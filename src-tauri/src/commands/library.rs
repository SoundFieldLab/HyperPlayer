use crate::events;
use crate::{
    dto::{
        EntityPageDto, LibraryAlbumDto, LibraryArtistDto, LibraryArtworkDto,
        LibraryArtworkRequestDto, LibraryEntityTracksRequestDto, LibraryFolderDto,
        LibraryLocationDto, LibraryLocationSelectionDto, LibraryMutationResultDto,
        LibraryOverviewDto, LibraryPageDto, LibraryPlaylistDto, LibraryQueryDto, LibraryRecentDto,
        LibraryScanRequestDto, LibraryTrackRequestDto, PageRequestDto,
        RegisterLibraryLocationRequestDto, TaskAcceptedDto,
    },
    error::{AppError, CommandResult},
    ports::AppState,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn require_main(window: &WebviewWindow) -> Result<&str, crate::error::ErrorDto> {
    if window.label() != "main" {
        return Err(
            AppError::Unavailable("command is restricted to the main window".into()).into(),
        );
    }
    Ok(window.label())
}

#[tauri::command]
pub fn library_overview(state: State<'_, AppState>) -> CommandResult<LibraryOverviewDto> {
    super::command(state.services.library.overview())
}

#[tauri::command]
pub fn library_query_tracks(
    state: State<'_, AppState>,
    request: LibraryQueryDto,
) -> CommandResult<LibraryPageDto> {
    super::command(state.services.library.query_tracks(request))
}

#[tauri::command]
pub fn library_query_albums(
    state: State<'_, AppState>,
    request: LibraryQueryDto,
) -> CommandResult<EntityPageDto<LibraryAlbumDto>> {
    super::command(state.services.library.query_albums(request))
}

#[tauri::command]
pub fn library_query_artists(
    state: State<'_, AppState>,
    request: LibraryQueryDto,
) -> CommandResult<EntityPageDto<LibraryArtistDto>> {
    super::command(state.services.library.query_artists(request))
}

#[tauri::command]
pub fn library_query_folders(
    state: State<'_, AppState>,
    request: LibraryQueryDto,
) -> CommandResult<EntityPageDto<LibraryFolderDto>> {
    super::command(state.services.library.query_folders(request))
}

#[tauri::command]
pub fn library_query_recent(
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<EntityPageDto<LibraryRecentDto>> {
    super::command(state.services.library.query_recent(page))
}

#[tauri::command]
pub fn library_query_playlists(
    state: State<'_, AppState>,
    request: LibraryQueryDto,
) -> CommandResult<EntityPageDto<LibraryPlaylistDto>> {
    super::command(state.services.library.query_playlists(request))
}

#[tauri::command]
pub fn library_album_tracks(
    state: State<'_, AppState>,
    request: LibraryEntityTracksRequestDto,
) -> CommandResult<LibraryPageDto> {
    super::command(state.services.library.album_tracks(request))
}

#[tauri::command]
pub fn library_artist_tracks(
    state: State<'_, AppState>,
    request: LibraryEntityTracksRequestDto,
) -> CommandResult<LibraryPageDto> {
    super::command(state.services.library.artist_tracks(request))
}

#[tauri::command]
pub fn library_folder_tracks(
    state: State<'_, AppState>,
    request: LibraryEntityTracksRequestDto,
) -> CommandResult<LibraryPageDto> {
    super::command(state.services.library.folder_tracks(request))
}

#[tauri::command]
pub fn library_playlist_tracks(
    state: State<'_, AppState>,
    request: LibraryEntityTracksRequestDto,
) -> CommandResult<LibraryPageDto> {
    super::command(state.services.library.playlist_tracks(request))
}

#[tauri::command]
pub fn library_artwork(
    state: State<'_, AppState>,
    request: LibraryArtworkRequestDto,
) -> CommandResult<LibraryArtworkDto> {
    super::command(state.services.library.artwork(&request.content_hash))
}

#[tauri::command]
pub fn library_reread_tags(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: LibraryTrackRequestDto,
) -> CommandResult<crate::dto::TrackDto> {
    require_main(&window)?;
    super::command(state.services.library.reread_tags(&request.track_id))
}

#[tauri::command]
pub fn library_remove_from_library(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: LibraryTrackRequestDto,
) -> CommandResult<LibraryMutationResultDto> {
    require_main(&window)?;
    super::command(
        state
            .services
            .library
            .remove_from_library(&request.track_id),
    )
}

#[tauri::command]
pub fn library_move_to_recycle_bin(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: LibraryTrackRequestDto,
) -> CommandResult<LibraryMutationResultDto> {
    require_main(&window)?;
    super::command(
        state
            .services
            .library
            .move_to_recycle_bin(&request.track_id),
    )
}

#[tauri::command]
pub async fn library_pick_location(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<LibraryLocationSelectionDto> {
    let window_label = require_main(&window)?;
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(LibraryLocationSelectionDto {
            selection_ticket: None,
            selected: false,
        });
    };
    let path = selected.into_path().map_err(|_| {
        crate::error::ErrorDto::from(AppError::InvalidArgument(
            "selected location is not a local filesystem path".into(),
        ))
    })?;
    let selection_ticket = super::command(state.issue_location_ticket(window_label, path))?;
    Ok(LibraryLocationSelectionDto {
        selection_ticket: Some(selection_ticket),
        selected: true,
    })
}

#[tauri::command]
pub fn library_register_location(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: RegisterLibraryLocationRequestDto,
) -> CommandResult<LibraryLocationDto> {
    let window_label = require_main(&window)?;
    let path =
        super::command(state.consume_location_ticket(window_label, &request.selection_ticket))?;
    super::command(state.services.library.register_location(&path))
}

#[tauri::command]
pub fn library_start_scan(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    request: LibraryScanRequestDto,
) -> CommandResult<TaskAcceptedDto> {
    require_main(&window)?;
    let progress_app = app.clone();
    let progress = Arc::new(move |payload| {
        let _ = progress_app.emit(events::LIBRARY_SCAN_PROGRESS, payload);
    });
    super::command(state.services.library.start_scan(request, progress))
}

#[tauri::command]
pub fn library_cancel_scan(
    window: WebviewWindow,
    state: State<'_, AppState>,
    task_id: String,
) -> CommandResult<()> {
    require_main(&window)?;
    super::command(state.services.library.cancel_scan(&task_id))
}
