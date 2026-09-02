//! HSE v1.5.1 Stage 22 Spatial/HRTF 的 HyperPlayer PCM 适配器（IDS 22，链尾）。
//!
//! # 职责边界（D33 主备与去重）
//!
//! DSP 运算、扬声器布局、房间声场与 HRTF 卷积全部由 vendored core 权威实现：
//! 渲染走 `hrtf_core::BinauralRenderer`，舞台构造与参数语义走
//! `hse_core::engine_chain::build_spatial_stage`（与引擎链/HSE2 投影共享同一
//! 份 speaker/room/ambience 逻辑）。本模块只负责 HyperPlayer 侧的：
//!
//! - typed 参数快照（[`SpatialSettings`]，含资源引用 [`SpatialResourceSpec`]）；
//! - **非实时**资源加载通道：资源文件（随产品分发的 MIT KEMAR SOFA）由 Tauri
//!   定位（bundle resource 路径 + 固定 SHA-256），经
//!   `hrtf_core::resource::load_verified_resource` 做 SHA-256 + SimpleFreeFieldHRIR
//!   校验后进入渲染器；hash 不匹配/文件缺失/解析失败 → 渲染器不可用 + 显式
//!   旁路 + 诊断（[`SpatialResourceStatus`]），**绝不静默用错数据**；
//! - 立体声交错/平面转换、生命周期、checkpoint 与链级语义。
//!
//! # 链级语义（`dsp.rs` 自动折叠）
//!
//! - `latency_frames`：启用时如实上报渲染器延迟（分区卷积 = 分区大小，时域
//!   卷积 = 0）；禁用（mode=off 或资源不可用）逐位直通，上报 0。
//! - `tail_frames`：启用时 = 渲染器延迟 + HRIR 长度（HRTF 卷积在输入停止后
//!   的拖尾）；房间混响的衰减拖尾没有权威 API，不虚报（与 HSE 引擎链一致）。
//! - `checkpoint`：渲染器状态为不透明运行态（hrtf-core 未提供深度快照 API），
//!   checkpoint 保存采样率/参数/舞台有无的拓扑快照；`restore` 以
//!   `SpatialStage::reset()` 的干净渲染器状态继续（slot 布局由参数确定性派生，
//!   稳定不变）。回滚后果是毫秒级空间卷积淡入，不产生爆音，不承诺逐位回放。
//! - 声道语义：立体声进、立体声出。输入左右声道按模式布局映射为双耳扬声器
//!   对象，渲染结果是双耳左右声道（不扩展声道数，无额外下混）。
//! - 参数更新 latest-wins：所有参数（mode/room/gain/布局）在控制路径重建舞台
//!   后原位替换；同模式 world→world 保留上一份参数对象以维持听者速度与稳定
//!   slot 连续性。资源热更换 = 携带新资源引用的新 revision 配置，编译线程
//!   「先验证再原子替换」，验证失败则新配置整体降级为显式旁路（保持旧链不
//!   受影响是链级 pending 语义的职责）。

use std::path::PathBuf;
use std::sync::Mutex;

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hrtf_core::{
    HrtfGrid, HrtfResourceDescriptor, HrtfResourceProvenance, ResourceError, SofaGridOptions,
};
use hse_core::engine_chain::{build_spatial_stage, EngineChainParams, SpatialStage};
use serde_json::{json, Value};

/// 随产品分发的 HRTF 资产的声明来源（见 `provenance/hrtf-mit-kemar/README.md`）。
/// 自定义外部资源应扩展描述符携带自己的 provenance；当前产品路径只注入本资产。
fn bundled_asset_provenance() -> HrtfResourceProvenance {
    HrtfResourceProvenance::new(
        "MIT KEMAR (normal pinna)",
        "1994-05 measurement (SOFA conversion 2020-03-24)",
        "https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa",
        "MIT Media Lab 1994 — no restrictions on use, provided the authors are cited",
        "Attribution: Gardner & Martin, MIT Media Lab Perceptual Computing TR #280; \
         cited in THIRD_PARTY_NOTICES.md / third_party_licenses/MIT-KEMAR-HRTF.txt",
    )
}

