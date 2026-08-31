use crate::{
    dto::{CacheStatsDto, CacheStatusDto, CacheTrackRequestDto, TaskAcceptedDto, TrackRefDto},
    error::CommandResult,
    ports::AppState,
};
use tauri::{State, WebviewWindow};

fn require_main(window: &WebviewWindow) -> Result<(), crate::error::ErrorDto> {
    if window.label() != "main" {
        return Err(crate::error::AppError::Unavailable(
            "command is restricted to the main window".into(),
        )
        .into());
    }
    Ok(())
}

#[tauri::command]
pub fn cache_stats(state: State<'_, AppState>) -> CommandResult<CacheStatsDto> {
    super::command(state.services.cache.stats())
}

#[tauri::command]
pub fn cache_status(
    state: State<'_, AppState>,
    track: TrackRefDto,
) -> CommandResult<CacheStatusDto> {
    super::command(state.services.cache.status(&track))
}

#[tauri::command]
pub async fn cache_track(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CacheTrackRequestDto,
) -> CommandResult<TaskAcceptedDto> {
    require_main(&window)?;
    super::command(state.services.cache.cache_track(request).await)
}

#[tauri::command]
pub fn cache_remove(
    window: WebviewWindow,
    state: State<'_, AppState>,
    track: TrackRefDto,
) -> CommandResult<()> {
    require_main(&window)?;
    super::command(state.services.cache.remove(&track))
}

#[tauri::command]
pub fn cache_clear(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<TaskAcceptedDto> {
    require_main(&window)?;
    super::command(state.services.cache.clear())
}
