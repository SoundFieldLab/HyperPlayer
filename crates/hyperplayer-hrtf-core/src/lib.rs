//! Platform-independent HRTF spatial geometry and rendering primitives.
//!
//! # 产品资产状态（2026-09-03 起）
//!
//! 已审计的 MIT KEMAR HRTF 资产随产品分发：`assets/hrtf/mit-kemar-normal-pinna.sofa`
//! （来源、许可证、hash 与分发义务见 `provenance/hrtf-mit-kemar/README.md` 与
//! `third_party_licenses/MIT-KEMAR-HRTF.txt`）。运行时加载必须经 [`resource`]
//! 的 SHA-256 校验通道；hash 不匹配、文件缺失或解析失败一律显式拒绝并回退
//! 旁路，绝不静默使用错误数据。[`fixtures`] 模块（feature `test-fixtures`）
//! 只服务测试，不是生产 API。

pub mod grid;
pub mod interpolation;
pub mod model;
mod partitioned;
pub mod renderer;
pub mod resource;
pub mod room;
pub mod sha256;
pub mod sofa;
pub mod world;

#[cfg(feature = "test-fixtures")]
pub mod fixtures;

pub use grid::{GridError, HrirPair, HrtfGrid, NearestIndex};
pub use interpolation::{InterpolationError, InterpolationMode};
pub use model::{air_absorption_coefficient, DistanceModel, DistanceParams, ModelError};
pub use partitioned::ConvolutionMode;
pub use renderer::{
    BinauralRenderer, HrtfRenderer, ObjectEffects, ObjectInput, PrepareError, ProcessError,
    RenderProfile,
};
pub use resource::{
    HrtfResourceDescriptor, HrtfResourceIdentity, HrtfResourceManager, HrtfResourceProvenance,
    ResourceError, VerifiedHrtfResource,
};
pub use room::{RoomError, RoomParams, RoomPreset};
pub use sha256::{digest as sha256_digest, digest_hex as sha256_digest_hex};
pub use sofa::{
    load_sofa_bytes, load_sofa_file, SofaDelayStrategy, SofaError, SofaGridOptions, SofaLookupMode,
    SofaRegularAxis,
};
pub use world::{
    relative_direction, relative_direction_pose, wrap_azimuth_deg, RelativeDirection, Vec3,
    WorldListener, WorldListenerPose,
};