/// 空间模式（HSE `/spatial/mode` 枚举）。`Off` 为默认：逐位直通。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialMode {
    #[default]
    Off,
    Instant,
    HeadLocked,
    World,
    Stage,
}

impl std::str::FromStr for SpatialMode {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "off" => Some(Self::Off),
            "instant" => Some(Self::Instant),
            "headLocked" => Some(Self::HeadLocked),
            "world" => Some(Self::World),
            "stage" => Some(Self::Stage),
            _ => None,
        }
        .ok_or_else(|| format!("unknown spatial enum value {value:?}"))
    }
}

impl SpatialMode {
    /// HSE JSON 枚举字符串（`/spatial` 段命名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Instant => "instant",
            Self::HeadLocked => "headLocked",
            Self::World => "world",
            Self::Stage => "stage",
        }
    }
}

/// instant 模式的房间预设（HSE `/spatial/instant/room` 枚举）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialRoomPreset {
    #[default]
    Off,
    Studio,
    Hall,
    Stage,
    Church,
    Outdoor,
    Bathroom,
    Corridor,
}

impl std::str::FromStr for SpatialRoomPreset {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "off" => Some(Self::Off),
            "studio" => Some(Self::Studio),
            "hall" => Some(Self::Hall),
            "stage" => Some(Self::Stage),
            "church" => Some(Self::Church),
            "outdoor" => Some(Self::Outdoor),
            "bathroom" => Some(Self::Bathroom),
            "corridor" => Some(Self::Corridor),
            _ => None,
        }
        .ok_or_else(|| format!("unknown spatial enum value {value:?}"))
    }
}

impl SpatialRoomPreset {
    /// HSE JSON 枚举字符串（`/spatial` 段命名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Studio => "studio",
            Self::Hall => "hall",
            Self::Stage => "stage",
            Self::Church => "church",
            Self::Outdoor => "outdoor",
            Self::Bathroom => "bathroom",
            Self::Corridor => "corridor",
        }
    }
}

/// 距离衰减模型（HSE `/spatial/distanceModel` 枚举）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialDistanceModel {
    #[default]
    Inverse,
    Linear,
    Exponential,
}

impl std::str::FromStr for SpatialDistanceModel {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "inverse" => Some(Self::Inverse),
            "linear" => Some(Self::Linear),
            "exponential" => Some(Self::Exponential),
            _ => None,
        }
        .ok_or_else(|| format!("unknown spatial enum value {value:?}"))
    }
}

impl SpatialDistanceModel {
    /// HSE JSON 枚举字符串（`/spatial` 段命名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inverse => "inverse",
            Self::Linear => "linear",
            Self::Exponential => "exponential",
        }
    }
}

/// HRTF 卷积实现（HSE `/spatial/convolution` 枚举）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialConvolution {
    Time,
    #[default]
    Partitioned,
}

impl std::str::FromStr for SpatialConvolution {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "time" => Some(Self::Time),
            "partitioned" => Some(Self::Partitioned),
            _ => None,
        }
        .ok_or_else(|| format!("unknown spatial enum value {value:?}"))
    }
}

impl SpatialConvolution {
    /// HSE JSON 枚举字符串（`/spatial` 段命名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Time => "time",
            Self::Partitioned => "partitioned",
        }
    }
}

/// HRTF 方向插值（HSE `/spatial/hrtfInterp` 枚举）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialInterpolation {
    #[default]
    Nearest,
    Spherical,
}

impl std::str::FromStr for SpatialInterpolation {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "nearest" => Some(Self::Nearest),
            "spherical" => Some(Self::Spherical),
            _ => None,
        }
        .ok_or_else(|| format!("unknown spatial enum value {value:?}"))
    }
}

impl SpatialInterpolation {
    /// HSE JSON 枚举字符串（`/spatial` 段命名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nearest => "nearest",
            Self::Spherical => "spherical",
        }
    }
}

