use crate::{
    commands::command,
    dto::EngineSnapshotDto,
    error::{AppError, CommandResult},
    ports::AppState,
};
use hyperplayer_engine::dsp_algorithms::{
    bass_enhancer::{BassEnhancerSettings, HarmonicType},
    chorus::ChorusSettings,
    compressor::CompressorSettings,
    deesser::DeesserSettings,
    delay::DelaySettings,
    flanger::FlangerSettings,
    loudness_normalization::LoudnessNormalizationSettings,
    night_mode::NightModeSettings,
    phaser::PhaserSettings,
    surround3d::Surround3dSettings,
    tremolo::TremoloSettings,
    DspConfig, EqBandParam, EqChainConfig, EqStereoMode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

const UNSUPPORTED_STAGES: [&str; 8] = [
    "13:reverb",
    "15:loudnessCompensation",
    "16:intelligentEqAndPostProcessing",
    "17:analysisAndFft",
    "18:dynamicEq",
    "20:modulationMatrixAndMasterGain",
    "21:limiter",
    "22:spatialAndHrtf",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DspConfigurationDto {
    #[serde(with = "crate::dto::u64_decimal_string")]
    pub revision: u64,
    pub loudness_normalization: LoudnessNormalizationDto,
    pub surround3d: Surround3dDto,
    pub mid_side: MidSideDto,
    pub pre_eq: EqChainDto,
    pub deesser: DeesserDto,
    pub compressor: CompressorDto,
    pub night_mode: NightModeDto,
    pub delay: DelayDto,
    pub chorus: ChorusDto,
    pub flanger: FlangerDto,
    pub phaser: PhaserDto,
    pub tremolo: TremoloDto,
    pub bass_enhancer: BassEnhancerDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessNormalizationDto {
    pub enabled: bool,
    pub target_lufs: f64,
    pub max_gain_db: f64,
    pub min_gain_db: f64,
    pub use_realtime_meter: bool,
    pub external_gain_db: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Surround3dDto {
    pub enabled: bool,
    pub distance: f64,
    pub speed: f64,
    pub angle: f64,
    pub direction: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidSideDto {
    pub enabled: bool,
    pub stereo_width: f64,
    pub voice_balance: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqChainDto {
    pub enabled: bool,
    pub band_count: usize,
    pub q_compensation: bool,
    pub stereo_mode: String,
    pub bands: Vec<EqBandDto>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBandDto {
    pub frequency: f64,
    pub gain: f64,
    pub q: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeesserDto {
    pub enabled: bool,
    pub center_hz: f64,
    pub q: f64,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub split_band: bool,
    pub mix: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressorDto {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub knee_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
    pub output_gain: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NightModeDto {
    pub enabled: bool,
    pub amount: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelayDto {
    pub enabled: bool,
    pub delay_ms: f64,
    pub feedback: f64,
    pub mix: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChorusDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth_ms: f64,
    pub mix: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlangerDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth_ms: f64,
    pub feedback: f64,
    pub mix: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaserDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth: f64,
    pub feedback: f64,
    pub mix: f64,
    pub stages: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TremoloDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth: f64,
    pub mix: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BassEnhancerDto {
    pub enabled: bool,
    pub cutoff_hz: f64,
    pub q: f64,
    pub harmonic_type: String,
    pub harmonic_gain: f64,
    pub mix: f64,
    pub level_db: f64,
    pub low_boost_db: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DspConfigureRequestDto {
    pub configuration: DspConfigurationDto,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DspApplyPresetRequestDto {
    pub preset_id: String,
    #[serde(with = "crate::dto::u64_decimal_string")]
    pub revision: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DspImportHse2RequestDto {
    pub code: String,
    #[serde(with = "crate::dto::u64_decimal_string")]
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DspApplyStatusDto {
    Applied,
    Pending,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DspApplyResultDto {
    #[serde(with = "crate::dto::u64_decimal_string")]
    pub revision: u64,
    pub status: DspApplyStatusDto,
    pub partial: bool,
    pub unsupported_stages: Vec<String>,
    pub engine: EngineSnapshotDto,
    pub configuration: DspConfigurationDto,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DspPresetDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub partial: bool,
    pub unsupported_stages: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DspHse2ExportDto {
    pub code: String,
    pub scope: String,
    pub unsupported_stages: Vec<String>,
}

fn finite(value: f64, field: &str, min: f64, max: f64) -> Result<f64, AppError> {
    if !value.is_finite() || !(min..=max).contains(&value) {
        return Err(AppError::InvalidArgument(format!(
            "{field} must be finite and between {min} and {max}"
        )));
    }
    Ok(value)
}

impl DspConfigurationDto {
    fn into_engine(self) -> Result<DspConfig, AppError> {
        let harmonic_type = match self.bass_enhancer.harmonic_type.as_str() {
            "odd" => HarmonicType::Odd,
            "even" => HarmonicType::Even,
            "atan" => HarmonicType::Atan,
            "soft" => HarmonicType::Soft,
            _ => {
                return Err(AppError::InvalidArgument(
                    "bassEnhancer.harmonicType is invalid".into(),
                ))
            }
        };
        if self.revision == 0 {
            return Err(AppError::InvalidArgument(
                "revision must be non-zero".into(),
            ));
        }
        if self.pre_eq.band_count != self.pre_eq.bands.len()
            || !(1..=20).contains(&self.pre_eq.band_count)
        {
            return Err(AppError::InvalidArgument(
                "preEq bands must match bandCount between 1 and 20".into(),
            ));
        }
        let stereo_mode = match self.pre_eq.stereo_mode.as_str() {
            "independent" => EqStereoMode::Independent,
            "hseShared" => EqStereoMode::HseShared,
            _ => {
                return Err(AppError::InvalidArgument(
                    "preEq.stereoMode is invalid".into(),
                ))
            }
        };
        let bands = self
            .pre_eq
            .bands
            .into_iter()
            .enumerate()
            .map(|(index, band)| {
                Ok(EqBandParam {
                    frequency: finite(
                        band.frequency,
                        &format!("preEq.bands[{index}].frequency"),
                        20.0,
                        20_000.0,
                    )?,
                    gain: finite(
                        band.gain,
                        &format!("preEq.bands[{index}].gain"),
                        -20.0,
                        20.0,
                    )?,
                    q: finite(band.q, &format!("preEq.bands[{index}].q"), 0.1, 10.0)?,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        let low_boost_db = self
            .bass_enhancer
            .low_boost_db
            .map(|value| finite(value, "bassEnhancer.lowBoostDb", -6.0, 12.0))
            .transpose()?;
        if !matches!(self.surround3d.direction, -1.0 | 1.0) {
            return Err(AppError::InvalidArgument(
                "surround3d.direction must be -1 or 1".into(),
            ));
        }
        let stereo_width = finite(self.mid_side.stereo_width, "midSide.stereoWidth", 0.0, 2.0)?;
        let voice_balance = finite(
            self.mid_side.voice_balance,
            "midSide.voiceBalance",
            -1.0,
            1.0,
        )?;
        Ok(DspConfig {
            loudness_normalization: LoudnessNormalizationSettings {
                enabled: self.loudness_normalization.enabled,
                target_lufs: finite(
                    self.loudness_normalization.target_lufs,
                    "loudnessNormalization.targetLufs",
                    -40.0,
                    0.0,
                )?,
                max_gain_db: finite(
                    self.loudness_normalization.max_gain_db,
                    "loudnessNormalization.maxGainDb",
                    0.0,
                    24.0,
                )?,
                min_gain_db: finite(
                    self.loudness_normalization.min_gain_db,
                    "loudnessNormalization.minGainDb",
                    -24.0,
                    0.0,
                )?,
                use_realtime_meter: self.loudness_normalization.use_realtime_meter,
                external_gain_db: finite(
                    self.loudness_normalization.external_gain_db,
                    "loudnessNormalization.externalGainDb",
                    -24.0,
                    24.0,
                )?,
            },
            surround3d: Surround3dSettings {
                enabled: self.surround3d.enabled,
                distance: finite(self.surround3d.distance, "surround3d.distance", 0.0, 10.0)?,
                speed: finite(self.surround3d.speed, "surround3d.speed", 0.0, 10.0)?,
                angle: finite(self.surround3d.angle, "surround3d.angle", -360.0, 360.0)?,
                direction: self.surround3d.direction,
            },
            stereo_width: if self.mid_side.enabled {
                stereo_width
            } else {
                1.0
            },
            voice_balance: if self.mid_side.enabled {
                voice_balance
            } else {
                0.0
            },
            pre_eq: EqChainConfig {
                enabled: self.pre_eq.enabled,
                band_count: self.pre_eq.band_count,
                q_compensation: self.pre_eq.q_compensation,
                stereo_mode,
                bands,
            },
            deesser: DeesserSettings {
                enabled: self.deesser.enabled,
                center_hz: finite(self.deesser.center_hz, "deesser.centerHz", 100.0, 16_000.0)?,
                q: finite(self.deesser.q, "deesser.q", 0.1, 10.0)?,
                threshold_db: finite(self.deesser.threshold_db, "deesser.thresholdDb", -60.0, 0.0)?,
                ratio: finite(self.deesser.ratio, "deesser.ratio", 1.0, 50.0)?,
                attack_ms: finite(self.deesser.attack_ms, "deesser.attackMs", 0.0, 100.0)?,
                release_ms: finite(self.deesser.release_ms, "deesser.releaseMs", 0.0, 2_000.0)?,
                split_band: self.deesser.split_band,
                mix: finite(self.deesser.mix, "deesser.mix", 0.0, 1.0)?,
                sidechain_enabled: false,
            },
            compressor: CompressorSettings {
                enabled: self.compressor.enabled,
                threshold_db: finite(
                    self.compressor.threshold_db,
                    "compressor.thresholdDb",
                    -60.0,
                    0.0,
                )?,
                ratio: finite(self.compressor.ratio, "compressor.ratio", 1.0, 50.0)?,
                knee_db: finite(self.compressor.knee_db, "compressor.kneeDb", 0.0, 24.0)?,
                attack_ms: finite(self.compressor.attack_ms, "compressor.attackMs", 0.0, 500.0)?,
                release_ms: finite(
                    self.compressor.release_ms,
                    "compressor.releaseMs",
                    0.0,
                    3_000.0,
                )?,
                makeup_db: finite(
                    self.compressor.makeup_db,
                    "compressor.makeupDb",
                    -24.0,
                    24.0,
                )?,
                output_gain: finite(
                    self.compressor.output_gain,
                    "compressor.outputGain",
                    0.0,
                    2.0,
                )?,
                sidechain_enabled: false,
            },
            night_mode: NightModeSettings {
                enabled: self.night_mode.enabled,
                amount: finite(self.night_mode.amount, "nightMode.amount", 0.0, 10.0)?,
            },
            delay: DelaySettings {
                enabled: self.delay.enabled,
                delay_ms: finite(self.delay.delay_ms, "delay.delayMs", 0.0, 2_000.0)?,
                feedback: finite(self.delay.feedback, "delay.feedback", 0.0, 0.98)?,
                mix: finite(self.delay.mix, "delay.mix", 0.0, 1.0)?,
            },
            chorus: ChorusSettings {
                enabled: self.chorus.enabled,
                rate_hz: finite(self.chorus.rate_hz, "chorus.rateHz", 0.01, 20.0)?,
                depth_ms: finite(self.chorus.depth_ms, "chorus.depthMs", 0.0, 50.0)?,
                mix: finite(self.chorus.mix, "chorus.mix", 0.0, 1.0)?,
            },
            flanger: FlangerSettings {
                enabled: self.flanger.enabled,
                rate_hz: finite(self.flanger.rate_hz, "flanger.rateHz", 0.01, 20.0)?,
                depth_ms: finite(self.flanger.depth_ms, "flanger.depthMs", 0.0, 50.0)?,
                feedback: finite(self.flanger.feedback, "flanger.feedback", 0.0, 0.98)?,
                mix: finite(self.flanger.mix, "flanger.mix", 0.0, 1.0)?,
            },
            phaser: PhaserSettings {
                enabled: self.phaser.enabled,
                rate_hz: finite(self.phaser.rate_hz, "phaser.rateHz", 0.01, 20.0)?,
                depth: finite(self.phaser.depth, "phaser.depth", 0.0, 1.0)?,
                feedback: finite(self.phaser.feedback, "phaser.feedback", 0.0, 0.98)?,
                mix: finite(self.phaser.mix, "phaser.mix", 0.0, 1.0)?,
                stages: finite(self.phaser.stages, "phaser.stages", 2.0, 8.0)?,
            },
            tremolo: TremoloSettings {
                enabled: self.tremolo.enabled,
                rate_hz: finite(self.tremolo.rate_hz, "tremolo.rateHz", 0.01, 30.0)?,
                depth: finite(self.tremolo.depth, "tremolo.depth", 0.0, 1.0)?,
                mix: finite(self.tremolo.mix, "tremolo.mix", 0.0, 1.0)?,
            },
            bass_enhancer: BassEnhancerSettings {
                enabled: self.bass_enhancer.enabled,
                cutoff_hz: finite(
                    self.bass_enhancer.cutoff_hz,
                    "bassEnhancer.cutoffHz",
                    20.0,
                    500.0,
                )?,
                q: finite(self.bass_enhancer.q, "bassEnhancer.q", 0.1, 10.0)?,
                harmonic_type,
                harmonic_gain: finite(
                    self.bass_enhancer.harmonic_gain,
                    "bassEnhancer.harmonicGain",
                    0.0,
                    1.0,
                )?,
                mix: finite(self.bass_enhancer.mix, "bassEnhancer.mix", 0.0, 1.0)?,
                level_db: finite(
                    self.bass_enhancer.level_db,
                    "bassEnhancer.levelDb",
                    -6.0,
                    6.0,
                )?,
                low_boost_db,
            },
        })
    }
}

impl DspConfigurationDto {
    fn from_engine(revision: u64, c: &DspConfig) -> Self {
        let harmonic_type = match c.bass_enhancer.harmonic_type {
            HarmonicType::Odd => "odd",
            HarmonicType::Even => "even",
            HarmonicType::Atan => "atan",
            HarmonicType::Soft => "soft",
        };
        Self {
            revision,
            loudness_normalization: LoudnessNormalizationDto {
                enabled: c.loudness_normalization.enabled,
                target_lufs: c.loudness_normalization.target_lufs,
                max_gain_db: c.loudness_normalization.max_gain_db,
                min_gain_db: c.loudness_normalization.min_gain_db,
                use_realtime_meter: c.loudness_normalization.use_realtime_meter,
                external_gain_db: c.loudness_normalization.external_gain_db,
            },
            surround3d: Surround3dDto {
                enabled: c.surround3d.enabled,
                distance: c.surround3d.distance,
                speed: c.surround3d.speed,
                angle: c.surround3d.angle,
                direction: c.surround3d.direction,
            },
            mid_side: MidSideDto {
                enabled: c.stereo_width != 1.0 || c.voice_balance != 0.0,
                stereo_width: c.stereo_width,
                voice_balance: c.voice_balance,
            },
            pre_eq: EqChainDto {
                enabled: c.pre_eq.enabled,
                band_count: c.pre_eq.band_count,
                q_compensation: c.pre_eq.q_compensation,
                stereo_mode: match c.pre_eq.stereo_mode {
                    EqStereoMode::Independent => "independent",
                    EqStereoMode::HseShared => "hseShared",
                }
                .into(),
                bands: c
                    .pre_eq
                    .bands
                    .iter()
                    .map(|b| EqBandDto {
                        frequency: b.frequency,
                        gain: b.gain,
                        q: b.q,
                    })
                    .collect(),
            },
            deesser: DeesserDto {
                enabled: c.deesser.enabled,
                center_hz: c.deesser.center_hz,
                q: c.deesser.q,
                threshold_db: c.deesser.threshold_db,
                ratio: c.deesser.ratio,
                attack_ms: c.deesser.attack_ms,
                release_ms: c.deesser.release_ms,
                split_band: c.deesser.split_band,
                mix: c.deesser.mix,
            },
            compressor: CompressorDto {
                enabled: c.compressor.enabled,
                threshold_db: c.compressor.threshold_db,
                ratio: c.compressor.ratio,
                knee_db: c.compressor.knee_db,
                attack_ms: c.compressor.attack_ms,
                release_ms: c.compressor.release_ms,
                makeup_db: c.compressor.makeup_db,
                output_gain: c.compressor.output_gain,
            },
            night_mode: NightModeDto {
                enabled: c.night_mode.enabled,
                amount: c.night_mode.amount,
            },
            delay: DelayDto {
                enabled: c.delay.enabled,
                delay_ms: c.delay.delay_ms,
                feedback: c.delay.feedback,
                mix: c.delay.mix,
            },
            chorus: ChorusDto {
                enabled: c.chorus.enabled,
                rate_hz: c.chorus.rate_hz,
                depth_ms: c.chorus.depth_ms,
                mix: c.chorus.mix,
            },
            flanger: FlangerDto {
                enabled: c.flanger.enabled,
                rate_hz: c.flanger.rate_hz,
                depth_ms: c.flanger.depth_ms,
                feedback: c.flanger.feedback,
                mix: c.flanger.mix,
            },
            phaser: PhaserDto {
                enabled: c.phaser.enabled,
                rate_hz: c.phaser.rate_hz,
                depth: c.phaser.depth,
                feedback: c.phaser.feedback,
                mix: c.phaser.mix,
                stages: c.phaser.stages,
            },
            tremolo: TremoloDto {
                enabled: c.tremolo.enabled,
                rate_hz: c.tremolo.rate_hz,
                depth: c.tremolo.depth,
                mix: c.tremolo.mix,
            },
            bass_enhancer: BassEnhancerDto {
                enabled: c.bass_enhancer.enabled,
                cutoff_hz: c.bass_enhancer.cutoff_hz,
                q: c.bass_enhancer.q,
                harmonic_type: harmonic_type.into(),
                harmonic_gain: c.bass_enhancer.harmonic_gain,
                mix: c.bass_enhancer.mix,
                level_db: c.bass_enhancer.level_db,
                low_boost_db: c.bass_enhancer.low_boost_db,
            },
        }
    }
}

fn unsupported() -> Vec<String> {
    UNSUPPORTED_STAGES.iter().map(ToString::to_string).collect()
}
fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |node, key| node.get(*key))
}

fn require_hse_schema(value: &Value) -> Result<(), AppError> {
    const OBJECTS: &[&[&str]] = &[
        &["eq"],
        &["deesser"],
        &["compressor"],
        &["nightMode"],
        &["bassEnhancer"],
        &["loudnessNormalization"],
        &["surround3d"],
        &["pitch"],
        &["modEffects"],
        &["modEffects", "delay"],
        &["modEffects", "chorus"],
        &["modEffects", "flanger"],
        &["modEffects", "phaser"],
        &["modEffects", "tremolo"],
    ];
    const BOOLEANS: &[&[&str]] = &[
        &["eq", "enabled"],
        &["eq", "qCompensation"],
        &["deesser", "enabled"],
        &["deesser", "splitBand"],
        &["compressor", "enabled"],
        &["nightMode", "enabled"],
        &["bassEnhancer", "enabled"],
        &["loudnessNormalization", "enabled"],
        &["loudnessNormalization", "useRealtimeMeter"],
        &["surround3d", "enabled"],
        &["modEffects", "delay", "enabled"],
        &["modEffects", "chorus", "enabled"],
        &["modEffects", "flanger", "enabled"],
        &["modEffects", "phaser", "enabled"],
        &["modEffects", "tremolo", "enabled"],
    ];
    const NUMBERS: &[&[&str]] = &[
        &["stereoWidth"],
        &["pitch", "voiceBalance"],
        &["eq", "bandCount"],
        &["deesser", "centerHz"],
        &["deesser", "q"],
        &["deesser", "thresholdDb"],
        &["deesser", "ratio"],
        &["deesser", "attackMs"],
        &["deesser", "releaseMs"],
        &["deesser", "mix"],
        &["compressor", "thresholdDb"],
        &["compressor", "ratio"],
        &["compressor", "kneeDb"],
        &["compressor", "attackMs"],
        &["compressor", "releaseMs"],
        &["compressor", "makeupDb"],
        &["compressor", "outputGain"],
        &["nightMode", "amount"],
        &["bassEnhancer", "cutoffHz"],
        &["bassEnhancer", "q"],
        &["bassEnhancer", "harmonicGain"],
        &["bassEnhancer", "mix"],
        &["bassEnhancer", "levelDb"],
        &["loudnessNormalization", "targetLufs"],
        &["loudnessNormalization", "maxGainDb"],
        &["loudnessNormalization", "minGainDb"],
        &["loudnessNormalization", "externalGainDb"],
        &["surround3d", "distance"],
        &["surround3d", "speed"],
        &["surround3d", "angle"],
        &["surround3d", "direction"],
        &["modEffects", "delay", "delayMs"],
        &["modEffects", "delay", "feedback"],
        &["modEffects", "delay", "mix"],
        &["modEffects", "chorus", "rateHz"],
        &["modEffects", "chorus", "depthMs"],
        &["modEffects", "chorus", "mix"],
        &["modEffects", "flanger", "rateHz"],
        &["modEffects", "flanger", "depthMs"],
        &["modEffects", "flanger", "feedback"],
        &["modEffects", "flanger", "mix"],
        &["modEffects", "phaser", "rateHz"],
        &["modEffects", "phaser", "depth"],
        &["modEffects", "phaser", "feedback"],
        &["modEffects", "phaser", "mix"],
        &["modEffects", "phaser", "stages"],
        &["modEffects", "tremolo", "rateHz"],
        &["modEffects", "tremolo", "depth"],
        &["modEffects", "tremolo", "mix"],
    ];
    for path in OBJECTS {
        if !value_at(value, path).is_some_and(Value::is_object) {
            return Err(AppError::InvalidArgument(format!(
                "HSE2 field {} must be an object",
                path.join(".")
            )));
        }
    }
    for path in BOOLEANS {
        if !value_at(value, path).is_some_and(Value::is_boolean) {
            return Err(AppError::InvalidArgument(format!(
                "HSE2 field {} must be boolean",
                path.join(".")
            )));
        }
    }
    for path in NUMBERS {
        if !value_at(value, path)
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
        {
            return Err(AppError::InvalidArgument(format!(
                "HSE2 field {} must be finite numeric",
                path.join(".")
            )));
        }
    }
    if !value_at(value, &["bassEnhancer", "harmonicType"]).is_some_and(Value::is_string) {
        return Err(AppError::InvalidArgument(
            "HSE2 field bassEnhancer.harmonicType must be string".into(),
        ));
    }
    let bands = value_at(value, &["eq", "proBands"])
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::InvalidArgument("HSE2 field eq.proBands must be an array".into())
        })?;
    if bands.len() > 20 {
        return Err(AppError::InvalidArgument(
            "HSE2 eq.proBands must contain at most 20 bands".into(),
        ));
    }
    for (index, band) in bands.iter().enumerate() {
        for field in ["frequency", "gain", "q"] {
            if !band
                .get(field)
                .and_then(Value::as_f64)
                .is_some_and(f64::is_finite)
            {
                return Err(AppError::InvalidArgument(format!(
                    "HSE2 field eq.proBands[{index}].{field} must be finite numeric"
                )));
            }
        }
    }
    Ok(())
}

fn number(value: &Value, path: &[&str], fallback: f64) -> f64 {
    path.iter()
        .try_fold(value, |node, key| node.get(*key))
        .and_then(Value::as_f64)
        .unwrap_or(fallback)
}
fn boolean(value: &Value, path: &[&str], fallback: bool) -> bool {
    path.iter()
        .try_fold(value, |node, key| node.get(*key))
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn config_from_hse(value: &Value, revision: u64) -> Result<DspConfigurationDto, AppError> {
    require_hse_schema(value)?;
    let mut dto = DspConfigurationDto::from_engine(revision, &DspConfig::default());
    dto.mid_side.enabled = true;
    dto.mid_side.stereo_width = number(value, &["stereoWidth"], 1.0);
    dto.mid_side.voice_balance = number(value, &["pitch", "voiceBalance"], 0.0);
    dto.pre_eq.enabled = boolean(value, &["eq", "enabled"], true);
    dto.pre_eq.q_compensation = boolean(value, &["eq", "qCompensation"], true);
    if let Some(bands) = value
        .get("eq")
        .and_then(|v| v.get("proBands"))
        .and_then(Value::as_array)
    {
        dto.pre_eq.bands = bands
            .iter()
            .map(|b| EqBandDto {
                frequency: number(b, &["frequency"], 1_000.0),
                gain: number(b, &["gain"], 0.0),
                q: number(b, &["q"], 1.1),
            })
            .collect();
        if dto.pre_eq.bands.is_empty() {
            let defaults = DspConfig::default();
            dto.pre_eq.bands = defaults
                .pre_eq
                .bands
                .iter()
                .map(|band| EqBandDto {
                    frequency: band.frequency,
                    gain: band.gain,
                    q: band.q,
                })
                .collect();
        }
        dto.pre_eq.band_count = dto.pre_eq.bands.len();
    }
    dto.deesser = DeesserDto {
        enabled: boolean(value, &["deesser", "enabled"], false),
        center_hz: number(value, &["deesser", "centerHz"], 6_000.0),
        q: number(value, &["deesser", "q"], 0.7),
        threshold_db: number(value, &["deesser", "thresholdDb"], -30.0),
        ratio: number(value, &["deesser", "ratio"], 8.0),
        attack_ms: number(value, &["deesser", "attackMs"], 1.0),
        release_ms: number(value, &["deesser", "releaseMs"], 80.0),
        split_band: boolean(value, &["deesser", "splitBand"], true),
        mix: number(value, &["deesser", "mix"], 1.0),
    };
    dto.compressor = CompressorDto {
        enabled: boolean(value, &["compressor", "enabled"], false),
        threshold_db: number(value, &["compressor", "thresholdDb"], -20.0),
        ratio: number(value, &["compressor", "ratio"], 4.0),
        knee_db: number(value, &["compressor", "kneeDb"], 6.0),
        attack_ms: number(value, &["compressor", "attackMs"], 10.0),
        release_ms: number(value, &["compressor", "releaseMs"], 150.0),
        makeup_db: number(value, &["compressor", "makeupDb"], 0.0),
        output_gain: number(value, &["compressor", "outputGain"], 1.0),
    };
    dto.night_mode = NightModeDto {
        enabled: boolean(value, &["nightMode", "enabled"], false),
        amount: number(value, &["nightMode", "amount"], 0.0),
    };
    dto.bass_enhancer = BassEnhancerDto {
        enabled: boolean(value, &["bassEnhancer", "enabled"], false),
        cutoff_hz: number(value, &["bassEnhancer", "cutoffHz"], 90.0),
        q: number(value, &["bassEnhancer", "q"], 0.7),
        harmonic_type: value
            .get("bassEnhancer")
            .and_then(|v| v.get("harmonicType"))
            .and_then(Value::as_str)
            .unwrap_or("odd")
            .into(),
        harmonic_gain: number(value, &["bassEnhancer", "harmonicGain"], 0.6),
        mix: number(value, &["bassEnhancer", "mix"], 0.5),
        level_db: number(value, &["bassEnhancer", "levelDb"], 0.0),
        low_boost_db: value
            .get("bassEnhancer")
            .and_then(|v| v.get("lowBoostDb"))
            .and_then(Value::as_f64),
    };
    if let Some(effects) = value.get("modEffects") {
        dto.delay = DelayDto {
            enabled: boolean(effects, &["delay", "enabled"], false),
            delay_ms: number(effects, &["delay", "delayMs"], 250.0),
            feedback: number(effects, &["delay", "feedback"], 0.3),
            mix: number(effects, &["delay", "mix"], 0.3),
        };
        dto.chorus = ChorusDto {
            enabled: boolean(effects, &["chorus", "enabled"], false),
            rate_hz: number(effects, &["chorus", "rateHz"], 1.0),
            depth_ms: number(effects, &["chorus", "depthMs"], 3.0),
            mix: number(effects, &["chorus", "mix"], 0.4),
        };
        dto.flanger = FlangerDto {
            enabled: boolean(effects, &["flanger", "enabled"], false),
            rate_hz: number(effects, &["flanger", "rateHz"], 0.5),
            depth_ms: number(effects, &["flanger", "depthMs"], 2.0),
            feedback: number(effects, &["flanger", "feedback"], 0.4),
            mix: number(effects, &["flanger", "mix"], 0.5),
        };
        dto.phaser = PhaserDto {
            enabled: boolean(effects, &["phaser", "enabled"], false),
            rate_hz: number(effects, &["phaser", "rateHz"], 0.5),
            depth: number(effects, &["phaser", "depth"], 0.5),
            feedback: number(effects, &["phaser", "feedback"], 0.4),
            mix: number(effects, &["phaser", "mix"], 0.5),
            stages: number(effects, &["phaser", "stages"], 4.0),
        };
        dto.tremolo = TremoloDto {
            enabled: boolean(effects, &["tremolo", "enabled"], false),
            rate_hz: number(effects, &["tremolo", "rateHz"], 5.0),
            depth: number(effects, &["tremolo", "depth"], 0.5),
            mix: number(effects, &["tremolo", "mix"], 1.0),
        };
    }
    dto.loudness_normalization = LoudnessNormalizationDto {
        enabled: boolean(value, &["loudnessNormalization", "enabled"], false),
        target_lufs: number(value, &["loudnessNormalization", "targetLufs"], -14.0),
        max_gain_db: number(value, &["loudnessNormalization", "maxGainDb"], 9.0),
        min_gain_db: number(value, &["loudnessNormalization", "minGainDb"], -9.0),
        use_realtime_meter: boolean(value, &["loudnessNormalization", "useRealtimeMeter"], true),
        external_gain_db: number(value, &["loudnessNormalization", "externalGainDb"], 0.0),
    };
    dto.surround3d = Surround3dDto {
        enabled: boolean(value, &["surround3d", "enabled"], false),
        distance: number(value, &["surround3d", "distance"], 0.5),
        speed: number(value, &["surround3d", "speed"], 1.0),
        angle: number(value, &["surround3d", "angle"], 0.0),
        direction: number(value, &["surround3d", "direction"], 1.0),
    };
    let _ = dto.clone().into_engine()?;
    Ok(dto)
}

fn hse_from_config(config: &DspConfig) -> Value {
    let dto = DspConfigurationDto::from_engine(1, config);
    let mut value = hyperplayer_engine::hse_default_params(48_000.0);
    value["stereoWidth"] = json!(dto.mid_side.stereo_width);
    value["pitch"]["voiceBalance"] = json!(dto.mid_side.voice_balance);
    value["eq"]["enabled"] = json!(dto.pre_eq.enabled);
    value["eq"]["qCompensation"] = json!(dto.pre_eq.q_compensation);
    value["eq"]["bandCount"] = json!(dto.pre_eq.band_count);
    value["eq"]["proBands"] = json!(dto.pre_eq.bands);
    value["deesser"] = json!(dto.deesser);
    value["compressor"] = json!(dto.compressor);
    value["nightMode"] = json!(dto.night_mode);
    value["bassEnhancer"] = json!(dto.bass_enhancer);
    value["loudnessNormalization"] = json!(dto.loudness_normalization);
    value["surround3d"] = json!(dto.surround3d);
    value["modEffects"] = json!({ "delay": dto.delay, "chorus": dto.chorus, "flanger": dto.flanger, "phaser": dto.phaser, "tremolo": dto.tremolo });
    value
}

fn apply(state: &AppState, dto: DspConfigurationDto) -> Result<DspApplyResultDto, AppError> {
    let revision = dto.revision;
    let config = dto.clone().into_engine()?;
    let _operation = state
        .dsp_operation
        .lock()
        .map_err(|_| AppError::StateUnavailable)?;
    {
        let mut dsp = state.dsp.lock().map_err(|_| AppError::StateUnavailable)?;
        let current_revision = dsp.newest_revision();
        if revision <= current_revision {
            return Err(AppError::InvalidArgument(format!(
                "revision must be greater than {current_revision}"
            )));
        }
        dsp.request(revision, config.clone());
    }
    let engine = match state.services.playback.configure_dsp(revision, config) {
        Ok(engine) => engine,
        Err(error) => {
            state
                .dsp
                .lock()
                .map_err(|_| AppError::StateUnavailable)?
                .reject(revision);
            return Err(error);
        }
    };
    let status = if engine.dsp_execution.revision == revision {
        state
            .dsp
            .lock()
            .map_err(|_| AppError::StateUnavailable)?
            .promote(revision);
        DspApplyStatusDto::Applied
    } else {
        DspApplyStatusDto::Pending
    };
    Ok(DspApplyResultDto {
        revision,
        status,
        partial: false,
        unsupported_stages: Vec::new(),
        engine,
        configuration: dto,
    })
}

fn get_configuration(state: &AppState) -> Result<DspConfigurationDto, AppError> {
    let engine = state.services.playback.engine_snapshot()?;
    let mut current = state.dsp.lock().map_err(|_| AppError::StateUnavailable)?;
    current.promote(engine.dsp_execution.revision);
    let (revision, config) = current
        .pending
        .as_ref()
        .filter(|pending| pending.revision == 1 && current.applied_revision == 0)
        .map_or(
            (current.applied_revision, &current.applied_config),
            |pending| (pending.revision, &pending.config),
        );
    Ok(DspConfigurationDto::from_engine(revision, config))
}

#[tauri::command]
pub fn dsp_get_configuration(state: State<'_, AppState>) -> CommandResult<DspConfigurationDto> {
    command(get_configuration(&state))
}
#[tauri::command]
pub fn dsp_configure(
    state: State<'_, AppState>,
    request: DspConfigureRequestDto,
) -> CommandResult<DspApplyResultDto> {
    command(apply(&state, request.configuration))
}
#[tauri::command]
pub fn dsp_list_presets() -> CommandResult<Vec<DspPresetDto>> {
    command(Ok(hyperplayer_engine::hse_builtin_scenes()
        .into_iter()
        .map(|scene| DspPresetDto {
            id: scene["id"].as_str().unwrap_or_default().into(),
            name: scene["name"].as_str().unwrap_or_default().into(),
            description: scene["description"].as_str().unwrap_or_default().into(),
            partial: true,
            unsupported_stages: unsupported(),
        })
        .collect()))
}
#[tauri::command]
pub fn dsp_apply_preset(
    state: State<'_, AppState>,
    request: DspApplyPresetRequestDto,
) -> CommandResult<DspApplyResultDto> {
    command((|| {
        let scene = hyperplayer_engine::hse_builtin_scenes()
            .into_iter()
            .find(|scene| scene["id"] == request.preset_id)
            .ok_or_else(|| AppError::InvalidArgument("unknown DSP preset".into()))?;
        let dto = config_from_hse(&scene["params"], request.revision)?;
        let mut result = apply(&state, dto)?;
        result.partial = true;
        result.unsupported_stages = unsupported();
        Ok(result)
    })())
}
#[tauri::command]
pub fn dsp_import_hse2(
    state: State<'_, AppState>,
    request: DspImportHse2RequestDto,
) -> CommandResult<DspApplyResultDto> {
    command((|| {
        if request.code.len() > 131_072 {
            return Err(AppError::InvalidArgument("HSE2 code is too large".into()));
        }
        let params = hyperplayer_engine::hse_decode_share_code(request.code.trim())
            .map_err(AppError::InvalidArgument)?;
        let dto = config_from_hse(&params, request.revision)?;
        let mut result = apply(&state, dto)?;
        result.partial = true;
        result.unsupported_stages = unsupported();
        Ok(result)
    })())
}
#[tauri::command]
pub fn dsp_export_hse2(state: State<'_, AppState>) -> CommandResult<DspHse2ExportDto> {
    command((|| {
        let current = state.dsp.lock().map_err(|_| AppError::StateUnavailable)?;
        let code =
            hyperplayer_engine::hse_encode_share_code(&hse_from_config(&current.applied_config))
                .map_err(AppError::InvalidArgument)?;
        Ok(DspHse2ExportDto {
            code,
            scope: "current14StageProjection".into(),
            unsupported_stages: unsupported(),
        })
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_zero_revision_and_non_finite_values() {
        let mut dto = DspConfigurationDto::from_engine(0, &DspConfig::default());
        assert!(dto.clone().into_engine().is_err());
        dto.revision = 2;
        dto.mid_side.stereo_width = f64::NAN;
        assert!(dto.into_engine().is_err());
    }
    #[test]
    fn presets_are_explicitly_partial() {
        let presets: Vec<_> = hyperplayer_engine::hse_builtin_scenes()
            .into_iter()
            .map(|scene| config_from_hse(&scene["params"], 2).unwrap())
            .collect();
        assert_eq!(presets.len(), 12);
        assert_eq!(
            unsupported(),
            vec![
                "13:reverb",
                "15:loudnessCompensation",
                "16:intelligentEqAndPostProcessing",
                "17:analysisAndFft",
                "18:dynamicEq",
                "20:modulationMatrixAndMasterGain",
                "21:limiter",
                "22:spatialAndHrtf",
            ]
        );
    }
    #[test]
    fn hse_sanitized_projection_accepts_codec_boundaries_and_preserves_q_compensation_false() {
        let mut value = hyperplayer_engine::hse_default_params(48_000.0);
        value["surround3d"]["distance"] = json!(10.0);
        value["surround3d"]["speed"] = json!(10.0);
        value["nightMode"]["amount"] = json!(10.0);
        value["deesser"]["centerHz"] = json!(100.0);
        value["deesser"]["attackMs"] = json!(0.0);
        value["compressor"]["ratio"] = json!(50.0);
        value["modEffects"]["delay"]["delayMs"] = json!(0.0);
        value["modEffects"]["phaser"]["stages"] = json!(8.0);
        value["eq"]["qCompensation"] = json!(false);

        let mapped = config_from_hse(&value, 2).unwrap().into_engine().unwrap();
        assert_eq!(mapped.surround3d.distance, 10.0);
        assert_eq!(mapped.night_mode.amount, 10.0);
        assert!(!mapped.pre_eq.q_compensation);
    }

    #[test]
    fn hse_import_validates_the_codec_sanitized_projection() {
        let raw = json!({ "compressor": { "ratio": "invalid" } });
        let code = hyperplayer_engine::hse_encode_share_code(&raw).unwrap();
        let sanitized = hyperplayer_engine::hse_decode_share_code(&code).unwrap();
        let mapped = config_from_hse(&sanitized, 2)
            .unwrap()
            .into_engine()
            .unwrap();
        assert_eq!(mapped.compressor.ratio, 4.0);
    }

    #[test]
    fn dsp_state_promotes_and_rejects_only_matching_pending_revision() {
        let mut state = crate::ports::DspConfigurationState::new();
        let requested = DspConfig {
            stereo_width: 1.5,
            ..DspConfig::default()
        };
        state.request(2, requested.clone());
        assert_eq!(state.applied_revision, 0);
        assert!(!state.reject(3));
        assert_eq!(state.pending.as_ref().unwrap().revision, 2);
        assert!(state.promote(2));
        assert_eq!(state.applied_revision, 2);
        assert_eq!(state.applied_config, requested);

        state.request(3, DspConfig::default());
        assert!(state.reject(3));
        assert_eq!(state.applied_revision, 2);
        assert!(state.pending.is_none());
    }

    #[test]
    fn event_before_command_return_promotion_is_idempotent() {
        let mut state = crate::ports::DspConfigurationState::new();
        state.request(2, DspConfig::default());
        assert!(state.promote(2));
        assert!(!state.promote(2));
        assert_eq!(state.applied_revision, 2);
        assert!(state.pending.is_none());
    }

    #[test]
    fn initial_default_revision_is_observed_and_first_ui_revision_is_accepted() {
        let state = AppState::in_memory().unwrap();
        let initial = get_configuration(&state).unwrap();
        assert_eq!(initial.revision, 1);
        assert_eq!(state.dsp.lock().unwrap().newest_revision(), 1);

        let next = DspConfigurationDto::from_engine(2, &DspConfig::default());
        let result = apply(&state, next).unwrap();
        assert_eq!(result.revision, 2);
    }

    #[test]
    fn configuration_transactions_accept_two_then_three_and_reject_stale_two() {
        let state = AppState::in_memory().unwrap();
        let revision_two = DspConfigurationDto::from_engine(2, &DspConfig::default());
        assert_eq!(apply(&state, revision_two.clone()).unwrap().revision, 2);
        let revision_three = DspConfigurationDto::from_engine(3, &DspConfig::default());
        assert_eq!(apply(&state, revision_three).unwrap().revision, 3);
        assert!(apply(&state, revision_two).is_err());
        assert_eq!(state.dsp.lock().unwrap().newest_revision(), 3);
    }
    #[test]
    fn current_projection_roundtrips_through_hse2() {
        let config = DspConfig::default();
        let code = hyperplayer_engine::hse_encode_share_code(&hse_from_config(&config)).unwrap();
        let decoded = hyperplayer_engine::hse_decode_share_code(&code).unwrap();
        let mapped = config_from_hse(&decoded, 2).unwrap().into_engine().unwrap();
        assert_eq!(mapped.pre_eq.bands.len(), config.pre_eq.bands.len());
        assert_eq!(mapped.bass_enhancer.enabled, config.bass_enhancer.enabled);
    }
}
