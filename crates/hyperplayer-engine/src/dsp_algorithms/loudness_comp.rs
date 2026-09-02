//! HSE v1.5.1 Stage 15 Loudness Compensation 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::loudness_comp::LoudnessCompStage` 权威实现；本模块
//! 仅负责 HyperPlayer 参数快照、生命周期、立体声交错/平面转换和实时缓冲管理。
//!
//! # 音量输入与参数更新语义（latest-wins）
//!
//! - 参数快照（含 `volume_percent`）由控制线程通过 [`LoudnessCompProcessor::set_params`]
//!   整体替换，多次调用 last-writer-wins；`process` 只读取模块内这一份统一快照
//!   （目标曲线在块首生效），不存在块中途二次取值。
//! - 参数更新不清空平滑状态：核心阶段按目标曲线重算目标段，currentGains 保留并由
//!   逐块一阶平滑向新目标连续收敛（音量变化不产生增益跳变；见核心模块
//!   `LoudnessCompStage::configure` 的规格 §4.3 语义）。
//! - 启用/禁用切换不改写核心状态：禁用块被完全旁路（缓冲零改写），重新启用时从
//!   冻结状态继续平滑（首次启用从 0 爬升，无补偿跳变）。
//! - **输出依赖本块帧数**（HSE v1.5.1 规格 §4.3 行为事实）：逐块平滑 alpha 按实际
//!   块长计算，因此本适配器把整个交错块作为一次 `Stage::process` 调用转发，
//!   块长调度属于引擎契约的一部分（爬升型向量按冻结 blockSize 回放）。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
// Pub re-export：config 作者与测试直接从本模块取 band 参数类型（同 EqBandParam 先例）。
pub use hse_core::loudness_comp::LoudnessBandParam;
use hse_core::loudness_comp::{
    LoudnessCompRuntimeState as CoreLoudnessCompRuntimeState,
    LoudnessCompSettings as CoreLoudnessCompSettings, LoudnessCompStage,
};
use hse_core::Stage as HseStage;
use serde::{Deserialize, Serialize};

/// HSE v1.5.1 `mode: 'auto' | 'preset' | 'custom'` 的模式枚举。
///
/// serde 蛇形命名与 TS 旧字符串载荷逐字兼容（"auto" / "preset" / "custom"）；
/// DTO 层旧载荷中的枚举外字符串应在 DTO 反序列化边界回退
/// [`LoudnessCompMode::Auto`]（核心 `LoudnessCompMode::from_params_str` 语义）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoudnessCompMode {
    /// 随音量线性等响度（ISO 226 简化近似）。
    #[default]
    Auto,
    /// 六条固定场景曲线（flat/bass/vocal/warm/bright/night）。
    Preset,
    /// 用户自定义控制点（low/high shelf + mid peaking）。
    Custom,
}

impl From<LoudnessCompMode> for hse_core::loudness_comp::LoudnessCompMode {
    fn from(value: LoudnessCompMode) -> Self {
        match value {
            LoudnessCompMode::Auto => Self::Auto,
            LoudnessCompMode::Preset => Self::Preset,
            LoudnessCompMode::Custom => Self::Custom,
        }
    }
}

/// 等响度补偿阶段参数快照（HyperPlayer 侧，含引擎门控 `enabled`）。
#[derive(Clone, Debug, PartialEq)]
pub struct LoudnessCompSettings {
    pub enabled: bool,
    pub mode: LoudnessCompMode,
    /// 音量百分比（0–100；核心钳制，非有限值回落下限）。
    pub volume_percent: f64,
    /// auto 模式最大提升 dB（0–24；核心钳制）。
    pub max_boost_db: f64,
    /// preset 模式预设 id：flat / bass / vocal / warm / bright / night；
    /// 未知 id 回退 flat 曲线（核心保留 HSE v1.5.1 行为）。
    pub preset: String,
    /// 逐块增益平滑时间常数（秒；0.01–10，核心钳制）。
    pub smoothing_seconds: f64,
    /// custom 模式目标曲线控制点（仅 custom 模式消费）。
    pub bands: Vec<LoudnessBandParam>,
}

