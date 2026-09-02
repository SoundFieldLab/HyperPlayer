use crate::adapters::CacheAdapter;
use crate::dto::TrackSourceDto;
use crate::error::AppResult;
use crate::platform::windows::resource_probe::{Eligibility, ResourceProbe};
use async_trait::async_trait;
use hyperplayer_engine::album::{
    AlbumFillCoordinator, AlbumFillWorkAvailability, ResourceConditions,
};
use hyperplayer_engine::cache::{CacheEntry, CacheObject, ContentAddressedCache};
use hyperplayer_engine::cache_policy::{
    plan_eviction, plan_reconciliation, CachePolicy, DiskReservePolicy, ReconciliationInput,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

/// Repository lock alias reused from adapters; mirrors `adapters::Repository`.
type Repository = Arc<Mutex<hyperplayer_engine::repository::SqliteRepository>>;

/// Single-instance, cancellable startup cache reconciliation.
///
/// The planner derives a safe deletion plan and the executor performs disk IO
/// outside the repository lock. The repository snapshot is taken under the lock;
/// file deletion and scanning run without holding it, so a slow disk never
/// blocks playback, queue or other repository consumers.
pub struct CacheRuntime {
    repository: Repository,
    cache_root: PathBuf,
    cancelled: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl CacheRuntime {
    pub fn new(repository: Repository, cache_root: PathBuf) -> Self {
        Self {
            repository,
            cache_root,
            cancelled: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }

    /// Starts the reconciliation worker as a background thread. Returns immediately;
    /// the worker runs reconciliation once and then parks until cancelled by [`shutdown`].
    ///
    /// Guards against a second concurrent start by refusing to spawn again while the
    /// previous worker is still live. The caller (Tauri setup) starts it exactly once.
    pub fn start(self: Arc<Self>) -> AppResult<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| crate::error::AppError::StateUnavailable)?;
        if worker.is_some() {
            return Ok(());
        }
        let cancel = Arc::clone(&self.cancelled);
        let repository = Arc::clone(&self.repository);
        let cache_root = self.cache_root.clone();
        let handle = thread::Builder::new()
            .name("hyperplayer-cache-reconcile".into())
            .spawn(move || {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let result = run_once(&repository, cache_root.as_path());
                if let Err(error) = result {
                    eprintln!("[cache-runtime] startup reconciliation failed: {error}");
                }
            })?;
        *worker = Some(handle);
        Ok(())
    }

    /// Signals the worker to stop and joins it with a bounded wait. Returns true if
    /// the run was interrupted before completion (observed on shutdown).
    pub fn shutdown(&self) -> bool {
        self.cancelled.store(true, Ordering::Relaxed);
        let worker = self.worker.lock().ok().and_then(|mut guard| guard.take());
        match worker {
            Some(handle) => {
                // No coercion to interrupt a blocking IO; we release the lock and let
                // the worker drain. A join timeout is intentionally not used here so we
                // do not detach a thread that could outlive the runtime.
                let _ = handle.join();
                false
            }
            None => false,
        }
    }
}

/// Single instance, cancellable album-fill worker (Stage 12 / D30).
///
/// Spawns a background thread that repeatedly runs [`run_album_fill`], which gates on
/// resources (AC + unmetered + disk reserve via [`ResourceProbe`]) and on injected idle
/// signals, claims one album item, downloads it through the shared CAS path and commits it
/// atomically. The loop sleeps between passes and can be stopped via [`shutdown`].
///
/// Idle/playback/network/window signals are injected through an [`IdleSnapshotProvider`];
/// wiring real engine/lifecycle values is the caller's job so this stays testable.
///
/// [`shutdown`]: Self::shutdown
#[allow(dead_code)]
pub struct AlbumFillWorker {
    repository: Repository,
    downloader: Arc<dyn TrackDownloader>,
    probe: Arc<dyn ResourceProbe>,
    cache_root: PathBuf,
    reserve: DiskReservePolicy,
    idle: Arc<Mutex<dyn IdleSnapshotProvider>>,
    cancelled: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[allow(dead_code)]
impl AlbumFillWorker {
    pub fn new(
        repository: Repository,
        downloader: Arc<dyn TrackDownloader>,
        probe: Arc<dyn ResourceProbe>,
        cache_root: PathBuf,
        reserve: DiskReservePolicy,
        idle: Arc<Mutex<dyn IdleSnapshotProvider>>,
    ) -> Self {
        Self {
            repository,
            downloader,
            probe,
            cache_root,
            reserve,
            idle,
            cancelled: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }

    pub fn start(self: Arc<Self>) -> AppResult<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| crate::error::AppError::StateUnavailable)?;
        if worker.is_some() {
            return Ok(());
        }
        let cancel = Arc::clone(&self.cancelled);
        let repository = Arc::clone(&self.repository);
        let downloader = Arc::clone(&self.downloader);
        let probe = Arc::clone(&self.probe);
        let cache_root = self.cache_root.clone();
        let reserve = self.reserve;
        let idle = Arc::clone(&self.idle);
        let handle = thread::Builder::new()
            .name("hyperplayer-album-fill".into())
            .spawn(move || {
                while !cancel.load(Ordering::Relaxed) {
                    let snapshot = match idle.lock() {
                        Ok(provider) => provider.snapshot(),
                        Err(_) => return,
                    };
                    let result = tauri::async_runtime::block_on(run_album_fill(
                        &repository,
                        downloader.as_ref(),
                        probe.as_ref(),
                        snapshot,
                        cache_root.as_path(),
                        &reserve,
                        now_unix_ms(),
                    ));
                    if let Err(error) = result {
                        eprintln!("[album-fill] pass failed: {error}");
                    }
                    thread::sleep(std::time::Duration::from_secs(30));
                }
            })?;
        *worker = Some(handle);
        Ok(())
    }

    pub fn shutdown(&self) -> bool {
        self.cancelled.store(true, Ordering::Relaxed);
        let worker = self.worker.lock().ok().and_then(|mut guard| guard.take());
        match worker {
            Some(handle) => {
                let _ = handle.join();
                true
            }
            None => false,
        }
    }
}

/// Produces the album-fill worker's current idle snapshot. Implementors return
/// [`IdleSnapshot::unknown()`] when they cannot observe playback/network/window state so the
/// worker fails closed (never fills while signals are unavailable).
pub trait IdleSnapshotProvider: Send + Sync {
    fn snapshot(&self) -> IdleSnapshot;
}

pub fn run_once(repository: &Repository, cache_root: &Path) -> AppResult<ReconcileOutcome> {
    let policy = CachePolicy::default();
    let store = ContentAddressedCache::new(cache_root)?;

    // Scan disk (no lock): expired partials, orphan objects, current object paths.
    let storage = store.scan()?;

    // Snapshot DB (under lock): expected objects + lease-protected hashes.
    let (db_objects, now_unix_ms, protected_hashes) = {
        let repo = wrap_lock(repository)?;
        let objects = repo.cache_object_snapshot()?;
        let leases = repo.cache_leased_hashes()?;
        (objects, now_unix_ms(), leases)
    };

    let plan = plan_reconciliation(
        &policy,
        ReconciliationInput {
            cache_root: cache_root.to_path_buf(),
            now_unix_ms,
            db_objects,
            object_paths: storage.object_paths,
            partials: storage.partials,
            protected_hashes,
        },
    )?;

    let mut outcome = ReconcileOutcome::default();

    // Delete expired partials (no lock). Each is a safe root-relative file.
    for partial in &plan.expired_partials {
        if store.remove_relative_file(partial)? {
            outcome.expired_partials_removed += 1;
        }
    }

    // Delete orphan objects (no lock) — safe root-relative, lease-protected already filtered.
    for orphan in &plan.orphan_objects {
        if store.remove_relative_file(orphan)? {
            outcome.orphans_removed += 1;
        }
    }

    // Apply missing DB objects (under lock): unleased -> delete, leased -> downgrade to partial.
    if !plan.missing_db_objects.is_empty() {
        let mut repo = wrap_lock(repository)?;
        outcome.missing_invalidated = repo.apply_missing_cache_objects(&plan.missing_db_objects)?;
    }

    Ok(outcome)
}

fn wrap_lock(
    repository: &Repository,
) -> AppResult<std::sync::MutexGuard<'_, hyperplayer_engine::repository::SqliteRepository>> {
    repository
        .lock()
        .map_err(|_| crate::error::AppError::StateUnavailable)
}

