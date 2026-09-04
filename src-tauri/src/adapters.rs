use crate::{
    dto::{
        CloseBehaviorDto, DSP_CONFIG_VERSION, EntityPageDto, LibraryAlbumDto, LibraryArtistDto,
        LibraryArtworkDto, LibraryEntityTracksRequestDto, LibraryFolderDto, LibraryLocationDto,
        LibraryMutationResultDto, LibraryOverviewDto, LibraryPageDto, LibraryPlaylistDto,
        LibraryQueryDto, LibraryRecentDto, LibraryScanRequestDto, PageRequestDto,
        PersistedDspConfig, ScanProgressDto, SettingsDto, TaskAcceptedDto, ThemeDto, TrackDto,
        TrackRefDto, TrackSourceDto, UpdateSettingsRequestDto,
    },
    error::{AppError, AppResult},
    ports::{validate_id, validate_page, LibraryPort, ScanProgressSink, SettingsPort},
};
use hyperplayer_engine::{
    library::{
        read_embedded_artwork, ContentAddressedArtwork, LibraryScanner, LoftyMetadataReader,
        MetadataReader, PLAYABLE_LOCAL_EXTENSIONS, ScanCancellation, ScanFailure,
    },
    model::{MediaId, MediaSource, Track},
    repository::{LibraryTrack, SqliteRepository},
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

type Repository = Arc<Mutex<SqliteRepository>>;

trait AppMutex<T> {
    fn app_lock(&self) -> AppResult<MutexGuard<'_, T>>;
}

impl<T> AppMutex<T> for Mutex<T> {
    fn app_lock(&self) -> AppResult<MutexGuard<'_, T>> {
        self.lock().map_err(|_| AppError::StateUnavailable)
    }
}

const MAX_CONCURRENT_SCANS: usize = 2;
const MAX_SCANS_PER_ROOT: usize = 1;

// 缓存治理默认值与 D25 保守默认一致（容量 10 GiB、90% 清理线、最近 100 曲保护、
// 整专补齐 standard/单并发）。读取旧 settings.json 缺失字段时由
// default_cache_policy_fields 回填，避免陈旧配置偏离已验证默认。
const DEFAULT_CACHE_CAPACITY_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_TRIM_PERCENT: u8 = 90;
const DEFAULT_CACHE_RECENT_TRACK_LIMIT: usize = 100;
const DEFAULT_ALBUM_FILL_ENABLED: bool = true;
const DEFAULT_ALBUM_FILL_QUALITY: &str = "standard";

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

    fn registered_roots(&self) -> AppResult<Vec<std::path::PathBuf>> {
        self.locations.all()
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

// 缓存治理默认值回填（D25 保守默认：10 GiB、90% 清理线、最近 100 曲保护、
// 整专补齐 standard/单并发）。读取旧 settings.json 缺失字段时由此回填，
// 避免陈旧配置偏离已验证默认。
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
fn migrate_persisted_dsp(raw: Option<PersistedDspConfig>) -> AppResult<Option<PersistedDspConfig>> {
    let Some(config) = raw else {
        return Ok(None);
    };
    if config.version != DSP_CONFIG_VERSION {
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
        // DSP 配置哑 KV（D35 Q16）：Rust 不解析内容，schema 归 TS；
        // Some(None) 清除，Some(Some(config)) 写入。
        if let Some(value) = request.dsp {
            settings.dsp = value;
        }
        validate_cache_policy(&settings)?;
        self.persist(&settings)?;
        *guard = settings.clone();
        Ok(settings)
    }
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

fn stable_hash(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn track_dto(track: &Track) -> TrackDto {
    let source = match track.source {
        MediaSource::Local { .. } => TrackSourceDto::Local,
        MediaSource::Netease { .. } => TrackSourceDto::Netease,
    };
    TrackDto {
        track_ref: TrackRefDto {
            id: track.id.0.clone(),
            source,
        },
        title: track.title.clone(),
        artists: track.artists.clone(),
        album: track.album.clone(),
        album_id: track.album_id.clone(),
        artist_ids: track.artist_ids.clone(),
        artwork_hash: track.artwork_hash.clone(),
        duration_ms: track.duration_ms,
        quality_label: None,
        playable: true,
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

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
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
            PLAYABLE_LOCAL_EXTENSIONS
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