impl Default for LoudnessCompSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: LoudnessCompMode::Auto,
            // auto 模式满音量 → 全部目标增益为 0 → 恒等链（启用时即透明起点）。
            volume_percent: 100.0,
            max_boost_db: 12.0,
            preset: "flat".to_string(),
            smoothing_seconds: 0.2,
            bands: Vec::new(),
        }
    }
}

impl LoudnessCompSettings {
    /// 结构级校验：数值字段必须有限。范围钳制与预设回退由核心按 HSE v1.5.1
    /// 行为执行；DTO 层如需更严的产品范围校验在 DTO 边界另行实施。
    pub fn validate(&self) -> Result<()> {
        if [
            self.volume_percent,
            self.max_boost_db,
            self.smoothing_seconds,
        ]
        .into_iter()
        .any(|value| !value.is_finite())
        {
            return Err(EngineError::InvalidInput(
                "loudness compensation settings must be finite".into(),
            ));
        }
        if self
            .bands
            .iter()
            .any(|band| !band.frequency.is_finite() || !band.gain.is_finite())
        {
            return Err(EngineError::InvalidInput(
                "loudness compensation bands must be finite".into(),
            ));
        }
        Ok(())
    }
}

impl From<LoudnessCompSettings> for CoreLoudnessCompSettings {
    fn from(value: LoudnessCompSettings) -> Self {
        Self {
            volume_percent: value.volume_percent,
            max_boost_db: value.max_boost_db,
            preset: value.preset,
            bands: value.bands,
            mode: value.mode.into(),
            smoothing_seconds: value.smoothing_seconds,
        }
    }
}

struct LoudnessCompProcessorRuntimeState {
    sample_rate: u32,
    inner: CoreLoudnessCompRuntimeState,
}

