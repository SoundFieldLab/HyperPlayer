//! HSE v1.5.1 Stage 20 Modulation / Master Targets 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::modulation_matrix::ModulationMatrixStage`
//! 权威实现；本模块仅负责受限 typed routing 的固化、参数校验、生命周期、
//! 立体声交错/平面转换与 master targets 的本位应用。
//!
//! # 受限 typed routing（fail closed）
//!
//! 路由 schema 固化为 `source × target × depth × polarity × smoothing`：
//!
//! - `source`：`lfo | envelope`（字符串严格解析，枚举外一律拒绝——**不复刻**
//!   TS 的 default fallback，防止未知来源静默落 envelope）；
//! - `target`：白名单 `masterGain | stereoWidth`（核心 [`ModulationTargets`]
//!   实际支持的全部目标；字符串严格解析，未知目标一律拒绝——**不复刻** TS 的
//!   「非 masterGain 全落 stereoWidth」fallback）；
//! - `depth`：路由量幅值，有限且 ∈ [0, 16]（目标端钳制域 masterGain [0,4]、
//!   stereoWidth [0,2]，超过 16 的深度无意义）；
//! - `polarity`：恰为 +1 或 -1；
//! - `smoothingMs`：路由级控制值平滑，有限且 ∈ [0, 5000]，0 = 关闭；
//! - 路由条目 ≤ 8 条。核心路由的 `offset` 不在本 schema 中暴露（恒 0）。
//!
//! 非法路由在构造/校验期以 [`EngineError::InvalidInput`] 拒绝，绝不静默丢弃。
//!
//! # base value 与 modulation delta 所有权
//!
//! master targets（master gain / stereo width）由本 processor 在自身链位
//! （IDS 第 20，LUFS tap 19 之后、Limiter 21 之前）**独自应用**：宽度先
//! （M/S 逆变换，与 HSE 引擎链 `MidSideStage` 逐位同式）、增益后（逐样本
//! `f64::from(x)·g → as f32`，与核心 `Stage::process` 逐位同式）。基线值
//! 1.0 由核心矩阵持有，delta 只在块内以局部值流动；不写任何其他 processor
//! 的参数，不跨线程共享可变态。targets 恰为 1.0 的路径完全跳过，逐位直通。
//!
//! # 链级语义
//!
//! - `latency_frames` / `tail_frames`：恒 0（控制率阶段，无延迟线、无尾部，
//!   如实上报）；
//! - 禁用即逐位直通且**矩阵状态不推进**；仅从禁用切换为启用时重置矩阵状态
//!   （LFO 相位、包络、平滑记忆），与 limiter 适配器语义一致；
//! - 链 swap（revision 变更）：双方均启用时经核心四件套原子迁移 LFO 相位、
//!   包络与平滑记忆（路由数量不一致则整体拒绝、重新起链）；禁用→启用一律
//!   全新状态。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason, RuntimeStateCapability};
use crate::error::{EngineError, Result};
use hse_core::mid_side::MidSideStage;
use hse_core::modulation_matrix::{
    EnvelopeParams, LfoParams, ModSource, ModTarget,
    ModulationMatrixRuntimeState as CoreModulationRuntimeState, ModulationMatrixStage,
    ModulationRoute,
};
use hse_core::Stage as HseStage;
use std::sync::atomic::{AtomicU64, Ordering};

/// 受限路由表上限（fail closed；控制率路由超出 8 条视为配置事故）。
pub const MAX_MODULATION_ROUTES: usize = 8;

/// 路由深度幅值上限（目标端钳制域为 masterGain [0,4] / stereoWidth [0,2]）。
pub const MAX_ROUTE_DEPTH: f64 = 16.0;

/// 路由级平滑上限（毫秒）。
pub const MAX_ROUTE_SMOOTHING_MS: f64 = 5_000.0;

/// meter 读数槽位索引：0 = master gain（线性），1 = stereo width（线性）。
const METER_SLOT_MASTER_GAIN: usize = 0;
const METER_SLOT_STEREO_WIDTH: usize = 1;
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

/// meter 读数快照：控制率线性值，`generation` 用于 telemetry 侧去重/丢帧判定。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModulationMeterReading {
    pub value: f64,
    pub generation: u64,
}

/// 调制源（严格 typed；字符串解析不接受枚举外值）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModRouteSource {
    Lfo,
    Envelope,
}

impl ModRouteSource {
    /// 严格解析：`lfo | envelope`，其他一律 `None`（fail closed）。
    pub fn parse_str(value: &str) -> Option<Self> {
        match value {
            "lfo" => Some(Self::Lfo),
            "envelope" => Some(Self::Envelope),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lfo => "lfo",
            Self::Envelope => "envelope",
        }
    }
}

/// 调制目标白名单（严格 typed；字符串解析不接受枚举外值）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModRouteTarget {
    MasterGain,
    StereoWidth,
}

