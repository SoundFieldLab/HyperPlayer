use crate::{
    dto::{CloseBehaviorDto, CloseRequestedDto, PlaybackStatusDto},
    events,
    ports::{AppState, PlaybackTransition},
};
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, Runtime, WindowEvent,
};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub fn handle_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        if let Some(state) = window.try_state::<AppState>() {
            state
                .telemetry_sessions
                .close_window_sessions(window.label());
        }
    }
}

pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    install_tray(app)?;
    install_main_window_close_handler(app);
    install_progress_forwarder(app)?;
    install_cache_runtime(app);
    Ok(())
}

fn install_cache_runtime<R: Runtime>(app: &tauri::AppHandle<R>) {
    // Start the single-instance cache reconciliation supervisor. It runs once at
    // startup and is cancelled on exit via `shutdown_services` / close handling.
    let state = app.state::<AppState>();
    if let Err(error) = state.services.cache_runtime.clone().start() {
        log_or_eprintln(&format!("failed to start cache runtime: {error}"));
    }
}

fn log_or_eprintln(message: &str) {
    eprintln!("{message}");
}

fn install_progress_forwarder<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let receiver = state
        .services
        .playback
        .subscribe_events()
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error.to_string())))?;
    let app = app.clone();
    std::thread::Builder::new()
        .name("hyperplayer-progress-forwarder".into())
        .spawn(move || {
            let mut next_emit = Instant::now();
            while let Ok(event) = receiver.recv() {
                if event.kind == hyperplayer_engine::EngineEventKind::Progress
                    && Instant::now() < next_emit
                {
                    continue;
                }
                if event.kind == hyperplayer_engine::EngineEventKind::AutomaticTransitionRequested {
                    let state = app.state::<AppState>();
                    let result = tauri::async_runtime::block_on(
                        crate::commands::playback::transition_resolved(
                            state.services.playback.as_ref(),
                            state.services.tracks.as_ref(),
                            PlaybackTransition::Next { automatic: true },
                        ),
                    );
                    match result {
                        Ok(snapshot) => {
                            let _ = emit_engine_snapshot(&app, &snapshot);
                        }
                        Err(_) => {
                            if let Ok((_, snapshot)) = state.services.playback.event_dto(event) {
                                let _ = emit_engine_snapshot(&app, &snapshot);
                            }
                        }
                    }
                    continue;
                }
                let state = app.state::<AppState>();
                let Ok((kind, snapshot)) = state.services.playback.event_dto(event) else {
                    break;
                };
                match kind {
                    hyperplayer_engine::EngineEventKind::Progress => {
                        let progress = crate::dto::PlaybackProgressDto {
                            revision: snapshot.revision,
                            position_ms: snapshot.playback.position_ms,
                            duration_ms: snapshot.playback.duration_ms,
                        };
                        if app.emit(events::PLAYBACK_PROGRESS, progress).is_err() {
                            break;
                        }
                        next_emit = Instant::now() + PROGRESS_INTERVAL;
                    }
                    hyperplayer_engine::EngineEventKind::StateChanged => {
                        if emit_engine_snapshot(&app, &snapshot).is_err() {
                            break;
                        }
                    }
                    hyperplayer_engine::EngineEventKind::DspExecutionChanged => {
                        if let Ok(mut dsp) = state.dsp.lock() {
                            dsp.promote(snapshot.dsp_execution.revision);
                        }
                        if emit_engine_snapshot(&app, &snapshot).is_err() {
                            break;
                        }
                    }
                    hyperplayer_engine::EngineEventKind::AutomaticTransitionRequested => {
                        unreachable!("automatic transitions are handled before event conversion")
                    }
                    hyperplayer_engine::EngineEventKind::DspConfigurationRejected {
                        revision,
                        code,
                        reason,
                        stage,
                    } => {
                        if let Ok(mut dsp) = state.dsp.lock() {
                            dsp.reject(revision);
                        }
                        if app
                            .emit(
                                events::DSP_CONFIGURATION_REJECTED,
                                crate::dto::DspConfigurationRejectedDto {
                                    revision,
                                    code: match code {
                                        hyperplayer_engine::actor::DspConfigurationRejectionCode::ValidationFailed => "validationFailed",
                                        hyperplayer_engine::actor::DspConfigurationRejectionCode::CompilationFailed => "compilationFailed",
                                        hyperplayer_engine::actor::DspConfigurationRejectionCode::ApplyFailed => "applyFailed",
                                    }
                                    .into(),
                                    reason: reason.into(),
                                    stage: stage.map(str::to_owned),
                                },
                            )
                            .is_err()
                        {
                            break;
                        }
                    }
                    hyperplayer_engine::EngineEventKind::DspProcessingFault {
                        revision,
                        processor_index,
                        processor_name,
                        kind,
                        stream_frame,
                        safe_bypass_active,
                        fallback_status,
                    } => {
                        if app
                            .emit(
                                events::DSP_PROCESSING_FAULT,
                                crate::dto::DspProcessingFaultDto {
                                    revision,
                                    processor_index,
                                    processor_name: processor_name.into(),
                                    kind: match kind {
                                        hyperplayer_engine::dsp::ProcessorFaultKind::ProcessingFailed => "processingFailed",
                                        hyperplayer_engine::dsp::ProcessorFaultKind::NonFiniteOutput => "nonFiniteOutput",
                                    }
                                    .into(),
                                    stream_frame,
                                    safe_bypass_active,
                                    fallback_status: match fallback_status {
                                        hyperplayer_engine::actor::DspFallbackStatus::RustSafeBypass => {
                                            crate::dto::DspFallbackStatusDto::RustSafeBypass
                                        }
                                    },
                                },
                            )
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        })?;
    Ok(())
}

fn install_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 HyperPlayer", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, "previous", "上一首", true, None::<&str>)?;
    let play_pause = MenuItem::with_id(app, "play-pause", "播放 / 暂停", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &previous, &play_pause, &next, &quit])?;

    let mut builder = TrayIconBuilder::with_id("hyperplayer-tray")
        .tooltip("HyperPlayer")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "previous" => tray_previous(app),
            "play-pause" => tray_play_pause(app),
            "next" => tray_next(app),
            "quit" => request_exit(app),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn install_main_window_close_handler<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let state = app_handle.state::<AppState>();
            let exit_requested = state
                .exit_requested
                .lock()
                .map(|value| *value)
                .unwrap_or(false);
            if exit_requested {
                return;
            }
            api.prevent_close();
            match state
                .services
                .settings
                .get()
                .map(|settings| settings.close_behavior)
            {
                Ok(CloseBehaviorDto::Exit) => request_exit(&app_handle),
                Ok(CloseBehaviorDto::MinimizeToTray) => hide_main_window(&app_handle),
                _ => emit_close_requested(&app_handle),
            }
        }
    });
}

fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn request_exit<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    if let Ok(mut exit_requested) = state.exit_requested.lock() {
        *exit_requested = true;
    }
    // Cancel the cache reconciliation supervisor so its worker is joined before the
    // runtime drops. Best-effort; a busy sync run is allowed to finish quickly.
    state.services.cache_runtime.shutdown();
    app.exit(0);
}

fn emit_close_requested<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let is_playing = state
        .services
        .playback
        .state()
        .map(|playback| playback.status == PlaybackStatusDto::Playing)
        .unwrap_or(false);
    let _ = app.emit(
        events::CLOSE_REQUESTED,
        CloseRequestedDto {
            is_playing,
            has_background_tasks: state.services.library.has_active_tasks(),
        },
    );
}

fn emit_engine_snapshot<R: Runtime>(
    app: &tauri::AppHandle<R>,
    snapshot: &crate::dto::EngineSnapshotDto,
) -> tauri::Result<()> {
    app.emit(events::ENGINE_SNAPSHOT_CHANGED, snapshot)?;
    app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback)?;
    app.emit(events::QUEUE_CHANGED, &snapshot.queue)
}

fn tray_play_pause<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let result = state.services.playback.state().and_then(|playback| {
        if playback.status == PlaybackStatusDto::Playing {
            state.services.playback.pause()
        } else {
            tauri::async_runtime::block_on(crate::commands::playback::resume_resolved(
                state.services.playback.as_ref(),
                state.services.tracks.as_ref(),
            ))
        }
    });
    if let Ok(snapshot) = result {
        let _ = emit_engine_snapshot(app, &snapshot);
    }
}

fn tray_previous<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let result = tauri::async_runtime::block_on(crate::commands::playback::transition_resolved(
        state.services.playback.as_ref(),
        state.services.tracks.as_ref(),
        PlaybackTransition::Previous,
    ));
    if let Ok(snapshot) = result {
        let _ = emit_engine_snapshot(app, &snapshot);
    }
}

fn tray_next<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let result = tauri::async_runtime::block_on(crate::commands::playback::transition_resolved(
        state.services.playback.as_ref(),
        state.services.tracks.as_ref(),
        PlaybackTransition::Next { automatic: false },
    ));
    if let Ok(snapshot) = result {
        let _ = emit_engine_snapshot(app, &snapshot);
    }
}
