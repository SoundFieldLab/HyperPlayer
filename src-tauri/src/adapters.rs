use crate::{
    adapter_mapping::{
        netease_album_detail_dto, netease_album_dto, netease_artist_detail_dto,
        netease_artist_summary_dto, netease_chart_dto, netease_cloud_page_dto, netease_comment_dto,
        netease_comment_page_dto, netease_dj_program_dto, netease_dj_radio_dto,
        netease_event_page_dto, netease_listen_report_dto, netease_listen_stats_dto,
        netease_mv_detail_dto, netease_mv_dto, netease_notice_page_dto,
        netease_playlist_detail_dto, netease_playlist_dto, netease_track_dto, netease_user_dto,
        netease_vip_dto, track_dto,
    },
    credential_vault::CredentialVault,
    dto::*,
    error::{AppError, AppResult},
    ports::{
        validate_id, validate_page, validate_track_ref, CachePort, LibraryPort, NeteasePort,
        PlaybackMediaTarget, PlaybackPort, PlaybackTransition, QueuePort, ScanProgressSink,
        SettingsPort, TelemetryFrame as PortTelemetryFrame, TelemetryPort, TelemetrySink,
        TelemetrySubscription, TrackResolverPort,
    },
};
use async_trait::async_trait;
use hyperplayer_engine::{
    actor::{EngineCommand, EngineEvent, EngineEventKind, EngineHandle},
    album::{AlbumSession, QUALIFYING_PLAYBACK_MS},
    cache::{
        authorize_cache, CacheAccessClass, CacheEntry, CacheGateDenial, CacheLease, CacheObject,
        CacheState, ContentAddressedCache, PlaybackAuthorization, Verification,
    },
    library::{
        read_embedded_artwork, ContentAddressedArtwork, LibraryScanner, LoftyMetadataReader,
        MetadataReader, ScanCancellation, ScanFailure,
    },
    model::{MediaId, MediaSource, QueueItem, Track},
    playback::{PlaybackSnapshot, PlaybackState},
    queue::{PlaybackMode, PlaybackQueue, QueueInsertPosition},
    repository::{LibraryTrack, PlaybackHistoryRecord, SqliteRepository},
    telemetry::{TelemetryActivity, TELEMETRY_FRAME_ENCODED_SIZE},
    MediaHandle, TrustedResolvedMedia,
};
use hyperplayer_source_netease::{
    CommentResource, HttpRequest, HttpResponse, LoginQrState, NeteaseService, PageRequest,
    PlayInfo, QualityPreference, SearchKind, Session, Transport, UserAccount, VipInfo,
};
use rand::{rngs::OsRng, CryptoRng, RngCore};
use reqwest::{redirect::Policy, Client, Response};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Seek, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroize;

#[cfg(test)]
use hyperplayer_source_netease::{Album, Artist, PlaylistSummary};

const ENGINE_COMMAND_CAPACITY: usize = 64;
const SHUFFLE_SEED: u64 = 0x4859_5045_5250_4c59;
const KNOWN_CACHE_QUALITIES: &[&str] = &[
    "standard", "higher", "exhigh", "lossless", "hires", "jyeffect", "sky", "jymaster",
];
const NETEASE_MUTATION_TTL: Duration = Duration::from_secs(60);
const NETEASE_SESSION_TTL: Duration = Duration::from_secs(180 * 24 * 60 * 60);
const NETEASE_SESSION_SCHEMA_VERSION: u8 = 1;
const NETEASE_FM_TARGET_COUNT: usize = 12;
const NETEASE_FM_MAX_BATCHES: usize = 3;
const MAX_CONCURRENT_SCANS: usize = 2;
const MAX_SCANS_PER_ROOT: usize = 1;
const MAX_CACHE_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CONCURRENT_CACHE_DOWNLOADS: usize = 3;
const MAX_MEDIA_REDIRECTS: usize = 5;
const MAX_NETEASE_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_NETEASE_IMAGE_REDIRECTS: usize = 3;
const NETEASE_IMAGE_MIME_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/gif"];

type Repository = Arc<Mutex<SqliteRepository>>;

trait AppMutex<T> {
    fn app_lock(&self) -> AppResult<MutexGuard<'_, T>>;
}

impl<T> AppMutex<T> for Mutex<T> {
    fn app_lock(&self) -> AppResult<MutexGuard<'_, T>> {
        self.lock().map_err(|_| AppError::StateUnavailable)
    }
}

struct EngineView {
    volume: f32,
    next_queue_id: u64,
}

struct PlaybackHistorySession {
    queue_id: u64,
    record_id: u64,
    last_position_ms: u64,
    last_persisted_position_ms: u64,
}

struct AlbumSessionState {
    album_id: String,
    current_queue_id: u64,
    last_position_ms: u64,
    current_duration_ms: Option<u64>,
    effective_playback_ms: u64,
    completed_tracks: u32,
    leased: Vec<(String, CacheLease)>,
    requested: Vec<MediaId>,
    recorded: bool,
}

#[derive(Clone)]
pub struct PrefetchRequest {
    pub track: TrackRefDto,
    pub quality: String,
}

pub struct EngineAdapter {
    handle: EngineHandle,
    repository: Repository,
    view: Mutex<EngineView>,
    playback_context: Mutex<PlaybackContextDto>,
    playback_history: Mutex<Option<PlaybackHistorySession>>,
    album_session: Mutex<Option<AlbumSessionState>>,
    prefetch_sender: std::sync::mpsc::SyncSender<PrefetchRequest>,
    restored_media_pending: Mutex<bool>,
    operation: Mutex<()>,
    telemetry_activity: Arc<TelemetryActivityCoordinator>,
}

#[derive(Default)]
struct TelemetryActivityCoordinator {
    next_id: AtomicU64,
    rates: Mutex<HashMap<u64, u8>>,
    effective_rate: AtomicU8,
}

impl TelemetryActivityCoordinator {
    fn register(&self) -> AppResult<u64> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.rates.app_lock()?.insert(id, 0);
        Ok(id)
    }

    fn update(&self, id: u64, rate_hz: u8) -> AppResult<()> {
        let mut rates = self.rates.app_lock()?;
        let rate = rates
            .get_mut(&id)
            .ok_or_else(|| AppError::Unavailable("telemetry subscription is closed".into()))?;
        *rate = rate_hz;
        self.effective_rate.store(
            rates.values().copied().max().unwrap_or(0),
            Ordering::Release,
        );
        Ok(())
    }

    fn unregister(&self, id: u64) {
        if let Ok(mut rates) = self.rates.lock() {
            rates.remove(&id);
            self.effective_rate.store(
                rates.values().copied().max().unwrap_or(0),
                Ordering::Release,
            );
        }
    }
}

struct EngineTelemetrySubscription {
    id: u64,
    activity: Arc<TelemetryActivityCoordinator>,
    cancelled: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl TelemetrySubscription for EngineTelemetrySubscription {
    fn set_activity(&self, rate_hz: u8) -> AppResult<()> {
        telemetry_activity(rate_hz)?;
        self.activity.update(self.id, rate_hz)
    }
}

impl Drop for EngineTelemetrySubscription {
    fn drop(&mut self) {
        self.activity.unregister(self.id);
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

impl EngineAdapter {
    pub fn with_prefetch(
        repository: Repository,
        restore_queue: bool,
        prefetch_sender: std::sync::mpsc::SyncSender<PrefetchRequest>,
    ) -> AppResult<Self> {
        Self::with_handle(
            EngineHandle::spawn(ENGINE_COMMAND_CAPACITY, SHUFFLE_SEED)?,
            repository,
            restore_queue,
            prefetch_sender,
        )
    }

    fn with_handle(
        handle: EngineHandle,
        repository: Repository,
        restore_queue: bool,
        prefetch_sender: std::sync::mpsc::SyncSender<PrefetchRequest>,
    ) -> AppResult<Self> {
        let restored = if restore_queue {
            repository.app_lock()?.load_playback_session()?
        } else {
            None
        };
        let next_queue_id = restored
            .as_ref()
            .map(|session| max_queue_id(&session.queue).saturating_add(1))
            .unwrap_or(1);
        let has_restored_queue = restored.is_some();
        if let Some(session) = restored {
            handle.request(EngineCommand::RestoreQueue {
                snapshot: session.queue.context_snapshot(),
                position_ms: session.position_ms,
                resume: false,
            })?;
        }
        handle.request(EngineCommand::ConfigureDsp {
            revision: 1,
            config: hyperplayer_engine::dsp_algorithms::DspConfig::default(),
        })?;
        Ok(Self {
            handle,
            repository,
            view: Mutex::new(EngineView {
                volume: 1.0,
                next_queue_id,
            }),
            playback_context: Mutex::new(PlaybackContextDto::default()),
            playback_history: Mutex::new(None),
            album_session: Mutex::new(None),
            prefetch_sender,
            restored_media_pending: Mutex::new(has_restored_queue),
            operation: Mutex::new(()),
            telemetry_activity: Arc::new(TelemetryActivityCoordinator::default()),
        })
    }

    fn validate_playback_context(
        media: &TrustedResolvedMedia,
        context: &PlaybackContextDto,
    ) -> AppResult<()> {
        match context.kind {
            PlaybackContextKindDto::Album => {
                let context_id = context
                    .id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        AppError::InvalidArgument("album playback context requires an id".into())
                    })?;
                if media.track.album_id.as_deref() != Some(context_id) {
                    return Err(AppError::InvalidArgument(
                        "album playback context does not match the resolved track".into(),
                    ));
                }
            }
            PlaybackContextKindDto::Playlist => {
                if context
                    .id
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    return Err(AppError::InvalidArgument(
                        "playlist playback context requires an id".into(),
                    ));
                }
            }
            PlaybackContextKindDto::Manual
            | PlaybackContextKindDto::Search
            | PlaybackContextKindDto::PersonalFm => {
                if context.id.is_some() {
                    return Err(AppError::InvalidArgument(
                        "this playback context must not include an id".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn command(&self, command: EngineCommand) -> AppResult<PlaybackSnapshot> {
        self.handle.request(command).map_err(Into::into)
    }

    fn snapshot_dto(&self, snapshot: PlaybackSnapshot) -> AppResult<PlaybackStateDto> {
        let view = self.view.app_lock()?;
        Ok(playback_dto(snapshot, view.volume))
    }

    fn allocate_item(&self, track: Track) -> AppResult<QueueItem> {
        let mut view = self.view.app_lock()?;
        let queue_id = view.next_queue_id;
        view.next_queue_id = view.next_queue_id.saturating_add(1);
        Ok(QueueItem::new(queue_id, track))
    }

    fn commit_snapshot(&self, snapshot: &PlaybackSnapshot) -> AppResult<()> {
        let position_ms = playback_position(&snapshot.state);
        let queue = PlaybackQueue::restore(snapshot.queue.clone()).ok_or_else(|| {
            AppError::Unavailable("engine returned an invalid queue snapshot".into())
        })?;
        self.repository
            .app_lock()?
            .save_playback_session(&queue, position_ms, unix_millis())?;
        Ok(())
    }

    fn engine_dto(&self, snapshot: PlaybackSnapshot) -> AppResult<EngineSnapshotDto> {
        let revision = snapshot.revision;
        let playback = self.snapshot_dto(snapshot.clone())?;
        let queue = self.queue_dto(&snapshot)?;
        let safe_bypass_active = snapshot.dsp_execution.safe_bypass_active;
        debug_assert_eq!(revision, queue.revision);
        Ok(EngineSnapshotDto {
            revision,
            playback,
            queue,
            dsp_execution: DspExecutionStatusDto {
                revision: snapshot.dsp_execution.revision,
                safe_bypass_active,
                fault: snapshot
                    .dsp_execution
                    .fault
                    .map(|fault| DspProcessingFaultDto {
                        revision: fault.revision,
                        processor_index: fault.processor_index,
                        processor_name: fault.processor_name,
                        kind: match fault.kind {
                            hyperplayer_engine::dsp::ProcessorFaultKind::ProcessingFailed => {
                                "processingFailed"
                            }
                            hyperplayer_engine::dsp::ProcessorFaultKind::NonFiniteOutput => {
                                "nonFiniteOutput"
                            }
                        }
                        .into(),
                        stream_frame: fault.stream_frame,
                        safe_bypass_active,
                        fallback_status: DspFallbackStatusDto::RustSafeBypass,
                    }),
            },
        })
    }

    fn execute(&self, command: EngineCommand) -> AppResult<EngineSnapshotDto> {
        let snapshot = self.command(command)?;
        self.update_playback_history(&snapshot)?;
        self.update_album_schedule(&snapshot)?;
        self.commit_snapshot(&snapshot)?;
        self.engine_dto(snapshot)
    }

    fn clear_album_session(&self) -> AppResult<()> {
        let prior = self.album_session.app_lock()?.take();
        if let Some(prior) = prior {
            let repository = self.repository.app_lock()?;
            for (hash, lease) in prior.leased {
                repository.release_cache_lease(&hash, &lease)?;
            }
        }
        Ok(())
    }

    fn update_album_schedule(&self, snapshot: &PlaybackSnapshot) -> AppResult<()> {
        let context = self.playback_context.app_lock()?.clone();
        if context.kind != PlaybackContextKindDto::Album {
            return self.clear_album_session();
        }
        let Some(current) = snapshot.queue.current.as_ref() else {
            return self.clear_album_session();
        };
        let Some(album_id) = current.track.album_id.as_deref() else {
            return self.clear_album_session();
        };
        if context.id.as_deref() != Some(album_id) {
            return self.clear_album_session();
        }
        let current_index = snapshot
            .queue
            .context
            .iter()
            .position(|item| item.queue_id == current.queue_id);
        let next = current_index
            .and_then(|index| snapshot.queue.context.get(index.saturating_add(1)))
            .filter(|item| item.track.album_id.as_deref() == Some(album_id));

        let position_ms = playback_position(&snapshot.state);
        let mut session = self.album_session.app_lock()?;
        let changed_track = session
            .as_ref()
            .is_some_and(|value| value.current_queue_id != current.queue_id);
        if session
            .as_ref()
            .is_none_or(|value| value.album_id != album_id || changed_track)
        {
            let prior = session.take();
            if let Some(previous) = prior.as_ref().filter(|value| value.album_id != album_id) {
                let repository = self.repository.app_lock()?;
                for (hash, lease) in &previous.leased {
                    repository.release_cache_lease(hash, lease)?;
                }
            }
            let completed_tracks = prior
                .as_ref()
                .filter(|value| value.album_id == album_id && changed_track)
                .map_or(0, |value| {
                    let completed = value.current_duration_ms.is_some_and(|duration| {
                        value.last_position_ms.saturating_add(1_000) >= duration
                    });
                    value.completed_tracks.saturating_add(u32::from(completed))
                });
            let effective_playback_ms = prior
                .as_ref()
                .filter(|value| value.album_id == album_id)
                .map_or(0, |value| value.effective_playback_ms);
            *session = Some(AlbumSessionState {
                album_id: album_id.to_owned(),
                current_queue_id: current.queue_id,
                last_position_ms: position_ms,
                current_duration_ms: current.track.duration_ms,
                effective_playback_ms,
                completed_tracks,
                leased: prior
                    .as_ref()
                    .filter(|value| value.album_id == album_id)
                    .map_or_else(Vec::new, |value| value.leased.clone()),
                requested: prior
                    .filter(|value| value.album_id == album_id)
                    .map_or_else(Vec::new, |value| value.requested),
                recorded: false,
            });
        }
        let state = session.as_mut().expect("album session initialized");
        if matches!(snapshot.state, PlaybackState::Playing { .. })
            && position_ms >= state.last_position_ms
        {
            let delta = position_ms - state.last_position_ms;
            if delta <= 2_000 {
                state.effective_playback_ms = state.effective_playback_ms.saturating_add(delta);
            }
        }
        state.last_position_ms = position_ms;

        let mut repository = self.repository.app_lock()?;
        let mut scheduled = vec![current];
        if let Some(next) = next {
            scheduled.push(next);
        }
        let lease = CacheLease::AlbumPrefetch {
            album_id: album_id.to_owned(),
        };
        let mut desired_leases = Vec::new();
        for item in scheduled {
            let entries = repository.cache_entries_for(&item.track.id)?;
            if entries.is_empty() && !state.requested.contains(&item.track.id) {
                let request = PrefetchRequest {
                    track: track_dto(&item.track).track_ref,
                    quality: "standard".into(),
                };
                match self.prefetch_sender.try_send(request) {
                    Ok(()) => state.requested.push(item.track.id.clone()),
                    Err(std::sync::mpsc::TrySendError::Full(_)) => {}
                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                        return Err(AppError::Unavailable(
                            "cache prefetch scheduler is unavailable".into(),
                        ))
                    }
                }
            }
            for entry in entries {
                repository.acquire_cache_lease(&entry.content_hash, &lease, unix_millis())?;
                desired_leases.push((entry.content_hash, lease.clone()));
            }
        }
        for (hash, lease) in state
            .leased
            .iter()
            .filter(|lease| !desired_leases.contains(lease))
        {
            repository.release_cache_lease(hash, lease)?;
        }
        state.leased = desired_leases;
        if !state.recorded
            && (state.completed_tracks >= 1
                || state.effective_playback_ms >= QUALIFYING_PLAYBACK_MS)
        {
            let session = AlbumSession {
                album_id: album_id.to_owned(),
                local_day: chrono::Local::now().date_naive().to_string(),
                from_album_context: true,
                completed_tracks: state.completed_tracks,
                effective_playback_ms: state.effective_playback_ms,
            };
            repository.record_album_session(&session)?;
            state.recorded = true;
        }
        Ok(())
    }

    fn finish_playback_history(&self) -> AppResult<()> {
        let Some(session) = self.playback_history.app_lock()?.take() else {
            return Ok(());
        };
        self.repository
            .app_lock()?
            .update_playback_history_position(session.record_id, session.last_position_ms)
            .map_err(Into::into)
    }

    fn update_playback_history(&self, snapshot: &PlaybackSnapshot) -> AppResult<()> {
        let Some(item) = snapshot.state.current() else {
            return Ok(());
        };
        let position_ms = playback_position(&snapshot.state);
        let mut history = self.playback_history.app_lock()?;
        if history
            .as_ref()
            .is_some_and(|session| session.queue_id == item.queue_id)
        {
            let session = history.as_mut().expect("history session exists");
            session.last_position_ms = match snapshot.state {
                PlaybackState::Stopped { .. } | PlaybackState::Failed { .. } => {
                    session.last_position_ms
                }
                _ => position_ms,
            };
            let terminal = matches!(
                snapshot.state,
                PlaybackState::Stopped { .. } | PlaybackState::Failed { .. }
            );
            let should_persist = terminal
                || matches!(snapshot.state, PlaybackState::Paused { .. })
                || session
                    .last_position_ms
                    .saturating_sub(session.last_persisted_position_ms)
                    >= 5_000;
            if should_persist {
                self.repository
                    .app_lock()?
                    .update_playback_history_position(
                        session.record_id,
                        session.last_position_ms,
                    )?;
                session.last_persisted_position_ms = session.last_position_ms;
            }
            if terminal {
                history.take();
            }
            return Ok(());
        }

        if let Some(previous) = history.take() {
            self.repository
                .app_lock()?
                .update_playback_history_position(previous.record_id, previous.last_position_ms)?;
        }
        if !matches!(snapshot.state, PlaybackState::Playing { .. }) {
            return Ok(());
        }
        let record_id =
            self.repository
                .app_lock()?
                .start_playback_history(&PlaybackHistoryRecord {
                    media_id: item.track.id.clone(),
                    played_unix_ms: unix_millis(),
                    position_ms,
                })?;
        *history = Some(PlaybackHistorySession {
            queue_id: item.queue_id,
            record_id,
            last_position_ms: position_ms,
            last_persisted_position_ms: position_ms,
        });
        Ok(())
    }

    fn queue_dto(&self, snapshot: &PlaybackSnapshot) -> AppResult<QueueSnapshotDto> {
        Ok(QueueSnapshotDto {
            current_item_id: snapshot
                .queue
                .current
                .as_ref()
                .map(|item| item.queue_id.to_string()),
            play_next: snapshot
                .queue
                .priority
                .iter()
                .map(queue_item_from_engine)
                .collect(),
            context: snapshot
                .queue
                .context
                .iter()
                .map(queue_item_from_engine)
                .collect(),
            revision: snapshot.revision,
        })
    }
}

impl PlaybackPort for EngineAdapter {
    fn state(&self) -> AppResult<PlaybackStateDto> {
        self.snapshot_dto(self.handle.snapshot()?)
    }

    fn engine_snapshot(&self) -> AppResult<EngineSnapshotDto> {
        self.engine_dto(self.handle.snapshot()?)
    }

    fn play_resolved(
        &self,
        media: Option<TrustedResolvedMedia>,
        context: PlaybackContextDto,
    ) -> AppResult<EngineSnapshotDto> {
        let _guard = self.operation.app_lock()?;
        let has_new_media = media.is_some();
        if let Some(media) = media.as_ref() {
            Self::validate_playback_context(media, &context)?;
        }
        let snapshot = if let Some(media) = media {
            let item = self.allocate_item(media.track.clone())?;
            self.command(EngineCommand::LoadContext {
                items: vec![item],
                start_index: 0,
                media,
            })?;
            self.command(EngineCommand::Ready)?
        } else {
            let current = self.handle.snapshot()?;
            match current.state {
                PlaybackState::Paused { .. } => self.command(EngineCommand::Resume)?,
                PlaybackState::Loading { .. } => self.command(EngineCommand::Ready)?,
                PlaybackState::Playing { .. } => current,
                _ => {
                    return Err(AppError::Unavailable(
                        "no resumable engine item is loaded".into(),
                    ))
                }
            }
        };
        if has_new_media {
            *self.restored_media_pending.app_lock()? = false;
            self.finish_playback_history()?;
            *self.playback_context.app_lock()? = context;
            self.clear_album_session()?;
        } else if *self.restored_media_pending.app_lock()? {
            *self.restored_media_pending.app_lock()? = false;
        }
        self.update_playback_history(&snapshot)?;
        self.update_album_schedule(&snapshot)?;
        self.commit_snapshot(&snapshot)?;
        self.engine_dto(snapshot)
    }

    fn restored_media_targets(&self) -> AppResult<Vec<(u64, TrackRefDto)>> {
        if !*self.restored_media_pending.app_lock()? {
            return Ok(Vec::new());
        }
        let snapshot = self.handle.snapshot()?;
        let Some(current) = snapshot.queue.current.clone() else {
            return Ok(Vec::new());
        };
        let mut targets = vec![(current.queue_id, track_dto(&current.track).track_ref)];
        let queue = PlaybackQueue::restore(snapshot.queue).ok_or_else(|| {
            AppError::Unavailable("engine returned an invalid queue snapshot".into())
        })?;
        if let Some(next) = queue.peek_next(true) {
            if next.queue_id != current.queue_id {
                targets.push((next.queue_id, track_dto(&next.track).track_ref));
            }
        }
        Ok(targets)
    }

    fn transition_media_targets(
        &self,
        transition: PlaybackTransition,
    ) -> AppResult<Vec<PlaybackMediaTarget>> {
        let snapshot = self.handle.snapshot()?;
        let mut queue = PlaybackQueue::restore(snapshot.queue).ok_or_else(|| {
            AppError::Unavailable("engine returned an invalid queue snapshot".into())
        })?;
        let target = match transition {
            PlaybackTransition::Next { automatic } => queue.peek_next(automatic).cloned(),
            PlaybackTransition::Previous => queue.traversal_history().last().cloned(),
        }
        .ok_or_else(|| AppError::Unavailable("queue has no transition target".into()))?;
        match transition {
            PlaybackTransition::Next { automatic } => {
                queue.advance(automatic);
            }
            PlaybackTransition::Previous => {
                queue.previous();
            }
        }
        let mut targets = vec![PlaybackMediaTarget {
            queue_id: target.queue_id,
            track: track_dto(&target.track).track_ref,
        }];
        if let Some(following) = queue.peek_next(true) {
            if following.queue_id != target.queue_id {
                targets.push(PlaybackMediaTarget {
                    queue_id: following.queue_id,
                    track: track_dto(&following.track).track_ref,
                });
            }
        }
        Ok(targets)
    }

    fn attach_restored_media(&self, media: Vec<(u64, TrustedResolvedMedia)>) -> AppResult<()> {
        if media.is_empty() {
            return Err(AppError::InvalidArgument(
                "restored queue media cannot be empty".into(),
            ));
        }
        let _guard = self.operation.app_lock()?;
        self.command(EngineCommand::AttachResolvedMedia { media })?;
        Ok(())
    }

    fn pause(&self) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::Pause)
    }

    fn stop(&self) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::Stop)
    }

