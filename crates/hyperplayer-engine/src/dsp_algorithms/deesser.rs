//! HSE de-esser 的 HyperPlayer 参数与路由适配。

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeesserSettings {
    pub enabled: bool,
    pub center_hz: f64,
    pub q: f64,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub split_band: bool,
    pub mix: f64,
    /// 引擎接线标志；算法仅在显式提供外部 sidechain 时使用外部检测信号。
    pub sidechain_enabled: bool,
}

impl Default for DeesserSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            center_hz: 6_000.0,
            q: 0.7,
            threshold_db: -30.0,
            ratio: 8.0,
            attack_ms: 1.0,
            release_ms: 80.0,
            split_band: true,
            mix: 1.0,
            sidechain_enabled: false,
        }
    }
}

impl From<DeesserSettings> for hse_core::deesser::DeesserSettings {
    fn from(settings: DeesserSettings) -> Self {
        Self {
            enabled: settings.enabled,
            center_hz: settings.center_hz,
            q: settings.q,
            threshold_db: settings.threshold_db,
            ratio: settings.ratio,
            attack_ms: settings.attack_ms,
            release_ms: settings.release_ms,
            split_band: settings.split_band,
            mix: settings.mix,
            sidechain_enabled: settings.sidechain_enabled,
        }
    }
}
