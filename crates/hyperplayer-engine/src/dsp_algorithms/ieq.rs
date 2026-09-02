//! HSE v1.5.1 Stage 16 IEQ + Stage 17 Analysis 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::engine_chain` 的 [`SpectrumAnalyzer`]（Stage 17
//! 权威频谱分析：mid 下混环形窗 + Hann + 2048 FFT 幅度谱）与 [`IeqController`]
//!（Stage 16 IEQ：参数态与平滑运行态分离，从幅度谱驱动 10-band 平滑增益）权威
//! 实现；本模块仅负责统一生命周期、立体声交错/平面转换与链位适配。
//!
//! # 分析 / 显示 / 参数态边界
//!
//! - **权威分析运行态**：[`SpectrumAnalyzer`] 内部（ring/write_pos/pending 帧数/谱
//!   缓冲），经其 `save/restore/snapshot/copy_runtime_state` 四件套迁移；
//! - **IEQ 参数态**：[`IeqParams`]（enabled/strength/target_curve/time_constant_sec），
//!   [`IeqController::set_params`] 即时生效，平滑运行态保留；
//! - **显示快照**：[`IeqController::display_snapshot`]（10-band 平滑增益 + 带电平），
//!   非实时路径取出；本 adapter 经 `ieq_snapshot()` 暴露。
//!
//! # 链位与默认
//!
//! HSE IDS 第 16/17 位，插在 `loudness-comp(15)` 之后、`dynamic-eq(18)` 之前。
//! 默认 `enabled=false`（HyperPlayer 透明默认链）；禁用即逐位直通且分析窗状态
//! 不推进、IEQ 增益不更新、无谱发布。实时线程零分配（工作缓冲 prepare 预分配，
//! 分析谱缓冲由 `SpectrumAnalyzer` 与 `IeqController` 内部持有）。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason, RuntimeStateCapability};
use crate::error::{EngineError, Result};
use hse_core::engine_chain::{
    AnalysisRuntimeState, IeqController, IeqDisplaySnapshot, IeqParams,
    IeqRuntimeState as CoreIeqRuntimeState, IeqTargetCurve, SpectrumAnalyzer,
};
use hse_core::eq_chain::EqChainRuntimeState;
use hse_core::eq_chain::{EqBandParam, EqChainStage};

/// Stage 16 IEQ 参数快照。默认 disabled（HyperPlayer 透明默认链）。
#[derive(Clone, Debug, PartialEq)]
pub struct IeqSettings {
    pub enabled: bool,
    /// IEQ 目标强度 ∈ [0, 1]（核心同域钳制）。
    pub strength: f64,
    /// 目标曲线。
    pub target_curve: IeqTargetCurve,
    /// 平滑时间常数（秒）∈ [0.1, 10]（核心用 max(time_constant, 0.1) 计算）。
    pub time_constant_sec: f64,
}

impl Default for IeqSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            strength: 0.5,
            target_curve: IeqTargetCurve::Flat,
            time_constant_sec: 1.0,
        }
    }
}

impl IeqSettings {
    fn to_params(&self) -> IeqParams {
        IeqParams {
            enabled: self.enabled,
            strength: self.strength,
            target_curve: self.target_curve,
            time_constant_sec: self.time_constant_sec,
        }
    }
}

/// Stage 16/17 权威运行态快照：分析窗状态 + IEQ 平滑状态 + EQ 链状态。
#[derive(Clone)]
struct IeqProcessorRuntimeState {
    sample_rate_bits: u64,
    analysis: AnalysisRuntimeState,
    ieq: CoreIeqRuntimeState,
    eq: EqChainRuntimeState,
}

