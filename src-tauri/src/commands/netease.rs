use crate::{
    dto::{
        NeteaseAccountDto, NeteaseAlbumDetailDto, NeteaseCloudPageDto, NeteaseCommentsRequestDto,
        NeteaseCommitMutationRequestDto, NeteaseCursorRequestDto, NeteaseDjPageDto,
        NeteaseDjProgramsRequestDto, NeteaseEventPageDto, NeteaseFavoritesDto, NeteaseFmDto,
        NeteaseFollowsRequestDto, NeteaseHomeDto, NeteaseListenReportDto,
        NeteaseListenReportRequestDto, NeteaseListenStatsDto, NeteaseLoginPollRequestDto,
        NeteaseLoginStartDto, NeteaseLoginStateDto, NeteaseMutationConfirmationDto,
        NeteaseMutationResultDto, NeteaseMvDetailDto, NeteaseMvListRequestDto, NeteaseMvPageDto,
        NeteaseNewSongsRequestDto, NeteaseNoticePageDto, NeteasePlaylistDetailDto,
        NeteasePrepareMutationRequestDto, NeteaseResourceRequestDto, NeteaseSearchPageDto,
        NeteaseSearchRequestDto, NeteaseStatusDto, NeteaseTracksDto, NeteaseUserEventsRequestDto,
        NeteaseUserPageDto, PageRequestDto,
    },
    error::CommandResult,
    events,
    ports::AppState,
};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

fn require_main(window: &WebviewWindow) -> Result<&str, crate::error::ErrorDto> {
    if window.label() != "main" {
        return Err(crate::error::AppError::Unavailable(
            "command is restricted to the main window".into(),
        )
        .into());
    }
    Ok(window.label())
}

#[cfg(test)]
pub const NETEASE_COMMAND_NAMES: &[&str] = &[
    "netease_status",
    "netease_search",
    "netease_mvs",
    "netease_mv_detail",
    "netease_dj_radios",
    "netease_dj_programs",
    "netease_charts",
    "netease_new_songs",
    "netease_listen_total",
    "netease_listen_report",
    "netease_listen_song_rank",
    "netease_followed_events",
    "netease_user_events",
    "netease_notices",
    "netease_home",
    "netease_album_detail",
    "netease_playlist_detail",
    "netease_artist_detail",
    "netease_personal_fm",
    "netease_account",
    "netease_favorites",
    "netease_comments",
    "netease_follows",
    "netease_cloud",
    "netease_prepare_mutation",
    "netease_commit_mutation",
    "netease_start_qr_login",
    "netease_poll_qr_login",
    "netease_logout",
];

#[tauri::command]
pub fn netease_status(state: State<'_, AppState>) -> CommandResult<NeteaseStatusDto> {
    super::command(state.services.netease.status())
}

#[tauri::command]
pub async fn netease_search(
    state: State<'_, AppState>,
    request: NeteaseSearchRequestDto,
) -> CommandResult<NeteaseSearchPageDto> {
    super::command(state.services.netease.search(request).await)
}

#[tauri::command]
pub async fn netease_mvs(
    state: State<'_, AppState>,
    request: NeteaseMvListRequestDto,
) -> CommandResult<NeteaseMvPageDto> {
    super::command(state.services.netease.mvs(request).await)
}

