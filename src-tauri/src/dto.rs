use serde::{Deserialize, Serialize};

pub const DEFAULT_CACHE_CAPACITY_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub const DEFAULT_CACHE_TRIM_PERCENT: u8 = 90;
pub const DEFAULT_CACHE_RECENT_TRACK_LIMIT: usize = 100;
pub const DEFAULT_ALBUM_FILL_ENABLED: bool = true;
pub const DEFAULT_ALBUM_FILL_QUALITY: &str = "standard";

// Cache policy defaults mirror `hyperplayer_engine::cache_policy::CachePolicy::default()`
// so an older settings.json missing these fields falls back to the engine defaults.
const fn default_cache_capacity_bytes() -> u64 {
    DEFAULT_CACHE_CAPACITY_BYTES
}

const fn default_cache_trim_percent() -> u8 {
    DEFAULT_CACHE_TRIM_PERCENT
}

const fn default_cache_recent_track_limit() -> usize {
    DEFAULT_CACHE_RECENT_TRACK_LIMIT
}

const fn default_album_fill_enabled() -> bool {
    DEFAULT_ALBUM_FILL_ENABLED
}

fn default_album_fill_quality() -> String {
    String::from(DEFAULT_ALBUM_FILL_QUALITY)
}

pub(crate) mod u64_decimal_string {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(D::Error::custom("expected an unsigned decimal string"));
        }
        value
            .parse()
            .map_err(|_| D::Error::custom("unsigned decimal string exceeds u64"))
    }
}

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
    pub settings: SettingsDto,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPlaylistCreateRequestDto {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPlaylistRenameRequestDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPlaylistTrackRequestDto {
    pub playlist_id: String,
    pub track_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPlaylistReorderRequestDto {
    pub playlist_id: String,
    pub track_id: String,
    pub target_position: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPlaylistDeleteRequestDto {
    pub id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    #[serde(default = "default_cache_capacity_bytes")]
    pub cache_capacity_bytes: u64,
    #[serde(default = "default_cache_trim_percent")]
    pub cache_trim_percent: u8,
    #[serde(default = "default_cache_recent_track_limit")]
    pub cache_recent_track_limit: usize,
    #[serde(default = "default_album_fill_enabled")]
    pub album_fill_enabled: bool,
    #[serde(default = "default_album_fill_quality")]
    pub album_fill_quality: String,
    /// 版本化 DSP 配置持久化。缺失（旧 settings.json）或版本未知一律回落默认；
    /// `revision` 为跨进程递增基准（见 `DspConfigurationState`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsp: Option<PersistedDspConfig>,
}

/// 持久化的 DSP 配置（version + revision + 配置 DTO）。
///
/// 迁移纪律（Stage 09）：
/// - `version` 缺失或非当前版本 → 回落默认（fail-close），不尝试跨版本映射；
/// - `revision` 缺失 → 回落 1（与 `DspConfigurationState::new()` 的 pending 基准一致）；
/// - 写时总是携带当前 `DSP_CONFIG_VERSION`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDspConfig {
    #[serde(default = "default_dsp_config_version")]
    pub version: u32,
    #[serde(with = "u64_decimal_string", default = "default_dsp_revision")]
    pub revision: u64,
    pub configuration: serde_json::Value,
}

/// 当前持久化 DSP 配置 schema 版本（版本化迁移的单一权威）。
pub const DSP_CONFIG_VERSION: u32 = 1;

const fn default_dsp_config_version() -> u32 {
    DSP_CONFIG_VERSION
}

const fn default_dsp_revision() -> u64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
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
    pub cache_capacity_bytes: Option<u64>,
    pub cache_trim_percent: Option<u8>,
    pub cache_recent_track_limit: Option<usize>,
    pub album_fill_enabled: Option<bool>,
    pub album_fill_quality: Option<String>,
    /// DSP 配置持久化（D35 Q16：哑 KV，schema 归 TS；Rust 不解析内容）。
    /// None = 不改动；Some(None) = 清除；Some(Some(config)) = 写入。
    pub dsp: Option<Option<PersistedDspConfig>>,
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

/// DPAPI 保险库哑存取（D35 Q17）：payload 为不透明字符串（TS 侧会话 JSON）。
/// `None` 表示删除。Rust 不解析内容，schema 归 TS。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialUpdateRequestDto {
    pub payload: Option<String>,
}

/// SMTC 上行元数据（D35 Q13）：Rust 纯桥，只写 SystemMediaTransportControls。
/// thumbnail 为 data URL（data:image/...;base64,...），空/非法时忽略。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SmtcMetadataRequestDto {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SmtcPlaybackStateDto {
    Playing,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmtcPlaybackStateRequestDto {
    pub state: SmtcPlaybackStateDto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmtcPositionRequestDto {
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
}

