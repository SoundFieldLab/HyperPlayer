use crate::{
    dto::{UpdateCheckDto, UpdaterStatusDto},
    error::{AppError, CommandResult},
};
use std::time::Duration;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

#[derive(Clone, Debug)]
pub struct UpdaterConfig {
    public_key: Option<String>,
    endpoint: Option<Url>,
    endpoint_error: Option<String>,
}

impl UpdaterConfig {
    pub fn from_env() -> Self {
        Self::from_values(
            option_env!("HYPERPLAYER_UPDATER_PUBLIC_KEY"),
            option_env!("HYPERPLAYER_UPDATER_ENDPOINT"),
        )
    }

    fn from_values(public_key: Option<&str>, endpoint: Option<&str>) -> Self {
        let public_key = public_key.map(str::trim).filter(|value| !value.is_empty());
        let endpoint = endpoint.map(str::trim).filter(|value| !value.is_empty());
        let parsed_endpoint = endpoint.and_then(|value| Url::parse(value).ok());
        let endpoint_error = if endpoint.is_none() {
            Some("updater endpoint is not configured".into())
        } else if parsed_endpoint
            .as_ref()
            .is_none_or(|value| value.scheme() != "https")
        {
            Some("updater endpoint must be a valid HTTPS URL".into())
        } else {
            None
        };
        Self {
            public_key: public_key.map(str::to_owned),
            endpoint: parsed_endpoint,
            endpoint_error,
        }
    }

    pub fn public_key(&self) -> Option<String> {
        self.enabled().then(|| self.public_key.clone()).flatten()
    }

    fn disabled_reason(&self) -> Option<String> {
        if self.public_key.is_none() {
            Some("updater is disabled: signing public key is not configured".into())
        } else {
            self.endpoint_error
                .as_ref()
                .map(|reason| format!("updater is disabled: {reason}"))
        }
    }

    fn enabled(&self) -> bool {
        self.disabled_reason().is_none() && self.endpoint.is_some()
    }

    fn status(&self) -> UpdaterStatusDto {
        UpdaterStatusDto {
            enabled: self.enabled(),
            reason: self.disabled_reason(),
        }
    }

    fn require_endpoint(&self) -> Result<Url, AppError> {
        if let Some(reason) = self.disabled_reason() {
            return Err(AppError::Unavailable(reason));
        }
        self.endpoint
            .clone()
            .ok_or_else(|| AppError::Unavailable("updater is disabled".into()))
    }
}

#[tauri::command]
pub fn updater_status(config: State<'_, UpdaterConfig>) -> UpdaterStatusDto {
    config.status()
}

#[tauri::command]
pub async fn updater_check(
    window: WebviewWindow,
    app: AppHandle,
    config: State<'_, UpdaterConfig>,
) -> CommandResult<UpdateCheckDto> {
    if window.label() != "main" {
        return Err(
            AppError::Unavailable("command is restricted to the main window".into()).into(),
        );
    }
    let endpoint = config
        .require_endpoint()
        .map_err(crate::error::ErrorDto::from)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| AppError::Updater(error.to_string()))?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| AppError::Updater(error.to_string()))?;
    let current_version = app.package_info().version.to_string();
    let update = updater
        .check()
        .await
        .map_err(|error| AppError::Updater(error.to_string()))?;
    Ok(match update {
        Some(update) => UpdateCheckDto {
            available: true,
            version: Some(update.version),
            current_version,
            notes: update.body,
        },
        None => UpdateCheckDto {
            available: false,
            version: None,
            current_version,
            notes: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_is_disabled_without_signing_configuration() {
        let config = UpdaterConfig::from_values(None, None);
        assert!(!config.status().enabled);
        assert!(config.status().reason.unwrap().contains("disabled"));
        assert!(matches!(
            config.require_endpoint(),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn updater_is_disabled_without_a_valid_https_endpoint() {
        let missing = UpdaterConfig::from_values(Some("public-key"), None);
        assert!(!missing.status().enabled);
        assert!(missing.public_key().is_none());
        assert!(matches!(
            missing.require_endpoint(),
            Err(AppError::Unavailable(_))
        ));

        let insecure = UpdaterConfig::from_values(Some("public-key"), Some("http://example.test"));
        assert!(!insecure.status().enabled);
        assert!(matches!(
            insecure.require_endpoint(),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn updater_is_enabled_only_with_signing_key_and_https_endpoint() {
        let configured = UpdaterConfig::from_values(
            Some("public-key"),
            Some("https://example.test/latest.json"),
        );
        assert!(configured.status().enabled);
        assert!(configured.status().reason.is_none());
        assert!(configured.public_key().is_some());
        assert!(configured.require_endpoint().is_ok());
    }
}
