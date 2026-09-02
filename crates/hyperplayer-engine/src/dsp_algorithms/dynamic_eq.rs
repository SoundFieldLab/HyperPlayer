//! HSE v1.5.1 Stage 18 Dynamic EQ 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::dynamic_eq::DynamicEqStage` 权威实现（全通
//! 交叉分带 + 频谱包络驱动增益 + 逐样本平滑）；本模块仅负责 HyperPlayer 参数
//! 快照、生命周期、立体声交错/平面转换、实时缓冲管理与每带读数发布。
//!
//! # 每 band 读数（telemetry 预留接口）
//!
//! [`DynamicEqProcessor::band_readings`] 以固定数组 + 代际 slot（generation）返回
//! 各带增益/电平/衰减读数：process 内零分配、零锁，读数随每个活跃块原子更新。
//! 背压语义：适配器自身**永不阻塞、永不排队**——读数槽位始终只保留最新一代，
//! 消费方（telemetry 发布器）按自身节奏采样，落后即隐式丢帧（以 generation 差值
//! 感知），与 D31 有界 telemetry channel 的丢帧策略对齐；节流定频由发布器承担。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::dynamic_eq::DynamicEqBandParam;
pub use hse_core::dynamic_eq::BAND_COUNT;
use hse_core::dynamic_eq::{
    DynamicEqParams, DynamicEqRuntimeState as CoreDynamicEqRuntimeState, DynamicEqStage,
};
use hse_core::Stage as HseStage;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DynamicEqBandSettings {
    pub enabled: bool,
    /// 交叉频率（Hz）；仅前 [`BAND_COUNT`]−1 个带的该字段生效，末带被核心忽略。
    pub frequency: f64,
    /// 静态目标曲线偏移（dB），生效域 [−12, +12]（核心钳制）。
    pub target_gain_db: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DynamicEqSettings {
    pub enabled: bool,
    /// 干湿混合强度，生效域 [0, 1]（核心钳制）。
    pub strength: f64,
    /// 阈值 dB，生效域 [−80, 0]（核心钳制）。
    pub threshold_db: f64,
    /// 压缩比，生效域 [1, 100]（核心钳制）。
    pub ratio: f64,
    /// 软拐点 dB，生效域 [0, 40]（核心钳制）。
    pub knee_db: f64,
    /// 启动时间 ms（下限 0.05 由核心钳制）。
    pub attack_ms: f64,
    /// 释放时间 ms（下限 1 由核心钳制）。
    pub release_ms: f64,
    /// 内部分析块长（样本），生效域 [16, 2048] 的整数（核心钳制）。
    pub block_size: f64,
    /// 固定 5 带；默认交叉点 200/800/2500/8000 Hz。
    pub bands: [DynamicEqBandSettings; BAND_COUNT],
}

impl Default for DynamicEqSettings {
    fn default() -> Self {
        const CROSSOVERS: [f64; BAND_COUNT] = [200.0, 800.0, 2500.0, 8000.0, 0.0];
        Self {
            enabled: false,
            strength: 1.0,
            threshold_db: -20.0,
            ratio: 2.0,
            knee_db: 6.0,
            attack_ms: 20.0,
            release_ms: 200.0,
            block_size: 128.0,
            bands: CROSSOVERS.map(|frequency| DynamicEqBandSettings {
                enabled: true,
                frequency,
                target_gain_db: 0.0,
            }),
        }
    }
}

/// 每 band 读数快照（固定数组，零堆分配；`generation` 为代际 slot 序号）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DynamicEqBandReadings {
    /// 读数代际：每处理一个活跃块自增 1；禁用/旁路期间保持不变（消费方以此
    /// 感知滞后与丢帧）。
    pub generation: u64,
    /// 各带平滑增益（线性；1 = 无偏移）。
    pub gains: [f64; BAND_COUNT],
    /// 各带最近分析电平（dB）。
    pub levels_db: [f64; BAND_COUNT],
    /// 各带最近控制更新的压缩衰减幅度（dB，≥ 0；应用为 static − reduction）。
    pub reduction_db: [f64; BAND_COUNT],
}

#[derive(Clone, Copy)]
struct DynamicEqReadouts {
    gains: [f64; BAND_COUNT],
    levels_db: [f64; BAND_COUNT],
    reduction_db: [f64; BAND_COUNT],
}

