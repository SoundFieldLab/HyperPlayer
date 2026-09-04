use serde::Serialize;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("operation unavailable: {0}")]
    Unavailable(String),
    #[error("application state is unavailable")]
    StateUnavailable,
    #[error("window operation failed: {0}")]
    Window(String),
    #[error("I/O operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("credential operation failed: {0}")]
    Credential(&'static str),
    #[error("engine operation failed: {0}")]
    Engine(#[from] hyperplayer_engine::EngineError),
    #[error("update operation failed: {0}")]
    Updater(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDto {
    pub code: &'static str,
    pub message: String,
}

impl From<AppError> for ErrorDto {
    fn from(error: AppError) -> Self {
        let message = match &error {
            AppError::Updater(_) => "update operation failed".into(),
            _ => error.to_string(),
        };
        let code = match error {
            AppError::InvalidArgument(_) => "invalidArgument",
            AppError::Unavailable(_) => "unavailable",
            AppError::StateUnavailable => "stateUnavailable",
            AppError::Window(_) => "windowError",
            AppError::Io(_) => "ioError",
            AppError::Serialization(_) => "serializationError",
            AppError::Database(_) => "databaseError",
            AppError::Credential(_) => "credentialError",
            AppError::Engine(_) => "engineError",
            AppError::Updater(_) => "updaterError",
        };
        Self { code, message }
    }
}

pub type CommandResult<T> = Result<T, ErrorDto>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_dto_maps_every_variant_to_a_code() {
        for error in [
            AppError::InvalidArgument("x".into()),
            AppError::Unavailable("x".into()),
            AppError::StateUnavailable,
            AppError::Window("x".into()),
            AppError::Io(std::io::Error::other("x")),
            AppError::Serialization(serde_json::Error::io(std::io::Error::other("x"))),
            AppError::Database(rusqlite::Error::InvalidQuery),
            AppError::Credential("x"),
            AppError::Engine(hyperplayer_engine::EngineError::InvalidInput("x".into())),
            AppError::Updater("x".into()),
        ] {
            let dto = ErrorDto::from(error);
            assert!(!dto.code.is_empty());
            assert!(!dto.message.is_empty());
        }
    }
}
