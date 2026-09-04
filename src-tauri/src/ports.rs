use crate::{
    adapters::{LibraryAdapter, LocationRegistry, SettingsAdapter},
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
}

pub struct AppServices {
    pub library: Arc<dyn LibraryPort>,
    pub settings: Arc<dyn SettingsPort>,
}

impl AppServices {
    /// 启动装配：本地曲库（SQLite repository + 位置注册 + 扫描/封面适配器）与设置。
    /// 播放/DSP/网易云/缓存/遥测/歌词已迁入 WebView 前端（TypeScript），不再在此构造；
    /// 网易云凭据保险库将在接线阶段经 command 暴露，此处不建立实例。
    pub fn new(app_data_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(app_data_dir)?;
        let repository = Arc::new(Mutex::new(
            hyperplayer_engine::repository::SqliteRepository::open(
                app_data_dir.join("hyperplayer.sqlite3"),
            )?,
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
        let artwork_root = app_data_dir.join("artwork");
        let settings = Arc::new(SettingsAdapter::open(app_data_dir.join("settings.json"))?);
        let library = Arc::new(LibraryAdapter::new(
            repository.clone(),
            locations,
            artwork_root,
        )?);
        Ok(Self { library, settings })
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        let repository = Arc::new(Mutex::new(
            hyperplayer_engine::repository::SqliteRepository::in_memory()?,
        ));
        let locations = Arc::new(LocationRegistry::in_memory()?);
        let artwork_root = std::env::temp_dir().join(format!(
            "hyperplayer-test-artwork-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let settings = Arc::new(SettingsAdapter::new());
        let library = Arc::new(LibraryAdapter::new(
            repository.clone(),
            locations,
            artwork_root,
        )?);
        Ok(Self { library, settings })
    }
}

pub struct AppState {
    pub services: AppServices,
    pub exit_requested: Mutex<bool>,
    location_tickets: Mutex<HashMap<String, LocationTicket>>,
}

struct LocationTicket {
    path: PathBuf,
    window_label: String,
    expires_at: Instant,
}

impl AppState {
    pub fn new(app_data_dir: &Path) -> AppResult<Self> {
        Ok(Self {
            services: AppServices::new(app_data_dir)?,
            exit_requested: Mutex::new(false),
            location_tickets: Mutex::new(HashMap::new()),
        })
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
            exit_requested: Mutex::new(false),
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
}