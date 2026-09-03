use crate::{
    dto::{
        NeteaseAccountDto, NeteaseAlbumCoversDto, NeteaseAlbumDetailDto, NeteaseArtistAlbumsDto,
        NeteaseArtistMvsDto, NeteaseBannerDto, NeteaseCloudPageDto, NeteaseCommentFloorDto,
        NeteaseCommentPageDto, NeteaseCommentsRequestDto, NeteaseCommitMutationRequestDto,
        NeteaseCursorRequestDto, NeteaseDjCategoriesDto, NeteaseDjPageDto,
        NeteaseDjProgramsRequestDto, NeteaseDjRecommendRequestDto, NeteaseEnrichedSongDto,
        NeteaseEventPageDto, NeteaseExploreNextDto, NeteaseExploreNextRequestDto,
        NeteaseFavoritesDto, NeteaseFmDto, NeteaseFollowsRequestDto, NeteaseHomeDto,
        NeteaseHotCommentsDto, NeteaseHotWordDto, NeteaseImageDto, NeteaseImageRequestDto,
        NeteaseJourneyOverviewDto, NeteaseLikedStateDto, NeteaseListenDataTodayDto,
        NeteaseListenReportDto, NeteaseListenReportRequestDto, NeteaseListenStatsDto,
        NeteaseLoginPollRequestDto, NeteaseLoginStartDto, NeteaseLoginStateDto,
        NeteaseLoginStatusDto, NeteaseMutationConfirmationDto, NeteaseMutationResultDto,
        NeteaseMvDetailDto, NeteaseMvListRequestDto, NeteaseMvPageDto, NeteaseNewSongsRequestDto,
        NeteaseNoticePageDto, NeteasePlaylistCategoryDto, NeteasePlaylistDetailDto,
        NeteasePlaylistPageDto, NeteasePrepareMutationRequestDto, NeteaseQualityOptionDto,
        NeteaseRecentPlaysDto, NeteaseRecentPlaysRequestDto, NeteaseResourceRequestDto,
        NeteaseScrobbleDto, NeteaseSearchPageDto, NeteaseSearchRequestDto,
        NeteaseSearchSuggestionsDto, NeteaseSimilarArtistsDto, NeteaseSongRelatedBlogsDto,
        NeteaseSongWikiDto, NeteaseStatusDto, NeteaseStylePreferenceDto, NeteaseSublistAlbumsDto,
        NeteaseSublistArtistsDto, NeteaseSublistMvsDto, NeteaseTracksDto,
        NeteaseUpdatePlaylistCoverRequestDto, NeteaseUserEventsRequestDto, NeteaseUserLevelDto,
        NeteaseUserPageDto, NeteaseUserSubcountDto, PageRequestDto,
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
    "netease_image",
    "netease_prepare_mutation",
    "netease_commit_mutation",
    "netease_start_qr_login",
    "netease_poll_qr_login",
    "netease_search_hot",
    "netease_search_suggest",
    "netease_banner",
    "netease_playlist_categories",
    "netease_high_quality_playlists",
    "netease_similar_playlists",
    "netease_artist_albums",
    "netease_artist_mvs",
    "netease_artist_sublist",
    "netease_album_sublist",
    "netease_mv_sublist",
    "netease_personalized_new_songs",
    "netease_dislike_recommend_song",
    "netease_check_songs_liked",
    "netease_hot_comments",
    "netease_comment_floor",
    "netease_msg_comments",
    "netease_user_followeds",
    "netease_user_level",
    "netease_user_subcount",
    "netease_style_preference",
    "netease_login_status",
    "netease_listen_data_today",
    "netease_journey_overview",
    "netease_recent_plays",
    "netease_similar_songs",
    "netease_song_quality_levels",
    "netease_dj_categories",
    "netease_dj_recommend",
    "netease_dj_program_toplist",
    "netease_dj_sublist",
    "netease_personalized_dj_radios",
    "netease_song_wiki",
    "netease_song_related_blogs",
    "netease_song_detail_enriched",
    "netease_playmode_intelligence_list",
    "netease_related_playlists",
    "netease_album_covers_batch",
    "netease_similar_artists",
    "netease_explore_next",
    "netease_update_playlist_cover",
    "netease_scrobble",
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
pub async fn netease_image(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: NeteaseImageRequestDto,
) -> CommandResult<NeteaseImageDto> {
    require_main(&window)?;
    super::command(state.services.netease.image(&request.url).await)
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
    let current_is_netease = state
        .services
        .playback
        .state()
        .ok()
        .and_then(|playback| playback.current_track)
        .is_some_and(|track| track.track_ref.source == crate::dto::TrackSourceDto::Netease);
    if current_is_netease {
        let snapshot = super::command(state.services.playback.stop())?;
        app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot)
            .and_then(|_| app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback))
            .and_then(|_| app.emit(events::QUEUE_CHANGED, &snapshot.queue))
            .map_err(|error| {
                crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
            })?;
    }
    app.emit(events::NETEASE_STATUS_CHANGED, &status)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    Ok(status)
}

