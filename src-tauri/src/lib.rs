// Official Tauri 2 template entry + plugin registration only (zero custom Rust).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|_app| {
                // Official stronghold plugin README example: derive a vault key
                // from a password. Real user password flow lands in M5.
                use argon2::{hash, Algorithm, Params, Version};
                let salt = b"hyperplayer-vault-salt";
                let config = Params::new(64, 32, 2, None).unwrap();
                let hash = hash(
                    b"hyperplayer-vault-default-password",
                    salt,
                    &config,
                    Algorithm::Argon2id,
                    Version::V0x13,
                )?;
                let mut result = [0u8; 32];
                result.copy_from_slice(hash.as_bytes());
                Ok(result.to_vec())
            })
            .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
