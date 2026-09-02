//! HSE v1.5.1 Stage 21 Limiter 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::limiter::LimiterStage` 权威实现；本模块仅负责
//! HyperPlayer 参数快照、生命周期、立体声交错/平面转换、实时缓冲管理、
//! lookahead 延迟如实上报、尾部排空（drain）与 meter 读数发布。
//!
//! 链级语义（`dsp.rs` 自动折叠）：
//! - `latency_frames`：启用时如实上报 core 的 lookahead 样本数（禁用即逐位
//!   直通，无延迟，上报 0）；链级 latency 汇总由 `PreparedProcessorChain` 折叠，
//!   adapter 不做额外补偿。
//! - `tail_frames`：启用时等于 lookahead（尚未送出的最后一段输入，可经
//!   [`LimiterProcessor::drain_tail`] 精确排空）；禁用时为 0。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::limiter::{
    LimiterRuntimeState as CoreLimiterRuntimeState, LimiterSettings as CoreLimiterSettings,
    LimiterStage,
};
use hse_core::Stage;
use std::sync::atomic::{AtomicU64, Ordering};

/// meter 读数槽位索引：0 = 增益衰减（dB，≤ 0），1 = 检测峰值（dBFS）。
const METER_SLOT_REDUCTION: usize = 0;
const METER_SLOT_PEAK: usize = 1;
const METER_SLOT_COUNT: usize = 2;

/// 无锁代际 slot：写侧先递增 generation（奇）再写值再递增（偶），
/// 读侧校验代际一致后取值，不重试时返回 `None`。固定数组 + 原子量，
/// 零分配、零锁，供 telemetry 通道在非音频线程读取。
#[derive(Default)]
struct MeterSlot {
    value_bits: AtomicU64,
    generation: AtomicU64,
}

impl MeterSlot {
    fn publish(&self, value: f64) {
        self.generation.fetch_add(1, Ordering::Release);
        self.value_bits.store(value.to_bits(), Ordering::Release);
        self.generation.fetch_add(1, Ordering::Release);
    }

    fn load(&self) -> Option<(f64, u64)> {
        for _ in 0..4 {
            let before = self.generation.load(Ordering::Acquire);
            if before == 0 {
                // generation 从 0 起：0 表示从未发布过读数。
                return None;
            }
            if before % 2 == 1 {
                continue;
            }
            let bits = self.value_bits.load(Ordering::Acquire);
            let after = self.generation.load(Ordering::Acquire);
            if before == after {
                return Some((f64::from_bits(bits), after));
            }
        }
        None
    }
}

/// meter 读数快照：值为 dB 域，`generation` 用于 telemetry 侧去重/丢帧判定。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimiterMeterReading {
    pub value_db: f64,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimiterSettings {
    pub enabled: bool,
    pub threshold_db: f64,
    pub lookahead_ms: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub true_peak: bool,
}

impl Default for LimiterSettings {
    fn default() -> Self {
        // 对齐 HSE Stage 21 默认参数；enabled=false 遵守 HyperPlayer 透明默认链。
        Self {
            enabled: false,
            threshold_db: -1.0,
            lookahead_ms: 5.0,
            attack_ms: 0.5,
            release_ms: 150.0,
            true_peak: true,
        }
    }
}

#[derive(Clone)]
struct LimiterRuntimeState {
    sample_rate_bits: u64,
    core: CoreLimiterRuntimeState,
}

pub struct LimiterProcessor {
    sample_rate: f64,
    settings: LimiterSettings,
    effect: LimiterStage,
    left: Vec<f32>,
    right: Vec<f32>,
    /// 固定 2 槽 meter 读数（衰减 / 检测峰值），process 尾部发布，零分配。
    meters: [MeterSlot; METER_SLOT_COUNT],
}

impl LimiterProcessor {
    pub fn new(sample_rate: f64, settings: LimiterSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(settings)?;
        let effect = LimiterStage::from_settings(sample_rate, core_settings(settings))
            .map_err(EngineError::InvalidInput)?;
        let mut processor = Self {
            sample_rate,
            settings: LimiterSettings::default(),
            effect,
            left: Vec::new(),
            right: Vec::new(),
            meters: Default::default(),
        };
        processor.apply_params(settings);
        Ok(processor)
    }

