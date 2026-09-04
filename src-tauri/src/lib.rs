mod adapters;
pub mod app_log;
mod commands;
mod credential_vault;
pub mod dto;
pub mod error;
pub mod events;
mod lifecycle;
mod netease_sidecar;
mod platform;
pub mod ports;

use commands::{bootstrap, credential, library, logging, settings, updater, window};
use ports::AppState;
use tauri::Manager;

pub fn run() {
    // 日志系统最先启动（后续任何 panic/命令错误都能落盘）；初始化失败仅退化
    // 为 stderr，不阻止应用启动。panic hook 记录后转默认行为。
    app_log::init();
    app_log::install_panic_hook();
    let updater_config = updater::UpdaterConfig::from_env();
    let mut builder = tauri::Builder::default();
    if let Some(public_key) = updater_config.public_key() {
        builder = builder.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(public_key)
                .build(),
        );
    }

    builder = builder.plugin(tauri_plugin_dialog::init());
    builder = builder.plugin(tauri_plugin_http::init());

    builder
        .invoke_handler(tauri::generate_handler![
            bootstrap::bootstrap,
            library::library_overview,
            library::library_query_tracks,
            library::library_query_albums,
            library::library_query_artists,
            library::library_query_folders,
            library::library_query_recent,
            library::library_query_playlists,
            library::library_create_playlist,
            library::library_rename_playlist,
            library::library_delete_playlist,
            library::library_add_playlist_track,
            library::library_remove_playlist_track,
            library::library_reorder_playlist_track,
            library::library_album_tracks,
            library::library_artist_tracks,
            library::library_folder_tracks,
            library::library_playlist_tracks,
            library::library_artwork,
            library::library_reread_tags,
            library::library_remove_from_library,
            library::library_move_to_recycle_bin,
            library::library_pick_location,
            library::library_register_location,
            library::library_start_scan,
            library::library_cancel_scan,
            settings::settings_get,
            settings::settings_update,
            credential::credential_get,
            credential::credential_set,
            window::window_show,
            window::window_close,
            window::window_hide,
            window::window_set_always_on_top,
            window::desktop_lyrics_set_click_through,
            window::window_resolve_close,
            platform::windows::windows_integration_status,
            platform::windows::windows_enable_media_controls,
            platform::windows::windows_register_file_associations,
            platform::windows::smtc_update_metadata,
            platform::windows::smtc_update_playback_state,
            platform::windows::smtc_update_position,
            updater::updater_status,
            updater::updater_check,
            updater::updater_update,
            logging::log_web,
        ])
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir()?;
            let state = AppState::new(&app_data_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "failed to initialize application services: {error}"
                ))
            })?;
            // asset 协议 scope：已注册曲库目录在启动时登记，新位置在
            // library_register_location 命令中登记（见 library.rs）。
            for root in state.services.library.registered_roots()? {
                app.asset_protocol_scope().allow_directory(&root, true)?;
            }
            app.manage(state);
            app.manage(updater_config.clone());
            lifecycle::install(app.handle())?;
            // 网易云协议 sidecar（D36）：完整版拉起 node 跑 vendored 服务；dev 期由
            // scripts/dev.mjs 编排，此处自动跳过。退出清理挂事件循环（on_event）。
            netease_sidecar::spawn(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build HyperPlayer")
        .run(move |app, event| netease_sidecar::on_event(app, event));
}
