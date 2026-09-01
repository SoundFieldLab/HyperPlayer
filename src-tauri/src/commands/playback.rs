use crate::{
    dto::{
        EngineSnapshotDto, PlayTrackRequestDto, RepeatModeDto, SeekRequestDto, SetVolumeRequestDto,
    },
    error::{AppResult, CommandResult},
    events,
    ports::{AppState, PlaybackMediaTarget, PlaybackPort, PlaybackTransition, TrackResolverPort},
};
use tauri::{AppHandle, Emitter, State};

fn emit(app: &AppHandle, snapshot: EngineSnapshotDto) -> CommandResult<EngineSnapshotDto> {
    app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    app.emit(events::QUEUE_CHANGED, &snapshot.queue)
        .map_err(|error| {
            crate::error::ErrorDto::from(crate::error::AppError::Window(error.to_string()))
        })?;
    Ok(snapshot)
}

#[tauri::command]
pub fn playback_get_state(state: State<'_, AppState>) -> CommandResult<EngineSnapshotDto> {
    super::command(state.services.playback.engine_snapshot())
}

#[tauri::command]
pub async fn playback_play(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Option<PlayTrackRequestDto>,
) -> CommandResult<EngineSnapshotDto> {
    let (track, context) = match request {
        Some(request) => (
            Some(super::command(
                state.services.tracks.resolve(&request.track).await,
            )?),
            request.context,
        ),
        None => {
            let snapshot = resume_resolved(
                state.services.playback.as_ref(),
                state.services.tracks.as_ref(),
            )
            .await
            .map_err(crate::error::ErrorDto::from)?;
            return emit(&app, snapshot);
        }
    };
    let snapshot = super::command(state.services.playback.play_resolved(track, context))?;
    emit(&app, snapshot)
}

pub(crate) async fn resume_resolved(
    playback: &dyn PlaybackPort,
    tracks: &dyn TrackResolverPort,
) -> AppResult<EngineSnapshotDto> {
    resolve_restored_media(playback, tracks).await?;
    playback.play_resolved(None, crate::dto::PlaybackContextDto::default())
}

async fn resolve_restored_media(
    playback: &dyn PlaybackPort,
    tracks: &dyn TrackResolverPort,
) -> AppResult<()> {
    let targets = playback.restored_media_targets()?;
    let Some((current_queue_id, current)) = targets.first() else {
        return Ok(());
    };
    let current_media = tracks.resolve(current).await?;
    let mut resolved = vec![(*current_queue_id, current_media)];
    for (queue_id, track) in targets.iter().skip(1) {
        if let Ok(media) = tracks.resolve(track).await {
            resolved.push((*queue_id, media));
        }
    }
    playback.attach_restored_media(resolved)
}

pub(crate) async fn transition_resolved(
    playback: &dyn PlaybackPort,
    tracks: &dyn TrackResolverPort,
    transition: PlaybackTransition,
) -> AppResult<EngineSnapshotDto> {
    let targets = playback.transition_media_targets(transition)?;
    let PlaybackMediaTarget {
        queue_id: target_queue_id,
        track: target,
    } = targets.first().cloned().ok_or_else(|| {
        crate::error::AppError::Unavailable("queue has no transition target".into())
    })?;
    let target_media = match tracks.resolve(&target).await {
        Ok(media) => media,
        Err(error) => {
            let _ = playback.pause();
            return Err(error);
        }
    };
    let mut resolved = vec![(target_queue_id, target_media)];
    for adjacent in targets.iter().skip(1) {
        if let Ok(media) = tracks.resolve(&adjacent.track).await {
            resolved.push((adjacent.queue_id, media));
        }
    }
    playback.attach_restored_media(resolved)?;
    let result = match transition {
        PlaybackTransition::Next { automatic } => playback.next(target_queue_id, automatic),
        PlaybackTransition::Previous => playback.previous(target_queue_id),
    };
    if result.is_err() {
        let _ = playback.pause();
    }
    result
}

