use crate::{
    dto::{
        EngineSnapshotDto, EnqueueRequestDto, QueueItemRequestDto, QueueSnapshotDto,
        ReorderQueueRequestDto,
    },
    error::CommandResult,
    events,
    ports::AppState,
};
use tauri::{AppHandle, Emitter, State};

fn emit(app: &AppHandle, snapshot: EngineSnapshotDto) -> CommandResult<QueueSnapshotDto> {
    app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    app.emit(events::QUEUE_CHANGED, &snapshot.queue)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    Ok(snapshot.queue)
}

#[tauri::command]
pub fn queue_get(state: State<'_, AppState>) -> CommandResult<QueueSnapshotDto> {
    super::command(state.services.queue.snapshot())
}

#[tauri::command]
pub async fn queue_enqueue(
    app: AppHandle,
    state: State<'_, AppState>,
    request: EnqueueRequestDto,
) -> CommandResult<QueueSnapshotDto> {
    let track = super::command(state.services.tracks.resolve(&request.track).await)?;
    emit(
        &app,
        super::command(
            state
                .services
                .queue
                .enqueue_resolved(track, request.position),
        )?,
    )
}

#[tauri::command]
pub fn queue_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    request: QueueItemRequestDto,
) -> CommandResult<QueueSnapshotDto> {
    emit(
        &app,
        super::command(state.services.queue.remove(&request.queue_item_id))?,
    )
}

#[tauri::command]
pub fn queue_reorder(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReorderQueueRequestDto,
) -> CommandResult<QueueSnapshotDto> {
    emit(&app, super::command(state.services.queue.reorder(request))?)
}

#[tauri::command]
pub fn queue_clear_play_next(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<QueueSnapshotDto> {
    emit(
        &app,
        super::command(state.services.queue.clear_play_next())?,
    )
}

#[tauri::command]
pub fn queue_clear_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<QueueSnapshotDto> {
    emit(&app, super::command(state.services.queue.clear_all())?)
}
