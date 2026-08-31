use crate::{
    dto::{SettingsDto, UpdateSettingsRequestDto},
    error::CommandResult,
    events,
    ports::AppState,
};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> CommandResult<SettingsDto> {
    super::command(state.services.settings.get())
}

#[tauri::command]
pub fn settings_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    request: UpdateSettingsRequestDto,
) -> CommandResult<SettingsDto> {
    if window.label() != "main" {
        return Err(crate::error::AppError::Unavailable(
            "command is restricted to the main window".into(),
        )
        .into());
    }
    let settings = super::command(state.services.settings.update(request))?;
    app.emit(events::SETTINGS_CHANGED, &settings)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    Ok(settings)
}