/// stage 模式的演出布局预设（HSE `/spatial/stage/preset` 枚举）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialStagePreset {
    #[default]
    Stage,
    Cinema,
    Piano,
    Nature,
}

impl std::str::FromStr for SpatialStagePreset {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "stage" => Some(Self::Stage),
            "cinema" => Some(Self::Cinema),
            "piano" => Some(Self::Piano),
            "nature" => Some(Self::Nature),
            _ => None,
        }
        .ok_or_else(|| format!("unknown spatial enum value {value:?}"))
    }
}

impl SpatialStagePreset {
    /// HSE JSON 枚举字符串（`/spatial` 段命名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stage => "stage",
            Self::Cinema => "cinema",
            Self::Piano => "piano",
            Self::Nature => "nature",
        }
    }
}

/// stage 模式的座位（HSE `/spatial/stage/seat` 枚举）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialSeat {
    Front,
    #[default]
    Middle,
    Back,
}

impl std::str::FromStr for SpatialSeat {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "front" => Some(Self::Front),
            "middle" => Some(Self::Middle),
            "back" => Some(Self::Back),
            _ => None,
        }
        .ok_or_else(|| format!("unknown spatial enum value {value:?}"))
    }
}

impl SpatialSeat {
    /// HSE JSON 枚举字符串（`/spatial` 段命名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Front => "front",
            Self::Middle => "middle",
            Self::Back => "back",
        }
    }
}

/// 空间资源引用：由 Tauri 侧解析的 bundle 资源路径 + 固定期望 SHA-256。
///
/// 路径是本机路径，**不参与 HSE2 序列化、不进入 DTO、不持久化**（分享码不含
/// 本机路径）；engine 在非实时编译线程按该引用校验加载。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpatialResourceSpec {
    /// SOFA 文件的绝对路径。
    pub path: PathBuf,
    /// 期望 SHA-256（64 个十六进制字符，大小写不敏感）。
    pub expected_sha256_hex: String,
}

/// 空间 stage 参数快照（与 HSE `/spatial` 段一一对应；headLocked/world/stage
/// 的对象布局本轮使用 HSE 默认布局，由舞台构造统一解析）。
#[derive(Clone, Debug, PartialEq)]
pub struct SpatialSettings {
    pub mode: SpatialMode,
    /// 主增益（HSE 默认 0.9；范围 0.5..=1.0）。
    pub master_gain: f64,
    /// instant 模式干湿量（0..=1）。
    pub instant_amount: f64,
    /// instant 模式立体声展开角（20..=120 度）。
    pub instant_spread_deg: f64,
    /// instant 模式房间预设。
    pub instant_room: SpatialRoomPreset,
    /// instant 模式房间混合量（0..=1）。
    pub instant_room_amount: f64,
    /// 距离衰减模型。
    pub distance_model: SpatialDistanceModel,
    /// 参考距离（>= 0.1 米）。
    pub ref_distance: f64,
    /// 最大距离（> 参考距离 + 0.1 米）。
    pub max_distance: f64,
    /// 卷积实现。
    pub convolution: SpatialConvolution,
    /// HRTF 方向插值。
    pub hrtf_interp: SpatialInterpolation,
    /// stage 模式布局预设。
    pub stage_preset: SpatialStagePreset,
    /// stage 模式座位。
    pub seat: SpatialSeat,
    /// stage 模式房间缩放（0.5..=2）。
    pub stage_room_size: f64,
    /// stage 模式混响量（0..=1）。
    pub stage_reverb_amount: f64,
    /// world 模式全局遮挡量（0..=1）。
    pub world_occlusion: f64,
    /// 环境声层开关。
    pub ambience_enabled: bool,
    /// 环境声层强度（0..=1）。
    pub ambience_amount: f64,
    /// 资源引用；`mode == Off` 时可省略，其余模式缺失时进入显式旁路。
    pub resource: Option<SpatialResourceSpec>,
}