    pub fn settings(&self) -> LimiterSettings {
        self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 参数即时生效并保留核心状态；仅从禁用切换为启用时重置核心状态
    ///（core 在缓冲尺寸变化或禁用→启用时自行清空管线，语义一致）。
    pub fn set_params(&mut self, settings: LimiterSettings) -> Result<()> {
        validate_settings(settings)?;
        let became_active = !self.is_active() && settings.enabled;
        self.apply_params(settings);
        if became_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    fn apply_params(&mut self, settings: LimiterSettings) {
        self.effect.configure(core_settings(settings));
        self.settings = settings;
    }

    fn reset_runtime_state(&mut self) {
        self.effect.reset();
    }

    /// 最近一次增益衰减读数（dB，≤ 0；无读数时 `None`）。
    pub fn reduction_reading(&self) -> Option<LimiterMeterReading> {
        self.meters[METER_SLOT_REDUCTION]
            .load()
            .map(|(value_db, generation)| LimiterMeterReading {
                value_db,
                generation,
            })
    }

    /// 最近一次检测峰值读数（dBFS；真峰值模式为 4× 过采样插值峰值，
    /// 可高于样本峰值；数字峰值模式为样本绝对值峰值；无读数时 `None`）。
    pub fn peak_reading(&self) -> Option<LimiterMeterReading> {
        self.meters[METER_SLOT_PEAK]
            .load()
            .map(|(value_db, generation)| LimiterMeterReading {
                value_db,
                generation,
            })
    }

    /// 排空 lookahead 延迟线尾部（停流/换链语义）：把尚未送出的最后至多
    /// `lookahead` 帧以冻结增益写入 `interleaved`（立体声交错，容量 ≤ 预备帧数），
    /// 返回实际写出的帧数。全部排空后核心音频状态回到等效 reset（参数保留）。
    /// 非实时路径 API，禁止在音频回调中调用。
    pub fn drain_tail(&mut self, interleaved: &mut [f32]) -> Result<usize> {
        if !interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "limiter drain requires complete stereo frames".into(),
            ));
        }
        let frames = interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "limiter drain exceeds the prepared frame capacity".into(),
            ));
        }
        let drained = self
            .effect
            .drain(&mut self.left[..frames], &mut self.right[..frames]);
        for (index, frame) in interleaved[..drained * 2]
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .enumerate()
        {
            frame[0] = self.left[index];
            frame[1] = self.right[index];
        }
        Ok(drained)
    }
}

fn core_settings(settings: LimiterSettings) -> CoreLimiterSettings {
    CoreLimiterSettings {
        enabled: settings.enabled,
        threshold_db: settings.threshold_db,
        lookahead_ms: settings.lookahead_ms,
        attack_ms: settings.attack_ms,
        release_ms: settings.release_ms,
        true_peak: settings.true_peak,
    }
}

