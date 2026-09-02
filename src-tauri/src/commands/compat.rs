use crate::{
    dto::{
        BackgroundTaskDto, FrontendDspDto, FrontendPlaybackDto, FrontendSettingsDto,
        FrontendSettingsPatchDto, FrontendTrackDto, LibrarySummaryDto, PlaybackStatusDto,
        RepeatModeDto, ThemeDto, TrackDto, TrackSourceDto, UpdateSettingsRequestDto,
    },
    error::{AppError, CommandResult},
    ports::AppState,
};
use tauri::{State, WebviewWindow};

#[tauri::command]
pub fn get_playback(state: State<'_, AppState>) -> CommandResult<FrontendPlaybackDto> {
    let playback = super::command(state.services.playback.state())?;
    let engine = super::command(state.services.playback.engine_snapshot())?;
    let queue = super::command(state.services.queue.snapshot())?;
    let current = playback.current_track.as_ref().map(frontend_track);
    let next_up = queue
        .play_next
        .iter()
        .map(|item| frontend_track(&item.track))
        .collect();
    let queue = queue
        .context
        .iter()
        .map(|item| frontend_track(&item.track))
        .collect();
    Ok(FrontendPlaybackDto {
        current,
        status: match playback.status {
            PlaybackStatusDto::Playing => "playing",
            PlaybackStatusDto::Paused | PlaybackStatusDto::Stopped => "paused",
            PlaybackStatusDto::Buffering => "buffering",
            PlaybackStatusDto::Error => "unavailable",
        }
        .into(),
        position_ms: playback.position_ms,
        volume: playback.volume,
        queue,
        next_up,
        repeat: match playback.repeat_mode {
            RepeatModeDto::Sequential => "sequence",
            RepeatModeDto::RepeatAll => "all",
            RepeatModeDto::RepeatOne => "one",
            RepeatModeDto::Shuffle => "shuffle",
        }
        .into(),
        dsp: FrontendDspDto {
            available: true,
            bypassed: engine.dsp_execution.revision == 0 || engine.dsp_execution.safe_bypass_active,
            label: "Rust DSP runtime 与参数桥已接通；当前支持 14 阶段实时处理".into(),
        },
    })
}

#[tauri::command]
pub fn set_playback(state: State<'_, AppState>, playing: bool) -> CommandResult<()> {
    let result = if playing {
        state
            .services
            .playback
            .play_resolved(None, crate::dto::PlaybackContextDto::default())
    } else {
        state.services.playback.pause()
    };
    super::command(result).map(|_| ())
}

#[tauri::command]
pub fn seek(state: State<'_, AppState>, position_ms: u64) -> CommandResult<()> {
    super::command(state.services.playback.seek(position_ms)).map(|_| ())
}

#[tauri::command]
pub fn set_volume(state: State<'_, AppState>, volume: f32) -> CommandResult<()> {
    super::command(state.services.playback.set_volume(volume)).map(|_| ())
}

#[tauri::command]
pub fn get_library_summary(state: State<'_, AppState>) -> CommandResult<LibrarySummaryDto> {
    let overview = super::command(state.services.library.overview())?;
    Ok(LibrarySummaryDto {
        tracks: overview.track_count,
        albums: overview.album_count,
        artists: overview.artist_count,
        folders: Vec::new(),
        last_scanned_at: None,
    })
}

#[tauri::command]
pub fn get_tasks() -> Vec<BackgroundTaskDto> {
    Vec::new()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CommandResult<FrontendSettingsDto> {
    super::command(state.services.settings.get()).map(frontend_settings)
}

#[tauri::command]
pub fn update_settings(
    window: WebviewWindow,
    state: State<'_, AppState>,
    patch: FrontendSettingsPatchDto,
) -> CommandResult<FrontendSettingsDto> {
    if window.label() != "main" {
        return Err(
            AppError::Unavailable("command is restricted to the main window".into()).into(),
        );
    }
    let theme = patch
        .theme
        .map(|theme| match theme.as_str() {
            "light" => Ok(ThemeDto::Light),
            "dark" => Ok(ThemeDto::Dark),
            "system" => Ok(ThemeDto::System),
            _ => Err(AppError::InvalidArgument("unsupported theme".into())),
        })
        .transpose()
        .map_err(crate::error::ErrorDto::from)?;
    super::command(state.services.settings.update(UpdateSettingsRequestDto {
        theme,
        dynamic_color: patch.dynamic_color,
        reduce_motion: patch.reduce_motion,
        reduce_transparency: patch.reduce_transparency,
        restore_queue: patch.restore_queue,
        autoplay_on_start: patch.auto_play_on_launch,
        close_behavior: None,
        netease_enabled: patch.netease_enabled,
    }))
    .map(frontend_settings)
}

fn frontend_track(track: &TrackDto) -> FrontendTrackDto {
    FrontendTrackDto {
        id: track.track_ref.id.clone(),
        title: track.title.clone(),
        artists: track.artists.clone(),
        album: track.album.clone().unwrap_or_default(),
        duration_ms: track.duration_ms.unwrap_or_default(),
        source: match track.track_ref.source {
            TrackSourceDto::Local => "local",
            TrackSourceDto::Netease => "netease",
        }
        .into(),
        entitlement: "unavailable".into(),
        quality: track.quality_label.clone().unwrap_or_else(|| "标准".into()),
        cache: "none".into(),
        cover_seed: String::new(),
    }
}

fn frontend_settings(settings: crate::dto::SettingsDto) -> FrontendSettingsDto {
    FrontendSettingsDto {
        theme: match settings.theme {
            ThemeDto::Light => "light",
            ThemeDto::Dark => "dark",
            ThemeDto::System => "system",
        }
        .into(),
        material: "clean".into(),
        dynamic_color: settings.dynamic_color,
        reduce_motion: settings.reduce_motion,
        reduce_transparency: settings.reduce_transparency,
        restore_queue: settings.restore_queue,
        auto_play_on_launch: settings.autoplay_on_start,
        netease_enabled: settings.netease_enabled,
    }
}