    fn next(&self, expected_queue_id: u64, automatic: bool) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::Next {
            automatic,
            expected_queue_id,
        })
    }

    fn previous(&self, expected_queue_id: u64) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::Previous { expected_queue_id })
    }

    fn seek(&self, position_ms: u64) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::Seek(position_ms))
    }

    fn set_volume(&self, volume: f32) -> AppResult<EngineSnapshotDto> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err(AppError::InvalidArgument(
                "volume must be between 0 and 1".into(),
            ));
        }
        let snapshot = self.command(EngineCommand::SetVolume(volume))?;
        self.view.app_lock()?.volume = volume;
        self.engine_dto(snapshot)
    }

    fn configure_dsp(
        &self,
        revision: u64,
        config: hyperplayer_engine::dsp_algorithms::DspConfig,
    ) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::ConfigureDsp { revision, config })
    }

    fn set_repeat_mode(&self, mode: RepeatModeDto) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::SetMode(engine_mode(mode)))
    }

    fn subscribe_events(&self) -> AppResult<std::sync::mpsc::Receiver<EngineEvent>> {
        self.handle.subscribe_events(8).map_err(Into::into)
    }

    fn event_dto(&self, event: EngineEvent) -> AppResult<(EngineEventKind, EngineSnapshotDto)> {
        self.update_playback_history(&event.snapshot)?;
        self.update_album_schedule(&event.snapshot)?;
        self.commit_snapshot(&event.snapshot)?;
        Ok((event.kind, self.engine_dto(event.snapshot)?))
    }
}

impl TelemetryPort for EngineAdapter {
    fn subscribe(&self, sink: TelemetrySink) -> AppResult<Box<dyn TelemetrySubscription>> {
        let subscriber = self.handle.subscribe_telemetry();
        let id = self.telemetry_activity.register()?;
        let activity = self.telemetry_activity.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let worker_activity = activity.clone();
        let worker = thread::Builder::new()
            .name(format!("hyperplayer-engine-telemetry-{id}"))
            .spawn(move || {
                while !worker_cancelled.load(Ordering::Acquire) {
                    let rate_hz = worker_activity.effective_rate.load(Ordering::Acquire);
                    subscriber.set_activity(
                        telemetry_activity(rate_hz).unwrap_or(TelemetryActivity::Inactive),
                    );
                    if let Some(frame) = subscriber.latest() {
                        let encoded = frame.encode();
                        debug_assert_eq!(encoded.len(), TELEMETRY_FRAME_ENCODED_SIZE);
                        sink(PortTelemetryFrame {
                            payload: encoded.to_vec(),
                        });
                    } else {
                        thread::sleep(Duration::from_millis(2));
                    }
                }
            });
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => {
                activity.unregister(id);
                return Err(error.into());
            }
        };
        Ok(Box::new(EngineTelemetrySubscription {
            id,
            activity,
            cancelled,
            worker: Mutex::new(Some(worker)),
        }))
    }
}

fn telemetry_activity(rate_hz: u8) -> AppResult<TelemetryActivity> {
    match rate_hz {
        0 => Ok(TelemetryActivity::Inactive),
        2 => Ok(TelemetryActivity::Minimal2Hz),
        15 => Ok(TelemetryActivity::Reduced15Hz),
        30 => Ok(TelemetryActivity::Active30Hz),
        _ => Err(AppError::InvalidArgument(
            "rateHz must be one of 0, 2, 15, or 30".into(),
        )),
    }
}

impl QueuePort for EngineAdapter {
    fn snapshot(&self) -> AppResult<QueueSnapshotDto> {
        self.queue_dto(&self.handle.snapshot()?)
    }

    fn enqueue_resolved(
        &self,
        media: TrustedResolvedMedia,
        position: QueueInsertPositionDto,
    ) -> AppResult<EngineSnapshotDto> {
        let item = self.allocate_item(media.track.clone())?;
        let position = match position {
            QueueInsertPositionDto::PlayNext => QueueInsertPosition::PlayNext,
            QueueInsertPositionDto::ContextEnd => QueueInsertPosition::ContextEnd,
        };
        self.execute(EngineCommand::Enqueue {
            item,
            position,
            media,
        })
    }

    fn remove(&self, queue_item_id: &str) -> AppResult<EngineSnapshotDto> {
        let queue_id = parse_queue_id(queue_item_id)?;
        self.execute(EngineCommand::Remove { queue_id })
    }

    fn reorder(&self, request: ReorderQueueRequestDto) -> AppResult<EngineSnapshotDto> {
        let queue_id = parse_queue_id(&request.queue_item_id)?;
        self.execute(EngineCommand::Reorder {
            queue_id,
            target_index: request.target_index,
        })
    }

    fn clear_play_next(&self) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::ClearPriority)
    }

    fn clear_all(&self) -> AppResult<EngineSnapshotDto> {
        self.execute(EngineCommand::ClearAll)
    }
}

pub struct LocationRegistry {
    connection: Mutex<Connection>,
}

impl LocationRegistry {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> AppResult<Self> {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS library_locations (
                id TEXT PRIMARY KEY NOT NULL,
                canonical_path TEXT NOT NULL UNIQUE
            );",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn register(&self, path: &Path) -> AppResult<LibraryLocationDto> {
        let canonical = canonical_directory(path)?;
        let encoded = canonical.to_string_lossy().into_owned();
        let id = format!("location-{:016x}", stable_hash(&encoded.to_lowercase()));
        self.connection.app_lock()?.execute(
            "INSERT INTO library_locations(id, canonical_path) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET canonical_path=excluded.canonical_path",
            params![id, encoded],
        )?;
        Ok(LibraryLocationDto {
            id,
            path: canonical.to_string_lossy().into_owned(),
        })
    }

    pub fn unregister(&self, id: &str) -> AppResult<bool> {
        Ok(self
            .connection
            .app_lock()?
            .execute("DELETE FROM library_locations WHERE id = ?1", [id])?
            == 1)
    }

    pub fn all(&self) -> AppResult<Vec<PathBuf>> {
        let connection = self.connection.app_lock()?;
        let mut statement = connection
            .prepare("SELECT canonical_path FROM library_locations ORDER BY canonical_path")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0).map(PathBuf::from))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn resolve_many(&self, ids: &[String]) -> AppResult<Vec<PathBuf>> {
        if ids.is_empty() {
            return Err(AppError::InvalidArgument(
                "at least one registered locationId is required".into(),
            ));
        }
        let connection = self.connection.app_lock()?;
        ids.iter()
            .map(|id| {
                validate_id(id, "locationId")?;
                connection
                    .query_row(
                        "SELECT canonical_path FROM library_locations WHERE id = ?1",
                        [id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        AppError::InvalidArgument(format!("locationId is not registered: {id}"))
                    })
            })
            .collect()
    }

    fn contains_file(&self, path: &Path) -> AppResult<bool> {
        let canonical = path.canonicalize().map_err(|_| {
            AppError::Unavailable("the registered local track file is unavailable".into())
        })?;
        let connection = self.connection.app_lock()?;
        let mut statement = connection.prepare("SELECT canonical_path FROM library_locations")?;
        let roots = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(roots
            .into_iter()
            .map(PathBuf::from)
            .any(|root| canonical.starts_with(root)))
    }
}

pub struct OfficialPlaybackResource {
    track: Track,
    url: String,
    authorization: PlaybackAuthorization,
}

#[async_trait]
pub trait PlaybackMediaBackend: Send + Sync {
    async fn resolve_official(&self, track: &TrackRefDto) -> AppResult<OfficialPlaybackResource>;
    async fn refresh_authorization(&self, entry: &CacheEntry) -> AppResult<PlaybackAuthorization>;
    async fn stream_official(&self, url: &str, destination: &mut std::fs::File) -> AppResult<()>;
}

pub struct TrackResolver {
    repository: Repository,
    locations: Arc<LocationRegistry>,
    backend: Arc<dyn PlaybackMediaBackend>,
    store: ContentAddressedCache,
    temporary_root: PathBuf,
}

impl TrackResolver {
    pub fn new(
        repository: Repository,
        locations: Arc<LocationRegistry>,
        backend: Arc<dyn PlaybackMediaBackend>,
        cache_root: PathBuf,
        temporary_root: PathBuf,
    ) -> AppResult<Self> {
        fs::create_dir_all(&temporary_root)?;
        Ok(Self {
            repository,
            locations,
            backend,
            store: ContentAddressedCache::new(cache_root)?,
            temporary_root,
        })
    }

    fn resolve_local(&self, track: &TrackRefDto) -> AppResult<TrustedResolvedMedia> {
        let record = self
            .repository
            .app_lock()?
            .track_by_id(&MediaId::new(&track.id))?
            .ok_or_else(|| AppError::Unavailable("local track id is not in the library".into()))?;
        if !self.locations.contains_file(&record.path)? {
            return Err(AppError::Unavailable(
                "local track is outside every registered library location".into(),
            ));
        }
        let canonical = record.path.canonicalize().map_err(|_| {
            AppError::Unavailable("the registered local track file is unavailable".into())
        })?;
        let mut resolved = record.track;
        resolved.source = MediaSource::Local {
            path: canonical.clone(),
        };
        let file = std::fs::File::open(&canonical)?;
        Ok(TrustedResolvedMedia::new(
            resolved,
            MediaHandle::local(file, canonical),
        ))
    }

    fn open_authorized_cache(
        &self,
        track: &TrackRefDto,
        authorization: &PlaybackAuthorization,
    ) -> AppResult<Option<MediaHandle>> {
        let entries = self
            .repository
            .app_lock()?
            .cache_entries_for(&MediaId::new(&track.id))?;
        let mut denial = None;
        for entry in entries {
            match authorize_cache(&entry, authorization) {
                Ok(()) => {
                    let path = self.store.object_path(&entry.content_hash)?;
                    let file = self.store.open(&entry.content_hash)?;
                    let backend = self.backend.clone();
                    let guarded_entry = entry.clone();
                    let authorize_read = Arc::new(move || {
                        let authorization = tauri::async_runtime::block_on(
                            backend.refresh_authorization(&guarded_entry),
                        )
                        .map_err(|error| {
                            hyperplayer_engine::EngineError::InvalidInput(error.to_string())
                        })?;
                        authorize_cache(&guarded_entry, &authorization).map_err(|denial| {
                            hyperplayer_engine::EngineError::InvalidInput(
                                cache_denial(denial).into(),
                            )
                        })
                    });
                    return Ok(Some(MediaHandle::guarded_private_cache(
                        file,
                        path,
                        authorize_read,
                    )));
                }
                Err(reason) => denial = Some(reason),
            }
        }
        if let Some(denial) = denial {
            return Err(AppError::Unavailable(cache_denial(denial).into()));
        }
        Ok(None)
    }

    async fn resolve_netease(&self, track: &TrackRefDto) -> AppResult<TrustedResolvedMedia> {
        let official = self.backend.resolve_official(track).await?;
        if official.authorization.official_full_playback != Verification::Confirmed {
            return Err(AppError::Unavailable(
                "official full-track playback was not confirmed".into(),
            ));
        }
        if let Some(handle) = self.open_authorized_cache(track, &official.authorization)? {
            return Ok(TrustedResolvedMedia::new(official.track, handle));
        }

        let path = self
            .temporary_root
            .join(format!("playback-{}.media", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).read(true).write(true);
        let mut file = options.open(&path)?;
        if let Err(error) = self.backend.stream_official(&official.url, &mut file).await {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        file.flush()?;
        file.rewind()?;
        Ok(TrustedResolvedMedia::new(
            official.track,
            MediaHandle::private_temporary(file, path),
        ))
    }
}

#[async_trait]
impl TrackResolverPort for TrackResolver {
    async fn resolve(&self, track: &TrackRefDto) -> AppResult<TrustedResolvedMedia> {
        validate_track_ref(track)?;
        match track.source {
            TrackSourceDto::Local => self.resolve_local(track),
            TrackSourceDto::Netease => self.resolve_netease(track).await,
        }
    }
}

struct ActiveScan {
    cancellation: Arc<ScanCancellation>,
    roots: Vec<PathBuf>,
}

struct ActiveScanGuard {
    scans: Arc<Mutex<HashMap<String, ActiveScan>>>,
    task_id: String,
}

impl Drop for ActiveScanGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.scans.lock() {
            active.remove(&self.task_id);
        }
    }
}

pub struct LibraryAdapter {
    repository: Repository,
    locations: Arc<LocationRegistry>,
    artwork: ContentAddressedArtwork,
    scans: Arc<Mutex<HashMap<String, ActiveScan>>>,
}

impl LibraryAdapter {
    pub fn new(
        repository: Repository,
        locations: Arc<LocationRegistry>,
        artwork_root: PathBuf,
    ) -> AppResult<Self> {
        Ok(Self {
            repository,
            locations,
            artwork: ContentAddressedArtwork::new(artwork_root)?,
            scans: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn all_tracks(&self) -> AppResult<Vec<hyperplayer_engine::repository::LibraryTrack>> {
        let repository = self.repository.app_lock()?;
        let mut offset = 0;
        let mut tracks = Vec::new();
        loop {
            let page = repository.list_tracks(500, offset)?;
            let count = page.len();
            tracks.extend(page);
            if count < 500 {
                return Ok(tracks);
            }
            offset += 500;
        }
    }

    fn entity_tracks(
        &self,
        request: LibraryEntityTracksRequestDto,
        query: impl FnOnce(
            &SqliteRepository,
            &str,
            u32,
            u32,
        ) -> hyperplayer_engine::Result<
            hyperplayer_engine::repository::Page<hyperplayer_engine::repository::LibraryTrack>,
        >,
    ) -> AppResult<LibraryPageDto> {
        validate_id(&request.id, "id")?;
        validate_page(&request.page)?;
        let offset = parse_cursor(request.page.cursor.as_deref())?;
        let repository = self.repository.app_lock()?;
        let page = query(
            &repository,
            &request.id,
            u32::from(request.page.limit),
            u32::try_from(offset)
                .map_err(|_| AppError::InvalidArgument("cursor is too large".into()))?,
        )?;
        let next = offset + page.items.len();
        Ok(LibraryPageDto {
            items: page
                .items
                .iter()
                .map(|item| track_dto(&item.track))
                .collect(),
            next_cursor: (next < page.total as usize).then(|| next.to_string()),
            total: page.total,
        })
    }
}

impl LibraryPort for LibraryAdapter {
    fn overview(&self) -> AppResult<LibraryOverviewDto> {
        let tracks = self.all_tracks()?;
        let albums = tracks
            .iter()
            .filter_map(|item| item.track.album.as_deref())
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        let artists = tracks
            .iter()
            .flat_map(|item| item.track.artists.iter().map(String::as_str))
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        Ok(LibraryOverviewDto {
            track_count: tracks.len() as u64,
            album_count: albums as u64,
            artist_count: artists as u64,
            scan_active: self.has_active_tasks(),
        })
    }

    fn query_tracks(&self, request: LibraryQueryDto) -> AppResult<LibraryPageDto> {
        validate_page(&request.page)?;
        let offset = parse_cursor(request.page.cursor.as_deref())?;
        let search = request
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let all = self.all_tracks()?;
        let filtered: Vec<_> = all
            .into_iter()
            .filter(|item| {
                search.is_none_or(|needle| {
                    let needle = needle.to_lowercase();
                    item.track.title.to_lowercase().contains(&needle)
                        || item
                            .track
                            .artists
                            .iter()
                            .any(|artist| artist.to_lowercase().contains(&needle))
                        || item
                            .track
                            .album
                            .as_ref()
                            .is_some_and(|album| album.to_lowercase().contains(&needle))
                })
            })
            .collect();
        let total = filtered.len();
        let end = (offset + usize::from(request.page.limit)).min(total);
        let items = filtered[offset.min(total)..end]
            .iter()
            .map(|item| track_dto(&item.track))
            .collect();
        Ok(LibraryPageDto {
            items,
            next_cursor: (end < total).then(|| end.to_string()),
            total: total as u64,
        })
    }

    fn query_albums(&self, request: LibraryQueryDto) -> AppResult<EntityPageDto<LibraryAlbumDto>> {
        validate_page(&request.page)?;
        let offset = parse_cursor(request.page.cursor.as_deref())?;
        let page = self.repository.app_lock()?.query_albums(
            request.search.as_deref(),
            u32::from(request.page.limit),
            u32::try_from(offset)
                .map_err(|_| AppError::InvalidArgument("cursor is too large".into()))?,
        )?;
        let next = offset + page.items.len();
        Ok(EntityPageDto {
            items: page
                .items
                .into_iter()
                .map(|item| LibraryAlbumDto {
                    id: item.id,
                    title: item.title,
                    artists: item.artists,
                    track_count: item.track_count,
                    artwork_hash: item.artwork_hash,
                })
                .collect(),
            next_cursor: (next < page.total as usize).then(|| next.to_string()),
            total: page.total,
        })
    }

    fn query_artists(
        &self,
        request: LibraryQueryDto,
    ) -> AppResult<EntityPageDto<LibraryArtistDto>> {
        validate_page(&request.page)?;
        let offset = parse_cursor(request.page.cursor.as_deref())?;
        let page = self.repository.app_lock()?.query_artists(
            request.search.as_deref(),
            u32::from(request.page.limit),
            u32::try_from(offset)
                .map_err(|_| AppError::InvalidArgument("cursor is too large".into()))?,
        )?;
        let next = offset + page.items.len();
        Ok(EntityPageDto {
            items: page
                .items
                .into_iter()
                .map(|item| LibraryArtistDto {
                    id: item.id,
                    name: item.name,
                    track_count: item.track_count,
                    album_count: item.album_count,
                    artwork_hash: item.artwork_hash,
                })
                .collect(),
            next_cursor: (next < page.total as usize).then(|| next.to_string()),
            total: page.total,
        })
    }

    fn query_folders(
        &self,
        request: LibraryQueryDto,
    ) -> AppResult<EntityPageDto<LibraryFolderDto>> {
        validate_page(&request.page)?;
        let offset = parse_cursor(request.page.cursor.as_deref())?;
        let page = self.repository.app_lock()?.query_folders(
            request.search.as_deref(),
            u32::from(request.page.limit),
            u32::try_from(offset)
                .map_err(|_| AppError::InvalidArgument("cursor is too large".into()))?,
        )?;
        let next = offset + page.items.len();
        Ok(EntityPageDto {
            items: page
                .items
                .into_iter()
                .map(|item| LibraryFolderDto {
                    id: item.id,
                    name: item.name,
                    track_count: item.track_count,
                })
                .collect(),
            next_cursor: (next < page.total as usize).then(|| next.to_string()),
            total: page.total,
        })
    }

    fn query_recent(&self, page: PageRequestDto) -> AppResult<EntityPageDto<LibraryRecentDto>> {
        validate_page(&page)?;
        let offset = parse_cursor(page.cursor.as_deref())?;
        let result = self.repository.app_lock()?.query_recent(
            u32::from(page.limit),
            u32::try_from(offset)
                .map_err(|_| AppError::InvalidArgument("cursor is too large".into()))?,
        )?;
        let next = offset + result.items.len();
        Ok(EntityPageDto {
            items: result
                .items
                .into_iter()
                .map(|item| LibraryRecentDto {
                    track: track_dto(&item.track.track),
                    played_unix_ms: item.played_unix_ms,
                    position_ms: item.position_ms,
                })
                .collect(),
            next_cursor: (next < result.total as usize).then(|| next.to_string()),
            total: result.total,
        })
    }

    fn query_playlists(
        &self,
        request: LibraryQueryDto,
    ) -> AppResult<EntityPageDto<LibraryPlaylistDto>> {
        validate_page(&request.page)?;
        let offset = parse_cursor(request.page.cursor.as_deref())?;
        let page = self.repository.app_lock()?.query_playlists(
            request.search.as_deref(),
            u32::from(request.page.limit),
            u32::try_from(offset)
                .map_err(|_| AppError::InvalidArgument("cursor is too large".into()))?,
        )?;
        let next = offset + page.items.len();
        Ok(EntityPageDto {
            items: page
                .items
                .into_iter()
                .map(|item| LibraryPlaylistDto {
                    id: item.id,
                    name: item.name,
                    track_count: item.track_count,
                    updated_unix_ms: item.updated_unix_ms,
                })
                .collect(),
            next_cursor: (next < page.total as usize).then(|| next.to_string()),
            total: page.total,
        })
    }

    fn create_playlist(&self, name: &str) -> AppResult<LibraryPlaylistDto> {
        let id = format!("local-playlist-{}", Uuid::new_v4());
        let now = unix_millis();
        self.repository
            .app_lock()?
            .create_playlist(&id, name, now)?;
        Ok(LibraryPlaylistDto {
            id,
            name: name.trim().to_owned(),
            track_count: 0,
            updated_unix_ms: now,
        })
    }

    fn rename_playlist(&self, id: &str, name: &str) -> AppResult<LibraryPlaylistDto> {
        validate_id(id, "playlistId")?;
        let now = unix_millis();
        let repository = self.repository.app_lock()?;
        repository.rename_playlist(id, name, now)?;
        repository
            .playlist_by_id(id)?
            .map(|playlist| LibraryPlaylistDto {
                id: playlist.id,
                name: playlist.name,
                track_count: playlist.track_count,
                updated_unix_ms: playlist.updated_unix_ms,
            })
            .ok_or_else(|| AppError::Unavailable("playlist disappeared after rename".into()))
    }

    fn delete_playlist(&self, id: &str) -> AppResult<()> {
        validate_id(id, "playlistId")?;
        self.repository.app_lock()?.delete_playlist(id)?;
        Ok(())
    }

    fn add_playlist_track(&self, playlist_id: &str, track_id: &str) -> AppResult<()> {
        validate_id(playlist_id, "playlistId")?;
        validate_id(track_id, "trackId")?;
        self.repository.app_lock()?.add_playlist_track(
            playlist_id,
            &MediaId::new(track_id),
            unix_millis(),
        )?;
        Ok(())
    }

    fn remove_playlist_track(&self, playlist_id: &str, track_id: &str) -> AppResult<()> {
        validate_id(playlist_id, "playlistId")?;
        validate_id(track_id, "trackId")?;
        self.repository.app_lock()?.remove_playlist_track(
            playlist_id,
            &MediaId::new(track_id),
            unix_millis(),
        )?;
        Ok(())
    }

    fn reorder_playlist_track(
        &self,
        playlist_id: &str,
        track_id: &str,
        target_position: u32,
    ) -> AppResult<()> {
        validate_id(playlist_id, "playlistId")?;
        validate_id(track_id, "trackId")?;
        self.repository.app_lock()?.reorder_playlist_track(
            playlist_id,
            &MediaId::new(track_id),
            target_position,
            unix_millis(),
        )?;
        Ok(())
    }

    fn album_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto> {
        self.entity_tracks(request, |repository, id, limit, offset| {
            repository.album_tracks(id, limit, offset)
        })
    }

    fn artist_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto> {
        self.entity_tracks(request, |repository, id, limit, offset| {
            repository.artist_tracks(id, limit, offset)
        })
    }

    fn folder_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto> {
        self.entity_tracks(request, |repository, id, limit, offset| {
            repository.folder_tracks(id, limit, offset)
        })
    }

    fn playlist_tracks(&self, request: LibraryEntityTracksRequestDto) -> AppResult<LibraryPageDto> {
        self.entity_tracks(request, |repository, id, limit, offset| {
            repository.playlist_tracks(id, limit, offset)
        })
    }

    fn artwork(&self, content_hash: &str) -> AppResult<LibraryArtworkDto> {
        let bytes = self.artwork.read(content_hash)?;
        let mime_type = match bytes.get(..12) {
            Some(bytes) if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
            Some(bytes) if bytes.starts_with(b"\xff\xd8\xff") => "image/jpeg",
            Some(bytes) if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" => "image/webp",
            _ => "application/octet-stream",
        };
        Ok(LibraryArtworkDto {
            content_hash: content_hash.to_owned(),
            mime_type: mime_type.into(),
            bytes,
        })
    }

    fn reread_tags(&self, track_id: &str) -> AppResult<TrackDto> {
        validate_id(track_id, "trackId")?;
        let id = MediaId::new(track_id);
        let path = self
            .repository
            .app_lock()?
            .media_path(&id)?
            .ok_or_else(|| AppError::Unavailable("track is not in the library".into()))?;
        let mut track = LoftyMetadataReader.read(&path)?;
        if let Some(artwork) = read_embedded_artwork(&path)? {
            self.artwork.store(&artwork)?;
            track.track.artwork_hash = Some(artwork.content_hash);
            track.track.artwork_mime = Some(artwork.mime_type);
        }
        self.repository.app_lock()?.upsert_track(&track)?;
        Ok(track_dto(&track.track))
    }

    fn remove_from_library(&self, track_id: &str) -> AppResult<LibraryMutationResultDto> {
        validate_id(track_id, "trackId")?;
        let removed = self
            .repository
            .app_lock()?
            .remove_track(&MediaId::new(track_id))?;
        Ok(LibraryMutationResultDto {
            removed_from_library: removed,
            moved_to_recycle_bin: false,
        })
    }

    fn move_to_recycle_bin(&self, track_id: &str) -> AppResult<LibraryMutationResultDto> {
        validate_id(track_id, "trackId")?;
        let media_id = MediaId::new(track_id);
        let path = self
            .repository
            .app_lock()?
            .track_by_id(&media_id)?
            .map(|record| record.path)
            .ok_or_else(|| AppError::Unavailable("local track is not in the library".into()))?;
        if !self.locations.contains_file(&path)? {
            return Err(AppError::Unavailable(
                "local track is outside every registered library location".into(),
            ));
        }
        crate::platform::windows::move_file_to_recycle_bin(&path)?;
        let removed = self.repository.app_lock()?.remove_track(&media_id)?;
        Ok(LibraryMutationResultDto {
            removed_from_library: removed,
            moved_to_recycle_bin: true,
        })
    }

    fn register_location(&self, path: &Path) -> AppResult<LibraryLocationDto> {
        let location = self.locations.register(path)?;
        if let Err(error) = self
            .repository
            .app_lock()?
            .register_library_root(Path::new(&location.path))
        {
            let _ = self.locations.unregister(&location.id);
            return Err(error.into());
        }
        Ok(location)
    }

    fn start_scan(
        &self,
        request: LibraryScanRequestDto,
        progress: ScanProgressSink,
    ) -> AppResult<TaskAcceptedDto> {
        let roots = self.locations.resolve_many(&request.location_ids)?;
        let task_id = Uuid::new_v4().to_string();
        let cancellation = Arc::new(ScanCancellation::default());
        {
            let mut scans = self.scans.app_lock()?;
            if scans.len() >= MAX_CONCURRENT_SCANS {
                return Err(AppError::Unavailable(
                    "the global library scan concurrency limit has been reached".into(),
                ));
            }
            if roots.iter().any(|root| {
                scans
                    .values()
                    .filter(|scan| scan.roots.contains(root))
                    .count()
                    >= MAX_SCANS_PER_ROOT
            }) {
                return Err(AppError::Unavailable(
                    "a scan is already active for one of the requested locations".into(),
                ));
            }
            scans.insert(
                task_id.clone(),
                ActiveScan {
                    cancellation: cancellation.clone(),
                    roots: roots.clone(),
                },
            );
        }
        let repository = self.repository.clone();
        let artwork = self.artwork.clone();
        let scans = self.scans.clone();
        let worker_task_id = task_id.clone();
        let spawn_result = thread::Builder::new()
            .name(format!("scan-{worker_task_id}"))
            .spawn(move || {
                let _active_scan = ActiveScanGuard {
                    scans,
                    task_id: worker_task_id.clone(),
                };
                progress(ScanProgressDto {
                    task_id: worker_task_id.clone(),
                    completed: 0,
                    total: None,
                    phase: "discovering".into(),
                });
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    scan_registered_roots(
                        &roots,
                        &cancellation,
                        &worker_task_id,
                        &progress,
                        &repository,
                        &artwork,
                    )
                }));
                let phase = match result {
                    Ok(Ok(true)) => "complete",
                    Ok(Ok(false)) => "cancelled",
                    Ok(Err(_)) | Err(_) => "failed",
                };
                progress(ScanProgressDto {
                    task_id: worker_task_id.clone(),
                    completed: u64::from(phase == "complete"),
                    total: Some(1),
                    phase: phase.into(),
                });
            });
        if let Err(error) = spawn_result {
            self.scans.app_lock()?.remove(&task_id);
            return Err(error.into());
        }
        Ok(TaskAcceptedDto {
            task_id,
            accepted: true,
        })
    }

