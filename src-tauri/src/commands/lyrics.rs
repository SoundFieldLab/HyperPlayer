use crate::{
    adapters::SettingsAdapter,
    dto::{
        LyricLineDto, LyricWordDto, LyricsDocumentDto, LyricsGetRequestDto, LyricsPayloadDto,
        TrackRefDto, TrackSourceDto,
    },
    error::{AppError, AppResult, CommandResult},
    ports::{validate_track_ref, AppState, LyricsPort, SettingsPort},
};
use hyperplayer_engine::lyrics::{
    load_local_lyrics, parse_lyrics_bundle, LyricsBundle, LyricsDocument, LyricsSource,
};
use hyperplayer_engine::model::MediaId;
use hyperplayer_source_netease::{
    Lyrics, NeteaseService, ProductionConfig, ReqwestTransport, Session,
};
use rand::rngs::OsRng;
use std::sync::Arc;
use tauri::State;

pub struct NeteaseLyricsAdapter {
    service: Option<NeteaseService<ReqwestTransport>>,
    settings: Arc<SettingsAdapter>,
    repository: Arc<std::sync::Mutex<hyperplayer_engine::repository::SqliteRepository>>,
}

impl NeteaseLyricsAdapter {
    pub fn new(
        settings: Arc<SettingsAdapter>,
        repository: Arc<std::sync::Mutex<hyperplayer_engine::repository::SqliteRepository>>,
    ) -> Self {
        let service = {
            let mut rng = OsRng;
            NeteaseService::production(ProductionConfig::default(), Session::new(&mut rng)).ok()
        };
        Self {
            service,
            settings,
            repository,
        }
    }

    #[cfg(test)]
    pub fn disabled(settings: Arc<SettingsAdapter>) -> Self {
        Self {
            service: None,
            settings,
            repository: Arc::new(std::sync::Mutex::new(
                hyperplayer_engine::repository::SqliteRepository::in_memory()
                    .expect("lyrics repository"),
            )),
        }
    }

    fn require_service(&self) -> AppResult<&NeteaseService<ReqwestTransport>> {
        if !self.settings.get()?.netease_enabled {
            return Err(AppError::Unavailable("NetEase source is disabled".into()));
        }
        self.service
            .as_ref()
            .ok_or_else(|| AppError::Unavailable("NetEase lyrics service is not configured".into()))
    }
}

#[async_trait::async_trait]
impl LyricsPort for NeteaseLyricsAdapter {
    async fn get(&self, track: &TrackRefDto) -> AppResult<LyricsPayloadDto> {
        validate_track_ref(track)?;
        if track.source == TrackSourceDto::Local {
            let (path, library_root) = self
                .repository
                .lock()
                .map_err(|_| AppError::StateUnavailable)?
                .media_path_with_root(&MediaId::new(&track.id))?
                .ok_or_else(|| AppError::Unavailable("local track is not in the library".into()))?;
            let embedded = match hyperplayer_engine::library::read_embedded_lyrics(&path) {
                Ok(lyrics) => lyrics,
                Err(hyperplayer_engine::EngineError::InvalidInput(message)) => {
                    return Err(AppError::InvalidArgument(message));
                }
                Err(_) => None,
            };
            let local =
                load_local_lyrics(&path, &library_root, embedded.as_deref()).map_err(|error| {
                    AppError::Unavailable(format!("local lyrics could not be read: {error}"))
                })?;
            local.document.validate().map_err(|error| {
                AppError::Unavailable(format!("invalid local lyrics timeline: {error:?}"))
            })?;
            return Ok(LyricsPayloadDto {
                document: document_dto(local.document),
                raw_original: String::new(),
                raw_translation: String::new(),
                raw_romanization: String::new(),
                raw_word_synced: String::new(),
                raw_word_synced_translation: String::new(),
                raw_ttml: String::new(),
            });
        }
        if track.source != TrackSourceDto::Netease {
            return Err(AppError::Unavailable(
                "local lyrics loading is not connected to the engine yet".into(),
            ));
        }
        let id = track.id.parse::<u64>().map_err(|_| {
            AppError::InvalidArgument("track.id must be a NetEase numeric id".into())
        })?;
        let lyrics = self.require_service()?.lyrics(id).await?;
        map_lyrics(lyrics)
    }
}

#[tauri::command]
pub async fn lyrics_get(
    state: State<'_, AppState>,
    request: LyricsGetRequestDto,
) -> CommandResult<LyricsPayloadDto> {
    super::command(state.services.lyrics.get(&request.track).await)
}

fn map_lyrics(raw: Lyrics) -> AppResult<LyricsPayloadDto> {
    let document = parse_lyrics_bundle(&LyricsBundle {
        original: &raw.original,
        translation: &raw.translation,
        romanization: &raw.romanization,
        word_synced: &raw.word_synced,
        word_synced_translation: &raw.word_synced_translation,
        ttml: &raw.ttml,
    });
    document
        .validate()
        .map_err(|error| AppError::Unavailable(format!("invalid lyrics timeline: {error:?}")))?;

    Ok(LyricsPayloadDto {
        document: document_dto(document),
        raw_original: raw.original,
        raw_translation: raw.translation,
        raw_romanization: raw.romanization,
        raw_word_synced: raw.word_synced,
        raw_word_synced_translation: raw.word_synced_translation,
        raw_ttml: raw.ttml,
    })
}

