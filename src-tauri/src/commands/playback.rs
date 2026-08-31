use crate::{
    dto::{
        EngineSnapshotDto, PlayTrackRequestDto, PlaybackStateDto, RepeatModeDto, SeekRequestDto,
        SetVolumeRequestDto,
    },
    error::CommandResult,
    events,
    ports::AppState,
};
use tauri::{AppHandle, Emitter, State};

fn emit(app: &AppHandle, snapshot: EngineSnapshotDto) -> CommandResult<PlaybackStateDto> {
    app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    app.emit(events::QUEUE_CHANGED, &snapshot.queue)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    Ok(snapshot.playback)
}

#[tauri::command]
pub fn playback_get_state(state: State<'_, AppState>) -> CommandResult<PlaybackStateDto> {
    super::command(state.services.playback.state())
}

#[tauri::command]
pub async fn playback_play(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Option<PlayTrackRequestDto>,
) -> CommandResult<PlaybackStateDto> {
    let track = match request {
        Some(request) => Some(super::command(
            state.services.tracks.resolve(&request.track).await,
        )?),
        None => None,
    };
    let snapshot = super::command(state.services.playback.play_resolved(track))?;
    emit(&app, snapshot)
}

#[tauri::command]
pub fn playback_pause(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<PlaybackStateDto> {
    emit(&app, super::command(state.services.playback.pause())?)
}

#[tauri::command]
pub fn playback_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<PlaybackStateDto> {
    emit(&app, super::command(state.services.playback.stop())?)
}

#[tauri::command]
pub fn playback_next(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<PlaybackStateDto> {
    emit(&app, super::command(state.services.playback.next())?)
}

#[tauri::command]
pub fn playback_previous(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<PlaybackStateDto> {
    emit(&app, super::command(state.services.playback.previous())?)
}

#[tauri::command]
pub fn playback_seek(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SeekRequestDto,
) -> CommandResult<PlaybackStateDto> {
    emit(
        &app,
        super::command(state.services.playback.seek(request.position_ms))?,
    )
}

#[tauri::command]
pub fn playback_set_volume(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SetVolumeRequestDto,
) -> CommandResult<PlaybackStateDto> {
    emit(
        &app,
        super::command(state.services.playback.set_volume(request.volume))?,
    )
}

#[tauri::command]
pub fn playback_set_repeat_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: RepeatModeDto,
) -> CommandResult<PlaybackStateDto> {
    emit(
        &app,
        super::command(state.services.playback.set_repeat_mode(mode))?,
    )
}
