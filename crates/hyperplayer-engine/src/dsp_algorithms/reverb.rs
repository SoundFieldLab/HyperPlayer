//! HSE v1.5.1 Stage 13 Reverb 的 HyperPlayer PCM 适配器。
//!
//! 三种混响模式的 DSP 运算与运行状态由 `hse_core` 权威实现（与 HSE v1.5.1
//! 引擎链 `reverb.kind` 语义对齐）：
//!
//! - `Algorithmic` → `hse_core::reverb_simple::ReverbSimpleStage`（Freeverb 类，
//!   上游 `reverb.mode = "algorithmic"`）；
//! - `Fdn` → `hse_core::fdn_reverb::FdnReverbStage`（反馈延迟网络，上游
//!   `reverb.mode = "fdn"`，与 algorithmic 共用 wet/dry/width/preDelay/type 参数）；
//! - `Convolution` → `hse_core::convolver::ConvolverStage`（非均匀分区卷积，上游
//!   `reverb.mode = "convolution"`）。
//!
//! 本模块仅负责 HyperPlayer 参数快照、模式编排、生命周期、立体声交错/平面转换和
//! 实时缓冲管理。IR 一律来自确定性配方（[`IrRecipe`]），不做第三方 IR 文件解码——
//! 未审计 IR 不进入本切片（见切片铁律）。
//!
//! # 模式/拓扑切换语义
//!
//! - 模式切换（Algorithmic ⇄ Fdn ⇄ Convolution）属于结构重建：[`ReverbProcessor::set_params`]
//!   内部整体重建核心 stage（状态清零）；revision 迁移（[`PcmProcessor::adopt_runtime_state_from`]）
//!   返回 `false`，由链层复位。
//! - checkpoint 迁移要求同模式 + 同采样率 + 同延迟拓扑（algorithmic 的梳状/全通
//!   长度、FDN 的线数与线长、卷积的 IR 指纹）。type/lines/IR 等拓扑性参数变化即
//!   checkpoint 不兼容；wet/dry/width/mix/preDelay 等非拓扑参数可带状态迁移。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
// Pub re-export：src-tauri DTO 层直接取 IR 配方类型（同 LoudnessBandParam 先例）。
pub use hse_core::convolver::IrRecipe;
use hse_core::convolver::{
    build_ir_recipe, ConvolverOptions, ConvolverRuntimeState as CoreConvolverRuntimeState,
    ConvolverStage,
};
use hse_core::fdn_reverb::{
    FdnReverbParams, FdnReverbRuntimeState as CoreFdnReverbRuntimeState, FdnReverbStage,
};
use hse_core::reverb_simple::{
    ReverbSimpleParams, ReverbSimpleRuntimeState as CoreReverbSimpleRuntimeState, ReverbSimpleStage,
};
use hse_core::Stage as HseStage;

/// 混响模式（对齐 HSE 上游 `reverb.mode`；`off`/禁用以 `enabled = false` 表达）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReverbMode {
    /// Freeverb 类算法混响（上游 `algorithmic`）。
    #[default]
    Algorithmic,
    /// FDN 反馈延迟网络混响（上游 `fdn`）。
    Fdn,
    /// 非均匀分区卷积混响（上游 `convolution`）。
    Convolution,
}

impl ReverbMode {
    /// HSE 固定阶段编号（控制面/工作台展示用）。
    pub const HSE_STAGE_ID: u8 = 13;

    /// 上游 JSON 的模式名（诊断/DTO 参考）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Algorithmic => "algorithmic",
            Self::Fdn => "fdn",
            Self::Convolution => "convolution",
        }
    }
}

/// 五种房间类型基准（对齐 TS `ReverbType`，未知值在 DTO 层拒绝而非回退）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReverbType {
    #[default]
    Hall,
    Room,
    Plate,
    Spring,
    Stage,
}

impl ReverbType {
    /// 上游 JSON 的类型名。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hall => "hall",
            Self::Room => "room",
            Self::Plate => "plate",
            Self::Spring => "spring",
            Self::Stage => "stage",
        }
    }
}