#[tauri::command]
pub async fn playback_pause(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<EngineSnapshotDto> {
    emit(&app, super::command(state.services.playback.pause())?)
}

#[tauri::command]
pub fn playback_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<EngineSnapshotDto> {
    emit(&app, super::command(state.services.playback.stop())?)
}

#[tauri::command]
pub async fn playback_next(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<EngineSnapshotDto> {
    let snapshot = transition_resolved(
        state.services.playback.as_ref(),
        state.services.tracks.as_ref(),
        PlaybackTransition::Next { automatic: false },
    )
    .await
    .map_err(crate::error::ErrorDto::from)?;
    emit(&app, snapshot)
}

#[tauri::command]
pub async fn playback_previous(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<EngineSnapshotDto> {
    let snapshot = transition_resolved(
        state.services.playback.as_ref(),
        state.services.tracks.as_ref(),
        PlaybackTransition::Previous,
    )
    .await
    .map_err(crate::error::ErrorDto::from)?;
    emit(&app, snapshot)
}

#[tauri::command]
pub fn playback_seek(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SeekRequestDto,
) -> CommandResult<EngineSnapshotDto> {
    emit(
        &app,
        super::command(state.services.playback.seek(request.position_ms))?,
    )
}

#[tauri::command]
pub fn playback_set_volume(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SetVolumeRequestDto,
) -> CommandResult<EngineSnapshotDto> {
    emit(
        &app,
        super::command(state.services.playback.set_volume(request.volume))?,
    )
}

#[tauri::command]
pub fn playback_set_repeat_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: RepeatModeDto,
) -> CommandResult<EngineSnapshotDto> {
    emit(
        &app,
        super::command(state.services.playback.set_repeat_mode(mode))?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        dto::{PlaybackContextDto, PlaybackStateDto, RepeatModeDto, TrackRefDto, TrackSourceDto},
        error::{AppError, AppResult},
    };
    use hyperplayer_engine::{
        EngineEvent, EngineEventKind, MediaHandle, MediaId, MediaSource, Track,
        TrustedResolvedMedia,
    };
    use std::{
        collections::HashSet,
        fs,
        sync::{Mutex, MutexGuard},
    };

    struct MockPlayback {
        targets: Vec<(u64, TrackRefDto)>,
        transition_targets: Vec<PlaybackMediaTarget>,
        attached: Mutex<Vec<Vec<u64>>>,
        transitions: Mutex<Vec<(PlaybackTransition, u64)>>,
        pauses: Mutex<usize>,
    }

    impl PlaybackPort for MockPlayback {
        fn state(&self) -> AppResult<PlaybackStateDto> {
            unreachable!()
        }
        fn engine_snapshot(&self) -> AppResult<EngineSnapshotDto> {
            unreachable!()
        }
        fn play_resolved(
            &self,
            _media: Option<TrustedResolvedMedia>,
            _context: PlaybackContextDto,
        ) -> AppResult<EngineSnapshotDto> {
            unreachable!()
        }
        fn restored_media_targets(&self) -> AppResult<Vec<(u64, TrackRefDto)>> {
            Ok(self.targets.clone())
        }
        fn transition_media_targets(
            &self,
            _transition: PlaybackTransition,
        ) -> AppResult<Vec<PlaybackMediaTarget>> {
            Ok(self.transition_targets.clone())
        }
        fn attach_restored_media(&self, media: Vec<(u64, TrustedResolvedMedia)>) -> AppResult<()> {
            self.attached
                .lock()
                .unwrap()
                .push(media.into_iter().map(|(queue_id, _)| queue_id).collect());
            Ok(())
        }
        fn pause(&self) -> AppResult<EngineSnapshotDto> {
            *self.pauses.lock().unwrap() += 1;
            Err(AppError::Unavailable("mock pause recorded".into()))
        }
        fn stop(&self) -> AppResult<EngineSnapshotDto> {
            unreachable!()
        }
        fn next(&self, expected_queue_id: u64, automatic: bool) -> AppResult<EngineSnapshotDto> {
            self.transitions
                .lock()
                .unwrap()
                .push((PlaybackTransition::Next { automatic }, expected_queue_id));
            Err(AppError::Unavailable("mock transition recorded".into()))
        }
        fn previous(&self, expected_queue_id: u64) -> AppResult<EngineSnapshotDto> {
            self.transitions
                .lock()
                .unwrap()
                .push((PlaybackTransition::Previous, expected_queue_id));
            Err(AppError::Unavailable("mock transition recorded".into()))
        }
        fn seek(&self, _position_ms: u64) -> AppResult<EngineSnapshotDto> {
            unreachable!()
        }
        fn set_volume(&self, _volume: f32) -> AppResult<EngineSnapshotDto> {
            unreachable!()
        }
        fn set_repeat_mode(&self, _mode: RepeatModeDto) -> AppResult<EngineSnapshotDto> {
            unreachable!()
        }
        fn subscribe_events(&self) -> AppResult<std::sync::mpsc::Receiver<EngineEvent>> {
            unreachable!()
        }
        fn event_dto(
            &self,
            _event: EngineEvent,
        ) -> AppResult<(EngineEventKind, EngineSnapshotDto)> {
            unreachable!()
        }
    }

    struct MockResolver {
        failed: HashSet<String>,
        calls: Mutex<Vec<String>>,
        directory: tempfile::TempDir,
    }

    #[async_trait::async_trait]
    impl TrackResolverPort for MockResolver {
        async fn resolve(&self, track: &TrackRefDto) -> AppResult<TrustedResolvedMedia> {
            self.calls.lock().unwrap().push(track.id.clone());
            if self.failed.contains(&track.id) {
                return Err(AppError::Unavailable("mock resolution failed".into()));
            }
            let path = self.directory.path().join(format!("{}.media", track.id));
            fs::write(&path, b"resolved").unwrap();
            Ok(TrustedResolvedMedia::new(
                Track {
                    id: MediaId::new(&track.id),
                    source: MediaSource::Netease {
                        song_id: track.id.parse().unwrap(),
                    },
                    title: format!("Track {}", track.id),
                    artists: vec![],
                    album: None,
                    album_id: None,
                    artist_ids: vec![],
                    artwork_hash: None,
                    artwork_mime: None,
                    duration_ms: None,
                },
                MediaHandle::private_temporary(fs::File::open(&path).unwrap(), path),
            ))
        }
    }

    fn targets() -> Vec<(u64, TrackRefDto)> {
        vec![
            (
                7,
                TrackRefDto {
                    id: "70".into(),
                    source: TrackSourceDto::Netease,
                },
            ),
            (
                8,
                TrackRefDto {
                    id: "80".into(),
                    source: TrackSourceDto::Netease,
                },
            ),
        ]
    }

    fn transition_targets() -> Vec<PlaybackMediaTarget> {
        vec![
            PlaybackMediaTarget {
                queue_id: 8,
                track: TrackRefDto {
                    id: "80".into(),
                    source: TrackSourceDto::Netease,
                },
            },
            PlaybackMediaTarget {
                queue_id: 9,
                track: TrackRefDto {
                    id: "90".into(),
                    source: TrackSourceDto::Netease,
                },
            },
        ]
    }

    fn attached(playback: &MockPlayback) -> MutexGuard<'_, Vec<Vec<u64>>> {
        playback.attached.lock().unwrap()
    }

    #[test]
    fn shared_transition_helper_hydrates_target_and_following_before_automatic_next() {
        let playback = MockPlayback {
            targets: Vec::new(),
            transition_targets: transition_targets(),
            attached: Mutex::new(Vec::new()),
            transitions: Mutex::new(Vec::new()),
            pauses: Mutex::new(0),
        };
        let resolver = MockResolver {
            failed: HashSet::new(),
            calls: Mutex::new(Vec::new()),
            directory: tempfile::tempdir().unwrap(),
        };

        assert!(tauri::async_runtime::block_on(transition_resolved(
            &playback,
            &resolver,
            PlaybackTransition::Next { automatic: true },
        ))
        .is_err());

        assert_eq!(*resolver.calls.lock().unwrap(), ["80", "90"]);
        assert_eq!(*attached(&playback), [vec![8, 9]]);
        assert_eq!(
            *playback.transitions.lock().unwrap(),
            [(PlaybackTransition::Next { automatic: true }, 8)]
        );
    }

    #[test]
    fn shared_transition_helper_tolerates_following_failure_for_previous() {
        let playback = MockPlayback {
            targets: Vec::new(),
            transition_targets: transition_targets(),
            attached: Mutex::new(Vec::new()),
            transitions: Mutex::new(Vec::new()),
            pauses: Mutex::new(0),
        };
        let resolver = MockResolver {
            failed: HashSet::from(["90".into()]),
            calls: Mutex::new(Vec::new()),
            directory: tempfile::tempdir().unwrap(),
        };

        assert!(tauri::async_runtime::block_on(transition_resolved(
            &playback,
            &resolver,
            PlaybackTransition::Previous,
        ))
        .is_err());

        assert_eq!(*attached(&playback), [vec![8]]);
        assert_eq!(
            *playback.transitions.lock().unwrap(),
            [(PlaybackTransition::Previous, 8)]
        );
    }

    #[test]
    fn shared_transition_helper_pauses_without_mutation_when_target_resolution_fails() {
        let playback = MockPlayback {
            targets: Vec::new(),
            transition_targets: transition_targets(),
            attached: Mutex::new(Vec::new()),
            transitions: Mutex::new(Vec::new()),
            pauses: Mutex::new(0),
        };
        let resolver = MockResolver {
            failed: HashSet::from(["80".into()]),
            calls: Mutex::new(Vec::new()),
            directory: tempfile::tempdir().unwrap(),
        };

        assert!(tauri::async_runtime::block_on(transition_resolved(
            &playback,
            &resolver,
            PlaybackTransition::Next { automatic: false },
        ))
        .is_err());

        assert!(attached(&playback).is_empty());
        assert!(playback.transitions.lock().unwrap().is_empty());
        assert_eq!(*playback.pauses.lock().unwrap(), 1);
    }

    #[test]
    fn restored_remote_current_and_adjacent_are_resolved_and_attached() {
        let playback = MockPlayback {
            targets: targets(),
            transition_targets: Vec::new(),
            attached: Mutex::new(Vec::new()),
            transitions: Mutex::new(Vec::new()),
            pauses: Mutex::new(0),
        };
        let resolver = MockResolver {
            failed: HashSet::new(),
            calls: Mutex::new(Vec::new()),
            directory: tempfile::tempdir().unwrap(),
        };

        tauri::async_runtime::block_on(resolve_restored_media(&playback, &resolver)).unwrap();

        assert_eq!(*resolver.calls.lock().unwrap(), ["70", "80"]);
        assert_eq!(*attached(&playback), [vec![7, 8]]);
    }

    #[test]
    fn restored_remote_adjacent_failure_still_attaches_current() {
        let playback = MockPlayback {
            targets: targets(),
            transition_targets: Vec::new(),
            attached: Mutex::new(Vec::new()),
            transitions: Mutex::new(Vec::new()),
            pauses: Mutex::new(0),
        };
        let resolver = MockResolver {
            failed: HashSet::from(["80".into()]),
            calls: Mutex::new(Vec::new()),
            directory: tempfile::tempdir().unwrap(),
        };

        tauri::async_runtime::block_on(resolve_restored_media(&playback, &resolver)).unwrap();

        assert_eq!(*resolver.calls.lock().unwrap(), ["70", "80"]);
        assert_eq!(*attached(&playback), [vec![7]]);
    }

    #[test]
    fn restored_remote_current_failure_attaches_nothing() {
        let playback = MockPlayback {
            targets: targets(),
            transition_targets: Vec::new(),
            attached: Mutex::new(Vec::new()),
            transitions: Mutex::new(Vec::new()),
            pauses: Mutex::new(0),
        };
        let resolver = MockResolver {
            failed: HashSet::from(["70".into()]),
            calls: Mutex::new(Vec::new()),
            directory: tempfile::tempdir().unwrap(),
        };

        assert!(
            tauri::async_runtime::block_on(resolve_restored_media(&playback, &resolver)).is_err()
        );

        assert_eq!(*resolver.calls.lock().unwrap(), ["70"]);
        assert!(attached(&playback).is_empty());
    }
}
