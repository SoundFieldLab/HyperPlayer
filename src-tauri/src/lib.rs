// Official Tauri 2 template entry + plugin registration only (zero custom Rust).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            // stronghold 官方推荐模式（插件 README）：JS 侧提供密码，插件以 argon2 + 盐文件
            // 派生 vault 密钥。密码由 app 层首启生成并存入 settings（后端补充规划 #47）。
            use tauri::Manager;
            let salt_path = app
                .path()
                .app_local_data_dir()
                .expect("could not resolve app local data path")
                .join("stronghold-salt.txt");
            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;
            Ok(())
        })
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_single_instance::init(|app, argv, cwd| {
                // 二次启动：转发参数事件给主窗口 JS，并聚焦已有窗口（后端补充规划 #40）。
                use tauri::{Emitter, Manager};
                let _ = app.emit(
                    "single-instance",
                    serde_json::json!({ "args": argv, "cwd": cwd }),
                );
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            }),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