// ---- Stage 16：发现/社交/用户能力 ----
#[tauri::command]
pub async fn netease_search_hot(
    state: State<'_, AppState>,
) -> CommandResult<Vec<NeteaseHotWordDto>> {
    super::command(state.services.netease.search_hot().await)
}

#[tauri::command]
pub async fn netease_search_suggest(
    state: State<'_, AppState>,
    request: NeteaseSearchRequestDto,
) -> CommandResult<NeteaseSearchSuggestionsDto> {
    super::command(state.services.netease.search_suggest(&request.query).await)
}

#[tauri::command]
pub async fn netease_banner(state: State<'_, AppState>) -> CommandResult<Vec<NeteaseBannerDto>> {
    super::command(state.services.netease.banner().await)
}

#[tauri::command]
pub async fn netease_playlist_categories(
    state: State<'_, AppState>,
) -> CommandResult<Vec<NeteasePlaylistCategoryDto>> {
    super::command(state.services.netease.playlist_categories().await)
}

#[tauri::command]
pub async fn netease_high_quality_playlists(
    state: State<'_, AppState>,
    request: NeteaseSearchRequestDto,
) -> CommandResult<NeteasePlaylistPageDto> {
    super::command(
        state
            .services
            .netease
            .high_quality_playlists(&request.query, request.page)
            .await,
    )
}