impl Default for SpatialSettings {
    fn default() -> Self {
        Self {
            mode: SpatialMode::Off,
            master_gain: 0.9,
            instant_amount: 0.7,
            instant_spread_deg: 60.0,
            instant_room: SpatialRoomPreset::Studio,
            instant_room_amount: 0.15,
            distance_model: SpatialDistanceModel::Inverse,
            ref_distance: 1.0,
            max_distance: 50.0,
            convolution: SpatialConvolution::Partitioned,
            hrtf_interp: SpatialInterpolation::Nearest,
            stage_preset: SpatialStagePreset::Stage,
            seat: SpatialSeat::Middle,
            stage_room_size: 1.0,
            stage_reverb_amount: 0.35,
            world_occlusion: 0.0,
            ambience_enabled: false,
            ambience_amount: 0.3,
            resource: None,
        }
    }
}

impl SpatialSettings {
    /// 是否请求空间渲染（mode != off）。资源不可用时舞台退化为显式旁路。
    pub fn is_active(&self) -> bool {
        self.mode != SpatialMode::Off
    }

    fn validate(&self) -> Result<()> {
        let invalid = |name: &str| {
            Err(EngineError::InvalidInput(format!(
                "spatial settings {name} out of range"
            )))
        };
        let finite = [
            ("master_gain", self.master_gain),
            ("instant_amount", self.instant_amount),
            ("instant_spread_deg", self.instant_spread_deg),
            ("instant_room_amount", self.instant_room_amount),
            ("ref_distance", self.ref_distance),
            ("max_distance", self.max_distance),
            ("stage_room_size", self.stage_room_size),
            ("stage_reverb_amount", self.stage_reverb_amount),
            ("world_occlusion", self.world_occlusion),
            ("ambience_amount", self.ambience_amount),
        ];
        if finite.iter().any(|(_, value)| !value.is_finite()) {
            return Err(EngineError::InvalidInput(
                "spatial settings must be finite".into(),
            ));
        }
        if !(0.5..=1.0).contains(&self.master_gain) {
            return invalid("master_gain");
        }
        if !(0.0..=1.0).contains(&self.instant_amount)
            || !(0.0..=1.0).contains(&self.instant_room_amount)
            || !(20.0..=120.0).contains(&self.instant_spread_deg)
        {
            return invalid("instant");
        }
        if self.ref_distance < 0.1 || self.max_distance <= self.ref_distance + 0.1 {
            return invalid("distance range");
        }
        if !(0.5..=2.0).contains(&self.stage_room_size)
            || !(0.0..=1.0).contains(&self.stage_reverb_amount)
            || !(0.0..=1.0).contains(&self.world_occlusion)
            || !(0.0..=1.0).contains(&self.ambience_amount)
        {
            return invalid("stage/world/ambience");
        }
        Ok(())
    }

    /// 投影为引擎链参数 overrides（仅 `/spatial` 段；其余段沿用 HSE 默认值）。
    fn overrides_json(&self) -> Value {
        json!({
            "spatial": {
                "mode": self.mode.as_str(),
                "masterGain": self.master_gain,
                "distanceModel": self.distance_model.as_str(),
                "refDistance": self.ref_distance,
                "maxDistance": self.max_distance,
                "convolution": self.convolution.as_str(),
                "hrtfInterp": self.hrtf_interp.as_str(),
                "instant": {
                    "spreadDeg": self.instant_spread_deg,
                    "amount": self.instant_amount,
                    "room": self.instant_room.as_str(),
                    "roomAmount": self.instant_room_amount,
                },
                "stage": {
                    "preset": self.stage_preset.as_str(),
                    "seat": self.seat.as_str(),
                    "roomSize": self.stage_room_size,
                    "reverbAmount": self.stage_reverb_amount,
                },
                "world": {
                    "occlusion": self.world_occlusion,
                },
                "ambience": {
                    "enabled": self.ambience_enabled,
                    "amount": self.ambience_amount,
                },
            }
        })
    }
}