    fn cancel_scan(&self, task_id: &str) -> AppResult<()> {
        validate_id(task_id, "taskId")?;
        let task = self
            .scans
            .app_lock()?
            .get(task_id)
            .map(|task| task.cancellation.clone())
            .ok_or_else(|| AppError::InvalidArgument("scan task is not active".into()))?;
        task.cancel();
        Ok(())
    }

    fn has_active_tasks(&self) -> bool {
        self.scans
            .lock()
            .map(|tasks| !tasks.is_empty())
            .unwrap_or(true)
    }
}

pub struct SettingsAdapter {
    settings: Mutex<SettingsDto>,
    path: Option<PathBuf>,
}

impl SettingsAdapter {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let mut settings = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<SettingsDto>(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => default_settings(),
            Err(error) => return Err(error.into()),
        };
        // DSP 配置迁移：未持久化 / 版本未知 / 损坏 → 回落 None（fail-close）；
        // 合法则保留，供 AppState::new 基准恢复 revision。
        settings.dsp = migrate_persisted_dsp(settings.dsp.take())?;
        Ok(Self {
            settings: Mutex::new(settings),
            path: Some(path),
        })
    }

    #[cfg(test)]
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(default_settings()),
            path: None,
        }
    }

    fn persist(&self, settings: &SettingsDto) -> AppResult<()> {
        if let Some(path) = &self.path {
            let parent = path.parent().ok_or_else(|| {
                AppError::InvalidArgument("settings path has no parent directory".into())
            })?;
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            temporary.write_all(&serde_json::to_vec_pretty(settings)?)?;
            temporary.as_file_mut().sync_all()?;
            temporary
                .persist(path)
                .map_err(|error| AppError::Io(error.error))?;
            if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
                let _ = directory.sync_all();
            }
        }
        Ok(())
    }
}

// Cache policy defaults mirror `hyperplayer_engine::cache_policy::CachePolicy::default()`.
// On read, fields that were missing in an older settings.json are backfilled from here so
// stale configurations never drift from the engine's validated defaults.
fn default_cache_policy_fields() -> (u64, u8, usize, bool, String) {
    (
        DEFAULT_CACHE_CAPACITY_BYTES,
        DEFAULT_CACHE_TRIM_PERCENT,
        DEFAULT_CACHE_RECENT_TRACK_LIMIT,
        DEFAULT_ALBUM_FILL_ENABLED,
        String::from(DEFAULT_ALBUM_FILL_QUALITY),
    )
}

fn default_settings() -> SettingsDto {
    let (
        cache_capacity_bytes,
        cache_trim_percent,
        cache_recent_track_limit,
        album_fill_enabled,
        album_fill_quality,
    ) = default_cache_policy_fields();
    SettingsDto {
        theme: ThemeDto::Dark,
        dynamic_color: true,
        reduce_motion: false,
        reduce_transparency: false,
        restore_queue: true,
        autoplay_on_start: false,
        close_behavior: CloseBehaviorDto::Ask,
        netease_enabled: true,
        cache_capacity_bytes,
        cache_trim_percent,
        cache_recent_track_limit,
        album_fill_enabled,
        album_fill_quality,
        dsp: None,
    }
}

/// 迁移：读取到的设置若无 DSP 字段、或版本未知、或 revision 非法，一律回落默认
/// （fail-close），丢弃该配置。返回 `None` = 无有效持久化 DSP 配置（`AppState::new`
/// 沿用进程内 default，revision 从 1 开始）。
fn migrate_persisted_dsp(
    raw: Option<crate::dto::PersistedDspConfig>,
) -> AppResult<Option<crate::dto::PersistedDspConfig>> {
    let Some(config) = raw else {
        return Ok(None);
    };
    if config.version != crate::dto::DSP_CONFIG_VERSION {
        return Ok(None);
    }
    if config.revision == 0 {
        return Ok(None);
    }
    Ok(Some(config))
}

fn validate_cache_policy(settings: &SettingsDto) -> AppResult<()> {
    if !(2 * 1024 * 1024 * 1024..=100 * 1024 * 1024 * 1024).contains(&settings.cache_capacity_bytes)
    {
        return Err(AppError::InvalidArgument(
            "缓存容量必须在 2 GiB 到 100 GiB 之间".into(),
        ));
    }
    if settings.cache_trim_percent != DEFAULT_CACHE_TRIM_PERCENT {
        return Err(AppError::InvalidArgument("缓存清理比固定为 90%".into()));
    }
    if settings.cache_recent_track_limit != DEFAULT_CACHE_RECENT_TRACK_LIMIT {
        return Err(AppError::InvalidArgument("最近曲目保护数固定为 100".into()));
    }
    if !matches!(
        settings.album_fill_quality.as_str(),
        "standard" | "higher" | "exhigh" | "lossless" | "hires"
    ) {
        return Err(AppError::InvalidArgument(
            "专辑补齐音质必须是 standard/higher/exhigh/lossless/hires".into(),
        ));
    }
    Ok(())
}

impl SettingsPort for SettingsAdapter {
    fn get(&self) -> AppResult<SettingsDto> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| AppError::StateUnavailable)
    }

    fn persisted_dsp_config(&self) -> AppResult<Option<crate::dto::PersistedDspConfig>> {
        self.settings
            .lock()
            .map(|settings| settings.dsp.clone())
            .map_err(|_| AppError::StateUnavailable)
    }

    fn persist_dsp_config(&self, config: &crate::dto::PersistedDspConfig) -> AppResult<()> {
        let mut guard = self.settings.app_lock()?;
        let mut settings = guard.clone();
        settings.dsp = Some(config.clone());
        self.persist(&settings)?;
        *guard = settings;
        Ok(())
    }

    fn update(&self, request: UpdateSettingsRequestDto) -> AppResult<SettingsDto> {
        let mut guard = self.settings.app_lock()?;
        let mut settings = guard.clone();
        if let Some(value) = request.theme {
            settings.theme = value;
        }
        if let Some(value) = request.dynamic_color {
            settings.dynamic_color = value;
        }
        if let Some(value) = request.reduce_motion {
            settings.reduce_motion = value;
        }
        if let Some(value) = request.reduce_transparency {
            settings.reduce_transparency = value;
        }
        if let Some(value) = request.restore_queue {
            settings.restore_queue = value;
        }
        if let Some(value) = request.autoplay_on_start {
            settings.autoplay_on_start = value;
        }
        if let Some(value) = request.close_behavior {
            settings.close_behavior = value;
        }
        if let Some(value) = request.netease_enabled {
            settings.netease_enabled = value;
        }
        if let Some(value) = request.cache_capacity_bytes {
            settings.cache_capacity_bytes = value;
        }
        if let Some(value) = request.cache_trim_percent {
            settings.cache_trim_percent = value;
        }
        if let Some(value) = request.cache_recent_track_limit {
            settings.cache_recent_track_limit = value;
        }
        if let Some(value) = request.album_fill_enabled {
            settings.album_fill_enabled = value;
        }
        if let Some(value) = request.album_fill_quality {
            settings.album_fill_quality = value;
        }
        validate_cache_policy(&settings)?;
        self.persist(&settings)?;
        *guard = settings.clone();
        Ok(settings)
    }
}

#[derive(Clone)]
struct EntitlementState {
    current_user_id: Option<u64>,
    entitlement: Verification,
    official_full_playback: Verification,
    validated_at: Option<SystemTime>,
}

impl Default for EntitlementState {
    fn default() -> Self {
        Self {
            current_user_id: None,
            entitlement: Verification::Unknown,
            official_full_playback: Verification::Unknown,
            validated_at: None,
        }
    }
}

#[derive(Clone)]
pub struct EntitlementProvider(Arc<Mutex<EntitlementState>>);

impl EntitlementProvider {
    fn authorization(&self) -> AppResult<PlaybackAuthorization> {
        let state = self.0.app_lock()?;
        Ok(PlaybackAuthorization {
            current_user_id: state.current_user_id,
            entitlement: state.entitlement,
            official_full_playback: state.official_full_playback,
            validated_at: state.validated_at,
        })
    }

    fn confirm_official_playback(&self) -> AppResult<PlaybackAuthorization> {
        let mut state = self.0.app_lock()?;
        state.official_full_playback = Verification::Confirmed;
        Ok(PlaybackAuthorization {
            current_user_id: state.current_user_id,
            entitlement: state.entitlement,
            official_full_playback: state.official_full_playback,
            validated_at: state.validated_at,
        })
    }

    fn clear(&self) -> AppResult<()> {
        *self.0.app_lock()? = EntitlementState::default();
        Ok(())
    }

    fn update_from_vip(&self, user: &UserAccount, vip: &VipInfo) -> AppResult<()> {
        let mut state = self.0.app_lock()?;
        state.current_user_id = Some(user.user_id);
        state.entitlement = if vip.is_vip {
            Verification::Confirmed
        } else {
            Verification::Denied
        };
        state.official_full_playback = Verification::Unknown;
        state.validated_at = Some(SystemTime::now());
        Ok(())
    }
}

pub struct CacheAdapter {
    repository: Repository,
    entitlement: EntitlementProvider,
    netease: Arc<NeteaseAdapter>,
    store: ContentAddressedCache,
    client: Client,
    active_tasks: Mutex<u32>,
    download_slots: tokio::sync::Semaphore,
}

impl CacheAdapter {
    pub fn new(
        repository: Repository,
        netease: Arc<NeteaseAdapter>,
        cache_root: PathBuf,
    ) -> AppResult<Self> {
        Ok(Self {
            repository,
            entitlement: netease.entitlement_provider(),
            netease,
            store: ContentAddressedCache::new(cache_root)?,
            client: secure_http_client()?,
            active_tasks: Mutex::new(0),
            download_slots: tokio::sync::Semaphore::new(MAX_CONCURRENT_CACHE_DOWNLOADS),
        })
    }

    #[allow(dead_code)]
    // Reserved as the sole cache-resource opening boundary; decoder wiring will call this method.
    pub(crate) fn open_cached_resource(
        &self,
        track: &TrackRefDto,
        quality: &str,
    ) -> AppResult<std::fs::File> {
        validate_track_ref(track)?;
        let quality = cache_quality(quality)?;
        let entry = self
            .repository
            .app_lock()?
            .cache_entry(&MediaId::new(&track.id), quality)?
            .ok_or_else(|| AppError::Unavailable("cache resource is missing".into()))?;
        authorize_cache(&entry, &self.entitlement.authorization()?)
            .map_err(|denial| AppError::Unavailable(cache_denial(denial).into()))?;
        self.store.open(&entry.content_hash).map_err(Into::into)
    }

    fn entries_for_track(&self, track: &TrackRefDto) -> AppResult<Vec<CacheEntry>> {
        self.repository
            .app_lock()?
            .cache_entries_for(&MediaId::new(&track.id))
            .map_err(Into::into)
    }

    fn remove_files(
        &self,
        objects: Vec<hyperplayer_engine::repository::RemovedCacheObject>,
    ) -> AppResult<()> {
        for object in objects {
            let path = self.store.object_path(&object.content_hash)?;
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// Resolves the official NetEase source for a track and streams it into the CAS store,
    /// returning the freshly committed [`CacheObject`] and its metadata [`CacheEntry`].
    ///
    /// This is the shared download entry point: both the foreground [`CachePort::cache_track`]
    /// and the Stage 12 album-fill worker route through it, so they share the same official
    /// URL discovery, size limit, SHA-256 verification and CAS write path. The caller is
    /// responsible for persisting `(object, entry)` atomically (see
    /// `SqliteRepository::complete_album_fill_item_with_cache` for the album-fill path).
    pub(crate) async fn download_track_to_object(
        &self,
        track: &TrackRefDto,
        quality: &str,
    ) -> AppResult<(CacheObject, CacheEntry)> {
        validate_track_ref(track)?;
        if track.source != TrackSourceDto::Netease {
            return Err(AppError::Unavailable(
                "local files are library resources and are not copied into playback cache".into(),
            ));
        }
        let quality = cache_quality(quality)?;
        let song_id = parse_netease_id(&track.id)?;
        let service = self.netease.require_service()?;
        let metadata = service
            .song_detail(&[song_id])
            .await?
            .into_iter()
            .find(|track| track.id == song_id)
            .ok_or_else(|| AppError::Unavailable("NetEase track does not exist".into()))?;
        let (access_class, entitlement_snapshot, last_validated_unix_ms) = if metadata.is_vip {
            let (user, vip) = self.netease.verify_account_entitlement().await?;
            entitlement_cache_metadata(true, Some(&user), Some(&vip), unix_millis())?
        } else {
            entitlement_cache_metadata(false, None, None, unix_millis())?
        };
        let play_info = service
            .song_url(
                song_id,
                cache_quality_preference(quality)?,
                metadata.is_vip,
                Duration::from_secs(12),
            )
            .await?;
        let url = play_info.url.ok_or_else(|| {
            AppError::Unavailable("NetEase did not return an official playback URL".into())
        })?;
        if play_info.free_trial_info.is_some() || (play_info.is_paid_content && !metadata.is_vip) {
            return Err(AppError::Unavailable(
                "trial or paid-content URLs cannot be cached as full tracks".into(),
            ));
        }
        let _download_slot =
            self.download_slots.acquire().await.map_err(|_| {
                AppError::Unavailable("cache download scheduler is unavailable".into())
            })?;
        {
            let mut active = self.active_tasks.app_lock()?;
            *active = active.saturating_add(1);
        }
        let _active = ActiveCacheTask(&self.active_tasks);
        let response = send_trusted_media_request(&self.client, &url).await?;
        if let Some(length) = response.content_length() {
            if length == 0 || length > MAX_CACHE_DOWNLOAD_BYTES {
                return Err(AppError::Unavailable(
                    "official playback response size is outside the cache limit".into(),
                ));
            }
        }
        let mut spool = tempfile::tempfile()?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0_u64;
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(map_reqwest_app_error)? {
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > MAX_CACHE_DOWNLOAD_BYTES {
                return Err(AppError::Unavailable(
                    "official playback response exceeded the cache limit".into(),
                ));
            }
            hasher.update(&chunk);
            spool.write_all(&chunk)?;
        }
        if downloaded == 0 {
            return Err(AppError::Unavailable(
                "official playback response contained no audio bytes".into(),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length != downloaded)
        {
            return Err(AppError::Unavailable(
                "official playback response length did not match Content-Length".into(),
            ));
        }
        let content_hash = format!("{:x}", hasher.finalize());
        let mut partial = self.store.begin_partial(&content_hash)?;
        spool.rewind()?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = spool.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            partial.write_all(&buffer[..read])?;
        }
        let object = partial.complete()?;
        let entry = CacheEntry {
            content_id: MediaId::new(&track.id),
            quality: play_info.level.as_str().into(),
            content_hash: content_hash.clone(),
            access_class,
            entitlement_snapshot,
            last_validated_unix_ms,
            official_source: "netease".into(),
            state: CacheState::Available,
        };
        Ok((object, entry))
    }
}

struct ActiveCacheTask<'a>(&'a Mutex<u32>);

impl Drop for ActiveCacheTask<'_> {
    fn drop(&mut self) {
        if let Ok(mut count) = self.0.lock() {
            *count = count.saturating_sub(1);
        }
    }
}

#[async_trait]
impl CachePort for CacheAdapter {
    fn stats(&self) -> AppResult<CacheStatsDto> {
        let stats = self.repository.app_lock()?.cache_stats()?;
        Ok(CacheStatsDto {
            entry_count: stats.entry_count,
            bytes_used: stats.bytes_used,
            active_tasks: *self.active_tasks.app_lock()?,
            locked_entries: stats.locked_entries,
        })
    }

    fn status(&self, track: &TrackRefDto) -> AppResult<CacheStatusDto> {
        validate_track_ref(track)?;
        let entries = self.entries_for_track(track)?;
        if entries.is_empty() {
            return Ok(CacheStatusDto {
                track: track.clone(),
                quality: None,
                cached_versions: 0,
                status: CacheEntryStatusDto::Missing,
                access_class: CacheAccessClassDto::Public,
                owner_user_id: None,
                last_validated_at: None,
            });
        }
        let cached_versions = u32::try_from(entries.len())
            .map_err(|_| AppError::Unavailable("too many cached quality versions".into()))?;
        let status = if entries
            .iter()
            .any(|entry| entry.state == CacheState::LockedEntitlement)
        {
            CacheEntryStatusDto::LockedEntitlement
        } else if entries
            .iter()
            .any(|entry| entry.state == CacheState::Partial)
        {
            CacheEntryStatusDto::Caching
        } else {
            CacheEntryStatusDto::Ready
        };
        let owner_ids = entries
            .iter()
            .filter_map(|entry| match entry.access_class {
                CacheAccessClass::Public => None,
                CacheAccessClass::AccountEntitled { owner_user_id } => Some(owner_user_id),
            })
            .collect::<std::collections::BTreeSet<_>>();
        let access_class = if owner_ids.is_empty() {
            CacheAccessClassDto::Public
        } else {
            CacheAccessClassDto::AccountEntitled
        };
        let owner_user_id = (owner_ids.len() == 1)
            .then(|| owner_ids.first().copied().map(|owner| owner.to_string()))
            .flatten();
        let quality = (entries.len() == 1).then(|| entries[0].quality.clone());
        let last_validated_at = entries
            .iter()
            .filter_map(|entry| entry.last_validated_unix_ms)
            .max()
            .map(|value| value.to_string());
        Ok(CacheStatusDto {
            track: track.clone(),
            quality,
            cached_versions,
            status,
            access_class,
            owner_user_id,
            last_validated_at,
        })
    }

    async fn cache_track(&self, request: CacheTrackRequestDto) -> AppResult<TaskAcceptedDto> {
        let (object, entry) = self
            .download_track_to_object(&request.track, &request.quality)
            .await?;
        let repository = self.repository.app_lock()?;
        repository.record_cache_object(&object, unix_millis())?;
        repository.upsert_cache_entry(&entry)?;
        Ok(TaskAcceptedDto {
            task_id: format!("cache-{}-{}", request.track.id, entry.quality),
            accepted: true,
        })
    }

    fn remove(&self, track: &TrackRefDto) -> AppResult<()> {
        validate_track_ref(track)?;
        let objects = self
            .repository
            .app_lock()?
            .remove_cache_entries_for(&MediaId::new(&track.id))?;
        self.remove_files(objects)
    }

