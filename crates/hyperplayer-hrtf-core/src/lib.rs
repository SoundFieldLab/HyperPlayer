//! Platform-independent HRTF spatial geometry and rendering primitives.
//!
//! # 状态说明
//!
//! HRTF/SOFA 数据的**资源合规审计尚未完成**：本 crate 不捆绑任何 SOFA/HRTF
//! 产品资产，HIR/SOFA 数据只能通过 [`resource`] 模块的外部注入 API 由用户
//! 提供（路径 + SHA-256 + 来源声明）。Stage 22 Spatial/HRTF 的产品接线
//! （engine asset loader/adapter、Tauri capability/DTO、空间场 UI）在资产
//! 门禁通过前保持受阻，不得据此宣称产品完成。

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