impl ModRouteTarget {
    /// 严格解析：`masterGain | stereoWidth`，其他一律 `None`（fail closed）。
    pub fn parse_str(value: &str) -> Option<Self> {
        match value {
            "masterGain" => Some(Self::MasterGain),
            "stereoWidth" => Some(Self::StereoWidth),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::MasterGain => "masterGain",
            Self::StereoWidth => "stereoWidth",
        }
    }
}

/// LFO 波形（严格 typed；字符串解析不接受枚举外值——TS 的 default→sine
/// fallback 不进入 HyperPlayer 边界）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModLfoShape {
    Sine,
    Triangle,
    Square,
    Saw,
}

impl ModLfoShape {
    /// 严格解析：`sine | triangle | square | saw`，其他一律 `None`。
    pub fn parse_str(value: &str) -> Option<Self> {
        match value {
            "sine" => Some(Self::Sine),
            "triangle" => Some(Self::Triangle),
            "square" => Some(Self::Square),
            "saw" => Some(Self::Saw),
            _ => None,
        }
    }

    fn to_core(self) -> hse_core::modulation_matrix::LfoShape {
        match self {
            Self::Sine => hse_core::modulation_matrix::LfoShape::Sine,
            Self::Triangle => hse_core::modulation_matrix::LfoShape::Triangle,
            Self::Square => hse_core::modulation_matrix::LfoShape::Square,
            Self::Saw => hse_core::modulation_matrix::LfoShape::Saw,
        }
    }
}

/// 一条受限 typed 调制路由（HyperPlayer schema；核心路由的 `offset` 不暴露，
/// 恒 0；实际路由量 = `polarity · depth`）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModRouteSettings {
    pub source: ModRouteSource,
    pub target: ModRouteTarget,
    /// 路由量幅值 ∈ [0, 16]（有限）。
    pub depth: f64,
    /// 极性，恰为 +1 或 -1。
    pub polarity: f64,
    /// 路由级控制值平滑（毫秒）∈ [0, 5000]，0 = 关闭。
    pub smoothing_ms: f64,
}

/// Stage 20 参数快照。默认 disabled（HyperPlayer 透明默认链）。
#[derive(Clone, Debug, PartialEq)]
pub struct ModulationSettings {
    pub enabled: bool,
    pub lfo_shape: ModLfoShape,
    /// LFO 频率（Hz）∈ [0, 1000]（有限）。
    pub lfo_rate_hz: f64,
    /// LFO 深度 ∈ [0, 1]（核心同域钳制）。
    pub lfo_depth: f64,
    /// 包络 attack（ms）∈ [0.05, 5000]（核心下限 0.05）。
    pub envelope_attack_ms: f64,
    /// 包络 release（ms）∈ [0.05, 5000]。
    pub envelope_release_ms: f64,
    /// 包络输出量 ∈ [0, 1]（核心同域钳制）。
    pub envelope_amount: f64,
    /// 受限路由表，≤ [`MAX_MODULATION_ROUTES`] 条。
    pub routes: Vec<ModRouteSettings>,
}

impl Default for ModulationSettings {
    fn default() -> Self {
        // 参数取 HSE TS 构造缺省（lfo sine/1/0.5、envelope 10/200/0.5）；
        // enabled=false 遵守 HyperPlayer 透明默认链。
        Self {
            enabled: false,
            lfo_shape: ModLfoShape::Sine,
            lfo_rate_hz: 1.0,
            lfo_depth: 0.5,
            envelope_attack_ms: 10.0,
            envelope_release_ms: 200.0,
            envelope_amount: 0.5,
            routes: Vec::new(),
        }
    }
}

impl ModulationSettings {
    /// 受限 schema 校验（fail closed）：任何越界 / 非有限 / 非白名单条目
    /// 一律拒绝。
    pub fn validate(&self) -> Result<()> {
        if !self.lfo_rate_hz.is_finite() || !(0.0..=1_000.0).contains(&self.lfo_rate_hz) {
            return Err(EngineError::InvalidInput(
                "modulation lfo.rateHz must be finite within [0, 1000]".into(),
            ));
        }
        if !self.lfo_depth.is_finite() || !(0.0..=1.0).contains(&self.lfo_depth) {
            return Err(EngineError::InvalidInput(
                "modulation lfo.depth must be finite within [0, 1]".into(),
            ));
        }
        for (label, ms) in [
            ("attackMs", self.envelope_attack_ms),
            ("releaseMs", self.envelope_release_ms),
        ] {
            if !ms.is_finite() || !(0.05..=5_000.0).contains(&ms) {
                return Err(EngineError::InvalidInput(format!(
                    "modulation envelope.{label} must be finite within [0.05, 5000]"
                )));
            }
        }
        if !self.envelope_amount.is_finite() || !(0.0..=1.0).contains(&self.envelope_amount) {
            return Err(EngineError::InvalidInput(
                "modulation envelope.amount must be finite within [0, 1]".into(),
            ));
        }
        if self.routes.len() > MAX_MODULATION_ROUTES {
            return Err(EngineError::InvalidInput(format!(
                "modulation supports at most {MAX_MODULATION_ROUTES} routes"
            )));
        }
        for (index, route) in self.routes.iter().enumerate() {
            if !route.depth.is_finite() || !(0.0..=MAX_ROUTE_DEPTH).contains(&route.depth) {
                return Err(EngineError::InvalidInput(format!(
                    "modulation routes[{index}].depth must be finite within [0, {MAX_ROUTE_DEPTH}]"
                )));
            }
            if route.polarity != 1.0 && route.polarity != -1.0 {
                return Err(EngineError::InvalidInput(format!(
                    "modulation routes[{index}].polarity must be exactly +1 or -1"
                )));
            }
            if !route.smoothing_ms.is_finite()
                || !(0.0..=MAX_ROUTE_SMOOTHING_MS).contains(&route.smoothing_ms)
            {
                return Err(EngineError::InvalidInput(format!(
                    "modulation routes[{index}].smoothingMs must be finite within [0, {MAX_ROUTE_SMOOTHING_MS}]"
                )));
            }
        }
        Ok(())
    }