fn document_dto(document: LyricsDocument) -> LyricsDocumentDto {
    LyricsDocumentDto {
        source: match document.source {
            LyricsSource::Unknown => "unknown",
            LyricsSource::Lrc => "lrc",
            LyricsSource::Yrc => "yrc",
            LyricsSource::Ttml => "ttml",
            LyricsSource::Embedded => "embedded",
        }
        .into(),
        title: document.metadata.title,
        artists: document.metadata.artists,
        album: document.metadata.album,
        language: document.metadata.language,
        offset_ms: document.metadata.offset_ms,
        lines: document
            .lines
            .into_iter()
            .map(|line| LyricLineDto {
                start_ms: line.start_ms,
                end_ms: line.end_ms,
                text: line.text,
                translation: line.translation,
                romanization: line.romanization,
                words: line
                    .words
                    .into_iter()
                    .map(|word| LyricWordDto {
                        start_ms: word.start_ms,
                        end_ms: word.end_ms,
                        text: word.text,
                    })
                    .collect(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_lrc_to_valid_engine_timeline() {
        let payload = map_lyrics(Lyrics {
            original: "[00:01.25]first\n[00:03.000]second".into(),
            translation: "[00:01.25]第一行".into(),
            romanization: "[00:01.25]di yi hang".into(),
            word_synced: String::new(),
            word_synced_translation: "[1250,500](1250,500,0)第一行".into(),
            ttml: String::new(),
        })
        .unwrap();
        assert_eq!(payload.document.source, "lrc");
        assert_eq!(payload.document.lines[0].start_ms, 1_250);
        assert_eq!(payload.document.lines[0].end_ms, Some(3_000));
        assert_eq!(
            payload.document.lines[0].translation.as_deref(),
            Some("第一行")
        );
        assert_eq!(
            payload.document.lines[0].romanization.as_deref(),
            Some("di yi hang")
        );
        assert!(!payload.raw_word_synced_translation.is_empty());
    }

    #[test]
    fn parses_ttml_when_other_formats_are_empty() {
        let payload = map_lyrics(Lyrics {
            original: String::new(),
            translation: String::new(),
            romanization: String::new(),
            word_synced: String::new(),
            word_synced_translation: String::new(),
            ttml: r#"<tt><body><p begin="1s" end="2s"><span begin="1s" end="2s">line</span></p></body></tt>"#.into(),
        })
        .unwrap();
        assert_eq!(payload.document.source, "ttml");
        assert_eq!(payload.document.lines[0].text, "line");
        assert_eq!(payload.document.lines[0].end_ms, Some(2_000));
    }

    #[test]
    fn malformed_preferred_formats_fall_through_to_parseable_ttml() {
        let payload = map_lyrics(Lyrics {
            original: "not lrc".into(),
            translation: String::new(),
            romanization: String::new(),
            word_synced: "not yrc".into(),
            word_synced_translation: String::new(),
            ttml: r#"<tt><body><p begin="1s" dur="1s">fallback</p></body></tt>"#.into(),
        })
        .unwrap();
        assert_eq!(payload.document.source, "ttml");
        assert_eq!(payload.document.lines[0].text, "fallback");
    }

    #[test]
    fn maps_yrc_line_and_word_timing() {
        let payload = map_lyrics(Lyrics {
            original: String::new(),
            translation: String::new(),
            romanization: String::new(),
            word_synced: "[1000,2000](1000,500,0)hello (1500,500,0)world".into(),
            word_synced_translation: String::new(),
            ttml: String::new(),
        })
        .unwrap();
        assert_eq!(payload.document.source, "yrc");
        assert_eq!(payload.document.lines[0].end_ms, Some(3_000));
        assert_eq!(payload.document.lines[0].words.len(), 2);
        assert_eq!(payload.document.lines[0].words[1].start_ms, 1_500);
    }

    #[test]
    fn local_sidecar_lyrics_load_only_through_registered_library_id() {
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("song.wav");
        std::fs::write(&audio, b"RIFF").unwrap();
        std::fs::write(root.path().join("song.lrc"), "[00:01.00]local line").unwrap();
        let repository = Arc::new(std::sync::Mutex::new(
            hyperplayer_engine::repository::SqliteRepository::in_memory().unwrap(),
        ));
        {
            let repo = repository.lock().unwrap();
            repo.register_library_root(root.path()).unwrap();
            repo.upsert_track(&hyperplayer_engine::repository::LibraryTrack {
                track: hyperplayer_engine::Track {
                    id: MediaId::new("local:test"),
                    source: hyperplayer_engine::MediaSource::Local {
                        path: audio.clone(),
                    },
                    title: "Song".into(),
                    artists: vec![],
                    album: None,
                    album_id: None,
                    artist_ids: vec![],
                    artwork_hash: None,
                    artwork_mime: None,
                    duration_ms: Some(1_000),
                },
                path: audio.clone(),
                file_size: 4,
                modified_unix_ms: 0,
                sample_rate: None,
                channels: None,
                bitrate_kbps: None,
            })
            .unwrap();
        }
        let adapter = NeteaseLyricsAdapter::new(Arc::new(SettingsAdapter::new()), repository);
        let payload = tauri::async_runtime::block_on(adapter.get(&TrackRefDto {
            id: "local:test".into(),
            source: TrackSourceDto::Local,
        }))
        .unwrap();
        assert_eq!(payload.document.source, "lrc");
        assert_eq!(payload.document.lines[0].text, "local line");
        assert!(tauri::async_runtime::block_on(adapter.get(&TrackRefDto {
            id: audio.to_string_lossy().into_owned(),
            source: TrackSourceDto::Local,
        }))
        .is_err());
    }

    #[test]
    fn rejects_non_numeric_netease_ids_before_network_access() {
        let settings = Arc::new(SettingsAdapter::new());
        let adapter = NeteaseLyricsAdapter::disabled(settings);
        let result = tauri::async_runtime::block_on(adapter.get(&TrackRefDto {
            id: "not-a-number".into(),
            source: TrackSourceDto::Netease,
        }));
        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }
}