/// 资源加载诊断：渲染器「到底用了哪份数据 / 为什么不可用」的唯一答案。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpatialResourceStatus {
    /// mode=off：未请求资源。
    NotRequired,
    /// 资源已通过 SHA-256 与 SOFA 校验，渲染器可用。
    Verified {
        sha256_hex: String,
        sample_rate: u32,
        azimuths: usize,
        elevations: usize,
        hrir_length: usize,
    },
    /// 资源不可用（hash 不匹配/缺失/解析失败/未提供引用）：显式旁路。
    Unavailable { reason: String },
}

/// 编译线程的已验证网格缓存：按（路径、期望 hash、采样率）缓存最近一次
/// 加载结果，避免每次链编译重复解析/重采样整个网格。仅控制路径使用。
/// 缓存键：（路径、期望 hash、目标采样率）。
type GridCacheKey = (PathBuf, String, u32);

static GRID_CACHE: Mutex<Option<(GridCacheKey, HrtfGrid)>> = Mutex::new(None);

/// 经 SHA-256 + SOFA 校验加载网格（带最近一次结果缓存；非实时路径专用）。
fn load_verified_grid(
    spec: &SpatialResourceSpec,
    sample_rate: u32,
) -> std::result::Result<HrtfGrid, ResourceError> {
    let key = (
        spec.path.clone(),
        spec.expected_sha256_hex.to_ascii_lowercase(),
        sample_rate,
    );
    if let Ok(guard) = GRID_CACHE.lock() {
        if let Some((cached_key, grid)) = guard.as_ref() {
            if *cached_key == key {
                return Ok(grid.clone());
            }
        }
    }
    let descriptor = HrtfResourceDescriptor::new(
        spec.path.clone(),
        spec.expected_sha256_hex.clone(),
        sample_rate,
        bundled_asset_provenance(),
        SofaGridOptions {
            sample_rate,
            ..SofaGridOptions::default()
        },
    )?;
    let resource = hrtf_core::resource::load_verified_resource(&descriptor)?;
    let grid = resource.into_parts().0;
    if let Ok(mut guard) = GRID_CACHE.lock() {
        *guard = Some((key, grid.clone()));
    }
    Ok(grid)
}

/// checkpoint 拓扑快照：渲染器音频状态为不透明运行态，不深度快照（见模块
/// 文档的 checkpoint 语义）。
#[derive(Clone, Debug, PartialEq)]
struct SpatialCheckpoint {
    sample_rate_bits: u64,
    settings: SpatialSettings,
    stage_active: bool,
}

