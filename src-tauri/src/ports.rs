use crate::{
    adapters::{
        CacheAdapter, EngineAdapter, LibraryAdapter, LocationRegistry, NeteaseAdapter,
        PrefetchRequest, SettingsAdapter, TrackResolver,
    },
    dto::*,
    error::AppResult,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

const LOCATION_TICKET_TTL: Duration = Duration::from_secs(60);

pub type ScanProgressSink = Arc<dyn Fn(ScanProgressDto) + Send + Sync>;
pub type TelemetrySink = Arc<dyn Fn(TelemetryFrame) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelemetryFrame {
    pub payload: Vec<u8>,
}

pub trait TelemetrySubscription: Send + Sync {
    fn set_activity(&self, rate_hz: u8) -> AppResult<()>;
}

pub trait TelemetryPort: Send + Sync {
    fn subscribe(&self, sink: TelemetrySink) -> AppResult<Box<dyn TelemetrySubscription>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackTransition {
    Next { automatic: bool },
    Previous,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackMediaTarget {
    pub queue_id: u64,
    pub track: TrackRefDto,
}

pub trait PlaybackPort: Send + Sync {
    fn state(&self) -> AppResult<PlaybackStateDto>;
    fn engine_snapshot(&self) -> AppResult<EngineSnapshotDto>;
    fn play_resolved(
        &self,
        media: Option<hyperplayer_engine::TrustedResolvedMedia>,
        context: PlaybackContextDto,
    ) -> AppResult<EngineSnapshotDto>;
    fn restored_media_targets(&self) -> AppResult<Vec<(u64, TrackRefDto)>>;
    fn transition_media_targets(
        &self,
        transition: PlaybackTransition,
    ) -> AppResult<Vec<PlaybackMediaTarget>>;
    fn attach_restored_media(
        &self,
        media: Vec<(u64, hyperplayer_engine::TrustedResolvedMedia)>,
    ) -> AppResult<()>;
    fn pause(&self) -> AppResult<EngineSnapshotDto>;
    fn stop(&self) -> AppResult<EngineSnapshotDto>;
    fn next(&self, expected_queue_id: u64, automatic: bool) -> AppResult<EngineSnapshotDto>;
    fn previous(&self, expected_queue_id: u64) -> AppResult<EngineSnapshotDto>;
    fn seek(&self, position_ms: u64) -> AppResult<EngineSnapshotDto>;
    fn set_volume(&self, volume: f32) -> AppResult<EngineSnapshotDto>;
    fn configure_dsp(
        &self,
        revision: u64,
        config: hyperplayer_engine::dsp_algorithms::DspConfig,
    ) -> AppResult<EngineSnapshotDto>;
    fn set_repeat_mode(&self, mode: RepeatModeDto) -> AppResult<EngineSnapshotDto>;
    fn subscribe_events(
        &self,
    ) -> AppResult<std::sync::mpsc::Receiver<hyperplayer_engine::EngineEvent>>;
    fn event_dto(
        &self,
        event: hyperplayer_engine::EngineEvent,
    ) -> AppResult<(hyperplayer_engine::EngineEventKind, EngineSnapshotDto)>;
}

pub trait QueuePort: Send + Sync {
    fn snapshot(&self) -> AppResult<QueueSnapshotDto>;
    fn enqueue_resolved(
        &self,
        media: hyperplayer_engine::TrustedResolvedMedia,
        position: QueueInsertPositionDto,
    ) -> AppResult<EngineSnapshotDto>;
    fn remove(&self, queue_item_id: &str) -> AppResult<EngineSnapshotDto>;
    fn reorder(&self, request: ReorderQueueRequestDto) -> AppResult<EngineSnapshotDto>;
    fn clear_play_next(&self) -> AppResult<EngineSnapshotDto>;
    fn clear_all(&self) -> AppResult<EngineSnapshotDto>;
}

pub trait LibraryPort: Send + Sync {
    fn overview(&self) -> AppResult<LibraryOverviewDto>;
    fn query_tracks(&self, request: LibraryQueryDto) -> AppResult<LibraryPageDto>;
    fn query_albums(&self, request: LibraryQueryDto) -> AppResult<EntityPageDto<LibraryAlbumDto>>;
    fn query_artists(&self, request: LibraryQueryDto)
        -> AppResult<EntityPageDto<LibraryArtistDto>>;
    fn query_folders(&self, request: LibraryQueryDto)
        -> AppResult<EntityPageDto<LibraryFolderDto>>;
    fn query_recent(&self, page: PageRequestDto) -> AppResult<EntityPageDto<LibraryRecentDto>>;
    fn query_playlists(
        &self,
        request: LibraryQueryDto,
    ) -> AppResult<EntityPageDto<LibraryPlaylistDto>>;
    fn create_playlist(&self, name: &str) -> AppResult<LibraryPlaylistDto>;
    fn rename_playlist(&self, id: &str, name: &str) -> AppResult<LibraryPlaylistDto>;
    fn delete_playlist(&self, id: &str) -> AppResult<()>;
    fn add_playlist_track(&self, playlist_id: &str, track_id: &str) -> AppResult<()>;
    fn remove_playlist_track(&self, playlist_id: &str, track_id: &str) -> AppResult<()>;
    fn reorder_playlist_track(
        &self,
        playlist_id: &str,
        track_id: &str,
        target_position: u32,
    ) -> AppResult<()>;
    fn album_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto>;
    fn artist_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto>;
    fn folder_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto>;
    fn playlist_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto>;
    fn artwork(&self, content_hash: &str) -> AppResult<LibraryArtworkDto>;
    fn reread_tags(&self, track_id: &str) -> AppResult<TrackDto>;
    fn remove_from_library(&self, track_id: &str) -> AppResult<LibraryMutationResultDto>;
    fn move_to_recycle_bin(&self, track_id: &str) -> AppResult<LibraryMutationResultDto>;
    fn register_location(&self, path: &Path) -> AppResult<LibraryLocationDto>;
    fn start_scan(
        &self,
        request: LibraryScanRequestDto,
        progress: ScanProgressSink,
    ) -> AppResult<TaskAcceptedDto>;
    fn cancel_scan(&self, task_id: &str) -> AppResult<()>;
    fn has_active_tasks(&self) -> bool;
}

pub trait SettingsPort: Send + Sync {
    fn get(&self) -> AppResult<SettingsDto>;
    fn update(&self, request: UpdateSettingsRequestDto) -> AppResult<SettingsDto>;
    /// 读取当前持久化的 DSP 配置（供启动恢复）；无/非法配置返回 None。
    fn persisted_dsp_config(&self) -> AppResult<Option<crate::dto::PersistedDspConfig>>;
    /// 原子持久化一份最新 DSP 配置（在 Tauri apply 成功路径调用，进磁盘写不落在播放线程）。
    fn persist_dsp_config(&self, config: &crate::dto::PersistedDspConfig) -> AppResult<()>;
}

#[async_trait::async_trait]
pub trait CachePort: Send + Sync {
    fn stats(&self) -> AppResult<CacheStatsDto>;
    fn status(&self, track: &TrackRefDto) -> AppResult<CacheStatusDto>;
    async fn cache_track(&self, request: CacheTrackRequestDto) -> AppResult<TaskAcceptedDto>;
    fn remove(&self, track: &TrackRefDto) -> AppResult<()>;
    fn clear(&self) -> AppResult<TaskAcceptedDto>;
}

#[async_trait::async_trait]
pub trait NeteasePort: Send + Sync {
    fn status(&self) -> AppResult<NeteaseStatusDto>;
    async fn search(&self, request: NeteaseSearchRequestDto) -> AppResult<NeteaseSearchPageDto>;
    async fn mvs(&self, request: NeteaseMvListRequestDto) -> AppResult<NeteaseMvPageDto>;
    async fn mv_detail(&self, id: u64) -> AppResult<NeteaseMvDetailDto>;
    async fn dj_radios(&self, page: PageRequestDto) -> AppResult<NeteaseDjPageDto>;
    async fn dj_programs(
        &self,
        request: NeteaseDjProgramsRequestDto,
    ) -> AppResult<NeteaseDjPageDto>;
    async fn charts(&self) -> AppResult<Vec<NeteaseChartDto>>;
    async fn new_songs(&self, area_id: u16) -> AppResult<NeteaseTracksDto>;
    async fn listen_total(&self) -> AppResult<NeteaseListenStatsDto>;
    async fn listen_report(
        &self,
        request: NeteaseListenReportRequestDto,
    ) -> AppResult<NeteaseListenReportDto>;
    async fn listen_song_rank(
        &self,
        request: NeteaseListenReportRequestDto,
    ) -> AppResult<NeteaseTracksDto>;
    async fn followed_events(
        &self,
        request: NeteaseCursorRequestDto,
    ) -> AppResult<NeteaseEventPageDto>;
    async fn user_events(
        &self,
        request: NeteaseUserEventsRequestDto,
    ) -> AppResult<NeteaseEventPageDto>;
    async fn notices(&self, request: NeteaseCursorRequestDto) -> AppResult<NeteaseNoticePageDto>;
    async fn home(&self) -> AppResult<NeteaseHomeDto>;
    async fn album_detail(&self, id: u64) -> AppResult<NeteaseAlbumDetailDto>;
    async fn playlist_detail(&self, id: u64) -> AppResult<NeteasePlaylistDetailDto>;
    async fn artist_detail(&self, id: u64) -> AppResult<NeteaseArtistDetailDto>;
    async fn personal_fm(&self) -> AppResult<NeteaseFmDto>;
    async fn account(&self) -> AppResult<NeteaseAccountDto>;
    async fn favorites(&self) -> AppResult<NeteaseFavoritesDto>;
    async fn comments(
        &self,
        request: NeteaseCommentsRequestDto,
    ) -> AppResult<NeteaseCommentPageDto>;
    async fn follows(&self, request: NeteaseFollowsRequestDto) -> AppResult<NeteaseUserPageDto>;
    async fn cloud(&self, page: PageRequestDto) -> AppResult<NeteaseCloudPageDto>;
    async fn image(&self, url: &str) -> AppResult<NeteaseImageDto>;
    fn prepare_mutation(
        &self,
        window_label: &str,
        request: NeteasePrepareMutationRequestDto,
    ) -> AppResult<NeteaseMutationConfirmationDto>;
    async fn commit_mutation(
        &self,
        window_label: &str,
        request: NeteaseCommitMutationRequestDto,
    ) -> AppResult<NeteaseMutationResultDto>;
    async fn start_qr_login(&self) -> AppResult<NeteaseLoginStartDto>;
    async fn poll_qr_login(&self, login_id: &str) -> AppResult<NeteaseLoginStateDto>;
    async fn logout(&self) -> AppResult<NeteaseStatusDto>;
    async fn resolve_track(&self, track: &TrackRefDto) -> AppResult<hyperplayer_engine::Track>;
}

#[async_trait::async_trait]
pub trait LyricsPort: Send + Sync {
    async fn get(&self, track: &TrackRefDto) -> AppResult<LyricsPayloadDto>;
}

#[async_trait::async_trait]
pub trait TrackResolverPort: Send + Sync {
    async fn resolve(
        &self,
        track: &TrackRefDto,
    ) -> AppResult<hyperplayer_engine::TrustedResolvedMedia>;
}

pub struct AppServices {
    pub playback: Arc<dyn PlaybackPort>,
    pub queue: Arc<dyn QueuePort>,
    pub library: Arc<dyn LibraryPort>,
    pub settings: Arc<dyn SettingsPort>,
    pub cache: Arc<dyn CachePort>,
    pub netease: Arc<dyn NeteasePort>,
    pub lyrics: Arc<dyn LyricsPort>,
    pub tracks: Arc<dyn TrackResolverPort>,
    pub telemetry: Arc<dyn TelemetryPort>,
    pub cache_runtime: Arc<crate::cache_runtime::CacheRuntime>,
}

impl AppServices {
    pub fn new(app_data_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(app_data_dir)?;
        let repository = Arc::new(Mutex::new(
            hyperplayer_engine::repository::SqliteRepository::open(
                app_data_dir.join("hyperplayer.sqlite3"),
            )?,
        ));
        let settings = Arc::new(SettingsAdapter::open(app_data_dir.join("settings.json"))?);
        let credential_vault = crate::credential_vault::netease_credential_vault(app_data_dir)?;
        let netease = Arc::new(NeteaseAdapter::new(
            settings.clone(),
            credential_vault,
            repository.clone(),
        )?);
        let cache_root = app_data_dir.join("cache");
        let cache = Arc::new(CacheAdapter::new(
            repository.clone(),
            netease.clone(),
            cache_root.clone(),
        )?);
        let (prefetch_sender, prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let engine = Arc::new(EngineAdapter::with_prefetch(
            repository.clone(),
            settings.get()?.restore_queue,
            prefetch_sender,
        )?);
        spawn_prefetch_worker(cache.clone(), prefetch_receiver)?;
        let lyrics = Arc::new(crate::commands::lyrics::NeteaseLyricsAdapter::new(
            settings.clone(),
            repository.clone(),
        ));
        let locations = Arc::new(LocationRegistry::open(
            app_data_dir.join("hyperplayer-locations.sqlite3"),
        )?);
        {
            let repository = repository
                .lock()
                .map_err(|_| crate::error::AppError::StateUnavailable)?;
            for root in locations.all()? {
                repository.register_library_root(&root)?;
            }
        }
        let tracks = Arc::new(TrackResolver::new(
            repository.clone(),
            locations.clone(),
            netease.clone(),
            cache_root.clone(),
            app_data_dir.join("playback-temp"),
        )?);
        let artwork_root = app_data_dir.join("artwork");
        let cache_runtime = Arc::new(crate::cache_runtime::CacheRuntime::new(
            repository.clone(),
            cache_root,
        ));
        Ok(Self {
            playback: engine.clone(),
            queue: engine.clone(),
            library: Arc::new(LibraryAdapter::new(
                repository.clone(),
                locations,
                artwork_root,
            )?),
            settings,
            cache,
            netease,
            lyrics,
            tracks,
            telemetry: engine,
            cache_runtime,
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        let repository = Arc::new(Mutex::new(
            hyperplayer_engine::repository::SqliteRepository::in_memory()?,
        ));
        let settings = Arc::new(SettingsAdapter::new());
        let netease = Arc::new(NeteaseAdapter::disabled(settings.clone()));
        let cache_root = std::env::temp_dir().join(format!(
            "hyperplayer-test-cache-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let cache = Arc::new(CacheAdapter::new(
            repository.clone(),
            netease.clone(),
            cache_root.clone(),
        )?);
        let (prefetch_sender, prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let engine = Arc::new(EngineAdapter::with_prefetch(
            repository.clone(),
            false,
            prefetch_sender,
        )?);
        spawn_prefetch_worker(cache.clone(), prefetch_receiver)?;
        let lyrics = Arc::new(crate::commands::lyrics::NeteaseLyricsAdapter::disabled(
            settings.clone(),
        ));
        let locations = Arc::new(LocationRegistry::in_memory()?);
        let tracks = Arc::new(TrackResolver::new(
            repository.clone(),
            locations.clone(),
            netease.clone(),
            cache_root.clone(),
            std::env::temp_dir().join(format!(
                "hyperplayer-test-playback-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            )),
        )?);
        let artwork_root = std::env::temp_dir().join(format!(
            "hyperplayer-test-artwork-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let cache_runtime = Arc::new(crate::cache_runtime::CacheRuntime::new(
            repository.clone(),
            cache_root,
        ));
        Ok(Self {
            playback: engine.clone(),
            queue: engine.clone(),
            library: Arc::new(LibraryAdapter::new(
                repository.clone(),
                locations,
                artwork_root,
            )?),
            settings,
            cache,
            netease,
            lyrics,
            tracks,
            telemetry: engine,
            cache_runtime,
        })
    }
}

fn spawn_prefetch_worker(
    cache: Arc<dyn CachePort>,
    receiver: std::sync::mpsc::Receiver<PrefetchRequest>,
) -> AppResult<()> {
    std::thread::Builder::new()
        .name("hyperplayer-cache-prefetch".into())
        .spawn(move || {
            while let Ok(request) = receiver.recv() {
                let track_id = request.track.id.clone();
                let quality = request.quality.clone();
                if let Err(error) =
                    tauri::async_runtime::block_on(cache.cache_track(CacheTrackRequestDto {
                        track: request.track,
                        quality: request.quality,
                    }))
                {
                    eprintln!(
                        "cache prefetch failed for track {track_id} at quality {quality}: {error}"
                    );
                }
            }
        })?;
    Ok(())
}

#[derive(Clone)]
pub struct PendingDspConfiguration {
    pub revision: u64,
    pub config: hyperplayer_engine::dsp_algorithms::DspConfig,
}

pub struct DspConfigurationState {
    pub applied_revision: u64,
    pub applied_config: hyperplayer_engine::dsp_algorithms::DspConfig,
    pub pending: Option<PendingDspConfiguration>,
}

impl DspConfigurationState {
    pub(crate) fn new() -> Self {
        Self {
            applied_revision: 0,
            applied_config: hyperplayer_engine::dsp_algorithms::DspConfig::default(),
            pending: Some(PendingDspConfiguration {
                revision: 1,
                config: hyperplayer_engine::dsp_algorithms::DspConfig::default(),
            }),
        }
    }

    /// 从持久化配置恢复：以持久化 revision 作为已应用基准，清空 pending（下次配置自
    /// 该 revision 之后递增）。非法（revision 0）由调用方在前置迁移中拦截。
    pub(crate) fn from_persisted(
        revision: u64,
        config: hyperplayer_engine::dsp_algorithms::DspConfig,
    ) -> Self {
        Self {
            applied_revision: revision,
            applied_config: config,
            pending: None,
        }
    }

    pub fn newest_revision(&self) -> u64 {
        self.pending
            .as_ref()
            .map_or(self.applied_revision, |pending| pending.revision)
    }

    pub fn request(
        &mut self,
        revision: u64,
        config: hyperplayer_engine::dsp_algorithms::DspConfig,
    ) {
        self.pending = Some(PendingDspConfiguration { revision, config });
    }

    pub fn promote(&mut self, revision: u64) -> bool {
        let Some(pending) = self.pending.take_if(|pending| pending.revision == revision) else {
            return false;
        };
        self.applied_revision = pending.revision;
        self.applied_config = pending.config;
        true
    }

    pub fn reject(&mut self, revision: u64) -> bool {
        self.pending
            .take_if(|pending| pending.revision == revision)
            .is_some()
    }
}

pub struct AppState {
    pub services: AppServices,
    pub telemetry_sessions: crate::commands::telemetry::TelemetrySessions,
    pub exit_requested: Mutex<bool>,
    pub dsp: Mutex<DspConfigurationState>,
    pub dsp_operation: Mutex<()>,
    location_tickets: Mutex<HashMap<String, LocationTicket>>,
}

struct LocationTicket {
    path: PathBuf,
    window_label: String,
    expires_at: Instant,
}

impl AppState {
    pub fn new(app_data_dir: &Path) -> AppResult<Self> {
        let services = AppServices::new(app_data_dir)?;
        // DSP 配置恢复：以持久化 revision 作为已应用基准，并立即向引擎 apply（进程启动
        // 首次配置）。损坏/版本未知在 SettingsAdapter::open 中已回落 None → 走 default。
        let dsp = Self::restore_dsp(&services)?;
        Ok(Self {
            services,
            telemetry_sessions: crate::commands::telemetry::TelemetrySessions::new(),
            exit_requested: Mutex::new(false),
            dsp: Mutex::new(dsp),
            dsp_operation: Mutex::new(()),
            location_tickets: Mutex::new(HashMap::new()),
        })
    }

    /// 从 settings 恢复 DSP 配置并 apply 到引擎；无有效持久化配置时返回 default 状态。
    ///
    /// 损坏 / 版本未知 / apply 失败均回落 default（fail-close）并输出诊断，不阻断启动。
    fn restore_dsp(services: &AppServices) -> AppResult<DspConfigurationState> {
        let Some(persisted) = services.settings.persisted_dsp_config()? else {
            return Ok(DspConfigurationState::new());
        };
        let config = match persisted.configuration.clone().into_engine_config() {
            Ok(config) => config,
            Err(error) => {
                eprintln!("persisted DSP configuration invalid; falling back to default: {error}");
                return Ok(DspConfigurationState::new());
            }
        };
        // 引擎 apply 失败不得阻断启动：走零 DSP 默认旁路并输出诊断。
        if services
            .playback
            .configure_dsp(persisted.revision, config.clone())
            .is_err()
        {
            eprintln!(
                "restoring persisted DSP configuration (revision {}) failed; falling back to default",
                persisted.revision
            );
            return Ok(DspConfigurationState::new());
        }
        Ok(DspConfigurationState::from_persisted(
            persisted.revision,
            config,
        ))
    }

    pub fn issue_location_ticket(&self, window_label: &str, path: PathBuf) -> AppResult<String> {
        let mut tickets = self
            .location_tickets
            .lock()
            .map_err(|_| crate::error::AppError::StateUnavailable)?;
        let now = Instant::now();
        tickets.retain(|_, ticket| ticket.expires_at > now);
        let token = Uuid::new_v4().to_string();
        tickets.insert(
            token.clone(),
            LocationTicket {
                path,
                window_label: window_label.to_owned(),
                expires_at: now + LOCATION_TICKET_TTL,
            },
        );
        Ok(token)
    }

    pub fn consume_location_ticket(&self, window_label: &str, token: &str) -> AppResult<PathBuf> {
        validate_id(token, "selectionTicket")?;
        let ticket = self
            .location_tickets
            .lock()
            .map_err(|_| crate::error::AppError::StateUnavailable)?
            .remove(token)
            .ok_or_else(|| {
                crate::error::AppError::InvalidArgument(
                    "directory selection ticket is invalid or already used".into(),
                )
            })?;
        if ticket.expires_at <= Instant::now() {
            return Err(crate::error::AppError::Unavailable(
                "directory selection ticket has expired".into(),
            ));
        }
        if ticket.window_label != window_label {
            return Err(crate::error::AppError::Unavailable(
                "directory selection ticket belongs to another window".into(),
            ));
        }
        Ok(ticket.path)
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        Ok(Self {
            services: AppServices::in_memory()?,
            telemetry_sessions: crate::commands::telemetry::TelemetrySessions::new(),
            exit_requested: Mutex::new(false),
            dsp: Mutex::new(DspConfigurationState::new()),
            dsp_operation: Mutex::new(()),
            location_tickets: Mutex::new(HashMap::new()),
        })
    }
}

pub fn validate_id(value: &str, field: &str) -> AppResult<()> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 {
        return Err(crate::error::AppError::InvalidArgument(format!(
            "{field} must contain 1 to 256 characters"
        )));
    }
    Ok(())
}

pub fn validate_track_ref(track: &TrackRefDto) -> AppResult<()> {
    validate_id(&track.id, "track.id")
}

pub fn validate_page(page: &PageRequestDto) -> AppResult<()> {
    if !(1..=100).contains(&page.limit) {
        return Err(crate::error::AppError::InvalidArgument(
            "limit must be between 1 and 100".into(),
        ));
    }
    if let Some(cursor) = &page.cursor {
        validate_id(cursor, "cursor")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paging_is_bounded() {
        assert!(validate_page(&PageRequestDto {
            cursor: None,
            limit: 0
        })
        .is_err());
        assert!(validate_page(&PageRequestDto {
            cursor: None,
            limit: 100
        })
        .is_ok());
        assert!(validate_page(&PageRequestDto {
            cursor: None,
            limit: 101
        })
        .is_err());
    }

    #[test]
    fn location_ticket_is_single_use_and_window_bound() {
        let state = AppState::in_memory().unwrap();
        let token = state
            .issue_location_ticket("main", PathBuf::from("C:\\Music"))
            .unwrap();
        assert!(matches!(
            state.consume_location_ticket("mini-player", &token),
            Err(crate::error::AppError::Unavailable(_))
        ));
        assert!(state.consume_location_ticket("main", &token).is_err());

        let token = state
            .issue_location_ticket("main", PathBuf::from("C:\\Music"))
            .unwrap();
        assert_eq!(
            state.consume_location_ticket("main", &token).unwrap(),
            PathBuf::from("C:\\Music")
        );
        assert!(state.consume_location_ticket("main", &token).is_err());
    }

    #[test]
    fn state_is_explicitly_in_memory() {
        let state = AppState::in_memory().unwrap();
        assert_eq!(state.services.library.overview().unwrap().track_count, 0);
    }

    #[test]
    fn persisted_dsp_restores_revision_as_applied_baseline() {
        let config = hyperplayer_engine::dsp_algorithms::DspConfig::default();
        let state = DspConfigurationState::from_persisted(7, config.clone());
        assert_eq!(state.applied_revision, 7);
        assert_eq!(state.applied_config, config);
        assert!(state.pending.is_none());
        assert_eq!(state.newest_revision(), 7);

        // 恢复后的下一次配置必须高于 7。
        let mut state = state;
        state.request(8, hyperplayer_engine::dsp_algorithms::DspConfig::default());
        assert_eq!(state.newest_revision(), 8);
    }
}
