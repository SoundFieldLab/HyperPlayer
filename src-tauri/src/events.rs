pub const PLAYBACK_STATE_CHANGED: &str = "hyperplayer://playback/state-changed";
pub const PLAYBACK_PROGRESS: &str = "hyperplayer://playback/progress";
pub const QUEUE_CHANGED: &str = "hyperplayer://queue/changed";
pub const ENGINE_SNAPSHOT_CHANGED: &str = "hyperplayer://engine/snapshot-changed";
pub const DSP_CONFIGURATION_REJECTED: &str = "hyperplayer://dsp/configuration-rejected";
pub const DSP_PROCESSING_FAULT: &str = "hyperplayer://dsp/processing-fault";
pub const LIBRARY_SCAN_PROGRESS: &str = "hyperplayer://library/scan-progress";
pub const SETTINGS_CHANGED: &str = "hyperplayer://settings/changed";
pub const CACHE_STATUS_CHANGED: &str = "hyperplayer://cache/status-changed";
pub const NETEASE_STATUS_CHANGED: &str = "hyperplayer://netease/status-changed";
pub const CLOSE_REQUESTED: &str = "hyperplayer://window/close-requested";
pub const LYRICS_CHANGED: &str = "hyperplayer://lyrics/changed";
pub const MEDIA_KEY_PRESSED: &str = "hyperplayer://windows/media-key-pressed";
pub const UPDATER_STATUS_CHANGED: &str = "hyperplayer://updater/status-changed";

pub const ALL: &[&str] = &[
    PLAYBACK_STATE_CHANGED,
    PLAYBACK_PROGRESS,
    QUEUE_CHANGED,
    ENGINE_SNAPSHOT_CHANGED,
    DSP_CONFIGURATION_REJECTED,
    DSP_PROCESSING_FAULT,
    LIBRARY_SCAN_PROGRESS,
    SETTINGS_CHANGED,
    CACHE_STATUS_CHANGED,
    NETEASE_STATUS_CHANGED,
    CLOSE_REQUESTED,
    LYRICS_CHANGED,
    MEDIA_KEY_PRESSED,
    UPDATER_STATUS_CHANGED,
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn event_names_are_unique_and_namespaced() {
        let unique = ALL.iter().copied().collect::<HashSet<_>>();
        assert_eq!(unique.len(), ALL.len());
        assert!(ALL.iter().all(|name| name.starts_with("hyperplayer://")));
    }
}
