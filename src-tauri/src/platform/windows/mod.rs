use crate::{
    dto::{FileAssociationRequestDto, IntegrationCapabilityDto, WindowsIntegrationStatusDto},
    error::{AppError, CommandResult},
    events,
    ports::AppState,
};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

fn require_main(window: &WebviewWindow) -> CommandResult<()> {
    if window.label() != "main" {
        return Err(
            AppError::Unavailable("command is restricted to the main window".into()).into(),
        );
    }
    Ok(())
}

const SMTC_NOT_INITIALIZED: &str =
    "SMTC is not initialized; call windows_enable_media_controls from the main window";
const FILE_ASSOCIATIONS_UNAVAILABLE: &str =
    "file associations are not declared in the signed installer configuration";

#[cfg(windows)]
struct SmtcRegistration {
    controls: windows::Media::SystemMediaTransportControls,
    button_token: i64,
}

#[cfg(windows)]
impl Drop for SmtcRegistration {
    fn drop(&mut self) {
        let _ = self.controls.RemoveButtonPressed(self.button_token);
        let _ = self.controls.SetIsEnabled(false);
    }
}

#[cfg(windows)]
fn smtc_registration() -> &'static Mutex<Option<SmtcRegistration>> {
    static REGISTRATION: OnceLock<Mutex<Option<SmtcRegistration>>> = OnceLock::new();
    REGISTRATION.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn windows_integration_status() -> WindowsIntegrationStatusDto {
    #[cfg(windows)]
    let initialized = smtc_registration()
        .lock()
        .map(|registration| registration.is_some())
        .unwrap_or(false);
    #[cfg(not(windows))]
    let initialized = false;

    let media_capability = if initialized {
        available()
    } else {
        unavailable(SMTC_NOT_INITIALIZED)
    };
    WindowsIntegrationStatusDto {
        platform: std::env::consts::OS.into(),
        smtc: media_capability.clone(),
        media_keys: media_capability,
        file_associations: unavailable(FILE_ASSOCIATIONS_UNAVAILABLE),
    }
}

#[tauri::command]
pub fn windows_enable_media_controls(window: WebviewWindow, app: AppHandle) -> CommandResult<()> {
    require_main(&window)?;
    enable_media_controls(app).map_err(Into::into)
}

#[cfg(windows)]
fn enable_media_controls(app: AppHandle) -> Result<(), AppError> {
    use windows::{
        Foundation::TypedEventHandler,
        Media::{SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs},
    };

    let mut registration = smtc_registration()
        .lock()
        .map_err(|_| AppError::StateUnavailable)?;
    if registration.is_some() {
        return Ok(());
    }

    let controls = SystemMediaTransportControls::GetForCurrentView()
        .map_err(|error| smtc_unavailable("get controls for current view", error))?;
    controls
        .SetIsPlayEnabled(true)
        .and_then(|_| controls.SetIsPauseEnabled(true))
        .and_then(|_| controls.SetIsStopEnabled(true))
        .and_then(|_| controls.SetIsPreviousEnabled(true))
        .and_then(|_| controls.SetIsNextEnabled(true))
        .map_err(|error| smtc_unavailable("enable transport buttons", error))?;

    let handler = TypedEventHandler::<
        SystemMediaTransportControls,
        SystemMediaTransportControlsButtonPressedEventArgs,
    >::new(move |_, args| {
        if let Some(args) = args.as_ref() {
            if let Ok(button) = args.Button() {
                handle_media_button(&app, button);
            }
        }
        Ok(())
    });
    let button_token = controls
        .ButtonPressed(&handler)
        .map_err(|error| smtc_unavailable("register media button handler", error))?;
    if let Err(error) = controls.SetIsEnabled(true) {
        let _ = controls.RemoveButtonPressed(button_token);
        return Err(smtc_unavailable("enable controls", error));
    }
    *registration = Some(SmtcRegistration {
        controls,
        button_token,
    });
    Ok(())
}

#[cfg(windows)]
fn smtc_unavailable(operation: &str, error: windows::core::Error) -> AppError {
    AppError::Unavailable(format!("SMTC could not {operation}: {error}"))
}

#[cfg(windows)]
fn handle_media_button(
    app: &AppHandle,
    button: windows::Media::SystemMediaTransportControlsButton,
) {
    use windows::Media::SystemMediaTransportControlsButton as Button;

    let state = app.state::<AppState>();
    let result = if button == Button::Play {
        state.services.playback.play_resolved(None)
    } else if button == Button::Pause {
        state.services.playback.pause()
    } else if button == Button::Stop {
        state.services.playback.stop()
    } else if button == Button::Next {
        state.services.playback.next()
    } else if button == Button::Previous {
        state.services.playback.previous()
    } else {
        return;
    };
    if let Ok(snapshot) = result {
        let _ = app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot);
        let _ = app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback);
        let _ = app.emit(events::QUEUE_CHANGED, &snapshot.queue);
    }
}

#[cfg(not(windows))]
fn enable_media_controls(_app: AppHandle) -> Result<(), AppError> {
    Err(AppError::Unavailable(platform_reason(
        "SMTC and media keys require Windows",
    )))
}

#[tauri::command]
pub fn windows_register_file_associations(
    window: WebviewWindow,
    request: FileAssociationRequestDto,
) -> CommandResult<()> {
    require_main(&window)?;
    validate_extensions(&request.extensions).map_err(crate::error::ErrorDto::from)?;
    Err(AppError::Unavailable(platform_reason(FILE_ASSOCIATIONS_UNAVAILABLE)).into())
}

fn available() -> IntegrationCapabilityDto {
    IntegrationCapabilityDto {
        available: true,
        reason: None,
    }
}

fn unavailable(reason: &str) -> IntegrationCapabilityDto {
    IntegrationCapabilityDto {
        available: false,
        reason: Some(platform_reason(reason)),
    }
}

fn platform_reason(reason: &str) -> String {
    if cfg!(windows) {
        reason.into()
    } else {
        format!(
            "Windows integration is unavailable on {}",
            std::env::consts::OS
        )
    }
}

fn validate_extensions(extensions: &[String]) -> Result<(), AppError> {
    if extensions.is_empty() {
        return Err(AppError::InvalidArgument(
            "at least one file extension is required".into(),
        ));
    }
    for extension in extensions {
        let extension = extension.trim();
        if extension.len() < 2
            || extension.len() > 16
            || !extension.starts_with('.')
            || !extension[1..]
                .chars()
                .all(|value| value.is_ascii_alphanumeric())
        {
            return Err(AppError::InvalidArgument(format!(
                "invalid file extension: {extension}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_extensions_are_strictly_validated() {
        assert!(validate_extensions(&[".mp3".into(), ".flac".into()]).is_ok());
        assert!(validate_extensions(&[]).is_err());
        assert!(validate_extensions(&["mp3".into()]).is_err());
        assert!(validate_extensions(&[".mp3 & calc.exe".into()]).is_err());
    }

    #[test]
    fn unavailable_capabilities_always_include_a_reason() {
        let status = windows_integration_status();
        assert!(!status.file_associations.available);
        assert!(status.file_associations.reason.is_some());
        if !status.smtc.available {
            assert!(status.smtc.reason.is_some());
            assert!(!status.media_keys.available);
        }
    }

    #[test]
    fn available_capability_never_carries_a_failure_reason() {
        assert_eq!(
            available(),
            IntegrationCapabilityDto {
                available: true,
                reason: None
            }
        );
    }
}