/// Stage 22 空间/HRTF 处理器（IDS 22，链尾）。
pub struct SpatialProcessor {
    sample_rate: f64,
    settings: SpatialSettings,
    /// 与 `settings` 对应的完整引擎链参数对象（world 连续性用 previous）。
    params_value: Value,
    stage: Option<SpatialStage>,
    resource_status: SpatialResourceStatus,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl SpatialProcessor {
    /// 构造处理器（非实时路径；资源校验与渲染器构造都在此完成）。
    ///
    /// 参数非法返回 `Err`；资源不可用**不**返回 `Err`——按显式旁路处理并在
    /// [`resource_status`](Self::resource_status) 留下诊断。
    pub fn new(sample_rate: f64, settings: SpatialSettings) -> Result<Self> {
        if !sample_rate.is_finite() || sample_rate <= 0.0 {
            return Err(EngineError::InvalidInput(
                "spatial sample rate must be finite and greater than zero".into(),
            ));
        }
        settings.validate()?;
        let params_value =
            EngineChainParams::from_overrides(sample_rate, &settings.overrides_json())
                .map_err(EngineError::InvalidInput)?
                .as_value()
                .clone();
        let mut processor = Self {
            sample_rate,
            settings,
            params_value,
            stage: None,
            resource_status: SpatialResourceStatus::NotRequired,
            left: Vec::new(),
            right: Vec::new(),
        };
        processor.rebuild_stage(None);
        Ok(processor)
    }

    /// latest-wins 参数更新（控制路径）：重建舞台并原位替换。
    ///
    /// 同模式 world→world 传入上一份参数对象，保持听者速度与稳定 slot 连续；
    /// 资源不可用时新配置整体进入显式旁路（诊断见 `resource_status`）。
    pub fn set_params(&mut self, settings: SpatialSettings) -> Result<()> {
        settings.validate()?;
        let params_value =
            EngineChainParams::from_overrides(self.sample_rate, &settings.overrides_json())
                .map_err(EngineError::InvalidInput)?
                .as_value()
                .clone();
        let previous = (self.settings.mode == SpatialMode::World
            && settings.mode == SpatialMode::World)
            .then(|| self.params_value.clone());
        self.params_value = params_value;
        self.settings = settings;
        self.rebuild_stage(previous.as_ref());
        Ok(())
    }

    /// 当前参数快照。
    pub fn settings(&self) -> &SpatialSettings {
        &self.settings
    }

    /// 是否有可用的空间舞台（mode != off 且资源校验通过）。
    pub fn is_active(&self) -> bool {
        self.stage.is_some()
    }

    /// 资源加载诊断（Verified/Unavailable/NotRequired）。
    pub fn resource_status(&self) -> &SpatialResourceStatus {
        &self.resource_status
    }

    /// 按 `settings` + `params_value` 重建舞台；失败 = 显式旁路 + 诊断。
    fn rebuild_stage(&mut self, previous: Option<&Value>) {
        if !self.settings.is_active() {
            self.stage = None;
            self.resource_status = SpatialResourceStatus::NotRequired;
            return;
        }
        let Some(spec) = self.settings.resource.clone() else {
            self.stage = None;
            self.resource_status = SpatialResourceStatus::Unavailable {
                reason: "spatial resource reference missing (Tauri 未注入资产路径)".into(),
            };
            return;
        };
        let sample_rate = self.sample_rate.round() as u32;
        match load_verified_grid(&spec, sample_rate) {
            Ok(grid) => {
                let identity = (
                    spec.expected_sha256_hex.to_ascii_lowercase(),
                    grid.sample_rate(),
                    grid.azimuths().len(),
                    grid.elevations().len(),
                    grid.hrir_length(),
                );
                match build_spatial_stage(
                    &self.params_value,
                    self.sample_rate,
                    Some(grid),
                    previous,
                ) {
                    Ok(stage) => {
                        self.resource_status = SpatialResourceStatus::Verified {
                            sha256_hex: identity.0,
                            sample_rate: identity.1,
                            azimuths: identity.2,
                            elevations: identity.3,
                            hrir_length: identity.4,
                        };
                        self.stage = stage;
                    }
                    Err(reason) => {
                        self.stage = None;
                        self.resource_status = SpatialResourceStatus::Unavailable { reason };
                    }
                }
            }
            Err(error) => {
                self.stage = None;
                self.resource_status = SpatialResourceStatus::Unavailable {
                    reason: error.to_string(),
                };
            }
        }
    }

    fn reset_runtime_state(&mut self) {
        if let Some(stage) = &mut self.stage {
            stage.reset();
        }
        self.left.fill(0.0);
        self.right.fill(0.0);
    }
}

impl PcmProcessor for SpatialProcessor {
    fn name(&self) -> &'static str {
        "spatial"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        // 渲染器音频状态不可迁移（不透明运行态）：新链以干净舞台接管；参数
        // 与 slot 布局由配置确定性派生，拓扑一致时语义连续。
        if self.is_active() && previous.is_active() && self.settings != previous.settings {
            self.reset_runtime_state();
        }
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(SpatialCheckpoint {
            sample_rate_bits: self.sample_rate.to_bits(),
            settings: self.settings.clone(),
            stage_active: self.stage.is_some(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<SpatialCheckpoint>()
            .is_some_and(|state| {
                state.sample_rate_bits == self.sample_rate.to_bits()
                    && state.stage_active == self.stage.is_some()
                    && state.settings == self.settings
            })
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        self.runtime_checkpoint_compatible(state)
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        if !self.runtime_checkpoint_compatible(state) {
            return false;
        }
        // 渲染器状态回滚以干净舞台继续（模块文档的 checkpoint 语义）。
        self.reset_runtime_state();
        true
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        if let Some(stage) = &mut self.stage {
            stage.prepare(max_block_frames);
        }
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "spatial requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "spatial block exceeds the prepared frame capacity".into(),
            ));
        }
        let Some(stage) = &mut self.stage else {
            // 显式旁路（mode=off 或资源不可用）：逐位直通。
            return Ok(());
        };
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        stage.process(&mut self.left[..frames], &mut self.right[..frames]);
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
        self.stage
            .as_ref()
            .map_or(0, |stage| stage.latency_samples() as u32)
    }

