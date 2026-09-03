mod adapter_mapping;
mod adapters;
mod cache_runtime;
mod commands;
mod credential_vault;
pub mod dto;
pub mod error;
pub mod events;
mod lifecycle;
mod platform;
pub mod ports;
mod secure_http;

use commands::{
    bootstrap, cache, compat, dsp, library, lyrics, netease, playback, queue, settings, telemetry,
    updater, weather, window,
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
        .on_window_event(lifecycle::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            bootstrap::bootstrap,
            bootstrap::dsp_availability,
            dsp::dsp_get_configuration,
            dsp::dsp_configure,
            dsp::dsp_list_presets,
            dsp::dsp_apply_preset,
            dsp::dsp_import_hse2,
            dsp::dsp_export_hse2,
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
            telemetry::telemetry_subscribe,
            telemetry::telemetry_ack,
            telemetry::telemetry_set_activity,
            telemetry::telemetry_close,
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
            netease::netease_search_hot,
            netease::netease_search_suggest,
            netease::netease_banner,
            netease::netease_playlist_categories,
            netease::netease_high_quality_playlists,
            netease::netease_similar_playlists,
            netease::netease_artist_albums,
            netease::netease_artist_mvs,
            netease::netease_artist_sublist,
            netease::netease_album_sublist,
            netease::netease_mv_sublist,
            netease::netease_personalized_new_songs,
            netease::netease_dislike_recommend_song,
            netease::netease_check_songs_liked,
            netease::netease_hot_comments,
            netease::netease_comment_floor,
            netease::netease_msg_comments,
            netease::netease_user_followeds,
            netease::netease_user_level,
            netease::netease_user_subcount,
            netease::netease_style_preference,
            netease::netease_login_status,
            netease::netease_listen_data_today,
            netease::netease_journey_overview,
            netease::netease_recent_plays,
            netease::netease_similar_songs,
            netease::netease_song_quality_levels,
            netease::netease_scrobble,
            netease::netease_dj_categories,
            netease::netease_dj_recommend,
            netease::netease_dj_program_toplist,
            netease::netease_dj_sublist,
            netease::netease_personalized_dj_radios,
            netease::netease_song_wiki,
            netease::netease_song_related_blogs,
            netease::netease_song_detail_enriched,
            netease::netease_playmode_intelligence_list,
            netease::netease_related_playlists,
            netease::netease_album_covers_batch,
            netease::netease_similar_artists,
            netease::netease_explore_next,
            netease::netease_update_playlist_cover,
            netease::netease_mv_playback,
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
            updater::updater_update,
            weather::shenzhen_weather,
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
            cache_capacity_bytes: 10 * 1024 * 1024 * 1024,
            cache_trim_percent: 90,
            cache_recent_track_limit: 100,
            album_fill_enabled: true,
            album_fill_quality: "standard".into(),
            dsp: None,
        })
        .unwrap();

        assert!(value.get("dynamicColor").is_some());
        assert!(value.get("closeBehavior").is_some());
        assert!(value.get("dynamic_color").is_none());
        assert!(value.get("cacheCapacityBytes").is_some());
        assert!(value.get("cacheTrimPercent").is_some());
        assert!(value.get("cacheRecentTrackLimit").is_some());
        assert!(value.get("albumFillEnabled").is_some());
        assert!(value.get("albumFillQuality").is_some());
        assert!(value.get("dsp").is_none());

        let weather = serde_json::to_value(ShenzhenWeatherDto {
            location: "深圳".into(),
            observed_at: "2026-09-01T12:30".into(),
            temperature_c: 31.2,
            apparent_temperature_c: 35.7,
            relative_humidity_percent: 72,
            weather_code: 61,
            condition: "雨".into(),
            wind_speed_kmh: 8.4,
            is_day: true,
        })
        .unwrap();
        assert!(weather.get("observedAt").is_some());
        assert!(weather.get("temperatureC").is_some());
        assert!(weather.get("relativeHumidityPercent").is_some());
        assert!(weather.get("observed_at").is_none());
    }

    #[test]
    fn telemetry_subscribe_uses_d31_defaults() {
        let request =
            serde_json::from_value::<TelemetrySubscribeRequestDto>(serde_json::json!({})).unwrap();
        assert_eq!(request.max_frame_bytes, 1024);
        assert_eq!(request.max_frames_per_second, 30);
    }

    #[test]
    fn telemetry_activity_uses_rate_hz_contract() {
        let request = serde_json::from_value::<TelemetryActivityRequestDto>(serde_json::json!({
            "sessionId": "session",
            "epoch": "1",
            "rateHz": 15
        }))
        .unwrap();
        assert_eq!(request.rate_hz, 15);
        assert!(
            serde_json::from_value::<TelemetryActivityRequestDto>(serde_json::json!({
                "sessionId": "session",
                "epoch": "1",
                "active": true
            }))
            .is_err()
        );
    }

    #[test]
    fn telemetry_u64_fields_use_lossless_decimal_strings() {
        let maximum = u64::MAX.to_string();
        let request = serde_json::from_value::<TelemetryAckRequestDto>(serde_json::json!({
            "sessionId": "session",
            "epoch": maximum,
            "sequence": "9007199254740993",
            "revision": "18446744073709551614"
        }))
        .unwrap();
        assert_eq!(request.epoch, u64::MAX);
        assert_eq!(request.sequence, 9_007_199_254_740_993);
        assert_eq!(request.revision, u64::MAX - 1);

        let session = serde_json::to_value(TelemetrySessionDto {
            session_id: "session".into(),
            epoch: u64::MAX,
            max_frame_bytes: 1024,
            max_frames_per_second: 30,
        })
        .unwrap();
        assert_eq!(session["epoch"], u64::MAX.to_string());

        for invalid in [
            serde_json::json!(1),
            serde_json::json!("-1"),
            serde_json::json!("+1"),
            serde_json::json!("01x"),
            serde_json::json!("18446744073709551616"),
        ] {
            assert!(
                serde_json::from_value::<TelemetryAckRequestDto>(serde_json::json!({
                    "sessionId": "session",
                    "epoch": invalid,
                    "sequence": "1",
                    "revision": "1"
                }))
                .is_err()
            );
        }
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
            },
            "context": { "kind": "manual", "id": null }
        }));
        assert!(result.is_err());
    }

    #[test]
    fn dsp_command_reports_built_in_runtime_capability() {
        let availability = crate::commands::bootstrap::dsp_availability().unwrap();
        assert!(availability.available);
        assert!(availability.reason.contains("Rust DSP runtime"));
        assert!(availability.reason.contains("DspPort"));
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