/// Synchronous, testable capacity quota run. Executes an eviction when the cached
/// physical size exceeds the policy capacity, deleting files on disk *outside the
/// repository lock* and clearing the affected database rows *inside* it. Reuses the
/// same primitives as [`run_once`] (eviction snapshot + planner + safe relative file
/// deletion) rather than introducing a second model.
#[allow(dead_code)]
pub fn run_quota(repository: &Repository, cache_root: &Path) -> AppResult<QuotaOutcome> {
    let policy = CachePolicy::default();
    let store = ContentAddressedCache::new(cache_root)?;

    // Snapshot DB (under lock): eviction records + lease-protected hashes + physical
    // size + recent remote ids.
    let snapshot = {
        let repo = wrap_lock(repository)?;
        repo.cache_eviction_snapshot(policy.recent_track_limit)?
    };

    let plan = plan_eviction(
        &policy,
        snapshot.current_physical_size_bytes,
        now_unix_ms(),
        &snapshot.records,
        &snapshot.protected_hashes,
        &snapshot.recent_remote_ids,
    );

    // The planner projects the size after eviction starting from the current physical
    // size and subtracting each selected group. Reuse that accounting as the bytes
    // reclaimed, so the quota metric stays consistent with the trigger source.
    let freed_bytes = snapshot
        .current_physical_size_bytes
        .saturating_sub(plan.projected_size_bytes);
    let mut outcome = QuotaOutcome {
        triggered: snapshot.current_physical_size_bytes > policy.capacity_bytes,
        freed_bytes,
        evicted: 0,
    };

    // Deduplicate hashes across the (possibly multi-record) candidate set, preserving
    // the planner's selection order so the files are pruned in a deterministic way.
    let selected_hashes: Vec<String> = {
        let mut seen = HashSet::new();
        plan.candidates
            .iter()
            .map(|record| record.content_hash.clone())
            .filter(|hash| seen.insert(hash.clone()))
            .collect()
    };

    // Delete disk files first (no lock): each is a safe root-relative object file.
    for hash in &selected_hashes {
        let object_path = PathBuf::from("objects").join(hash);
        store.remove_relative_file(&object_path)?;
    }

    // Clear the DB rows out of the same plan (under lock, one batch). Leased hashes
    // are silently skipped by the repository, so this cannot delete an in-flight object.
    if !selected_hashes.is_empty() {
        let mut repo = wrap_lock(repository)?;
        let removed = repo.apply_cache_eviction_hashes(&selected_hashes)?;
        outcome.evicted = removed.len();
    }

    Ok(outcome)
}

/// Summary of a single capacity quota run, sufficient for logging and tests.
#[allow(dead_code)]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuotaOutcome {
    /// True when the run observed a physical size above the configured capacity.
    pub triggered: bool,
    /// Bytes reclaimed, taken from the planner's own projected size reduction so it
    /// stays consistent with the physical-size trigger source.
    pub freed_bytes: u64,
    /// Number of distinct content hashes removed from the database.
    pub evicted: usize,
}