impl DynamicEqReadouts {
    fn capture(stage: &DynamicEqStage) -> Self {
        Self {
            gains: stage.get_band_gains(),
            levels_db: stage.get_band_levels_db(),
            reduction_db: stage.get_band_reduction_db(),
        }
    }
}

#[derive(Clone)]
struct DynamicEqProcessorRuntimeState {
    sample_rate: u32,
    core: CoreDynamicEqRuntimeState,
    readouts: DynamicEqReadouts,
    readouts_generation: u64,
}

pub struct DynamicEqProcessor {
    sample_rate: u32,
    settings: DynamicEqSettings,
    inner: DynamicEqStage,
    left: Vec<f32>,
    right: Vec<f32>,
    readouts: DynamicEqReadouts,
    readouts_generation: u64,
}

impl DynamicEqProcessor {
    pub fn new(sample_rate: u32, settings: DynamicEqSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(&settings)?;

        let inner = DynamicEqStage::from_params(
            f64::from(sample_rate),
            DynamicEqParams {
                enabled: Some(settings.enabled),
                strength: Some(settings.strength),
                threshold_db: Some(settings.threshold_db),
                ratio: Some(settings.ratio),
                knee_db: Some(settings.knee_db),
                attack_ms: Some(settings.attack_ms),
                release_ms: Some(settings.release_ms),
                block_size: Some(settings.block_size),
                bands: Some(
                    settings
                        .bands
                        .iter()
                        .map(|band| DynamicEqBandParam {
                            enabled: band.enabled,
                            frequency: band.frequency,
                            target_gain_db: Some(band.target_gain_db),
                        })
                        .collect(),
                ),
            },
        )
        .map_err(EngineError::InvalidInput)?;
        Ok(Self {
            sample_rate,
            settings,
            inner,
            left: Vec::new(),
            right: Vec::new(),
            readouts: DynamicEqReadouts {
                gains: [1.0; BAND_COUNT],
                levels_db: [0.0; BAND_COUNT],
                reduction_db: [0.0; BAND_COUNT],
            },
            readouts_generation: 0,
        })
    }