    fn core_routes(&self) -> Vec<ModulationRoute> {
        self.routes
            .iter()
            .map(|route| ModulationRoute {
                source: match route.source {
                    ModRouteSource::Lfo => ModSource::Lfo,
                    ModRouteSource::Envelope => ModSource::Envelope,
                },
                target: match route.target {
                    ModRouteTarget::MasterGain => ModTarget::MasterGain,
                    ModRouteTarget::StereoWidth => ModTarget::StereoWidth,
                },
                amount: route.polarity * route.depth,
                offset: 0.0,
            })
            .collect()
    }
}

#[derive(Clone)]
struct ModulationRuntimeState {
    sample_rate_bits: u64,
    core: CoreModulationRuntimeState,
}

pub struct ModulationProcessor {
    sample_rate: f64,
    settings: ModulationSettings,
    matrix: ModulationMatrixStage,
    /// stereo width 的本位应用（M/S 逆变换；与 HSE 引擎链 MidSideStage 同式）。
    width: MidSideStage,
    left: Vec<f32>,
    right: Vec<f32>,
    /// 固定 2 槽控制率读数（master gain / stereo width，线性），process 尾部
    /// 发布，零分配。
    meters: [MeterSlot; METER_SLOT_COUNT],
}

impl ModulationProcessor {
    pub fn new(sample_rate: f64, settings: ModulationSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        settings.validate()?;
        let mut matrix =
            ModulationMatrixStage::new(sample_rate).map_err(EngineError::InvalidInput)?;
        matrix.set_lfo_params(LfoParams {
            shape: settings.lfo_shape.to_core(),
            rate_hz: settings.lfo_rate_hz,
            depth: settings.lfo_depth,
        });
        matrix.set_envelope_params(EnvelopeParams {
            attack_ms: settings.envelope_attack_ms,
            release_ms: settings.envelope_release_ms,
            amount: settings.envelope_amount,
        });
        matrix.set_routes_with_smoothing(
            settings.core_routes(),
            settings.routes.iter().map(|r| r.smoothing_ms).collect(),
        );
        Ok(Self {
            sample_rate,
            settings,
            matrix,
            width: MidSideStage::new(),
            left: Vec::new(),
            right: Vec::new(),
            meters: Default::default(),
        })
    }