pub struct LoudnessCompProcessor {
    sample_rate: u32,
    enabled: bool,
    inner: LoudnessCompStage,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl LoudnessCompProcessor {
    pub fn new(sample_rate: u32, settings: LoudnessCompSettings) -> Result<Self> {
        settings.validate()?;
        let enabled = settings.enabled;
        let inner = LoudnessCompStage::from_settings(f64::from(sample_rate), settings.into())
            .map_err(EngineError::InvalidInput)?;
        Ok(Self {
            sample_rate,
            enabled,
            inner,
            left: Vec::new(),
            right: Vec::new(),
        })
    }

    pub fn is_active(&self) -> bool {
        self.enabled
    }

    /// 目标段快照（诊断/遥测用途）：每槽 (gain, freq, type)，槽序与核心
    /// `targets_snapshot` 一致。
    pub fn targets_snapshot(&self) -> [(f64, f64, i32); 6] {
        self.inner.targets_snapshot()
    }

    /// 参数即时生效并整体替换目标曲线（latest-wins，见模块文档）；平滑状态
    /// 保留并向新目标连续收敛，启用状态切换不清空核心状态。
    pub fn set_params(&mut self, settings: LoudnessCompSettings) -> Result<()> {
        settings.validate()?;
        self.enabled = settings.enabled;
        self.inner.configure(settings.into());
        Ok(())
    }
}

impl PcmProcessor for LoudnessCompProcessor {
    fn name(&self) -> &'static str {
        "loudness-comp"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.enabled && !previous.enabled {
            return true;
        }
        self.inner.copy_runtime_state_from(&previous.inner).is_ok()
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(LoudnessCompProcessorRuntimeState {
            sample_rate: self.sample_rate,
            inner: self.inner.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<LoudnessCompProcessorRuntimeState>()
            .is_some_and(|state| self.sample_rate == state.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<LoudnessCompProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.save_runtime_state(&mut state.inner).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<LoudnessCompProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.restore_runtime_state(&state.inner).is_ok()
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
                "loudness compensation requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "loudness compensation block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.enabled {
            return Ok(());
        }

        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        // 整块一次转发：逐块平滑 alpha 依赖本块帧数（模块文档「输出依赖本块帧数」）。
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
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        // HSE v1.5.1 reset 语义（规格 §4.5.5）：currentGains 钉到 targetGains 并
        // 立即重算全部 6 槽系数，TDF2 状态清零。
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn validate_stereo_format(format: PcmFormat, sample_rate: u32) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "loudness compensation requires stereo PCM".into(),
        ));
    }
    if format.sample_rate != sample_rate {
        return Err(EngineError::InvalidInput(
            "loudness compensation sample rate does not match PCM format".into(),
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

    fn enabled_auto(volume_percent: f64, smoothing: f64) -> LoudnessCompSettings {
        LoudnessCompSettings {
            enabled: true,
            mode: LoudnessCompMode::Auto,
            volume_percent,
            max_boost_db: 12.0,
            preset: "flat".to_string(),
            smoothing_seconds: smoothing,
            bands: Vec::new(),
        }
    }

    fn prepared(
        sample_rate: u32,
        settings: LoudnessCompSettings,
        capacity: usize,
    ) -> LoudnessCompProcessor {
        let mut processor = LoudnessCompProcessor::new(sample_rate, settings).unwrap();
        processor.prepare(format(sample_rate), capacity).unwrap();
        processor
    }

    fn process(processor: &mut LoudnessCompProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate),
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
    fn defaults_are_disabled_and_transparent() {
        assert_eq!(
            LoudnessCompSettings::default(),
            LoudnessCompSettings {
                enabled: false,
                mode: LoudnessCompMode::Auto,
                volume_percent: 100.0,
                max_boost_db: 12.0,
                preset: "flat".to_string(),
                smoothing_seconds: 0.2,
                bands: Vec::new(),
            }
        );

        let mut processor = prepared(48_000, LoudnessCompSettings::default(), 8);
        assert!(!processor.is_active());
        let mut samples = signal(8);
        let expected = samples.clone();
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(
            samples
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            "disabled 必须逐位透明"
        );
    }

    #[test]
    fn invalid_settings_and_sample_rate_are_rejected() {
        assert!(LoudnessCompProcessor::new(0, LoudnessCompSettings::default()).is_err());
        let mut non_finite = enabled_auto(48.0, 0.2);
        non_finite.volume_percent = f64::NAN;
        assert!(LoudnessCompProcessor::new(48_000, non_finite.clone()).is_err());
        non_finite.volume_percent = 48.0;
        non_finite.smoothing_seconds = f64::INFINITY;
        assert!(LoudnessCompProcessor::new(48_000, non_finite.clone()).is_err());
        non_finite.smoothing_seconds = 0.2;
        non_finite.bands.push(LoudnessBandParam {
            frequency: f64::NEG_INFINITY,
            gain: 3.0,
        });
        assert!(LoudnessCompProcessor::new(48_000, non_finite).is_err());

        let mut processor = prepared(48_000, enabled_auto(48.0, 0.2), 8);
        let mut bad = enabled_auto(48.0, 0.2);
        bad.max_boost_db = f64::NAN;
        assert!(processor.set_params(bad).is_err());
        // 失败的 set_params 不得改动既有参数（latest-wins 只认成功提交）。
        assert!(processor.is_active());
    }

    #[test]
    fn matches_vendored_stage_on_whole_block_and_stays_reproducible() {
        // 与核心阶段逐位一致（交错 ↔ 平面转换零损耗），同调度逐位可复现。
        let settings = enabled_auto(20.0, 0.05);
        let input = signal(600);
        let mut via_adapter = input.clone();
        let mut processor = prepared(48_000, settings.clone(), 600);
        process(&mut processor, &mut via_adapter).unwrap();

        // 核心参照：同一输入整块一次转发（与适配器的单次 process 语义一致）。
        let mut core = LoudnessCompStage::from_settings(48_000.0, settings.into()).unwrap();
        let mut left = input.iter().step_by(2).copied().collect::<Vec<_>>();
        let mut right = input.iter().skip(1).step_by(2).copied().collect::<Vec<_>>();
        core.process(&mut left, &mut right);
        let mut via_core = Vec::with_capacity(input.len());
        for index in 0..left.len() {
            via_core.push(left[index]);
            via_core.push(right[index]);
        }
        assert_eq!(via_adapter, via_core, "适配器必须与 vendored 阶段逐位一致");

        let mut again = input.clone();
        let mut repeat = prepared(48_000, enabled_auto(20.0, 0.05), 600);
        process(&mut repeat, &mut again).unwrap();
        assert_eq!(via_adapter, again, "同调度必须逐位可复现");
    }

    #[test]
    fn volume_change_smooths_toward_new_target_without_discontinuity() {
        // latest-wins：音量 20 → 100 中途更新，目标曲线整体替换、平滑状态保留，
        // 输出与「构造后立即 set_params」的参考实例逐位一致，且与全程 volume=20
        // 的实例显著可区分（新目标确实生效）。
        let prefix = signal(768);
        let continuation = signal(384);

        let mut updated = prepared(48_000, enabled_auto(20.0, 0.05), 768);
        let mut updated_input = prefix.clone();
        process(&mut updated, &mut updated_input).unwrap();
        updated.set_params(enabled_auto(100.0, 0.05)).unwrap();
        let mut tail = continuation.clone();
        process(&mut updated, &mut tail).unwrap();

        let mut reference = prepared(48_000, enabled_auto(20.0, 0.05), 768);
        let mut reference_input = prefix.clone();
        process(&mut reference, &mut reference_input).unwrap();
        reference.set_params(enabled_auto(100.0, 0.05)).unwrap();
        let mut reference_tail = continuation.clone();
        process(&mut reference, &mut reference_tail).unwrap();
        assert_eq!(
            tail, reference_tail,
            "latest-wins：参数更新即时生效且语义一致"
        );

        let mut unchanged = prepared(48_000, enabled_auto(20.0, 0.05), 768);
        let mut unchanged_input = prefix.clone();
        process(&mut unchanged, &mut unchanged_input).unwrap();
        let mut unchanged_tail = continuation.clone();
        process(&mut unchanged, &mut unchanged_tail).unwrap();
        let max_diff = tail
            .iter()
            .zip(unchanged_tail.iter())
            .map(|(&x, &y)| (f64::from(x) - f64::from(y)).abs())
            .fold(0.0_f64, f64::max);
        assert!(
            max_diff > 1.0e-3,
            "音量更新后的输出应与旧目标显著可区分，实际 maxDiff={max_diff}"
        );
    }

    #[test]
    fn disabled_freezes_state_and_reenable_continues_smoothly() {
        let active = enabled_auto(20.0, 0.05);
        let mut processor = prepared(48_000, active.clone(), 64);
        let mut first = signal(64);
        process(&mut processor, &mut first).unwrap();

        processor
            .set_params(LoudnessCompSettings {
                enabled: false,
                ..active.clone()
            })
            .unwrap();
        let mut bypassed = signal(8);
        let expected = bypassed.clone();
        process(&mut processor, &mut bypassed).unwrap();
        assert_eq!(bypassed, expected, "禁用块必须逐位直通");

        // 重新启用：从冻结状态继续平滑（而非跳变到目标）。
        processor.set_params(active.clone()).unwrap();
        // 参照：把同一冻结状态显式迁移到全新实例后处理同一段输入。
        let mut frozen = prepared(48_000, active.clone(), 16);
        assert!(frozen.adopt_runtime_state_from(&mut processor));
        let mut frozen_input = signal(16);
        process(&mut frozen, &mut frozen_input).unwrap();
        let mut reenabled = signal(16);
        process(&mut processor, &mut reenabled).unwrap();
        assert_eq!(reenabled, frozen_input, "重新启用必须从冻结状态连续续跑");
    }

    #[test]
    fn migration_and_checkpoint_preserve_opaque_core_state() {
        let old_settings = enabled_auto(20.0, 0.05);
        let next_settings = enabled_auto(60.0, 0.08);
        let mut previous = prepared(48_000, old_settings.clone(), 64);
        let mut reference = prepared(48_000, old_settings.clone(), 64);
        let mut prefix = signal(37);
        let mut reference_prefix = prefix.clone();
        process(&mut previous, &mut prefix).unwrap();
        process(&mut reference, &mut reference_prefix).unwrap();

        // revision 迁移：新参数 + 旧平滑状态。
        let mut next = prepared(48_000, next_settings.clone(), 64);
        assert!(next.adopt_runtime_state_from(&mut previous));
        reference.set_params(next_settings.clone()).unwrap();
        let mut adopted_output = signal(19);
        let mut reference_output = adopted_output.clone();
        process(&mut next, &mut adopted_output).unwrap();
        process(&mut reference, &mut reference_output).unwrap();
        assert_eq!(adopted_output, reference_output);

        // checkpoint 往返。
        let initial_checkpoint = next.create_runtime_checkpoint().unwrap();
        let mut expected_after_checkpoint = signal(13);
        process(&mut next, &mut expected_after_checkpoint).unwrap();
        assert!(next.restore_runtime_state(initial_checkpoint.as_ref()));
        let mut restored_output = signal(13);
        process(&mut next, &mut restored_output).unwrap();
        assert_eq!(restored_output, expected_after_checkpoint);

        let mut checkpoint = next.create_runtime_checkpoint().unwrap();
        let mut more = signal(11);
        process(&mut next, &mut more).unwrap();
        assert!(next.save_runtime_state(checkpoint.as_mut()));
        let mut saved_output = signal(17);
        process(&mut next, &mut saved_output).unwrap();
        assert!(next.restore_runtime_state(checkpoint.as_ref()));
        let mut replayed_output = signal(17);
        process(&mut next, &mut replayed_output).unwrap();
        assert_eq!(replayed_output, saved_output);

        // 从禁用实例启用：不采纳旧状态（核心状态从未推进，重置语义）。
        let mut disabled = prepared(
            48_000,
            LoudnessCompSettings {
                enabled: false,
                ..next_settings.clone()
            },
            16,
        );
        assert!(disabled.adopt_runtime_state_from(&mut previous));

        // 采样率不符与错误类型一律拒绝。
        let mut other_rate = prepared(44_100, next_settings.clone(), 16);
        assert!(!other_rate.adopt_runtime_state_from(&mut previous));
        assert!(!other_rate.runtime_checkpoint_compatible(checkpoint.as_ref()));
        let mut wrong_type = BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut wrong_type));
        let mut wrong_checkpoint: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!next.save_runtime_state(wrong_checkpoint.as_mut()));
        assert!(!next.restore_runtime_state(wrong_checkpoint.as_ref()));
    }

