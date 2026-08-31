mod adapter_mapping;
mod adapters;
mod commands;
mod credential_vault;
pub mod dto;
pub mod error;
pub mod events;
mod lifecycle;
mod platform;
pub mod ports;

use commands::{
    bootstrap, cache, compat, library, lyrics, netease, playback, queue, settings, updater, window,
};
use ports::AppState;
use tauri::Manager;

pub fn run() {
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

    builder
        .invoke_handler(tauri::generate_handler![
            bootstrap::bootstrap,
            bootstrap::dsp_availability,
            compat::get_playback,
            compat::set_playback,
            compat::seek,
            compat::set_volume,
            compat::get_library_summary,
            compat::get_tasks,
            compat::get_settings,
            compat::update_settings,
            playback::playback_get_state,
            playback::playback_play,
            playback::playback_pause,
            playback::playback_stop,
            playback::playback_next,
            playback::playback_previous,
            playback::playback_seek,
            playback::playback_set_volume,
            playback::playback_set_repeat_mode,
            queue::queue_get,
            queue::queue_enqueue,
            queue::queue_remove,
            queue::queue_reorder,
            queue::queue_clear_play_next,
            queue::queue_clear_all,
            library::library_overview,
            library::library_query_tracks,
            library::library_query_albums,
            library::library_query_artists,
            library::library_query_folders,
            library::library_query_recent,
            library::library_query_playlists,
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
            cache::cache_stats,
            cache::cache_status,
            cache::cache_track,
            cache::cache_remove,
            cache::cache_clear,
            netease::netease_status,
            netease::netease_search,
            netease::netease_mvs,
            netease::netease_mv_detail,
            netease::netease_dj_radios,
            netease::netease_dj_programs,
            netease::netease_charts,
            netease::netease_new_songs,
            netease::netease_listen_total,
            netease::netease_listen_report,
            netease::netease_listen_song_rank,
            netease::netease_followed_events,
            netease::netease_user_events,
            netease::netease_notices,
            netease::netease_home,
            netease::netease_album_detail,
            netease::netease_playlist_detail,
            netease::netease_artist_detail,
            netease::netease_personal_fm,
            netease::netease_account,
            netease::netease_favorites,
            netease::netease_comments,
            netease::netease_follows,
            netease::netease_cloud,
            netease::netease_image,
            netease::netease_prepare_mutation,
            netease::netease_commit_mutation,
            netease::netease_start_qr_login,
            netease::netease_poll_qr_login,
            netease::netease_logout,
            lyrics::lyrics_get,
            window::window_show,
            window::window_close,
            window::window_hide,
            window::window_set_always_on_top,
            window::desktop_lyrics_set_click_through,
            window::window_resolve_close,
            platform::windows::windows_integration_status,
            platform::windows::windows_enable_media_controls,
            platform::windows::windows_register_file_associations,
            updater::updater_status,
            updater::updater_check,
        ])
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir()?;
            let state = AppState::new(&app_data_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "failed to initialize application services: {error}"
                ))
            })?;
            app.manage(state);
            app.manage(updater_config.clone());
            lifecycle::install(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run HyperPlayer");
}

#[cfg(test)]
mod tests {
    use super::dto::*;

    #[test]
    fn dto_json_uses_camel_case() {
        let value = serde_json::to_value(SettingsDto {
            theme: ThemeDto::Light,
            dynamic_color: true,
            reduce_motion: false,
            reduce_transparency: false,
            restore_queue: true,
            autoplay_on_start: false,
            close_behavior: CloseBehaviorDto::Ask,
            netease_enabled: true,
        })
        .unwrap();

        assert!(value.get("dynamicColor").is_some());
        assert!(value.get("closeBehavior").is_some());
        assert!(value.get("dynamic_color").is_none());
    }

    #[test]
    fn library_registration_accepts_only_selection_tickets() {
        assert!(
            serde_json::from_value::<RegisterLibraryLocationRequestDto>(serde_json::json!({
                "path": "C:\\Music"
            }))
            .is_err()
        );
        assert_eq!(
            serde_json::from_value::<RegisterLibraryLocationRequestDto>(serde_json::json!({
                "selectionTicket": "ticket"
            }))
            .unwrap()
            .selection_ticket,
            "ticket"
        );
    }

    #[test]
    fn play_request_rejects_frontend_track_metadata() {
        let result = serde_json::from_value::<PlayTrackRequestDto>(serde_json::json!({
            "track": {
                "id": "local:trusted",
                "source": "local",
                "title": "untrusted title",
                "playable": true
            }
        }));
        assert!(result.is_err());
    }

    #[test]
    fn dsp_command_returns_unavailable() {
        let error = crate::commands::bootstrap::dsp_availability().unwrap_err();
        assert_eq!(error.code, "unavailable");
        assert!(error.message.contains("D16"));
    }

    #[test]
    fn netease_command_mapping_is_complete_and_unique() {
        let names = crate::commands::netease::NETEASE_COMMAND_NAMES;
        let unique = names
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), names.len());
        for required in [
            "netease_search",
            "netease_mvs",
            "netease_mv_detail",
            "netease_dj_radios",
            "netease_dj_programs",
            "netease_charts",
            "netease_new_songs",
            "netease_listen_total",
            "netease_listen_report",
            "netease_listen_song_rank",
            "netease_followed_events",
            "netease_user_events",
            "netease_notices",
            "netease_home",
            "netease_album_detail",
            "netease_playlist_detail",
            "netease_artist_detail",
            "netease_personal_fm",
            "netease_account",
            "netease_favorites",
            "netease_comments",
            "netease_follows",
            "netease_cloud",
            "netease_image",
            "netease_prepare_mutation",
            "netease_commit_mutation",
        ] {
            assert!(
                unique.contains(required),
                "missing command mapping: {required}"
            );
        }
        assert!(!names.iter().any(|name| {
            name.contains("route")
                || name.contains("raw")
                || name.contains("cookie")
                || name.contains("url")
        }));
    }

    #[test]
    fn netease_use_case_dtos_do_not_expose_transport_fields() {
        let value = serde_json::to_value(NeteaseMvDetailDto {
            mv: NeteaseMvDto {
                id: 7,
                name: "MV".into(),
                cover_url: Some("cover-id".into()),
                duration_ms: Some(10),
                artists: vec![],
                play_count: Some(20),
            },
            description: Some("description".into()),
            publish_time: Some("2026-08-30".into()),
            favorite_count: Some(1),
            comment_count: Some(2),
        })
        .unwrap();
        let encoded = value.to_string().to_ascii_lowercase();
        for forbidden in ["rawbody", "cookie", "playurl", "requesturl", "checktoken"] {
            assert!(!encoded.contains(forbidden));
        }
    }
}
