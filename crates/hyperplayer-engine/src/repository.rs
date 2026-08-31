use crate::album::{
    AlbumFillTask, AlbumPromotion, AlbumSession, AlbumTaskState, PrefetchPriority,
    FREQUENT_ALBUM_THRESHOLD,
};
use crate::cache::{
    CacheAccessClass, CacheEntry, CacheLease, CacheObject, CacheState, EntitlementSnapshot,
};
use crate::error::{EngineError, Result};
use crate::model::{
    AlbumSummary, ArtistSummary, FolderSummary, MediaId, MediaSource, PlaylistSummary, Track,
};
use crate::queue::{PlaybackQueue, QueueContextSnapshot};
use rusqlite::types::Type;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::{Path, PathBuf};

const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        "CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY NOT NULL,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            artists TEXT NOT NULL,
            album TEXT,
            album_id TEXT,
            duration_ms INTEGER,
            file_size INTEGER NOT NULL,
            modified_unix_ms INTEGER NOT NULL,
            sample_rate INTEGER,
            channels INTEGER,
            bitrate_kbps INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
        CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);",
    ),
    (
        2,
        "CREATE TABLE IF NOT EXISTS album_sessions (
            album_id TEXT NOT NULL,
            local_day TEXT NOT NULL,
            PRIMARY KEY(album_id, local_day)
        );
        CREATE TABLE IF NOT EXISTS album_stats (
            album_id TEXT PRIMARY KEY NOT NULL,
            qualified_sessions INTEGER NOT NULL DEFAULT 0,
            is_frequent INTEGER NOT NULL DEFAULT 0
        );",
    ),
    (
        3,
        "CREATE TABLE IF NOT EXISTS cache_entries (
            content_id TEXT NOT NULL,
            quality TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            access_class TEXT NOT NULL CHECK(access_class IN ('public', 'account_entitled')),
            owner_user_id INTEGER,
            entitlement_product TEXT,
            entitlement_valid_until_unix_ms INTEGER,
            entitlement_server_revision TEXT,
            last_validated_unix_ms INTEGER,
            official_source TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('available', 'locked_entitlement', 'partial')),
            PRIMARY KEY(content_id, quality),
            CHECK(
                (access_class = 'public' AND owner_user_id IS NULL) OR
                (access_class = 'account_entitled' AND owner_user_id IS NOT NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_cache_content_hash ON cache_entries(content_hash);",
    ),
    (
        4,
        "CREATE TABLE IF NOT EXISTS library_roots (
            path TEXT PRIMARY KEY NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS playback_session (
            singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
            queue_json TEXT NOT NULL,
            position_ms INTEGER NOT NULL,
            updated_unix_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS playback_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id TEXT NOT NULL,
            played_unix_ms INTEGER NOT NULL,
            position_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_playback_history_played
            ON playback_history(played_unix_ms DESC);",
    ),
    (
        5,
        "CREATE TABLE IF NOT EXISTS cache_objects (
            content_hash TEXT PRIMARY KEY NOT NULL,
            size_bytes INTEGER NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            completed_unix_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cache_leases (
            content_hash TEXT NOT NULL,
            lease_key TEXT NOT NULL,
            created_unix_ms INTEGER NOT NULL,
            PRIMARY KEY(content_hash, lease_key),
            FOREIGN KEY(content_hash) REFERENCES cache_objects(content_hash) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS album_fill_tasks (
            album_id TEXT PRIMARY KEY NOT NULL,
            state TEXT NOT NULL,
            priority TEXT NOT NULL,
            completed_items INTEGER NOT NULL,
            total_items INTEGER NOT NULL,
            updated_unix_ms INTEGER NOT NULL,
             failure TEXT
        );",
    ),
    (
        6,
        "ALTER TABLE tracks ADD COLUMN artist_ids TEXT NOT NULL DEFAULT '';
         ALTER TABLE tracks ADD COLUMN artwork_hash TEXT;
         ALTER TABLE tracks ADD COLUMN artwork_mime TEXT;
         ALTER TABLE tracks ADD COLUMN folder_id TEXT;
         ALTER TABLE tracks ADD COLUMN folder_name TEXT;
         ALTER TABLE tracks ADD COLUMN folder_path TEXT;
         CREATE TABLE IF NOT EXISTS track_artists (
             media_id TEXT NOT NULL,
             artist_id TEXT NOT NULL,
             artist_name TEXT NOT NULL,
             position INTEGER NOT NULL,
             PRIMARY KEY(media_id, artist_id),
             FOREIGN KEY(media_id) REFERENCES tracks(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS playlists (
             id TEXT PRIMARY KEY NOT NULL,
             name TEXT NOT NULL,
             created_unix_ms INTEGER NOT NULL,
             updated_unix_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS playlist_tracks (
             playlist_id TEXT NOT NULL,
             media_id TEXT NOT NULL,
             position INTEGER NOT NULL,
             PRIMARY KEY(playlist_id, media_id),
             UNIQUE(playlist_id, position),
             FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
             FOREIGN KEY(media_id) REFERENCES tracks(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
         CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists(artist_id, media_id);
         CREATE INDEX IF NOT EXISTS idx_playlist_tracks_order ON playlist_tracks(playlist_id, position);",
    ),
];

const LATEST_SCHEMA_VERSION: i64 = 6;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryTrack {
    pub track: Track,
    pub path: PathBuf,
    pub file_size: u64,
    pub modified_unix_ms: u64,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub bitrate_kbps: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackSessionRecord {
    pub queue: PlaybackQueue,
    pub position_ms: u64,
    pub updated_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackHistoryRecord {
    pub media_id: MediaId,
    pub played_unix_ms: u64,
    pub position_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentTrack {
    pub track: LibraryTrack,
    pub played_unix_ms: u64,
    pub position_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LibraryCounts {
    pub tracks: u64,
    pub albums: u64,
    pub artists: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CacheRepositoryStats {
    pub entry_count: u64,
    pub bytes_used: u64,
    pub locked_entries: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntitlementCacheScope {
    Owner(u64),
    AllAccounts,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CacheEntitlementLockResult {
    pub locked_entries: usize,
    pub revoked_leases: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemovedCacheObject {
    pub content_hash: String,
    pub relative_path: PathBuf,
}

pub trait ScanRepository {
    fn upsert_scanned_track(&self, track: &LibraryTrack) -> Result<()>;
    fn finish_scan(&mut self, root: &Path, found: &[PathBuf]) -> Result<usize>;
}

pub struct SqliteRepository {
    connection: Connection,
}

impl SqliteRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let mut repository = Self { connection };
        repository.migrate()?;
        Ok(repository)
    }

    pub fn in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let mut repository = Self { connection };
        repository.migrate()?;
        Ok(repository)
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    pub fn register_library_root(&self, root: &Path) -> Result<PathBuf> {
        let canonical = root.canonicalize()?;
        if !canonical.is_dir() {
            return Err(EngineError::InvalidInput(
                "library root must be an existing directory".into(),
            ));
        }
        self.connection.execute(
            "INSERT INTO library_roots(path, enabled) VALUES (?1, 1)
             ON CONFLICT(path) DO UPDATE SET enabled = 1",
            [canonical.to_string_lossy().as_ref()],
        )?;
        Ok(canonical)
    }

    pub fn unregister_library_root(&self, root: &Path) -> Result<bool> {
        let normalized = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        Ok(self.connection.execute(
            "DELETE FROM library_roots WHERE path = ?1",
            [normalized.to_string_lossy().as_ref()],
        )? == 1)
    }

    pub fn library_roots(&self) -> Result<Vec<PathBuf>> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM library_roots WHERE enabled = 1 ORDER BY path")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0).map(PathBuf::from))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn media_path(&self, id: &MediaId) -> Result<Option<PathBuf>> {
        Ok(self.media_path_with_root(id)?.map(|(path, _)| path))
    }

    pub fn media_path_with_root(&self, id: &MediaId) -> Result<Option<(PathBuf, PathBuf)>> {
        let Some(track) = self.track_by_id(id)? else {
            return Ok(None);
        };
        let candidate = track.path.canonicalize()?;
        let roots = self.library_roots()?;
        roots
            .into_iter()
            .find(|root| candidate.starts_with(root))
            .map(|root| (candidate, root))
            .map(Some)
            .ok_or_else(|| {
                EngineError::InvalidInput("media path is outside registered library roots".into())
            })
    }

    pub fn save_playback_session(
        &self,
        queue: &PlaybackQueue,
        position_ms: u64,
        updated_unix_ms: u64,
    ) -> Result<()> {
        let queue_json = serde_json::to_string(&queue.context_snapshot())
            .map_err(|error| EngineError::InvalidInput(error.to_string()))?;
        self.connection.execute(
            "INSERT INTO playback_session(singleton, queue_json, position_ms, updated_unix_ms)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(singleton) DO UPDATE SET queue_json=excluded.queue_json,
                position_ms=excluded.position_ms, updated_unix_ms=excluded.updated_unix_ms",
            params![
                queue_json,
                sqlite_integer(position_ms, "position_ms")?,
                sqlite_integer(updated_unix_ms, "updated_unix_ms")?
            ],
        )?;
        Ok(())
    }

    pub fn load_playback_session(&self) -> Result<Option<PlaybackSessionRecord>> {
        self.connection
            .query_row(
                "SELECT queue_json, position_ms, updated_unix_ms FROM playback_session WHERE singleton = 1",
                [],
                |row| {
                    let json: String = row.get(0)?;
                    let snapshot: QueueContextSnapshot = serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error))
                    })?;
                    let queue = PlaybackQueue::restore(snapshot)
                        .ok_or_else(|| invalid_column(0, "invalid persisted queue snapshot"))?;
                    Ok(PlaybackSessionRecord {
                        queue,
                        position_ms: u64_column(row, 1)?,
                        updated_unix_ms: u64_column(row, 2)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn append_playback_history(&self, record: &PlaybackHistoryRecord) -> Result<()> {
        self.start_playback_history(record).map(|_| ())
    }

    pub fn start_playback_history(&self, record: &PlaybackHistoryRecord) -> Result<u64> {
        self.connection.execute(
            "INSERT INTO playback_history(media_id, played_unix_ms, position_ms) VALUES (?1, ?2, ?3)",
            params![
                record.media_id.0,
                sqlite_integer(record.played_unix_ms, "played_unix_ms")?,
                sqlite_integer(record.position_ms, "position_ms")?
            ],
        )?;
        u64::try_from(self.connection.last_insert_rowid())
            .map_err(|_| EngineError::InvalidInput("playback history id is invalid".into()))
    }

    pub fn update_playback_history_position(
        &self,
        history_id: u64,
        position_ms: u64,
    ) -> Result<()> {
        let changed = self.connection.execute(
            "UPDATE playback_history SET position_ms = ?2 WHERE id = ?1",
            params![
                sqlite_integer(history_id, "playback history id")?,
                sqlite_integer(position_ms, "position_ms")?
            ],
        )?;
        if changed == 0 {
            return Err(EngineError::InvalidInput(
                "playback history entry does not exist".into(),
            ));
        }
        Ok(())
    }

    pub fn playback_history(&self, limit: u32) -> Result<Vec<PlaybackHistoryRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT media_id, played_unix_ms, position_ms FROM playback_history
             ORDER BY played_unix_ms DESC, id DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], |row| {
            Ok(PlaybackHistoryRecord {
                media_id: MediaId(row.get(0)?),
                played_unix_ms: u64_column(row, 1)?,
                position_ms: u64_column(row, 2)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn upsert_track(&self, value: &LibraryTrack) -> Result<()> {
        let artists = value.track.artists.join("\u{1f}");
        let artist_ids = value.track.artist_ids.join("\u{1f}");
        let duration_ms = optional_sqlite_integer(value.track.duration_ms, "duration_ms")?;
        let folder = value
            .path
            .parent()
            .map(|path| path.to_string_lossy().into_owned());
        let folder_name = value
            .path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned();
        let folder_id = folder
            .as_deref()
            .map(|path| crate::library::stable_entity_id("folder", &[path]));
        let file_size = sqlite_integer(value.file_size, "file_size")?;
        let modified_unix_ms = sqlite_integer(value.modified_unix_ms, "modified_unix_ms")?;
        self.connection.execute(
            "INSERT INTO tracks (
                id, path, title, artists, album, album_id, duration_ms, file_size,
                modified_unix_ms, sample_rate, channels, bitrate_kbps, artist_ids,
                artwork_hash, artwork_mime, folder_id, folder_name, folder_path
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(path) DO UPDATE SET
                id=excluded.id, title=excluded.title, artists=excluded.artists,
                album=excluded.album, album_id=excluded.album_id,
                duration_ms=excluded.duration_ms, file_size=excluded.file_size,
                modified_unix_ms=excluded.modified_unix_ms,
                sample_rate=excluded.sample_rate, channels=excluded.channels,
                bitrate_kbps=excluded.bitrate_kbps, artist_ids=excluded.artist_ids,
                artwork_hash=excluded.artwork_hash, artwork_mime=excluded.artwork_mime,
                folder_id=excluded.folder_id, folder_name=excluded.folder_name,
                folder_path=excluded.folder_path",
            params![
                value.track.id.0,
                value.path.to_string_lossy(),
                value.track.title,
                artists,
                value.track.album,
                value.track.album_id,
                duration_ms,
                file_size,
                modified_unix_ms,
                value.sample_rate,
                value.channels,
                value.bitrate_kbps,
                artist_ids,
                value.track.artwork_hash,
                value.track.artwork_mime,
                folder_id,
                folder_name,
                folder,
            ],
        )?;
        self.connection.execute(
            "DELETE FROM track_artists WHERE media_id = ?1",
            params![value.track.id.0],
        )?;
        for (position, (artist_id, artist_name)) in value
            .track
            .artist_ids
            .iter()
            .zip(&value.track.artists)
            .enumerate()
        {
            self.connection.execute(
                "INSERT INTO track_artists(media_id, artist_id, artist_name, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    value.track.id.0,
                    artist_id,
                    artist_name,
                    i64::try_from(position).map_err(|_| EngineError::InvalidInput(
                        "artist position exceeds SQLite INTEGER".into()
                    ))?
                ],
            )?;
        }
        Ok(())
    }

    pub fn track_by_id(&self, id: &MediaId) -> Result<Option<LibraryTrack>> {
        self.connection
            .query_row(
                "SELECT id, path, title, artists, album, album_id, duration_ms,
                        file_size, modified_unix_ms, sample_rate, channels, bitrate_kbps,
                        artist_ids, artwork_hash, artwork_mime
                 FROM tracks WHERE id = ?1",
                params![id.0],
                map_track,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_tracks(&self, limit: u32, offset: u32) -> Result<Vec<LibraryTrack>> {
        let mut statement = self.connection.prepare(
            "SELECT id, path, title, artists, album, album_id, duration_ms,
                    file_size, modified_unix_ms, sample_rate, channels, bitrate_kbps,
                    artist_ids, artwork_hash, artwork_mime
             FROM tracks ORDER BY title COLLATE NOCASE, id LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit, offset], map_track)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn library_counts(&self) -> Result<LibraryCounts> {
        self.connection
            .query_row(
                "SELECT COUNT(*),
                        COUNT(DISTINCT CASE WHEN album_id IS NOT NULL THEN album_id END),
                        (SELECT COUNT(DISTINCT artist_id) FROM track_artists)
                 FROM tracks",
                [],
                |row| {
                    Ok(LibraryCounts {
                        tracks: u64_column(row, 0)?,
                        albums: u64_column(row, 1)?,
                        artists: u64_column(row, 2)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn query_tracks(
        &self,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Page<LibraryTrack>> {
        let search = search.map(|value| format!("%{}%", escape_like(value)));
        let filter = "(?1 IS NULL OR title LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                      OR artists LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                      OR album LIKE ?1 ESCAPE '\\' COLLATE NOCASE)";
        let total = self.connection.query_row(
            &format!("SELECT COUNT(*) FROM tracks WHERE {filter}"),
            params![search],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT id, path, title, artists, album, album_id, duration_ms,
                    file_size, modified_unix_ms, sample_rate, channels, bitrate_kbps,
                    artist_ids, artwork_hash, artwork_mime
             FROM tracks WHERE {filter}
             ORDER BY title COLLATE NOCASE, id LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = statement.query_map(params![search, limit, offset], map_track)?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn query_albums(
        &self,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Page<AlbumSummary>> {
        let search = search.map(|value| format!("%{}%", escape_like(value)));
        let filter = "album_id IS NOT NULL AND album IS NOT NULL
                      AND (?1 IS NULL OR album LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                           OR artists LIKE ?1 ESCAPE '\\' COLLATE NOCASE)";
        let total = self.connection.query_row(
            &format!("SELECT COUNT(DISTINCT album_id) FROM tracks WHERE {filter}"),
            params![search],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT album_id, MIN(album), MIN(artists), COUNT(*), MAX(artwork_hash)
             FROM tracks WHERE {filter} GROUP BY album_id
             ORDER BY MIN(album) COLLATE NOCASE, album_id LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = statement.query_map(params![search, limit, offset], |row| {
            let artists: String = row.get(2)?;
            Ok(AlbumSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                artists: split_stored(&artists),
                track_count: u64_column(row, 3)?,
                artwork_hash: row.get(4)?,
            })
        })?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn query_artists(
        &self,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Page<ArtistSummary>> {
        let search = search.map(|value| format!("%{}%", escape_like(value)));
        let filter = "(?1 IS NULL OR ta.artist_name LIKE ?1 ESCAPE '\\' COLLATE NOCASE)";
        let total = self.connection.query_row(
            &format!("SELECT COUNT(DISTINCT ta.artist_id) FROM track_artists ta WHERE {filter}"),
            params![search],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT ta.artist_id, MIN(ta.artist_name), COUNT(DISTINCT ta.media_id),
                    COUNT(DISTINCT t.album_id), MAX(t.artwork_hash)
             FROM track_artists ta JOIN tracks t ON t.id = ta.media_id
             WHERE {filter} GROUP BY ta.artist_id
             ORDER BY MIN(ta.artist_name) COLLATE NOCASE, ta.artist_id LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = statement.query_map(params![search, limit, offset], |row| {
            Ok(ArtistSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: u64_column(row, 2)?,
                album_count: u64_column(row, 3)?,
                artwork_hash: row.get(4)?,
            })
        })?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn query_folders(
        &self,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Page<FolderSummary>> {
        let search = search.map(|value| format!("%{}%", escape_like(value)));
        let filter = "folder_id IS NOT NULL
                      AND (?1 IS NULL OR folder_name LIKE ?1 ESCAPE '\\' COLLATE NOCASE)";
        let total = self.connection.query_row(
            &format!("SELECT COUNT(DISTINCT folder_id) FROM tracks WHERE {filter}"),
            params![search],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT folder_id, MIN(folder_name), MIN(folder_path), COUNT(*) FROM tracks WHERE {filter}
             GROUP BY folder_id ORDER BY MIN(folder_name) COLLATE NOCASE, folder_id
             LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = statement.query_map(params![search, limit, offset], |row| {
            Ok(FolderSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                path: PathBuf::from(row.get::<_, String>(2)?),
                track_count: u64_column(row, 3)?,
            })
        })?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn query_recent(&self, limit: u32, offset: u32) -> Result<Page<RecentTrack>> {
        let total = self.connection.query_row(
            "SELECT COUNT(DISTINCT h.media_id) FROM playback_history h
             JOIN tracks t ON t.id = h.media_id",
            [],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.path, t.title, t.artists, t.album, t.album_id, t.duration_ms,
                    t.file_size, t.modified_unix_ms, t.sample_rate, t.channels, t.bitrate_kbps,
                    t.artist_ids, t.artwork_hash, t.artwork_mime,
                    h.played_unix_ms, h.position_ms
             FROM playback_history h JOIN tracks t ON t.id = h.media_id
             WHERE h.id = (SELECT h2.id FROM playback_history h2
                           WHERE h2.media_id = h.media_id
                           ORDER BY h2.played_unix_ms DESC, h2.id DESC LIMIT 1)
             ORDER BY h.played_unix_ms DESC, h.id DESC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit, offset], |row| {
            Ok(RecentTrack {
                track: map_track(row)?,
                played_unix_ms: u64_column(row, 15)?,
                position_ms: u64_column(row, 16)?,
            })
        })?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn create_playlist(&self, id: &str, name: &str, now: u64) -> Result<()> {
        let name = validate_playlist_name(id, name)?;
        let now = sqlite_integer(now, "playlist timestamp")?;
        self.connection.execute(
            "INSERT INTO playlists(id, name, created_unix_ms, updated_unix_ms)
             VALUES (?1, ?2, ?3, ?3)",
            params![id, name, now],
        )?;
        Ok(())
    }

    pub fn add_playlist_track(
        &mut self,
        playlist_id: &str,
        media_id: &MediaId,
        now: u64,
    ) -> Result<()> {
        let now = sqlite_integer(now, "playlist timestamp")?;
        let transaction = self.connection.transaction()?;
        let inserted = transaction.execute(
            "INSERT INTO playlist_tracks(playlist_id, media_id, position)
             VALUES (?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM playlist_tracks WHERE playlist_id = ?1), 0))
             ON CONFLICT(playlist_id, media_id) DO NOTHING",
            params![playlist_id, media_id.0],
        )?;
        if inserted == 1 {
            transaction.execute(
                "UPDATE playlists SET updated_unix_ms = ?2 WHERE id = ?1",
                params![playlist_id, now],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn rename_playlist(&self, playlist_id: &str, name: &str, now: u64) -> Result<()> {
        let name = validate_playlist_name(playlist_id, name)?;
        let changed = self.connection.execute(
            "UPDATE playlists SET name = ?2, updated_unix_ms = ?3 WHERE id = ?1",
            params![
                playlist_id,
                name,
                sqlite_integer(now, "playlist timestamp")?
            ],
        )?;
        if changed == 0 {
            return Err(EngineError::InvalidInput("playlist does not exist".into()));
        }
        Ok(())
    }

    pub fn delete_playlist(&mut self, playlist_id: &str) -> Result<()> {
        if playlist_id.trim().is_empty() {
            return Err(EngineError::InvalidInput("playlist id is required".into()));
        }
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute("DELETE FROM playlists WHERE id = ?1", [playlist_id])?;
        if changed == 0 {
            return Err(EngineError::InvalidInput("playlist does not exist".into()));
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_playlist_track(
        &mut self,
        playlist_id: &str,
        media_id: &MediaId,
        now: u64,
    ) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let position: Option<u32> = transaction
            .query_row(
                "SELECT position FROM playlist_tracks WHERE playlist_id = ?1 AND media_id = ?2",
                params![playlist_id, media_id.0],
                |row| row.get(0),
            )
            .optional()?;
        let Some(position) = position else {
            return Err(EngineError::InvalidInput(
                "playlist track does not exist".into(),
            ));
        };
        transaction.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND media_id = ?2",
            params![playlist_id, media_id.0],
        )?;
        transaction.execute(
            "UPDATE playlist_tracks SET position = -position - 2 WHERE playlist_id = ?1 AND position > ?2",
            params![playlist_id, position],
        )?;
        transaction.execute(
            "UPDATE playlist_tracks SET position = -position - 3 WHERE playlist_id = ?1 AND position <= -2",
            [playlist_id],
        )?;
        transaction.execute(
            "UPDATE playlists SET updated_unix_ms = ?2 WHERE id = ?1",
            params![playlist_id, sqlite_integer(now, "playlist timestamp")?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reorder_playlist_track(
        &mut self,
        playlist_id: &str,
        media_id: &MediaId,
        target_position: u32,
        now: u64,
    ) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let current: Option<u32> = transaction
            .query_row(
                "SELECT position FROM playlist_tracks WHERE playlist_id = ?1 AND media_id = ?2",
                params![playlist_id, media_id.0],
                |row| row.get(0),
            )
            .optional()?;
        let Some(current) = current else {
            return Err(EngineError::InvalidInput(
                "playlist track does not exist".into(),
            ));
        };
        let count: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?1",
            [playlist_id],
            |row| row.get(0),
        )?;
        if target_position >= count {
            return Err(EngineError::InvalidInput(
                "playlist target position is out of bounds".into(),
            ));
        }
        if current != target_position {
            transaction.execute(
                "UPDATE playlist_tracks SET position = -1 WHERE playlist_id = ?1 AND media_id = ?2",
                params![playlist_id, media_id.0],
            )?;
            if target_position < current {
                transaction.execute(
                    "UPDATE playlist_tracks SET position = -position - 2 WHERE playlist_id = ?1 AND position >= ?2 AND position < ?3",
                    params![playlist_id, target_position, current],
                )?;
                transaction.execute(
                    "UPDATE playlist_tracks SET position = -position - 1 WHERE playlist_id = ?1 AND position <= -2",
                    [playlist_id],
                )?;
            } else {
                transaction.execute(
                    "UPDATE playlist_tracks SET position = -position - 2 WHERE playlist_id = ?1 AND position > ?2 AND position <= ?3",
                    params![playlist_id, current, target_position],
                )?;
                transaction.execute(
                    "UPDATE playlist_tracks SET position = -position - 3 WHERE playlist_id = ?1 AND position <= -2",
                    [playlist_id],
                )?;
            }
            transaction.execute(
                "UPDATE playlist_tracks SET position = ?3 WHERE playlist_id = ?1 AND media_id = ?2",
                params![playlist_id, media_id.0, target_position],
            )?;
        }
        transaction.execute(
            "UPDATE playlists SET updated_unix_ms = ?2 WHERE id = ?1",
            params![playlist_id, sqlite_integer(now, "playlist timestamp")?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn playlist_by_id(&self, playlist_id: &str) -> Result<Option<PlaylistSummary>> {
        self.connection
            .query_row(
                "SELECT p.id, p.name, COUNT(pt.media_id), p.updated_unix_ms
                 FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
                 WHERE p.id = ?1 GROUP BY p.id",
                [playlist_id],
                |row| {
                    Ok(PlaylistSummary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        track_count: u64_column(row, 2)?,
                        updated_unix_ms: u64_column(row, 3)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn query_playlists(
        &self,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Page<PlaylistSummary>> {
        let search = search.map(|value| format!("%{}%", escape_like(value)));
        let filter = "(?1 IS NULL OR p.name LIKE ?1 ESCAPE '\\' COLLATE NOCASE)";
        let total = self.connection.query_row(
            &format!("SELECT COUNT(*) FROM playlists p WHERE {filter}"),
            params![search],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT p.id, p.name, COUNT(pt.media_id), p.updated_unix_ms
             FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             WHERE {filter} GROUP BY p.id
             ORDER BY p.updated_unix_ms DESC, p.id LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = statement.query_map(params![search, limit, offset], |row| {
            Ok(PlaylistSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: u64_column(row, 2)?,
                updated_unix_ms: u64_column(row, 3)?,
            })
        })?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn album_tracks(
        &self,
        album_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Page<LibraryTrack>> {
        self.entity_tracks("t.album_id = ?1", album_id, limit, offset)
    }

    pub fn artist_tracks(
        &self,
        artist_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Page<LibraryTrack>> {
        let total = self.connection.query_row(
            "SELECT COUNT(*) FROM track_artists WHERE artist_id = ?1",
            [artist_id],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.path, t.title, t.artists, t.album, t.album_id, t.duration_ms,
                    t.file_size, t.modified_unix_ms, t.sample_rate, t.channels, t.bitrate_kbps,
                    t.artist_ids, t.artwork_hash, t.artwork_mime
             FROM track_artists ta JOIN tracks t ON t.id = ta.media_id
             WHERE ta.artist_id = ?1 ORDER BY t.album COLLATE NOCASE, t.title COLLATE NOCASE, t.id
             LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(params![artist_id, limit, offset], map_track)?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn folder_tracks(
        &self,
        folder_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Page<LibraryTrack>> {
        self.entity_tracks("t.folder_id = ?1", folder_id, limit, offset)
    }

    fn entity_tracks(
        &self,
        filter: &str,
        id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Page<LibraryTrack>> {
        let total = self.connection.query_row(
            &format!("SELECT COUNT(*) FROM tracks t WHERE {filter}"),
            [id],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT t.id, t.path, t.title, t.artists, t.album, t.album_id, t.duration_ms,
                    t.file_size, t.modified_unix_ms, t.sample_rate, t.channels, t.bitrate_kbps,
                    t.artist_ids, t.artwork_hash, t.artwork_mime
             FROM tracks t WHERE {filter}
             ORDER BY t.title COLLATE NOCASE, t.id LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = statement.query_map(params![id, limit, offset], map_track)?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn playlist_tracks(
        &self,
        playlist_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Page<LibraryTrack>> {
        let total = self.connection.query_row(
            "SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?1",
            [playlist_id],
            |row| u64_column(row, 0),
        )?;
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.path, t.title, t.artists, t.album, t.album_id, t.duration_ms,
                    t.file_size, t.modified_unix_ms, t.sample_rate, t.channels, t.bitrate_kbps,
                    t.artist_ids, t.artwork_hash, t.artwork_mime
             FROM playlist_tracks pt JOIN tracks t ON t.id = pt.media_id
             WHERE pt.playlist_id = ?1 ORDER BY pt.position LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(params![playlist_id, limit, offset], map_track)?;
        Ok(Page {
            items: rows.collect::<std::result::Result<Vec<_>, _>>()?,
            total,
        })
    }

    pub fn remove_track(&self, id: &MediaId) -> Result<bool> {
        Ok(self
            .connection
            .execute("DELETE FROM tracks WHERE id = ?1", params![id.0])?
            == 1)
    }

    pub fn remove_missing_under(&mut self, root: &Path, found: &[PathBuf]) -> Result<usize> {
        let escaped_root = root
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let prefix = format!("{escaped_root}%");
        let transaction = self.connection.transaction()?;
        let mut statement =
            transaction.prepare("SELECT path FROM tracks WHERE path LIKE ?1 ESCAPE '\\'")?;
        let existing = statement
            .query_map([prefix], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        let mut removed = 0;
        for stored_path in existing {
            let path = Path::new(&stored_path);
            if path.starts_with(root) && !found.iter().any(|candidate| candidate == path) {
                removed +=
                    transaction.execute("DELETE FROM tracks WHERE path = ?1", [stored_path])?;
            }
        }
        transaction.commit()?;
        Ok(removed)
    }

    pub fn upsert_cache_entry(&self, entry: &CacheEntry) -> Result<()> {
        if entry.content_id.0.trim().is_empty()
            || entry.quality.trim().is_empty()
            || entry.content_hash.trim().is_empty()
            || entry.official_source.trim().is_empty()
        {
            return Err(EngineError::InvalidInput(
                "cache identity, quality, hash, and official source are required".into(),
            ));
        }
        let entitlement_metadata_incomplete =
            entry.entitlement_snapshot.as_ref().is_none_or(|snapshot| {
                snapshot.valid_until_unix_ms.is_none()
                    || snapshot
                        .server_revision
                        .as_deref()
                        .is_none_or(|value| value.trim().is_empty())
            }) || entry.last_validated_unix_ms.is_none();
        if matches!(entry.access_class, CacheAccessClass::AccountEntitled { .. })
            && entitlement_metadata_incomplete
        {
            return Err(EngineError::InvalidInput(
                "account-entitled cache requires expiration, revision, and validation time".into(),
            ));
        }
        let (access_class, owner_user_id) = match entry.access_class {
            CacheAccessClass::Public => ("public", None),
            CacheAccessClass::AccountEntitled { owner_user_id } => (
                "account_entitled",
                Some(sqlite_integer(owner_user_id, "owner_user_id")?),
            ),
        };
        let (product, valid_until, revision) = match &entry.entitlement_snapshot {
            Some(snapshot) => (
                Some(snapshot.product.as_str()),
                optional_sqlite_integer(snapshot.valid_until_unix_ms, "valid_until_unix_ms")?,
                snapshot.server_revision.as_deref(),
            ),
            None => (None, None, None),
        };
        let last_validated =
            optional_sqlite_integer(entry.last_validated_unix_ms, "last_validated_unix_ms")?;
        self.connection.execute(
            "INSERT INTO cache_entries (
                content_id, quality, content_hash, access_class, owner_user_id,
                entitlement_product, entitlement_valid_until_unix_ms,
                entitlement_server_revision, last_validated_unix_ms, official_source, state
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(content_id, quality) DO UPDATE SET
                content_hash=excluded.content_hash, access_class=excluded.access_class,
                owner_user_id=excluded.owner_user_id,
                entitlement_product=excluded.entitlement_product,
                entitlement_valid_until_unix_ms=excluded.entitlement_valid_until_unix_ms,
                entitlement_server_revision=excluded.entitlement_server_revision,
                last_validated_unix_ms=excluded.last_validated_unix_ms,
                official_source=excluded.official_source, state=excluded.state",
            params![
                entry.content_id.0,
                entry.quality,
                entry.content_hash,
                access_class,
                owner_user_id,
                product,
                valid_until,
                revision,
                last_validated,
                entry.official_source,
                cache_state_name(entry.state),
            ],
        )?;
        Ok(())
    }

    pub fn cache_entry(&self, content_id: &MediaId, quality: &str) -> Result<Option<CacheEntry>> {
        self.connection
            .query_row(
                "SELECT content_id, quality, content_hash, access_class, owner_user_id,
                        entitlement_product, entitlement_valid_until_unix_ms,
                        entitlement_server_revision, last_validated_unix_ms,
                        official_source, state
                 FROM cache_entries WHERE content_id = ?1 AND quality = ?2",
                params![content_id.0, quality],
                map_cache_entry,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn cache_entries_for(&self, content_id: &MediaId) -> Result<Vec<CacheEntry>> {
        let mut statement = self.connection.prepare(
            "SELECT content_id, quality, content_hash, access_class, owner_user_id,
                    entitlement_product, entitlement_valid_until_unix_ms,
                    entitlement_server_revision, last_validated_unix_ms,
                    official_source, state
             FROM cache_entries WHERE content_id = ?1 ORDER BY quality",
        )?;
        let rows = statement.query_map(params![content_id.0], map_cache_entry)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn cache_stats(&self) -> Result<CacheRepositoryStats> {
        self.connection
            .query_row(
                "SELECT COUNT(*),
                        COALESCE((SELECT SUM(size_bytes) FROM cache_objects), 0),
                        COALESCE(SUM(CASE WHEN state = 'locked_entitlement' THEN 1 ELSE 0 END), 0)
                 FROM cache_entries",
                [],
                |row| {
                    Ok(CacheRepositoryStats {
                        entry_count: u64_column(row, 0)?,
                        bytes_used: u64_column(row, 1)?,
                        locked_entries: u64_column(row, 2)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn lock_account_entitled_cache_entries(
        &mut self,
        scope: EntitlementCacheScope,
    ) -> Result<CacheEntitlementLockResult> {
        let owner_user_id = match scope {
            EntitlementCacheScope::Owner(owner_user_id) => {
                Some(sqlite_integer(owner_user_id, "owner_user_id")?)
            }
            EntitlementCacheScope::AllAccounts => None,
        };
        let transaction = self.connection.transaction()?;
        let revoked_leases = transaction.execute(
            "DELETE FROM cache_leases
             WHERE content_hash IN (
                 SELECT content_hash FROM cache_entries
                 WHERE access_class = 'account_entitled'
                   AND (?1 IS NULL OR owner_user_id = ?1)
             )",
            params![owner_user_id],
        )?;
        let locked_entries = transaction.execute(
            "UPDATE cache_entries SET state = 'locked_entitlement'
             WHERE access_class = 'account_entitled'
               AND (?1 IS NULL OR owner_user_id = ?1)
               AND state <> 'locked_entitlement'",
            params![owner_user_id],
        )?;
        transaction.commit()?;
        Ok(CacheEntitlementLockResult {
            locked_entries,
            revoked_leases,
        })
    }

    pub fn remove_cache_entries_for(
        &mut self,
        content_id: &MediaId,
    ) -> Result<Vec<RemovedCacheObject>> {
        let transaction = self.connection.transaction()?;
        let hashes = {
            let mut statement = transaction
                .prepare("SELECT DISTINCT content_hash FROM cache_entries WHERE content_id = ?1")?;
            let rows = statement
                .query_map(params![content_id.0], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        transaction.execute(
            "DELETE FROM cache_entries
             WHERE content_id = ?1
               AND NOT EXISTS (
                   SELECT 1 FROM cache_leases
                   WHERE cache_leases.content_hash = cache_entries.content_hash
               )",
            params![content_id.0],
        )?;
        let removed = collect_unreferenced_cache_objects(&transaction, hashes)?;
        transaction.commit()?;
        Ok(removed)
    }

    pub fn clear_cache_entries(&mut self) -> Result<Vec<RemovedCacheObject>> {
        let transaction = self.connection.transaction()?;
        let hashes = {
            let mut statement =
                transaction.prepare("SELECT DISTINCT content_hash FROM cache_entries")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        transaction.execute(
            "DELETE FROM cache_entries
             WHERE NOT EXISTS (
                 SELECT 1 FROM cache_leases
                 WHERE cache_leases.content_hash = cache_entries.content_hash
             )",
            [],
        )?;
        let removed = collect_unreferenced_cache_objects(&transaction, hashes)?;
        transaction.commit()?;
        Ok(removed)
    }

    pub fn record_cache_object(&self, object: &CacheObject, completed_unix_ms: u64) -> Result<()> {
        let file_name = object
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                EngineError::InvalidInput("cache object path has no file name".into())
            })?;
        if file_name != object.content_hash || object.path.extension().is_some() {
            return Err(EngineError::InvalidInput(
                "cache object path must be the extensionless content hash".into(),
            ));
        }
        self.connection.execute(
            "INSERT INTO cache_objects(content_hash, size_bytes, relative_path, completed_unix_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(content_hash) DO UPDATE SET size_bytes=excluded.size_bytes,
                relative_path=excluded.relative_path, completed_unix_ms=excluded.completed_unix_ms",
            params![
                object.content_hash,
                sqlite_integer(object.size_bytes, "size_bytes")?,
                file_name,
                sqlite_integer(completed_unix_ms, "completed_unix_ms")?
            ],
        )?;
        Ok(())
    }

    pub fn acquire_cache_lease(
        &self,
        content_hash: &str,
        lease: &CacheLease,
        created_unix_ms: u64,
    ) -> Result<()> {
        self.connection.execute(
            "INSERT INTO cache_leases(content_hash, lease_key, created_unix_ms)
             VALUES (?1, ?2, ?3) ON CONFLICT(content_hash, lease_key) DO NOTHING",
            params![
                content_hash,
                lease.stable_key(),
                sqlite_integer(created_unix_ms, "created_unix_ms")?
            ],
        )?;
        Ok(())
    }

    pub fn release_cache_lease(&self, content_hash: &str, lease: &CacheLease) -> Result<bool> {
        Ok(self.connection.execute(
            "DELETE FROM cache_leases WHERE content_hash = ?1 AND lease_key = ?2",
            params![content_hash, lease.stable_key()],
        )? == 1)
    }

    pub fn cache_lease_count(&self, content_hash: &str) -> Result<u32> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM cache_leases WHERE content_hash = ?1",
                [content_hash],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn upsert_album_fill_task(&self, task: &AlbumFillTask) -> Result<()> {
        if task.album_id.trim().is_empty() || task.completed_items > task.total_items {
            return Err(EngineError::InvalidInput("invalid album fill task".into()));
        }
        self.connection.execute(
            "INSERT INTO album_fill_tasks(album_id, state, priority, completed_items,
                 total_items, updated_unix_ms, failure)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(album_id) DO UPDATE SET state=excluded.state,
                 priority=excluded.priority, completed_items=excluded.completed_items,
                 total_items=excluded.total_items, updated_unix_ms=excluded.updated_unix_ms,
                 failure=excluded.failure",
            params![
                task.album_id,
                album_task_state_name(task.state),
                prefetch_priority_name(task.priority),
                task.completed_items,
                task.total_items,
                sqlite_integer(task.updated_unix_ms, "updated_unix_ms")?,
                task.failure
            ],
        )?;
        Ok(())
    }

    pub fn album_fill_task(&self, album_id: &str) -> Result<Option<AlbumFillTask>> {
        self.connection
            .query_row(
                "SELECT album_id, state, priority, completed_items, total_items,
                        updated_unix_ms, failure FROM album_fill_tasks WHERE album_id = ?1",
                [album_id],
                map_album_fill_task,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn record_album_session(&mut self, session: &AlbumSession) -> Result<AlbumPromotion> {
        if !session.qualifies() {
            return Err(EngineError::InvalidInput(
                "album session does not satisfy D24 qualification rules".into(),
            ));
        }
        if session.album_id.trim().is_empty() || session.local_day.trim().is_empty() {
            return Err(EngineError::InvalidInput(
                "album id and local day are required".into(),
            ));
        }
        let transaction = self.connection.transaction()?;
        let counted = transaction.execute(
            "INSERT OR IGNORE INTO album_sessions(album_id, local_day) VALUES (?1, ?2)",
            params![session.album_id, session.local_day],
        )? == 1;
        if counted {
            transaction.execute(
                "INSERT INTO album_stats(album_id, qualified_sessions, is_frequent)
                 VALUES (?1, 1, 0)
                 ON CONFLICT(album_id) DO UPDATE SET
                    qualified_sessions = qualified_sessions + 1",
                params![session.album_id],
            )?;
            transaction.execute(
                "UPDATE album_stats SET is_frequent = 1
                 WHERE album_id = ?1 AND qualified_sessions >= ?2",
                params![session.album_id, FREQUENT_ALBUM_THRESHOLD],
            )?;
        }
        promotion_result(transaction, &session.album_id, counted)
    }

    fn migrate(&mut self) -> Result<()> {
        let current: i64 = self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current > LATEST_SCHEMA_VERSION {
            return Err(EngineError::Unsupported(format!(
                "database schema version {current} is newer than supported version {LATEST_SCHEMA_VERSION}"
            )));
        }
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version > current) {
            let transaction = self.connection.transaction()?;
            transaction.execute_batch(sql)?;
            transaction.pragma_update(None, "user_version", version)?;
            transaction.commit()?;
        }
        Ok(())
    }
}

impl ScanRepository for SqliteRepository {
    fn upsert_scanned_track(&self, track: &LibraryTrack) -> Result<()> {
        self.upsert_track(track)
    }

    fn finish_scan(&mut self, root: &Path, found: &[PathBuf]) -> Result<usize> {
        self.remove_missing_under(root, found)
    }
}

fn collect_unreferenced_cache_objects(
    transaction: &Transaction<'_>,
    hashes: Vec<String>,
) -> Result<Vec<RemovedCacheObject>> {
    let mut removed = Vec::new();
    for hash in hashes {
        let references: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM cache_entries WHERE content_hash = ?1",
            [&hash],
            |row| row.get(0),
        )?;
        let leases: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM cache_leases WHERE content_hash = ?1",
            [&hash],
            |row| row.get(0),
        )?;
        if references == 0 && leases == 0 {
            let path = transaction
                .query_row(
                    "SELECT relative_path FROM cache_objects WHERE content_hash = ?1",
                    [&hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(path) = path {
                transaction
                    .execute("DELETE FROM cache_objects WHERE content_hash = ?1", [&hash])?;
                removed.push(RemovedCacheObject {
                    content_hash: hash,
                    relative_path: PathBuf::from(path),
                });
            }
        }
    }
    Ok(removed)
}

fn promotion_result(
    transaction: Transaction<'_>,
    album_id: &str,
    counted: bool,
) -> Result<AlbumPromotion> {
    let (qualified_sessions, is_frequent): (u32, bool) = transaction.query_row(
        "SELECT qualified_sessions, is_frequent FROM album_stats WHERE album_id = ?1",
        params![album_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    transaction.commit()?;
    Ok(AlbumPromotion {
        counted,
        qualified_sessions,
        became_frequent: counted && qualified_sessions == FREQUENT_ALBUM_THRESHOLD,
        is_frequent,
    })
}

fn split_stored(value: &str) -> Vec<String> {
    if value.is_empty() {
        Vec::new()
    } else {
        value.split('\u{1f}').map(str::to_owned).collect()
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn map_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTrack> {
    let path = PathBuf::from(row.get::<_, String>(1)?);
    let artists: String = row.get(3)?;
    let artist_ids: String = row.get(12)?;
    Ok(LibraryTrack {
        track: Track {
            id: MediaId(row.get(0)?),
            source: MediaSource::Local { path: path.clone() },
            title: row.get(2)?,
            artists: split_stored(&artists),
            album: row.get(4)?,
            album_id: row.get(5)?,
            artist_ids: split_stored(&artist_ids),
            artwork_hash: row.get(13)?,
            artwork_mime: row.get(14)?,
            duration_ms: optional_u64_column(row, 6)?,
        },
        path,
        file_size: u64_column(row, 7)?,
        modified_unix_ms: u64_column(row, 8)?,
        sample_rate: row.get(9)?,
        channels: row.get(10)?,
        bitrate_kbps: row.get(11)?,
    })
}

fn map_cache_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<CacheEntry> {
    let access_name: String = row.get(3)?;
    let owner: Option<i64> = row.get(4)?;
    let access_class = match (access_name.as_str(), owner) {
        ("public", None) => CacheAccessClass::Public,
        ("account_entitled", Some(owner)) => CacheAccessClass::AccountEntitled {
            owner_user_id: checked_u64(owner, 4)?,
        },
        _ => return Err(invalid_column(3, "invalid cache access class")),
    };
    let product: Option<String> = row.get(5)?;
    let valid_until_unix_ms = optional_u64_column(row, 6)?;
    let server_revision: Option<String> = row.get(7)?;
    let entitlement_snapshot = product.map(|product| EntitlementSnapshot {
        product,
        valid_until_unix_ms,
        server_revision,
    });
    let state_name: String = row.get(10)?;
    let state = match state_name.as_str() {
        "available" => CacheState::Available,
        "locked_entitlement" => CacheState::LockedEntitlement,
        "partial" => CacheState::Partial,
        _ => return Err(invalid_column(10, "invalid cache state")),
    };
    Ok(CacheEntry {
        content_id: MediaId(row.get(0)?),
        quality: row.get(1)?,
        content_hash: row.get(2)?,
        access_class,
        entitlement_snapshot,
        last_validated_unix_ms: optional_u64_column(row, 8)?,
        official_source: row.get(9)?,
        state,
    })
}

fn cache_state_name(state: CacheState) -> &'static str {
    match state {
        CacheState::Available => "available",
        CacheState::LockedEntitlement => "locked_entitlement",
        CacheState::Partial => "partial",
    }
}

fn album_task_state_name(state: AlbumTaskState) -> &'static str {
    match state {
        AlbumTaskState::Pending => "pending",
        AlbumTaskState::Running => "running",
        AlbumTaskState::PausedResources => "paused_resources",
        AlbumTaskState::Completed => "completed",
        AlbumTaskState::Cancelled => "cancelled",
        AlbumTaskState::Failed => "failed",
    }
}

fn prefetch_priority_name(priority: PrefetchPriority) -> &'static str {
    match priority {
        PrefetchPriority::CurrentTrack => "current_track",
        PrefetchPriority::NextTrack => "next_track",
        PrefetchPriority::FollowingTrack => "following_track",
        PrefetchPriority::FrequentAlbumRemainder => "frequent_album_remainder",
    }
}

fn map_album_fill_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumFillTask> {
    let state = match row.get::<_, String>(1)?.as_str() {
        "pending" => AlbumTaskState::Pending,
        "running" => AlbumTaskState::Running,
        "paused_resources" => AlbumTaskState::PausedResources,
        "completed" => AlbumTaskState::Completed,
        "cancelled" => AlbumTaskState::Cancelled,
        "failed" => AlbumTaskState::Failed,
        _ => return Err(invalid_column(1, "invalid album task state")),
    };
    let priority = match row.get::<_, String>(2)?.as_str() {
        "current_track" => PrefetchPriority::CurrentTrack,
        "next_track" => PrefetchPriority::NextTrack,
        "following_track" => PrefetchPriority::FollowingTrack,
        "frequent_album_remainder" => PrefetchPriority::FrequentAlbumRemainder,
        _ => return Err(invalid_column(2, "invalid prefetch priority")),
    };
    Ok(AlbumFillTask {
        album_id: row.get(0)?,
        state,
        priority,
        completed_items: row.get(3)?,
        total_items: row.get(4)?,
        updated_unix_ms: u64_column(row, 5)?,
        failure: row.get(6)?,
    })
}

fn validate_playlist_name<'a>(id: &str, name: &'a str) -> Result<&'a str> {
    let name = name.trim();
    if id.trim().is_empty() || name.is_empty() {
        return Err(EngineError::InvalidInput(
            "playlist id and name are required".into(),
        ));
    }
    if name.chars().count() > 80 {
        return Err(EngineError::InvalidInput(
            "playlist name is too long".into(),
        ));
    }
    Ok(name)
}

fn sqlite_integer(value: u64, field: &str) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| EngineError::InvalidInput(format!("{field} exceeds SQLite INTEGER")))
}

fn optional_sqlite_integer(value: Option<u64>, field: &str) -> Result<Option<i64>> {
    value.map(|value| sqlite_integer(value, field)).transpose()
}

fn u64_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    checked_u64(row.get(index)?, index)
}

fn optional_u64_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| checked_u64(value, index))
        .transpose()
}

fn checked_u64(value: i64, index: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

fn invalid_column(index: usize, message: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message.to_owned(),
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track_at(id: &str, path: impl Into<PathBuf>) -> LibraryTrack {
        let path = path.into();
        LibraryTrack {
            track: Track {
                id: MediaId::new(id),
                source: MediaSource::Local { path: path.clone() },
                title: "Song".into(),
                artists: vec!["One".into(), "Two".into()],
                album: Some("Album".into()),
                album_id: Some(crate::library::stable_entity_id("album", &["Album", "One"])),
                artist_ids: vec![
                    crate::library::stable_entity_id("artist", &["One"]),
                    crate::library::stable_entity_id("artist", &["Two"]),
                ],
                artwork_hash: None,
                artwork_mime: None,
                duration_ms: Some(1234),
            },
            path,
            file_size: 55,
            modified_unix_ms: 99,
            sample_rate: Some(48_000),
            channels: Some(2),
            bitrate_kbps: Some(900),
        }
    }

    fn track() -> LibraryTrack {
        track_at("local:1", "C:/music/song.flac")
    }

    fn session(day: &str) -> AlbumSession {
        AlbumSession {
            album_id: "album".into(),
            local_day: day.into(),
            from_album_context: true,
            completed_tracks: 1,
            effective_playback_ms: 0,
        }
    }

    #[test]
    fn migrations_and_track_round_trip() {
        let repository = SqliteRepository::in_memory().unwrap();
        assert_eq!(repository.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        repository.upsert_track(&track()).unwrap();
        assert_eq!(
            repository.track_by_id(&MediaId::new("local:1")).unwrap(),
            Some(track())
        );
    }

    #[test]
    fn remove_missing_under_does_not_delete_sibling_with_same_text_prefix() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let missing = track_at("local:missing", "C:/music/missing.wav");
        let sibling = track_at("local:sibling", "C:/music-backup/keep.wav");
        repository.upsert_track(&missing).unwrap();
        repository.upsert_track(&sibling).unwrap();

        assert_eq!(
            repository
                .remove_missing_under(Path::new("C:/music"), &[])
                .unwrap(),
            1
        );
        assert!(repository.track_by_id(&missing.track.id).unwrap().is_none());
        assert_eq!(
            repository.track_by_id(&sibling.track.id).unwrap(),
            Some(sibling)
        );
    }

    #[test]
    fn remove_missing_under_treats_like_wildcards_as_literal_path_characters() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let under_root = track_at("local:wild", "C:/mix%_root/missing.wav");
        let like_match = track_at("local:like", "C:/mixXXroot/keep.wav");
        repository.upsert_track(&under_root).unwrap();
        repository.upsert_track(&like_match).unwrap();

        assert_eq!(
            repository
                .remove_missing_under(Path::new("C:/mix%_root"), &[])
                .unwrap(),
            1
        );
        assert_eq!(
            repository.track_by_id(&like_match.track.id).unwrap(),
            Some(like_match)
        );
    }

    #[test]
    fn cache_metadata_round_trips_without_losing_entitlement_owner() {
        let repository = SqliteRepository::in_memory().unwrap();
        let entry = CacheEntry {
            content_id: MediaId::new("netease:1"),
            quality: "lossless".into(),
            content_hash: "sha256-value".into(),
            access_class: CacheAccessClass::AccountEntitled { owner_user_id: 42 },
            entitlement_snapshot: Some(EntitlementSnapshot {
                product: "vip".into(),
                valid_until_unix_ms: Some(123_456),
                server_revision: Some("rev-1".into()),
            }),
            last_validated_unix_ms: Some(123_000),
            official_source: "netease".into(),
            state: CacheState::LockedEntitlement,
        };
        repository.upsert_cache_entry(&entry).unwrap();
        assert_eq!(
            repository
                .cache_entry(&entry.content_id, &entry.quality)
                .unwrap(),
            Some(entry)
        );
    }

    #[test]
    fn incomplete_entitled_cache_is_rejected() {
        let repository = SqliteRepository::in_memory().unwrap();
        let entry = CacheEntry {
            content_id: MediaId::new("netease:1"),
            quality: "lossless".into(),
            content_hash: "sha256-value".into(),
            access_class: CacheAccessClass::AccountEntitled { owner_user_id: 42 },
            entitlement_snapshot: None,
            last_validated_unix_ms: None,
            official_source: "netease".into(),
            state: CacheState::Available,
        };
        assert!(repository.upsert_cache_entry(&entry).is_err());
    }

    #[test]
    fn locking_entitled_cache_for_owner_preserves_other_owners_and_public_entries() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let owner_hash = "1".repeat(64);
        let other_hash = "2".repeat(64);
        for hash in [&owner_hash, &other_hash] {
            repository
                .record_cache_object(
                    &CacheObject {
                        content_hash: hash.clone(),
                        size_bytes: 1,
                        path: PathBuf::from(hash),
                    },
                    1,
                )
                .unwrap();
        }
        let entitled_entry = |content_id: &str, owner_user_id, content_hash: &str| CacheEntry {
            content_id: MediaId::new(content_id),
            quality: "lossless".into(),
            content_hash: content_hash.into(),
            access_class: CacheAccessClass::AccountEntitled { owner_user_id },
            entitlement_snapshot: Some(EntitlementSnapshot {
                product: "vip".into(),
                valid_until_unix_ms: Some(123_456),
                server_revision: Some("rev-1".into()),
            }),
            last_validated_unix_ms: Some(123_000),
            official_source: "netease".into(),
            state: CacheState::Available,
        };
        let owner_entry = entitled_entry("owner", 42, &owner_hash);
        let other_entry = entitled_entry("other", 7, &other_hash);
        let public_entry = CacheEntry {
            content_id: MediaId::new("public"),
            quality: "lossless".into(),
            content_hash: owner_hash.clone(),
            access_class: CacheAccessClass::Public,
            entitlement_snapshot: None,
            last_validated_unix_ms: None,
            official_source: "netease".into(),
            state: CacheState::Available,
        };
        for entry in [&owner_entry, &other_entry, &public_entry] {
            repository.upsert_cache_entry(entry).unwrap();
        }
        let lease = CacheLease::NextTrackPrefetch;
        repository
            .acquire_cache_lease(&owner_hash, &lease, 2)
            .unwrap();
        repository
            .acquire_cache_lease(&other_hash, &lease, 2)
            .unwrap();

        let result = repository
            .lock_account_entitled_cache_entries(EntitlementCacheScope::Owner(42))
            .unwrap();

        assert_eq!(
            result,
            CacheEntitlementLockResult {
                locked_entries: 1,
                revoked_leases: 1,
            }
        );
        assert_eq!(
            repository
                .cache_entry(&owner_entry.content_id, &owner_entry.quality)
                .unwrap()
                .unwrap()
                .state,
            CacheState::LockedEntitlement
        );
        assert_eq!(
            repository
                .cache_entry(&other_entry.content_id, &other_entry.quality)
                .unwrap()
                .unwrap()
                .state,
            CacheState::Available
        );
        assert_eq!(
            repository
                .cache_entry(&public_entry.content_id, &public_entry.quality)
                .unwrap()
                .unwrap()
                .state,
            CacheState::Available
        );
        assert_eq!(repository.cache_lease_count(&owner_hash).unwrap(), 0);
        assert_eq!(repository.cache_lease_count(&other_hash).unwrap(), 1);
    }

    #[test]
    fn locking_all_entitled_cache_is_idempotent_and_revokes_all_matching_leases() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let first_hash = "3".repeat(64);
        let second_hash = "4".repeat(64);
        for hash in [&first_hash, &second_hash] {
            repository
                .record_cache_object(
                    &CacheObject {
                        content_hash: hash.clone(),
                        size_bytes: 1,
                        path: PathBuf::from(hash),
                    },
                    1,
                )
                .unwrap();
        }
        for (content_id, owner_user_id, content_hash, state) in [
            ("first", 42, &first_hash, CacheState::Available),
            ("second", 7, &second_hash, CacheState::Partial),
        ] {
            repository
                .upsert_cache_entry(&CacheEntry {
                    content_id: MediaId::new(content_id),
                    quality: "lossless".into(),
                    content_hash: content_hash.clone(),
                    access_class: CacheAccessClass::AccountEntitled { owner_user_id },
                    entitlement_snapshot: Some(EntitlementSnapshot {
                        product: "vip".into(),
                        valid_until_unix_ms: Some(123_456),
                        server_revision: Some("rev-1".into()),
                    }),
                    last_validated_unix_ms: Some(123_000),
                    official_source: "netease".into(),
                    state,
                })
                .unwrap();
            repository
                .acquire_cache_lease(content_hash, &CacheLease::NextTrackPrefetch, 2)
                .unwrap();
        }

        assert_eq!(
            repository
                .lock_account_entitled_cache_entries(EntitlementCacheScope::AllAccounts)
                .unwrap(),
            CacheEntitlementLockResult {
                locked_entries: 2,
                revoked_leases: 2,
            }
        );
        for content_id in ["first", "second"] {
            assert_eq!(
                repository
                    .cache_entry(&MediaId::new(content_id), "lossless")
                    .unwrap()
                    .unwrap()
                    .state,
                CacheState::LockedEntitlement
            );
        }
        assert_eq!(repository.cache_lease_count(&first_hash).unwrap(), 0);
        assert_eq!(repository.cache_lease_count(&second_hash).unwrap(), 0);
        assert_eq!(
            repository
                .lock_account_entitled_cache_entries(EntitlementCacheScope::AllAccounts)
                .unwrap(),
            CacheEntitlementLockResult::default()
        );
        assert_eq!(
            repository
                .lock_account_entitled_cache_entries(EntitlementCacheScope::Owner(999))
                .unwrap(),
            CacheEntitlementLockResult::default()
        );
    }

    #[test]
    fn album_session_counts_once_per_day_and_promotes_at_five() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let first = repository
            .record_album_session(&session("2026-08-30"))
            .unwrap();
        let duplicate = repository
            .record_album_session(&session("2026-08-30"))
            .unwrap();
        assert!(first.counted);
        assert!(!duplicate.counted);

        for day in ["2026-08-31", "2026-09-01", "2026-09-02"] {
            repository.record_album_session(&session(day)).unwrap();
        }
        let promoted = repository
            .record_album_session(&session("2026-09-03"))
            .unwrap();
        assert_eq!(promoted.qualified_sessions, 5);
        assert!(promoted.became_frequent);
        assert!(promoted.is_frequent);
    }

    #[test]
    fn repository_rejects_unqualified_album_sessions() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let mut value = session("2026-08-30");
        value.from_album_context = false;
        assert!(repository.record_album_session(&value).is_err());
    }

    #[test]
    fn future_schema_is_rejected_without_migration() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("future.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "user_version", LATEST_SCHEMA_VERSION + 1)
            .unwrap();
        drop(connection);

        assert!(matches!(
            SqliteRepository::open(path),
            Err(EngineError::Unsupported(_))
        ));
    }

    #[test]
    fn queue_history_and_restore_position_round_trip() {
        use crate::model::test_item;

        let repository = SqliteRepository::in_memory().unwrap();
        let mut queue = PlaybackQueue::new(19);
        queue.replace_context(vec![test_item(1), test_item(2)], 0);
        queue.advance(false);
        repository
            .save_playback_session(&queue, 12_345, 99)
            .unwrap();
        repository
            .append_playback_history(&PlaybackHistoryRecord {
                media_id: MediaId::new("track-2"),
                played_unix_ms: 99,
                position_ms: 12_345,
            })
            .unwrap();
        let history_id = repository
            .start_playback_history(&PlaybackHistoryRecord {
                media_id: MediaId::new("track-session"),
                played_unix_ms: 100,
                position_ms: 0,
            })
            .unwrap();
        repository
            .update_playback_history_position(history_id, 5_432)
            .unwrap();

        let restored = repository.load_playback_session().unwrap().unwrap();
        assert_eq!(restored.queue.context_snapshot(), queue.context_snapshot());
        assert_eq!(restored.position_ms, 12_345);
        let history = repository.playback_history(10).unwrap();
        assert_eq!(history[0].media_id, MediaId::new("track-session"));
        assert_eq!(history[0].position_ms, 5_432);
        assert_eq!(history[1].position_ms, 12_345);
    }

    #[test]
    fn registered_root_guards_media_id_to_path_resolution() {
        let root = tempfile::tempdir().unwrap();
        let song = root.path().join("song.flac");
        std::fs::write(&song, []).unwrap();
        let repository = SqliteRepository::in_memory().unwrap();
        repository
            .upsert_track(&track_at("local:safe", &song))
            .unwrap();
        assert!(repository.media_path(&MediaId::new("local:safe")).is_err());

        let canonical_root = repository.register_library_root(root.path()).unwrap();
        assert_eq!(
            repository.media_path(&MediaId::new("local:safe")).unwrap(),
            Some(canonical_root.join("song.flac"))
        );
    }

    #[test]
    fn playlist_lifecycle_preserves_tracks_and_ignores_duplicate_adds() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let first = track_at("local:first", "C:/music/first.flac");
        let second = track_at("local:second", "C:/music/second.flac");
        repository.upsert_track(&first).unwrap();
        repository.upsert_track(&second).unwrap();
        repository
            .create_playlist("playlist", "Original", 1)
            .unwrap();

        repository
            .add_playlist_track("playlist", &first.track.id, 2)
            .unwrap();
        repository
            .add_playlist_track("playlist", &first.track.id, 3)
            .unwrap();
        assert_eq!(
            repository
                .playlist_by_id("playlist")
                .unwrap()
                .unwrap()
                .updated_unix_ms,
            2
        );
        repository
            .add_playlist_track("playlist", &second.track.id, 4)
            .unwrap();
        repository
            .rename_playlist("playlist", "  Renamed  ", 5)
            .unwrap();

        let playlists = repository.query_playlists(None, 10, 0).unwrap();
        assert_eq!(playlists.total, 1);
        assert_eq!(playlists.items[0].name, "Renamed");
        assert_eq!(playlists.items[0].track_count, 2);
        assert_eq!(
            repository
                .playlist_tracks("playlist", 10, 0)
                .unwrap()
                .items
                .into_iter()
                .map(|track| track.track.id)
                .collect::<Vec<_>>(),
            vec![first.track.id.clone(), second.track.id.clone()]
        );

        repository.delete_playlist("playlist").unwrap();
        assert_eq!(repository.query_playlists(None, 10, 0).unwrap().total, 0);
        assert_eq!(
            repository.track_by_id(&first.track.id).unwrap(),
            Some(first)
        );
        assert_eq!(
            repository.track_by_id(&second.track.id).unwrap(),
            Some(second)
        );
    }

    #[test]
    fn removing_and_reordering_playlist_tracks_keeps_a_dense_order() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let tracks = [
            track_at("local:first", "C:/music/first.flac"),
            track_at("local:second", "C:/music/second.flac"),
            track_at("local:third", "C:/music/third.flac"),
        ];
        repository.create_playlist("playlist", "Order", 1).unwrap();
        for (index, track) in tracks.iter().enumerate() {
            repository.upsert_track(track).unwrap();
            repository
                .add_playlist_track("playlist", &track.track.id, index as u64 + 2)
                .unwrap();
        }

        repository
            .reorder_playlist_track("playlist", &tracks[2].track.id, 0, 10)
            .unwrap();
        repository
            .reorder_playlist_track("playlist", &tracks[2].track.id, 2, 11)
            .unwrap();
        repository
            .remove_playlist_track("playlist", &tracks[1].track.id, 12)
            .unwrap();

        assert_eq!(
            repository
                .playlist_tracks("playlist", 10, 0)
                .unwrap()
                .items
                .into_iter()
                .map(|track| track.track.id)
                .collect::<Vec<_>>(),
            vec![tracks[0].track.id.clone(), tracks[2].track.id.clone()]
        );
        repository
            .reorder_playlist_track("playlist", &tracks[2].track.id, 0, 13)
            .unwrap();
        assert_eq!(
            repository
                .playlist_tracks("playlist", 10, 0)
                .unwrap()
                .items
                .into_iter()
                .map(|track| track.track.id)
                .collect::<Vec<_>>(),
            vec![tracks[2].track.id.clone(), tracks[0].track.id.clone()]
        );
    }

    #[test]
    fn playlist_mutations_reject_missing_tracks_and_out_of_bounds_positions() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let only = track_at("local:only", "C:/music/only.flac");
        repository.upsert_track(&only).unwrap();
        repository.create_playlist("playlist", "Bounds", 1).unwrap();
        repository
            .add_playlist_track("playlist", &only.track.id, 2)
            .unwrap();

        assert!(matches!(
            repository.add_playlist_track("playlist", &MediaId::new("local:missing"), u64::MAX),
            Err(EngineError::InvalidInput(_))
        ));
        assert_eq!(
            repository.playlist_tracks("playlist", 10, 0).unwrap().total,
            1
        );
        assert!(matches!(
            repository.reorder_playlist_track("playlist", &only.track.id, 1, 3),
            Err(EngineError::InvalidInput(_))
        ));
        assert!(matches!(
            repository.remove_playlist_track("playlist", &MediaId::new("local:missing"), 4),
            Err(EngineError::InvalidInput(_))
        ));
        assert!(matches!(
            repository.rename_playlist("missing", "Name", 5),
            Err(EngineError::InvalidInput(_))
        ));
        assert!(matches!(
            repository.create_playlist("too-long", &"x".repeat(81), 6),
            Err(EngineError::InvalidInput(_))
        ));
        assert!(matches!(
            repository.rename_playlist("playlist", &"x".repeat(81), 7),
            Err(EngineError::InvalidInput(_))
        ));
        assert!(matches!(
            repository.delete_playlist("missing"),
            Err(EngineError::InvalidInput(_))
        ));
    }

    #[test]
    fn cache_stats_and_removal_preserve_leased_objects() {
        let mut repository = SqliteRepository::in_memory().unwrap();
        let hash = "b".repeat(64);
        let object = CacheObject {
            content_hash: hash.clone(),
            size_bytes: 11,
            path: PathBuf::from(&hash),
        };
        let entry = CacheEntry {
            content_id: MediaId::new("song"),
            quality: "lossless".into(),
            content_hash: hash.clone(),
            access_class: CacheAccessClass::Public,
            entitlement_snapshot: None,
            last_validated_unix_ms: None,
            official_source: "netease".into(),
            state: CacheState::Available,
        };
        repository.record_cache_object(&object, 1).unwrap();
        repository.upsert_cache_entry(&entry).unwrap();
        assert_eq!(
            repository.cache_stats().unwrap(),
            CacheRepositoryStats {
                entry_count: 1,
                bytes_used: 11,
                locked_entries: 0,
            }
        );
        let lease = CacheLease::NextTrackPrefetch;
        repository.acquire_cache_lease(&hash, &lease, 2).unwrap();
        assert!(repository
            .remove_cache_entries_for(&MediaId::new("song"))
            .unwrap()
            .is_empty());
        assert_eq!(repository.cache_stats().unwrap().entry_count, 1);
        assert_eq!(repository.cache_stats().unwrap().bytes_used, 11);
        repository.release_cache_lease(&hash, &lease).unwrap();
        let removed = repository
            .remove_cache_entries_for(&MediaId::new("song"))
            .unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(repository.cache_stats().unwrap().entry_count, 0);
    }

    #[test]
    fn cache_leases_and_album_tasks_round_trip() {
        let repository = SqliteRepository::in_memory().unwrap();
        let hash = "a".repeat(64);
        let object = CacheObject {
            content_hash: hash.clone(),
            size_bytes: 7,
            path: PathBuf::from(&hash),
        };
        repository.record_cache_object(&object, 1).unwrap();
        let lease = CacheLease::AlbumPrefetch {
            album_id: "album".into(),
        };
        repository.acquire_cache_lease(&hash, &lease, 2).unwrap();
        assert_eq!(repository.cache_lease_count(&hash).unwrap(), 1);
        assert!(repository.release_cache_lease(&hash, &lease).unwrap());

        let task = AlbumFillTask {
            album_id: "album".into(),
            state: AlbumTaskState::PausedResources,
            priority: PrefetchPriority::FrequentAlbumRemainder,
            completed_items: 2,
            total_items: 10,
            updated_unix_ms: 3,
            failure: None,
        };
        repository.upsert_album_fill_task(&task).unwrap();
        assert_eq!(repository.album_fill_task("album").unwrap(), Some(task));
    }
}
