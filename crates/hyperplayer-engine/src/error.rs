use thiserror::Error;

pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("invalid transition from {from} using {command}")]
    InvalidTransition {
        from: &'static str,
        command: &'static str,
    },
    #[error("engine actor command queue is full")]
    ActorQueueFull,
    #[error("engine actor is unavailable")]
    ActorUnavailable,
    #[error("engine actor response channel closed")]
    ActorResponseClosed,
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("decode failed: {0}")]
    Decode(String),
    #[error("audio backend failed: {0}")]
    AudioBackend(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("metadata parse error: {0}")]
    Metadata(#[from] lofty::error::FileParseError),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
}
