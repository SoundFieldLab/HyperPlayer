//! HSE 动态压缩器的 HyperPlayer 参数与路由适配。

use hse_core::compressor::CompressorSettings as CoreCompressorSettings;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompressorSettings {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub knee_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
    pub output_gain: f64,
    /// 接线层元数据；普通处理入口始终使用压缩器自身的立体声联合包络。
    pub sidechain_enabled: bool,
}

impl Default for CompressorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_db: -20.0,
            ratio: 4.0,
            knee_db: 6.0,
            attack_ms: 10.0,
            release_ms: 150.0,
            makeup_db: 0.0,
            output_gain: 1.0,
            sidechain_enabled: false,
        }
    }
}

impl From<CompressorSettings> for CoreCompressorSettings {
    fn from(settings: CompressorSettings) -> Self {
        Self {
            enabled: settings.enabled,
            threshold_db: settings.threshold_db,
            ratio: settings.ratio,
            knee_db: settings.knee_db,
            attack_ms: settings.attack_ms,
            release_ms: settings.release_ms,
            makeup_db: settings.makeup_db,
            output_gain: settings.output_gain,
            // HyperPlayer 的该字段仅描述路由；外部总线只由显式入口接入。
            sidechain_enabled: false,
        }
    }
}
