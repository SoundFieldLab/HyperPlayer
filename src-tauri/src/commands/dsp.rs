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
    dynamic_eq::DynamicEqSettings,
    flanger::FlangerSettings,
    limiter::LimiterSettings,
    loudness_comp::{LoudnessBandParam, LoudnessCompMode, LoudnessCompSettings},
    loudness_normalization::LoudnessNormalizationSettings,
    night_mode::NightModeSettings,
    phaser::PhaserSettings,
    reverb::{IrRecipe, ReverbMode, ReverbSettings, ReverbType},
    surround3d::Surround3dSettings,
    tremolo::TremoloSettings,
    DspConfig, EqBandParam, EqChainConfig, EqStereoMode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

const UNSUPPORTED_STAGES: [&str; 1] = ["22:spatialAndHrtf"];

/// 卷积模式确定性 IR 配方（DTO 不携带 IR；无第三方 IR 文件解码，见
/// `dsp_algorithms/reverb.rs` 的切片铁律）。
const DEFAULT_CONVOLUTION_IR: IrRecipe = IrRecipe::ExpNoise {
    length: 8_192.0,
    seed: 0x4850_5352,
    decay: 4.0,
    amp: 0.35,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
    pub reverb: ReverbDto,
    pub bass_enhancer: BassEnhancerDto,
    pub loudness_comp: LoudnessCompDto,
    pub ieq: IeqDto,
    pub dynamic_eq: DynamicEqDto,
    pub modulation: ModulationDto,
    pub limiter: LimiterDto,
    pub lufs_metering: LufsMeteringDto,
}

/// LUFS 计量段（Stage 19 分析 tap）。`mode` 默认 `hseV151`（兼容）；`ituBs17705`
/// 为独立标准模式（待向量认证，不宣称合规）。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LufsMeteringDto {
    pub mode: String,
}