/// 统一三种模式的混响参数快照。
///
/// `Algorithmic`/`Fdn` 共用 `reverb_type/room_size/damping/wet/dry/pre_delay_ms/width`
/// （上游 fdn 模式即复用 algorithmic 参数表）；`Convolution` 使用 `mix/pre_delay_ms`
/// 与 [`IrRecipe`] 配方。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbSettings {
    pub enabled: bool,
    pub mode: ReverbMode,
    pub reverb_type: ReverbType,
    /// 房间大小（0..1，core 侧按 type 基准 ±0.25 混合后钳制）。
    pub room_size: f64,
    /// 阻尼（0..1，语义同上）。
    pub damping: f64,
    /// 湿路增益（0..4）。
    pub wet: f64,
    /// 干路增益（0..4）。
    pub dry: f64,
    /// 湿路预延迟 ms（0..1000；三种模式统一语义）。
    pub pre_delay_ms: f64,
    /// 立体声扩展（0..2）。
    pub width: f64,
    /// FDN 线数，仅允许 2/4/8/16。
    pub fdn_lines: u32,
    /// 卷积模式干湿混合（0..1，1 = 纯湿）。
    pub mix: f64,
    /// 卷积模式 IR 去周期化开关。
    pub de_periodize: bool,
    /// 卷积最短分区长 Ls（样本；core 钳制 32..8192；= 湿路延迟）。
    pub partition_size: f64,
    /// 卷积长分区长（向上取 Ls 的 2 的幂整数倍）。
    pub long_partition_size: f64,
    /// 卷积短区段时长 ms（0..5000）。
    pub short_region_ms: f64,
    /// 卷积 IR 配方；`None` 时 Convolution 模式构造报错（无第三方 IR 文件解码）。
    pub ir_recipe: Option<IrRecipe>,
}

impl Default for ReverbSettings {
    fn default() -> Self {
        // 默认值对齐 HSE 上游 createDefaultParams 的 reverb 段；enabled=false。
        Self {
            enabled: false,
            mode: ReverbMode::default(),
            reverb_type: ReverbType::default(),
            room_size: 0.5,
            damping: 0.5,
            wet: 0.3,
            dry: 0.7,
            pre_delay_ms: 0.0,
            width: 1.0,
            fdn_lines: 8,
            mix: 0.3,
            de_periodize: true,
            partition_size: 512.0,
            long_partition_size: 4096.0,
            short_region_ms: 100.0,
            ir_recipe: None,
        }
    }
}

/// 混响核心 stage 的模式编排。
// Algorithmic（Freeverb 状态体积小）与 Box 化的 Fdn/Convolution 体积差异属设计内
// ——实时热路径要求 Fdn/Convolution 走堆分配，Algorithmic 保持内联零间接。
#[allow(clippy::large_enum_variant)]
enum ReverbEngine {
    Algorithmic(ReverbSimpleStage),
    Fdn(Box<FdnReverbStage>),
    Convolution(Box<ConvolverStage>),
}

/// 处理延迟与尾音（帧）由构造/换参时重算，实时路径只读。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ReverbTiming {
    latency_frames: u32,
    tail_frames: u32,
}

fn saturating_frames(samples: usize) -> u32 {
    u32::try_from(samples).unwrap_or(u32::MAX)
}