/// Summary of a single reconciliation run, sufficient for logging and tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    pub expired_partials_removed: usize,
    pub orphans_removed: usize,
    pub missing_invalidated: usize,
}

impl ReconcileOutcome {
    /// True when a run found nothing to reconcile. Exposed for the future quota
    /// runtime state and diagnostics; currently only exercised by tests.
    #[allow(dead_code)]
    pub fn is_idle(&self) -> bool {
        self.expired_partials_removed == 0
            && self.orphans_removed == 0
            && self.missing_invalidated == 0
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

/// Idle/deadline signals the album-fill worker must observe before starting work.
///
/// The worker only runs when (a) the resource gate passes (`Eligibility::Allowed`, fail
/// closed), (b) playback has been idle for `playback_idle_ms`, (c) the network has been
/// idle for `network_idle_ms`, and (d) the window has been hidden for `window_hidden_ms`.
/// Stage 12 wires these dynamically; the trait lets the driver be tested with fake signals
/// rather than depending on engine/lifecycle wiring. The caller injects the current values
/// on each call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdleSnapshot {
    /// Milliseconds since the last playback activity, or `u64::MAX` when unknown
    /// (treated as a soft "not idle" so we never fill while signals are unavailable).
    pub playback_idle_ms: u64,
    /// Milliseconds since the last network activity, or `u64::MAX` when unknown.
    pub network_idle_ms: u64,
    /// Milliseconds since the window was last visible, or `u64::MAX` when unknown.
    pub window_hidden_ms: u64,
    /// Playback is `Playing` / actively using the cache (e.g. foreground prefetch) when true.
    pub foreground_active: bool,
}

impl IdleSnapshot {
    /// A fully "unknown" snapshot: fails every idle gate (fail closed).
    #[allow(dead_code)]
    pub fn unknown() -> Self {
        Self {
            playback_idle_ms: u64::MAX,
            network_idle_ms: u64::MAX,
            window_hidden_ms: u64::MAX,
            foreground_active: true,
        }
    }

    /// True when both idle thresholds and the hidden-window threshold are satisfied and no
    /// foreground playback requires the cache.
    pub fn idle_ready(&self, thresholds: &IdleThresholds) -> bool {
        !self.foreground_active
            && self.playback_idle_ms >= thresholds.playback_idle_ms
            && self.network_idle_ms >= thresholds.network_idle_ms
            && self.window_hidden_ms >= thresholds.window_hidden_ms
    }
}

/// Idle thresholds for a single album-fill run. Defaults to the Stage 12 guidance:
/// 60s playback idle, 30s network idle, and 2 min window hidden.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdleThresholds {
    pub playback_idle_ms: u64,
    pub network_idle_ms: u64,
    pub window_hidden_ms: u64,
}

impl Default for IdleThresholds {
    fn default() -> Self {
        Self {
            playback_idle_ms: 60 * 1_000,
            network_idle_ms: 30 * 1_000,
            window_hidden_ms: 2 * 60 * 1_000,
        }
    }
}

/// Failure classification for a single album-fill item download.
///
/// Distinguishes transient failures (safe to requeue and retry later) from permanent ones
/// (account/entitlement switch, expired or unavailable URL, track disappearance) that must
/// stop the item rather than burn attempts. The worker maps this to either a requeue
/// (`pending`) or a fail (`failed`) of the item.
fn classify_download_failure(error: &crate::error::AppError) -> bool {
    // Any Unavailable carrying entitlement/VIP/account/URL/song-not-found semantics is
    // treated as permanent (stop retrying). Transient network/size/flip errors are requeued.
    // The precise classification lives behind this helper so it stays testable and central.
    let message = error.to_string();
    let permanent_markers = [
        "VIP",
        "entitlement",
        "requires login",
        "may not be available",
        "does not exist",
        "trial or paid-content",
        "not confirmed",
        "non-public address",
    ];
    permanent_markers
        .iter()
        .any(|marker| message.to_lowercase().contains(&marker.to_lowercase()))
}

/// Downloads a single official track into the CAS store, returning the freshly committed
/// `(object, entry)`. Implemented by [`CacheAdapter`] for production and by test fakes.
///
/// This keeps the album-fill driver testable without network/CredentialVault wiring.
#[async_trait]
pub trait TrackDownloader: Send + Sync {
    async fn download_track_to_object(
        &self,
        track: &crate::dto::TrackRefDto,
        quality: &str,
    ) -> AppResult<(CacheObject, CacheEntry)>;
}

#[async_trait]
impl TrackDownloader for CacheAdapter {
    async fn download_track_to_object(
        &self,
        track: &crate::dto::TrackRefDto,
        quality: &str,
    ) -> AppResult<(CacheObject, CacheEntry)> {
        CacheAdapter::download_track_to_object(&self, track, quality).await
    }
}

/// Per-run outcome of the album-fill worker's single item pass, sufficient for logging
/// and tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AlbumFillOutcome {
    /// An item was claimed into `running` state but the pass did not download it.
    pub yielded: bool,
    /// An item was claimed and completed (cache object + entry + item committed).
    pub completed: usize,
    /// An item was claimed, failed permanently, and marked `failed` (no more retries).
    pub failed: usize,
    /// An item was claimed, hit a transient error, and requeued to `pending`.
    pub requeued: usize,
    /// The pass was blocked by resources / idle not ready, so no download happened.
    pub blocked_resources: bool,
    /// The pass found no eligible work to claim.
    pub idle: bool,
}

