pub const LIBRARY_SCAN_PROGRESS: &str = "hyperplayer://library/scan-progress";
pub const SETTINGS_CHANGED: &str = "hyperplayer://settings/changed";
pub const CLOSE_REQUESTED: &str = "hyperplayer://window/close-requested";
pub const MEDIA_KEY_PRESSED: &str = "hyperplayer://windows/media-key-pressed";
pub const UPDATER_STATUS_CHANGED: &str = "hyperplayer://updater/status-changed";

pub const ALL: &[&str] = &[
    LIBRARY_SCAN_PROGRESS,
    SETTINGS_CHANGED,
    CLOSE_REQUESTED,
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