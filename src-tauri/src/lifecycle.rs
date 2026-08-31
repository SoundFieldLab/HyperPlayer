use crate::{
    dto::{CloseBehaviorDto, CloseRequestedDto, PlaybackStatusDto},
    events,
    ports::AppState,
};
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, Runtime, WindowEvent,
};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    install_tray(app)?;
    install_main_window_close_handler(app);
    install_progress_forwarder(app)?;
    Ok(())
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
            while let Ok(mut event) = receiver.recv() {
                if event.kind == hyperplayer_engine::EngineEventKind::Progress {
                    let wait = next_emit.saturating_duration_since(Instant::now());
                    if !wait.is_zero() {
                        std::thread::sleep(wait);
                    }
                    while let Ok(newer) = receiver.try_recv() {
                        event = newer;
                        if event.kind == hyperplayer_engine::EngineEventKind::StateChanged {
                            break;
                        }
                    }
                }
                let state = app.state::<AppState>();
                let Ok((kind, snapshot)) = state.services.playback.event_dto(event) else {
                    break;
                };
                match kind {
                    hyperplayer_engine::EngineEventKind::Progress => {
                        let progress = crate::dto::PlaybackProgressDto {
                            position_ms: snapshot.playback.position_ms,
                            duration_ms: snapshot.playback.duration_ms,
                        };
                        if app.emit(events::PLAYBACK_PROGRESS, progress).is_err() {
                            break;
                        }
                        next_emit = Instant::now() + PROGRESS_INTERVAL;
                    }
                    hyperplayer_engine::EngineEventKind::StateChanged => {
                        if app
                            .emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot)
                            .and_then(|_| {
                                app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback)
                            })
                            .and_then(|_| app.emit(events::QUEUE_CHANGED, &snapshot.queue))
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

fn tray_play_pause<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let result = state.services.playback.state().and_then(|playback| {
        if playback.status == PlaybackStatusDto::Playing {
            state.services.playback.pause()
        } else {
            state
                .services
                .playback
                .play_resolved(None, crate::dto::PlaybackContextDto::default())
        }
    });
    if let Ok(snapshot) = result {
        let _ = app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot);
        let _ = app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback);
        let _ = app.emit(events::QUEUE_CHANGED, &snapshot.queue);
    }
}

fn tray_previous<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    if let Ok(snapshot) = state.services.playback.previous() {
        let _ = app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot);
        let _ = app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback);
        let _ = app.emit(events::QUEUE_CHANGED, &snapshot.queue);
    }
}

fn tray_next<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    if let Ok(snapshot) = state.services.playback.next() {
        let _ = app.emit(events::ENGINE_SNAPSHOT_CHANGED, &snapshot);
        let _ = app.emit(events::PLAYBACK_STATE_CHANGED, &snapshot.playback);
        let _ = app.emit(events::QUEUE_CHANGED, &snapshot.queue);
    }
}