/// 统一混响 PCM 适配器。
pub struct ReverbProcessor {
    sample_rate: f64,
    settings: ReverbSettings,
    engine: ReverbEngine,
    timing: ReverbTiming,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl ReverbProcessor {
    pub fn new(sample_rate: f64, settings: ReverbSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(settings)?;
        let engine = build_engine(sample_rate, settings)?;
        let mut processor = Self {
            sample_rate,
            settings,
            engine,
            timing: ReverbTiming::default(),
            left: Vec::new(),
            right: Vec::new(),
        };
        processor.refresh_timing();
        Ok(processor)
    }

    pub fn settings(&self) -> ReverbSettings {
        self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 参数即时生效。非拓扑参数原位更新并保留核心状态；模式切换、卷积分区/
    /// IR/去周期化变化属于结构重建（核心状态清零）。
    pub fn set_params(&mut self, settings: ReverbSettings) -> Result<()> {
        validate_settings(settings)?;
        if settings.mode == self.settings.mode {
            match &mut self.engine {
                ReverbEngine::Algorithmic(stage) => {
                    stage.configure(algorithmic_params(settings));
                }
                ReverbEngine::Fdn(stage) => {
                    // 线数已在 validate_settings 校验，set_params 不可能失败。
                    stage
                        .set_params(fdn_params(settings))
                        .map_err(EngineError::InvalidInput)?;
                }
                ReverbEngine::Convolution(stage) => {
                    // 分区/IR/去周期化变化 → 重建（拓扑变化）；否则原位生效。
                    if self.settings.de_periodize != settings.de_periodize
                        || self.settings.partition_size != settings.partition_size
                        || self.settings.long_partition_size != settings.long_partition_size
                        || self.settings.short_region_ms != settings.short_region_ms
                        || self.settings.ir_recipe != settings.ir_recipe
                    {
                        self.engine = build_engine(self.sample_rate, settings)?;
                    } else {
                        stage.set_mix(settings.mix);
                        stage.set_pre_delay_ms(settings.pre_delay_ms);
                    }
                }
            }
            self.settings = settings;
            self.refresh_timing();
            return Ok(());
        }
        // 模式切换：整体重建。
        self.engine = build_engine(self.sample_rate, settings)?;
        self.settings = settings;
        self.refresh_timing();
        Ok(())
    }

    fn refresh_timing(&mut self) {
        self.timing = match &self.engine {
            ReverbEngine::Algorithmic(stage) => ReverbTiming {
                latency_frames: 0,
                tail_frames: saturating_frames(stage.tail_samples()),
            },
            ReverbEngine::Fdn(stage) => ReverbTiming {
                latency_frames: 0,
                tail_frames: saturating_frames(stage.tail_samples()),
            },
            ReverbEngine::Convolution(stage) => ReverbTiming {
                latency_frames: saturating_frames(stage.get_latency_samples()),
                tail_frames: saturating_frames(stage.tail_samples()),
            },
        };
    }

    fn reset_runtime_state(&mut self) {
        match &mut self.engine {
            ReverbEngine::Algorithmic(stage) => stage.reset(),
            ReverbEngine::Fdn(stage) => stage.reset(),
            ReverbEngine::Convolution(stage) => stage.reset(),
        }
    }
}

/// checkpoint 载体：模式 + 采样率（引擎侧核对）+ 对应模式的核心状态。
///
/// 模式枚举天然承担「模式切换 ⇒ checkpoint 不兼容」判定。
#[derive(Clone)]
struct ReverbRuntimeState {
    sample_rate: f64,
    core: ReverbCoreState,
}

#[derive(Clone)]
// 体积差异说明同 [`ReverbEngine`]：非实时 checkpoint 路径，布局跟随核心状态自然尺寸。
#[allow(clippy::large_enum_variant)]
enum ReverbCoreState {
    Algorithmic(CoreReverbSimpleRuntimeState),
    Fdn(CoreFdnReverbRuntimeState),
    Convolution(CoreConvolverRuntimeState),
}

fn algorithmic_params(settings: ReverbSettings) -> ReverbSimpleParams {
    ReverbSimpleParams {
        room_size: settings.room_size,
        damping: settings.damping,
        wet: settings.wet,
        dry: settings.dry,
        pre_delay_ms: settings.pre_delay_ms,
        width: settings.width,
        reverb_type: settings.reverb_type.as_str().to_string(),
    }
}

fn fdn_params(settings: ReverbSettings) -> FdnReverbParams {
    FdnReverbParams {
        room_size: settings.room_size,
        damping: settings.damping,
        wet: settings.wet,
        dry: settings.dry,
        pre_delay_ms: settings.pre_delay_ms,
        width: settings.width,
        reverb_type: settings.reverb_type.as_str().to_string(),
        lines: Some(f64::from(settings.fdn_lines)),
    }
}

fn build_engine(sample_rate: f64, settings: ReverbSettings) -> Result<ReverbEngine> {
    let engine = match settings.mode {
        ReverbMode::Algorithmic => ReverbEngine::Algorithmic(
            ReverbSimpleStage::from_params(sample_rate, algorithmic_params(settings))
                .map_err(EngineError::InvalidInput)?,
        ),
        ReverbMode::Fdn => ReverbEngine::Fdn(Box::new(
            FdnReverbStage::from_params(sample_rate, fdn_params(settings))
                .map_err(EngineError::InvalidInput)?,
        )),
        ReverbMode::Convolution => {
            let recipe = settings.ir_recipe.ok_or_else(|| {
                EngineError::InvalidInput("convolution reverb requires an IR recipe".to_string())
            })?;
            let ir = build_ir_recipe(&recipe).map_err(EngineError::InvalidInput)?;
            let mut stage = ConvolverStage::new(
                sample_rate,
                ConvolverOptions {
                    partition_size: settings.partition_size,
                    long_partition_size: settings.long_partition_size,
                    short_region_ms: settings.short_region_ms,
                    de_periodize: settings.de_periodize,
                },
            )
            .map_err(EngineError::InvalidInput)?;
            stage
                .load_ir(&ir, Some("hyperplayer-ir-recipe"))
                .map_err(EngineError::InvalidInput)?;
            stage.set_mix(settings.mix);
            stage.set_pre_delay_ms(settings.pre_delay_ms);
            ReverbEngine::Convolution(Box::new(stage))
        }
    };
    Ok(engine)
}

impl PcmProcessor for ReverbProcessor {
    fn name(&self) -> &'static str {
        "reverb"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate || self.settings.mode != previous.settings.mode
        {
            return false;
        }
        if self.is_active() && previous.is_active() {
            let adopted = match (&mut self.engine, &previous.engine) {
                (ReverbEngine::Algorithmic(target), ReverbEngine::Algorithmic(source)) => {
                    target.copy_runtime_state_from(source).is_ok()
                }
                (ReverbEngine::Fdn(target), ReverbEngine::Fdn(source)) => {
                    target.copy_runtime_state_from(source).is_ok()
                }
                (ReverbEngine::Convolution(target), ReverbEngine::Convolution(source)) => {
                    target.copy_runtime_state_from(source).is_ok()
                }
                _ => false,
            };
            if !adopted {
                return false;
            }
        } else if self.is_active() {
            self.reset_runtime_state();
        }
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        let core = match &self.engine {
            ReverbEngine::Algorithmic(stage) => ReverbCoreState::Algorithmic(
                // 快照为非实时路径；checkpoint 载体需要 owned 状态。
                stage.snapshot_runtime_state(),
            ),
            ReverbEngine::Fdn(stage) => ReverbCoreState::Fdn(stage.snapshot_runtime_state()),
            ReverbEngine::Convolution(stage) => {
                ReverbCoreState::Convolution(stage.snapshot_runtime_state())
            }
        };
        Some(Box::new(ReverbRuntimeState {
            sample_rate: self.sample_rate,
            core,
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<ReverbRuntimeState>()
            .is_some_and(|state| {
                self.sample_rate == state.sample_rate
                    && matches!(
                        (&self.engine, &state.core),
                        (
                            ReverbEngine::Algorithmic(_),
                            ReverbCoreState::Algorithmic(_)
                        ) | (ReverbEngine::Fdn(_), ReverbCoreState::Fdn(_))
                            | (
                                ReverbEngine::Convolution(_),
                                ReverbCoreState::Convolution(_)
                            )
                    )
            })
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<ReverbRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        match (&self.engine, &mut state.core) {
            (ReverbEngine::Algorithmic(stage), ReverbCoreState::Algorithmic(target)) => {
                stage.save_runtime_state(target).is_ok()
            }
            (ReverbEngine::Fdn(stage), ReverbCoreState::Fdn(target)) => {
                stage.save_runtime_state(target).is_ok()
            }
            (ReverbEngine::Convolution(stage), ReverbCoreState::Convolution(target)) => {
                stage.save_runtime_state(target).is_ok()
            }
            _ => false,
        }
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<ReverbRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        match (&mut self.engine, &state.core) {
            (ReverbEngine::Algorithmic(stage), ReverbCoreState::Algorithmic(source)) => {
                stage.restore_runtime_state(source).is_ok()
            }
            (ReverbEngine::Fdn(stage), ReverbCoreState::Fdn(source)) => {
                stage.restore_runtime_state(source).is_ok()
            }
            (ReverbEngine::Convolution(stage), ReverbCoreState::Convolution(source)) => {
                stage.restore_runtime_state(source).is_ok()
            }
            _ => false,
        }
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
                "reverb requires complete stereo frames".into(),
            ));
        }

        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "reverb block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.is_active() {
            return Ok(());
        }

        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        match &mut self.engine {
            ReverbEngine::Algorithmic(stage) => {
                stage.process(&mut self.left[..frames], &mut self.right[..frames]);
            }
            ReverbEngine::Fdn(stage) => {
                stage.process(&mut self.left[..frames], &mut self.right[..frames]);
            }
            ReverbEngine::Convolution(stage) => {
                stage.process(&mut self.left[..frames], &mut self.right[..frames]);
            }
        }
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
        self.reset_runtime_state();
    }