impl PcmProcessor for LimiterProcessor {
    fn name(&self) -> &'static str {
        "limiter"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.is_active() && previous.is_active() {
            // core 内部校验采样率与 lookahead 一致性（不一致时整体拒绝迁移）。
            self.effect
                .copy_runtime_state_from(&previous.effect)
                .is_ok()
        } else {
            if self.is_active() {
                self.reset_runtime_state();
            }
            true
        }
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(LimiterRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            core: self.effect.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<LimiterRuntimeState>()
            .is_some_and(|state| state.sample_rate_bits == self.sample_rate.to_bits())
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<LimiterRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        self.effect.save_runtime_state(&mut state.core).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<LimiterRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        self.effect.restore_runtime_state(&state.core).is_ok()
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "limiter requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "limiter block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.is_active() {
            return Ok(());
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.effect
            .process(&mut self.left[..frames], &mut self.right[..frames]);
        for (index, frame) in block
            .interleaved
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .enumerate()
        {
            frame[0] = self.left[index];
            frame[1] = self.right[index];
        }
        // meter 读数发布：每块一次，固定 slot + 代际，零分配（HPTM 遥测取数口）。
        self.meters[METER_SLOT_REDUCTION].publish(self.effect.reduction_db());
        // 峰值读数以 -240 dB 地板量化，避免静音时发布 -inf。
        self.meters[METER_SLOT_PEAK]
            .publish(20.0 * self.effect.last_detected_peak().max(1e-12).log10());
        // HPTM 遥测取数门：有订阅者时才发布（发布器首次出帧后置位），否则
        // 零成本跳过；发布走进程级代际槽（零分配、零锁、可丢帧）。
        if crate::telemetry::chain_metering_hot() {
            if let Some(reduction) = self.reduction_reading() {
                crate::telemetry::publish_limiter_readings(
                    reduction.value_db,
                    self.peak_reading()
                        .map(|peak| peak.value_db)
                        .unwrap_or(f64::NEG_INFINITY),
                );
            }
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.reset_runtime_state();
    }

    fn latency_frames(&self) -> u32 {
        if self.is_active() {
            u32::try_from(self.effect.latency_samples()).unwrap_or(u32::MAX)
        } else {
            0
        }
    }

    fn tail_frames(&self) -> u32 {
        if self.is_active() {
            u32::try_from(self.effect.tail_samples()).unwrap_or(u32::MAX)
        } else {
            0
        }
    }
}

fn validate_sample_rate(sample_rate: f64) -> Result<()> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(EngineError::InvalidInput(
            "limiter sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_settings(settings: LimiterSettings) -> Result<()> {
    if [
        settings.threshold_db,
        settings.lookahead_ms,
        settings.attack_ms,
        settings.release_ms,
    ]
    .into_iter()
    .any(|value| !value.is_finite())
    {
        return Err(EngineError::InvalidInput(
            "limiter settings must be finite".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "limiter requires stereo PCM".into(),
        ));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "limiter sample rate does not match PCM format".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::{BypassProcessor, PcmSampleFormat};

    fn format(sample_rate: u32) -> PcmFormat {
        PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    fn enabled(threshold_db: f64, lookahead_ms: f64, true_peak: bool) -> LimiterSettings {
        LimiterSettings {
            enabled: true,
            threshold_db,
            lookahead_ms,
            attack_ms: 0.5,
            release_ms: 150.0,
            true_peak,
        }
    }

    fn prepared(sample_rate: f64, settings: LimiterSettings, capacity: usize) -> LimiterProcessor {
        let mut processor = LimiterProcessor::new(sample_rate, settings).unwrap();
        processor
            .prepare(format(sample_rate as u32), capacity)
            .unwrap();
        processor
    }

    fn process(processor: &mut LimiterProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate as u32),
            interleaved: samples,
        })
    }

    fn signal(frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|index| {
                let sample = ((index as f64 * 0.37).sin() * 0.7) as f32;
                [sample, -sample * 0.75]
            })
            .collect()
    }

    #[test]
    fn defaults_validation_and_transparent_disabled_path() {
        assert_eq!(
            LimiterSettings::default(),
            LimiterSettings {
                enabled: false,
                threshold_db: -1.0,
                lookahead_ms: 5.0,
                attack_ms: 0.5,
                release_ms: 150.0,
                true_peak: true,
            }
        );
        for sample_rate in [0.0, -48_000.0, f64::NAN, f64::INFINITY] {
            assert!(LimiterProcessor::new(sample_rate, LimiterSettings::default()).is_err());
        }
        for mut bad in [
            enabled(f64::NAN, 5.0, true),
            enabled(-1.0, f64::INFINITY, true),
            enabled(-1.0, 5.0, true),
        ] {
            bad.release_ms = f64::NAN;
            assert!(LimiterProcessor::new(48_000.0, bad).is_err());
            assert!(LimiterProcessor::new(48_000.0, enabled(-1.0, 5.0, true))
                .unwrap()
                .set_params(bad)
                .is_err());
        }

        // 禁用：逐位直通、无 latency/tail、meter 无读数、无尾部可排空。
        let mut processor = prepared(48_000.0, LimiterSettings::default(), 64);
        let input = signal(64);
        let mut samples = input.clone();
        let expected = samples.iter().map(|s| s.to_bits()).collect::<Vec<_>>();
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(
            samples.iter().map(|s| s.to_bits()).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
        assert!(processor.reduction_reading().is_none());
        assert!(processor.peak_reading().is_none());
        let mut drained = vec![0.0_f32; 16];
        assert_eq!(processor.drain_tail(&mut drained).unwrap(), 0);
        assert!(drained.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn ceiling_impulse_is_delayed_and_attenuated_with_honest_latency() {
        let settings = enabled(-6.0, 5.0, true);
        let mut processor = prepared(48_000.0, settings, 512);
        assert_eq!(processor.name(), "limiter");
        // lookahead = round(5ms * 48kHz) = 240 —— 延迟必须如实上报。
        assert_eq!(processor.latency_frames(), 240);
        assert_eq!(processor.tail_frames(), 240);

        // 单脉冲 + 静音垫：输出脉冲必须出现在第 240 帧且被压到阈值之下。
        let mut samples = vec![0.0_f32; 512];
        samples[0] = 1.0;
        samples[1] = -1.0;
        process(&mut processor, &mut samples[..256]).unwrap();
        process(&mut processor, &mut samples[256..]).unwrap();
        let left = samples.iter().step_by(2).copied().collect::<Vec<_>>();
        let thr = 10.0_f64.powf(-6.0 / 20.0) as f32;
        assert!(
            left[..240].iter().all(|&s| s == 0.0),
            "lookahead 窗口内不应有输出"
        );
        let peak = left[240].abs();
        assert!(
            peak > 0.3 && peak <= thr * 1.05,
            "超限脉冲应被延迟 240 帧并压至阈值附近，实际 {peak}（阈值 {thr}）"
        );

        // 启用状态下 meter 有读数：衰减为非正 dB，峰值读数有限。
        let reduction = processor.reduction_reading().unwrap();
        assert!(reduction.value_db <= 0.0);
        let peak_reading = processor.peak_reading().unwrap();
        // 末块为静音：读数落在 -240 dB 地板，有限且非正。
        assert!(peak_reading.value_db.is_finite() && peak_reading.value_db <= 0.0);
    }

    #[test]
    fn intersample_true_peak_reacts_stronger_than_digital_peak() {
        // 零段接 ±1 交替短脉冲：4× 过采样 sinc 重建在交替起始处产生 intersample
        // 过冲（检测峰值 ≈ 1.073 > 样本峰值 1.0），真峰值模式产生实际衰减，
        // 数字峰值模式保持增益 1。
        let mut frames = vec![0.0_f32; 600];
        frames.extend([1.0_f32, -1.0, 1.0]);
        let interleaved: Vec<f32> = frames.iter().flat_map(|&s| [s, s]).collect();

        let mut tp = prepared(48_000.0, enabled(0.0, 5.0, true), 1_024);
        let mut tp_samples = interleaved.clone();
        process(&mut tp, &mut tp_samples).unwrap();
        let tp_reduction = tp.reduction_reading().unwrap().value_db;
        assert!(
            tp_reduction < -0.005,
            "真峰值模式应检测到 intersample 过冲并衰减，实际 {tp_reduction}"
        );

        let mut dp = prepared(48_000.0, enabled(0.0, 5.0, false), 1_024);
        let mut dp_samples = interleaved.clone();
        process(&mut dp, &mut dp_samples).unwrap();
        let dp_reduction = dp.reduction_reading().unwrap().value_db;
        assert_eq!(dp_reduction, 0.0, "数字峰值不超阈不衰减");
        assert!(tp_reduction < dp_reduction);
    }

    #[test]
    fn drain_tail_flushes_exactly_the_lookahead_and_resets_cleanly() {
        // 阈值 0 dBFS、输入峰值 0.7：限幅器全程增益恰为 1.0，因此排空输出必须
        // 与输入延迟 lookahead 后逐位一致（timing + 内容双验证，无浮点重构）。
        let settings = enabled(0.0, 2.5, true);
        let lookahead = 120_usize;
        let mut processor = prepared(48_000.0, settings, 512);
        let input = signal(300);
        let mut samples = input.clone();
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(processor.reduction_reading().unwrap().value_db, 0.0);

        // 分次排空：2 + 64 + 剩余，总数必须恰为 lookahead。
        let mut drained_all = Vec::new();
        for request in [2_usize, 64, 256] {
            let mut buf = vec![0.0_f32; request * 2];
            let drained = processor.drain_tail(&mut buf).unwrap();
            assert!(drained <= request);
            drained_all.extend_from_slice(&buf[..drained * 2]);
        }
        assert_eq!(
            drained_all.len() / 2,
            lookahead,
            "排空总数必须等于 lookahead"
        );
        for k in 0..lookahead {
            let src = 300 + k - lookahead;
            assert_eq!(
                drained_all[k * 2].to_bits(),
                input[src * 2].to_bits(),
                "L @{k}"
            );
            assert_eq!(
                drained_all[k * 2 + 1].to_bits(),
                input[src * 2 + 1].to_bits(),
                "R @{k}"
            );
        }
        // 排空后再排空恒 0。
        let mut extra = vec![0.0_f32; 32];
        assert_eq!(processor.drain_tail(&mut extra).unwrap(), 0);
        assert!(extra.iter().all(|&s| s == 0.0));

        // 排空后送入新流：排空进度归零，行为与从未排空的等价新实例一致，
        // 且新流再次积累 lookahead 尾部。
        let mut fresh = prepared(48_000.0, settings, 32);
        let mut next = signal(32);
        let mut expected = next.clone();
        process(&mut processor, &mut next).unwrap();
        process(&mut fresh, &mut expected).unwrap();
        assert_eq!(next, expected);
        assert_eq!(processor.drain_tail(&mut vec![0.0_f32; 512]).unwrap(), 32);
    }

    #[test]
    fn reset_discards_pending_tail_and_matches_fresh_instance() {
        let settings = enabled(-3.0, 2.5, true);
        let mut processor = prepared(48_000.0, settings, 64);
        let mut samples = signal(64);
        process(&mut processor, &mut samples).unwrap();
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.settings(), settings);
        assert_eq!(processor.tail_frames(), 120, "静态 tail 容量不变");
        // reset 丢弃延迟内容：无内容可排空。
        let mut drained = vec![0.0_f32; 128];
        assert_eq!(processor.drain_tail(&mut drained).unwrap(), 0);
        assert!(drained.iter().all(|&s| s == 0.0));
        // 后续输出与等价新实例一致。
        let mut next = signal(16);
        let mut expected = next.clone();
        process(&mut processor, &mut next).unwrap();
        let mut fresh = prepared(48_000.0, settings, 16);
        process(&mut fresh, &mut expected).unwrap();
        assert_eq!(next, expected);
    }

    #[test]
    fn migration_and_checkpoint_preserve_opaque_core_state() {
        // 同 lookahead 改参：状态连续迁移，输出与「改参保留状态」的参考一致。
        let old_settings = enabled(-3.0, 2.5, true);
        let same_lookahead_settings = enabled(-6.0, 2.5, true);
        let mut previous = prepared(48_000.0, old_settings, 512);
        let mut reference = prepared(48_000.0, old_settings, 512);
        let mut prefix = signal(400);
        let mut reference_prefix = prefix.clone();
        process(&mut previous, &mut prefix).unwrap();
        process(&mut reference, &mut reference_prefix).unwrap();

        let mut next = prepared(48_000.0, same_lookahead_settings, 512);
        assert!(next.adopt_runtime_state_from(&mut previous));
        reference.set_params(same_lookahead_settings).unwrap();
        let mut adopted = signal(200);
        let mut expected = adopted.clone();
        process(&mut next, &mut adopted).unwrap();
        process(&mut reference, &mut expected).unwrap();
        assert_eq!(adopted, expected, "adopt 后必须与保留状态的参考逐位一致");

        // 检查点 save/restore 往返。
        let initial = next.create_runtime_checkpoint().unwrap();
        assert!(next.runtime_checkpoint_compatible(initial.as_ref()));
        let mut after = signal(100);
        process(&mut next, &mut after).unwrap();
        assert!(next.restore_runtime_state(initial.as_ref()));
        let mut replay = signal(100);
        process(&mut next, &mut replay).unwrap();
        assert_eq!(replay, after);
        let mut checkpoint = next.create_runtime_checkpoint().unwrap();
        assert!(next.save_runtime_state(checkpoint.as_mut()));
        let mut more = signal(90);
        process(&mut next, &mut more).unwrap();
        assert!(next.restore_runtime_state(checkpoint.as_ref()));
        let mut replayed = signal(90);
        process(&mut next, &mut replayed).unwrap();
        assert_eq!(replayed, more);

        // 禁用/启用切换与采样率、类型、lookahead 失配。
        let mut disabled = prepared(
            48_000.0,
            LimiterSettings {
                enabled: false,
                ..same_lookahead_settings
            },
            64,
        );
        assert!(disabled.adopt_runtime_state_from(&mut previous));
        let mut activated = prepared(48_000.0, same_lookahead_settings, 64);
        assert!(activated.adopt_runtime_state_from(&mut disabled));
        let mut from_disabled = signal(16);
        let mut fresh_output = from_disabled.clone();
        process(&mut activated, &mut from_disabled).unwrap();
        let mut fresh = prepared(48_000.0, same_lookahead_settings, 16);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(from_disabled, fresh_output);

        let mut other_rate = prepared(44_100.0, same_lookahead_settings, 64);
        assert!(!other_rate.adopt_runtime_state_from(&mut next));
        assert!(!other_rate.runtime_checkpoint_compatible(checkpoint.as_ref()));
        assert!(!other_rate.restore_runtime_state(checkpoint.as_ref()));
        let mut bypass = BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut bypass));
        let mut wrong: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!next.save_runtime_state(wrong.as_mut()));
        assert!(!next.restore_runtime_state(wrong.as_ref()));

        // lookahead 不同的同采样率实例：core 原子拒绝迁移（链级重新起链）。
        let mut other_lookahead = prepared(48_000.0, enabled(-3.0, 5.0, true), 512);
        assert!(!other_lookahead.adopt_runtime_state_from(&mut next));

        // 不同 lookahead 改参后双方均从干净管线开始，输出仍一致。
        let mut changed = prepared(48_000.0, enabled(-6.0, 1.0, true), 512);
        let mut changed_reference = prepared(48_000.0, enabled(-6.0, 1.0, true), 512);
        assert!(!changed.adopt_runtime_state_from(&mut previous));
        let mut changed_out = signal(100);
        let mut changed_expected = changed_out.clone();
        process(&mut changed, &mut changed_out).unwrap();
        process(&mut changed_reference, &mut changed_expected).unwrap();
        assert_eq!(changed_out, changed_expected);
    }