    fn tail_frames(&self) -> u32 {
        self.stage.as_ref().map_or(0, |stage| {
            stage
                .latency_samples()
                .saturating_add(stage.hrir_length())
                .min(u32::MAX as usize) as u32
        })
    }
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "spatial requires stereo PCM".into(),
        ));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "spatial sample rate does not match PCM format".into(),
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

    #[test]
    fn default_settings_are_off_transparent() {
        let settings = SpatialSettings::default();
        assert_eq!(settings.mode, SpatialMode::Off);
        assert!(!settings.is_active());
        let mut processor = SpatialProcessor::new(48_000.0, settings).unwrap();
        processor.prepare(format(48_000), 16).unwrap();
        assert_eq!(processor.name(), "spatial");
        assert!(!processor.is_active());
        assert_eq!(
            processor.resource_status(),
            &SpatialResourceStatus::NotRequired
        );
        let mut samples = [
            -0.0_f32,
            0.25,
            -0.5,
            1.0,
            0.75,
            -0.25,
            0.0,
            f32::MIN_POSITIVE,
        ];
        let expected = samples.map(f32::to_bits);
        processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut samples,
            })
            .unwrap();
        assert_eq!(samples.map(f32::to_bits), expected);
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
    }

    #[test]
    fn active_mode_without_resource_degrades_to_explicit_bypass() {
        let settings = SpatialSettings {
            mode: SpatialMode::Instant,
            ..SpatialSettings::default()
        };
        let mut processor = SpatialProcessor::new(48_000.0, settings).unwrap();
        assert!(!processor.is_active());
        assert!(matches!(
            processor.resource_status(),
            SpatialResourceStatus::Unavailable { .. }
        ));
        // 显式旁路仍要求合法块契约，且逐位直通。
        processor.prepare(format(48_000), 4).unwrap();
        let mut samples = [0.5_f32, -0.5, 0.25, -0.25];
        let expected = samples.map(f32::to_bits);
        processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut samples,
            })
            .unwrap();
        assert_eq!(samples.map(f32::to_bits), expected);
        assert_eq!(processor.latency_frames(), 0);
    }

    #[test]
    fn missing_resource_reports_diagnostics_not_silent_passthrough() {
        let settings = SpatialSettings {
            mode: SpatialMode::HeadLocked,
            resource: Some(SpatialResourceSpec {
                path: PathBuf::from("Z:/definitely/missing/kemar.sofa"),
                expected_sha256_hex:
                    "e7035994f5fd754058424c061380ee92b1d5ed58fccef2887a4266916616acdf".into(),
            }),
            ..SpatialSettings::default()
        };
        let processor = SpatialProcessor::new(48_000.0, settings).unwrap();
        match processor.resource_status() {
            SpatialResourceStatus::Unavailable { reason } => {
                assert!(!reason.is_empty());
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn invalid_settings_are_rejected_before_resource_lookup() {
        for settings in [
            SpatialSettings {
                master_gain: 0.4,
                ..SpatialSettings::default()
            },
            SpatialSettings {
                mode: SpatialMode::Instant,
                instant_spread_deg: 10.0,
                ..SpatialSettings::default()
            },
            SpatialSettings {
                ref_distance: 0.05,
                ..SpatialSettings::default()
            },
            SpatialSettings {
                max_distance: 1.0,
                ref_distance: 1.0,
                ..SpatialSettings::default()
            },
            SpatialSettings {
                stage_room_size: 3.0,
                ..SpatialSettings::default()
            },
        ] {
            assert!(SpatialProcessor::new(48_000.0, settings).is_err());
        }
        assert!(SpatialProcessor::new(0.0, SpatialSettings::default()).is_err());
    }

    #[test]
    fn overrides_json_projects_every_typed_field() {
        let settings = SpatialSettings {
            mode: SpatialMode::Stage,
            master_gain: 1.0,
            instant_amount: 0.4,
            instant_spread_deg: 80.0,
            instant_room: SpatialRoomPreset::Hall,
            instant_room_amount: 0.5,
            distance_model: SpatialDistanceModel::Exponential,
            ref_distance: 2.0,
            max_distance: 30.0,
            convolution: SpatialConvolution::Time,
            hrtf_interp: SpatialInterpolation::Spherical,
            stage_preset: SpatialStagePreset::Cinema,
            seat: SpatialSeat::Back,
            stage_room_size: 1.5,
            stage_reverb_amount: 0.2,
            world_occlusion: 0.25,
            ambience_enabled: true,
            ambience_amount: 0.6,
            resource: None,
        };
        let value = settings.overrides_json();
        let spatial = value.get("spatial").expect("spatial overrides object");
        assert_eq!(spatial["mode"], "stage");
        assert_eq!(spatial["masterGain"], 1.0);
        assert_eq!(spatial["distanceModel"], "exponential");
        assert_eq!(spatial["convolution"], "time");
        assert_eq!(spatial["hrtfInterp"], "spherical");
        assert_eq!(spatial["instant"]["spreadDeg"], 80.0);
        assert_eq!(spatial["instant"]["room"], "hall");
        assert_eq!(spatial["stage"]["preset"], "cinema");
        assert_eq!(spatial["stage"]["seat"], "back");
        assert_eq!(spatial["world"]["occlusion"], 0.25);
        assert_eq!(spatial["ambience"]["enabled"], true);
        assert_eq!(spatial["ambience"]["amount"], 0.6);
    }

    #[test]
    fn params_update_is_latest_wins_and_rejects_invalid() {
        let mut processor = SpatialProcessor::new(48_000.0, SpatialSettings::default()).unwrap();
        assert!(processor
            .set_params(SpatialSettings {
                mode: SpatialMode::Instant,
                master_gain: 0.2,
                ..SpatialSettings::default()
            })
            .is_err());
        // 失败的更新不得改写当前参数（latest-wins 只接受合法快照）。
        assert_eq!(processor.settings().mode, SpatialMode::Off);
        processor
            .set_params(SpatialSettings {
                mode: SpatialMode::Instant,
                ..SpatialSettings::default()
            })
            .unwrap();
        assert_eq!(processor.settings().mode, SpatialMode::Instant);
        assert!(matches!(
            processor.resource_status(),
            SpatialResourceStatus::Unavailable { .. }
        ));
        processor.set_params(SpatialSettings::default()).unwrap();
        assert_eq!(processor.settings().mode, SpatialMode::Off);
        assert_eq!(
            processor.resource_status(),
            &SpatialResourceStatus::NotRequired
        );
    }

    #[test]
    fn checkpoints_track_settings_and_stage_presence() {
        let mut processor = SpatialProcessor::new(48_000.0, SpatialSettings::default()).unwrap();
        let mut checkpoint = processor.create_runtime_checkpoint().unwrap();
        assert!(processor.runtime_checkpoint_compatible(checkpoint.as_ref()));
        assert!(processor.save_runtime_state(checkpoint.as_mut()));
        assert!(processor.restore_runtime_state(checkpoint.as_ref()));

        let mut other_rate = SpatialProcessor::new(44_100.0, SpatialSettings::default()).unwrap();
        assert!(!other_rate.runtime_checkpoint_compatible(checkpoint.as_ref()));
        assert!(!other_rate.restore_runtime_state(checkpoint.as_ref()));
        let mut wrong: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!processor.save_runtime_state(wrong.as_mut()));
        assert!(!processor.restore_runtime_state(wrong.as_ref()));
    }
}
