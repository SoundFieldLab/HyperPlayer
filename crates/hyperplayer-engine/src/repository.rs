use crate::error::{EngineError, Result};
use crate::model::{
    AlbumSummary, ArtistSummary, FolderSummary, MediaId, MediaSource, PlaylistSummary, Track,
};
use rusqlite::types::Type;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
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
    (
        7,
        "ALTER TABLE cache_entries ADD COLUMN logical_size_bytes INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE cache_entries ADD COLUMN last_accessed_unix_ms INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE cache_entries ADD COLUMN acquisition_class TEXT NOT NULL DEFAULT 'automatic'
             CHECK(acquisition_class IN ('frequent_album_remainder', 'automatic', 'user_requested', 'recent_playback'));
         ALTER TABLE cache_entries ADD COLUMN public_proof_unix_ms INTEGER;
         ALTER TABLE cache_entries ADD COLUMN public_proof_revision TEXT;
         ALTER TABLE cache_entries ADD COLUMN partial_created_unix_ms INTEGER;
         ALTER TABLE cache_entries ADD COLUMN integrity_verified_unix_ms INTEGER;
         UPDATE cache_entries
            SET logical_size_bytes = COALESCE(
                (SELECT size_bytes FROM cache_objects
                 WHERE cache_objects.content_hash = cache_entries.content_hash),
                0
            );
         CREATE INDEX IF NOT EXISTS idx_cache_entries_eviction
             ON cache_entries(state, acquisition_class, last_accessed_unix_ms, content_hash);
         CREATE TABLE album_fill_items (
             item_id INTEGER PRIMARY KEY AUTOINCREMENT,
             album_id TEXT NOT NULL,
             content_id TEXT NOT NULL,
             quality TEXT NOT NULL,
             state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
             attempt_count INTEGER NOT NULL DEFAULT 0,
             priority TEXT NOT NULL CHECK(priority IN ('deferred', 'standard')),
             created_unix_ms INTEGER NOT NULL,
             updated_unix_ms INTEGER NOT NULL,
             failure TEXT,
             UNIQUE(album_id, content_id, quality)
         );
         CREATE INDEX idx_album_fill_items_claim
             ON album_fill_items(state, priority DESC, created_unix_ms, item_id);",
    ),
];

pub const LATEST_SCHEMA_VERSION: i64 = 7;
const V6_SCHEMA_VERSION: i64 = 6;

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

pub trait ScanRepository {
    fn upsert_scanned_track(&self, track: &LibraryTrack) -> Result<()>;
    fn finish_scan(&mut self, root: &Path, found: &[PathBuf]) -> Result<usize>;
}

/// v6 → v7 迁移前的一致性备份路径（保留 D30 迁移安全性）。
pub fn cache_v6_backup_path(path: &Path) -> PathBuf {
    let mut backup = path.as_os_str().to_os_string();
    backup.push(".v6.backup");
    PathBuf::from(backup)
}

fn cache_v6_backup_temp_path(path: &Path) -> PathBuf {
    let mut backup = cache_v6_backup_path(path).into_os_string();
    backup.push(".tmp");
    PathBuf::from(backup)
}

pub struct SqliteRepository {
    connection: Connection,
}

impl SqliteRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current > LATEST_SCHEMA_VERSION {
            return Err(EngineError::Unsupported(format!(
                "database schema version {current} is newer than supported version {LATEST_SCHEMA_VERSION}"
            )));
        }
        if current == V6_SCHEMA_VERSION {
            create_v6_backup(&connection, path)?;
        }
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

fn create_v6_backup(connection: &Connection, path: &Path) -> Result<()> {
    let backup_path = cache_v6_backup_path(path);
    let temporary_path = cache_v6_backup_temp_path(path);
    if temporary_path.exists() {
        fs::remove_file(&temporary_path)?;
    }
    let escaped = temporary_path.to_string_lossy().replace('\'', "''");
    connection.execute_batch(&format!("VACUUM INTO '{escaped}'"))?;
    let backup = Connection::open(&temporary_path)?;
    let version: i64 = backup.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    drop(backup);
    if version != V6_SCHEMA_VERSION {
        let _ = fs::remove_file(&temporary_path);
        return Err(EngineError::InvalidInput(
            "v6 recovery backup validation failed".into(),
        ));
    }
    replace_backup_atomically(&temporary_path, &backup_path)?;
    Ok(())
}

fn replace_backup_atomically(temporary_path: &Path, backup_path: &Path) -> Result<()> {
    if fs::rename(temporary_path, backup_path).is_ok() {
        return Ok(());
    }
    let mut previous = backup_path.as_os_str().to_os_string();
    previous.push(".previous");
    let previous = PathBuf::from(previous);
    if previous.exists() {
        fs::remove_file(&previous)?;
    }
    fs::rename(backup_path, &previous)?;
    if let Err(error) = fs::rename(temporary_path, backup_path) {
        let _ = fs::rename(&previous, backup_path);
        return Err(error.into());
    }
    fs::remove_file(previous)?;
    Ok(())
}

impl ScanRepository for SqliteRepository {
    fn upsert_scanned_track(&self, track: &LibraryTrack) -> Result<()> {
        self.upsert_track(track)
    }

    fn finish_scan(&mut self, root: &Path, found: &[PathBuf]) -> Result<usize> {
        self.remove_missing_under(root, found)
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory() -> SqliteRepository {
        SqliteRepository::in_memory().expect("in-memory repository")
    }

    fn sample(track_id: &str) -> LibraryTrack {
        LibraryTrack {
            track: Track {
                id: MediaId::new(track_id),
                source: MediaSource::Local {
                    path: "C:/music/a.mp3".into(),
                },
                title: "Track".into(),
                artists: vec!["Artist".into()],
                album: Some("Album".into()),
                album_id: Some("album-1".into()),
                artist_ids: vec!["artist-1".into()],
                artwork_hash: None,
                artwork_mime: None,
                duration_ms: Some(120_000),
            },
            path: "C:/music/a.mp3".into(),
            file_size: 1024,
            modified_unix_ms: 1_000,
            sample_rate: Some(44_100),
            channels: Some(2),
            bitrate_kbps: Some(320),
        }
    }

    #[test]
    fn upsert_and_query_track_roundtrip() {
        let repository = in_memory();
        repository.upsert_track(&sample("track-1")).unwrap();
        let page = repository.list_tracks(10, 0).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].track.id.0, "track-1");
    }

    #[test]
    fn schema_version_is_latest() {
        let repository = in_memory();
        assert_eq!(repository.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
    }
}
