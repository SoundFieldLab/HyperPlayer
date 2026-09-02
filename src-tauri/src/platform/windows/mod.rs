pub mod resource_probe;

use crate::{
    dto::{FileAssociationRequestDto, IntegrationCapabilityDto, WindowsIntegrationStatusDto},
    error::{AppError, CommandResult},
    events,
    ports::{AppState, PlaybackTransition},
};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};
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

pub(crate) fn move_file_to_recycle_bin(path: &Path) -> Result<(), AppError> {
    validate_recycle_bin_file(path)?;
    move_validated_file_to_recycle_bin(path)
}

fn validate_recycle_bin_file(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(AppError::InvalidArgument(
            "Recycle Bin path must be absolute".into(),
        ));
    }

    let metadata = std::fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::InvalidArgument("Recycle Bin path does not exist".into())
        } else {
            AppError::Io(error)
        }
    })?;
    if !metadata.is_file() {
        return Err(AppError::InvalidArgument(
            "Recycle Bin path must identify a file".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn move_validated_file_to_recycle_bin(path: &Path) -> Result<(), AppError> {
    use windows::{
        core::{GUID, PCWSTR},
        Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::Shell::{
                IFileOperation, IShellItem, SHCreateItemFromParsingName, FOFX_RECYCLEONDELETE,
                FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
            },
        },
    };

    const CLSID_FILE_OPERATION: GUID = GUID::from_u128(0x3ad05575_8857_4850_9277_11b85bdb8e09);

    struct ComInitialization(bool);
    impl Drop for ComInitialization {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: this balances the successful CoInitializeEx call on this thread.
                unsafe { CoUninitialize() };
            }
        }
    }

    // SAFETY: COM is initialized for this thread and balanced by `ComInitialization`.
    // RPC_E_CHANGED_MODE means the caller already initialized a different apartment,
    // in which case COM remains usable and must not be uninitialized here.
    let initialized =
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
        return Err(recycle_bin_unavailable(
            "initialize COM",
            initialized.into(),
        ));
    }
    let _com = ComInitialization(initialized.is_ok());

    let path_list = recycle_bin_path_list(path)?;
    // SAFETY: the path buffer remains live and NUL-terminated for this call.
    let item: IShellItem = unsafe {
        SHCreateItemFromParsingName(PCWSTR(path_list.as_ptr()), None)
            .map_err(|error| recycle_bin_unavailable("resolve the file", error))?
    };
    // SAFETY: CLSID_FILE_OPERATION identifies the in-process FileOperation COM class.
    let operation: IFileOperation = unsafe {
        CoCreateInstance(&CLSID_FILE_OPERATION, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| recycle_bin_unavailable("create the file operation", error))?
    };
    let flags = FOFX_RECYCLEONDELETE | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
    // SAFETY: all COM interfaces are valid for the current initialized apartment.
    unsafe {
        operation
            .SetOperationFlags(flags)
            .and_then(|_| operation.DeleteItem(&item, None))
            .and_then(|_| operation.PerformOperations())
            .map_err(|error| recycle_bin_unavailable("move the file", error))?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|error| recycle_bin_unavailable("read the operation result", error))?
            .as_bool()
        {
            return Err(AppError::Unavailable(
                "the Recycle Bin operation was aborted; the file was not moved".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn recycle_bin_unavailable(operation: &str, error: windows::core::Error) -> AppError {
    AppError::Unavailable(format!(
        "could not {operation} for the Recycle Bin: {error}"
    ))
}

#[cfg(windows)]
fn recycle_bin_path_list(path: &Path) -> Result<Vec<u16>, AppError> {
    use std::os::windows::ffi::OsStrExt;

    let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    if encoded.contains(&0) {
        return Err(AppError::InvalidArgument(
            "Recycle Bin path contains a NUL character".into(),
        ));
    }
    encoded.extend_from_slice(&[0, 0]);
    Ok(encoded)
}

#[cfg(not(windows))]
fn move_validated_file_to_recycle_bin(_path: &Path) -> Result<(), AppError> {
    Err(AppError::Unavailable(platform_reason(
        "the Recycle Bin requires Windows",
    )))
}

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
        tauri::async_runtime::block_on(crate::commands::playback::resume_resolved(
            state.services.playback.as_ref(),
            state.services.tracks.as_ref(),
        ))
    } else if button == Button::Pause {
        state.services.playback.pause()
    } else if button == Button::Stop {
        state.services.playback.stop()
    } else if button == Button::Next {
        tauri::async_runtime::block_on(crate::commands::playback::transition_resolved(
            state.services.playback.as_ref(),
            state.services.tracks.as_ref(),
            PlaybackTransition::Next { automatic: false },
        ))
    } else if button == Button::Previous {
        tauri::async_runtime::block_on(crate::commands::playback::transition_resolved(
            state.services.playback.as_ref(),
            state.services.tracks.as_ref(),
            PlaybackTransition::Previous,
        ))
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

    #[test]
    fn recycle_bin_validation_rejects_relative_paths() {
        let error = validate_recycle_bin_file(Path::new("track.flac")).unwrap_err();
        assert!(matches!(error, AppError::InvalidArgument(_)));
    }

    #[test]
    fn recycle_bin_validation_rejects_missing_absolute_paths() {
        let directory = tempfile::tempdir().unwrap();
        let error = validate_recycle_bin_file(&directory.path().join("missing.flac")).unwrap_err();
        assert!(matches!(error, AppError::InvalidArgument(_)));
    }

    #[test]
    fn recycle_bin_validation_rejects_directories() {
        let directory = tempfile::tempdir().unwrap();
        let error = validate_recycle_bin_file(directory.path()).unwrap_err();
        assert!(matches!(error, AppError::InvalidArgument(_)));
    }

    #[test]
    fn recycle_bin_validation_accepts_existing_absolute_files() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(validate_recycle_bin_file(file.path()).is_ok());
        assert!(file.path().exists());
    }

    #[cfg(windows)]
    #[test]
    fn recycle_bin_path_list_is_utf16_with_exactly_two_trailing_nuls() {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};

        let expected = vec![
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            0xD83C,
            0xDFB5,
            b'.' as u16,
            b'f' as u16,
            b'l' as u16,
            b'a' as u16,
            b'c' as u16,
        ];
        let path = OsString::from_wide(&expected);
        let encoded = recycle_bin_path_list(Path::new(&path)).unwrap();

        assert_eq!(&encoded[..expected.len()], expected);
        assert_eq!(&encoded[expected.len()..], &[0, 0]);
        assert!(!expected.contains(&0));
    }

    #[cfg(windows)]
    #[test]
    fn recycle_bin_path_list_rejects_embedded_nuls() {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};

        let path = OsString::from_wide(&[
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            b'a' as u16,
            0,
            b'b' as u16,
        ]);
        let error = recycle_bin_path_list(Path::new(&path)).unwrap_err();
        assert!(matches!(error, AppError::InvalidArgument(_)));
    }
}
