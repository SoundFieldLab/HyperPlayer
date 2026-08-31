use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoDto {
    pub app_name: String,
    pub app_version: String,
    pub platform: String,
    pub initialized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapDto {
    pub app: AppInfoDto,
    pub playback: PlaybackStateDto,
    pub queue: QueueSnapshotDto,
    pub settings: SettingsDto,
    pub netease: NeteaseStatusDto,
    pub dsp: DspAvailabilityDto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatusDto {
    Stopped,
    Paused,
    Playing,
    Buffering,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepeatModeDto {
    Sequential,
    RepeatAll,
    RepeatOne,
    Shuffle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrackSourceDto {
    Local,
    Netease,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackRefDto {
    pub id: String,
    pub source: TrackSourceDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackDto {
    pub track_ref: TrackRefDto,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub artist_ids: Vec<String>,
    pub artwork_hash: Option<String>,
    pub duration_ms: Option<u64>,
    pub quality_label: Option<String>,
    pub playable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStateDto {
    pub status: PlaybackStatusDto,
    pub current_track: Option<TrackDto>,
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
    pub volume: f32,
    pub muted: bool,
    pub repeat_mode: RepeatModeDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetVolumeRequestDto {
    pub volume: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SeekRequestDto {
    pub position_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlayTrackRequestDto {
    pub track: TrackRefDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemDto {
    pub queue_item_id: String,
    pub track: TrackDto,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshotDto {
    pub current_item_id: Option<String>,
    pub play_next: Vec<QueueItemDto>,
    pub context: Vec<QueueItemDto>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshotDto {
    pub playback: PlaybackStateDto,
    pub queue: QueueSnapshotDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueRequestDto {
    pub track: TrackRefDto,
    pub position: QueueInsertPositionDto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueueInsertPositionDto {
    PlayNext,
    ContextEnd,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemRequestDto {
    pub queue_item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReorderQueueRequestDto {
    pub queue_item_id: String,
    pub target_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageRequestDto {
    pub cursor: Option<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryQueryDto {
    pub search: Option<String>,
    pub page: PageRequestDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPageDto {
    pub items: Vec<TrackDto>,
    pub next_cursor: Option<String>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAlbumDto {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub track_count: u64,
    pub artwork_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryArtistDto {
    pub id: String,
    pub name: String,
    pub track_count: u64,
    pub album_count: u64,
    pub artwork_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderDto {
    pub id: String,
    pub name: String,
    pub track_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPlaylistDto {
    pub id: String,
    pub name: String,
    pub track_count: u64,
    pub updated_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRecentDto {
    pub track: TrackDto,
    pub played_unix_ms: u64,
    pub position_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntityPageDto<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryEntityTracksRequestDto {
    pub id: String,
    pub page: PageRequestDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryTrackRequestDto {
    pub track_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryArtworkRequestDto {
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryArtworkDto {
    pub content_hash: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMutationResultDto {
    pub removed_from_library: bool,
    pub moved_to_recycle_bin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOverviewDto {
    pub track_count: u64,
    pub album_count: u64,
    pub artist_count: u64,
    pub scan_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanRequestDto {
    pub location_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterLibraryLocationRequestDto {
    pub selection_ticket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLocationSelectionDto {
    pub selection_ticket: Option<String>,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLocationDto {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskAcceptedDto {
    pub task_id: String,
    pub accepted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundTaskKindDto {
    Scan,
    Cache,
    Sync,
    Update,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundTaskStateDto {
    Running,
    Attention,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTaskDto {
    pub id: String,
    pub kind: BackgroundTaskKindDto,
    pub title: String,
    pub detail: String,
    pub progress: Option<f32>,
    pub state: BackgroundTaskStateDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummaryDto {
    pub tracks: u64,
    pub albums: u64,
    pub artists: u64,
    pub folders: Vec<String>,
    pub last_scanned_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ThemeDto {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehaviorDto {
    Ask,
    MinimizeToTray,
    Exit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub theme: ThemeDto,
    pub dynamic_color: bool,
    pub reduce_motion: bool,
    pub reduce_transparency: bool,
    pub restore_queue: bool,
    pub autoplay_on_start: bool,
    pub close_behavior: CloseBehaviorDto,
    pub netease_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequestDto {
    pub theme: Option<ThemeDto>,
    pub dynamic_color: Option<bool>,
    pub reduce_motion: Option<bool>,
    pub reduce_transparency: Option<bool>,
    pub restore_queue: Option<bool>,
    pub autoplay_on_start: Option<bool>,
    pub close_behavior: Option<CloseBehaviorDto>,
    pub netease_enabled: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CacheAccessClassDto {
    Public,
    AccountEntitled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CacheEntryStatusDto {
    Missing,
    Queued,
    Caching,
    Ready,
    LockedEntitlement,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatusDto {
    pub track: TrackRefDto,
    pub quality: Option<String>,
    pub status: CacheEntryStatusDto,
    pub access_class: CacheAccessClassDto,
    pub owner_user_id: Option<String>,
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheTrackRequestDto {
    pub track: TrackRefDto,
    pub quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsDto {
    pub entry_count: u64,
    pub bytes_used: u64,
    pub active_tasks: u32,
    pub locked_entries: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseStatusDto {
    pub enabled: bool,
    pub authenticated: bool,
    pub user_id: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NeteaseSearchKindDto {
    Track,
    Album,
    Artist,
    Playlist,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSearchRequestDto {
    pub query: String,
    pub kind: NeteaseSearchKindDto,
    pub page: PageRequestDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSearchPageDto {
    pub tracks: Vec<TrackDto>,
    pub albums: Vec<NeteaseAlbumDto>,
    pub artists: Vec<NeteaseArtistSummaryDto>,
    pub playlists: Vec<NeteasePlaylistDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseMvListRequestDto {
    pub area: String,
    pub kind: String,
    pub order: String,
    pub page: PageRequestDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseMvDto {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub duration_ms: Option<u64>,
    pub artists: Vec<NeteaseArtistDto>,
    pub play_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseMvPageDto {
    pub items: Vec<NeteaseMvDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseMvDetailDto {
    pub mv: NeteaseMvDto,
    pub description: Option<String>,
    pub publish_time: Option<String>,
    pub favorite_count: Option<u64>,
    pub comment_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseDjRadioDto {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub description: Option<String>,
    pub program_count: Option<u64>,
    pub subscriber_count: Option<u64>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseDjProgramsRequestDto {
    pub radio_id: u64,
    pub ascending: bool,
    pub page: PageRequestDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseDjProgramDto {
    pub id: u64,
    pub name: String,
    pub radio: NeteaseDjRadioDto,
    pub main_track: Option<TrackDto>,
    pub duration_ms: Option<u64>,
    pub listener_count: Option<u64>,
    pub liked_count: Option<u64>,
    pub created_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseDjPageDto {
    pub radios: Vec<NeteaseDjRadioDto>,
    pub programs: Vec<NeteaseDjProgramDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseChartDto {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub update_frequency: Option<String>,
    pub description: Option<String>,
    pub preview_tracks: Vec<TrackDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseNewSongsRequestDto {
    pub area_id: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseTracksDto {
    pub tracks: Vec<TrackDto>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NeteaseListenPeriodDto {
    Week,
    Month,
    Year,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseListenReportRequestDto {
    pub period: NeteaseListenPeriodDto,
    pub end_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseListenStatsDto {
    pub total_minutes: u64,
    pub total_plays: u64,
    pub songs: Vec<TrackDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseListenReportDto {
    pub period: String,
    pub end_time: Option<String>,
    pub stats: NeteaseListenStatsDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseCursorRequestDto {
    pub cursor: Option<i64>,
    pub limit: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseUserEventsRequestDto {
    pub user_id: u64,
    pub cursor: Option<i64>,
    pub limit: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSocialEventDto {
    pub id: u64,
    pub event_type: Option<String>,
    pub occurred_at_ms: Option<u64>,
    pub user: Option<NeteaseUserDto>,
    pub text: Option<String>,
    pub track: Option<TrackDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseEventPageDto {
    pub items: Vec<NeteaseSocialEventDto>,
    pub has_more: bool,
    pub next_cursor: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseNoticeDto {
    pub id: u64,
    pub occurred_at_ms: Option<u64>,
    pub title: Option<String>,
    pub text: String,
    pub user: Option<NeteaseUserDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseNoticePageDto {
    pub items: Vec<NeteaseNoticeDto>,
    pub has_more: bool,
    pub next_cursor: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseImageRequestDto {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseImageDto {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseLoginStartDto {
    pub login_id: String,
    pub qr_image_data_url: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseLoginPollRequestDto {
    pub login_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NeteaseLoginPhaseDto {
    Waiting,
    Scanned,
    Confirmed,
    Expired,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseLoginStateDto {
    pub phase: NeteaseLoginPhaseDto,
    pub status: NeteaseStatusDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseResourceRequestDto {
    pub id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseArtistDto {
    pub id: u64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseAlbumDto {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteasePlaylistDto {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub track_count: u64,
    pub play_count: Option<u64>,
    pub owner_id: u64,
    pub owner_name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseHomeDto {
    pub recommended_tracks: Vec<TrackDto>,
    pub recommended_playlists: Vec<NeteasePlaylistDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseAlbumDetailDto {
    pub album: NeteaseAlbumDto,
    pub description: Option<String>,
    pub publish_time_ms: Option<u64>,
    pub artist: Option<NeteaseArtistDto>,
    pub tracks: Vec<TrackDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteasePlaylistDetailDto {
    pub playlist: NeteasePlaylistDto,
    pub tracks: Vec<TrackDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseArtistSummaryDto {
    pub id: u64,
    pub name: String,
    pub image_url: Option<String>,
    pub aliases: Vec<String>,
    pub brief_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseArtistDetailDto {
    pub artist: NeteaseArtistSummaryDto,
    pub hot_tracks: Vec<TrackDto>,
    pub introduction: Option<String>,
    pub fans_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseFmDto {
    pub tracks: Vec<TrackDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseUserDto {
    pub user_id: u64,
    pub nickname: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseVipDto {
    pub active: bool,
    pub expires_at_ms: Option<u64>,
    pub level: Option<u32>,
    pub verified_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseAccountDto {
    pub user: NeteaseUserDto,
    pub vip: NeteaseVipDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseFavoritesDto {
    pub liked_track_ids: Vec<u64>,
    pub playlists: Vec<NeteasePlaylistDto>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NeteaseCommentResourceDto {
    Song,
    Mv,
    Playlist,
    Album,
    Radio,
    Video,
    Event,
    DigitalAlbum,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseCommentsRequestDto {
    pub resource: NeteaseCommentResourceDto,
    pub resource_id: u64,
    pub page: PageRequestDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseCommentDto {
    pub id: u64,
    pub content: String,
    pub time_text: Option<String>,
    pub liked_count: u64,
    pub liked: bool,
    pub user: Option<NeteaseUserDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseCommentPageDto {
    pub comments: Vec<NeteaseCommentDto>,
    pub total_count: u64,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseFollowsRequestDto {
    pub user_id: u64,
    pub page: PageRequestDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseUserPageDto {
    pub users: Vec<NeteaseUserDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseCloudSongDto {
    pub cloud_id: u64,
    pub track: TrackDto,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseCloudPageDto {
    pub songs: Vec<NeteaseCloudSongDto>,
    pub total_count: u64,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NeteaseMutationDto {
    SetAlbumFavorite {
        album_id: u64,
        favorite: bool,
    },
    CreatePlaylist {
        name: String,
        private: bool,
    },
    DeletePlaylist {
        playlist_id: u64,
    },
    UpdatePlaylist {
        playlist_id: u64,
        name: Option<String>,
        description: String,
        tags: Vec<String>,
    },
    SetPlaylistFavorite {
        playlist_id: u64,
        favorite: bool,
    },
    AddPlaylistTracks {
        playlist_id: u64,
        track_ids: Vec<u64>,
    },
    RemovePlaylistTracks {
        playlist_id: u64,
        track_ids: Vec<u64>,
    },
    SetArtistFavorite {
        artist_id: u64,
        favorite: bool,
    },
    SetMvFavorite {
        mv_id: u64,
        favorite: bool,
    },
    SetDjRadioFavorite {
        radio_id: u64,
        favorite: bool,
    },
    TrashFmTrack {
        track_id: u64,
    },
    SetTrackFavorite {
        track_id: u64,
        favorite: bool,
    },
    AddComment {
        resource: NeteaseCommentResourceDto,
        resource_id: u64,
        content: String,
    },
    ReplyComment {
        resource: NeteaseCommentResourceDto,
        resource_id: u64,
        comment_id: u64,
        content: String,
    },
    SetCommentFavorite {
        resource: NeteaseCommentResourceDto,
        resource_id: u64,
        comment_id: u64,
        favorite: bool,
    },
    DeleteComment {
        resource: NeteaseCommentResourceDto,
        resource_id: u64,
        comment_id: u64,
    },
    SetUserFollowed {
        user_id: u64,
        followed: bool,
    },
    DeleteCloudSong {
        cloud_id: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteasePrepareMutationRequestDto {
    pub mutation: NeteaseMutationDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseMutationConfirmationDto {
    pub confirmation_token: String,
    pub summary: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeteaseCommitMutationRequestDto {
    pub confirmation_token: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseMutationResultDto {
    pub succeeded: bool,
    pub created_playlist: Option<NeteasePlaylistDto>,
    pub comment: Option<NeteaseCommentDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DspAvailabilityDto {
    pub available: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindowKindDto {
    Main,
    MiniPlayer,
    DesktopLyrics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowWindowRequestDto {
    pub kind: WindowKindDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseWindowRequestDto {
    pub kind: WindowKindDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowFlagRequestDto {
    pub kind: WindowKindDto,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsGetRequestDto {
    pub track: TrackRefDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsPayloadDto {
    pub document: LyricsDocumentDto,
    pub raw_original: String,
    pub raw_translation: String,
    pub raw_romanization: String,
    pub raw_word_synced: String,
    pub raw_word_synced_translation: String,
    pub raw_ttml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDocumentDto {
    pub source: String,
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub language: Option<String>,
    pub offset_ms: i64,
    pub lines: Vec<LyricLineDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricLineDto {
    pub start_ms: u64,
    pub end_ms: Option<u64>,
    pub text: String,
    pub translation: Option<String>,
    pub romanization: Option<String>,
    pub words: Vec<LyricWordDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricWordDto {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCapabilityDto {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsIntegrationStatusDto {
    pub platform: String,
    pub smtc: IntegrationCapabilityDto,
    pub media_keys: IntegrationCapabilityDto,
    pub file_associations: IntegrationCapabilityDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileAssociationRequestDto {
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatusDto {
    pub enabled: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckDto {
    pub available: bool,
    pub version: Option<String>,
    pub current_version: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseDecisionRequestDto {
    pub action: CloseDecisionDto,
    pub remember: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CloseDecisionDto {
    Cancel,
    MinimizeToTray,
    Exit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequestedDto {
    pub is_playing: bool,
    pub has_background_tasks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressDto {
    pub task_id: String,
    pub completed: u64,
    pub total: Option<u64>,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProgressDto {
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrontendPlaybackDto {
    pub current: Option<FrontendTrackDto>,
    pub status: String,
    pub position_ms: u64,
    pub volume: f32,
    pub queue: Vec<FrontendTrackDto>,
    pub next_up: Vec<FrontendTrackDto>,
    pub repeat: String,
    pub dsp: FrontendDspDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrontendTrackDto {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: u64,
    pub source: String,
    pub entitlement: String,
    pub quality: String,
    pub cache: String,
    pub cover_seed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrontendDspDto {
    pub available: bool,
    pub bypassed: bool,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrontendSettingsDto {
    pub theme: String,
    pub material: String,
    pub dynamic_color: bool,
    pub reduce_motion: bool,
    pub reduce_transparency: bool,
    pub restore_queue: bool,
    pub auto_play_on_launch: bool,
    pub netease_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrontendSettingsPatchDto {
    pub theme: Option<String>,
    pub material: Option<String>,
    pub dynamic_color: Option<bool>,
    pub reduce_motion: Option<bool>,
    pub reduce_transparency: Option<bool>,
    pub restore_queue: Option<bool>,
    pub auto_play_on_launch: Option<bool>,
    pub netease_enabled: Option<bool>,
}