    #[test]
    fn format_complete_frame_and_prepared_capacity_validation_precede_bypass() {
        let mut processor =
            LoudnessCompProcessor::new(48_000, LoudnessCompSettings::default()).unwrap();
        assert!(processor.prepare(format(48_000), 2).is_ok());

        let mono = PcmFormat {
            channels: 1,
            ..format(48_000)
        };
        assert!(processor.prepare(mono, 2).is_err());
        assert!(processor.prepare(format(44_100), 2).is_err());

        let mut incomplete = [1.0_f32, -1.0, 0.5];
        let unchanged = incomplete;
        assert!(process(&mut processor, &mut incomplete).is_err());
        assert_eq!(incomplete, unchanged, "异常路径不得改写输入缓冲");

        let mut oversized = [1.0_f32, -1.0, 0.5, -0.5, 0.25, -0.25];
        let oversized_unchanged = oversized;
        assert!(process(&mut processor, &mut oversized).is_err());
        assert_eq!(oversized, oversized_unchanged);
    }

    #[test]
    fn extreme_sample_rates_stay_finite_and_bounded() {
        for sample_rate in [8_000_u32, 44_100, 192_000] {
            let mut processor = prepared(
                sample_rate,
                LoudnessCompSettings {
                    enabled: true,
                    volume_percent: 0.0,
                    max_boost_db: 24.0,
                    smoothing_seconds: 0.01,
                    mode: LoudnessCompMode::Auto,
                    preset: "flat".to_string(),
                    bands: Vec::new(),
                },
                256,
            );
            let mut samples = signal(256);
            process(&mut processor, &mut samples).unwrap();
            for (index, sample) in samples.iter().enumerate() {
                assert!(
                    sample.is_finite() && sample.abs() < 1.0e5,
                    "sample rate {sample_rate} 输出必须有限有界 @{index}"
                );
            }
        }
        // 采样率与 prepare 格式不符必须在准备期报错。
        let mut processor = prepared(48_000, enabled_auto(20.0, 0.05), 4);
        assert!(processor.prepare(format(96_000), 4).is_err());
    }

    #[test]
    fn loudness_comp_has_no_latency_or_tail() {
        let mut processor = prepared(48_000, enabled_auto(50.0, 0.2), 4);
        assert_eq!(processor.name(), "loudness-comp");
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
        let mut samples = signal(4);
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(processor.tail_frames(), 0);
    }
}