#[tauri::command]
pub async fn netease_mv_detail(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseMvDetailDto> {
    super::command(state.services.netease.mv_detail(request.id).await)
}

#[tauri::command]
pub async fn netease_dj_radios(
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<NeteaseDjPageDto> {
    super::command(state.services.netease.dj_radios(page).await)
}

#[tauri::command]
pub async fn netease_dj_programs(
    state: State<'_, AppState>,
    request: NeteaseDjProgramsRequestDto,
) -> CommandResult<NeteaseDjPageDto> {
    super::command(state.services.netease.dj_programs(request).await)
}

#[tauri::command]
pub async fn netease_charts(
    state: State<'_, AppState>,
) -> CommandResult<Vec<crate::dto::NeteaseChartDto>> {
    super::command(state.services.netease.charts().await)
}

#[tauri::command]
pub async fn netease_new_songs(
    state: State<'_, AppState>,
    request: NeteaseNewSongsRequestDto,
) -> CommandResult<NeteaseTracksDto> {
    super::command(state.services.netease.new_songs(request.area_id).await)
}

#[tauri::command]
pub async fn netease_listen_total(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<NeteaseListenStatsDto> {
    require_main(&window)?;
    super::command(state.services.netease.listen_total().await)
}

#[tauri::command]
pub async fn netease_listen_report(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteaseListenReportRequestDto,
) -> CommandResult<NeteaseListenReportDto> {
    require_main(&window)?;
    super::command(state.services.netease.listen_report(request).await)
}

#[tauri::command]
pub async fn netease_listen_song_rank(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteaseListenReportRequestDto,
) -> CommandResult<NeteaseTracksDto> {
    require_main(&window)?;
    super::command(state.services.netease.listen_song_rank(request).await)
}

#[tauri::command]
pub async fn netease_followed_events(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteaseCursorRequestDto,
) -> CommandResult<NeteaseEventPageDto> {
    require_main(&window)?;
    super::command(state.services.netease.followed_events(request).await)
}

#[tauri::command]
pub async fn netease_user_events(
    state: State<'_, AppState>,
    request: NeteaseUserEventsRequestDto,
) -> CommandResult<NeteaseEventPageDto> {
    super::command(state.services.netease.user_events(request).await)
}

#[tauri::command]
pub async fn netease_notices(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteaseCursorRequestDto,
) -> CommandResult<NeteaseNoticePageDto> {
    require_main(&window)?;
    super::command(state.services.netease.notices(request).await)
}

#[tauri::command]
pub async fn netease_home(state: State<'_, AppState>) -> CommandResult<NeteaseHomeDto> {
    super::command(state.services.netease.home().await)
}

#[tauri::command]
pub async fn netease_album_detail(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseAlbumDetailDto> {
    super::command(state.services.netease.album_detail(request.id).await)
}

#[tauri::command]
pub async fn netease_playlist_detail(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteasePlaylistDetailDto> {
    super::command(state.services.netease.playlist_detail(request.id).await)
}

#[tauri::command]
pub async fn netease_artist_detail(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<crate::dto::NeteaseArtistDetailDto> {
    super::command(state.services.netease.artist_detail(request.id).await)
}

#[tauri::command]
pub async fn netease_personal_fm(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<NeteaseFmDto> {
    require_main(&window)?;
    super::command(state.services.netease.personal_fm().await)
}

#[tauri::command]
pub async fn netease_account(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<NeteaseAccountDto> {
    require_main(&window)?;
    super::command(state.services.netease.account().await)
}

#[tauri::command]
pub async fn netease_favorites(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<NeteaseFavoritesDto> {
    require_main(&window)?;
    super::command(state.services.netease.favorites().await)
}

#[tauri::command]
pub async fn netease_comments(
    state: State<'_, AppState>,
    request: NeteaseCommentsRequestDto,
) -> CommandResult<crate::dto::NeteaseCommentPageDto> {
    super::command(state.services.netease.comments(request).await)
}

#[tauri::command]
pub async fn netease_follows(
    state: State<'_, AppState>,
    request: NeteaseFollowsRequestDto,
) -> CommandResult<NeteaseUserPageDto> {
    super::command(state.services.netease.follows(request).await)
}

#[tauri::command]
pub async fn netease_cloud(
    window: WebviewWindow,
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<NeteaseCloudPageDto> {
    require_main(&window)?;
    super::command(state.services.netease.cloud(page).await)
}

#[tauri::command]
pub fn netease_prepare_mutation(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteasePrepareMutationRequestDto,
) -> CommandResult<NeteaseMutationConfirmationDto> {
    let label = require_main(&window)?;
    super::command(state.services.netease.prepare_mutation(label, request))
}

#[tauri::command]
pub async fn netease_commit_mutation(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteaseCommitMutationRequestDto,
) -> CommandResult<NeteaseMutationResultDto> {
    let label = require_main(&window)?;
    super::command(state.services.netease.commit_mutation(label, request).await)
}

#[tauri::command]
pub async fn netease_start_qr_login(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<NeteaseLoginStartDto> {
    require_main(&window)?;
    super::command(state.services.netease.start_qr_login().await)
}

#[tauri::command]
pub async fn netease_poll_qr_login(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteaseLoginPollRequestDto,
) -> CommandResult<NeteaseLoginStateDto> {
    require_main(&window)?;
    super::command(
        state
            .services
            .netease
            .poll_qr_login(&request.login_id)
            .await,
    )
}

#[tauri::command]
pub async fn netease_logout(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<NeteaseStatusDto> {
    require_main(&window)?;
    let status = super::command(state.services.netease.logout().await)?;
    app.emit(events::NETEASE_STATUS_CHANGED, &status)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    Ok(status)
}