#[tauri::command]
pub async fn netease_similar_playlists(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteasePlaylistPageDto> {
    super::command(
        state
            .services
            .netease
            .similar_playlists(request.id, 30)
            .await,
    )
}

#[tauri::command]
pub async fn netease_artist_albums(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    page: PageRequestDto,
) -> CommandResult<NeteaseArtistAlbumsDto> {
    super::command(state.services.netease.artist_albums(request.id, page).await)
}

#[tauri::command]
pub async fn netease_artist_mvs(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    page: PageRequestDto,
) -> CommandResult<NeteaseArtistMvsDto> {
    super::command(state.services.netease.artist_mvs(request.id, page).await)
}

#[tauri::command]
pub async fn netease_artist_sublist(
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<NeteaseSublistArtistsDto> {
    super::command(state.services.netease.artist_sublist(page).await)
}

#[tauri::command]
pub async fn netease_album_sublist(
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<NeteaseSublistAlbumsDto> {
    super::command(state.services.netease.album_sublist(page).await)
}

#[tauri::command]
pub async fn netease_mv_sublist(
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<NeteaseSublistMvsDto> {
    super::command(state.services.netease.mv_sublist(page).await)
}

#[tauri::command]
pub async fn netease_personalized_new_songs(
    state: State<'_, AppState>,
) -> CommandResult<NeteaseTracksDto> {
    super::command(state.services.netease.personalized_new_songs(30).await)
}

#[tauri::command]
pub async fn netease_dislike_recommend_song(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseMutationResultDto> {
    super::command(
        state
            .services
            .netease
            .dislike_recommend_song(request.id)
            .await,
    )
}

#[tauri::command]
pub async fn netease_check_songs_liked(
    state: State<'_, AppState>,
    ids: Vec<u64>,
) -> CommandResult<Vec<NeteaseLikedStateDto>> {
    super::command(state.services.netease.check_songs_liked(ids).await)
}

#[tauri::command]
pub async fn netease_hot_comments(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    page: PageRequestDto,
) -> CommandResult<NeteaseHotCommentsDto> {
    super::command(state.services.netease.hot_comments(request, page).await)
}

#[tauri::command]
pub async fn netease_comment_floor(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    parent_comment_id: u64,
    page: PageRequestDto,
) -> CommandResult<NeteaseCommentFloorDto> {
    super::command(
        state
            .services
            .netease
            .comment_floor(request, parent_comment_id, page)
            .await,
    )
}

#[tauri::command]
pub async fn netease_msg_comments(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    page: PageRequestDto,
) -> CommandResult<NeteaseCommentPageDto> {
    super::command(state.services.netease.msg_comments(request.id, page).await)
}

#[tauri::command]
pub async fn netease_user_followeds(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    page: PageRequestDto,
) -> CommandResult<NeteaseUserPageDto> {
    super::command(
        state
            .services
            .netease
            .user_followeds(request.id, page)
            .await,
    )
}

#[tauri::command]
pub async fn netease_user_level(state: State<'_, AppState>) -> CommandResult<NeteaseUserLevelDto> {
    super::command(state.services.netease.user_level().await)
}

#[tauri::command]
pub async fn netease_user_subcount(
    state: State<'_, AppState>,
) -> CommandResult<NeteaseUserSubcountDto> {
    super::command(state.services.netease.user_subcount().await)
}

#[tauri::command]
pub async fn netease_style_preference(
    state: State<'_, AppState>,
) -> CommandResult<NeteaseStylePreferenceDto> {
    super::command(state.services.netease.style_preference().await)
}

#[tauri::command]
pub async fn netease_login_status(
    state: State<'_, AppState>,
) -> CommandResult<NeteaseLoginStatusDto> {
    super::command(state.services.netease.login_status().await)
}

#[tauri::command]
pub async fn netease_listen_data_today(
    state: State<'_, AppState>,
) -> CommandResult<NeteaseListenDataTodayDto> {
    super::command(state.services.netease.listen_data_today().await)
}

#[tauri::command]
pub async fn netease_journey_overview(
    state: State<'_, AppState>,
) -> CommandResult<NeteaseJourneyOverviewDto> {
    super::command(state.services.netease.journey_overview().await)
}

#[tauri::command]
pub async fn netease_recent_plays(
    state: State<'_, AppState>,
    request: NeteaseRecentPlaysRequestDto,
) -> CommandResult<NeteaseRecentPlaysDto> {
    super::command(
        state
            .services
            .netease
            .recent_plays(
                &request.kind,
                request.user_id,
                request.limit.unwrap_or(50) as usize,
            )
            .await,
    )
}

#[tauri::command]
pub async fn netease_similar_songs(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseTracksDto> {
    super::command(state.services.netease.similar_songs(request.id, 30).await)
}

#[tauri::command]
pub async fn netease_song_quality_levels(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<Vec<NeteaseQualityOptionDto>> {
    super::command(state.services.netease.song_quality_levels(request.id).await)
}

#[tauri::command]
pub async fn netease_scrobble(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    position_ms: u64,
) -> CommandResult<NeteaseScrobbleDto> {
    super::command(
        state
            .services
            .netease
            .scrobble(request.id, position_ms)
            .await,
    )
}

// ---- Stage 16 第二批：长尾路由 ----
#[tauri::command]
pub async fn netease_dj_categories(
    state: State<'_, AppState>,
) -> CommandResult<NeteaseDjCategoriesDto> {
    super::command(state.services.netease.dj_categories().await)
}

#[tauri::command]
pub async fn netease_dj_recommend(
    state: State<'_, AppState>,
    request: NeteaseDjRecommendRequestDto,
) -> CommandResult<NeteaseDjPageDto> {
    super::command(
        state
            .services
            .netease
            .dj_recommend(request.limit.unwrap_or(6))
            .await,
    )
}

#[tauri::command]
pub async fn netease_dj_program_toplist(
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<NeteaseDjPageDto> {
    super::command(state.services.netease.dj_program_toplist(page).await)
}

#[tauri::command]
pub async fn netease_dj_sublist(
    state: State<'_, AppState>,
    page: PageRequestDto,
) -> CommandResult<NeteaseDjPageDto> {
    super::command(state.services.netease.dj_sublist(page).await)
}

#[tauri::command]
pub async fn netease_personalized_dj_radios(
    state: State<'_, AppState>,
    request: NeteaseDjRecommendRequestDto,
) -> CommandResult<NeteaseDjPageDto> {
    super::command(
        state
            .services
            .netease
            .personalized_dj_radios(request.limit.unwrap_or(30))
            .await,
    )
}

#[tauri::command]
pub async fn netease_song_wiki(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseSongWikiDto> {
    super::command(state.services.netease.song_wiki(request.id).await)
}

#[tauri::command]
pub async fn netease_song_related_blogs(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseSongRelatedBlogsDto> {
    super::command(
        state
            .services
            .netease
            .song_related_blogs(request.id, 1, 5)
            .await,
    )
}

#[tauri::command]
pub async fn netease_song_detail_enriched(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseEnrichedSongDto> {
    super::command(
        state
            .services
            .netease
            .song_detail_enriched(request.id)
            .await,
    )
}

#[tauri::command]
pub async fn netease_playmode_intelligence_list(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
    playlist_id: u64,
) -> CommandResult<NeteaseTracksDto> {
    super::command(
        state
            .services
            .netease
            .playmode_intelligence_list(request.id, playlist_id, 30)
            .await,
    )
}

#[tauri::command]
pub async fn netease_related_playlists(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteasePlaylistPageDto> {
    super::command(state.services.netease.related_playlists(request.id).await)
}

#[tauri::command]
pub async fn netease_album_covers_batch(
    state: State<'_, AppState>,
    ids: Vec<u64>,
) -> CommandResult<NeteaseAlbumCoversDto> {
    super::command(state.services.netease.album_covers_batch(ids).await)
}

#[tauri::command]
pub async fn netease_similar_artists(
    state: State<'_, AppState>,
    request: NeteaseResourceRequestDto,
) -> CommandResult<NeteaseSimilarArtistsDto> {
    super::command(state.services.netease.similar_artists(request.id).await)
}

#[tauri::command]
pub async fn netease_explore_next(
    state: State<'_, AppState>,
    request: NeteaseExploreNextRequestDto,
) -> CommandResult<NeteaseExploreNextDto> {
    super::command(state.services.netease.explore_next(request).await)
}

#[tauri::command]
pub async fn netease_update_playlist_cover(
    state: State<'_, AppState>,
    request: NeteaseUpdatePlaylistCoverRequestDto,
) -> CommandResult<NeteaseMutationResultDto> {
    super::command(state.services.netease.update_playlist_cover(request).await)
}