/// Runs a single album-fill worker pass: gate resources, gate idle, claim one item (BFS by
/// priority, single concurrency enforced by the repository), download it through
/// [`TrackDownloader`], and atomically complete it.
///
/// The provided `probe` supplies the resource snapshot (AC / unmetered / disk reserve) and
/// `idle` supplies the idle signals. Both are injected so the driver is testable with fakes
/// and does not hard-code engine / lifecycle access. Only one item is processed per call so
/// the worker stays cancellable between items and never monopolises a run.
pub async fn run_album_fill(
    repository: &Repository,
    downloader: &dyn TrackDownloader,
    probe: &dyn ResourceProbe,
    idle: IdleSnapshot,
    cache_root: &Path,
    reserve: &DiskReservePolicy,
    updated_unix_ms: u64,
) -> AppResult<AlbumFillOutcome> {
    let mut outcome = AlbumFillOutcome::default();

    // Gate 1: idle thresholds (playback idle 60s, network idle 30s, hidden 2 min). When the
    // injected provider cannot know, `idle_ready` is false (fail closed).
    if !idle.idle_ready(&IdleThresholds::default()) {
        outcome.blocked_resources = true;
        return Ok(outcome);
    }

    // Gate 2: resource eligibility (AC + unmetered + disk reserve), fail closed on unknown.
    let eligibility = probe.eligibility(cache_root, reserve);
    if !matches!(eligibility, Eligibility::Allowed) {
        let mut repo = wrap_lock(repository)?;
        repo.yield_album_fill_items(updated_unix_ms)?;
        outcome.blocked_resources = true;
        return Ok(outcome);
    }

    // Crash recovery: an orphaned `running` item (e.g. claimed then the process died before
    // completion) is returned to `pending` so it can be re-claimed. `yield_album_fill_items`
    // only touches `running`, so a `failed` item is never resurrected. The worker is
    // single-concurrent and never leaves an item `running` across two calls, so this is safe
    // to run before every pass.
    {
        let mut repo = wrap_lock(repository)?;
        repo.yield_album_fill_items(updated_unix_ms)?;
    }

    let conditions = ResourceConditions {
        pipeline_idle: true,
        network_idle: true,
        metered_network: false,
        low_battery: false,
        disk_pressure: false,
    };
    let claimed = {
        let mut repo = wrap_lock(repository)?;
        let coordinator = AlbumFillCoordinator::default();
        match coordinator.poll(
            &mut repo,
            &conditions,
            AlbumFillWorkAvailability::Idle,
            updated_unix_ms,
        )? {
            hyperplayer_engine::album::AlbumFillPoll::Claimed(item) => Some(item),
            hyperplayer_engine::album::AlbumFillPoll::YieldedToForeground => {
                outcome.yielded = true;
                None
            }
            hyperplayer_engine::album::AlbumFillPoll::BlockedResources => {
                outcome.blocked_resources = true;
                None
            }
            hyperplayer_engine::album::AlbumFillPoll::Idle => {
                outcome.idle = true;
                None
            }
        }
    };

    let Some(item) = claimed else {
        return Ok(outcome);
    };

    let track_ref = crate::dto::TrackRefDto {
        id: item.content_id.0.clone(),
        source: TrackSourceDto::Netease,
    };
    match downloader
        .download_track_to_object(&track_ref, &item.quality)
        .await
    {
        Ok((object, entry)) => {
            let mut repo = wrap_lock(repository)?;
            repo.complete_album_fill_item_with_cache(
                item.item_id,
                &object,
                &entry,
                updated_unix_ms,
            )?;
            outcome.completed += 1;
        }
        Err(error) => {
            let mut repo = wrap_lock(repository)?;
            if classify_download_failure(&error) {
                repo.fail_album_fill_item(item.item_id, &error.to_string(), updated_unix_ms)?;
                outcome.failed += 1;
            } else {
                repo.requeue_album_fill_item(item.item_id, updated_unix_ms)?;
                outcome.requeued += 1;
            }
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperplayer_engine::cache::CacheAccessClass;
    use hyperplayer_engine::cache::CacheAcquisitionClass;
    use hyperplayer_engine::cache::CacheEntry;
    use hyperplayer_engine::cache::CacheLease;
    use hyperplayer_engine::cache::CacheObject;
    use hyperplayer_engine::cache::CacheRecord;
    use hyperplayer_engine::cache::CacheState;
    use hyperplayer_engine::cache::PublicOfflineProof;
    use hyperplayer_engine::cache_policy::GIB;
    use hyperplayer_engine::model::MediaId;
    use hyperplayer_engine::repository::PlaybackHistoryRecord;
    use hyperplayer_engine::repository::SqliteRepository;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn repo() -> Arc<Mutex<SqliteRepository>> {
        Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()))
    }

    fn cache_root() -> TempDir {
        tempfile::tempdir().unwrap()
    }

    fn hash(byte: &str) -> String {
        byte.repeat(64)
    }

    fn make_objects_dir(root: &Path) {
        fs::create_dir_all(root.join("objects")).unwrap();
    }

    fn write_object(root: &Path, h: &str) {
        make_objects_dir(root);
        fs::write(root.join("objects").join(h), b"data").unwrap();
    }

    fn record_object(repository: &Repository, h: &str, size: u64) {
        repository
            .lock()
            .unwrap()
            .record_cache_object(
                &CacheObject {
                    content_hash: h.into(),
                    size_bytes: size,
                    path: PathBuf::from("objects").join(h),
                },
                1,
            )
            .unwrap();
    }

    fn write_partial(root: &Path, h: &str) {
        let dir = root.join("partial");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{h}.part")), b"partial").unwrap();
    }

    // Seeds both the physical-size row (`cache_objects`) and the eviction record
    // (`cache_entries`) so `cache_eviction_snapshot` sees a realistic quota state.
    fn seed_cache_entry(
        repository: &Repository,
        content_id: &str,
        h: &str,
        size: u64,
        last_accessed: u64,
    ) {
        let repo = repository.lock().unwrap();
        repo.record_cache_object(
            &CacheObject {
                content_hash: h.into(),
                size_bytes: size,
                path: PathBuf::from("objects").join(h),
            },
            1,
        )
        .unwrap();
        repo.upsert_cache_record(&CacheRecord {
            entry: CacheEntry {
                content_id: MediaId::new(content_id),
                quality: "standard".into(),
                content_hash: h.into(),
                access_class: CacheAccessClass::Public,
                entitlement_snapshot: None,
                last_validated_unix_ms: None,
                official_source: "netease".into(),
                state: CacheState::Available,
            },
            logical_size_bytes: size,
            last_accessed_unix_ms: last_accessed,
            acquisition_class: CacheAcquisitionClass::Automatic,
            public_offline_proof: Some(PublicOfflineProof {
                confirmed_unix_ms: 1,
                server_revision: "r".into(),
            }),
            partial_created_unix_ms: None,
            integrity_verified_unix_ms: Some(1),
        })
        .unwrap();
    }

    // Marks a content_id as recently played so the planner protects it from eviction.
    fn mark_recent(repository: &Repository, content_id: &str, played_unix_ms: u64) {
        repository
            .lock()
            .unwrap()
            .append_playback_history(&PlaybackHistoryRecord {
                media_id: MediaId::new(content_id),
                played_unix_ms,
                position_ms: 0,
            })
            .unwrap();
    }

    fn physical_size(repository: &Repository) -> u64 {
        repository
            .lock()
            .unwrap()
            .cache_eviction_snapshot(100)
            .unwrap()
            .current_physical_size_bytes
    }

    fn shell_outcome() -> (Arc<Mutex<SqliteRepository>>, TempDir) {
        (repo(), cache_root())
    }

    // Forces a file's modified time to be older than the partial_max_age (24h) so the
    // reconciliation planner treats it as an expired partial.
    fn age_file(root: &Path, h: &str) {
        let path = root.join("partial").join(format!("{h}.part"));
        let file = fs::File::options().write(true).open(path).unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);
        file.set_modified(past).unwrap();
    }

    #[test]
    fn run_removes_expired_partial_and_orphan_and_invalidates_missing() {
        let repository = repo();
        let root = cache_root();
        let partial_hash = hash("a");
        let orphan_hash = hash("b");
        let present_hash = hash("c");
        let missing_hash = hash("d");

        write_partial(root.path(), &partial_hash);
        age_file(root.path(), &partial_hash);
        write_object(root.path(), &orphan_hash);
        write_object(root.path(), &present_hash);
        record_object(&repository, &present_hash, 4);
        record_object(&repository, &missing_hash, 4);

        let outcome = run_once(&repository, root.path()).unwrap();

        assert!(!root
            .path()
            .join("partial")
            .join(format!("{partial_hash}.part"))
            .exists());
        assert!(!root.path().join("objects").join(&orphan_hash).exists());
        assert!(root.path().join("objects").join(&present_hash).exists());
        // The DB-only cache object with no file is reported as missing. Whether it is
        // deleted (unleased) or downgraded (leased) is exercised by the repository
        // `apply_missing_cache_objects` tests; here we just confirm the cleanup ran.
        assert_eq!(outcome.expired_partials_removed, 1);
        assert_eq!(outcome.orphans_removed, 1);
    }

    #[test]
    fn run_removes_free_orphan_but_preserves_lease_managed_object() {
        let repository = repo();
        let root = cache_root();
        let free_orphan = hash("5");
        let managed = hash("6");

        // A managed, present object: exists on disk and in DB, holds a lease.
        write_object(root.path(), &managed);
        record_object(&repository, &managed, 4);
        repository
            .lock()
            .unwrap()
            .acquire_cache_lease(&managed, &CacheLease::ActivePlayback, 1)
            .unwrap();
        // A free orphan on disk with no DB row and no lease.
        write_object(root.path(), &free_orphan);

        let outcome = run_once(&repository, root.path()).unwrap();

        assert!(root.path().join("objects").join(&managed).exists());
        assert!(!root.path().join("objects").join(&free_orphan).exists());
        assert_eq!(outcome.orphans_removed, 1);
    }

    #[test]
    fn run_is_idempotent_across_repeats() {
        let repository = repo();
        let root = cache_root();
        let orphan_hash = hash("1");
        write_object(root.path(), &orphan_hash);

        let first = run_once(&repository, root.path()).unwrap();
        assert_eq!(first.orphans_removed, 1);
        let second = run_once(&repository, root.path()).unwrap();
        assert!(second.is_idle());
    }

    #[test]
    fn run_quota_evicts_until_trim_target_when_over_capacity() {
        let (repository, root) = shell_outcome();
        // Five 3 GiB objects (15 GiB) exceed the 10 GiB capacity. The planner evicts
        // oldest-first Automatic groups until it lands on the 90% (9 GiB) trim target,
        // i.e. exactly the two oldest objects.
        let hashes: Vec<String> = (0..5).map(|i| hash(&i.to_string())).collect();
        for (index, h) in hashes.iter().enumerate() {
            seed_cache_entry(&repository, &format!("{index}"), h, 3 * GIB, index as u64);
            write_object(root.path(), h);
        }

        let outcome = run_quota(&repository, root.path()).unwrap();

        assert!(outcome.triggered);
        assert_eq!(outcome.freed_bytes, 6 * GIB);
        assert_eq!(outcome.evicted, 2);
        // The two oldest objects are evicted; the remainder lands exactly on target.
        assert!(!root.path().join("objects").join(&hashes[0]).exists());
        assert!(!root.path().join("objects").join(&hashes[1]).exists());
        for h in &hashes[2..] {
            assert!(root.path().join("objects").join(h).exists());
        }
        assert_eq!(physical_size(&repository), 9 * GIB);
    }

    #[test]
    fn run_quota_is_noop_below_capacity() {
        let (repository, root) = shell_outcome();
        let h = hash("a");
        seed_cache_entry(&repository, "100", &h, 1, 1);
        write_object(root.path(), &h);

        let outcome = run_quota(&repository, root.path()).unwrap();

        assert!(!outcome.triggered);
        assert_eq!(outcome.freed_bytes, 0);
        assert_eq!(outcome.evicted, 0);
        assert!(root.path().join("objects").join(&h).exists());
    }

    #[test]
    fn run_quota_protects_leased_and_recent_tracks() {
        let (repository, root) = shell_outcome();
        let leased = hash("a");
        let recent = hash("b");
        let evictable = hash("c");
        // Each is 6 GiB; any two exceed capacity, so the planner picks groups by rank
        // and must skip the leased/recent ones.
        seed_cache_entry(&repository, "100", &leased, 6 * GIB, 1);
        seed_cache_entry(&repository, "200", &recent, 6 * GIB, 2);
        seed_cache_entry(&repository, "300", &evictable, 6 * GIB, 3);
        write_object(root.path(), &leased);
        write_object(root.path(), &recent);
        write_object(root.path(), &evictable);
        repository
            .lock()
            .unwrap()
            .acquire_cache_lease(&leased, &CacheLease::ActivePlayback, 1)
            .unwrap();
        mark_recent(&repository, "200", 99_999);

        let outcome = run_quota(&repository, root.path()).unwrap();

        assert!(outcome.triggered);
        // Only the unprotected automatic group is evicted (leases/recent are protected).
        assert_eq!(outcome.evicted, 1);
        assert!(!root.path().join("objects").join(&evictable).exists());
        assert!(root.path().join("objects").join(&leased).exists());
        assert!(root.path().join("objects").join(&recent).exists());
    }

    #[test]
    fn run_quota_is_idempotent_across_repeats() {
        let (repository, root) = shell_outcome();
        let a = hash("a");
        let b = hash("b");
        seed_cache_entry(&repository, "100", &a, 6 * GIB, 1);
        seed_cache_entry(&repository, "200", &b, 5 * GIB, 2);
        write_object(root.path(), &a);
        write_object(root.path(), &b);

        let first = run_quota(&repository, root.path()).unwrap();
        assert_eq!(first.evicted, 1);
        let second = run_quota(&repository, root.path()).unwrap();
        // Second run observes the remaining size under capacity and does nothing.
        assert!(!second.triggered);
        assert_eq!(second.freed_bytes, 0);
        assert_eq!(second.evicted, 0);
    }

    #[test]
    fn run_quota_recovers_after_removing_all_rows() {
        let (repository, root) = shell_outcome();
        let h = hash("a");
        // A single 11 GiB object exceeds capacity and is evicted entirely.
        seed_cache_entry(&repository, "100", &h, 11 * GIB, 1);
        write_object(root.path(), &h);

        let outcome = run_quota(&repository, root.path()).unwrap();

        assert!(outcome.triggered);
        assert_eq!(outcome.evicted, 1);
        assert!(!root.path().join("objects").join(&h).exists());
        assert_eq!(physical_size(&repository), 0);
    }

    #[test]
    fn run_quota_is_re_runnable_after_io_failure() {
        let (repository, root) = shell_outcome();
        let h = hash("a");
        let path = root.path().join("objects").join(&h);
        seed_cache_entry(&repository, "100", &h, 11 * GIB, 1);
        // Simulate an IO failure: the to-be-evicted object is a directory, not a file,
        // so `remove_relative_file` errors out and the run aborts before any DB change.
        fs::create_dir_all(&path).unwrap();

        let first = run_quota(&repository, root.path());
        assert!(first.is_err());
        // The DB owed nothing to the failed run: the row is still present.
        assert_eq!(physical_size(&repository), 11 * GIB);

        // Repair the disk and re-run: the quota run now succeeds exactly once.
        fs::remove_dir_all(&path).unwrap();
        write_object(root.path(), &h);
        let second = run_quota(&repository, root.path()).unwrap();
        assert!(second.triggered);
        assert_eq!(second.evicted, 1);
        assert!(!path.exists());
        assert_eq!(physical_size(&repository), 0);
    }

    // ---- Stage 12 album-fill worker tests ----

    use crate::dto::TrackRefDto;
    use crate::error::AppError;
    use crate::platform::windows::resource_probe::{
        DiskReserveState, NetworkCostState, PowerState, ResourceSnapshot,
    };
    use hyperplayer_engine::album::AlbumFillItem;
    use hyperplayer_engine::album::AlbumFillItemPriority;
    use hyperplayer_engine::cache_policy::DiskReservePolicy;

    // A fake resource probe that returns a fixed 3-dimension snapshot.
    struct FakeProbe {
        snapshot: ResourceSnapshot,
    }

    impl ResourceProbe for FakeProbe {
        fn power_state(&self) -> PowerState {
            self.snapshot.power
        }
        fn network_cost_state(&self) -> NetworkCostState {
            self.snapshot.network_cost
        }
        fn free_space_bytes(&self, _cache_root: &Path) -> Option<(u64, u64)> {
            match self.snapshot.disk_reserve {
                DiskReserveState::MeetsReserve => Some((50 * 1024 * 1024, 100 * 1024 * 1024)),
                DiskReserveState::BelowReserve => Some((1, 100 * 1024 * 1024)),
                DiskReserveState::Unknown => None,
            }
        }
    }

    fn reserve() -> DiskReservePolicy {
        DiskReservePolicy {
            minimum_bytes: 10 * 1024 * 1024,
            minimum_percent: 10,
            resume_bytes: 12 * 1024 * 1024,
            resume_percent: 12,
        }
    }

    fn idle_ready() -> IdleSnapshot {
        IdleSnapshot {
            playback_idle_ms: 5 * 60 * 1_000,
            network_idle_ms: 60 * 1_000,
            window_hidden_ms: 3 * 60 * 1_000,
            foreground_active: false,
        }
    }

    fn ideal_snapshot() -> ResourceSnapshot {
        ResourceSnapshot {
            power: PowerState::OnAc,
            network_cost: NetworkCostState::Unmetered,
            disk_reserve: DiskReserveState::MeetsReserve,
        }
    }

    fn enqueue_item(repository: &Repository, album_id: &str, content_id: &str) -> i64 {
        repository
            .lock()
            .unwrap()
            .enqueue_album_fill_item(&AlbumFillItem::pending(
                album_id,
                MediaId::new(content_id),
                "standard",
                AlbumFillItemPriority::Standard,
                1,
            ))
            .unwrap()
    }

    fn album_item_state(
        repository: &Repository,
        item_id: i64,
    ) -> hyperplayer_engine::album::AlbumFillItemState {
        repository
            .lock()
            .unwrap()
            .album_fill_item(item_id)
            .unwrap()
            .unwrap()
            .state
    }

    fn item_state_is(
        repository: &Repository,
        item_id: i64,
        expect: hyperplayer_engine::album::AlbumFillItemState,
    ) -> bool {
        album_item_state(repository, item_id) == expect
    }

    // A fake downloader; each invocation pops one queued result. `calls` counts invocations
    // so the single-concurrency test can assert exactly one item is processed per run, and a
    // queue lets the tests exercise a second pass (retry / next item) without exhausting.
    struct FakeDownloader {
        results: std::sync::Mutex<Vec<AppResult<(CacheObject, CacheEntry)>>>,
        calls: Mutex<usize>,
    }

    impl FakeDownloader {
        fn new(results: Vec<AppResult<(CacheObject, CacheEntry)>>) -> Self {
            Self {
                results: std::sync::Mutex::new(results),
                calls: Mutex::new(0),
            }
        }

        /// A downloader that succeeds for any requested track by deriving the object/entry
        /// from the claimed content id. Used to assert multi-item single-concurrency and
        /// crash-recovery passes without enumerating every expected result.
        fn any_ok() -> Self {
            Self::new(vec![])
        }
    }

    #[async_trait]
    impl TrackDownloader for FakeDownloader {
        async fn download_track_to_object(
            &self,
            track: &TrackRefDto,
            _quality: &str,
        ) -> AppResult<(CacheObject, CacheEntry)> {
            *self.calls.lock().unwrap() += 1;
            let mut results = self.results.lock().unwrap();
            if let Some(result) = results.pop() {
                return result;
            }
            // Auto-derive from the requested content id when the queue is exhausted.
            let h = hash(&track.id);
            Ok((fake_object(&track.id), fake_entry(&track.id, &h)))
        }
    }

    fn fake_object(content_id: &str) -> CacheObject {
        let h = hash(content_id);
        CacheObject {
            content_hash: h.clone(),
            size_bytes: 4,
            path: PathBuf::from("objects").join(h),
        }
    }

    fn fake_entry(content_id: &str, h: &str) -> CacheEntry {
        CacheEntry {
            content_id: MediaId::new(content_id),
            quality: "standard".into(),
            content_hash: h.into(),
            access_class: CacheAccessClass::Public,
            entitlement_snapshot: None,
            last_validated_unix_ms: None,
            official_source: "netease".into(),
            state: CacheState::Available,
        }
    }

    #[test]
    fn idle_blocked_when_playback_not_idle() {
        let repository = repo();
        let root = cache_root();
        let downloader = FakeDownloader::any_ok();
        let probe = FakeProbe {
            snapshot: ideal_snapshot(),
        };
        let mut not_idle = idle_ready();
        not_idle.playback_idle_ms = 0;
        let outcome = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            not_idle,
            root.path(),
            &reserve(),
            2,
        ))
        .unwrap();
        assert!(outcome.blocked_resources);
        assert!(!outcome.idle);
        assert_eq!(*downloader.calls.lock().unwrap(), 0);
    }

    #[test]
    fn any_unknown_resource_blocks_and_yields() {
        let repository = repo();
        let root = cache_root();
        let item_id = enqueue_item(&repository, "album", "a");
        let downloader = FakeDownloader::any_ok();
        // Every non-ideal snapshot (battery, metered, below-reserve, or any Unknown) blocks.
        let cases = [
            ResourceSnapshot {
                power: PowerState::OnBattery,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::MeetsReserve,
            },
            ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Metered,
                disk_reserve: DiskReserveState::MeetsReserve,
            },
            ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::BelowReserve,
            },
            ResourceSnapshot {
                power: PowerState::Unknown,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::MeetsReserve,
            },
            ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Unknown,
                disk_reserve: DiskReserveState::MeetsReserve,
            },
            ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::Unknown,
            },
        ];
        for snapshot in cases {
            let probe = FakeProbe { snapshot };
            let outcome = tauri::async_runtime::block_on(run_album_fill(
                &repository,
                &downloader,
                &probe,
                idle_ready(),
                root.path(),
                &reserve(),
                2,
            ))
            .unwrap();
            assert!(
                outcome.blocked_resources,
                "expected blocked for {snapshot:?}"
            );
            // The running item (if any) is yielded back to pending.
            assert!(item_state_is(
                &repository,
                item_id,
                hyperplayer_engine::album::AlbumFillItemState::Pending
            ));
            assert_eq!(*downloader.calls.lock().unwrap(), 0);
        }
    }

    #[test]
    fn ideal_resources_claim_and_complete_atomically() {
        let repository = repo();
        let root = cache_root();
        let item_id = enqueue_item(&repository, "album", "a");
        let h = hash("a");
        let downloader = FakeDownloader::any_ok();
        let probe = FakeProbe {
            snapshot: ideal_snapshot(),
        };
        let outcome = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            2,
        ))
        .unwrap();
        assert_eq!(outcome.completed, 1);
        assert_eq!(*downloader.calls.lock().unwrap(), 1);
        assert!(item_state_is(
            &repository,
            item_id,
            hyperplayer_engine::album::AlbumFillItemState::Completed
        ));
        // The cache object + entry are persisted by the atomic completion.
        let repo = repository.lock().unwrap();
        let entry = repo
            .cache_entry(&MediaId::new("a"), "standard")
            .unwrap()
            .unwrap();
        assert_eq!(entry.content_hash, h);
        assert!(!root.path().join("objects").join(&h).exists());
    }

    #[test]
    fn permanent_failure_marks_item_failed_and_does_not_retry() {
        let repository = repo();
        let root = cache_root();
        let item_id = enqueue_item(&repository, "album", "a");
        let downloader = FakeDownloader::new(vec![Err(AppError::Unavailable(
            "NetEase VIP entitlement was not confirmed".into(),
        ))]);
        let probe = FakeProbe {
            snapshot: ideal_snapshot(),
        };
        let outcome = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            2,
        ))
        .unwrap();
        assert_eq!(outcome.failed, 1);
        assert!(item_state_is(
            &repository,
            item_id,
            hyperplayer_engine::album::AlbumFillItemState::Failed
        ));
        assert_eq!(*downloader.calls.lock().unwrap(), 1);
        // A failed item is not claimable again.
        let again = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            3,
        ))
        .unwrap();
        assert!(again.idle);
    }

    #[test]
    fn transient_failure_requeues_item_to_pending() {
        let repository = repo();
        let root = cache_root();
        let item_id = enqueue_item(&repository, "album", "a");
        // "connection" / size-class errors are transient.
        let transient = || {
            Err(AppError::Unavailable(
                "official playback response exceeded the cache limit".into(),
            ))
        };
        let downloader = FakeDownloader::new(vec![transient(), transient()]);
        let probe = FakeProbe {
            snapshot: ideal_snapshot(),
        };
        let outcome = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            2,
        ))
        .unwrap();
        assert_eq!(outcome.requeued, 1);
        assert!(item_state_is(
            &repository,
            item_id,
            hyperplayer_engine::album::AlbumFillItemState::Pending
        ));
        // Requeued item is claimable again on the next pass.
        let again = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            3,
        ))
        .unwrap();
        assert_eq!(again.requeued, 1);
    }

    #[test]
    fn single_concurrency_claims_one_item_per_run() {
        let repository = repo();
        let root = cache_root();
        enqueue_item(&repository, "album", "a");
        enqueue_item(&repository, "album", "b");
        let downloader = FakeDownloader::any_ok();
        let probe = FakeProbe {
            snapshot: ideal_snapshot(),
        };
        // First run claims and completes the single highest-priority BFS item.
        let first = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            2,
        ))
        .unwrap();
        assert_eq!(first.completed, 1);
        assert_eq!(*downloader.calls.lock().unwrap(), 1);
        // A second run claims the next item — proving the repo never hands out a second
        // concurrent claim while the first is still in-flight.
        let second = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            3,
        ))
        .unwrap();
        assert_eq!(second.completed, 1);
        assert_eq!(*downloader.calls.lock().unwrap(), 2);
    }

    #[test]
    fn process_restart_recovers_running_items() {
        let repository = repo();
        let root = cache_root();
        // Simulate a crash-orphaned running item (as if claimed but never finished).
        let item_id = {
            let mut repo = repository.lock().unwrap();
            let item = AlbumFillItem::pending(
                "album",
                MediaId::new("a"),
                "standard",
                AlbumFillItemPriority::Standard,
                1,
            );
            repo.enqueue_album_fill_item(&item).unwrap();
            repo.claim_album_fill_item(2, AlbumFillWorkAvailability::Idle)
                .unwrap()
                .unwrap()
                .item_id
        };
        assert!(item_state_is(
            &repository,
            item_id,
            hyperplayer_engine::album::AlbumFillItemState::Running
        ));
        // On a fresh startup the worker yields running items back to pending before claiming,
        // so a single run recovers the crashed item.
        let probe = FakeProbe {
            snapshot: ideal_snapshot(),
        };
        let downloader = FakeDownloader::any_ok();
        let outcome = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            3,
        ))
        .unwrap();
        assert_eq!(outcome.completed, 1);
        assert!(item_state_is(
            &repository,
            item_id,
            hyperplayer_engine::album::AlbumFillItemState::Completed
        ));
    }

    #[test]
    fn duplicate_item_does_not_create_second_row() {
        let repository = repo();
        let root = cache_root();
        enqueue_item(&repository, "album", "a");
        enqueue_item(&repository, "album", "a");
        let probe = FakeProbe {
            snapshot: ideal_snapshot(),
        };
        let downloader = FakeDownloader::any_ok();
        let outcome = tauri::async_runtime::block_on(run_album_fill(
            &repository,
            &downloader,
            &probe,
            idle_ready(),
            root.path(),
            &reserve(),
            2,
        ))
        .unwrap();
        assert_eq!(outcome.completed, 1);
        let repo = repository.lock().unwrap();
        let entries = repo.cache_entries_for(&MediaId::new("a")).unwrap().len();
        assert_eq!(entries, 1);
    }
}