    pub fn settings(&self) -> DynamicEqSettings {
        self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 每 band 读数（零分配、零锁；代际 slot 语义见模块文档）。
    pub fn band_readings(&self) -> DynamicEqBandReadings {
        DynamicEqBandReadings {
            generation: self.readouts_generation,
            gains: self.readouts.gains,
            levels_db: self.readouts.levels_db,
            reduction_db: self.readouts.reduction_db,
        }
    }

    /// 参数即时生效并保留核心运行态（核心 `set_params` 语义：改参不清历史、
    /// 不产生增益跳变）；仅从禁用切换为启用时重置核心运行态，避免带着禁用前
    /// 的陈旧包络恢复播报。
    pub fn set_params(&mut self, settings: DynamicEqSettings) -> Result<()> {
        validate_settings(&settings)?;
        let became_active = !self.is_active() && settings.enabled;
        self.apply_params(settings);
        if became_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    fn apply_params(&mut self, settings: DynamicEqSettings) {
        self.inner.set_params(DynamicEqParams {
            enabled: Some(settings.enabled),
            strength: Some(settings.strength),
            threshold_db: Some(settings.threshold_db),
            ratio: Some(settings.ratio),
            knee_db: Some(settings.knee_db),
            attack_ms: Some(settings.attack_ms),
            release_ms: Some(settings.release_ms),
            block_size: Some(settings.block_size),
            bands: Some(
                settings
                    .bands
                    .iter()
                    .map(|band| DynamicEqBandParam {
                        enabled: band.enabled,
                        frequency: band.frequency,
                        target_gain_db: Some(band.target_gain_db),
                    })
                    .collect(),
            ),
        });
        self.settings = settings;
    }

    fn reset_runtime_state(&mut self) {
        self.inner.reset();
        self.readouts = DynamicEqReadouts {
            gains: [1.0; BAND_COUNT],
            levels_db: [0.0; BAND_COUNT],
            reduction_db: [0.0; BAND_COUNT],
        };
    }
}

impl PcmProcessor for DynamicEqProcessor {
    fn name(&self) -> &'static str {
        "dynamic-eq"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.enabled_and_previous_was_bypassed(previous) {
            return true;
        }
        if self.inner.copy_runtime_state_from(&previous.inner).is_err() {
            return false;
        }
        // 读数随核心状态一并迁移，代际延续前序实例（telemetry 连续性）。
        self.readouts = previous.readouts;
        self.readouts_generation = previous.readouts_generation;
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(DynamicEqProcessorRuntimeState {
            sample_rate: self.sample_rate,
            core: self.inner.snapshot_runtime_state(),
            readouts: self.readouts,
            readouts_generation: self.readouts_generation,
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<DynamicEqProcessorRuntimeState>()
            .is_some_and(|state| self.sample_rate == state.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<DynamicEqProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        if self.inner.save_runtime_state(&mut state.core).is_err() {
            return false;
        }
        state.readouts = self.readouts;
        state.readouts_generation = self.readouts_generation;
        true
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<DynamicEqProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        if self.inner.restore_runtime_state(&state.core).is_err() {
            return false;
        }
        self.readouts = state.readouts;
        self.readouts_generation = state.readouts_generation;
        true
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        self.inner.prepare(max_block_frames);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "dynamic eq requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "dynamic eq block exceeds the prepared frame capacity".into(),
            ));
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        // 核心 run() 对 disabled/strength≤0 硬直通：缓冲逐位不改写、状态不推进。
        self.inner
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
        if self.is_active() {
            self.readouts = DynamicEqReadouts::capture(&self.inner);
            self.readouts_generation = self.readouts_generation.wrapping_add(1);
            // HPTM 遥测取数门：有订阅者时才发布（发布器首次出帧后置位），
            // 否则零成本跳过；发布走进程级代际槽（零分配、零锁、可丢帧）。
            if crate::telemetry::chain_metering_hot() {
                let readings = self.band_readings();
                crate::telemetry::publish_dynamic_eq_reading(
                    readings.generation,
                    &readings.gains,
                    &readings.levels_db,
                    &readings.reduction_db,
                );
            }
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.reset_runtime_state();
        self.readouts_generation = self.readouts_generation.wrapping_add(1);
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

impl DynamicEqProcessor {
    /// 新实例已启用而前序实例处于禁用（旁路）态：前序无有效运行态可继承，
    /// 保持新实例从零状态开始。
    fn enabled_and_previous_was_bypassed(&self, previous: &Self) -> bool {
        self.is_active() && !previous.is_active()
    }
}

fn validate_sample_rate(sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(EngineError::InvalidInput(
            "dynamic eq sample rate must be greater than zero".into(),
        ));
    }
    Ok(())
}

/// 有限性校验（范围钳制由核心 `set_params` 按规格参数表执行）。
fn validate_settings(settings: &DynamicEqSettings) -> Result<()> {
    let scalars = [
        settings.strength,
        settings.threshold_db,
        settings.ratio,
        settings.knee_db,
        settings.attack_ms,
        settings.release_ms,
        settings.block_size,
    ];
    if scalars.iter().any(|value| !value.is_finite()) {
        return Err(EngineError::InvalidInput(
            "dynamic eq settings must be finite".into(),
        ));
    }
    if settings
        .bands
        .iter()
        .any(|band| !band.frequency.is_finite() || !band.target_gain_db.is_finite())
    {
        return Err(EngineError::InvalidInput(
            "dynamic eq band settings must be finite".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: u32) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "dynamic eq requires stereo PCM".into(),
        ));
    }
    if format.sample_rate != sample_rate {
        return Err(EngineError::InvalidInput(
            "dynamic eq sample rate does not match PCM format".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(sample_rate: u32) -> PcmFormat {
        PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: crate::dsp::PcmSampleFormat::F32,
        }
    }

    fn active_settings() -> DynamicEqSettings {
        DynamicEqSettings {
            enabled: true,
            strength: 0.8,
            threshold_db: -30.0,
            ratio: 8.0,
            knee_db: 6.0,
            attack_ms: 10.0,
            release_ms: 200.0,
            block_size: 128.0,
            bands: DynamicEqSettings::default().bands,
        }
    }

    fn prepared(
        sample_rate: u32,
        settings: DynamicEqSettings,
        capacity: usize,
    ) -> DynamicEqProcessor {
        let mut processor = DynamicEqProcessor::new(sample_rate, settings).unwrap();
        processor.prepare(format(sample_rate), capacity).unwrap();
        processor
    }

    fn process(processor: &mut DynamicEqProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate),
            interleaved: samples,
        })
    }

    fn interleaved(frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|index| {
                let sample = ((index as f64 * 0.31).sin() * 0.6) as f32;
                [sample, sample * 0.5]
            })
            .collect()
    }

    #[test]
    fn defaults_are_disabled_and_settings_are_finite_validated() {
        assert!(!DynamicEqSettings::default().enabled);
        assert_eq!(DynamicEqSettings::default().bands.len(), BAND_COUNT);
        let bands = DynamicEqSettings::default().bands;
        assert_eq!(
            [
                bands[0].frequency,
                bands[1].frequency,
                bands[2].frequency,
                bands[3].frequency
            ],
            [200.0, 800.0, 2500.0, 8000.0]
        );

        assert!(DynamicEqProcessor::new(0_u32, DynamicEqSettings::default()).is_err());
        let mut settings = active_settings();
        settings.strength = f64::NAN;
        assert!(DynamicEqProcessor::new(48_000, settings).is_err());
        let mut settings = active_settings();
        settings.bands[2].frequency = f64::INFINITY;
        assert!(DynamicEqProcessor::new(48_000, settings).is_err());
        let mut settings = active_settings();
        settings.block_size = f64::NEG_INFINITY;
        assert!(DynamicEqProcessor::new(48_000, settings).is_err());
    }

    #[test]
    fn disabled_is_bit_transparent_and_freezes_readings() {
        let mut processor = prepared(48_000, DynamicEqSettings::default(), 64);
        let mut samples = interleaved(64);
        let expected = samples.clone();
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(
            samples.iter().map(|&s| s.to_bits()).collect::<Vec<_>>(),
            expected.iter().map(|&s| s.to_bits()).collect::<Vec<_>>()
        );
        // 禁用态代际不推进：消费方据此判定读数陈旧并丢弃。
        assert_eq!(processor.band_readings().generation, 0);
    }

    #[test]
    fn active_generation_advances_per_block_and_readings_are_finite() {
        let mut processor = prepared(48_000, active_settings(), 33);
        for expected in 1..=5_u64 {
            let mut samples = interleaved(33);
            process(&mut processor, &mut samples).unwrap();
            let readings = processor.band_readings();
            assert_eq!(readings.generation, expected);
            assert!(readings.gains.iter().all(|g| g.is_finite()));
            assert!(readings.levels_db.iter().all(|l| l.is_finite()));
            assert!(readings.reduction_db.iter().all(|r| r.is_finite()));
        }
        // 读数重复采样零开销且内容稳定（快照语义，不消费槽位）。
        assert_eq!(processor.band_readings(), processor.band_readings());
    }

    #[test]
    fn block_splitting_is_bit_exact_across_crossover_sweep() {
        // 线性扫频跨越全部交叉点（200/800/2500/8000）。注意本模块特有行为
        // （规格 §4.5）：内部分析块边界 = min(params.blockSize, 本次调用剩余
        // 样本数)，输出依赖驱动分块——仅当每次驱动调用长度为 params.blockSize
        // （128）的整数倍（末块短块除外）时与整块处理逐位一致；任意切块的
        // 发散属设计内语义（core 测试「控制节奏与分块耦合」实证）。
        let frames = 2_000;
        let sweep = |i: usize| {
            let t = i as f64 / frames as f64;
            let freq = 80.0 + (12_000.0 - 80.0) * t;
            ((2.0 * std::f64::consts::PI * freq * i as f64 / 48_000.0).sin() * 0.6) as f32
        };
        let mut whole = interleaved(frames);
        for i in 0..frames {
            whole[i * 2] = sweep(i);
            whole[i * 2 + 1] = sweep(i) * 0.7;
        }
        let mut chunked = whole.clone();

        let mut whole_processor = prepared(48_000, active_settings(), frames);
        process(&mut whole_processor, &mut whole).unwrap();

        let mut chunked_processor = prepared(48_000, active_settings(), 1_000);
        let mut offset = 0;
        for len in [128, 640, 512, 512, 128, 80] {
            let end = (offset + len).min(frames);
            process(&mut chunked_processor, &mut chunked[offset * 2..end * 2]).unwrap();
            offset = end;
        }
        assert_eq!(offset, frames);
        assert_eq!(
            whole.iter().map(|&s| s.to_bits()).collect::<Vec<_>>(),
            chunked.iter().map(|&s| s.to_bits()).collect::<Vec<_>>(),
            "blockSize 整数倍切块不得改变逐样本运算序列"
        );
    }

    #[test]
    fn crossover_band_output_has_no_step_discontinuity() {
        // 缓释参数下扫频输出：相邻样本增量必须与输入同量级（无爆音/阶跃）。
        let frames = 2_000;
        let mut samples = interleaved(frames);
        for i in 0..frames {
            let t = i as f64 / frames as f64;
            let freq = 80.0 + (12_000.0 - 80.0) * t;
            samples[i * 2] =
                ((2.0 * std::f64::consts::PI * freq * i as f64 / 48_000.0).sin() * 0.6) as f32;
            samples[i * 2 + 1] = samples[i * 2];
        }
        let input_delta = samples
            .chunks(2)
            .zip(samples.chunks(2).skip(1))
            .map(|(a, b)| (f64::from(b[0]) - f64::from(a[0])).abs())
            .fold(0.0_f64, f64::max);

        let mut processor = prepared(
            48_000,
            DynamicEqSettings {
                strength: 1.0,
                threshold_db: -40.0,
                ratio: 8.0,
                attack_ms: 5.0,
                release_ms: 300.0,
                ..active_settings()
            },
            frames,
        );
        process(&mut processor, &mut samples).unwrap();
        let output_delta = samples
            .chunks(2)
            .zip(samples.chunks(2).skip(1))
            .map(|(a, b)| (f64::from(b[0]) - f64::from(a[0])).abs())
            .fold(0.0_f64, f64::max);
        assert!(
            output_delta <= input_delta + 0.05,
            "交叉点附近不得出现阶跃：input {input_delta} vs output {output_delta}"
        );
    }

    #[test]
    fn attack_pulls_gain_down_and_release_recovers_monotonically() {
        let mut processor = prepared(
            48_000,
            DynamicEqSettings {
                strength: 1.0,
                threshold_db: -40.0,
                ratio: 8.0,
                attack_ms: 1.0,
                release_ms: 50.0,
                ..active_settings()
            },
            256,
        );
        // 强激励 6 块：增益沿 attack 下探。
        let mut gains = [1.0; BAND_COUNT];
        for _ in 0..6 {
            let mut loud = vec![0.85_f32; 256];
            process(&mut processor, &mut loud).unwrap();
            gains = processor.band_readings().gains;
        }
        assert!(
            gains.iter().any(|&g| g < 0.8),
            "attack 阶段增益应显著下探：{gains:?}"
        );

        // 静音起始的阶跃会在交叉树中激起短暂瞬态（LP/HP 状态回落），前两个
        // 静音块内控制目标仍被瞬态能量牵引；瞬态（最长 τ≈0.8 ms ≈ 38 样本）
        // 消散后目标回到 1，增益沿 release 单调恢复（release 50 ms → 无过冲）。
        for _ in 0..2 {
            let mut settle = vec![0.0_f32; 256];
            process(&mut processor, &mut settle).unwrap();
        }
        let mut previous = processor.band_readings().gains;

        // 静音 6 块：增益沿 release 单调恢复。
        for _ in 0..6 {
            let mut silence = vec![0.0_f32; 256];
            process(&mut processor, &mut silence).unwrap();
            let current = processor.band_readings().gains;
            for (now, before) in current.iter().zip(previous.iter()) {
                assert!(
                    *now >= *before - 1.0e-9,
                    "release 恢复必须单调不回落：{previous:?} → {current:?}"
                );
            }
            previous = current;
        }
        assert!(
            previous
                .iter()
                .any(|&g| g > gains.iter().copied().fold(0.0_f64, f64::max)),
            "release 后增益应显著回升"
        );
    }

    #[test]
    fn checkpoint_roundtrip_and_adoption_preserve_state() {
        let settings = active_settings();
        let prefix = interleaved(37);
        let continuation = interleaved(19);

        let mut source = prepared(48_000, settings, 64);
        let mut source_prefix = prefix.clone();
        process(&mut source, &mut source_prefix).unwrap();
        let checkpoint = source.create_runtime_checkpoint().unwrap();
        let mut expected = continuation.clone();
        process(&mut source, &mut expected).unwrap();

        let mut replay = prepared(48_000, settings, 64);
        assert!(replay.restore_runtime_state(checkpoint.as_ref()));
        let mut actual = continuation.clone();
        process(&mut replay, &mut actual).unwrap();
        assert_eq!(
            actual.iter().map(|&s| s.to_bits()).collect::<Vec<_>>(),
            expected.iter().map(|&s| s.to_bits()).collect::<Vec<_>>()
        );

        // save：可复用检查点按当前状态覆写。
        let mut reusable = replay.create_runtime_checkpoint().unwrap();
        assert!(replay.save_runtime_state(reusable.as_mut()));
        let mut more = interleaved(11);
        process(&mut replay, &mut more).unwrap();
        assert!(replay.restore_runtime_state(reusable.as_ref()));
        let mut replayed = interleaved(11);
        process(&mut replay, &mut replayed).unwrap();
        assert_eq!(replayed, more);

        // adopt：同采样率迁移运行态；换参不得覆盖新参数。
        let mut next_settings = active_settings();
        next_settings.threshold_db = -12.0;
        let mut previous = prepared(48_000, settings, 64);
        process(&mut previous, &mut prefix.clone()).unwrap();
        let mut next = prepared(48_000, next_settings, 64);
        assert!(next.adopt_runtime_state_from(&mut previous));
        assert_eq!(next.settings(), next_settings);

        // 失配与错型：一律拒绝。
        let mut other_rate = prepared(44_100, settings, 16);
        assert!(!other_rate.adopt_runtime_state_from(&mut previous));
        let other_checkpoint = other_rate.create_runtime_checkpoint().unwrap();
        assert!(!other_rate.runtime_checkpoint_compatible(checkpoint.as_ref()));
        assert!(!replay.runtime_checkpoint_compatible(other_checkpoint.as_ref()));
        assert!(!replay.restore_runtime_state(other_checkpoint.as_ref()));
        let mut wrong_checkpoint: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!replay.save_runtime_state(wrong_checkpoint.as_mut()));
        assert!(!replay.restore_runtime_state(wrong_checkpoint.as_ref()));
    }