    pub fn settings(&self) -> &ModulationSettings {
        &self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 参数即时生效并保留核心状态（LFO 相位、包络、平滑记忆跨参数变更延续）；
    /// 仅从禁用切换为启用时重置矩阵状态。路由表整体替换时平滑记忆从 0 重新
    /// 收敛（确定性）。
    pub fn set_params(&mut self, settings: ModulationSettings) -> Result<()> {
        settings.validate()?;
        let became_active = !self.is_active() && settings.enabled;
        self.matrix.set_lfo_params(LfoParams {
            shape: settings.lfo_shape.to_core(),
            rate_hz: settings.lfo_rate_hz,
            depth: settings.lfo_depth,
        });
        self.matrix.set_envelope_params(EnvelopeParams {
            attack_ms: settings.envelope_attack_ms,
            release_ms: settings.envelope_release_ms,
            amount: settings.envelope_amount,
        });
        self.matrix.set_routes_with_smoothing(
            settings.core_routes(),
            settings.routes.iter().map(|r| r.smoothing_ms).collect(),
        );
        if became_active {
            self.reset_runtime_state();
        }
        self.settings = settings;
        Ok(())
    }

    fn reset_runtime_state(&mut self) {
        self.matrix.reset();
    }

    /// 最近一次 master gain 读数（线性；无读数时 `None`）。
    pub fn master_gain_reading(&self) -> Option<ModulationMeterReading> {
        self.meters[METER_SLOT_MASTER_GAIN]
            .load()
            .map(|(value, generation)| ModulationMeterReading { value, generation })
    }

    /// 最近一次 stereo width 读数（线性；无读数时 `None`）。
    pub fn stereo_width_reading(&self) -> Option<ModulationMeterReading> {
        self.meters[METER_SLOT_STEREO_WIDTH]
            .load()
            .map(|(value, generation)| ModulationMeterReading { value, generation })
    }
}

impl PcmProcessor for ModulationProcessor {
    fn name(&self) -> &'static str {
        "modulation"
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
            // core 内部校验采样率位型与路由数量一致性（不一致时整体拒绝迁移）。
            self.matrix
                .copy_runtime_state_from(&previous.matrix)
                .is_ok()
        } else {
            if self.is_active() {
                self.reset_runtime_state();
            }
            true
        }
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(ModulationRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            core: self.matrix.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<ModulationRuntimeState>()
            .is_some_and(|state| state.sample_rate_bits == self.sample_rate.to_bits())
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<ModulationRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        self.matrix.save_runtime_state(&mut state.core).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<ModulationRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        self.matrix.restore_runtime_state(&state.core).is_ok()
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
                "modulation requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "modulation block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.is_active() {
            // 禁用：逐位直通，矩阵状态（相位/包络/平滑）不推进。
            return Ok(());
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        // 先推进矩阵（包络读取本链位增益前输入；LFO 相位按块推进），再本位
        // 应用 master targets：宽度先行（对齐 HSE 引擎链 mid-side 在前）、
        // 增益在后（f64 乘法、f32 写回，与核心 Stage::process 同落点）。
        let targets = self
            .matrix
            .process_block(&self.left[..frames], &self.right[..frames]);
        self.width.set_params(targets.stereo_width, 0.0);
        if self.width.gains() != (1.0, 1.0) {
            self.width
                .process(&mut self.left[..frames], &mut self.right[..frames]);
        }
        let gain = targets.master_gain;
        if gain != 1.0 {
            for i in 0..frames {
                self.left[i] = (f64::from(self.left[i]) * gain) as f32;
                self.right[i] = (f64::from(self.right[i]) * gain) as f32;
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
        // 控制率读数发布：每块一次，固定 slot + 代际，零分配（遥测取数口）。
        self.meters[METER_SLOT_MASTER_GAIN].publish(targets.master_gain);
        self.meters[METER_SLOT_STEREO_WIDTH].publish(targets.stereo_width);
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
            "modulation sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "modulation requires stereo PCM".into(),
        ));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "modulation sample rate does not match PCM format".into(),
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

    fn route(
        source: ModRouteSource,
        target: ModRouteTarget,
        depth: f64,
        polarity: f64,
        smoothing_ms: f64,
    ) -> ModRouteSettings {
        ModRouteSettings {
            source,
            target,
            depth,
            polarity,
            smoothing_ms,
        }
    }

    fn lfo_master_settings(depth: f64) -> ModulationSettings {
        ModulationSettings {
            enabled: true,
            lfo_shape: ModLfoShape::Sine,
            lfo_rate_hz: 4.0,
            lfo_depth: 1.0,
            envelope_attack_ms: 10.0,
            envelope_release_ms: 200.0,
            envelope_amount: 0.5,
            routes: vec![route(
                ModRouteSource::Lfo,
                ModRouteTarget::MasterGain,
                depth,
                1.0,
                0.0,
            )],
        }
    }

    fn prepared(
        sample_rate: f64,
        settings: &ModulationSettings,
        capacity: usize,
    ) -> ModulationProcessor {
        let mut processor = ModulationProcessor::new(sample_rate, settings.clone()).unwrap();
        processor
            .prepare(format(sample_rate as u32), capacity)
            .unwrap();
        processor
    }

    fn process(processor: &mut ModulationProcessor, samples: &mut [f32]) -> Result<()> {
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
    fn strict_parsing_rejects_everything_outside_the_whitelist() {
        // 受限 schema 的字符串边界：未知 source/target/shape 一律 None（DTO
        // 层必须映射为校验错误，绝不走 TS 的 default fallback）。
        assert_eq!(ModRouteSource::parse_str("lfo"), Some(ModRouteSource::Lfo));
        assert_eq!(
            ModRouteSource::parse_str("envelope"),
            Some(ModRouteSource::Envelope)
        );
        assert_eq!(ModRouteSource::parse_str("LFO"), None);
        assert_eq!(ModRouteSource::parse_str("sidechain"), None);
        assert_eq!(ModRouteSource::parse_str(""), None);

        assert_eq!(
            ModRouteTarget::parse_str("masterGain"),
            Some(ModRouteTarget::MasterGain)
        );
        assert_eq!(
            ModRouteTarget::parse_str("stereoWidth"),
            Some(ModRouteTarget::StereoWidth)
        );
        // TS 会把非 masterGain 一律落 stereoWidth；HyperPlayer 边界拒绝。
        assert_eq!(ModRouteTarget::parse_str("volume"), None);
        assert_eq!(ModRouteTarget::parse_str("mastergain"), None);

        assert_eq!(ModLfoShape::parse_str("saw"), Some(ModLfoShape::Saw));
        assert_eq!(ModLfoShape::parse_str("bogus"), None);
    }

    #[test]
    fn defaults_are_disabled_transparent_and_honest_about_latency() {
        let default_settings = ModulationSettings::default();
        assert!(!default_settings.enabled);
        let mut processor = prepared(48_000.0, &default_settings, 64);
        assert_eq!(processor.name(), "modulation");
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
        assert!(processor.master_gain_reading().is_none());
        assert!(processor.stereo_width_reading().is_none());
    }

    #[test]
    fn invalid_settings_fail_closed_at_construction_and_update() {
        for sample_rate in [0.0, -48_000.0, f64::NAN, f64::INFINITY] {
            assert!(ModulationProcessor::new(sample_rate, ModulationSettings::default()).is_err());
        }
        let base = lfo_master_settings(0.5);
        let invalid = [
            |s: &mut ModulationSettings| s.lfo_rate_hz = -1.0,
            |s: &mut ModulationSettings| s.lfo_rate_hz = f64::NAN,
            |s: &mut ModulationSettings| s.lfo_depth = 1.5,
            |s: &mut ModulationSettings| s.envelope_attack_ms = 0.0,
            |s: &mut ModulationSettings| s.envelope_release_ms = 6_000.0,
            |s: &mut ModulationSettings| s.envelope_amount = f64::NAN,
            |s: &mut ModulationSettings| {
                s.routes = vec![route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    f64::NAN,
                    1.0,
                    0.0,
                )]
            },
            |s: &mut ModulationSettings| {
                s.routes = vec![route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    MAX_ROUTE_DEPTH + 0.5,
                    1.0,
                    0.0,
                )]
            },
            // 极性不是恰 ±1：fail closed。
            |s: &mut ModulationSettings| {
                s.routes = vec![route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    1.0,
                    2.0,
                    0.0,
                )]
            },
            |s: &mut ModulationSettings| {
                s.routes = vec![route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    1.0,
                    0.0,
                    0.0,
                )]
            },
            |s: &mut ModulationSettings| {
                s.routes = vec![route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    1.0,
                    1.0,
                    6_000.0,
                )]
            },
            // 路由数量超限。
            |s: &mut ModulationSettings| {
                s.routes = (0..MAX_MODULATION_ROUTES + 1)
                    .map(|_| {
                        route(
                            ModRouteSource::Lfo,
                            ModRouteTarget::MasterGain,
                            0.1,
                            1.0,
                            0.0,
                        )
                    })
                    .collect();
            },
        ];
        for mutate in invalid {
            let mut settings = base.clone();
            mutate(&mut settings);
            assert!(
                ModulationProcessor::new(48_000.0, settings.clone()).is_err(),
                "构造必须拒绝 {settings:?}"
            );
            let mut processor = prepared(48_000.0, &base, 8);
            assert!(processor.set_params(settings).is_err(), "更新必须拒绝");
        }
    }

    #[test]
    fn adapter_matches_core_matrix_plus_width_composition_bit_exact() {
        // 适配器语义 = 核心 process_block 的 targets + MidSideStage(width,0) +
        // 逐样本 master gain——用独立组合逐位复算并对照。
        let settings = ModulationSettings {
            enabled: true,
            lfo_shape: ModLfoShape::Triangle,
            lfo_rate_hz: 3.0,
            lfo_depth: 0.8,
            envelope_attack_ms: 3.0,
            envelope_release_ms: 90.0,
            envelope_amount: 0.9,
            routes: vec![
                route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    0.35,
                    1.0,
                    0.0,
                ),
                route(
                    ModRouteSource::Envelope,
                    ModRouteTarget::StereoWidth,
                    0.9,
                    -1.0,
                    0.0,
                ),
            ],
        };
        let frames = 1_231_usize;
        let left = lcg_noise(frames, 87001, 0.6);
        let right = lcg_noise(frames, 31337, 0.5);

        let mut adapter = prepared(48_000.0, &settings, 512);
        let mut actual = Vec::new();
        let mut offset = 0_usize;
        while offset < frames {
            let end = (offset + 331).min(frames);
            let mut chunk = left[offset..end]
                .iter()
                .zip(&right[offset..end])
                .flat_map(|(&l, &r)| [l, r])
                .collect::<Vec<_>>();
            process(&mut adapter, &mut chunk).unwrap();
            actual.extend_from_slice(&chunk);
            offset = end;
        }

        // 参照：核心矩阵逐块 + mid-side + gain（与适配器相同分块）。
        let mut matrix = ModulationMatrixStage::new(48_000.0).unwrap();
        matrix.set_lfo_params(LfoParams {
            shape: hse_core::modulation_matrix::LfoShape::Triangle,
            rate_hz: 3.0,
            depth: 0.8,
        });
        matrix.set_envelope_params(EnvelopeParams {
            attack_ms: 3.0,
            release_ms: 90.0,
            amount: 0.9,
        });
        matrix.set_routes(settings.core_routes());
        let mut width = MidSideStage::new();
        let mut expected = Vec::with_capacity(frames * 2);
        let mut l_buf = vec![0.0_f32; 512];
        let mut r_buf = vec![0.0_f32; 512];
        let mut offset = 0_usize;
        while offset < frames {
            let end = (offset + 331).min(frames);
            let n = end - offset;
            l_buf[..n].copy_from_slice(&left[offset..end]);
            r_buf[..n].copy_from_slice(&right[offset..end]);
            let targets = matrix.process_block(&l_buf[..n], &r_buf[..n]);
            width.set_params(targets.stereo_width, 0.0);
            if width.gains() != (1.0, 1.0) {
                width.process(&mut l_buf[..n], &mut r_buf[..n]);
            }
            let g = targets.master_gain;
            if g != 1.0 {
                for i in 0..n {
                    l_buf[i] = (f64::from(l_buf[i]) * g) as f32;
                    r_buf[i] = (f64::from(r_buf[i]) * g) as f32;
                }
            }
            for i in 0..n {
                expected.push(l_buf[i]);
                expected.push(r_buf[i]);
            }
            offset = end;
        }
        assert_eq!(
            actual.iter().map(|s| s.to_bits()).collect::<Vec<_>>(),
            expected.iter().map(|s| s.to_bits()).collect::<Vec<_>>(),
            "适配器必须与「核心矩阵 + mid-side 宽度 + 增益」组合逐位一致"
        );

        // 读数：目标值随 LFO/包络变化，且始终在核心钳制域内。
        let gain_reading = adapter.master_gain_reading().unwrap();
        let width_reading = adapter.stereo_width_reading().unwrap();
        assert!((0.0..=4.0).contains(&gain_reading.value));
        assert!((0.0..=2.0).contains(&width_reading.value));
    }

    #[test]
    fn targets_clamp_at_core_domains_through_the_adapter() {
        // saw 相位接近 1（saw→+1）触上界 4；相位 0（saw→−1）触下界 0
        // （核心 GWT-MM-03 经适配器复现，读数同步钳制）。
        let rate_up = 0.999_999 * 48_000.0 / 256.0;
        let mut up = prepared(
            48_000.0,
            &ModulationSettings {
                lfo_shape: ModLfoShape::Saw,
                lfo_rate_hz: rate_up,
                routes: vec![route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    5.0,
                    1.0,
                    0.0,
                )],
                ..lfo_master_settings(5.0)
            },
            256,
        );
        // 256 帧 = 512 个交错样本：首块推进后相位 ≈ 0.999999 → saw → +1 触上界。
        let mut samples = vec![0.25_f32; 512];
        process(&mut up, &mut samples).unwrap();
        assert_eq!(up.master_gain_reading().unwrap().value, 4.0);
        // 上界增益不得放大超过 4。
        assert!(samples.iter().all(|s| f64::from(*s) <= 1.05));

        let rate_zero = 48_000.0 / 256.0; // 每块推进恰好 1.0 → 相位 0 → saw = −1
        let mut down = prepared(
            48_000.0,
            &ModulationSettings {
                lfo_shape: ModLfoShape::Saw,
                lfo_rate_hz: rate_zero,
                routes: vec![route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::MasterGain,
                    5.0,
                    1.0,
                    0.0,
                )],
                ..lfo_master_settings(5.0)
            },
            256,
        );
        let mut samples = vec![0.25_f32; 512];
        process(&mut down, &mut samples).unwrap();
        assert_eq!(down.master_gain_reading().unwrap().value, 0.0);
        assert!(samples.iter().all(|s| *s == 0.0), "增益 0 必须静音输出");
    }

    #[test]
    fn identity_targets_leave_the_signal_bit_transparent() {
        // 双恒等锚点：无路由（targets 恒 1）与「仅 stereoWidth 目标且 offset
        // 域下 width 恰 1」时输出与输入逐位一致（含 ±0 语义）。
        let mut no_routes = prepared(48_000.0, &lfo_master_settings(0.0), 8);
        let left = lcg_noise(8, 5, 0.6);
        let right = lcg_noise(8, 6, 0.6);
        let mut samples = left
            .iter()
            .zip(&right)
            .flat_map(|(&l, &r)| [l, r])
            .collect::<Vec<_>>();
        samples[0] = 0.0;
        samples[1] = -0.0;
        let expected = samples.clone();
        process(&mut no_routes, &mut samples).unwrap();
        assert_eq!(samples, expected);
        assert_eq!(no_routes.master_gain_reading().unwrap().value, 1.0);
        assert_eq!(no_routes.stereo_width_reading().unwrap().value, 1.0);
    }

    #[test]
    fn same_segmentation_is_deterministic_and_block_rate_semantics_survive() {
        // 本阶段输出**依赖块切分**（核心 GWT-MM-06：增益按块常量、LFO 相位按块
        // 推进，包络按块采样）——不同分块不得逐位一致；同一分块必须确定可复现。
        let settings = ModulationSettings {
            enabled: true,
            lfo_shape: ModLfoShape::Square,
            lfo_rate_hz: 2.0,
            lfo_depth: 1.0,
            envelope_attack_ms: 2.0,
            envelope_release_ms: 120.0,
            envelope_amount: 1.0,
            routes: vec![
                route(
                    ModRouteSource::Envelope,
                    ModRouteTarget::MasterGain,
                    1.0,
                    1.0,
                    0.0,
                ),
                route(
                    ModRouteSource::Lfo,
                    ModRouteTarget::StereoWidth,
                    0.7,
                    1.0,
                    12.0,
                ),
            ],
        };
        let frames = 1_503_usize;
        let left = lcg_noise(frames, 11, 0.6);
        let right = lcg_noise(frames, 12, 0.6);
        let to_interleaved = |l: &[f32], r: &[f32]| {
            l.iter()
                .zip(r)
                .flat_map(|(&a, &b)| [a, b])
                .collect::<Vec<_>>()
        };
        let run = |chunks: &[usize]| {
            let mut processor = prepared(48_000.0, &settings, frames);
            let mut out = to_interleaved(&left, &right);
            let mut offset = 0_usize;
            for &frames_chunk in chunks {
                process(
                    &mut processor,
                    &mut out[offset * 2..(offset + frames_chunk) * 2],
                )
                .unwrap();
                offset += frames_chunk;
            }
            out
        };

        let first = run(&[521, 521, 461]);
        let second = run(&[521, 521, 461]);
        assert_eq!(first, second, "同一分块序列必须确定可复现（逐位一致）");
        let whole = run(&[frames]);
        assert_ne!(
            first, whole,
            "调制输出依赖 blockSize：不同分块必须可区分（GWT-MM-06 经适配器保持）"
        );
    }

    #[test]
    fn checkpoint_round_trip_preserves_lfo_envelope_and_smoothing() {
        let settings = ModulationSettings {
            enabled: true,
            lfo_shape: ModLfoShape::Sine,
            lfo_rate_hz: 4.0,
            lfo_depth: 1.0,
            envelope_attack_ms: 3.0,
            envelope_release_ms: 90.0,
            envelope_amount: 0.9,
            routes: vec![route(
                ModRouteSource::Envelope,
                ModRouteTarget::MasterGain,
                0.8,
                1.0,
                40.0,
            )],
        };
        let frames = 600_usize;
        let left = lcg_noise(frames, 21, 0.6);
        let right = lcg_noise(frames, 22, 0.5);
        let to_interleaved = |l: &[f32], r: &[f32]| {
            l.iter()
                .zip(r)
                .flat_map(|(&a, &b)| [a, b])
                .collect::<Vec<_>>()
        };
        let run = |processor: &mut ModulationProcessor, samples: &mut [f32]| {
            let mut offset = 0_usize;
            while offset * 2 < samples.len() {
                let end = ((offset + 97).min(frames)) * 2;
                process(processor, &mut samples[offset * 2..end]).unwrap();
                offset += 97;
            }
        };

        let mut source = prepared(48_000.0, &settings, frames);
        let mut prefix = to_interleaved(&left, &right);
        run(&mut source, &mut prefix);
        let checkpoint = source.create_runtime_checkpoint().unwrap();
        assert!(source.runtime_checkpoint_compatible(checkpoint.as_ref()));
        let mut tail = to_interleaved(&left, &right);
        run(&mut source, &mut tail);

        // 检查点 restore 往返：同参新实例恢复后与原实例逐位一致。
        let mut replay = prepared(48_000.0, &settings, frames);
        assert!(replay.restore_runtime_state(checkpoint.as_ref()));
        let mut replayed = to_interleaved(&left, &right);
        run(&mut replay, &mut replayed);
        assert_eq!(replayed, tail);

        // save 复用路径。
        let mut reusable = source.create_runtime_checkpoint().unwrap();
        assert!(source.save_runtime_state(reusable.as_mut()));
        assert!(source.restore_runtime_state(reusable.as_ref()));

        // 采样率失配 + 类型失配：整体拒绝。
        let mut other_rate = prepared(44_100.0, &settings, 64);
        assert!(!other_rate.runtime_checkpoint_compatible(checkpoint.as_ref()));
        assert!(!other_rate.restore_runtime_state(checkpoint.as_ref()));
        let mut wrong: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!source.save_runtime_state(wrong.as_mut()));
        assert!(!source.restore_runtime_state(wrong.as_ref()));
    }

    #[test]
    fn chain_swap_adopts_state_only_between_active_instances() {
        // 语义说明：双方启用 → LFO 相位/包络/平滑记忆经核心四件套原子迁移，
        // 输出与「同实例 set_params 换参」的连续流逐位一致；禁用→启用 → 全新
        // 状态，输出与等价新实例逐位一致。
        let settings = lfo_master_settings(0.5);
        let changed = ModulationSettings {
            lfo_rate_hz: 2.0,
            ..settings.clone()
        };
        let frames = 400_usize;
        let left = lcg_noise(frames, 31, 0.6);
        let right = lcg_noise(frames, 32, 0.5);
        let to_interleaved = |l: &[f32], r: &[f32]| {
            l.iter()
                .zip(r)
                .flat_map(|(&a, &b)| [a, b])
                .collect::<Vec<_>>()
        };

        let mut previous = prepared(48_000.0, &settings, frames);
        let mut prefix = to_interleaved(&left, &right);
        process(&mut previous, &mut prefix).unwrap();

        // 参照：同一实例直接换参（状态连续）。
        let mut reference = prepared(48_000.0, &settings, frames);
        let mut reference_prefix = to_interleaved(&left, &right);
        process(&mut reference, &mut reference_prefix).unwrap();
        reference.set_params(changed.clone()).unwrap();

        let mut next = prepared(48_000.0, &changed, frames);
        assert!(next.adopt_runtime_state_from(&mut previous));
        let mut adopted = to_interleaved(&left, &right);
        process(&mut next, &mut adopted).unwrap();
        let mut expected = to_interleaved(&left, &right);
        process(&mut reference, &mut expected).unwrap();
        assert_eq!(
            adopted, expected,
            "adopt 后必须与换参保留状态的参考逐位一致"
        );

        // 路由数量不同：核心原子拒绝 → adopt 失败（链级重新起链）。
        let mut fewer_routes = prepared(
            48_000.0,
            &ModulationSettings {
                routes: Vec::new(),
                ..changed.clone()
            },
            64,
        );
        assert!(!fewer_routes.adopt_runtime_state_from(&mut next));

        // 采样率不同 + 类型不同：拒绝。
        let mut other_rate = prepared(44_100.0, &changed, 64);
        assert!(!other_rate.adopt_runtime_state_from(&mut next));
        let mut bypass = crate::dsp::BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut bypass));

        // 禁用→启用：adopt 不迁移状态（禁用实例无可迁移内容），随后经
        // set_params 启用触发 reset → 全新状态，输出与等价新实例逐位一致。
        let disabled_settings = ModulationSettings {
            enabled: false,
            ..settings.clone()
        };
        let mut from_disabled = prepared(48_000.0, &disabled_settings, 64);
        assert!(from_disabled.adopt_runtime_state_from(&mut previous));
        from_disabled.set_params(settings.clone()).unwrap();
        let mut fresh = prepared(48_000.0, &settings, 64);
        let mut a = lcg_noise(64, 51, 0.5)
            .iter()
            .zip(lcg_noise(64, 52, 0.5))
            .flat_map(|(&x, y)| [x, y])
            .collect::<Vec<_>>();
        let mut b = a.clone();
        process(&mut from_disabled, &mut a).unwrap();
        process(&mut fresh, &mut b).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn disabled_gap_does_not_advance_state_and_reenable_matches_fresh() {
        // 禁用期间矩阵状态不推进：重新启用后与从未禁用的等价新实例逐位一致
        // （set_params 启用触发 reset）。
        let settings = lfo_master_settings(0.5);
        let disabled = ModulationSettings {
            enabled: false,
            ..settings.clone()
        };
        let mut processor = prepared(48_000.0, &settings, 128);
        let gap = lcg_noise(128, 61, 0.5)
            .iter()
            .zip(lcg_noise(128, 62, 0.5))
            .flat_map(|(&x, y)| [x, y])
            .collect::<Vec<_>>();
        process(&mut processor, &mut gap.clone()).unwrap();
        processor.set_params(disabled).unwrap();
        let mut during_gap = gap.clone();
        process(&mut processor, &mut during_gap).unwrap();
        assert_eq!(during_gap, gap, "禁用期间逐位直通");
        processor.set_params(settings.clone()).unwrap();

        let mut fresh = prepared(48_000.0, &settings, 128);
        let mut a = lcg_noise(128, 71, 0.5)
            .iter()
            .zip(lcg_noise(128, 72, 0.5))
            .flat_map(|(&x, y)| [x, y])
            .collect::<Vec<_>>();
        let mut b = a.clone();
        process(&mut processor, &mut a).unwrap();
        process(&mut fresh, &mut b).unwrap();
        assert_eq!(a, b, "重新启用后必须与等价新实例逐位一致");
    }

    #[test]
    fn format_frame_and_capacity_validation_precede_bypass() {
        let mut processor =
            ModulationProcessor::new(48_000.0, ModulationSettings::default()).unwrap();
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
        assert_eq!(oversized, unchanged, "越界块必须在改写前被拒绝");
        let mut unprepared = ModulationProcessor::new(48_000.0, lfo_master_settings(0.5)).unwrap();
        let mut frame = [1.0_f32, -1.0];
        assert!(process(&mut unprepared, &mut frame).is_err());
        assert_eq!(frame, [1.0, -1.0], "未 prepare 的处理不得改写样本");
    }
}