impl Default for LufsMeteringDto {
    fn default() -> Self {
        Self {
            mode: "hseV151".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessNormalizationDto {
    pub enabled: bool,
    pub target_lufs: f64,
    pub max_gain_db: f64,
    pub min_gain_db: f64,
    pub use_realtime_meter: bool,
    pub external_gain_db: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Surround3dDto {
    pub enabled: bool,
    pub distance: f64,
    pub speed: f64,
    pub angle: f64,
    pub direction: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MidSideDto {
    pub enabled: bool,
    pub stereo_width: f64,
    pub voice_balance: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EqChainDto {
    pub enabled: bool,
    pub band_count: usize,
    pub q_compensation: bool,
    pub stereo_mode: String,
    pub bands: Vec<EqBandDto>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EqBandDto {
    pub frequency: f64,
    pub gain: f64,
    pub q: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
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
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
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
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NightModeDto {
    pub enabled: bool,
    pub amount: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DelayDto {
    pub enabled: bool,
    pub delay_ms: f64,
    pub feedback: f64,
    pub mix: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChorusDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth_ms: f64,
    pub mix: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlangerDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth_ms: f64,
    pub feedback: f64,
    pub mix: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhaserDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth: f64,
    pub feedback: f64,
    pub mix: f64,
    pub stages: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TremoloDto {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth: f64,
    pub mix: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReverbDto {
    pub enabled: bool,
    pub mode: String,
    pub reverb_type: String,
    pub room_size: f64,
    pub damping: f64,
    pub wet: f64,
    pub dry: f64,
    pub pre_delay_ms: f64,
    pub width: f64,
    pub fdn_lines: u32,
    pub mix: f64,
    pub partition_size: f64,
    pub short_region_ms: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessCompDto {
    pub enabled: bool,
    pub mode: String,
    pub preset: String,
    pub volume_percent: f64,
    pub max_boost_db: f64,
    pub smoothing_seconds: f64,
    pub bands: Vec<LoudnessCompBandDto>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessCompBandDto {
    pub frequency: f64,
    pub gain: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicEqDto {
    pub enabled: bool,
    pub strength: f64,
    pub threshold_db: f64,
    pub ratio: f64,
    pub knee_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub block_size: f64,
    pub bands: Vec<DynamicEqBandDto>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicEqBandDto {
    pub enabled: bool,
    pub frequency: f64,
    pub target_gain_db: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimiterDto {
    pub enabled: bool,
    pub threshold_db: f64,
    pub lookahead_ms: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub true_peak: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IeqTargetCurveDto {
    Flat,
    Warm,
    Bright,
    Vocal,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IeqDto {
    pub enabled: bool,
    pub strength: f64,
    pub target_curve: IeqTargetCurveDto,
    pub time_constant_sec: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModLfoShapeDto {
    Sine,
    Triangle,
    Square,
    Saw,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModRouteSourceDto {
    Lfo,
    Envelope,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModRouteTargetDto {
    MasterGain,
    StereoWidth,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModRouteDto {
    pub source: ModRouteSourceDto,
    pub target: ModRouteTargetDto,
    pub depth: f64,
    pub polarity: f64,
    pub smoothing_ms: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModulationDto {
    pub enabled: bool,
    pub lfo_shape: ModLfoShapeDto,
    pub lfo_rate_hz: f64,
    pub lfo_depth: f64,
    pub envelope_attack_ms: f64,
    pub envelope_release_ms: f64,
    pub envelope_amount: f64,
    pub routes: Vec<ModRouteDto>,
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
    /// 公开入口：持久化配置（PersistedDspConfig.configuration）恢复为引擎 DspConfig。
    pub fn into_engine_config(self) -> Result<DspConfig, AppError> {
        self.into_engine()
    }

    /// 公开入口：由引擎 DspConfig + revision 构造 DTO（持久化/导出共用）。
    pub fn from_engine_value(revision: u64, c: &DspConfig) -> Self {
        Self::from_engine(revision, c)
    }

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
            reverb: {
                let mode = match self.reverb.mode.as_str() {
                    "algorithmic" => ReverbMode::Algorithmic,
                    "fdn" => ReverbMode::Fdn,
                    "convolution" => ReverbMode::Convolution,
                    _ => return Err(AppError::InvalidArgument("reverb.mode is invalid".into())),
                };
                let reverb_type = match self.reverb.reverb_type.as_str() {
                    "hall" => ReverbType::Hall,
                    "room" => ReverbType::Room,
                    "plate" => ReverbType::Plate,
                    "spring" => ReverbType::Spring,
                    "stage" => ReverbType::Stage,
                    _ => {
                        return Err(AppError::InvalidArgument(
                            "reverb.reverbType is invalid".into(),
                        ))
                    }
                };
                let fdn_lines = self.reverb.fdn_lines;
                if !matches!(fdn_lines, 2 | 4 | 8 | 16) {
                    return Err(AppError::InvalidArgument(
                        "reverb.fdnLines must be one of 2, 4, 8, 16".into(),
                    ));
                }
                let partition_size = finite(
                    self.reverb.partition_size,
                    "reverb.partitionSize",
                    32.0,
                    8_192.0,
                )?;
                ReverbSettings {
                    enabled: self.reverb.enabled,
                    mode,
                    reverb_type,
                    room_size: finite(self.reverb.room_size, "reverb.roomSize", 0.0, 1.0)?,
                    damping: finite(self.reverb.damping, "reverb.damping", 0.0, 1.0)?,
                    wet: finite(self.reverb.wet, "reverb.wet", 0.0, 4.0)?,
                    dry: finite(self.reverb.dry, "reverb.dry", 0.0, 4.0)?,
                    pre_delay_ms: finite(
                        self.reverb.pre_delay_ms,
                        "reverb.preDelayMs",
                        0.0,
                        1_000.0,
                    )?,
                    width: finite(self.reverb.width, "reverb.width", 0.0, 2.0)?,
                    fdn_lines,
                    mix: finite(self.reverb.mix, "reverb.mix", 0.0, 1.0)?,
                    partition_size,
                    // 长分区下限跟随最短分区（引擎钳制 32..8192 且 long >= Ls）。
                    long_partition_size: partition_size.max(4_096.0),
                    short_region_ms: finite(
                        self.reverb.short_region_ms,
                        "reverb.shortRegionMs",
                        0.0,
                        5_000.0,
                    )?,
                    // 卷积模式注入确定性 IR 配方（DTO 不携带 IR；非卷积模式不消费）。
                    de_periodize: true,
                    ir_recipe: (mode == ReverbMode::Convolution).then_some(DEFAULT_CONVOLUTION_IR),
                }
            },
            loudness_comp: {
                let mode = match self.loudness_comp.mode.as_str() {
                    "auto" => LoudnessCompMode::Auto,
                    "preset" => LoudnessCompMode::Preset,
                    "custom" => LoudnessCompMode::Custom,
                    _ => {
                        return Err(AppError::InvalidArgument(
                            "loudnessComp.mode is invalid".into(),
                        ))
                    }
                };
                if !matches!(
                    self.loudness_comp.preset.as_str(),
                    "flat" | "bass" | "vocal" | "warm" | "bright" | "night"
                ) {
                    return Err(AppError::InvalidArgument(
                        "loudnessComp.preset is invalid".into(),
                    ));
                }
                let bands = self
                    .loudness_comp
                    .bands
                    .iter()
                    .enumerate()
                    .map(|(index, band)| {
                        Ok(LoudnessBandParam {
                            frequency: finite(
                                band.frequency,
                                &format!("loudnessComp.bands[{index}].frequency"),
                                20.0,
                                20_000.0,
                            )?,
                            gain: finite(
                                band.gain,
                                &format!("loudnessComp.bands[{index}].gain"),
                                -24.0,
                                24.0,
                            )?,
                        })
                    })
                    .collect::<Result<Vec<_>, AppError>>()?;
                LoudnessCompSettings {
                    enabled: self.loudness_comp.enabled,
                    mode,
                    volume_percent: finite(
                        self.loudness_comp.volume_percent,
                        "loudnessComp.volumePercent",
                        0.0,
                        100.0,
                    )?,
                    max_boost_db: finite(
                        self.loudness_comp.max_boost_db,
                        "loudnessComp.maxBoostDb",
                        0.0,
                        24.0,
                    )?,
                    preset: self.loudness_comp.preset.clone(),
                    smoothing_seconds: finite(
                        self.loudness_comp.smoothing_seconds,
                        "loudnessComp.smoothingSeconds",
                        0.01,
                        10.0,
                    )?,
                    bands,
                }
            },
            dynamic_eq: {
                let bands = self
                    .dynamic_eq
                    .bands
                    .iter()
                    .enumerate()
                    .map(|(index, band)| {
                        // 末带（index 4）的 frequency 被核心忽略（引擎默认 0.0），
                        // 仅要求有限值；前四带按产品范围严格校验。
                        let frequency = if index < 4 {
                            finite(
                                band.frequency,
                                &format!("dynamicEq.bands[{index}].frequency"),
                                30.0,
                                20_000.0,
                            )?
                        } else if band.frequency.is_finite() {
                            band.frequency
                        } else {
                            return Err(AppError::InvalidArgument(format!(
                                "dynamicEq.bands[{index}].frequency must be finite"
                            )));
                        };
                        Ok(
                            hyperplayer_engine::dsp_algorithms::dynamic_eq::DynamicEqBandSettings {
                                enabled: band.enabled,
                                frequency,
                                target_gain_db: finite(
                                    band.target_gain_db,
                                    &format!("dynamicEq.bands[{index}].targetGainDb"),
                                    -12.0,
                                    12.0,
                                )?,
                            },
                        )
                    })
                    .collect::<Result<Vec<_>, AppError>>()?;
                DynamicEqSettings {
                    enabled: self.dynamic_eq.enabled,
                    strength: finite(self.dynamic_eq.strength, "dynamicEq.strength", 0.0, 1.0)?,
                    threshold_db: finite(
                        self.dynamic_eq.threshold_db,
                        "dynamicEq.thresholdDb",
                        -80.0,
                        0.0,
                    )?,
                    ratio: finite(self.dynamic_eq.ratio, "dynamicEq.ratio", 1.0, 100.0)?,
                    knee_db: finite(self.dynamic_eq.knee_db, "dynamicEq.kneeDb", 0.0, 40.0)?,
                    attack_ms: finite(
                        self.dynamic_eq.attack_ms,
                        "dynamicEq.attackMs",
                        0.0,
                        1_000.0,
                    )?,
                    release_ms: finite(
                        self.dynamic_eq.release_ms,
                        "dynamicEq.releaseMs",
                        0.0,
                        5_000.0,
                    )?,
                    block_size: finite(
                        self.dynamic_eq.block_size,
                        "dynamicEq.blockSize",
                        16.0,
                        2_048.0,
                    )?,
                    bands: bands.try_into().map_err(|_| {
                        AppError::InvalidArgument(
                            "dynamicEq.bands must carry exactly 5 bands".into(),
                        )
                    })?,
                }
            },
            limiter: LimiterSettings {
                enabled: self.limiter.enabled,
                threshold_db: finite(self.limiter.threshold_db, "limiter.thresholdDb", -60.0, 0.0)?,
                lookahead_ms: finite(self.limiter.lookahead_ms, "limiter.lookaheadMs", 0.0, 20.0)?,
                attack_ms: finite(self.limiter.attack_ms, "limiter.attackMs", 0.0, 100.0)?,
                release_ms: finite(self.limiter.release_ms, "limiter.releaseMs", 0.0, 1_000.0)?,
                true_peak: self.limiter.true_peak,
            },
            ieq: hyperplayer_engine::dsp_algorithms::ieq::IeqSettings {
                enabled: self.ieq.enabled,
                strength: finite(self.ieq.strength, "ieq.strength", 0.0, 1.0)?,
                target_curve: match self.ieq.target_curve {
                    IeqTargetCurveDto::Flat => hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Flat,
                    IeqTargetCurveDto::Warm => hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Warm,
                    IeqTargetCurveDto::Bright => {
                        hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Bright
                    }
                    IeqTargetCurveDto::Vocal => {
                        hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Vocal
                    }
                },
                time_constant_sec: finite(
                    self.ieq.time_constant_sec,
                    "ieq.timeConstantSec",
                    0.1,
                    10.0,
                )?,
            },
            modulation: hyperplayer_engine::dsp_algorithms::modulation::ModulationSettings {
                enabled: self.modulation.enabled,
                lfo_shape: match self.modulation.lfo_shape {
                    ModLfoShapeDto::Sine => {
                        hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Sine
                    }
                    ModLfoShapeDto::Triangle => {
                        hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Triangle
                    }
                    ModLfoShapeDto::Square => {
                        hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Square
                    }
                    ModLfoShapeDto::Saw => {
                        hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Saw
                    }
                },
                lfo_rate_hz: finite(self.modulation.lfo_rate_hz, "modulation.lfoRateHz", 0.0, 1_000.0)?,
                lfo_depth: finite(self.modulation.lfo_depth, "modulation.lfoDepth", 0.0, 1.0)?,
                envelope_attack_ms: finite(
                    self.modulation.envelope_attack_ms,
                    "modulation.envelopeAttackMs",
                    0.05,
                    5_000.0,
                )?,
                envelope_release_ms: finite(
                    self.modulation.envelope_release_ms,
                    "modulation.envelopeReleaseMs",
                    0.05,
                    5_000.0,
                )?,
                envelope_amount: finite(
                    self.modulation.envelope_amount,
                    "modulation.envelopeAmount",
                    0.0,
                    1.0,
                )?,
                routes: self
                    .modulation
                    .routes
                    .into_iter()
                    .enumerate()
                    .map(|(index, route)| {
                        let source = match route.source {
                            ModRouteSourceDto::Lfo => {
                                hyperplayer_engine::dsp_algorithms::modulation::ModRouteSource::Lfo
                            }
                            ModRouteSourceDto::Envelope => {
                                hyperplayer_engine::dsp_algorithms::modulation::ModRouteSource::Envelope
                            }
                        };
                        let target = match route.target {
                            ModRouteTargetDto::MasterGain => {
                                hyperplayer_engine::dsp_algorithms::modulation::ModRouteTarget::MasterGain
                            }
                            ModRouteTargetDto::StereoWidth => {
                                hyperplayer_engine::dsp_algorithms::modulation::ModRouteTarget::StereoWidth
                            }
                        };
                        let depth = finite(
                            route.depth,
                            &format!("modulation.routes[{index}].depth"),
                            0.0,
                            16.0,
                        )?;
                        let polarity = route.polarity;
                        if polarity != 1.0 && polarity != -1.0 {
                            return Err(AppError::InvalidArgument(format!(
                                "modulation.routes[{index}].polarity must be exactly +1 or -1"
                            )));
                        }
                        Ok(
                            hyperplayer_engine::dsp_algorithms::modulation::ModRouteSettings {
                                source,
                                target,
                                depth,
                                polarity,
                                smoothing_ms: finite(
                                    route.smoothing_ms,
                                    &format!("modulation.routes[{index}].smoothingMs"),
                                    0.0,
                                    5_000.0,
                                )?,
                            },
                        )
                    })
                    .collect::<Result<Vec<_>, AppError>>()?,
            },
            metering_lufs_mode: match self.lufs_metering.mode.as_str() {
                "ituBs17705" => {
                    hyperplayer_engine::dsp_algorithms::lufs_meter::LufsMeterMode::ItuBs1770_5
                }
                _ => hyperplayer_engine::dsp_algorithms::lufs_meter::LufsMeterMode::HseV151,
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
            reverb: ReverbDto {
                enabled: c.reverb.enabled,
                mode: match c.reverb.mode {
                    ReverbMode::Algorithmic => "algorithmic",
                    ReverbMode::Fdn => "fdn",
                    ReverbMode::Convolution => "convolution",
                }
                .into(),
                reverb_type: match c.reverb.reverb_type {
                    ReverbType::Hall => "hall",
                    ReverbType::Room => "room",
                    ReverbType::Plate => "plate",
                    ReverbType::Spring => "spring",
                    ReverbType::Stage => "stage",
                }
                .into(),
                room_size: c.reverb.room_size,
                damping: c.reverb.damping,
                wet: c.reverb.wet,
                dry: c.reverb.dry,
                pre_delay_ms: c.reverb.pre_delay_ms,
                width: c.reverb.width,
                fdn_lines: c.reverb.fdn_lines,
                mix: c.reverb.mix,
                partition_size: c.reverb.partition_size,
                short_region_ms: c.reverb.short_region_ms,
            },
            loudness_comp: LoudnessCompDto {
                enabled: c.loudness_comp.enabled,
                mode: match c.loudness_comp.mode {
                    LoudnessCompMode::Auto => "auto",
                    LoudnessCompMode::Preset => "preset",
                    LoudnessCompMode::Custom => "custom",
                }
                .into(),
                preset: c.loudness_comp.preset.clone(),
                volume_percent: c.loudness_comp.volume_percent,
                max_boost_db: c.loudness_comp.max_boost_db,
                smoothing_seconds: c.loudness_comp.smoothing_seconds,
                bands: c
                    .loudness_comp
                    .bands
                    .iter()
                    .map(|band| LoudnessCompBandDto {
                        frequency: band.frequency,
                        gain: band.gain,
                    })
                    .collect(),
            },
            dynamic_eq: DynamicEqDto {
                enabled: c.dynamic_eq.enabled,
                strength: c.dynamic_eq.strength,
                threshold_db: c.dynamic_eq.threshold_db,
                ratio: c.dynamic_eq.ratio,
                knee_db: c.dynamic_eq.knee_db,
                attack_ms: c.dynamic_eq.attack_ms,
                release_ms: c.dynamic_eq.release_ms,
                block_size: c.dynamic_eq.block_size,
                bands: c
                    .dynamic_eq
                    .bands
                    .iter()
                    .map(|band| DynamicEqBandDto {
                        enabled: band.enabled,
                        frequency: band.frequency,
                        target_gain_db: band.target_gain_db,
                    })
                    .collect(),
            },
            limiter: LimiterDto {
                enabled: c.limiter.enabled,
                threshold_db: c.limiter.threshold_db,
                lookahead_ms: c.limiter.lookahead_ms,
                attack_ms: c.limiter.attack_ms,
                release_ms: c.limiter.release_ms,
                true_peak: c.limiter.true_peak,
            },
            ieq: IeqDto {
                enabled: c.ieq.enabled,
                strength: c.ieq.strength,
                target_curve: match c.ieq.target_curve {
                    hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Flat => {
                        IeqTargetCurveDto::Flat
                    }
                    hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Warm => {
                        IeqTargetCurveDto::Warm
                    }
                    hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Bright => {
                        IeqTargetCurveDto::Bright
                    }
                    hyperplayer_engine::dsp_algorithms::IeqTargetCurve::Vocal => {
                        IeqTargetCurveDto::Vocal
                    }
                },
                time_constant_sec: c.ieq.time_constant_sec,
            },
            modulation: ModulationDto {
                enabled: c.modulation.enabled,
                lfo_shape: match c.modulation.lfo_shape {
                    hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Sine => {
                        ModLfoShapeDto::Sine
                    }
                    hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Triangle => {
                        ModLfoShapeDto::Triangle
                    }
                    hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Square => {
                        ModLfoShapeDto::Square
                    }
                    hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Saw => {
                        ModLfoShapeDto::Saw
                    }
                },
                lfo_rate_hz: c.modulation.lfo_rate_hz,
                lfo_depth: c.modulation.lfo_depth,
                envelope_attack_ms: c.modulation.envelope_attack_ms,
                envelope_release_ms: c.modulation.envelope_release_ms,
                envelope_amount: c.modulation.envelope_amount,
                routes: c
                    .modulation
                    .routes
                    .iter()
                    .map(|route| ModRouteDto {
                        source: match route.source {
                            hyperplayer_engine::dsp_algorithms::modulation::ModRouteSource::Lfo => {
                                ModRouteSourceDto::Lfo
                            }
                            hyperplayer_engine::dsp_algorithms::modulation::ModRouteSource::Envelope => {
                                ModRouteSourceDto::Envelope
                            }
                        },
                        target: match route.target {
                            hyperplayer_engine::dsp_algorithms::modulation::ModRouteTarget::MasterGain => {
                                ModRouteTargetDto::MasterGain
                            }
                            hyperplayer_engine::dsp_algorithms::modulation::ModRouteTarget::StereoWidth => {
                                ModRouteTargetDto::StereoWidth
                            }
                        },
                        depth: route.depth,
                        polarity: route.polarity,
                        smoothing_ms: route.smoothing_ms,
                    })
                    .collect(),
            },
            lufs_metering: LufsMeteringDto {
                mode: match c.metering_lufs_mode {
                    hyperplayer_engine::dsp_algorithms::lufs_meter::LufsMeterMode::ItuBs1770_5 => {
                        "ituBs17705"
                    }
                    hyperplayer_engine::dsp_algorithms::lufs_meter::LufsMeterMode::HseV151 => {
                        "hseV151"
                    }
                }
                .into(),
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
        &["reverb"],
        &["reverb", "algorithmic"],
        &["reverb", "convolution"],
        &["loudnessCompensation"],
        &["dynamicEq"],
        &["limiter"],
        &["ieq"],
        &["modulation"],
        &["modulation", "lfo"],
        &["modulation", "envelope"],
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
        &["reverb", "enabled"],
        &["reverb", "convolution", "dePeriodize"],
        &["loudnessCompensation", "enabled"],
        &["dynamicEq", "enabled"],
        &["limiter", "enabled"],
        &["limiter", "truePeak"],
        &["ieq", "enabled"],
        &["modulation", "enabled"],
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
        &["reverb", "algorithmic", "roomSize"],
        &["reverb", "algorithmic", "damping"],
        &["reverb", "algorithmic", "wet"],
        &["reverb", "algorithmic", "dry"],
        &["reverb", "algorithmic", "preDelayMs"],
        &["reverb", "algorithmic", "width"],
        &["reverb", "convolution", "mix"],
        &["reverb", "convolution", "preDelayMs"],
        &["loudnessCompensation", "volumePercent"],
        &["loudnessCompensation", "maxBoostDb"],
        &["loudnessCompensation", "smoothingSeconds"],
        &["dynamicEq", "strength"],
        &["dynamicEq", "thresholdDb"],
        &["dynamicEq", "ratio"],
        &["dynamicEq", "attackMs"],
        &["dynamicEq", "releaseMs"],
        &["limiter", "thresholdDb"],
        &["limiter", "lookaheadMs"],
        &["limiter", "attackMs"],
        &["limiter", "releaseMs"],
        &["ieq", "strength"],
        &["ieq", "timeConstantSec"],
        &["modulation", "lfo", "rateHz"],
        &["modulation", "lfo", "depth"],
        &["modulation", "envelope", "attackMs"],
        &["modulation", "envelope", "releaseMs"],
        &["modulation", "envelope", "amount"],
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
    // reverb：algorithmic/fdn 参数全量投影；convolution 无可解析 IR（irName 仅是
    // 引用，HyperPlayer 不做 IR 文件解码）→ 确定性配方 + off 回落算法模式缺省。
    let reverb_mode = value
        .get("reverb")
        .and_then(|v| v.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("algorithmic");
    let reverb_alg =
        |field: &str, fallback: f64| number(value, &["reverb", "algorithmic", field], fallback);
    dto.reverb = ReverbDto {
        enabled: boolean(value, &["reverb", "enabled"], false),
        mode: match reverb_mode {
            "fdn" => "fdn",
            "convolution" => "convolution",
            _ => "algorithmic",
        }
        .into(),
        reverb_type: value
            .get("reverb")
            .and_then(|v| v.get("algorithmic"))
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("hall")
            .into(),
        room_size: reverb_alg("roomSize", 0.5),
        damping: reverb_alg("damping", 0.5),
        wet: reverb_alg("wet", 0.3),
        dry: reverb_alg("dry", 0.7),
        pre_delay_ms: reverb_alg("preDelayMs", 0.0),
        width: reverb_alg("width", 1.0),
        fdn_lines: 8,
        mix: number(value, &["reverb", "convolution", "mix"], 0.3),
        partition_size: 512.0,
        short_region_ms: 100.0,
    };
    dto.loudness_comp = LoudnessCompDto {
        enabled: boolean(value, &["loudnessCompensation", "enabled"], false),
        mode: value
            .get("loudnessCompensation")
            .and_then(|v| v.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .into(),
        preset: value
            .get("loudnessCompensation")
            .and_then(|v| v.get("preset"))
            .and_then(Value::as_str)
            .unwrap_or("flat")
            .into(),
        volume_percent: number(value, &["loudnessCompensation", "volumePercent"], 80.0),
        max_boost_db: number(value, &["loudnessCompensation", "maxBoostDb"], 12.0),
        smoothing_seconds: number(value, &["loudnessCompensation", "smoothingSeconds"], 0.2),
        bands: value
            .get("loudnessCompensation")
            .and_then(|v| v.get("bands"))
            .and_then(Value::as_array)
            .map(|bands| {
                bands
                    .iter()
                    .map(|band| LoudnessCompBandDto {
                        frequency: number(band, &["frequency"], 1_000.0),
                        gain: number(band, &["gain"], 0.0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };
    dto.dynamic_eq = DynamicEqDto {
        enabled: boolean(value, &["dynamicEq", "enabled"], false),
        strength: number(value, &["dynamicEq", "strength"], 0.5),
        threshold_db: number(value, &["dynamicEq", "thresholdDb"], -20.0),
        ratio: number(value, &["dynamicEq", "ratio"], 2.0),
        // kneeDb / blockSize 不在 HSE 分享白名单 → 缺省还原。
        knee_db: 6.0,
        attack_ms: number(value, &["dynamicEq", "attackMs"], 20.0),
        release_ms: number(value, &["dynamicEq", "releaseMs"], 200.0),
        block_size: 128.0,
        // bands 白名单仅 enabled/targetGainDb → 交叉频率按引擎默认还原。
        bands: (0..5)
            .map(|index| {
                let band = value
                    .get("dynamicEq")
                    .and_then(|v| v.get("bands"))
                    .and_then(Value::as_array)
                    .and_then(|bands| bands.get(index));
                DynamicEqBandDto {
                    enabled: band
                        .and_then(|b| b.get("enabled"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    frequency: [200.0, 800.0, 2_500.0, 8_000.0, 0.0][index],
                    target_gain_db: band
                        .and_then(|b| b.get("targetGainDb"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                }
            })
            .collect(),
    };
    dto.limiter = LimiterDto {
        enabled: boolean(value, &["limiter", "enabled"], true),
        threshold_db: number(value, &["limiter", "thresholdDb"], -1.0),
        // HSE 分享码允许 lookahead 0–50ms / release 0–2000ms；HyperPlayer 链路
        // 按 0–20 / 0–1000 门控，超界回落上限而非拒绝整份导入。
        lookahead_ms: number(value, &["limiter", "lookaheadMs"], 5.0).min(20.0),
        attack_ms: number(value, &["limiter", "attackMs"], 0.5),
        release_ms: number(value, &["limiter", "releaseMs"], 150.0).min(1_000.0),
        true_peak: boolean(value, &["limiter", "truePeak"], true),
    };
    // ieq：分析内建（Stage 17 implicit），仅投影参数态（Stage 16）。
    dto.ieq = IeqDto {
        enabled: boolean(value, &["ieq", "enabled"], false),
        strength: number(value, &["ieq", "strength"], 0.5),
        target_curve: match value
            .get("ieq")
            .and_then(|v| v.get("targetCurve"))
            .and_then(Value::as_str)
            .unwrap_or("flat")
        {
            "warm" => IeqTargetCurveDto::Warm,
            "bright" => IeqTargetCurveDto::Bright,
            "vocal" => IeqTargetCurveDto::Vocal,
            _ => IeqTargetCurveDto::Flat,
        },
        time_constant_sec: number(value, &["ieq", "timeConstantSec"], 3.0),
    };
    // modulation：只接受白名单 target（masterGain/stereoWidth），其余 route fail
    // closed并在导入时拒绝（严格 DTO）。
    dto.modulation = ModulationDto {
        enabled: boolean(value, &["modulation", "enabled"], false),
        lfo_shape: match value
            .get("modulation")
            .and_then(|v| v.get("lfo"))
            .and_then(|v| v.get("shape"))
            .and_then(Value::as_str)
            .unwrap_or("sine")
        {
            "triangle" => ModLfoShapeDto::Triangle,
            "square" => ModLfoShapeDto::Square,
            "saw" => ModLfoShapeDto::Saw,
            _ => ModLfoShapeDto::Sine,
        },
        lfo_rate_hz: number(value, &["modulation", "lfo", "rateHz"], 1.0),
        lfo_depth: number(value, &["modulation", "lfo", "depth"], 0.5),
        envelope_attack_ms: number(value, &["modulation", "envelope", "attackMs"], 10.0),
        envelope_release_ms: number(value, &["modulation", "envelope", "releaseMs"], 200.0),
        envelope_amount: number(value, &["modulation", "envelope", "amount"], 0.5),
        routes: value
            .get("modulation")
            .and_then(|v| v.get("routes"))
            .and_then(Value::as_array)
            .map(|routes| {
                routes
                    .iter()
                    .filter_map(|route| {
                        let source = match route.get("source").and_then(Value::as_str) {
                            Some("lfo") => ModRouteSourceDto::Lfo,
                            Some("envelope") => ModRouteSourceDto::Envelope,
                            _ => return None,
                        };
                        let target = match route.get("target").and_then(Value::as_str) {
                            Some("masterGain") => ModRouteTargetDto::MasterGain,
                            Some("stereoWidth") => ModRouteTargetDto::StereoWidth,
                            _ => return None,
                        };
                        Some(ModRouteDto {
                            source,
                            target,
                            depth: number(route, &["amount"], 0.5).abs(),
                            polarity: number(route, &["amount"], 0.5).signum(),
                            smoothing_ms: number(route, &["smoothingMs"], 0.0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
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
    // reverb：algorithmic 段承载 mode=algorithmic/fdn 共用的参数表；卷积只投影
    // mix/preDelayMs/dePeriodize，IR 恒为空引用（确定性配方不进分享码）。
    value["reverb"] = json!({
        "enabled": dto.reverb.enabled,
        "mode": dto.reverb.mode,
        "algorithmic": {
            "type": dto.reverb.reverb_type,
            "roomSize": dto.reverb.room_size,
            "damping": dto.reverb.damping,
            "wet": dto.reverb.wet,
            "dry": dto.reverb.dry,
            "preDelayMs": dto.reverb.pre_delay_ms,
            "width": dto.reverb.width,
        },
        "convolution": {
            "ir": Value::Null,
            "irName": Value::Null,
            "mix": dto.reverb.mix,
            "preDelayMs": dto.reverb.pre_delay_ms,
            "dePeriodize": true,
        },
    });
    value["loudnessCompensation"] = json!({
        "enabled": dto.loudness_comp.enabled,
        "mode": dto.loudness_comp.mode,
        "preset": dto.loudness_comp.preset,
        "bands": dto.loudness_comp.bands,
        "volumePercent": dto.loudness_comp.volume_percent,
        "maxBoostDb": dto.loudness_comp.max_boost_db,
        "smoothingSeconds": dto.loudness_comp.smoothing_seconds,
    });
    // dynamicEq：kneeDb/blockSize/带内频率不在 HSE 分享白名单，导出时省略
    //（导入端按缺省还原）。
    value["dynamicEq"] = json!({
        "enabled": dto.dynamic_eq.enabled,
        "strength": dto.dynamic_eq.strength,
        "thresholdDb": dto.dynamic_eq.threshold_db,
        "ratio": dto.dynamic_eq.ratio,
        "attackMs": dto.dynamic_eq.attack_ms,
        "releaseMs": dto.dynamic_eq.release_ms,
        "bands": dto.dynamic_eq.bands.iter().map(|band| json!({
            "enabled": band.enabled,
            "targetGainDb": band.target_gain_db,
        })).collect::<Vec<_>>(),
    });
    value["limiter"] = json!({
        "enabled": dto.limiter.enabled,
        "thresholdDb": dto.limiter.threshold_db,
        "lookaheadMs": dto.limiter.lookahead_ms,
        "attackMs": dto.limiter.attack_ms,
        "releaseMs": dto.limiter.release_ms,
        "truePeak": dto.limiter.true_peak,
    });
    value["ieq"] = json!({
        "enabled": dto.ieq.enabled,
        "strength": dto.ieq.strength,
        "targetCurve": match dto.ieq.target_curve {
            IeqTargetCurveDto::Warm => "warm",
            IeqTargetCurveDto::Bright => "bright",
            IeqTargetCurveDto::Vocal => "vocal",
            IeqTargetCurveDto::Flat => "flat",
        },
        "timeConstantSec": dto.ieq.time_constant_sec,
    });
    value["modulation"] = json!({
        "enabled": dto.modulation.enabled,
        "lfo": {
            "shape": match dto.modulation.lfo_shape {
                ModLfoShapeDto::Triangle => "triangle",
                ModLfoShapeDto::Square => "square",
                ModLfoShapeDto::Saw => "saw",
                ModLfoShapeDto::Sine => "sine",
            },
            "rateHz": dto.modulation.lfo_rate_hz,
            "depth": dto.modulation.lfo_depth,
        },
        "envelope": {
            "attackMs": dto.modulation.envelope_attack_ms,
            "releaseMs": dto.modulation.envelope_release_ms,
            "amount": dto.modulation.envelope_amount,
        },
        "routes": dto.modulation.routes.iter().map(|route| json!({
            "source": match route.source {
                ModRouteSourceDto::Lfo => "lfo",
                ModRouteSourceDto::Envelope => "envelope",
            },
            "target": match route.target {
                ModRouteTargetDto::MasterGain => "masterGain",
                ModRouteTargetDto::StereoWidth => "stereoWidth",
            },
            "amount": route.polarity * route.depth,
            "smoothingMs": route.smoothing_ms,
        })).collect::<Vec<_>>(),
    });
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
        // 持久化最新 applied 配置（revision 跨进程递增）。写失败不阻断 apply 结果——
        // 磁盘写属 best-effort，播放权威在内存状态；下次启动以内置 default 兜底。
        let _ = state
            .services
            .settings
            .persist_dsp_config(&crate::dto::PersistedDspConfig {
                version: crate::dto::DSP_CONFIG_VERSION,
                revision,
                configuration: dto.clone(),
            });
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
            scope: "current21StageProjection".into(),
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
        assert_eq!(unsupported(), vec!["22:spatialAndHrtf"]);
        // 13/15/18/21 已接线：默认 HSE 参数投影可完整回读（limiter 在 HSE 默认
        // 参数中启用）。
        let mapped = config_from_hse(&hyperplayer_engine::hse_default_params(48_000.0), 2)
            .unwrap()
            .into_engine()
            .unwrap();
        assert!(!mapped.reverb.enabled);
        assert_eq!(mapped.reverb.mode, ReverbMode::Algorithmic);
        assert_eq!(mapped.loudness_comp.mode, LoudnessCompMode::Auto);
        assert!(!mapped.dynamic_eq.enabled);
        assert!(mapped.limiter.enabled);
        assert_eq!(mapped.limiter.threshold_db, -1.0);
    }

    #[test]
    fn new_stage_dtos_roundtrip_through_engine() {
        let mut dto = DspConfigurationDto::from_engine(2, &DspConfig::default());
        dto.reverb.enabled = true;
        dto.reverb.mode = "fdn".into();
        dto.reverb.fdn_lines = 16;
        dto.loudness_comp.enabled = true;
        dto.loudness_comp.mode = "custom".into();
        dto.loudness_comp.bands = vec![LoudnessCompBandDto {
            frequency: 1_000.0,
            gain: 6.0,
        }];
        dto.dynamic_eq.enabled = true;
        dto.dynamic_eq.ratio = 8.0;
        dto.limiter.enabled = true;
        dto.limiter.true_peak = false;
        let config = dto.into_engine().unwrap();
        assert_eq!(config.reverb.mode, ReverbMode::Fdn);
        assert_eq!(config.reverb.fdn_lines, 16);
        assert_eq!(config.loudness_comp.mode, LoudnessCompMode::Custom);
        assert_eq!(config.loudness_comp.bands.len(), 1);
        assert_eq!(config.dynamic_eq.ratio, 8.0);
        assert!(config.limiter.enabled && !config.limiter.true_peak);

        let round_trip = DspConfigurationDto::from_engine(2, &config);
        assert_eq!(round_trip.reverb.mode, "fdn");
        assert_eq!(round_trip.loudness_comp.mode, "custom");
        assert!(!round_trip.limiter.true_peak);
        let back = round_trip.into_engine().unwrap();
        assert_eq!(back.reverb, config.reverb);
        assert_eq!(back.loudness_comp, config.loudness_comp);
        assert_eq!(back.dynamic_eq, config.dynamic_eq);
        assert_eq!(back.limiter, config.limiter);
    }

    #[test]
    fn lufs_meter_mode_roundtrips_and_defaults_to_hse_v151() {
        // 默认模式为 hseV151（兼容）。
        let mut dto = DspConfigurationDto::from_engine(2, &DspConfig::default());
        assert_eq!(dto.lufs_metering.mode, "hseV151");
        let config = dto.clone().into_engine().unwrap();
        assert_eq!(
            config.metering_lufs_mode,
            hyperplayer_engine::dsp_algorithms::lufs_meter::LufsMeterMode::HseV151
        );
        // 标准模式可被显式选择并在 DTO↔引擎间完整往返。
        dto.lufs_metering.mode = "ituBs17705".into();
        let config = dto.clone().into_engine().unwrap();
        assert_eq!(
            config.metering_lufs_mode,
            hyperplayer_engine::dsp_algorithms::lufs_meter::LufsMeterMode::ItuBs1770_5
        );
        let back = DspConfigurationDto::from_engine(3, &config);
        assert_eq!(back.lufs_metering.mode, "ituBs17705");
        // 未知字符串回落兼容默认。
        let mut dto = DspConfigurationDto::from_engine(4, &DspConfig::default());
        dto.lufs_metering.mode = "bogus".into();
        assert_eq!(
            dto.into_engine().unwrap().metering_lufs_mode,
            hyperplayer_engine::dsp_algorithms::lufs_meter::LufsMeterMode::HseV151
        );
    }

    #[test]
    fn new_stage_dtos_reject_out_of_range_values() {
        let reject = |mutate: &dyn Fn(&mut DspConfigurationDto)| {
            let mut dto = DspConfigurationDto::from_engine(2, &DspConfig::default());
            dto.reverb.enabled = true;
            mutate(&mut dto);
            assert!(dto.into_engine().is_err());
        };
        reject(&|dto| dto.reverb.room_size = 1.5);
        reject(&|dto| dto.reverb.fdn_lines = 7);
        reject(&|dto| dto.reverb.mode = "off".into());
        reject(&|dto| dto.reverb.reverb_type = "cathedral".into());

        let mut loudness = DspConfigurationDto::from_engine(2, &DspConfig::default());
        loudness.loudness_comp.volume_percent = 150.0;
        assert!(loudness.into_engine().is_err());
        let mut loudness = DspConfigurationDto::from_engine(2, &DspConfig::default());
        loudness.loudness_comp.preset = "mega".into();
        assert!(loudness.into_engine().is_err());

        let mut dynamic_eq = DspConfigurationDto::from_engine(2, &DspConfig::default());
        dynamic_eq.dynamic_eq.ratio = 0.5;
        assert!(dynamic_eq.into_engine().is_err());
        let mut dynamic_eq = DspConfigurationDto::from_engine(2, &DspConfig::default());
        dynamic_eq.dynamic_eq.block_size = 8.0;
        assert!(dynamic_eq.into_engine().is_err());

        let mut limiter = DspConfigurationDto::from_engine(2, &DspConfig::default());
        limiter.limiter.threshold_db = -70.0;
        assert!(limiter.into_engine().is_err());
        let mut limiter = DspConfigurationDto::from_engine(2, &DspConfig::default());
        limiter.limiter.lookahead_ms = 25.0;
        assert!(limiter.into_engine().is_err());
    }

    #[test]
    fn hse_import_restores_unprojected_reverb_and_dynamic_eq_fields() {
        let mut value = hyperplayer_engine::hse_default_params(48_000.0);
        value["reverb"]["mode"] = json!("convolution");
        value["reverb"]["convolution"]["mix"] = json!(0.8);
        value["reverb"]["enabled"] = json!(true);
        value["dynamicEq"]["bands"][2]["targetGainDb"] = json!(6.0);
        value["loudnessCompensation"]["mode"] = json!("preset");
        value["loudnessCompensation"]["preset"] = json!("night");

        let mapped = config_from_hse(&value, 2).unwrap().into_engine().unwrap();
        // 卷积模式可构造（确定性 IR 配方注入），mix 投影生效。
        assert_eq!(mapped.reverb.mode, ReverbMode::Convolution);
        assert!(mapped.reverb.enabled);
        assert_eq!(mapped.reverb.mix, 0.8);
        // kneeDb/blockSize/带频率不在 HSE 白名单 → 引擎缺省还原。
        assert_eq!(mapped.dynamic_eq.knee_db, 6.0);
        assert_eq!(mapped.dynamic_eq.block_size, 128.0);
        assert_eq!(mapped.dynamic_eq.bands[2].target_gain_db, 6.0);
        assert_eq!(mapped.loudness_comp.preset, "night");
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

    #[test]
    fn hse2_projects_hse_native_amount_losslessly_and_keeps_hp_only_params_as_boundary() {
        // HSE 分享 schema 携带的复合信号（modulation.route.amount = polarity·depth、
        // reverb.convolution.mix）应无损往返。
        let mut dto = DspConfigurationDto::from_engine(2, &DspConfig::default());
        dto.modulation.enabled = true;
        dto.modulation.routes = vec![ModRouteDto {
            source: ModRouteSourceDto::Lfo,
            target: ModRouteTargetDto::MasterGain,
            depth: 0.35,
            polarity: -1.0,
            smoothing_ms: 12.0,
        }];
        dto.reverb.enabled = true;
        dto.reverb.mode = "convolution".into();
        dto.reverb.mix = 0.8;
        dto.reverb.fdn_lines = 16;
        dto.dynamic_eq.knee_db = 9.0;
        dto.dynamic_eq.block_size = 256.0;

        let code = hyperplayer_engine::hse_encode_share_code(&hse_from_config(
            &dto.clone().into_engine().unwrap(),
        ))
        .unwrap();
        let decoded = hyperplayer_engine::hse_decode_share_code(&code).unwrap();
        let round = config_from_hse(&decoded, 3).unwrap().into_engine().unwrap();

        // HSE 原生字段无损返回：amount = polarity·depth 复合量往返一致。
        let route = &round.modulation.routes[0];
        assert_eq!(
            route.source,
            hyperplayer_engine::dsp_algorithms::modulation::ModRouteSource::Lfo
        );
        assert_eq!(route.polarity * route.depth, -0.35);
        assert_eq!(round.reverb.mix, 0.8);
        assert_eq!(round.reverb.mode, ReverbMode::Convolution);
        // HyperPlayer-only 参数不在 HSE 分享白名单，按引擎缺省还原（受控边界）。
        assert_eq!(round.dynamic_eq.knee_db, 6.0);
        assert_eq!(round.dynamic_eq.block_size, 128.0);
    }
}
