//! HSE 虚拟低频增强的 HyperPlayer 参数适配。

use hse_core::bass_enhancer::BassEnhancerSettings as CoreBassEnhancerSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HarmonicType {
    Odd,
    Even,
    Atan,
    Soft,
}

impl HarmonicType {
    fn core_name(self) -> &'static str {
        match self {
            Self::Odd => "odd",
            Self::Even => "even",
            Self::Atan => "atan",
            Self::Soft => "soft",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BassEnhancerSettings {
    pub enabled: bool,
    pub cutoff_hz: f64,
    pub q: f64,
    pub harmonic_type: HarmonicType,
    pub harmonic_gain: f64,
    pub mix: f64,
    pub level_db: f64,
    pub low_boost_db: Option<f64>,
}

impl Default for BassEnhancerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            cutoff_hz: 90.0,
            q: 0.7,
            harmonic_type: HarmonicType::Odd,
            harmonic_gain: 0.6,
            mix: 0.5,
            level_db: 0.0,
            low_boost_db: None,
        }
    }
}

impl From<BassEnhancerSettings> for CoreBassEnhancerSettings {
    fn from(settings: BassEnhancerSettings) -> Self {
        Self {
            enabled: settings.enabled,
            cutoff_hz: settings.cutoff_hz,
            q: settings.q,
            harmonic_type: settings.harmonic_type.core_name().to_owned(),
            harmonic_gain: settings.harmonic_gain,
            mix: settings.mix,
            level_db: settings.level_db,
            low_boost_db: settings.low_boost_db,
        }
    }
}
