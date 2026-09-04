//! HyperPlayer 框架无关的本地曲库核心（D34/D35 重定调后）。
//!
//! 播放、DSP、网易云协议与缓存治理已迁入 WebView 前端（TypeScript）；
//! 本 crate 只保留本地曲库：SQLite repository、lofty 扫描、封面与模型。

pub mod error;
pub mod library;
pub mod model;
pub mod repository;

pub use error::{EngineError, Result};
pub use model::{MediaId, MediaSource, Track};
