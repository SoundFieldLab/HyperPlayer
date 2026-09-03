use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityLevel {
    Standard,
    Higher,
    Exhigh,
    Lossless,
    Hires,
    Jyeffect,
    Sky,
    Jymaster,
}
impl QualityLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Higher => "higher",
            Self::Exhigh => "exhigh",
            Self::Lossless => "lossless",
            Self::Hires => "hires",
            Self::Jyeffect => "jyeffect",
            Self::Sky => "sky",
            Self::Jymaster => "jymaster",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QualityPreference {
    Standard,
    High,
    VeryHigh,
    Lossless,
    HiRes,
    #[default]
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: u64,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: u64,
    pub name: String,
    pub pic_url: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: u64,
    pub name: String,
    pub artists: Vec<Artist>,
    pub album: Album,
    pub duration_ms: u64,
    pub fee: u8,
    pub mv_id: Option<u64>,
    pub is_vip: bool,
    pub no_copyright: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    pub key: String,
    pub label: String,
    pub bitrate: u64,
    pub size_bytes: u64,
    pub sample_rate: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeTrialInfo {
    pub start: u64,
    pub end: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayInfo {
    pub id: u64,
    pub url: Option<String>,
    pub level: QualityLevel,
    pub bitrate: u64,
    pub size_bytes: u64,
    pub md5: String,
    pub container_type: String,
    pub fee: u8,
    pub free_trial_info: Option<FreeTrialInfo>,
    pub is_paid_content: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub track_count: u64,
    pub play_count: Option<u64>,
    pub owner_id: u64,
    pub owner_name: Option<String>,
    pub description: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    #[serde(flatten)]
    pub summary: PlaylistSummary,
    pub tracks: Vec<Track>,
    pub track_ids: Vec<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAccount {
    pub user_id: u64,
    pub nickname: String,
    pub avatar_url: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VipInfo {
    pub is_vip: bool,
    pub expire_time: Option<u64>,
    pub red_vip_level: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub original: String,
    pub translation: String,
    pub romanization: String,
    pub word_synced: String,
    pub word_synced_translation: String,
    pub ttml: String,
}
impl Lyrics {
    pub fn empty() -> Self {
        Self {
            original: String::new(),
            translation: String::new(),
            romanization: String::new(),
            word_synced: String::new(),
            word_synced_translation: String::new(),
            ttml: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum LoginQrState {
    Expired,
    Waiting,
    Scanned,
    Authorized,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entitlement {
    AccountEntitled {
        user_id: u64,
        verified_at_ms: u64,
        expires_at_ms: Option<u64>,
    },
    Denied,
}
impl Entitlement {
    pub fn authorize_cached_vip(
        &self,
        current_user_id: Option<u64>,
        cache_owner_id: u64,
        now_ms: u64,
    ) -> crate::Result<()> {
        match self {
            Self::AccountEntitled {
                user_id,
                verified_at_ms,
                expires_at_ms,
            } if Some(*user_id) == current_user_id
                && *user_id == cache_owner_id
                && *verified_at_ms <= now_ms
                && expires_at_ms.is_none_or(|v| v > now_ms) =>
            {
                Ok(())
            }
            _ => Err(crate::Error::EntitlementDenied),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageRequest {
    pub limit: usize,
    pub offset: usize,
}
impl PageRequest {
    pub fn bounded(self, max: usize) -> Self {
        Self {
            limit: self.limit.clamp(1, max),
            offset: self.offset,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumDetail {
    #[serde(flatten)]
    pub album: Album,
    pub description: Option<String>,
    pub publish_time_ms: Option<u64>,
    pub artist: Option<Artist>,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSummary {
    pub id: u64,
    pub name: String,
    pub pic_url: Option<String>,
    pub aliases: Vec<String>,
    pub brief_description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistOverview {
    pub artist: ArtistSummary,
    pub hot_songs: Vec<Track>,
    pub introduction: Option<String>,
    pub fans_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub user_id: u64,
    pub nickname: String,
    pub avatar_url: Option<String>,
    pub signature: Option<String>,
    pub follow_count: Option<u64>,
    pub fan_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: u64,
    pub content: String,
    pub time_text: Option<String>,
    pub liked_count: u64,
    pub liked: bool,
    pub user: Option<UserAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPage {
    pub comments: Vec<Comment>,
    pub total_count: u64,
    pub has_more: bool,
    pub cursor: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSong {
    pub cloud_id: u64,
    pub track: Track,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPage {
    pub songs: Vec<CloudSong>,
    pub total_count: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub succeeded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchKind {
    Track,
    Album,
    Artist,
    Playlist,
}

impl SearchKind {
    pub const fn api_type(self) -> u16 {
        match self {
            Self::Track => 1,
            Self::Album => 10,
            Self::Artist => 100,
            Self::Playlist => 1000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub artists: Vec<ArtistSummary>,
    pub playlists: Vec<PlaylistSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvSummary {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub duration_ms: Option<u64>,
    pub artists: Vec<Artist>,
    pub play_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvDetail {
    pub mv: MvSummary,
    pub description: Option<String>,
    pub publish_time: Option<String>,
    pub favorite_count: Option<u64>,
    pub comment_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjRadio {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub description: Option<String>,
    pub program_count: Option<u64>,
    pub subscriber_count: Option<u64>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjProgram {
    pub id: u64,
    pub name: String,
    pub radio: DjRadio,
    pub main_track: Option<Track>,
    pub duration_ms: Option<u64>,
    pub listener_count: Option<u64>,
    pub liked_count: Option<u64>,
    pub created_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSummary {
    pub id: u64,
    pub name: String,
    pub cover_url: Option<String>,
    pub update_frequency: Option<String>,
    pub description: Option<String>,
    pub preview_tracks: Vec<Track>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenStats {
    pub total_minutes: u64,
    pub total_plays: u64,
    pub songs: Vec<Track>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenReport {
    pub period: String,
    pub end_time: Option<String>,
    pub stats: ListenStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialEvent {
    pub id: u64,
    pub event_type: Option<String>,
    pub occurred_at_ms: Option<u64>,
    pub user: Option<UserAccount>,
    pub text: Option<String>,
    pub track: Option<Track>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeMessage {
    pub id: u64,
    pub occurred_at_ms: Option<u64>,
    pub title: Option<String>,
    pub text: String,
    pub user: Option<UserAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPage<T> {
    pub items: Vec<T>,
    pub has_more: bool,
    pub next_cursor: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentResource {
    Song,
    Mv,
    Playlist,
    Album,
    Radio,
    Video,
    Event,
    DigitalAlbum,
}

impl CommentResource {
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Song => "R_SO_4_",
            Self::Mv => "R_MV_5_",
            Self::Playlist => "A_PL_0_",
            Self::Album => "R_AL_3_",
            Self::Radio => "A_DJ_1_",
            Self::Video => "R_VI_62_",
            Self::Event => "A_EV_2_",
            Self::DigitalAlbum => "A_DR_14_",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotWord {
    pub word: String,
    pub score: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSuggestions {
    pub songs: Vec<SuggestSong>,
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub playlists: Vec<PlaylistSummary>,
    pub order: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestSong {
    pub id: u64,
    pub name: String,
    pub artists: Vec<Artist>,
    pub album: Album,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BannerItem {
    pub id: u64,
    pub title: String,
    pub image_url: String,
    pub target_url: String,
    pub target_type: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCategory {
    pub name: String,
    pub id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LikedState {
    pub song_id: u64,
    pub liked: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotCommentPage {
    pub comments: Vec<Comment>,
    pub total: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentFloor {
    pub floor: u64,
    pub comments: Vec<Comment>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserLevel {
    pub level: u64,
    pub next_level_experience: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSubcount {
    pub playlists: u64,
    pub albums: u64,
    pub artists: u64,
    pub mvs: u64,
    pub dj_radios: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StylePreference {
    pub tag_ids: Vec<u64>,
    pub tag_names: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub logged_in: bool,
    pub user_id: Option<u64>,
    pub nickname: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentPlay {
    pub played_at_ms: u64,
    pub resource: RecentPlayResource,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecentPlayResource {
    Song(Track),
    Playlist(PlaylistSummary),
    Album(Album),
    DjRadio(DjRadio),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenDataToday {
    pub listened_ms: u64,
    pub play_count: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JourneyOverview {
    pub total_listen_ms: u64,
    pub total_play_count: u64,
    pub today_listen_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleResult {
    pub reported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichedSong {
    pub track: Track,
    pub quality_levels: Vec<QualityOption>,
    pub album_extra: Option<AlbumExtra>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumExtra {
    pub company: String,
    pub publish_time_ms: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCover {
    pub id: u64,
    pub cover_url: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreNextResult {
    pub songs: Vec<Track>,
    pub batch: usize,
    pub has_more: bool,
}