    fn clear(&self) -> AppResult<TaskAcceptedDto> {
        let objects = self.repository.app_lock()?.clear_cache_entries()?;
        self.remove_files(objects)?;
        Ok(TaskAcceptedDto {
            task_id: format!("cache-clear-{}", unix_millis()),
            accepted: true,
        })
    }
}

#[derive(Clone)]
struct ReqwestTransport {
    client: Client,
    authorized_cookie: Arc<Mutex<Option<String>>>,
}

impl ReqwestTransport {
    fn take_authorized_cookie(&self) -> AppResult<Option<String>> {
        Ok(self.authorized_cookie.app_lock()?.take())
    }
}

#[async_trait]
impl Transport for ReqwestTransport {
    async fn execute(
        &self,
        request: HttpRequest,
    ) -> hyperplayer_source_netease::Result<HttpResponse> {
        let method = match request.method {
            hyperplayer_source_netease::Method::Get => reqwest::Method::GET,
            hyperplayer_source_netease::Method::Post => reqwest::Method::POST,
        };
        let mut builder = self
            .client
            .request(method, request.url)
            .timeout(request.timeout);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        let response = builder
            .body(request.body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status().as_u16();
        let mut headers = BTreeMap::new();
        for (name, value) in response.headers() {
            if let Ok(value) = value.to_str() {
                headers
                    .entry(name.as_str().to_owned())
                    .or_insert_with(Vec::new)
                    .push(value.to_owned());
            }
        }
        let body = response.bytes().await.map_err(map_reqwest_error)?.to_vec();
        if let Some(cookie) = authorized_cookie_from_response(&body) {
            *self.authorized_cookie.lock().map_err(|_| {
                hyperplayer_source_netease::Error::Transport("HTTP state unavailable".into())
            })? = Some(cookie);
        }
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

fn authorized_cookie_from_response(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    if value.get("code").and_then(serde_json::Value::as_i64) != Some(803) {
        return None;
    }
    let cookie = value
        .get("cookie")?
        .as_array()?
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect::<Vec<_>>()
        .join(";");
    (!cookie.is_empty()).then_some(cookie)
}

struct SecretSession {
    cookie: String,
    device_id: String,
    expires_at_ms: u64,
}

impl Drop for SecretSession {
    fn drop(&mut self) {
        self.cookie.zeroize();
        self.device_id.zeroize();
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    version: u8,
    cookie: String,
    device_id: String,
    expires_at_ms: u64,
}

struct DeviceIdRng {
    bytes: [u8; 26],
    offset: usize,
}

impl DeviceIdRng {
    fn from_hex(value: &str) -> AppResult<Self> {
        if value.len() != 52 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::Credential("stored credential is invalid"));
        }
        let mut bytes = [0_u8; 26];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| AppError::Credential("stored credential is invalid"))?;
        }
        Ok(Self { bytes, offset: 0 })
    }
}

impl RngCore for DeviceIdRng {
    fn next_u32(&mut self) -> u32 {
        let mut bytes = [0_u8; 4];
        self.fill_bytes(&mut bytes);
        u32::from_le_bytes(bytes)
    }

    fn next_u64(&mut self) -> u64 {
        let mut bytes = [0_u8; 8];
        self.fill_bytes(&mut bytes);
        u64::from_le_bytes(bytes)
    }

    fn fill_bytes(&mut self, destination: &mut [u8]) {
        for byte in destination {
            *byte = self.bytes[self.offset % self.bytes.len()];
            self.offset += 1;
        }
    }

    fn try_fill_bytes(&mut self, destination: &mut [u8]) -> Result<(), rand::Error> {
        self.fill_bytes(destination);
        Ok(())
    }
}

impl CryptoRng for DeviceIdRng {}

impl StoredSession {
    fn into_secret(self) -> AppResult<SecretSession> {
        if self.version != NETEASE_SESSION_SCHEMA_VERSION
            || self.cookie.is_empty()
            || self.cookie.len() > 64 * 1024
            || !self.cookie.split(';').any(|part| {
                part.trim()
                    .split_once('=')
                    .is_some_and(|(name, value)| name == "MUSIC_U" && !value.is_empty())
            })
            || self.device_id.len() != 52
            || !self
                .device_id
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err(AppError::Credential("stored credential is invalid"));
        }
        Ok(SecretSession {
            cookie: self.cookie,
            device_id: self.device_id,
            expires_at_ms: self.expires_at_ms,
        })
    }
}

impl From<&SecretSession> for StoredSession {
    fn from(session: &SecretSession) -> Self {
        Self {
            version: NETEASE_SESSION_SCHEMA_VERSION,
            cookie: session.cookie.clone(),
            device_id: session.device_id.clone(),
            expires_at_ms: session.expires_at_ms,
        }
    }
}

#[derive(Default)]
struct LoginState {
    generation: u64,
    active_login_id: Option<String>,
    authenticated: bool,
    user_id: Option<u64>,
    display_name: Option<String>,
    secret: Option<SecretSession>,
}

struct PendingMutation {
    mutation: NeteaseMutationDto,
    operation_digest: [u8; 32],
    window_label: String,
    account_user_id: Option<u64>,
    expires_at_ms: u64,
    login_generation: u64,
}

pub struct NeteaseAdapter {
    service: Option<NeteaseService<ReqwestTransport>>,
    transport: Option<ReqwestTransport>,
    vault: Arc<dyn CredentialVault>,
    device_id: String,
    settings: Arc<SettingsAdapter>,
    repository: Repository,
    login: Mutex<LoginState>,
    pending_mutations: Mutex<HashMap<String, PendingMutation>>,
    session_gate: tokio::sync::Mutex<()>,
    entitlement: EntitlementProvider,
}

impl NeteaseAdapter {
    pub fn new(
        settings: Arc<SettingsAdapter>,
        vault: Arc<dyn CredentialVault>,
        repository: Repository,
    ) -> AppResult<Self> {
        Self::with_client(settings, vault, repository, Client::builder().build().ok())
    }

    fn with_client(
        settings: Arc<SettingsAdapter>,
        vault: Arc<dyn CredentialVault>,
        repository: Repository,
        client: Option<Client>,
    ) -> AppResult<Self> {
        let restored = Self::load_stored_session(vault.as_ref())?;
        let (service, transport, device_id) = if let Some(client) = client {
            let transport = ReqwestTransport {
                client,
                authorized_cookie: Arc::new(Mutex::new(None)),
            };
            let mut rng = OsRng;
            let mut session = if let Some(secret) = restored.as_ref() {
                Session::new(&mut DeviceIdRng::from_hex(&secret.device_id)?)
            } else {
                Session::new(&mut rng)
            };
            let device_id = session.device_id().to_owned();
            if let Some(secret) = restored.as_ref() {
                session.set_user_cookie(&secret.cookie);
            }
            (
                Some(NeteaseService::new(transport.clone(), session)),
                Some(transport),
                device_id,
            )
        } else {
            (None, None, String::new())
        };
        let authenticated = restored.is_some() && service.is_some();
        Ok(Self {
            service,
            transport,
            vault,
            device_id,
            settings,
            repository,
            login: Mutex::new(LoginState {
                authenticated,
                secret: restored,
                ..LoginState::default()
            }),
            pending_mutations: Mutex::new(HashMap::new()),
            session_gate: tokio::sync::Mutex::new(()),
            entitlement: EntitlementProvider(Arc::new(Mutex::new(EntitlementState::default()))),
        })
    }

    fn load_stored_session(vault: &dyn CredentialVault) -> AppResult<Option<SecretSession>> {
        let Some(mut bytes) = vault.load()? else {
            return Ok(None);
        };
        let decoded = serde_json::from_slice::<StoredSession>(&bytes)
            .map_err(|_| AppError::Credential("stored credential is invalid"))
            .and_then(StoredSession::into_secret);
        bytes.zeroize();
        match decoded {
            Ok(secret) if secret.expires_at_ms > unix_millis() => Ok(Some(secret)),
            Ok(_) | Err(_) => {
                vault.delete()?;
                Ok(None)
            }
        }
    }

    fn persist_session(&self, session: &SecretSession) -> AppResult<()> {
        let mut bytes = serde_json::to_vec(&StoredSession::from(session))?;
        let result = self.vault.replace(&bytes);
        bytes.zeroize();
        result
    }

    fn lock_entitled_cache(&self, owner_user_id: Option<u64>) -> AppResult<()> {
        let scope = owner_user_id.map_or(
            hyperplayer_engine::repository::EntitlementCacheScope::AllAccounts,
            hyperplayer_engine::repository::EntitlementCacheScope::Owner,
        );
        self.repository
            .app_lock()?
            .lock_account_entitled_cache_entries(scope)?;
        Ok(())
    }

    fn commit_authorized_session(&self, login: &mut LoginState, cookie: String) -> AppResult<()> {
        let secret = SecretSession {
            cookie,
            device_id: self.device_id.clone(),
            expires_at_ms: unix_millis().saturating_add(NETEASE_SESSION_TTL.as_millis() as u64),
        };
        if login.authenticated {
            self.lock_entitled_cache(login.user_id)?;
        }
        if let Err(error) = self.persist_session(&secret) {
            if let Some(previous) = login.secret.as_ref() {
                if let Some(service) = self.service.as_ref() {
                    service.set_user_cookie(&previous.cookie);
                }
            } else if let Some(service) = self.service.as_ref() {
                service.clear_user_cookie();
            }
            return Err(error);
        }
        login.generation = login.generation.saturating_add(1);
        login.authenticated = true;
        login.active_login_id = None;
        login.user_id = None;
        login.display_name = None;
        login.secret = Some(secret);
        self.pending_mutations.app_lock()?.clear();
        self.entitlement.clear()
    }

    #[cfg(test)]
    pub fn disabled(settings: Arc<SettingsAdapter>) -> Self {
        Self::disabled_with_vault(
            settings,
            Arc::new(crate::credential_vault::MemoryCredentialVault::new(None)),
        )
    }

    #[cfg(test)]
    fn disabled_with_vault(
        settings: Arc<SettingsAdapter>,
        vault: Arc<dyn CredentialVault>,
    ) -> Self {
        Self {
            service: None,
            transport: None,
            vault,
            device_id: String::new(),
            settings,
            repository: Arc::new(Mutex::new(
                SqliteRepository::in_memory().expect("test repository"),
            )),
            login: Mutex::new(LoginState::default()),
            pending_mutations: Mutex::new(HashMap::new()),
            session_gate: tokio::sync::Mutex::new(()),
            entitlement: EntitlementProvider(Arc::new(Mutex::new(EntitlementState::default()))),
        }
    }

    pub fn entitlement_provider(&self) -> EntitlementProvider {
        self.entitlement.clone()
    }

    fn require_service(&self) -> AppResult<&NeteaseService<ReqwestTransport>> {
        if !self.settings.get()?.netease_enabled {
            return Err(AppError::Unavailable("NetEase source is disabled".into()));
        }
        self.service
            .as_ref()
            .ok_or_else(|| AppError::Unavailable("NetEase HTTP service is not configured".into()))
    }

    async fn verify_account_entitlement(&self) -> AppResult<(UserAccount, VipInfo)> {
        self.require_authenticated()?;
        let result = async {
            let service = self.require_service()?;
            let user = service.account().await?.ok_or_else(|| {
                AppError::Unavailable("NetEase account session is not authenticated".into())
            })?;
            let vip = service.vip_info().await?;
            Ok::<_, AppError>((user, vip))
        }
        .await;
        let (user, vip) = match result {
            Ok(value) => value,
            Err(error) => {
                let owner_user_id = self.login.app_lock()?.user_id;
                self.lock_entitled_cache(owner_user_id)?;
                self.entitlement.clear()?;
                return Err(error);
            }
        };
        let previous_owner = self.login.app_lock()?.user_id;
        if previous_owner.is_some_and(|owner| owner != user.user_id) {
            self.lock_entitled_cache(previous_owner)?;
        }
        self.entitlement.update_from_vip(&user, &vip)?;
        let mut login = self.login.app_lock()?;
        login.authenticated = true;
        login.user_id = Some(user.user_id);
        login.display_name = Some(user.nickname.clone());
        Ok((user, vip))
    }

    fn authenticated_context(&self) -> AppResult<(u64, Option<u64>)> {
        self.require_service()?;
        let login = self.login.app_lock()?;
        if !login.authenticated {
            return Err(AppError::Unavailable(
                "NetEase account authentication is required".into(),
            ));
        }
        Ok((login.generation, login.user_id))
    }

    fn require_authenticated(&self) -> AppResult<u64> {
        self.authenticated_context().map(|context| context.0)
    }

    fn prepare_mutation_inner(
        &self,
        window_label: &str,
        mutation: NeteaseMutationDto,
    ) -> AppResult<NeteaseMutationConfirmationDto> {
        let (login_generation, account_user_id) = self.authenticated_context()?;
        validate_netease_mutation(&mutation)?;
        let summary = netease_mutation_summary(&mutation);
        let operation_digest = mutation_digest(&mutation, &summary)?;
        let expires_at_ms = unix_millis().saturating_add(NETEASE_MUTATION_TTL.as_millis() as u64);
        let mut token_bytes = [0_u8; 24];
        OsRng.fill_bytes(&mut token_bytes);
        let confirmation_token = token_bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut pending = self.pending_mutations.app_lock()?;
        let now = unix_millis();
        pending.retain(|_, entry| entry.expires_at_ms > now);
        pending.insert(
            confirmation_token.clone(),
            PendingMutation {
                mutation,
                operation_digest,
                window_label: window_label.to_owned(),
                account_user_id,
                expires_at_ms,
                login_generation,
            },
        );
        Ok(NeteaseMutationConfirmationDto {
            confirmation_token,
            summary,
            expires_at_ms,
        })
    }

    fn take_pending_mutation(
        &self,
        window_label: &str,
        request: NeteaseCommitMutationRequestDto,
    ) -> AppResult<NeteaseMutationDto> {
        if !request.confirmed {
            return Err(AppError::InvalidArgument(
                "confirmed must be true to commit a NetEase mutation".into(),
            ));
        }
        validate_id(&request.confirmation_token, "confirmationToken")?;
        let (generation, account_user_id) = self.authenticated_context()?;
        let pending = self
            .pending_mutations
            .app_lock()?
            .remove(&request.confirmation_token)
            .ok_or_else(|| {
                AppError::InvalidArgument("confirmation token is invalid or already used".into())
            })?;
        if pending.expires_at_ms <= unix_millis() {
            return Err(AppError::Unavailable(
                "confirmation token has expired".into(),
            ));
        }
        if pending.login_generation != generation || pending.account_user_id != account_user_id {
            return Err(AppError::Unavailable(
                "account session changed after mutation preparation".into(),
            ));
        }
        if pending.window_label != window_label {
            return Err(AppError::Unavailable(
                "confirmation token belongs to another window".into(),
            ));
        }
        let summary = netease_mutation_summary(&pending.mutation);
        let actual_digest = mutation_digest(&pending.mutation, &summary)?;
        if actual_digest != pending.operation_digest {
            return Err(AppError::Unavailable(
                "confirmation token operation binding is invalid".into(),
            ));
        }
        Ok(pending.mutation)
    }
}

#[async_trait]
impl NeteasePort for NeteaseAdapter {
    fn status(&self) -> AppResult<NeteaseStatusDto> {
        let login = self.login.app_lock()?;
        Ok(NeteaseStatusDto {
            enabled: self.settings.get()?.netease_enabled && self.service.is_some(),
            authenticated: login.authenticated,
            user_id: login.user_id.map(|id| id.to_string()),
            display_name: login.display_name.clone(),
        })
    }

    async fn search(&self, request: NeteaseSearchRequestDto) -> AppResult<NeteaseSearchPageDto> {
        validate_page(&request.page)?;
        let offset = parse_cursor(request.page.cursor.as_deref())?;
        let kind = match request.kind {
            NeteaseSearchKindDto::Track => SearchKind::Track,
            NeteaseSearchKindDto::Album => SearchKind::Album,
            NeteaseSearchKindDto::Artist => SearchKind::Artist,
            NeteaseSearchKindDto::Playlist => SearchKind::Playlist,
        };
        let results = self
            .require_service()?
            .search(
                &request.query,
                kind,
                PageRequest {
                    limit: usize::from(request.page.limit),
                    offset,
                },
            )
            .await?;
        let count = match kind {
            SearchKind::Track => results.tracks.len(),
            SearchKind::Album => results.albums.len(),
            SearchKind::Artist => results.artists.len(),
            SearchKind::Playlist => results.playlists.len(),
        };
        Ok(NeteaseSearchPageDto {
            tracks: results.tracks.into_iter().map(netease_track_dto).collect(),
            albums: results.albums.into_iter().map(netease_album_dto).collect(),
            artists: results
                .artists
                .into_iter()
                .map(netease_artist_summary_dto)
                .collect(),
            playlists: results
                .playlists
                .into_iter()
                .map(netease_playlist_dto)
                .collect(),
            next_cursor: (count == usize::from(request.page.limit))
                .then(|| (offset + count).to_string()),
        })
    }

    async fn mvs(&self, request: NeteaseMvListRequestDto) -> AppResult<NeteaseMvPageDto> {
        let page = netease_page(&request.page)?;
        let offset = page.offset;
        let limit = page.limit;
        let items = self
            .require_service()?
            .mvs(&request.area, &request.kind, &request.order, page)
            .await?;
        let count = items.len();
        Ok(NeteaseMvPageDto {
            items: items.into_iter().map(netease_mv_dto).collect(),
            next_cursor: (count == limit).then(|| (offset + count).to_string()),
        })
    }

    async fn mv_detail(&self, id: u64) -> AppResult<NeteaseMvDetailDto> {
        validate_positive_id(id, "mvId")?;
        Ok(netease_mv_detail_dto(
            self.require_service()?.mv_detail(id).await?,
        ))
    }

    async fn dj_radios(&self, page: PageRequestDto) -> AppResult<NeteaseDjPageDto> {
        let page = netease_page(&page)?;
        let offset = page.offset;
        let limit = page.limit;
        let radios = self.require_service()?.dj_radios(page).await?;
        let count = radios.len();
        Ok(NeteaseDjPageDto {
            radios: radios.into_iter().map(netease_dj_radio_dto).collect(),
            programs: vec![],
            next_cursor: (count == limit).then(|| (offset + count).to_string()),
        })
    }

    async fn dj_programs(
        &self,
        request: NeteaseDjProgramsRequestDto,
    ) -> AppResult<NeteaseDjPageDto> {
        validate_positive_id(request.radio_id, "radioId")?;
        let page = netease_page(&request.page)?;
        let offset = page.offset;
        let limit = page.limit;
        let programs = self
            .require_service()?
            .dj_programs(request.radio_id, request.ascending, page)
            .await?;
        let count = programs.len();
        Ok(NeteaseDjPageDto {
            radios: vec![],
            programs: programs.into_iter().map(netease_dj_program_dto).collect(),
            next_cursor: (count == limit).then(|| (offset + count).to_string()),
        })
    }

    async fn charts(&self) -> AppResult<Vec<NeteaseChartDto>> {
        Ok(self
            .require_service()?
            .charts()
            .await?
            .into_iter()
            .map(netease_chart_dto)
            .collect())
    }

    async fn new_songs(&self, area_id: u16) -> AppResult<NeteaseTracksDto> {
        Ok(NeteaseTracksDto {
            tracks: self
                .require_service()?
                .new_songs(area_id)
                .await?
                .into_iter()
                .map(netease_track_dto)
                .collect(),
        })
    }

    async fn listen_total(&self) -> AppResult<NeteaseListenStatsDto> {
        self.require_authenticated()?;
        Ok(netease_listen_stats_dto(
            self.require_service()?.listen_total().await?,
        ))
    }

    async fn listen_report(
        &self,
        request: NeteaseListenReportRequestDto,
    ) -> AppResult<NeteaseListenReportDto> {
        self.require_authenticated()?;
        let period = netease_listen_period(request.period);
        Ok(netease_listen_report_dto(
            self.require_service()?
                .listen_report(period, request.end_time.as_deref())
                .await?,
        ))
    }

    async fn listen_song_rank(
        &self,
        request: NeteaseListenReportRequestDto,
    ) -> AppResult<NeteaseTracksDto> {
        self.require_authenticated()?;
        if request.period == NeteaseListenPeriodDto::Year {
            return Err(AppError::InvalidArgument(
                "song rank period supports week or month only".into(),
            ));
        }
        Ok(NeteaseTracksDto {
            tracks: self
                .require_service()?
                .listen_song_rank(
                    netease_listen_period(request.period),
                    request.end_time.as_deref(),
                )
                .await?
                .into_iter()
                .map(netease_track_dto)
                .collect(),
        })
    }

    async fn followed_events(
        &self,
        request: NeteaseCursorRequestDto,
    ) -> AppResult<NeteaseEventPageDto> {
        self.require_authenticated()?;
        validate_netease_limit(request.limit)?;
        Ok(netease_event_page_dto(
            self.require_service()?
                .followed_events(request.cursor, usize::from(request.limit))
                .await?,
        ))
    }

    async fn user_events(
        &self,
        request: NeteaseUserEventsRequestDto,
    ) -> AppResult<NeteaseEventPageDto> {
        validate_positive_id(request.user_id, "userId")?;
        validate_netease_limit(request.limit)?;
        Ok(netease_event_page_dto(
            self.require_service()?
                .user_events(request.user_id, request.cursor, usize::from(request.limit))
                .await?,
        ))
    }

    async fn notices(&self, request: NeteaseCursorRequestDto) -> AppResult<NeteaseNoticePageDto> {
        self.require_authenticated()?;
        validate_netease_limit(request.limit)?;
        Ok(netease_notice_page_dto(
            self.require_service()?
                .notices(request.cursor, usize::from(request.limit))
                .await?,
        ))
    }

    async fn home(&self) -> AppResult<NeteaseHomeDto> {
        let service = self.require_service()?;
        if self.login.app_lock()?.authenticated {
            let tracks = service.recommend_songs().await?;
            let playlists = service.recommend_playlists().await?;
            return Ok(NeteaseHomeDto {
                recommended_tracks: tracks.into_iter().map(netease_track_dto).collect(),
                recommended_playlists: playlists.into_iter().map(netease_playlist_dto).collect(),
                anonymous: false,
                unavailable_sections: Vec::new(),
            });
        }
        let explore = service.public_explore().await?;
        Ok(NeteaseHomeDto {
            recommended_tracks: explore
                .new_songs
                .into_iter()
                .map(netease_track_dto)
                .collect(),
            recommended_playlists: explore
                .playlists
                .into_iter()
                .map(netease_playlist_dto)
                .collect(),
            anonymous: true,
            unavailable_sections: explore
                .unavailable_sections
                .into_iter()
                .map(|section| format!("{section:?}"))
                .collect(),
        })
    }

    async fn album_detail(&self, id: u64) -> AppResult<NeteaseAlbumDetailDto> {
        validate_positive_id(id, "albumId")?;
        Ok(netease_album_detail_dto(
            self.require_service()?.album_detail(id).await?,
        ))
    }

    async fn playlist_detail(&self, id: u64) -> AppResult<NeteasePlaylistDetailDto> {
        validate_positive_id(id, "playlistId")?;
        Ok(netease_playlist_detail_dto(
            self.require_service()?.playlist_detail(id).await?,
        ))
    }

    async fn artist_detail(&self, id: u64) -> AppResult<NeteaseArtistDetailDto> {
        validate_positive_id(id, "artistId")?;
        Ok(netease_artist_detail_dto(
            self.require_service()?.artist_overview(id).await?,
        ))
    }

    async fn personal_fm(&self) -> AppResult<NeteaseFmDto> {
        self.require_authenticated()?;
        let tracks = self
            .require_service()?
            .personal_fm_batched(NETEASE_FM_TARGET_COUNT, NETEASE_FM_MAX_BATCHES)
            .await?;
        Ok(NeteaseFmDto {
            tracks: tracks.into_iter().map(netease_track_dto).collect(),
        })
    }

    async fn account(&self) -> AppResult<NeteaseAccountDto> {
        let (user, vip) = self.verify_account_entitlement().await?;
        let verified_at_ms = unix_millis();
        Ok(NeteaseAccountDto {
            user: netease_user_dto(user),
            vip: netease_vip_dto(vip, verified_at_ms),
        })
    }

    async fn favorites(&self) -> AppResult<NeteaseFavoritesDto> {
        self.require_authenticated()?;
        let service = self.require_service()?;
        let user = service.account().await?.ok_or_else(|| {
            AppError::Unavailable("NetEase account session is not authenticated".into())
        })?;
        let page = PageRequest {
            limit: 100,
            offset: 0,
        };
        let liked_track_ids = service.liked_song_ids(user.user_id).await?;
        let playlists = service.user_playlists(user.user_id, page).await?;
        Ok(NeteaseFavoritesDto {
            liked_track_ids,
            playlists: playlists.into_iter().map(netease_playlist_dto).collect(),
        })
    }

    async fn comments(
        &self,
        request: NeteaseCommentsRequestDto,
    ) -> AppResult<NeteaseCommentPageDto> {
        validate_positive_id(request.resource_id, "resourceId")?;
        let page = netease_page(&request.page)?;
        let offset = page.offset;
        let limit = page.limit;
        let result = self
            .require_service()?
            .comments(
                netease_comment_resource(request.resource),
                request.resource_id,
                page,
            )
            .await?;
        Ok(netease_comment_page_dto(result, offset, limit))
    }

