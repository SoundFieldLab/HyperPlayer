//! HyperPlayer 框架无关的播放、曲库、缓存与音频协调核心。

pub mod actor;
pub mod album;
pub mod audio;
pub mod cache;
pub mod cache_policy;
pub mod dsp;
pub mod dsp_algorithms;
pub mod error;
pub mod library;
pub mod lyrics;
pub mod media;
pub mod model;
pub mod playback;
pub mod queue;
pub mod repository;
pub mod runtime;
pub mod telemetry;

pub use actor::{EngineCommand, EngineEvent, EngineEventKind, EngineHandle};
pub use error::{EngineError, Result};
pub use media::{MediaHandle, MediaHandleKind, TrustedResolvedMedia};
pub use model::{MediaId, MediaSource, QueueItem, Track};
pub use playback::{DspExecutionFault, DspExecutionSnapshot, PlaybackSnapshot, PlaybackState};
pub use telemetry::{TelemetryActivity, TelemetryFrame, TelemetryHub, TelemetrySubscriber};

/// HSE 控制面快照；实时播放仍只接受 typed [`dsp_algorithms::DspConfig`]。
pub fn hse_builtin_scenes() -> Vec<serde_json::Value> {
    hse_core::scenes::builtin_scenes()
}

pub fn hse_default_params(sample_rate: f64) -> serde_json::Value {
    hse_core::params::default_params(sample_rate)
}

pub fn hse_encode_share_code(params: &serde_json::Value) -> std::result::Result<String, String> {
    hse_core::share_codec::encode_share_code(params)
}

pub fn hse_decode_share_code(code: &str) -> std::result::Result<serde_json::Value, String> {
    hse_core::share_codec::decode_share_code(code)
}