    #[test]
    fn per_frame_core_state_is_block_invariant_across_rates_and_blocks() {
        for (sample_rate, settings, expected_latency) in [
            (48_000.0_f64, enabled(-3.0, 5.0, true), 240_u32),
            (44_100.0, enabled(-6.0, 2.0, false), 88), // round(2ms * 44100)
            (8_000.0, enabled(-1.0, 0.5, true), 4),    // round(0.5ms * 8000)
        ] {
            let input = signal(1_503);
            let mut whole = prepared(sample_rate, settings, 1_503);
            let mut split = prepared(sample_rate, settings, 1_503);
            assert_eq!(whole.latency_frames(), expected_latency);
            assert_eq!(whole.tail_frames(), expected_latency);
            let mut whole_output = input.clone();
            let mut split_output = input;
            process(&mut whole, &mut whole_output).unwrap();
            let mut offset = 0_usize;
            for frames in [521_usize, 521, 461] {
                process(
                    &mut split,
                    &mut split_output[offset * 2..(offset + frames) * 2],
                )
                .unwrap();
                offset += frames;
            }
            assert_eq!(
                whole_output, split_output,
                "sample_rate={sample_rate} 分块必须与整块逐位一致"
            );
        }
    }

    #[test]
    fn lookahead_change_reconfigures_pipeline_like_fresh_instance() {
        let settings = enabled(-3.0, 5.0, true);
        let mut processor = prepared(48_000.0, settings, 256);
        let mut prefix = signal(200);
        process(&mut processor, &mut prefix).unwrap();
        processor.set_params(enabled(-3.0, 2.0, true)).unwrap();
        assert_eq!(processor.latency_frames(), 96); // round(2ms * 48kHz)
        assert_eq!(processor.tail_frames(), 96);

        let mut next = signal(64);
        let mut expected = next.clone();
        process(&mut processor, &mut next).unwrap();
        let mut fresh = prepared(48_000.0, enabled(-3.0, 2.0, true), 64);
        process(&mut fresh, &mut expected).unwrap();
        assert_eq!(next, expected);
    }

    #[test]
    fn format_frame_and_capacity_validation_precede_bypass() {
        let mut processor = LimiterProcessor::new(48_000.0, LimiterSettings::default()).unwrap();
        assert!(processor.prepare(format(48_000), 4).is_ok());
        assert!(processor
            .prepare(
                PcmFormat {
                    channels: 1,
                    ..format(48_000)
                },
                4
            )
            .is_err());
        assert!(processor.prepare(format(44_100), 4).is_err());

        let mut partial = [1.0_f32, -1.0, 0.5];
        assert!(process(&mut processor, &mut partial).is_err());
        let mut oversized = [1.0_f32; 10];
        let unchanged = oversized;
        assert!(process(&mut processor, &mut oversized).is_err());
        assert_eq!(oversized, unchanged);
        let mut unprepared = LimiterProcessor::new(48_000.0, enabled(-1.0, 5.0, true)).unwrap();
        let mut frame = [1.0_f32, -1.0];
        assert!(process(&mut unprepared, &mut frame).is_err());
        assert!(unprepared.drain_tail(&mut frame).is_err());
        assert!(unprepared.drain_tail(&mut [1.0_f32, -1.0, 0.5]).is_err());
    }
}