    #[test]
    fn reenable_and_reset_start_from_clean_state() {
        let settings = active_settings();
        let mut processor = prepared(48_000, settings, 64);
        let mut warm = interleaved(64);
        process(&mut processor, &mut warm).unwrap();

        let mut disabled = settings;
        disabled.enabled = false;
        processor.set_params(disabled).unwrap();
        let mut bypassed = interleaved(8);
        let expected = bypassed.clone();
        process(&mut processor, &mut bypassed).unwrap();
        assert_eq!(bypassed, expected);

        processor.set_params(settings).unwrap();
        let mut restarted = interleaved(9);
        process(&mut processor, &mut restarted).unwrap();
        let mut fresh = prepared(48_000, settings, 9);
        let mut fresh_output = interleaved(9);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(restarted, fresh_output, "重新启用必须从干净状态开始");

        let mut advance = interleaved(11);
        process(&mut processor, &mut advance).unwrap();
        processor.reset(ResetReason::Seek);
        let mut reset_output = interleaved(9);
        process(&mut processor, &mut reset_output).unwrap();
        assert_eq!(reset_output, fresh_output);
        assert_eq!(processor.settings(), settings);
    }

    #[test]
    fn malformed_blocks_are_rejected_before_bypass_and_recovery_works() {
        let mut processor = DynamicEqProcessor::new(48_000, DynamicEqSettings::default()).unwrap();
        processor.prepare(format(48_000), 2).unwrap();

        let mono = PcmFormat {
            channels: 1,
            ..format(48_000)
        };
        assert!(processor.prepare(mono, 2).is_err());
        assert!(processor.prepare(format(44_100), 2).is_err());

        let mut incomplete = [1.0_f32, -1.0, 0.5];
        assert!(process(&mut processor, &mut incomplete).is_err());

        let mut oversized = [0.5_f32; 6];
        let unchanged = oversized;
        assert!(process(&mut processor, &mut oversized).is_err());
        assert_eq!(oversized, unchanged, "出错路径不得改写缓冲");

        let mut unprepared = DynamicEqProcessor::new(48_000, active_settings()).unwrap();
        let mut frame = [1.0_f32, -1.0];
        assert!(process(&mut unprepared, &mut frame).is_err());

        // 故障旁路后恢复：合法块继续正常处理。
        let mut recovered = interleaved(2);
        assert!(process(&mut processor, &mut recovered).is_ok());
    }

    #[test]
    fn dynamic_eq_has_no_latency_or_tail() {
        let mut processor = prepared(48_000, active_settings(), 4);
        assert_eq!(processor.name(), "dynamic-eq");
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
        let mut samples = interleaved(4);
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(processor.tail_frames(), 0);
    }
}
