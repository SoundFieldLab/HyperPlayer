//! HyperPlayer 框架无关的播放、曲库、缓存与音频协调核心。

pub mod actor;
pub mod album;
pub mod audio;
pub mod cache;
pub mod dsp;
pub mod error;
pub mod library;
pub mod lyrics;
pub mod media;
pub mod model;
pub mod playback;
pub mod queue;
pub mod repository;
pub mod runtime;

pub use actor::{EngineCommand, EngineEvent, EngineEventKind, EngineHandle};
pub use error::{EngineError, Result};
pub use media::{MediaHandle, MediaHandleKind, TrustedResolvedMedia};
pub use model::{MediaId, MediaSource, QueueItem, Track};
pub use playback::{PlaybackSnapshot, PlaybackState};