    async fn follows(&self, request: NeteaseFollowsRequestDto) -> AppResult<NeteaseUserPageDto> {
        validate_positive_id(request.user_id, "userId")?;
        let page = netease_page(&request.page)?;
        let offset = page.offset;
        let limit = page.limit;
        let users = self
            .require_service()?
            .follows(request.user_id, page)
            .await?;
        let count = users.len();
        Ok(NeteaseUserPageDto {
            users: users.into_iter().map(netease_user_dto).collect(),
            next_cursor: (count == limit).then(|| (offset + count).to_string()),
        })
    }

    async fn cloud(&self, page: PageRequestDto) -> AppResult<NeteaseCloudPageDto> {
        self.require_authenticated()?;
        let page = netease_page(&page)?;
        let offset = page.offset;
        let limit = page.limit;
        Ok(netease_cloud_page_dto(
            self.require_service()?.cloud_songs(page).await?,
            offset,
            limit,
        ))
    }

    async fn image(&self, url: &str) -> AppResult<NeteaseImageDto> {
        self.require_service()?;
        let client = secure_http_client()?;
        let mut response = send_trusted_netease_image_request(&client, url).await?;
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| NETEASE_IMAGE_MIME_TYPES.contains(value))
            .ok_or_else(|| {
                AppError::Unavailable("NetEase image response has an unsupported MIME type".into())
            })?
            .to_owned();
        if response
            .content_length()
            .is_some_and(|length| length == 0 || length > MAX_NETEASE_IMAGE_BYTES)
        {
            return Err(AppError::Unavailable(
                "NetEase image response size is outside the image limit".into(),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(map_reqwest_app_error)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_NETEASE_IMAGE_BYTES as usize {
                return Err(AppError::Unavailable(
                    "NetEase image response exceeded the image limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(AppError::Unavailable(
                "NetEase image response contained no bytes".into(),
            ));
        }
        Ok(NeteaseImageDto { mime_type, bytes })
    }

    fn prepare_mutation(
        &self,
        window_label: &str,
        request: NeteasePrepareMutationRequestDto,
    ) -> AppResult<NeteaseMutationConfirmationDto> {
        self.prepare_mutation_inner(window_label, request.mutation)
    }

    async fn commit_mutation(
        &self,
        window_label: &str,
        request: NeteaseCommitMutationRequestDto,
    ) -> AppResult<NeteaseMutationResultDto> {
        let mutation = self.take_pending_mutation(window_label, request)?;
        let service = self.require_service()?;
        let mut result = NeteaseMutationResultDto {
            succeeded: true,
            created_playlist: None,
            comment: None,
        };
        match mutation {
            NeteaseMutationDto::SetAlbumFavorite { album_id, favorite } => {
                service.subscribe_album(album_id, favorite).await?;
            }
            NeteaseMutationDto::CreatePlaylist { name, private } => {
                result.created_playlist = Some(netease_playlist_dto(
                    service.create_playlist(&name, private).await?,
                ));
            }
            NeteaseMutationDto::DeletePlaylist { playlist_id } => {
                service.delete_playlist(playlist_id).await?;
            }
            NeteaseMutationDto::UpdatePlaylist {
                playlist_id,
                name,
                description,
                tags,
            } => {
                service
                    .update_playlist(playlist_id, name.as_deref(), &description, &tags)
                    .await?;
            }
            NeteaseMutationDto::SetPlaylistFavorite {
                playlist_id,
                favorite,
            } => {
                service.subscribe_playlist(playlist_id, favorite).await?;
            }
            NeteaseMutationDto::AddPlaylistTracks {
                playlist_id,
                track_ids,
            } => {
                service
                    .manipulate_playlist_tracks("add", playlist_id, &track_ids)
                    .await?;
            }
            NeteaseMutationDto::RemovePlaylistTracks {
                playlist_id,
                track_ids,
            } => {
                service
                    .manipulate_playlist_tracks("del", playlist_id, &track_ids)
                    .await?;
            }
            NeteaseMutationDto::SetArtistFavorite {
                artist_id,
                favorite,
            } => {
                service.subscribe_artist(artist_id, favorite).await?;
            }
            NeteaseMutationDto::SetMvFavorite { mv_id, favorite } => {
                service.subscribe_mv(mv_id, favorite).await?;
            }
            NeteaseMutationDto::SetDjRadioFavorite { radio_id, favorite } => {
                service.subscribe_dj_radio(radio_id, favorite).await?;
            }
            NeteaseMutationDto::TrashFmTrack { track_id } => {
                service.trash_fm_song(track_id).await?;
            }
            NeteaseMutationDto::SetTrackFavorite { track_id, favorite } => {
                service.like_song(track_id, favorite).await?;
            }
            NeteaseMutationDto::AddComment {
                resource,
                resource_id,
                content,
            } => {
                result.comment = Some(netease_comment_dto(
                    service
                        .add_comment(netease_comment_resource(resource), resource_id, &content)
                        .await?,
                ));
            }
            NeteaseMutationDto::ReplyComment {
                resource,
                resource_id,
                comment_id,
                content,
            } => {
                result.comment = Some(netease_comment_dto(
                    service
                        .reply_comment(
                            netease_comment_resource(resource),
                            resource_id,
                            comment_id,
                            &content,
                        )
                        .await?,
                ));
            }
            NeteaseMutationDto::SetCommentFavorite {
                resource,
                resource_id,
                comment_id,
                favorite,
            } => {
                service
                    .like_comment(
                        netease_comment_resource(resource),
                        resource_id,
                        comment_id,
                        favorite,
                    )
                    .await?;
            }
            NeteaseMutationDto::DeleteComment {
                resource,
                resource_id,
                comment_id,
            } => {
                service
                    .delete_comment(netease_comment_resource(resource), resource_id, comment_id)
                    .await?;
            }
            NeteaseMutationDto::SetUserFollowed { user_id, followed } => {
                service.follow_user(user_id, followed).await?;
            }
            NeteaseMutationDto::DeleteCloudSong { cloud_id } => {
                service.delete_cloud_song(cloud_id).await?;
            }
        }
        Ok(result)
    }

    async fn start_qr_login(&self) -> AppResult<NeteaseLoginStartDto> {
        let _session_guard = self.session_gate.lock().await;
        let service = self.require_service()?;
        let key = service.create_login_qr_key().await?;
        let mut login = self.login.app_lock()?;
        login.generation = login.generation.saturating_add(1);
        login.active_login_id = Some(key.clone());
        Ok(NeteaseLoginStartDto {
            login_id: key.clone(),
            qr_image_data_url: NeteaseService::<ReqwestTransport>::qr_image_url(&key)?,
            expires_at: (unix_millis() + Duration::from_secs(300).as_millis() as u64).to_string(),
        })
    }

    async fn poll_qr_login(&self, login_id: &str) -> AppResult<NeteaseLoginStateDto> {
        validate_id(login_id, "loginId")?;
        let _session_guard = self.session_gate.lock().await;
        let generation = {
            let login = self.login.app_lock()?;
            if login.active_login_id.as_deref() != Some(login_id) {
                return Err(AppError::InvalidArgument(
                    "loginId is not the active QR generation".into(),
                ));
            }
            login.generation
        };
        let remote = self
            .require_service()?
            .check_login_qr_state(login_id)
            .await?;
        let mut login = self.login.app_lock()?;
        if login.generation != generation || login.active_login_id.as_deref() != Some(login_id) {
            return Err(AppError::Unavailable(
                "QR login generation changed while polling".into(),
            ));
        }
        let phase = match remote {
            LoginQrState::Expired => {
                login.active_login_id = None;
                NeteaseLoginPhaseDto::Expired
            }
            LoginQrState::Waiting => NeteaseLoginPhaseDto::Waiting,
            LoginQrState::Scanned => NeteaseLoginPhaseDto::Scanned,
            LoginQrState::Authorized => {
                let cookie = self
                    .transport
                    .as_ref()
                    .ok_or_else(|| {
                        AppError::Unavailable("NetEase HTTP transport is not configured".into())
                    })?
                    .take_authorized_cookie()?
                    .ok_or(AppError::Credential(
                        "authorized NetEase credential was not captured",
                    ))?;
                self.commit_authorized_session(&mut login, cookie)?;
                NeteaseLoginPhaseDto::Confirmed
            }
        };
        let authenticated = login.authenticated;
        let user_id = login.user_id.map(|id| id.to_string());
        let display_name = login.display_name.clone();
        drop(login);
        Ok(NeteaseLoginStateDto {
            phase,
            status: NeteaseStatusDto {
                enabled: self.settings.get()?.netease_enabled && self.service.is_some(),
                authenticated,
                user_id,
                display_name,
            },
        })
    }

    async fn logout(&self) -> AppResult<NeteaseStatusDto> {
        let _session_guard = self.session_gate.lock().await;
        self.vault.delete()?;
        let was_authenticated;
        let owner_user_id = {
            let mut login = self.login.app_lock()?;
            was_authenticated = login.authenticated;
            let owner_user_id = login.user_id;
            login.generation = login.generation.saturating_add(1);
            login.active_login_id = None;
            login.authenticated = false;
            login.user_id = None;
            login.display_name = None;
            login.secret = None;
            owner_user_id
        };
        if was_authenticated {
            self.lock_entitled_cache(owner_user_id)?;
        }
        if let Some(service) = &self.service {
            service.clear_user_cookie();
        }
        self.pending_mutations.app_lock()?.clear();
        self.entitlement.clear()?;
        self.status()
    }

    async fn resolve_track(&self, track: &TrackRefDto) -> AppResult<Track> {
        if track.source != TrackSourceDto::Netease {
            return Err(AppError::InvalidArgument(
                "expected a NetEase track reference".into(),
            ));
        }
        let song_id = parse_netease_id(&track.id)?;
        let service = self.require_service()?;
        let metadata = service
            .song_detail(&[song_id])
            .await?
            .into_iter()
            .find(|item| item.id == song_id)
            .ok_or_else(|| AppError::Unavailable("NetEase track does not exist".into()))?;
        if metadata.no_copyright {
            return Err(AppError::Unavailable(
                "NetEase reports that this track is not playable".into(),
            ));
        }
        let artist_ids = metadata
            .artists
            .iter()
            .map(|artist| artist.id.to_string())
            .collect();
        let artists = metadata
            .artists
            .into_iter()
            .map(|artist| artist.name)
            .collect();
        Ok(Track {
            id: MediaId::new(song_id.to_string()),
            source: MediaSource::Netease { song_id },
            title: metadata.name,
            artists,
            album: Some(metadata.album.name),
            album_id: Some(metadata.album.id.to_string()),
            artist_ids,
            artwork_hash: None,
            artwork_mime: None,
            duration_ms: Some(metadata.duration_ms),
        })
    }
}

#[async_trait]
impl PlaybackMediaBackend for NeteaseAdapter {
    async fn resolve_official(&self, track: &TrackRefDto) -> AppResult<OfficialPlaybackResource> {
        if track.source != TrackSourceDto::Netease {
            return Err(AppError::InvalidArgument(
                "expected a NetEase track reference".into(),
            ));
        }
        let song_id = parse_netease_id(&track.id)?;
        let service = self.require_service()?;
        let metadata = service
            .song_detail(&[song_id])
            .await?
            .into_iter()
            .find(|item| item.id == song_id)
            .ok_or_else(|| AppError::Unavailable("NetEase track does not exist".into()))?;
        if metadata.no_copyright {
            return Err(AppError::Unavailable(
                "NetEase reports that this track is not playable".into(),
            ));
        }
        let is_vip = metadata.is_vip;
        if is_vip {
            let user = service.account().await?.ok_or_else(|| {
                AppError::Unavailable("NetEase VIP playback requires login".into())
            })?;
            let vip = service.vip_info().await?;
            self.entitlement.update_from_vip(&user, &vip)?;
            if !vip.is_vip {
                return Err(AppError::Unavailable(
                    "NetEase VIP entitlement was not confirmed".into(),
                ));
            }
        }
        let artist_ids = metadata
            .artists
            .iter()
            .map(|artist| artist.id.to_string())
            .collect();
        let artists = metadata
            .artists
            .into_iter()
            .map(|artist| artist.name)
            .collect();
        let resolved = Track {
            id: MediaId::new(song_id.to_string()),
            source: MediaSource::Netease { song_id },
            title: metadata.name,
            artists,
            album: Some(metadata.album.name),
            album_id: Some(metadata.album.id.to_string()),
            artist_ids,
            artwork_hash: None,
            artwork_mime: None,
            duration_ms: Some(metadata.duration_ms),
        };
        let play_info = service
            .song_url(
                song_id,
                QualityPreference::Auto,
                is_vip,
                Duration::from_secs(12),
            )
            .await?;
        let url = authorized_official_url(&play_info, is_vip)?;
        let trusted_url = TrustedMediaUrl::parse(url).await?;
        Ok(OfficialPlaybackResource {
            track: resolved,
            url: trusted_url.0.into(),
            authorization: self.entitlement.confirm_official_playback()?,
        })
    }

    async fn refresh_authorization(&self, entry: &CacheEntry) -> AppResult<PlaybackAuthorization> {
        let track = TrackRefDto {
            id: entry.content_id.0.clone(),
            source: TrackSourceDto::Netease,
        };
        let authorization = self.resolve_official(&track).await?.authorization;
        if matches!(entry.access_class, CacheAccessClass::AccountEntitled { .. }) {
            self.account().await?;
            return self.entitlement.confirm_official_playback();
        }
        Ok(authorization)
    }

    async fn stream_official(&self, url: &str, destination: &mut std::fs::File) -> AppResult<()> {
        let client = secure_http_client()?;
        let mut response = send_trusted_media_request(&client, url).await?;
        let expected_length = response.content_length();
        if expected_length.is_some_and(|length| length == 0 || length > MAX_CACHE_DOWNLOAD_BYTES) {
            return Err(AppError::Unavailable(
                "official playback response size is outside the playback limit".into(),
            ));
        }
        let mut downloaded = 0_u64;
        while let Some(chunk) = response.chunk().await.map_err(map_reqwest_app_error)? {
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > MAX_CACHE_DOWNLOAD_BYTES {
                return Err(AppError::Unavailable(
                    "official playback response exceeded the playback limit".into(),
                ));
            }
            destination.write_all(&chunk)?;
        }
        if downloaded == 0 {
            return Err(AppError::Unavailable(
                "official playback response contained no audio bytes".into(),
            ));
        }
        if expected_length.is_some_and(|length| length != downloaded) {
            return Err(AppError::Unavailable(
                "official playback response length did not match Content-Length".into(),
            ));
        }
        Ok(())
    }
}

fn scan_registered_roots(
    roots: &[PathBuf],
    cancellation: &ScanCancellation,
    task_id: &str,
    progress: &ScanProgressSink,
    repository: &Repository,
    artwork: &ContentAddressedArtwork,
) -> hyperplayer_engine::Result<bool> {
    let scanner = LibraryScanner::default();
    let mut completed = 0_u64;
    for root in roots {
        if cancellation.is_cancelled() {
            return Ok(false);
        }

        let report = scanner.scan_with_cancel(std::slice::from_ref(root), cancellation)?;
        let mut found = report
            .tracks
            .iter()
            .map(|track| track.path.clone())
            .collect::<Vec<_>>();
        let cleanup_safe = preserve_failed_audio_paths(root, &report.failures, &mut found);
        let cancelled = report.cancelled;
        let tracks = report
            .tracks
            .into_iter()
            .filter(|track| is_playable_library_audio(&track.path))
            .collect::<Vec<_>>();
        let failures = report
            .failures
            .into_iter()
            .filter(|failure| !failure.path.is_file() || is_playable_library_audio(&failure.path))
            .collect::<Vec<_>>();

        for mut track in tracks {
            if cancellation.is_cancelled() {
                return Ok(false);
            }
            if let Err(error) = store_scanned_artwork(&mut track, artwork) {
                emit_scan_failure(
                    task_id,
                    completed,
                    progress,
                    &ScanFailure {
                        path: track.path.clone(),
                        message: format!("artwork: {error}"),
                    },
                );
            }
            if let Err(error) = repository
                .lock()
                .map_err(|_| hyperplayer_engine::EngineError::ActorUnavailable)?
                .upsert_track(&track)
            {
                emit_scan_failure(
                    task_id,
                    completed,
                    progress,
                    &ScanFailure {
                        path: track.path.clone(),
                        message: format!("index: {error}"),
                    },
                );
            }
            completed = completed.saturating_add(1);
            progress(ScanProgressDto {
                task_id: task_id.to_owned(),
                completed,
                total: None,
                phase: "indexing".into(),
            });
        }

        for failure in &failures {
            emit_scan_failure(task_id, completed, progress, failure);
        }
        if cancelled || cancellation.is_cancelled() {
            return Ok(false);
        }
        if cleanup_safe {
            preserve_existing_library_paths(root, repository, &mut found)?;
            repository
                .lock()
                .map_err(|_| hyperplayer_engine::EngineError::ActorUnavailable)?
                .remove_missing_under(root, &found)?;
        } else {
            progress(ScanProgressDto {
                task_id: task_id.to_owned(),
                completed,
                total: None,
                phase: format!(
                    "error:{}: missing-file cleanup skipped because the root was not fully readable",
                    root.display()
                ),
            });
        }
    }
    Ok(true)
}

fn preserve_existing_library_paths(
    root: &Path,
    repository: &Repository,
    found: &mut Vec<PathBuf>,
) -> hyperplayer_engine::Result<()> {
    let repository = repository
        .lock()
        .map_err(|_| hyperplayer_engine::EngineError::ActorUnavailable)?;
    let mut offset = 0;
    loop {
        let tracks = repository.list_tracks(500, offset)?;
        let count = tracks.len();
        for track in tracks {
            if track.path.starts_with(root) {
                if let Ok(metadata) = fs::symlink_metadata(&track.path) {
                    if metadata.is_file() && !metadata.file_type().is_symlink() {
                        found.push(track.path);
                    }
                }
            }
        }
        if count < 500 {
            return Ok(());
        }
        offset += 500;
    }
}

fn is_playable_library_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            hyperplayer_engine::audio::PLAYABLE_LOCAL_EXTENSIONS
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

fn store_scanned_artwork(
    track: &mut LibraryTrack,
    artwork: &ContentAddressedArtwork,
) -> hyperplayer_engine::Result<()> {
    match read_embedded_artwork(&track.path) {
        Ok(Some(object)) => {
            artwork.store(&object)?;
            track.track.artwork_hash = Some(object.content_hash);
            track.track.artwork_mime = Some(object.mime_type);
            Ok(())
        }
        Ok(None) => {
            track.track.artwork_hash = None;
            track.track.artwork_mime = None;
            Ok(())
        }
        Err(error) => {
            track.track.artwork_hash = None;
            track.track.artwork_mime = None;
            Err(error)
        }
    }
}

fn preserve_failed_audio_paths(
    root: &Path,
    failures: &[ScanFailure],
    found: &mut Vec<PathBuf>,
) -> bool {
    let mut cleanup_safe = true;
    for failure in failures {
        match fs::symlink_metadata(&failure.path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                if failure.path.starts_with(root) {
                    found.push(failure.path.clone());
                }
            }
            _ => cleanup_safe = false,
        }
    }
    cleanup_safe
}

fn emit_scan_failure(
    task_id: &str,
    completed: u64,
    progress: &ScanProgressSink,
    failure: &ScanFailure,
) {
    progress(ScanProgressDto {
        task_id: task_id.to_owned(),
        completed,
        total: None,
        phase: format!("error:{}: {}", failure.path.display(), failure.message),
    });
}

fn canonical_directory(path: &Path) -> AppResult<PathBuf> {
    reject_non_local_path(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::InvalidArgument("library location cannot be resolved".into()))?;
    reject_non_local_path(&canonical)?;
    if !canonical.is_dir() {
        return Err(AppError::InvalidArgument(
            "library location must be a directory".into(),
        ));
    }
    ensure_local_volume(&canonical)?;
    Ok(canonical)
}

fn reject_non_local_path(path: &Path) -> AppResult<()> {
    let value = path.as_os_str().to_string_lossy().replace('/', "\\");
    let lowered = value.to_ascii_lowercase();
    let extended_drive = lowered.starts_with("\\\\?\\")
        && lowered
            .get(4..)
            .is_some_and(|rest| rest.as_bytes().get(1) == Some(&b':'));
    if (lowered.starts_with("\\\\") && !extended_drive)
        || lowered.starts_with("\\\\.\\")
        || lowered.starts_with("\\\\?\\unc\\")
        || lowered.starts_with("\\\\?\\globalroot\\")
        || (lowered.starts_with("\\\\?\\")
            && lowered
                .get(4..)
                .is_none_or(|rest| rest.as_bytes().get(1) != Some(&b':')))
        || lowered.starts_with("http:")
        || lowered.starts_with("https:")
        || lowered.starts_with("webdav:")
    {
        return Err(AppError::InvalidArgument(
            "library location must be on a local filesystem volume".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_local_volume(path: &Path) -> AppResult<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};

    let value = path.as_os_str().to_string_lossy();
    let bytes = value.as_bytes();
    let drive_letter = if value.starts_with(r"\\?\") {
        bytes.get(4).copied()
    } else {
        bytes.first().copied()
    }
    .filter(u8::is_ascii_alphabetic)
    .ok_or_else(|| AppError::InvalidArgument("library location has no local volume".into()))?;
    let root = [drive_letter as u16, ':' as u16, '\\' as u16, 0];
    let drive_type = unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) };
    if drive_type != DRIVE_FIXED && drive_type != DRIVE_REMOVABLE {
        return Err(AppError::InvalidArgument(
            "library location must use a fixed or removable local volume".into(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_local_volume(_path: &Path) -> AppResult<()> {
    Ok(())
}

fn stable_hash(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn netease_comment_resource(resource: NeteaseCommentResourceDto) -> CommentResource {
    match resource {
        NeteaseCommentResourceDto::Song => CommentResource::Song,
        NeteaseCommentResourceDto::Mv => CommentResource::Mv,
        NeteaseCommentResourceDto::Playlist => CommentResource::Playlist,
        NeteaseCommentResourceDto::Album => CommentResource::Album,
        NeteaseCommentResourceDto::Radio => CommentResource::Radio,
        NeteaseCommentResourceDto::Video => CommentResource::Video,
        NeteaseCommentResourceDto::Event => CommentResource::Event,
        NeteaseCommentResourceDto::DigitalAlbum => CommentResource::DigitalAlbum,
    }
}

fn netease_page(page: &PageRequestDto) -> AppResult<PageRequest> {
    validate_page(page)?;
    Ok(PageRequest {
        limit: usize::from(page.limit),
        offset: parse_cursor(page.cursor.as_deref())?,
    })
}

fn netease_listen_period(period: NeteaseListenPeriodDto) -> &'static str {
    match period {
        NeteaseListenPeriodDto::Week => "week",
        NeteaseListenPeriodDto::Month => "month",
        NeteaseListenPeriodDto::Year => "year",
    }
}

fn validate_netease_limit(limit: u16) -> AppResult<()> {
    if (1..=100).contains(&limit) {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(
            "limit must be between 1 and 100".into(),
        ))
    }
}

fn validate_positive_id(id: u64, field: &str) -> AppResult<()> {
    if id == 0 {
        Err(AppError::InvalidArgument(format!(
            "{field} must be greater than zero"
        )))
    } else {
        Ok(())
    }
}

fn validate_netease_mutation(mutation: &NeteaseMutationDto) -> AppResult<()> {
    match mutation {
        NeteaseMutationDto::SetAlbumFavorite { album_id, .. } => {
            validate_positive_id(*album_id, "albumId")
        }
        NeteaseMutationDto::CreatePlaylist { name, .. } => {
            NeteaseService::<ReqwestTransport>::validate_create_playlist(name)?;
            Ok(())
        }
        NeteaseMutationDto::DeletePlaylist { playlist_id }
        | NeteaseMutationDto::SetPlaylistFavorite { playlist_id, .. } => {
            validate_positive_id(*playlist_id, "playlistId")
        }
        NeteaseMutationDto::UpdatePlaylist {
            playlist_id,
            name,
            description,
            tags,
        } => {
            validate_positive_id(*playlist_id, "playlistId")?;
            NeteaseService::<ReqwestTransport>::validate_update_playlist(
                name.as_deref(),
                description,
            )?;
            if tags.len() > 3 || tags.iter().any(|tag| tag.trim().is_empty()) {
                return Err(AppError::InvalidArgument(
                    "playlist tags must contain at most three non-empty values".into(),
                ));
            }
            Ok(())
        }
        NeteaseMutationDto::AddPlaylistTracks {
            playlist_id,
            track_ids,
        }
        | NeteaseMutationDto::RemovePlaylistTracks {
            playlist_id,
            track_ids,
        } => {
            validate_positive_id(*playlist_id, "playlistId")?;
            validate_id_list(track_ids, "trackIds")
        }
        NeteaseMutationDto::SetArtistFavorite { artist_id, .. } => {
            validate_positive_id(*artist_id, "artistId")
        }
        NeteaseMutationDto::SetMvFavorite { mv_id, .. } => validate_positive_id(*mv_id, "mvId"),
        NeteaseMutationDto::SetDjRadioFavorite { radio_id, .. } => {
            validate_positive_id(*radio_id, "radioId")
        }
        NeteaseMutationDto::TrashFmTrack { track_id }
        | NeteaseMutationDto::SetTrackFavorite { track_id, .. } => {
            validate_positive_id(*track_id, "trackId")
        }
        NeteaseMutationDto::AddComment {
            resource_id,
            content,
            ..
        } => {
            validate_positive_id(*resource_id, "resourceId")?;
            validate_comment_content(content)
        }
        NeteaseMutationDto::ReplyComment {
            resource_id,
            comment_id,
            content,
            ..
        } => {
            validate_positive_id(*resource_id, "resourceId")?;
            validate_positive_id(*comment_id, "commentId")?;
            validate_comment_content(content)
        }
        NeteaseMutationDto::SetCommentFavorite {
            resource_id,
            comment_id,
            ..
        }
        | NeteaseMutationDto::DeleteComment {
            resource_id,
            comment_id,
            ..
        } => {
            validate_positive_id(*resource_id, "resourceId")?;
            validate_positive_id(*comment_id, "commentId")
        }
        NeteaseMutationDto::SetUserFollowed { user_id, .. } => {
            validate_positive_id(*user_id, "userId")
        }
        NeteaseMutationDto::DeleteCloudSong { cloud_id } => {
            validate_positive_id(*cloud_id, "cloudId")
        }
    }
}

fn validate_id_list(ids: &[u64], field: &str) -> AppResult<()> {
    if ids.is_empty() || ids.contains(&0) || ids.len() > 1000 {
        Err(AppError::InvalidArgument(format!(
            "{field} must contain 1 to 1000 positive ids"
        )))
    } else {
        Ok(())
    }
}

fn validate_comment_content(content: &str) -> AppResult<()> {
    let count = content.trim().chars().count();
    if !(1..=140).contains(&count) {
        Err(AppError::InvalidArgument(
            "comment content must contain 1 to 140 characters".into(),
        ))
    } else {
        Ok(())
    }
}

fn mutation_digest(mutation: &NeteaseMutationDto, summary: &str) -> AppResult<[u8; 32]> {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(mutation)?);
    hasher.update([0]);
    hasher.update(summary.as_bytes());
    Ok(hasher.finalize().into())
}

fn netease_mutation_summary(mutation: &NeteaseMutationDto) -> String {
    match mutation {
        NeteaseMutationDto::SetAlbumFavorite { favorite, .. } => {
            set_summary(*favorite, "favorite album", "unfavorite album")
        }
        NeteaseMutationDto::CreatePlaylist { .. } => "create playlist".into(),
        NeteaseMutationDto::DeletePlaylist { .. } => "delete playlist".into(),
        NeteaseMutationDto::UpdatePlaylist { .. } => "update playlist".into(),
        NeteaseMutationDto::SetPlaylistFavorite { favorite, .. } => {
            set_summary(*favorite, "favorite playlist", "unfavorite playlist")
        }
        NeteaseMutationDto::AddPlaylistTracks { .. } => "add tracks to playlist".into(),
        NeteaseMutationDto::RemovePlaylistTracks { .. } => "remove tracks from playlist".into(),
        NeteaseMutationDto::SetArtistFavorite { favorite, .. } => {
            set_summary(*favorite, "favorite artist", "unfavorite artist")
        }
        NeteaseMutationDto::SetMvFavorite { favorite, .. } => {
            set_summary(*favorite, "favorite MV", "unfavorite MV")
        }
        NeteaseMutationDto::SetDjRadioFavorite { favorite, .. } => {
            set_summary(*favorite, "favorite DJ radio", "unfavorite DJ radio")
        }
        NeteaseMutationDto::TrashFmTrack { .. } => "remove track from personal FM".into(),
        NeteaseMutationDto::SetTrackFavorite { favorite, .. } => {
            set_summary(*favorite, "favorite track", "unfavorite track")
        }
        NeteaseMutationDto::AddComment { .. } => "publish comment".into(),
        NeteaseMutationDto::ReplyComment { .. } => "publish comment reply".into(),
        NeteaseMutationDto::SetCommentFavorite { favorite, .. } => {
            set_summary(*favorite, "like comment", "unlike comment")
        }
        NeteaseMutationDto::DeleteComment { .. } => "delete comment".into(),
        NeteaseMutationDto::SetUserFollowed { followed, .. } => {
            set_summary(*followed, "follow user", "unfollow user")
        }
        NeteaseMutationDto::DeleteCloudSong { .. } => "delete cloud song".into(),
    }
}

fn set_summary(value: bool, enabled: &str, disabled: &str) -> String {
    if value { enabled } else { disabled }.into()
}

fn playback_dto(snapshot: PlaybackSnapshot, volume: f32) -> PlaybackStateDto {
    let (status, position_ms) = match &snapshot.state {
        PlaybackState::Idle | PlaybackState::Stopped { .. } => (PlaybackStatusDto::Stopped, 0),
        PlaybackState::Loading { .. } => (PlaybackStatusDto::Buffering, 0),
        PlaybackState::Playing { position_ms, .. } => (PlaybackStatusDto::Playing, *position_ms),
        PlaybackState::Paused { position_ms, .. } => (PlaybackStatusDto::Paused, *position_ms),
        PlaybackState::Failed { .. } => (PlaybackStatusDto::Error, 0),
    };
    let current_track = snapshot.state.current().map(|item| track_dto(&item.track));
    let duration_ms = current_track.as_ref().and_then(|track| track.duration_ms);
    PlaybackStateDto {
        status,
        current_track,
        position_ms,
        duration_ms,
        volume,
        muted: volume == 0.0,
        repeat_mode: dto_mode(snapshot.mode),
    }
}

fn queue_item_from_engine(item: &QueueItem) -> QueueItemDto {
    QueueItemDto {
        queue_item_id: item.queue_id.to_string(),
        track: track_dto(&item.track),
    }
}

fn parse_queue_id(value: &str) -> AppResult<u64> {
    validate_id(value, "queueItemId")?;
    value
        .parse()
        .map_err(|_| AppError::InvalidArgument("queueItemId must be an unsigned integer".into()))
}

fn playback_position(state: &PlaybackState) -> u64 {
    match state {
        PlaybackState::Playing { position_ms, .. } | PlaybackState::Paused { position_ms, .. } => {
            *position_ms
        }
        _ => 0,
    }
}

fn max_queue_id(queue: &PlaybackQueue) -> u64 {
    queue
        .context_snapshot()
        .current
        .into_iter()
        .chain(queue.priority().iter().cloned())
        .chain(queue.context().iter().cloned())
        .chain(queue.traversal_history().iter().cloned())
        .map(|item| item.queue_id)
        .max()
        .unwrap_or(0)
}

fn engine_mode(mode: RepeatModeDto) -> PlaybackMode {
    match mode {
        RepeatModeDto::Sequential => PlaybackMode::Sequential,
        RepeatModeDto::RepeatAll => PlaybackMode::RepeatAll,
        RepeatModeDto::RepeatOne => PlaybackMode::RepeatOne,
        RepeatModeDto::Shuffle => PlaybackMode::Shuffle,
    }
}

fn dto_mode(mode: PlaybackMode) -> RepeatModeDto {
    match mode {
        PlaybackMode::Sequential => RepeatModeDto::Sequential,
        PlaybackMode::RepeatAll => RepeatModeDto::RepeatAll,
        PlaybackMode::RepeatOne => RepeatModeDto::RepeatOne,
        PlaybackMode::Shuffle => RepeatModeDto::Shuffle,
    }
}

fn parse_cursor(cursor: Option<&str>) -> AppResult<usize> {
    cursor
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| AppError::InvalidArgument("cursor must be a numeric offset".into()))
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

fn parse_netease_id(value: &str) -> AppResult<u64> {
    value
        .strip_prefix("netease:")
        .unwrap_or(value)
        .parse()
        .map_err(|_| AppError::InvalidArgument("NetEase track id must be numeric".into()))
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn secure_http_client() -> AppResult<Client> {
    Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(map_reqwest_app_error)
}

#[derive(Clone, Debug)]
struct TrustedMediaUrl(Url);

impl TrustedMediaUrl {
    async fn parse(value: &str) -> AppResult<Self> {
        let url = Url::parse(value)
            .map_err(|_| AppError::Unavailable("official playback URL is invalid".into()))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port_or_known_default() != Some(443)
        {
            return Err(AppError::Unavailable(
                "official playback URL is not a trusted HTTPS endpoint".into(),
            ));
        }
        let host = url.host_str().ok_or_else(|| {
            AppError::Unavailable("official playback URL has no trusted host".into())
        })?;
        if host.parse::<IpAddr>().is_ok() || !is_trusted_media_host(host) {
            return Err(AppError::Unavailable(
                "official playback URL host is not allowlisted".into(),
            ));
        }
        let addresses = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| AppError::Unavailable("official playback host lookup failed".into()))?
            .map(|address| address.ip())
            .collect::<HashSet<_>>();
        if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(*address)) {
            return Err(AppError::Unavailable(
                "official playback host did not resolve to public addresses".into(),
            ));
        }
        Ok(Self(url))
    }
}

fn is_trusted_media_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ["music.126.net", "music.163.com"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

fn is_trusted_netease_image_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    [
        "music.126.net",
        "music.163.com",
        "p1.music.126.net",
        "p2.music.126.net",
    ]
    .iter()
    .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.is_multicast()
        || address.octets()[0] == 0
        || address.octets()[0] >= 224
        || address.octets()[0] == 100 && (64..=127).contains(&address.octets()[1]))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || address
            .to_ipv4_mapped()
            .is_some_and(|mapped| !is_public_ipv4(mapped)))
}

async fn send_trusted_media_request(client: &Client, initial: &str) -> AppResult<Response> {
    let mut current = TrustedMediaUrl::parse(initial).await?;
    for redirect_count in 0..=MAX_MEDIA_REDIRECTS {
        let response = client
            .get(current.0.clone())
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(map_reqwest_app_error)?;
        let remote_address = response.remote_addr().ok_or_else(|| {
            AppError::Unavailable("official playback connection address is unavailable".into())
        })?;
        if !is_public_ip(remote_address.ip()) {
            return Err(AppError::Unavailable(
                "official playback connection used a non-public address".into(),
            ));
        }
        if response.status().is_redirection() {
            if redirect_count == MAX_MEDIA_REDIRECTS {
                return Err(AppError::Unavailable(
                    "official playback response exceeded the redirect limit".into(),
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    AppError::Unavailable("official playback redirect is invalid".into())
                })?;
            let next = current.0.join(location).map_err(|_| {
                AppError::Unavailable("official playback redirect is invalid".into())
            })?;
            current = TrustedMediaUrl::parse(next.as_str()).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err(AppError::Unavailable(format!(
                "official playback request failed with HTTP {}",
                response.status().as_u16()
            )));
        }
        return Ok(response);
    }
    Err(AppError::Unavailable(
        "official playback request could not be completed".into(),
    ))
}

async fn send_trusted_netease_image_request(client: &Client, initial: &str) -> AppResult<Response> {
    let mut current = parse_trusted_netease_image_url(initial).await?;
    for redirect_count in 0..=MAX_NETEASE_IMAGE_REDIRECTS {
        let response = client
            .get(current.clone())
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(map_reqwest_app_error)?;
        let remote_address = response.remote_addr().ok_or_else(|| {
            AppError::Unavailable("NetEase image connection address is unavailable".into())
        })?;
        if !is_public_ip(remote_address.ip()) {
            return Err(AppError::Unavailable(
                "NetEase image connection used a non-public address".into(),
            ));
        }
        if response.status().is_redirection() {
            if redirect_count == MAX_NETEASE_IMAGE_REDIRECTS {
                return Err(AppError::Unavailable(
                    "NetEase image response exceeded the redirect limit".into(),
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::Unavailable("NetEase image redirect is invalid".into()))?;
            let next = current
                .join(location)
                .map_err(|_| AppError::Unavailable("NetEase image redirect is invalid".into()))?;
            current = parse_trusted_netease_image_url(next.as_str()).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err(AppError::Unavailable(format!(
                "NetEase image request failed with HTTP {}",
                response.status().as_u16()
            )));
        }
        return Ok(response);
    }
    Err(AppError::Unavailable(
        "NetEase image request could not be completed".into(),
    ))
}

async fn parse_trusted_netease_image_url(value: &str) -> AppResult<Url> {
    let url = Url::parse(value)
        .map_err(|_| AppError::Unavailable("NetEase image URL is invalid".into()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(AppError::Unavailable(
            "NetEase image URL is not a trusted HTTPS endpoint".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::Unavailable("NetEase image URL has no trusted host".into()))?;
    if host.parse::<IpAddr>().is_ok() || !is_trusted_netease_image_host(host) {
        return Err(AppError::Unavailable(
            "NetEase image URL host is not allowlisted".into(),
        ));
    }
    let addresses = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| AppError::Unavailable("NetEase image host lookup failed".into()))?
        .map(|address| address.ip())
        .collect::<HashSet<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(*address)) {
        return Err(AppError::Unavailable(
            "NetEase image host did not resolve to public addresses".into(),
        ));
    }
    Ok(url)
}

fn map_reqwest_app_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::Unavailable("network request timed out".into())
    } else if error.is_connect() {
        AppError::Unavailable("network connection failed".into())
    } else if error.is_body() || error.is_decode() {
        AppError::Unavailable("network response could not be read".into())
    } else {
        AppError::Unavailable("network request failed".into())
    }
}

fn map_reqwest_error(error: reqwest::Error) -> hyperplayer_source_netease::Error {
    if error.is_timeout() {
        hyperplayer_source_netease::Error::Timeout
    } else if error.is_connect() {
        hyperplayer_source_netease::Error::Transport("network connection failed".into())
    } else if error.is_body() || error.is_decode() {
        hyperplayer_source_netease::Error::Transport("network response could not be read".into())
    } else {
        hyperplayer_source_netease::Error::Transport("network request failed".into())
    }
}

fn entitlement_cache_metadata(
    metadata_is_vip: bool,
    user: Option<&UserAccount>,
    vip: Option<&VipInfo>,
    now_ms: u64,
) -> AppResult<(
    CacheAccessClass,
    Option<hyperplayer_engine::cache::EntitlementSnapshot>,
    Option<u64>,
)> {
    if !metadata_is_vip {
        return Ok((CacheAccessClass::Public, None, None));
    }
    let user =
        user.ok_or_else(|| AppError::Unavailable("NetEase VIP playback requires login".into()))?;
    let vip = vip
        .filter(|value| value.is_vip)
        .ok_or_else(|| AppError::Unavailable("NetEase VIP entitlement was not confirmed".into()))?;
    let valid_until_unix_ms = vip
        .expire_time
        .filter(|expires_at| *expires_at > now_ms)
        .ok_or_else(|| {
            AppError::Unavailable("NetEase VIP entitlement has no valid future expiry".into())
        })?;
    Ok((
        CacheAccessClass::AccountEntitled {
            owner_user_id: user.user_id,
        },
        Some(hyperplayer_engine::cache::EntitlementSnapshot {
            product: "netease-vip".into(),
            valid_until_unix_ms: Some(valid_until_unix_ms),
            server_revision: Some(format!(
                "netease:{}:{}:{}",
                user.user_id,
                vip.red_vip_level.unwrap_or_default(),
                valid_until_unix_ms
            )),
        }),
        Some(now_ms),
    ))
}

fn authorized_official_url(play_info: &PlayInfo, account_entitled: bool) -> AppResult<&str> {
    let url = play_info.url.as_deref().ok_or_else(|| {
        AppError::Unavailable("NetEase did not return an official playback URL".into())
    })?;
    if play_info.free_trial_info.is_some() || (play_info.is_paid_content && !account_entitled) {
        return Err(AppError::Unavailable(
            "NetEase did not authorize an official full-track playback URL".into(),
        ));
    }
    Ok(url)
}

fn cache_quality(value: &str) -> AppResult<&str> {
    let value = value.trim().to_ascii_lowercase();
    KNOWN_CACHE_QUALITIES
        .iter()
        .copied()
        .find(|quality| *quality == value)
        .ok_or_else(|| AppError::InvalidArgument(format!("unsupported cache quality: {value}")))
}

fn cache_quality_preference(value: &str) -> AppResult<QualityPreference> {
    match value {
        "standard" => Ok(QualityPreference::Standard),
        "higher" => Ok(QualityPreference::High),
        "exhigh" => Ok(QualityPreference::VeryHigh),
        "lossless" => Ok(QualityPreference::Lossless),
        "hires" => Ok(QualityPreference::HiRes),
        _ => Err(AppError::Unavailable(format!(
            "the NetEase adapter cannot request cache quality {value}"
        ))),
    }
}

fn cache_denial(denial: CacheGateDenial) -> &'static str {
    match denial {
        CacheGateDenial::CacheUnavailable => "cache resource is unavailable",
        CacheGateDenial::NotLoggedIn => "cache access requires login",
        CacheGateDenial::AccountMismatch => "cache belongs to another account",
        CacheGateDenial::EntitlementNotConfirmed => "VIP entitlement was not confirmed",
        CacheGateDenial::OfficialPlaybackNotConfirmed => {
            "official playback permission was not confirmed"
        }
        CacheGateDenial::ValidationMissing => "real-time entitlement validation is missing",
    }
}

#[cfg(test)]
#[path = "adapters_media_tests.rs"]
mod media_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use hyperplayer_engine::{
        audio::{AudioOutput, WavDecoderFactory},
        cache::{CacheEntry, EntitlementSnapshot},
        dsp::{PcmFormat, PcmSampleFormat},
    };

    struct TestOutput(PcmFormat);

    impl AudioOutput for TestOutput {
        fn format(&self) -> PcmFormat {
            self.0
        }
        fn start(&mut self) -> hyperplayer_engine::Result<()> {
            Ok(())
        }
        fn pause(&mut self) -> hyperplayer_engine::Result<()> {
            Ok(())
        }
        fn stop(&mut self) -> hyperplayer_engine::Result<()> {
            Ok(())
        }
        fn write(&mut self, pcm: &[f32]) -> hyperplayer_engine::Result<usize> {
            Ok(pcm.len())
        }
    }

    fn test_engine() -> EngineAdapter {
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let (prefetch_sender, _prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        EngineAdapter {
            handle: EngineHandle::spawn_with_output(
                ENGINE_COMMAND_CAPACITY,
                SHUFFLE_SEED,
                Box::new(WavDecoderFactory),
                Box::new(TestOutput(PcmFormat {
                    sample_rate: 8_000,
                    channels: 1,
                    sample_format: PcmSampleFormat::F32,
                })),
            )
            .unwrap(),
            repository,
            view: Mutex::new(EngineView {
                volume: 1.0,
                next_queue_id: 1,
            }),
            playback_context: Mutex::new(PlaybackContextDto::default()),
            playback_history: Mutex::new(None),
            album_session: Mutex::new(None),
            prefetch_sender,
            restored_media_pending: Mutex::new(false),
            operation: Mutex::new(()),
            telemetry_activity: Arc::new(TelemetryActivityCoordinator::default()),
        }
    }

    fn local_engine_track(id: u64, path: PathBuf) -> Track {
        Track {
            id: MediaId::new(id.to_string()),
            source: MediaSource::Local { path },
            title: "Track".into(),
            artists: vec!["Artist".into()],
            album: Some("Album".into()),
            album_id: None,
            artist_ids: vec![],
            artwork_hash: None,
            artwork_mime: None,
            duration_ms: Some(1),
        }
    }

    fn local_engine_media(id: u64, path: PathBuf) -> TrustedResolvedMedia {
        let file = fs::File::open(&path).unwrap();
        TrustedResolvedMedia::new(
            local_engine_track(id, path.clone()),
            MediaHandle::local(file, path),
        )
    }

    fn minimal_wav() -> Vec<u8> {
        let samples = [0_i16; 8];
        let data_size = u32::try_from(samples.len() * 2).unwrap();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&8_000_u32.to_le_bytes());
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        wav.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
        wav
    }

    fn tagged_mp3_with_artwork(artwork: &[u8]) -> Vec<u8> {
        let mut picture = Vec::new();
        picture.push(0);
        picture.extend_from_slice(b"image/png\0");
        picture.push(3);
        picture.push(0);
        picture.extend_from_slice(artwork);

        let mut frame = Vec::new();
        frame.extend_from_slice(b"APIC");
        frame.extend_from_slice(&(picture.len() as u32).to_be_bytes());
        frame.extend_from_slice(&[0, 0]);
        frame.extend_from_slice(&picture);

        let size = frame.len() as u32;
        let mut encoded = Vec::new();
        encoded.extend_from_slice(b"ID3\x03\0\0");
        encoded.extend_from_slice(&[
            ((size >> 21) & 0x7f) as u8,
            ((size >> 14) & 0x7f) as u8,
            ((size >> 7) & 0x7f) as u8,
            (size & 0x7f) as u8,
        ]);
        encoded.extend_from_slice(&frame);
        for _ in 0..8 {
            let mut audio_frame = [0_u8; 72];
            audio_frame[..4].copy_from_slice(&[0xff, 0xe3, 0x18, 0xc0]);
            encoded.extend_from_slice(&audio_frame);
        }
        encoded
    }

    fn playback_snapshot(item: QueueItem, position_ms: u64) -> PlaybackSnapshot {
        let mut queue = PlaybackQueue::new(SHUFFLE_SEED);
        queue.replace_context(vec![item.clone()], 0);
        PlaybackSnapshot {
            state: PlaybackState::Playing { item, position_ms },
            mode: PlaybackMode::Sequential,
            next: None,
            priority_count: 0,
            context_count: 1,
            queue: queue.context_snapshot(),
            revision: 1,
            dsp_execution: Default::default(),
        }
    }

    #[test]
    fn telemetry_activity_uses_highest_live_subscription_rate() {
        let activity = TelemetryActivityCoordinator::default();
        let first = activity.register().unwrap();
        let second = activity.register().unwrap();
        activity.update(first, 30).unwrap();
        activity.update(second, 2).unwrap();
        assert_eq!(activity.effective_rate.load(Ordering::Acquire), 30);
        activity.unregister(first);
        assert_eq!(activity.effective_rate.load(Ordering::Acquire), 2);
        activity.unregister(second);
        assert_eq!(activity.effective_rate.load(Ordering::Acquire), 0);
    }

    #[test]
    fn engine_snapshot_uses_one_authoritative_revision() {
        let adapter = test_engine();
        let item = QueueItem::new(41, local_engine_track(1, PathBuf::from("snapshot.wav")));
        let mut snapshot = playback_snapshot(item, 250);
        snapshot.dsp_execution.revision = 8;
        let dto = adapter.engine_dto(snapshot).unwrap();
        assert_eq!(dto.revision, dto.queue.revision);
        assert_eq!(dto.revision, 1);
        assert_eq!(dto.dsp_execution.revision, 8);
        assert_eq!(dto.playback.position_ms, 250);
    }

    #[test]
    fn playback_history_uses_one_row_per_queue_item_and_persists_pause_position() {
        let adapter = test_engine();
        let item = QueueItem::new(41, local_engine_track(1, PathBuf::from("history.wav")));
        let first = playback_snapshot(item.clone(), 0);
        adapter.update_playback_history(&first).unwrap();
        let progress = playback_snapshot(item.clone(), 5_500);
        adapter.update_playback_history(&progress).unwrap();
        let mut paused = progress;
        paused.state = PlaybackState::Paused {
            item,
            position_ms: 6_250,
        };
        adapter.update_playback_history(&paused).unwrap();

        let history = adapter
            .repository
            .lock()
            .unwrap()
            .playback_history(10)
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].media_id, MediaId::new("1"));
        assert_eq!(history[0].position_ms, 6_250);
    }

    #[test]
    fn album_session_requires_explicit_matching_context_and_ignores_seek_jumps() {
        let mut adapter = test_engine();
        let (prefetch_sender, prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        adapter.prefetch_sender = prefetch_sender;
        let mut track = local_engine_track(1, PathBuf::from("album.wav"));
        track.album_id = Some("album-1".into());
        let item = QueueItem::new(42, track);
        let first = playback_snapshot(item.clone(), 1_000);

        adapter.update_album_schedule(&first).unwrap();
        assert!(adapter.album_session.lock().unwrap().is_none());
        assert!(prefetch_receiver.try_recv().is_err());

        *adapter.playback_context.lock().unwrap() = PlaybackContextDto {
            kind: PlaybackContextKindDto::Album,
            id: Some("album-1".into()),
        };
        adapter.update_album_schedule(&first).unwrap();
        assert_eq!(prefetch_receiver.try_recv().unwrap().track.id, "1");
        let jumped = playback_snapshot(item, 10_000);
        adapter.update_album_schedule(&jumped).unwrap();
        let session = adapter.album_session.lock().unwrap();
        assert_eq!(session.as_ref().unwrap().effective_playback_ms, 0);
    }

    #[test]
    fn playback_context_rejects_spoofed_album_ids() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("context.wav");
        fs::write(&path, minimal_wav()).unwrap();
        let mut media = local_engine_media(1, path);
        media.track.album_id = Some("album-1".into());
        assert!(EngineAdapter::validate_playback_context(
            &media,
            &PlaybackContextDto {
                kind: PlaybackContextKindDto::Album,
                id: Some("other-album".into()),
            },
        )
        .is_err());
    }

    #[test]
    fn album_context_schedules_next_and_records_five_minute_session() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("album-one.wav");
        let second = directory.path().join("album-two.wav");
        fs::write(&first, minimal_wav()).unwrap();
        fs::write(&second, minimal_wav()).unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let (prefetch_sender, prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let handle = EngineHandle::spawn_with_output(
            ENGINE_COMMAND_CAPACITY,
            SHUFFLE_SEED,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput(PcmFormat {
                sample_rate: 8_000,
                channels: 1,
                sample_format: PcmSampleFormat::F32,
            })),
        )
        .unwrap();
        let adapter =
            EngineAdapter::with_handle(handle, repository, false, prefetch_sender).unwrap();
        let mut one = local_engine_track(1, first.clone());
        one.album_id = Some("album-1".into());
        let mut two = local_engine_track(2, second.clone());
        two.album_id = Some("album-1".into());
        adapter
            .enqueue_resolved(
                TrustedResolvedMedia::new(
                    one,
                    MediaHandle::local(fs::File::open(&first).unwrap(), first),
                ),
                QueueInsertPositionDto::ContextEnd,
            )
            .unwrap();
        adapter
            .enqueue_resolved(
                TrustedResolvedMedia::new(
                    two,
                    MediaHandle::local(fs::File::open(&second).unwrap(), second),
                ),
                QueueInsertPositionDto::ContextEnd,
            )
            .unwrap();
        *adapter.playback_context.lock().unwrap() = PlaybackContextDto {
            kind: PlaybackContextKindDto::Album,
            id: Some("album-1".into()),
        };
        let mut snapshot = adapter.handle.snapshot().unwrap();
        let item = snapshot.state.current().unwrap().clone();
        for position_ms in 0..=QUALIFYING_PLAYBACK_MS {
            if !position_ms.is_multiple_of(1_000) {
                continue;
            }
            snapshot.state = PlaybackState::Playing {
                item: item.clone(),
                position_ms,
            };
            adapter.update_album_schedule(&snapshot).unwrap();
        }

        let first_request = prefetch_receiver.try_recv().unwrap();
        let second_request = prefetch_receiver.try_recv().unwrap();
        assert_eq!(first_request.track.id, "1");
        assert_eq!(second_request.track.id, "2");
        assert!(prefetch_receiver.try_recv().is_err());
        let mut repository = adapter.repository.lock().unwrap();
        let duplicate = repository
            .record_album_session(&AlbumSession {
                album_id: "album-1".into(),
                local_day: chrono::Local::now().date_naive().to_string(),
                from_album_context: true,
                completed_tracks: 0,
                effective_playback_ms: QUALIFYING_PLAYBACK_MS,
            })
            .unwrap();
        assert!(!duplicate.counted);
        assert_eq!(duplicate.qualified_sessions, 1);
    }

    #[test]
    fn queue_mutations_use_engine_snapshot_and_persist() {
        let directory = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (1..=3)
            .map(|id| {
                let path = directory.path().join(format!("{id}.wav"));
                fs::write(&path, minimal_wav()).unwrap();
                path
            })
            .collect();
        let adapter = test_engine();
        for (id, path) in paths.into_iter().enumerate() {
            adapter
                .enqueue_resolved(
                    local_engine_media((id + 1) as u64, path),
                    QueueInsertPositionDto::ContextEnd,
                )
                .unwrap();
        }
        let initial = adapter.snapshot().unwrap();
        assert_eq!(initial.context.len(), 3);
        let moved = adapter
            .reorder(ReorderQueueRequestDto {
                queue_item_id: initial.context[2].queue_item_id.clone(),
                target_index: 1,
            })
            .unwrap();
        assert_eq!(moved.queue.context[1].track.track_ref.id, "3");
        assert_eq!(moved.queue.revision, initial.revision + 1);
        let removed = adapter
            .remove(&moved.queue.context[1].queue_item_id)
            .unwrap();
        assert_eq!(removed.queue.context.len(), 2);
        assert_eq!(removed.queue.revision, moved.queue.revision + 1);
        let persisted = adapter
            .repository
            .lock()
            .unwrap()
            .load_playback_session()
            .unwrap()
            .unwrap();
        assert_eq!(persisted.queue.context().len(), 2);
        assert_eq!(adapter.clear_all().unwrap().queue.context.len(), 0);
    }

    #[test]
    fn restore_recovers_position_paused() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("restore.wav");
        let mut audio = minimal_wav();
        audio.extend(std::iter::repeat_n(0_u8, 16_000));
        let data_size = (audio.len() - 44) as u32;
        audio[4..8].copy_from_slice(&(36 + data_size).to_le_bytes());
        audio[40..44].copy_from_slice(&data_size.to_le_bytes());
        fs::write(&path, audio).unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let mut queue = PlaybackQueue::new(SHUFFLE_SEED);
        queue.replace_context(vec![QueueItem::new(7, local_engine_track(7, path))], 0);
        repository
            .lock()
            .unwrap()
            .save_playback_session(&queue, 500, 1)
            .unwrap();
        let handle = EngineHandle::spawn_with_output(
            ENGINE_COMMAND_CAPACITY,
            SHUFFLE_SEED,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput(PcmFormat {
                sample_rate: 8_000,
                channels: 1,
                sample_format: PcmSampleFormat::F32,
            })),
        )
        .unwrap();
        let (prefetch_sender, _prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let adapter =
            EngineAdapter::with_handle(handle, repository, true, prefetch_sender).unwrap();
        let state = adapter.state().unwrap();
        assert_eq!(state.status, PlaybackStatusDto::Paused);
        assert!(state.position_ms >= 500);
        assert_eq!(state.current_track.unwrap().track_ref.id, "7");
    }

    #[test]
    fn restored_local_queue_resolves_through_library_and_resumes_without_queue_changes() {
        let root = tempfile::tempdir().unwrap();
        let first_path = root.path().join("restore-one.wav");
        let second_path = root.path().join("restore-two.wav");
        let mut audio = minimal_wav();
        audio.extend(std::iter::repeat_n(0_u8, 16_000));
        let data_size = (audio.len() - 44) as u32;
        audio[4..8].copy_from_slice(&(36 + data_size).to_le_bytes());
        audio[40..44].copy_from_slice(&data_size.to_le_bytes());
        fs::write(&first_path, &audio).unwrap();
        fs::write(&second_path, &audio).unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        for (id, path) in [(7, &first_path), (8, &second_path)] {
            repository
                .lock()
                .unwrap()
                .upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                    track: local_engine_track(id, path.clone()),
                    path: path.clone(),
                    file_size: audio.len() as u64,
                    modified_unix_ms: 0,
                    sample_rate: Some(8_000),
                    channels: Some(1),
                    bitrate_kbps: None,
                })
                .unwrap();
        }
        let mut queue = PlaybackQueue::new(SHUFFLE_SEED);
        queue.replace_context(
            vec![
                QueueItem::new(70, local_engine_track(7, first_path.clone())),
                QueueItem::new(80, local_engine_track(8, second_path.clone())),
            ],
            0,
        );
        queue.set_mode(PlaybackMode::RepeatAll);
        let original = queue.context_snapshot();
        repository
            .lock()
            .unwrap()
            .save_playback_session(&queue, 500, 1)
            .unwrap();
        let locations = Arc::new(LocationRegistry::in_memory().unwrap());
        locations.register(root.path()).unwrap();
        let resolver_root = tempfile::tempdir().unwrap();
        let resolver = TrackResolver::new(
            repository.clone(),
            locations,
            Arc::new(NeteaseAdapter::disabled(Arc::new(SettingsAdapter::new()))),
            resolver_root.path().join("cache"),
            resolver_root.path().join("temporary"),
        )
        .unwrap();
        let handle = EngineHandle::spawn_with_output(
            ENGINE_COMMAND_CAPACITY,
            SHUFFLE_SEED,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput(PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            })),
        )
        .unwrap();
        let (prefetch_sender, _prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let adapter =
            EngineAdapter::with_handle(handle, repository, true, prefetch_sender).unwrap();

        let targets = adapter.restored_media_targets().unwrap();
        assert_eq!(
            targets.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            [70, 80]
        );
        let mut resolved = Vec::new();
        for (queue_id, track) in targets {
            resolved.push((
                queue_id,
                tauri::async_runtime::block_on(resolver.resolve(&track)).unwrap(),
            ));
        }
        adapter.attach_restored_media(resolved).unwrap();
        let playing = adapter
            .play_resolved(None, PlaybackContextDto::default())
            .unwrap();

        assert_eq!(playing.playback.status, PlaybackStatusDto::Playing);
        assert!(playing.playback.position_ms >= 500);
        assert_eq!(
            playing
                .queue
                .context
                .iter()
                .map(|item| item.queue_item_id.as_str())
                .collect::<Vec<_>>(),
            ["70", "80"]
        );
        let engine = adapter.handle.snapshot().unwrap();
        assert_eq!(engine.queue, original);
    }

    #[test]
    fn missing_restored_local_file_keeps_queue_paused_at_saved_position() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("missing-after-restore.wav");
        fs::write(&path, minimal_wav()).unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        repository
            .lock()
            .unwrap()
            .upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                track: local_engine_track(7, path.clone()),
                path: path.clone(),
                file_size: 44,
                modified_unix_ms: 0,
                sample_rate: Some(8_000),
                channels: Some(1),
                bitrate_kbps: None,
            })
            .unwrap();
        let mut queue = PlaybackQueue::new(SHUFFLE_SEED);
        queue.replace_context(
            vec![QueueItem::new(70, local_engine_track(7, path.clone()))],
            0,
        );
        repository
            .lock()
            .unwrap()
            .save_playback_session(&queue, 333, 1)
            .unwrap();
        let locations = Arc::new(LocationRegistry::in_memory().unwrap());
        locations.register(root.path()).unwrap();
        fs::remove_file(&path).unwrap();
        let resolver_root = tempfile::tempdir().unwrap();
        let resolver = TrackResolver::new(
            repository.clone(),
            locations,
            Arc::new(NeteaseAdapter::disabled(Arc::new(SettingsAdapter::new()))),
            resolver_root.path().join("cache"),
            resolver_root.path().join("temporary"),
        )
        .unwrap();
        let handle = EngineHandle::spawn_with_output(
            ENGINE_COMMAND_CAPACITY,
            SHUFFLE_SEED,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput(PcmFormat {
                sample_rate: 8_000,
                channels: 1,
                sample_format: PcmSampleFormat::F32,
            })),
        )
        .unwrap();
        let (prefetch_sender, _prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let adapter =
            EngineAdapter::with_handle(handle, repository, true, prefetch_sender).unwrap();
        let targets = adapter.restored_media_targets().unwrap();

        assert!(tauri::async_runtime::block_on(resolver.resolve(&targets[0].1)).is_err());
        let state = adapter.state().unwrap();
        assert_eq!(state.status, PlaybackStatusDto::Paused);
        assert_eq!(state.position_ms, 333);
        assert_eq!(
            adapter.snapshot().unwrap().current_item_id.as_deref(),
            Some("70")
        );
    }

    #[test]
    fn restored_transition_targets_cover_three_tracks_repeat_all_and_previous_history() {
        let directory = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (1..=3)
            .map(|id| {
                let path = directory.path().join(format!("transition-{id}.wav"));
                fs::write(&path, minimal_wav()).unwrap();
                path
            })
            .collect();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let items: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                QueueItem::new(
                    (index as u64 + 1) * 10,
                    local_engine_track(index as u64 + 1, path.clone()),
                )
            })
            .collect();
        let mut queue = PlaybackQueue::new(SHUFFLE_SEED);
        queue.replace_context(items, 0);
        queue.set_mode(PlaybackMode::RepeatAll);
        queue.advance(false);
        repository
            .lock()
            .unwrap()
            .save_playback_session(&queue, 400, 1)
            .unwrap();
        let handle = EngineHandle::spawn_with_output(
            ENGINE_COMMAND_CAPACITY,
            SHUFFLE_SEED,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput(PcmFormat {
                sample_rate: 8_000,
                channels: 1,
                sample_format: PcmSampleFormat::F32,
            })),
        )
        .unwrap();
        let (prefetch_sender, _prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let adapter =
            EngineAdapter::with_handle(handle, repository, true, prefetch_sender).unwrap();

        let next = adapter
            .transition_media_targets(PlaybackTransition::Next { automatic: false })
            .unwrap();
        assert_eq!(
            next.iter()
                .map(|target| target.queue_id)
                .collect::<Vec<_>>(),
            [30, 10]
        );
        let previous = adapter
            .transition_media_targets(PlaybackTransition::Previous)
            .unwrap();
        assert_eq!(
            previous
                .iter()
                .map(|target| target.queue_id)
                .collect::<Vec<_>>(),
            [10, 20]
        );
        let snapshot = adapter.handle.snapshot().unwrap();
        assert_eq!(snapshot.mode, PlaybackMode::RepeatAll);
        assert_eq!(snapshot.queue.current.as_ref().unwrap().queue_id, 20);
        assert_eq!(snapshot.queue.traversal_history[0].queue_id, 10);
    }

    #[test]
    fn restored_shuffle_targets_are_stable_without_mutating_queue() {
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let mut queue = PlaybackQueue::new(SHUFFLE_SEED);
        queue.replace_context(
            (1..=4)
                .map(|id| {
                    QueueItem::new(
                        id * 10,
                        local_engine_track(id, PathBuf::from(format!("{id}.wav"))),
                    )
                })
                .collect(),
            0,
        );
        queue.set_mode(PlaybackMode::Shuffle);
        let original = queue.context_snapshot();
        repository
            .lock()
            .unwrap()
            .save_playback_session(&queue, 0, 1)
            .unwrap();
        let handle = EngineHandle::spawn_with_output(
            ENGINE_COMMAND_CAPACITY,
            SHUFFLE_SEED,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput(PcmFormat {
                sample_rate: 8_000,
                channels: 1,
                sample_format: PcmSampleFormat::F32,
            })),
        )
        .unwrap();
        let (prefetch_sender, _prefetch_receiver) = std::sync::mpsc::sync_channel(8);
        let adapter =
            EngineAdapter::with_handle(handle, repository, true, prefetch_sender).unwrap();

        let first = adapter
            .transition_media_targets(PlaybackTransition::Next { automatic: true })
            .unwrap();
        let second = adapter
            .transition_media_targets(PlaybackTransition::Next { automatic: true })
            .unwrap();

        assert_eq!(first, second);
        assert_eq!(adapter.handle.snapshot().unwrap().queue, original);
    }

    #[test]
    fn playback_and_queue_share_one_engine_state() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("one.wav");
        let second = directory.path().join("two.wav");
        fs::write(&first, minimal_wav()).unwrap();
        fs::write(&second, minimal_wav()).unwrap();
        let adapter = test_engine();
        adapter
            .enqueue_resolved(
                local_engine_media(1, first),
                QueueInsertPositionDto::ContextEnd,
            )
            .unwrap();
        adapter
            .enqueue_resolved(
                local_engine_media(2, second),
                QueueInsertPositionDto::PlayNext,
            )
            .unwrap();
        assert_eq!(
            adapter.snapshot().unwrap().current_item_id.as_deref(),
            Some("1")
        );
        assert_eq!(
            adapter.snapshot().unwrap().play_next[0].track.track_ref.id,
            "2"
        );
    }

    #[test]
    fn cache_status_aggregates_all_quality_versions_and_remove_clears_them() {
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let entries = [
            CacheEntry {
                content_id: MediaId::new("42"),
                quality: "standard".into(),
                content_hash: "public-hash".into(),
                access_class: CacheAccessClass::Public,
                entitlement_snapshot: None,
                last_validated_unix_ms: Some(10),
                official_source: "netease".into(),
                state: CacheState::Available,
            },
            CacheEntry {
                content_id: MediaId::new("42"),
                quality: "lossless".into(),
                content_hash: "private-hash".into(),
                access_class: CacheAccessClass::AccountEntitled { owner_user_id: 7 },
                entitlement_snapshot: Some(EntitlementSnapshot {
                    product: "vip".into(),
                    valid_until_unix_ms: Some(i64::MAX as u64),
                    server_revision: Some("r1".into()),
                }),
                last_validated_unix_ms: Some(20),
                official_source: "netease".into(),
                state: CacheState::LockedEntitlement,
            },
        ];
        for entry in &entries {
            repository
                .lock()
                .unwrap()
                .upsert_cache_entry(entry)
                .unwrap();
        }
        let cache_root = tempfile::tempdir().unwrap();
        let netease = Arc::new(NeteaseAdapter::disabled(Arc::new(SettingsAdapter::new())));
        let adapter =
            CacheAdapter::new(repository, netease, cache_root.path().to_path_buf()).unwrap();
        let track = TrackRefDto {
            id: "42".into(),
            source: TrackSourceDto::Netease,
        };

        let status = adapter.status(&track).unwrap();
        assert_eq!(status.cached_versions, 2);
        assert_eq!(status.quality, None);
        assert_eq!(status.status, CacheEntryStatusDto::LockedEntitlement);
        assert_eq!(status.access_class, CacheAccessClassDto::AccountEntitled);
        assert_eq!(status.owner_user_id.as_deref(), Some("7"));
        assert_eq!(status.last_validated_at.as_deref(), Some("20"));

        adapter.remove(&track).unwrap();
        let status = adapter.status(&track).unwrap();
        assert_eq!(status.cached_versions, 0);
        assert_eq!(status.status, CacheEntryStatusDto::Missing);
    }

    #[test]
    fn cache_open_fails_closed_without_realtime_entitlement() {
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        repository
            .lock()
            .unwrap()
            .upsert_cache_entry(&CacheEntry {
                content_id: MediaId::new("42"),
                quality: "lossless".into(),
                content_hash: "private-hash".into(),
                access_class: CacheAccessClass::AccountEntitled { owner_user_id: 7 },
                entitlement_snapshot: Some(EntitlementSnapshot {
                    product: "vip".into(),
                    valid_until_unix_ms: Some(i64::MAX as u64),
                    server_revision: Some("r1".into()),
                }),
                last_validated_unix_ms: Some(1),
                official_source: "netease".into(),
                state: CacheState::Available,
            })
            .unwrap();
        let cache_root = tempfile::tempdir().unwrap();
        let netease = Arc::new(NeteaseAdapter::disabled(Arc::new(SettingsAdapter::new())));
        let adapter =
            CacheAdapter::new(repository, netease, cache_root.path().to_path_buf()).unwrap();
        assert!(matches!(
            adapter.open_cached_resource(
                &TrackRefDto {
                    id: "42".into(),
                    source: TrackSourceDto::Netease
                },
                "lossless"
            ),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn local_track_id_is_resolved_from_sqlite_and_registered_root() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("song.wav");
        fs::write(&path, []).unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        repository
            .lock()
            .unwrap()
            .upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                track: Track {
                    id: MediaId::new("local:trusted"),
                    source: MediaSource::Local { path: path.clone() },
                    title: "Trusted".into(),
                    artists: vec![],
                    album: None,
                    album_id: None,
                    artist_ids: vec![],
                    artwork_hash: None,
                    artwork_mime: None,
                    duration_ms: None,
                },
                path: path.clone(),
                file_size: 0,
                modified_unix_ms: 0,
                sample_rate: None,
                channels: None,
                bitrate_kbps: None,
            })
            .unwrap();
        let locations = Arc::new(LocationRegistry::in_memory().unwrap());
        locations.register(root.path()).unwrap();
        let settings = Arc::new(SettingsAdapter::new());
        let resolver_root = tempfile::tempdir().unwrap();
        let resolver = TrackResolver::new(
            repository,
            locations,
            Arc::new(NeteaseAdapter::disabled(settings)),
            resolver_root.path().join("cache"),
            resolver_root.path().join("temporary"),
        )
        .unwrap();

        let resolved = resolver
            .resolve_local(&TrackRefDto {
                id: "local:trusted".into(),
                source: TrackSourceDto::Local,
            })
            .unwrap();
        assert_eq!(resolved.track.id.0, "local:trusted");
        assert_eq!(
            resolved.handle.kind(),
            hyperplayer_engine::MediaHandleKind::Local
        );
        assert_eq!(
            resolved.track.source,
            MediaSource::Local {
                path: path.canonicalize().unwrap()
            }
        );
    }

    #[test]
    fn local_path_string_is_never_accepted_as_an_id() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("song.wav");
        fs::write(&path, []).unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let locations = Arc::new(LocationRegistry::in_memory().unwrap());
        locations.register(root.path()).unwrap();
        let resolver_root = tempfile::tempdir().unwrap();
        let resolver = TrackResolver::new(
            repository,
            locations,
            Arc::new(NeteaseAdapter::disabled(Arc::new(SettingsAdapter::new()))),
            resolver_root.path().join("cache"),
            resolver_root.path().join("temporary"),
        )
        .unwrap();

        assert!(matches!(
            resolver.resolve_local(&TrackRefDto {
                id: path.to_string_lossy().into_owned(),
                source: TrackSourceDto::Local,
            }),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn non_local_library_paths_are_rejected_before_io() {
        for path in [
            r"\\server\share\Music",
            r"\\?\UNC\server\share\Music",
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1",
            "https://example.test/dav",
            "webdav://example.test/music",
        ] {
            assert!(matches!(
                reject_non_local_path(Path::new(path)),
                Err(AppError::InvalidArgument(_))
            ));
        }
    }

    #[test]
    fn official_playback_allows_entitled_paid_urls_but_rejects_trials() {
        let paid = PlayInfo {
            id: 7,
            url: Some("https://m10.music.126.net/full.flac".into()),
            level: hyperplayer_source_netease::QualityLevel::Lossless,
            bitrate: 0,
            size_bytes: 0,
            md5: String::new(),
            container_type: "flac".into(),
            fee: 1,
            free_trial_info: None,
            is_paid_content: true,
        };
        assert_eq!(
            authorized_official_url(&paid, true).unwrap(),
            "https://m10.music.126.net/full.flac"
        );
        assert!(authorized_official_url(&paid, false).is_err());

        let trial = PlayInfo {
            free_trial_info: Some(hyperplayer_source_netease::FreeTrialInfo {
                start: 0,
                end: 30_000,
            }),
            ..paid
        };
        assert!(authorized_official_url(&trial, true).is_err());
    }

    #[test]
    fn trusted_media_hosts_and_public_addresses_are_strict() {
        assert!(is_trusted_media_host("m10.music.126.net"));
        assert!(is_trusted_media_host("music.163.com"));
        assert!(!is_trusted_media_host("music.126.net.attacker.test"));
        assert!(!is_trusted_media_host("example.com"));
        assert!(is_trusted_netease_image_host("p1.music.126.net"));
        assert!(is_trusted_netease_image_host("sub.music.163.com"));
        assert!(!is_trusted_netease_image_host(
            "music.163.com.attacker.test"
        ));
        assert!(!is_trusted_netease_image_host("example.com"));
        assert!(!is_trusted_netease_image_host("127.0.0.1"));
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        for address in ["127.0.0.1", "10.0.0.1", "169.254.1.2", "::1", "fc00::1"] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn registering_a_location_also_authorizes_engine_media_paths() {
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("song.wav");
        fs::write(&audio, b"RIFF").unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        repository
            .lock()
            .unwrap()
            .upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                track: Track {
                    id: MediaId::new("local:registered"),
                    source: MediaSource::Local {
                        path: audio.clone(),
                    },
                    title: "Song".into(),
                    artists: vec![],
                    album: None,
                    album_id: None,
                    artist_ids: vec![],
                    artwork_hash: None,
                    artwork_mime: None,
                    duration_ms: None,
                },
                path: audio,
                file_size: 4,
                modified_unix_ms: 0,
                sample_rate: None,
                channels: None,
                bitrate_kbps: None,
            })
            .unwrap();
        let adapter = LibraryAdapter::new(
            repository.clone(),
            Arc::new(LocationRegistry::in_memory().unwrap()),
            root.path().join("artwork"),
        )
        .unwrap();

        adapter.register_location(root.path()).unwrap();

        assert!(repository
            .lock()
            .unwrap()
            .media_path(&MediaId::new("local:registered"))
            .unwrap()
            .is_some());
    }

    #[test]
    fn production_scan_indexes_playable_files_stores_artwork_and_removes_missing_rows() {
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("tagged.mp3");
        let unsupported = root.path().join("not-playable.ogg");
        let missing = root.path().join("missing.wav");
        let artwork_bytes = b"\x89PNG\r\n\x1a\nscan-artwork";
        fs::write(&audio, tagged_mp3_with_artwork(artwork_bytes)).unwrap();
        fs::write(&unsupported, b"not valid ogg").unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        {
            let repository = repository.lock().unwrap();
            repository
                .upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                    track: local_engine_track(98, unsupported.clone()),
                    path: unsupported.clone(),
                    file_size: 0,
                    modified_unix_ms: 0,
                    sample_rate: None,
                    channels: None,
                    bitrate_kbps: None,
                })
                .unwrap();
            repository
                .upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                    track: local_engine_track(99, missing.clone()),
                    path: missing,
                    file_size: 0,
                    modified_unix_ms: 0,
                    sample_rate: None,
                    channels: None,
                    bitrate_kbps: None,
                })
                .unwrap();
        }
        let artwork_root = root.path().join("artwork");
        let artwork = ContentAddressedArtwork::new(&artwork_root).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let progress: ScanProgressSink =
            Arc::new(move |event| captured.lock().unwrap().push(event));

        assert!(scan_registered_roots(
            &[root.path().to_path_buf()],
            &ScanCancellation::default(),
            "scan",
            &progress,
            &repository,
            &artwork,
        )
        .unwrap());

        let tracks = repository.lock().unwrap().list_tracks(10, 0).unwrap();
        assert_eq!(tracks.len(), 2);
        let scanned = tracks.iter().find(|track| track.path == audio).unwrap();
        assert!(tracks.iter().any(|track| track.path == unsupported));
        let artwork_hash = scanned.track.artwork_hash.as_ref().unwrap();
        assert_eq!(
            fs::read(artwork_root.join(artwork_hash)).unwrap(),
            artwork_bytes
        );
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.phase.contains("not-playable.ogg")));
    }

    #[test]
    fn production_scan_preserves_rows_when_cancelled() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing.wav");
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        repository
            .lock()
            .unwrap()
            .upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                track: local_engine_track(99, missing.clone()),
                path: missing,
                file_size: 0,
                modified_unix_ms: 0,
                sample_rate: None,
                channels: None,
                bitrate_kbps: None,
            })
            .unwrap();
        let cancellation = ScanCancellation::default();
        cancellation.cancel();
        let artwork = ContentAddressedArtwork::new(root.path().join("artwork")).unwrap();
        let progress: ScanProgressSink = Arc::new(|_| {});

        assert!(!scan_registered_roots(
            &[root.path().to_path_buf()],
            &cancellation,
            "scan",
            &progress,
            &repository,
            &artwork,
        )
        .unwrap());
        assert_eq!(
            repository.lock().unwrap().list_tracks(10, 0).unwrap().len(),
            1
        );
    }

    #[test]
    fn production_scan_reports_each_malformed_playable_file() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("broken.mp3"), b"broken").unwrap();
        fs::write(root.path().join("ignored.m4a"), b"broken").unwrap();
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let artwork = ContentAddressedArtwork::new(root.path().join("artwork")).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let progress: ScanProgressSink =
            Arc::new(move |event| captured.lock().unwrap().push(event));

        assert!(scan_registered_roots(
            &[root.path().to_path_buf()],
            &ScanCancellation::default(),
            "scan",
            &progress,
            &repository,
            &artwork,
        )
        .unwrap());

        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| {
            event.phase.starts_with("error:") && event.phase.contains("broken.mp3")
        }));
        assert!(!events
            .iter()
            .any(|event| event.phase.contains("ignored.m4a")));
    }

    #[test]
    fn scan_task_ids_are_uuids_and_same_root_is_limited() {
        let root = tempfile::tempdir().unwrap();
        let locations = Arc::new(LocationRegistry::in_memory().unwrap());
        let location = locations.register(root.path()).unwrap();
        let adapter = LibraryAdapter::new(
            Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap())),
            locations,
            root.path().join("artwork"),
        )
        .unwrap();
        adapter.scans.lock().unwrap().insert(
            Uuid::new_v4().to_string(),
            ActiveScan {
                cancellation: Arc::new(ScanCancellation::default()),
                roots: vec![root.path().canonicalize().unwrap()],
            },
        );
        assert!(matches!(
            adapter.start_scan(
                LibraryScanRequestDto {
                    location_ids: vec![location.id]
                },
                Arc::new(|_| {})
            ),
            Err(AppError::Unavailable(_))
        ));
        assert!(adapter
            .scans
            .lock()
            .unwrap()
            .keys()
            .all(|task_id| Uuid::parse_str(task_id).is_ok()));
    }

    #[test]
    fn unknown_scan_location_id_is_rejected() {
        let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
        let artwork_root = tempfile::tempdir().unwrap();
        let adapter = LibraryAdapter::new(
            repository,
            Arc::new(LocationRegistry::in_memory().unwrap()),
            artwork_root.path().join("artwork"),
        )
        .unwrap();
        assert!(matches!(
            adapter.start_scan(
                LibraryScanRequestDto {
                    location_ids: vec!["C:/Music".into()]
                },
                Arc::new(|_| {})
            ),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn settings_persist_as_complete_json_without_temp_file_leak() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let adapter = SettingsAdapter::open(path.clone()).unwrap();
        adapter
            .update(UpdateSettingsRequestDto {
                theme: Some(ThemeDto::Dark),
                ..Default::default()
            })
            .unwrap();
        let updated = adapter
            .update(UpdateSettingsRequestDto {
                reduce_motion: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<SettingsDto>(&fs::read(path).unwrap()).unwrap(),
            updated
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn settings_migrates_missing_cache_policy_fields_to_defaults() {
        // A legacy settings.json without cache-policy fields must deserialize using the
        // serde defaults, which mirror the engine's `CachePolicy::default()`.
        let legacy = r#"{
            "theme": "light",
            "dynamicColor": true,
            "reduceMotion": false,
            "reduceTransparency": false,
            "restoreQueue": true,
            "autoplayOnStart": false,
            "closeBehavior": "ask",
            "neteaseEnabled": true
        }"#;
        let settings: SettingsDto = serde_json::from_str(legacy).unwrap();
        assert_eq!(settings.cache_capacity_bytes, 10 * 1024 * 1024 * 1024);
        assert_eq!(settings.cache_trim_percent, 90);
        assert_eq!(settings.cache_recent_track_limit, 100);
        assert!(settings.album_fill_enabled);
        assert_eq!(settings.album_fill_quality, "standard");
    }

    #[test]
    fn settings_update_rejects_invalid_cache_capacity() {
        let adapter = SettingsAdapter::new();
        let result = adapter.update(UpdateSettingsRequestDto {
            cache_capacity_bytes: Some(1),
            ..Default::default()
        });
        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
        // The optimistic in-memory value must not be overwritten on a rejected update.
        assert_eq!(
            adapter.get().unwrap().cache_capacity_bytes,
            10 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn settings_update_rejects_tampered_fixed_fields() {
        let adapter = SettingsAdapter::new();
        assert!(matches!(
            adapter.update(UpdateSettingsRequestDto {
                cache_trim_percent: Some(50),
                ..Default::default()
            }),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            adapter.update(UpdateSettingsRequestDto {
                cache_recent_track_limit: Some(42),
                ..Default::default()
            }),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            adapter.update(UpdateSettingsRequestDto {
                album_fill_quality: Some("studio".into()),
                ..Default::default()
            }),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn settings_update_applies_valid_cache_capacity_and_reads_back() {
        let adapter = SettingsAdapter::new();
        let updated = adapter
            .update(UpdateSettingsRequestDto {
                cache_capacity_bytes: Some(20 * 1024 * 1024 * 1024),
                album_fill_enabled: Some(false),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(updated.cache_capacity_bytes, 20 * 1024 * 1024 * 1024);
        assert!(!updated.album_fill_enabled);
        assert_eq!(
            adapter.get().unwrap().cache_capacity_bytes,
            20 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn dsp_config_persists_and_survives_reopen() {
        use crate::commands::dsp::DspConfigurationDto;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let adapter = SettingsAdapter::open(path.clone()).unwrap();
        // 初始无持久化 DSP 配置。
        assert!(adapter.persisted_dsp_config().unwrap().is_none());

        let mut dto = DspConfigurationDto::from_engine_value(
            7,
            &hyperplayer_engine::dsp_algorithms::DspConfig::default(),
        );
        dto.reverb.enabled = true;
        adapter
            .persist_dsp_config(&crate::dto::PersistedDspConfig {
                version: crate::dto::DSP_CONFIG_VERSION,
                revision: 7,
                configuration: dto,
            })
            .unwrap();

        let reopened = SettingsAdapter::open(path.clone()).unwrap();
        let restored = reopened.persisted_dsp_config().unwrap().expect("必须恢复");
        assert_eq!(restored.version, crate::dto::DSP_CONFIG_VERSION);
        assert_eq!(restored.revision, 7);
        assert!(restored.configuration.reverb.enabled);
    }

    #[test]
    fn dsp_config_migration_falls_back_on_missing_field() {
        // 旧 settings.json（无 dsp 字段）→ dsp=None。
        let no_dsp = r#"{
            "theme": "dark",
            "dynamicColor": true,
            "reduceMotion": false,
            "reduceTransparency": false,
            "restoreQueue": true,
            "autoplayOnStart": false,
            "closeBehavior": "ask",
            "neteaseEnabled": true,
            "cacheCapacityBytes": 10737418240,
            "cacheTrimPercent": 90,
            "cacheRecentTrackLimit": 100,
            "albumFillEnabled": true,
            "albumFillQuality": "standard"
        }"#;
        let settings: SettingsDto = serde_json::from_str(no_dsp).unwrap();
        assert!(settings.dsp.is_none());
    }

    #[test]
    fn dsp_config_upgrade_and_revision_zero_fall_back_to_none() {
        use crate::commands::dsp::DspConfigurationDto;
        let config = crate::dto::PersistedDspConfig {
            version: crate::dto::DSP_CONFIG_VERSION,
            revision: 7,
            configuration: DspConfigurationDto::from_engine_value(
                7,
                &hyperplayer_engine::dsp_algorithms::DspConfig::default(),
            ),
        };
        // 合法配置原样保留。
        assert_eq!(
            migrate_persisted_dsp(Some(config.clone()))
                .unwrap()
                .unwrap()
                .revision,
            7
        );
        // 未知 version → None。
        let mut stale = config.clone();
        stale.version = 99;
        assert!(migrate_persisted_dsp(Some(stale)).unwrap().is_none());
        // revision 0 → None。
        let mut zero = config;
        zero.revision = 0;
        assert!(migrate_persisted_dsp(Some(zero)).unwrap().is_none());
        // 缺失 → None。
        assert!(migrate_persisted_dsp(None).unwrap().is_none());
    }

    #[test]
    fn logout_invalidates_active_qr_generation() {
        let adapter = NeteaseAdapter::disabled(Arc::new(SettingsAdapter::new()));
        {
            let mut login = adapter.login.lock().unwrap();
            login.generation = 7;
            login.active_login_id = Some("active".into());
            login.authenticated = true;
        }
        tauri::async_runtime::block_on(adapter.logout()).unwrap();
        let login = adapter.login.lock().unwrap();
        assert_eq!(login.generation, 8);
        assert!(login.active_login_id.is_none());
        assert!(!login.authenticated);
    }

    #[test]
    fn disabled_netease_never_returns_fake_results() {
        let settings = Arc::new(SettingsAdapter::new());
        let adapter = NeteaseAdapter::disabled(settings);
        let result = tauri::async_runtime::block_on(adapter.search(NeteaseSearchRequestDto {
            query: "test".into(),
            kind: NeteaseSearchKindDto::Track,
            page: PageRequestDto {
                cursor: None,
                limit: 20,
            },
        }));
        assert!(matches!(result, Err(AppError::Unavailable(_))));
    }

    #[test]
    fn netease_domain_models_map_to_command_dtos() {
        let playlist = netease_playlist_dto(PlaylistSummary {
            id: 9,
            name: "List".into(),
            cover_url: Some("https://image.example/cover".into()),
            track_count: 2,
            play_count: Some(3),
            owner_id: 4,
            owner_name: Some("Owner".into()),
            description: Some("Description".into()),
        });
        assert_eq!(playlist.id, 9);
        assert_eq!(playlist.owner_name.as_deref(), Some("Owner"));

        let track = netease_track_dto(hyperplayer_source_netease::Track {
            id: 7,
            name: "Song".into(),
            artists: vec![Artist {
                id: 8,
                name: "Artist".into(),
            }],
            album: Album {
                id: 6,
                name: "Album".into(),
                pic_url: Some("https://image.example/album".into()),
            },
            duration_ms: 123,
            fee: 1,
            mv_id: None,
            is_vip: true,
            no_copyright: false,
        });
        assert_eq!(track.track_ref.id, "7");
        assert_eq!(track.track_ref.source, TrackSourceDto::Netease);
        assert_eq!(track.artists, vec!["Artist"]);
        assert!(track.playable);
        let json = serde_json::to_string(&track).unwrap();
        assert!(!json.contains("cookie"));
        assert!(!json.contains("route"));
        assert!(!json.contains("playUrl"));
    }

    #[test]
    fn mutation_confirmation_is_short_lived_single_use_and_session_bound() {
        let adapter = NeteaseAdapter::new(
            Arc::new(SettingsAdapter::new()),
            Arc::new(crate::credential_vault::MemoryCredentialVault::new(None)),
            Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap())),
        )
        .unwrap();
        adapter.login.lock().unwrap().authenticated = true;
        let confirmation = adapter
            .prepare_mutation_inner(
                "main",
                NeteaseMutationDto::SetTrackFavorite {
                    track_id: 7,
                    favorite: true,
                },
            )
            .unwrap();
        assert_eq!(confirmation.confirmation_token.len(), 48);
        assert!(confirmation.expires_at_ms > unix_millis());

        let mutation = adapter
            .take_pending_mutation(
                "main",
                NeteaseCommitMutationRequestDto {
                    confirmation_token: confirmation.confirmation_token.clone(),
                    confirmed: true,
                },
            )
            .unwrap();
        assert_eq!(
            mutation,
            NeteaseMutationDto::SetTrackFavorite {
                track_id: 7,
                favorite: true
            }
        );
        assert!(adapter
            .take_pending_mutation(
                "main",
                NeteaseCommitMutationRequestDto {
                    confirmation_token: confirmation.confirmation_token,
                    confirmed: true,
                },
            )
            .is_err());

        let confirmation = adapter
            .prepare_mutation_inner("main", NeteaseMutationDto::DeleteCloudSong { cloud_id: 11 })
            .unwrap();
        adapter.login.lock().unwrap().generation += 1;
        assert!(matches!(
            adapter.take_pending_mutation(
                "main",
                NeteaseCommitMutationRequestDto {
                    confirmation_token: confirmation.confirmation_token,
                    confirmed: true,
                },
            ),
            Err(AppError::Unavailable(_))
        ));
        let confirmation = adapter
            .prepare_mutation_inner("main", NeteaseMutationDto::DeleteCloudSong { cloud_id: 12 })
            .unwrap();
        assert!(matches!(
            adapter.take_pending_mutation(
                "mini-player",
                NeteaseCommitMutationRequestDto {
                    confirmation_token: confirmation.confirmation_token.clone(),
                    confirmed: true,
                },
            ),
            Err(AppError::Unavailable(_))
        ));
        assert!(adapter
            .take_pending_mutation(
                "main",
                NeteaseCommitMutationRequestDto {
                    confirmation_token: confirmation.confirmation_token,
                    confirmed: true,
                },
            )
            .is_err());
    }

    #[test]
    fn credential_restore_reuses_device_session_and_marks_authenticated() {
        use crate::credential_vault::MemoryCredentialVault;

        let stored = serde_json::to_vec(&StoredSession {
            version: NETEASE_SESSION_SCHEMA_VERSION,
            cookie: "MUSIC_U=restored-secret; __csrf=csrf-secret".into(),
            device_id: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123".into(),
            expires_at_ms: unix_millis() + 60_000,
        })
        .unwrap();
        let vault = Arc::new(MemoryCredentialVault::new(Some(stored)));
        let adapter = NeteaseAdapter::new(
            Arc::new(SettingsAdapter::new()),
            vault,
            Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap())),
        )
        .unwrap();

        let login = adapter.login.lock().unwrap();
        assert!(login.authenticated);
        assert_eq!(login.secret.as_ref().unwrap().device_id, adapter.device_id);
        assert_eq!(adapter.device_id.len(), 52);
    }

    #[test]
    fn expired_or_invalid_credentials_are_deleted_on_restore() {
        use crate::credential_vault::MemoryCredentialVault;

        for stored in [
            serde_json::to_vec(&StoredSession {
                version: NETEASE_SESSION_SCHEMA_VERSION,
                cookie: "MUSIC_U=expired-secret".into(),
                device_id: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123".into(),
                expires_at_ms: unix_millis().saturating_sub(1),
            })
            .unwrap(),
            b"not a credential document".to_vec(),
        ] {
            let vault = Arc::new(MemoryCredentialVault::new(Some(stored)));
            let restored = NeteaseAdapter::load_stored_session(vault.as_ref()).unwrap();
            assert!(restored.is_none());
            assert!(vault.snapshot().is_none());
        }
    }

    #[test]
    fn account_switch_replaces_vault_only_after_success() {
        use crate::credential_vault::MemoryCredentialVault;

        let vault = Arc::new(MemoryCredentialVault::new(None));
        let mut adapter =
            NeteaseAdapter::disabled_with_vault(Arc::new(SettingsAdapter::new()), vault.clone());
        adapter.device_id = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123".into();
        let mut login = LoginState {
            authenticated: true,
            secret: Some(SecretSession {
                cookie: "MUSIC_U=old-secret".into(),
                device_id: adapter.device_id.clone(),
                expires_at_ms: unix_millis() + 60_000,
            }),
            ..LoginState::default()
        };

        vault.set_fail_replace(true);
        assert!(adapter
            .commit_authorized_session(&mut login, "MUSIC_U=new-secret".into())
            .is_err());
        assert_eq!(login.secret.as_ref().unwrap().cookie, "MUSIC_U=old-secret");
        assert!(vault.snapshot().is_none());

        vault.set_fail_replace(false);
        adapter
            .commit_authorized_session(&mut login, "MUSIC_U=new-secret".into())
            .unwrap();
        let bytes = vault.snapshot().unwrap();
        let stored: StoredSession = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(stored.cookie, "MUSIC_U=new-secret");
        assert_eq!(login.secret.as_ref().unwrap().cookie, "MUSIC_U=new-secret");
    }

    #[test]
    fn logout_deletes_injected_vault_credential() {
        use crate::credential_vault::MemoryCredentialVault;

        let vault = Arc::new(MemoryCredentialVault::new(Some(
            b"encrypted-placeholder".to_vec(),
        )));
        let adapter =
            NeteaseAdapter::disabled_with_vault(Arc::new(SettingsAdapter::new()), vault.clone());
        {
            let mut login = adapter.login.lock().unwrap();
            login.authenticated = true;
            login.user_id = Some(42);
        }
        let content_hash = "5".repeat(64);
        {
            let repository = adapter.repository.lock().unwrap();
            repository
                .record_cache_object(
                    &hyperplayer_engine::cache::CacheObject {
                        content_hash: content_hash.clone(),
                        size_bytes: 1,
                        path: PathBuf::from(&content_hash),
                    },
                    1,
                )
                .unwrap();
            repository
                .upsert_cache_entry(&CacheEntry {
                    content_id: MediaId::new("vip-track"),
                    quality: "lossless".into(),
                    content_hash: content_hash.clone(),
                    access_class: CacheAccessClass::AccountEntitled { owner_user_id: 42 },
                    entitlement_snapshot: Some(EntitlementSnapshot {
                        product: "netease-vip".into(),
                        valid_until_unix_ms: Some(unix_millis() + 60_000),
                        server_revision: Some("revision".into()),
                    }),
                    last_validated_unix_ms: Some(unix_millis()),
                    official_source: "netease".into(),
                    state: CacheState::Available,
                })
                .unwrap();
            repository
                .acquire_cache_lease(&content_hash, &CacheLease::NextTrackPrefetch, unix_millis())
                .unwrap();
        }

        tauri::async_runtime::block_on(adapter.logout()).unwrap();

        assert!(vault.snapshot().is_none());
        assert!(!adapter.login.lock().unwrap().authenticated);
        let repository = adapter.repository.lock().unwrap();
        assert_eq!(
            repository
                .cache_entry(&MediaId::new("vip-track"), "lossless")
                .unwrap()
                .unwrap()
                .state,
            CacheState::LockedEntitlement
        );
        assert_eq!(repository.cache_lease_count(&content_hash).unwrap(), 0);
    }

    #[test]
    fn credential_errors_do_not_expose_secret_material() {
        let dto =
            crate::error::ErrorDto::from(AppError::Credential("could not replace credential"));
        let json = serde_json::to_string(&dto).unwrap();
        assert!(!json.contains("MUSIC_U"));
        assert!(!json.contains("secret"));
    }

    #[test]
    fn mutation_dto_is_closed_and_uses_camel_case_fields() {
        let request =
            serde_json::from_value::<NeteasePrepareMutationRequestDto>(serde_json::json!({
                "mutation": {
                    "kind": "addPlaylistTracks",
                    "playlistId": 2,
                    "trackIds": [3, 4]
                }
            }))
            .unwrap();
        assert_eq!(
            request.mutation,
            NeteaseMutationDto::AddPlaylistTracks {
                playlist_id: 2,
                track_ids: vec![3, 4]
            }
        );
        assert!(
            serde_json::from_value::<NeteasePrepareMutationRequestDto>(serde_json::json!({
                "mutation": {
                    "kind": "rawRoute",
                    "route": "/api/unsafe"
                }
            }))
            .is_err()
        );
    }
}
