pub const LIBRARY_SCAN_PROGRESS: &str = "hyperplayer://library/scan-progress";
pub const SETTINGS_CHANGED: &str = "hyperplayer://settings/changed";
pub const CLOSE_REQUESTED: &str = "hyperplayer://window/close-requested";
pub const MEDIA_KEY_PRESSED: &str = "hyperplayer://windows/media-key-pressed";
pub const UPDATER_STATUS_CHANGED: &str = "hyperplayer://updater/status-changed";
/// D35 Q18：播放状态跨窗口广播（主窗口 app.emit，辅助窗口订阅）。
/// 仅声明事件名；由 WebView 前端广播，Rust 侧不产生播放语义。
pub const PLAYBACK_BROADCAST: &str = "hyperplayer://playback/broadcast";

pub const ALL: &[&str] = &[
    LIBRARY_SCAN_PROGRESS,
    SETTINGS_CHANGED,
    CLOSE_REQUESTED,
    MEDIA_KEY_PRESSED,
    UPDATER_STATUS_CHANGED,
    PLAYBACK_BROADCAST,
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