/// Stage 16/17 适配器：内含分析器 + IEQ 控制器 + 10-band EQ 链。
pub struct IeqProcessor {
    sample_rate: f64,
    settings: IeqSettings,
    analyzer: SpectrumAnalyzer,
    controller: IeqController,
    eq: EqChainStage,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl IeqProcessor {
    pub fn new(sample_rate: f64, settings: IeqSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        let analyzer = SpectrumAnalyzer::new().map_err(EngineError::InvalidInput)?;
        let controller = IeqController::new(sample_rate, settings.to_params());
        let mut eq = EqChainStage::new(sample_rate, 10.0).map_err(EngineError::InvalidInput)?;
        // IEQ 固定交叉 31.5..16000，q=1.1，频率先置 0（增益随分析更新）。
        eq.set_bands(&controller.eq_bands().clone());
        Ok(Self {
            sample_rate,
            settings,
            analyzer,
            controller,
            eq,
            left: Vec::new(),
            right: Vec::new(),
        })
    }

    pub fn settings(&self) -> &IeqSettings {
        &self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 参数即时生效并保留运行态（IEQ 平滑增益随强度/曲线/时间常数连续更新）。
    pub fn set_params(&mut self, settings: IeqSettings) -> Result<()> {
        validate_ieq(&settings)?;
        let became_active = !self.is_active() && settings.enabled;
        self.controller.set_params(settings.to_params());
        if became_active {
            self.reset_runtime_state();
        }
        self.settings = settings;
        Ok(())
    }

    /// IEQ 显示快照（10-band 平滑增益 + 带电平；控制路径读取）。
    pub fn ieq_snapshot(&self) -> IeqDisplaySnapshot {
        self.controller.display_snapshot()
    }

    /// 分析器句柄（供 telemetry publisher 读取幅度谱；非实时路径）。
    pub fn analyzer(&self) -> &SpectrumAnalyzer {
        &self.analyzer
    }

    fn reset_runtime_state(&mut self) {
        self.analyzer.reset();
        self.controller.reset();
        // EQ 链增益归零。
        let bands = vec![
            EqBandParam {
                frequency: 0.0,
                gain: 0.0,
                q: 1.1,
            };
            10
        ];
        self.eq.set_bands(&bands);
    }
}

impl PcmProcessor for IeqProcessor {
    fn name(&self) -> &'static str {
        "ieq-post"
    }

    fn runtime_state_capability(&self) -> RuntimeStateCapability {
        RuntimeStateCapability::Stateful
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.is_active() && previous.is_active() {
            // 三个组件分别校验拓扑一致性（分析窗长度/采样率），任一不兼容则整体拒绝。
            if previous.analyzer.snapshot_runtime_state().ring.len() != 2048 {
                return false;
            }
            // 从 previous 提取快照，再恢复进 self（逐组件，原子失败即整体拒绝）。
            let analysis = previous.analyzer.snapshot_runtime_state();
            let ieq = previous.controller.snapshot_runtime_state();
            let eq_state = previous.eq.snapshot_runtime_state();
            let ok = self.analyzer.restore_runtime_state(&analysis).is_ok()
                && self.controller.restore_runtime_state(&ieq).is_ok()
                && self.eq.restore_runtime_state(&eq_state).is_ok();
            if !ok {
                // 部分恢复不作祟：回退到干净状态。
                self.reset_runtime_state();
                return false;
            }
            true
        } else {
            if self.is_active() {
                self.reset_runtime_state();
            }
            true
        }
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(IeqProcessorRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            analysis: self.analyzer.snapshot_runtime_state(),
            ieq: self.controller.snapshot_runtime_state(),
            eq: self.eq.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<IeqProcessorRuntimeState>()
            .is_some_and(|state| state.sample_rate_bits == self.sample_rate.to_bits())
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<IeqProcessorRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        if self
            .analyzer
            .save_runtime_state(&mut state.analysis)
            .is_err()
        {
            return false;
        }
        if self.controller.save_runtime_state(&mut state.ieq).is_err() {
            return false;
        }
        if self.eq.save_runtime_state(&mut state.eq).is_err() {
            return false;
        }
        true
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<IeqProcessorRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        if self
            .analyzer
            .restore_runtime_state(&state.analysis)
            .is_err()
        {
            return false;
        }
        if self.controller.restore_runtime_state(&state.ieq).is_err() {
            return false;
        }
        if self.eq.restore_runtime_state(&state.eq).is_err() {
            return false;
        }
        true
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
                "ieq requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "ieq block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.is_active() {
            // 禁用：逐位直通，分析/IEQ 状态不推进。
            return Ok(());
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        // 先分析（mid 下混），攒满 2048 帧触发一次窗口分析 + IEQ 增益更新。
        let due = self
            .analyzer
            .push(&self.left[..frames], &self.right[..frames]);
        if due > 0 {
            for _ in 0..due {
                self.analyzer.analyze_window();
            }
            // 以最新幅度谱驱动 IEQ 平滑增益，并应用到 10-band EQ 链。
            let magnitude = self.analyzer.magnitude().to_vec();
            self.controller.update_from_magnitude(&magnitude);
            self.eq.set_bands(self.controller.eq_bands());
        }
        // 将 IEQ 均衡应用到信号（f32 增益已写入 bands，这里只处理真实信号）。
        self.eq.process_interleaved_stereo_shared(block.interleaved);
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.reset_runtime_state();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn validate_sample_rate(sample_rate: f64) -> Result<()> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(EngineError::InvalidInput(
            "ieq sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported("ieq requires stereo PCM".into()));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "ieq sample rate does not match PCM format".into(),
        ));
    }
    Ok(())
}

fn validate_ieq(settings: &IeqSettings) -> Result<()> {
    if !settings.strength.is_finite() || !(0.0..=1.0).contains(&settings.strength) {
        return Err(EngineError::InvalidInput(
            "ieq strength must be finite within [0, 1]".into(),
        ));
    }
    if !settings.time_constant_sec.is_finite()
        || !(0.1..=10.0).contains(&settings.time_constant_sec)
    {
        return Err(EngineError::InvalidInput(
            "ieq timeConstantSec must be finite within [0.1, 10]".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::PcmSampleFormat;

    fn format(sample_rate: u32) -> PcmFormat {
        PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    fn active(settings: &IeqSettings) -> IeqProcessor {
        let mut processor = IeqProcessor::new(48_000.0, settings.clone()).unwrap();
        processor.prepare(format(48_000), 2048).unwrap();
        processor
    }

    fn process(processor: &mut IeqProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate as u32),
            interleaved: samples,
        })
    }

    fn lcg_noise(n: usize, seed: u32, amp: f64) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((f64::from(s) / 4294967296.0) * 2.0 - 1.0) * amp
            })
            .map(|v| v as f32)
            .collect()
    }

    #[test]
    fn defaults_are_disabled_transparent() {
        let settings = IeqSettings::default();
        assert!(!settings.enabled);
        let mut processor = active(&settings);
        assert_eq!(processor.name(), "ieq-post");
        let input = lcg_noise(64, 42, 0.5);
        let mut samples = input.clone();
        let expected = samples.iter().map(|s| s.to_bits()).collect::<Vec<_>>();
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(
            samples.iter().map(|s| s.to_bits()).collect::<Vec<_>>(),
            expected,
            "禁用必须逐位直通"
        );
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
    }

    #[test]
    fn invalid_settings_fail_closed() {
        for sample_rate in [0.0, -48_000.0, f64::NAN, f64::INFINITY] {
            assert!(IeqProcessor::new(sample_rate, IeqSettings::default()).is_err());
        }
        let invalid = IeqSettings {
            strength: 1.5,
            ..IeqSettings::default()
        };
        assert!(validate_ieq(&invalid).is_err());
        let invalid = IeqSettings {
            time_constant_sec: 0.05,
            ..IeqSettings::default()
        };
        assert!(validate_ieq(&invalid).is_err());
    }

    #[test]
    fn snapshot_present_but_zeroed_until_enabled() {
        let processor = active(&IeqSettings::default());
        let snapshot = processor.ieq_snapshot();
        assert_eq!(snapshot.gains, [0.0; 10]);
        assert_eq!(snapshot.band_levels_db, [0.0; 10]);
    }

    #[test]
    fn enabled_process_runs_and_reports_snapshot() {
        let settings = IeqSettings {
            enabled: true,
            strength: 0.8,
            target_curve: IeqTargetCurve::Vocal,
            time_constant_sec: 1.0,
        };
        let mut processor = active(&settings);
        // 攒满 2048 帧触发分析 + IEQ 更新。
        let frames = 2048_usize;
        let mut samples = lcg_noise(frames * 2, 7, 0.4);
        process(&mut processor, &mut samples).unwrap();
        let snapshot = processor.ieq_snapshot();
        assert!(
            snapshot.band_levels_db.iter().any(|&v| v != 0.0),
            "启用后带电平应在分析后更新"
        );
        assert!(
            snapshot.gains.iter().any(|&v| v != 0.0),
            "启用后增益应随分析更新"
        );
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
    }
}
