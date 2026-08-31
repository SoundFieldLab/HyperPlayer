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
    #[error("NetEase operation failed: {0}")]
    Netease(#[from] hyperplayer_source_netease::Error),
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
            AppError::Netease(hyperplayer_source_netease::Error::Timeout) => {
                "NetEase operation failed: network request timed out".into()
            }
            AppError::Netease(
                hyperplayer_source_netease::Error::Transport(_)
                | hyperplayer_source_netease::Error::HttpStatus(_)
                | hyperplayer_source_netease::Error::Api { .. }
                | hyperplayer_source_netease::Error::InvalidResponse(_),
            ) => "NetEase operation failed: remote service request failed".into(),
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
            AppError::Netease(_) => "neteaseError",
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
    fn network_errors_do_not_expose_urls_or_credentials() {
        let secret = "https://user:password@example.test/media?token=secret";
        let dto = ErrorDto::from(AppError::Netease(
            hyperplayer_source_netease::Error::Transport(secret.into()),
        ));
        assert_eq!(dto.code, "neteaseError");
        assert!(!dto.message.contains("secret"));
        assert!(!dto.message.contains("password"));
        assert!(!dto.message.contains("example.test"));

        let dto = ErrorDto::from(AppError::Netease(hyperplayer_source_netease::Error::Api {
            code: 500,
            message: secret.into(),
        }));
        assert!(!dto.message.contains("secret"));
        assert!(!dto.message.contains("example.test"));

        let dto = ErrorDto::from(AppError::Updater(secret.into()));
        assert_eq!(dto.message, "update operation failed");
    }
}