    fn latency_frames(&self) -> u32 {
        // 禁用即逐位直通：无处理延迟（与 tail 一起在链级折叠为 0）。
        if self.is_active() {
            self.timing.latency_frames
        } else {
            0
        }
    }

    fn tail_frames(&self) -> u32 {
        // 禁用适配器不得延长链尾（否则终端排空会被禁用混响拖住数十秒）。
        if self.is_active() {
            self.timing.tail_frames
        } else {
            0
        }
    }
}

fn validate_sample_rate(sample_rate: f64) -> Result<()> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(EngineError::InvalidInput(
            "reverb sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

/// 参数有效性（范围约束与 core 钳制一致；拓扑性约束在此硬校验）。
fn validate_settings(settings: ReverbSettings) -> Result<()> {
    let values = [
        settings.room_size,
        settings.damping,
        settings.wet,
        settings.dry,
        settings.pre_delay_ms,
        settings.width,
        settings.mix,
        settings.partition_size,
        settings.long_partition_size,
        settings.short_region_ms,
    ];
    if values.into_iter().any(|value| !value.is_finite()) {
        return Err(EngineError::InvalidInput(
            "reverb settings must be finite".into(),
        ));
    }
    if !matches!(settings.fdn_lines, 2 | 4 | 8 | 16) {
        return Err(EngineError::InvalidInput(
            "reverb fdn lines must be one of 2, 4, 8, 16".into(),
        ));
    }
    if settings.room_size < 0.0 || settings.room_size > 1.0 {
        return Err(EngineError::InvalidInput(
            "reverb room size must be within 0 and 1".into(),
        ));
    }
    if settings.damping < 0.0 || settings.damping > 1.0 {
        return Err(EngineError::InvalidInput(
            "reverb damping must be within 0 and 1".into(),
        ));
    }
    if !(0.0..=4.0).contains(&settings.wet) || !(0.0..=4.0).contains(&settings.dry) {
        return Err(EngineError::InvalidInput(
            "reverb wet/dry must be within 0 and 4".into(),
        ));
    }
    if settings.pre_delay_ms < 0.0 || settings.pre_delay_ms > 1000.0 {
        return Err(EngineError::InvalidInput(
            "reverb pre delay must be within 0 and 1000 ms".into(),
        ));
    }
    if settings.width < 0.0 || settings.width > 2.0 {
        return Err(EngineError::InvalidInput(
            "reverb width must be within 0 and 2".into(),
        ));
    }
    if !(0.0..=1.0).contains(&settings.mix) {
        return Err(EngineError::InvalidInput(
            "reverb mix must be within 0 and 1".into(),
        ));
    }
    if settings.partition_size < 32.0 || settings.partition_size > 8192.0 {
        return Err(EngineError::InvalidInput(
            "reverb partition size must be within 32 and 8192 samples".into(),
        ));
    }
    if settings.long_partition_size < settings.partition_size
        || settings.long_partition_size > 8192.0
    {
        return Err(EngineError::InvalidInput(
            "reverb long partition size must be within partition size and 8192 samples".into(),
        ));
    }
    if settings.short_region_ms < 0.0 || settings.short_region_ms > 5000.0 {
        return Err(EngineError::InvalidInput(
            "reverb short region must be within 0 and 5000 ms".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "reverb requires stereo PCM".into(),
        ));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "reverb sample rate does not match PCM format".into(),
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

    fn algorithmic(enabled: bool) -> ReverbSettings {
        ReverbSettings {
            enabled,
            mode: ReverbMode::Algorithmic,
            ..ReverbSettings::default()
        }
    }

    fn fdn(enabled: bool) -> ReverbSettings {
        ReverbSettings {
            enabled,
            mode: ReverbMode::Fdn,
            ..ReverbSettings::default()
        }
    }

    fn convolution(enabled: bool) -> ReverbSettings {
        ReverbSettings {
            enabled,
            mode: ReverbMode::Convolution,
            partition_size: 64.0,
            long_partition_size: 256.0,
            mix: 1.0,
            ir_recipe: Some(IrRecipe::Delta { delay: 0.0 }),
            ..ReverbSettings::default()
        }
    }

    fn prepared(sample_rate: f64, settings: ReverbSettings, capacity: usize) -> ReverbProcessor {
        let mut processor = ReverbProcessor::new(sample_rate, settings).unwrap();
        processor
            .prepare(format(sample_rate as u32), capacity)
            .unwrap();
        processor
    }

    fn process(processor: &mut ReverbProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate as u32),
            interleaved: samples,
        })
    }

    fn impulse(frames: usize) -> Vec<f32> {
        let mut samples = vec![0.0_f32; frames * 2];
        samples[0] = 1.0;
        samples
    }

    fn noise(frames: usize) -> Vec<f32> {
        let mut u = 0x5eed_u32;
        (0..frames * 2)
            .map(|_| {
                u = u.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (f64::from(u) / f64::from(u32::MAX) * 2.0 - 1.0) as f32
            })
            .collect()
    }

    #[test]
    fn defaults_are_disabled_and_validate_rejects_bad_configs() {
        assert!(!ReverbSettings::default().enabled);
        assert_eq!(ReverbSettings::default().mode, ReverbMode::Algorithmic);
        assert_eq!(
            ReverbProcessor::new(48_000.0, ReverbSettings::default())
                .unwrap()
                .name(),
            "reverb"
        );

        for sample_rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(ReverbProcessor::new(sample_rate, algorithmic(true)).is_err());
        }
        for settings in [
            ReverbSettings {
                room_size: f64::NAN,
                ..algorithmic(true)
            },
            ReverbSettings {
                fdn_lines: 7,
                ..fdn(true)
            },
            ReverbSettings {
                wet: 4.5,
                ..algorithmic(true)
            },
            ReverbSettings {
                pre_delay_ms: -1.0,
                ..algorithmic(true)
            },
            ReverbSettings {
                width: 2.5,
                ..algorithmic(true)
            },
            ReverbSettings {
                mix: 1.5,
                ..convolution(true)
            },
            ReverbSettings {
                partition_size: 16.0,
                ..convolution(true)
            },
            ReverbSettings {
                short_region_ms: 6000.0,
                ..convolution(true)
            },
            ReverbSettings {
                ir_recipe: None,
                ..convolution(true)
            },
        ] {
            assert!(ReverbProcessor::new(48_000.0, settings).is_err());
        }
        // 长分区小于短分区。
        assert!(ReverbProcessor::new(
            48_000.0,
            ReverbSettings {
                long_partition_size: 32.0,
                ..convolution(true)
            }
        )
        .is_err());
    }

    #[test]
    fn impulse_reverb_tails_and_latencies_per_mode() {
        // 卷积：δ IR → 湿路延迟 = Ls（checkpoint 友好的确定性锚点）。
        let mut convolution = prepared(48_000.0, convolution(true), 256);
        assert_eq!(convolution.latency_frames(), 64);
        let mut samples = impulse(256);
        process(&mut convolution, &mut samples).unwrap();
        for index in 0..64 {
            assert_eq!(samples[index * 2].to_bits(), 0_u32, "湿路延迟帧 {index}");
        }
        assert!(samples[64 * 2].abs() > 0.0, "Ls 处出现延迟直通湿声");
        assert!(convolution.tail_frames() >= 64);

        // 算法/FDN：无处理延迟，湿尾有限且远端显著衰减。
        for settings in [algorithmic(true), fdn(true)] {
            let mut processor = prepared(48_000.0, settings, 512);
            assert_eq!(processor.latency_frames(), 0);
            let tail = processor.tail_frames();
            assert!(tail > 0 && tail <= 10 * 48_000, "tail = {tail}");
            // 1 秒冲激窗（覆盖多轮反馈往返），按容量 512 帧分块驱动。
            let frames = 48_000;
            let mut samples = impulse(frames);
            for chunk in samples.chunks_mut(1_024) {
                process(&mut processor, chunk).unwrap();
            }
            assert!(samples.iter().all(|x| x.is_finite()));
            let first_echo = samples
                .iter()
                .map(|x| f64::from(*x).abs())
                .fold(0.0, f64::max);
            assert!(first_echo > 0.0, "{:?} 应产生湿声", settings.mode);
            let far = samples
                .iter()
                .skip(samples.len() / 2)
                .map(|x| f64::from(*x).abs())
                .fold(0.0, f64::max);
            assert!(
                far <= first_echo,
                "{:?} 远端湿尾不应高于首回波",
                settings.mode
            );
        }
    }

    #[test]
    fn per_frame_core_state_is_block_invariant() {
        for settings in [algorithmic(true), fdn(true), convolution(true)] {
            let input = noise(1_003);
            let mut whole = prepared(48_000.0, settings, 1_003);
            let mut split = prepared(48_000.0, settings, 1_003);
            let mut whole_output = input.clone();
            let mut split_output = input;
            process(&mut whole, &mut whole_output).unwrap();
            process(&mut split, &mut split_output[..442]).unwrap();
            process(&mut split, &mut split_output[442..1_556]).unwrap();
            process(&mut split, &mut split_output[1_556..]).unwrap();
            assert_eq!(
                whole_output.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                split_output.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                "{:?} 块切分必须一致",
                settings.mode
            );
        }
    }

    #[test]
    fn disabled_is_bit_transparent() {
        for settings in [
            algorithmic(false),
            fdn(false),
            ReverbSettings {
                ir_recipe: Some(IrRecipe::ExpNoise {
                    length: 512.0,
                    seed: 777,
                    decay: 6.0,
                    amp: 0.5,
                }),
                ..convolution(false)
            },
        ] {
            let mut processor = prepared(48_000.0, settings, 128);
            let input = noise(128);
            let expected = input.clone();
            let mut samples = input;
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
                "{:?} 禁用必须逐位透明",
                settings.mode
            );
        }
    }

    #[test]
    fn mode_switch_rebuilds_and_parameter_updates_preserve_state() {
        let settings = algorithmic(true);
        // 预热长度必须超过 comb 延迟（@48kHz 最长约 1.5k 样本），否则核心状态尚未
        // 进入输出路径，「换参不清状态」断言无法与全新实例区分。
        let mut processor = prepared(48_000.0, settings, 2_048);
        let mut warmed = noise(2_048);
        process(&mut processor, &mut warmed).unwrap();

        // 非拓扑参数更新：状态保留（湿尾续播不断裂——与全新实例不同）。
        let mut louder = settings;
        louder.wet = 0.9;
        processor.set_params(louder).unwrap();
        assert_eq!(processor.settings(), louder);
        let mut continued = noise(64);
        process(&mut processor, &mut continued).unwrap();
        let mut fresh = prepared(48_000.0, louder, 64);
        let mut from_zero = noise(64);
        process(&mut fresh, &mut from_zero).unwrap();
        assert_ne!(continued, from_zero, "换参不得清空核心状态");

        // 模式切换：重建（与全新 Fdn 实例一致）。
        processor.set_params(fdn(true)).unwrap();
        assert_eq!(processor.settings().mode, ReverbMode::Fdn);
        let mut after_switch = noise(128);
        process(&mut processor, &mut after_switch).unwrap();
        let mut fresh_fdn = prepared(48_000.0, fdn(true), 128);
        let mut fresh_output = noise(128);
        process(&mut fresh_fdn, &mut fresh_output).unwrap();
        assert_eq!(after_switch, fresh_output, "模式切换必须从零状态出发");

        // 卷积拓扑变化（IR 配方更换）→ 重建；mix 变化 → 原位。
        let mut convolution_processor = prepared(48_000.0, convolution(true), 256);
        let mut advanced = noise(256);
        process(&mut convolution_processor, &mut advanced).unwrap();
        let mut remix = convolution(true);
        remix.mix = 0.5;
        convolution_processor.set_params(remix).unwrap();
        assert_eq!(convolution_processor.settings(), remix);
        let mut ir_changed = convolution(true);
        ir_changed.mix = 0.5;
        ir_changed.ir_recipe = Some(IrRecipe::Delta { delay: 3.0 });
        convolution_processor.set_params(ir_changed).unwrap();
        let mut after_rebuild = noise(256);
        process(&mut convolution_processor, &mut after_rebuild).unwrap();
        let mut rebuilt = prepared(48_000.0, ir_changed, 256);
        let mut reference = noise(256);
        process(&mut rebuilt, &mut reference).unwrap();
        assert_eq!(after_rebuild, reference, "IR 更换后必须与全新实例一致");
    }

    #[test]
    fn migration_and_checkpoint_preserve_opaque_core_state() {
        let old_settings = algorithmic(true);
        let next_settings = ReverbSettings {
            wet: 0.9,
            width: 0.5,
            ..algorithmic(true)
        };
        let mut previous = prepared(48_000.0, old_settings, 256);
        let mut reference = prepared(48_000.0, old_settings, 256);
        let mut prefix = noise(128);
        let mut reference_prefix = prefix.clone();
        process(&mut previous, &mut prefix).unwrap();
        process(&mut reference, &mut reference_prefix).unwrap();

        let mut next = prepared(48_000.0, next_settings, 256);
        assert!(next.adopt_runtime_state_from(&mut previous));
        assert_eq!(next.settings(), next_settings);
        let mut adopted_output = noise(129);
        let mut reference_output = adopted_output.clone();
        process(&mut next, &mut adopted_output).unwrap();
        reference.set_params(next_settings).unwrap();
        process(&mut reference, &mut reference_output).unwrap();
        assert_eq!(adopted_output, reference_output);

        let initial_checkpoint = next.create_runtime_checkpoint().unwrap();
        assert!(next.runtime_checkpoint_compatible(initial_checkpoint.as_ref()));
        let mut expected_after_checkpoint = noise(67);
        process(&mut next, &mut expected_after_checkpoint).unwrap();
        assert!(next.restore_runtime_state(initial_checkpoint.as_ref()));
        let mut restored_output = noise(67);
        process(&mut next, &mut restored_output).unwrap();
        assert_eq!(restored_output, expected_after_checkpoint);

        let mut checkpoint = next.create_runtime_checkpoint().unwrap();
        let mut more = noise(59);
        process(&mut next, &mut more).unwrap();
        assert!(next.save_runtime_state(checkpoint.as_mut()));
        let mut saved_output = noise(83);
        process(&mut next, &mut saved_output).unwrap();
        assert!(next.restore_runtime_state(checkpoint.as_ref()));
        let mut replayed_output = noise(83);
        process(&mut next, &mut replayed_output).unwrap();
        assert_eq!(replayed_output, saved_output);

        // 模式切换 = checkpoint 不兼容（重建）。
        let mut fdn_processor = prepared(48_000.0, fdn(true), 64);
        assert!(!fdn_processor.runtime_checkpoint_compatible(initial_checkpoint.as_ref()));
        assert!(!fdn_processor.adopt_runtime_state_from(&mut next));

        // 拓扑性参数变化（type）= checkpoint 不兼容。
        let mut type_changed = prepared(
            48_000.0,
            ReverbSettings {
                reverb_type: ReverbType::Plate,
                ..algorithmic(true)
            },
            64,
        );
        assert!(!type_changed.adopt_runtime_state_from(&mut next));
        assert!(!type_changed.restore_runtime_state(initial_checkpoint.as_ref()));

        // 禁用 → 启用迁移从零状态出发。
        let mut disabled = prepared(
            48_000.0,
            ReverbSettings {
                enabled: false,
                ..next_settings
            },
            64,
        );
        assert!(disabled.adopt_runtime_state_from(&mut next));
        let mut from_disabled = prepared(48_000.0, next_settings, 64);
        assert!(from_disabled.adopt_runtime_state_from(&mut disabled));
        let mut reset_adoption_output = noise(45);
        process(&mut from_disabled, &mut reset_adoption_output).unwrap();
        let mut fresh = prepared(48_000.0, next_settings, 45);
        let mut fresh_output = noise(45);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(reset_adoption_output, fresh_output);

        // 采样率与类型失配。
        let mut other_rate = prepared(44_100.0, next_settings, 64);
        assert!(!other_rate.adopt_runtime_state_from(&mut next));
        let mut wrong_type = BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut wrong_type));
        let mut wrong_checkpoint: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!next.save_runtime_state(wrong_checkpoint.as_mut()));
        assert!(!next.restore_runtime_state(wrong_checkpoint.as_ref()));
    }

    #[test]
    fn reset_clears_reverb_state() {
        let settings = algorithmic(true);
        let mut processor = prepared(48_000.0, settings, 128);
        let mut first = noise(128);
        process(&mut processor, &mut first).unwrap();
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.settings(), settings);
        let mut reset_output = impulse(64);
        process(&mut processor, &mut reset_output).unwrap();
        let mut fresh = prepared(48_000.0, settings, 64);
        let mut fresh_output = impulse(64);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(reset_output, fresh_output);
    }

    #[test]
    fn format_complete_frame_and_prepared_capacity_validation_precede_bypass() {
        let mut processor = ReverbProcessor::new(48_000.0, ReverbSettings::default()).unwrap();
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
        assert_eq!(incomplete, unchanged);

        let mut oversized = [1.0_f32; 6];
        assert!(process(&mut processor, &mut oversized).is_err());
    }
}
