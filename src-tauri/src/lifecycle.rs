use crate::{
    dto::{CloseBehaviorDto, CloseRequestedDto},
    events,
    ports::AppState,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, Runtime, WindowEvent,
};



pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    install_tray(app)?;
    install_main_window_close_handler(app);
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
    // D35：播放状态由 WebView 前端播放服务持有，Rust 窗口层不再询问播放服务；
    // is_playing 由前端在收到事件后自行判断，此处仅保留字段以维持 DTO 结构。
    let _ = app.emit(
        events::CLOSE_REQUESTED,
        CloseRequestedDto {
            is_playing: false,
            has_background_tasks: state.services.library.has_active_tasks(),
        },
    );
}

// D35 Q13：Rust 是纯转发桥——托盘媒体键与 SMTC 共用同一通道，
// 播放语义由 WebView 前端播放服务统一执行。
fn tray_play_pause<R: Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit(
        events::MEDIA_KEY_PRESSED,
        serde_json::json!({ "button": "play-pause" }),
    );
}

fn tray_previous<R: Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit(
        events::MEDIA_KEY_PRESSED,
        serde_json::json!({ "button": "previous" }),
    );
}

fn tray_next<R: Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit(
        events::MEDIA_KEY_PRESSED,
        serde_json::json!({ "button": "next" }),
    );
}