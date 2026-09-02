use hse_core::{
    biquad::BiquadStage,
    compressor::CompressorStage,
    convolver::IrRecipe,
    eq_chain::EqBandParam,
    modulation_matrix::{
        EnvelopeParams, LfoParams, LfoShape, ModSource, ModTarget, ModulationMatrixStage,
        ModulationRoute,
    },
    Stage as HseStage,
};
use hyperplayer_engine::dsp::{PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat, ResetReason};
use hyperplayer_engine::dsp_algorithms::bass_enhancer::{BassEnhancerSettings, HarmonicType};
use hyperplayer_engine::dsp_algorithms::chorus::{ChorusProcessor, ChorusSettings};
use hyperplayer_engine::dsp_algorithms::compressor::CompressorSettings;
use hyperplayer_engine::dsp_algorithms::deesser::DeesserSettings;
use hyperplayer_engine::dsp_algorithms::delay::{DelayProcessor, DelaySettings};
use hyperplayer_engine::dsp_algorithms::dynamic_eq::{DynamicEqProcessor, DynamicEqSettings};
use hyperplayer_engine::dsp_algorithms::flanger::{FlangerProcessor, FlangerSettings};
use hyperplayer_engine::dsp_algorithms::limiter::{LimiterProcessor, LimiterSettings};
use hyperplayer_engine::dsp_algorithms::loudness_comp::{
    LoudnessBandParam, LoudnessCompMode, LoudnessCompProcessor, LoudnessCompSettings,
};
use hyperplayer_engine::dsp_algorithms::loudness_normalization::{
    LoudnessNormalizationProcessor, LoudnessNormalizationSettings,
};
use hyperplayer_engine::dsp_algorithms::lufs_meter::{LufsMeterProcessor, SharedLufsState};
use hyperplayer_engine::dsp_algorithms::night_mode::{NightModeProcessor, NightModeSettings};
use hyperplayer_engine::dsp_algorithms::phaser::{PhaserProcessor, PhaserSettings};
use hyperplayer_engine::dsp_algorithms::reverb::{
    ReverbMode, ReverbProcessor, ReverbSettings, ReverbType,
};
use hyperplayer_engine::dsp_algorithms::surround3d::{Surround3dProcessor, Surround3dSettings};
use hyperplayer_engine::dsp_algorithms::tremolo::{TremoloProcessor, TremoloSettings};
use hyperplayer_engine::dsp_algorithms::{
    BassEnhancerProcessor, DeesserProcessor, EqChainConfig, EqChainProcessor, EqStereoMode,
    MidSideProcessor,
};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorMeta {
    schema_version: u32,
    module: String,
    case: String,
    sample_rate: u32,
    block_size: usize,
    channels: u16,
    frames: usize,
    params: Value,
    tolerance: Tolerance,
    source: VectorSource,
}

#[derive(Deserialize)]
struct VectorSource {
    project: String,
    version: String,
    commit: String,
}

#[derive(Deserialize)]
struct Tolerance {
    kind: String,
    value: f64,
    floor: f64,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("tests/fixtures/dsp")
}

fn number(params: &Value, field: &str) -> f64 {
    params[field]
        .as_f64()
        .unwrap_or_else(|| panic!("{field} must be numeric"))
}

fn boolean(params: &Value, field: &str) -> bool {
    params[field]
        .as_bool()
        .unwrap_or_else(|| panic!("{field} must be boolean"))
}

struct VectorCompressor {
    inner: CompressorStage,
    derive_mono_sum: bool,
    left: Vec<f32>,
    right: Vec<f32>,
    side_left: Vec<f32>,
    side_right: Vec<f32>,
}

impl PcmProcessor for VectorCompressor {
    fn name(&self) -> &'static str {
        "compressor-vector-driver"
    }

    fn prepare(
        &mut self,
        format: PcmFormat,
        max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        if format.channels != 2 {
            return Err(hyperplayer_engine::EngineError::Unsupported(
                "compressor vectors require stereo".into(),
            ));
        }
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        self.side_left.resize(max_block_frames, 0.0);
        self.side_right.resize(max_block_frames, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        let frames = block.interleaved.len() / 2;
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
            if self.derive_mono_sum {
                let mono = (f64::from(frame[0]) + f64::from(frame[1])) as f32;
                self.side_left[index] = mono;
                self.side_right[index] = mono;
            }
        }
        if self.derive_mono_sum {
            self.inner.process_with_sidechain(
                &mut self.left[..frames],
                &mut self.right[..frames],
                &self.side_left[..frames],
                &self.side_right[..frames],
            );
        } else {
            self.inner
                .process(&mut self.left[..frames], &mut self.right[..frames]);
        }
        for (index, frame) in block
            .interleaved
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .enumerate()
        {
            frame[0] = self.left[index];
            frame[1] = self.right[index];
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

struct VectorBiquad {
    left: BiquadStage,
    right: BiquadStage,
    left_buffer: Vec<f32>,
    right_buffer: Vec<f32>,
}

impl PcmProcessor for VectorBiquad {
    fn name(&self) -> &'static str {
        "biquad-vector-driver"
    }

    fn prepare(
        &mut self,
        format: PcmFormat,
        max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        if format.channels != 2 {
            return Err(hyperplayer_engine::EngineError::Unsupported(
                "biquad vectors require stereo".into(),
            ));
        }
        self.left_buffer.resize(max_block_frames, 0.0);
        self.right_buffer.resize(max_block_frames, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        let frames = block.interleaved.len() / 2;
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left_buffer[index] = frame[0];
            self.right_buffer[index] = frame[1];
        }
        self.left.process_mono(&mut self.left_buffer[..frames]);
        self.right.process_mono(&mut self.right_buffer[..frames]);
        for (index, frame) in block
            .interleaved
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .enumerate()
        {
            frame[0] = self.left_buffer[index];
            frame[1] = self.right_buffer[index];
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        HseStage::reset(&mut self.left);
        HseStage::reset(&mut self.right);
    }

    fn latency_frames(&self) -> u32 {
        0
    }
    fn tail_frames(&self) -> u32 {
        0
    }
}

#[test]
fn vector_biquad_reset_clears_both_channel_stages() {
    let create = || BiquadStage::new(48_000.0, "peaking", 1_000.0, 1.0, 6.0).unwrap();
    let mut processor = VectorBiquad {
        left: create(),
        right: create(),
        left_buffer: Vec::new(),
        right_buffer: Vec::new(),
    };
    let format = PcmFormat {
        sample_rate: 48_000,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    };
    processor.prepare(format, 4).unwrap();

    let input = [1.0_f32, -0.5, 0.0, 0.0, 0.25, 0.75, 0.0, 0.0];
    let mut first = input;
    processor
        .process(PcmBlock {
            format,
            interleaved: &mut first,
        })
        .unwrap();
    let mut advance_state = input;
    processor
        .process(PcmBlock {
            format,
            interleaved: &mut advance_state,
        })
        .unwrap();

    processor.reset(ResetReason::Seek);
    let mut replay = input;
    processor
        .process(PcmBlock {
            format,
            interleaved: &mut replay,
        })
        .unwrap();

    assert_eq!(replay.map(f32::to_bits), first.map(f32::to_bits));
}

struct VectorLoudnessNormalization {
    normalization: LoudnessNormalizationProcessor,
    meter: LufsMeterProcessor,
}

impl PcmProcessor for VectorLoudnessNormalization {
    fn name(&self) -> &'static str {
        "loudness-normalization-vector-driver"
    }

    fn prepare(
        &mut self,
        format: PcmFormat,
        max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        self.normalization.prepare(format, max_block_frames)?;
        self.meter.prepare(format, max_block_frames)
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        let format = block.format;
        self.normalization.process(PcmBlock {
            format,
            interleaved: block.interleaved,
        })?;
        self.meter.process(block)
    }

    fn reset(&mut self, reason: ResetReason) {
        self.normalization.reset(reason);
        self.meter.reset(reason);
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

/// modulation-matrix 冻结向量驱动器（对齐 `dsp_parity_modulation.rs` 核心
/// 语义，specs/dsp/modulation-matrix.md §4.4）：推进矩阵 + masterGain
/// 逐样本乘；stereoWidth 产物不入向量。
struct VectorModulationMatrix {
    inner: ModulationMatrixStage,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl VectorModulationMatrix {
    fn new(meta: &VectorMeta) -> Self {
        let routes = meta.params["routes"]
            .as_array()
            .expect("routes must be an array")
            .iter()
            .map(|value| ModulationRoute {
                source: match value["source"].as_str().expect("route.source") {
                    "lfo" => ModSource::Lfo,
                    "envelope" => ModSource::Envelope,
                    other => panic!("unsupported route source {other}"),
                },
                target: match value["target"].as_str().expect("route.target") {
                    "masterGain" => ModTarget::MasterGain,
                    "stereoWidth" => ModTarget::StereoWidth,
                    other => panic!("unsupported route target {other}"),
                },
                amount: number(value, "amount"),
                offset: value.get("offset").and_then(Value::as_f64).unwrap_or(0.0),
            })
            .collect::<Vec<_>>();
        let lfo = &meta.params["lfo"];
        let envelope = &meta.params["envelope"];
        let mut inner = ModulationMatrixStage::new(f64::from(meta.sample_rate)).unwrap();
        inner.set_routes(routes);
        inner.set_lfo_params(LfoParams {
            shape: LfoShape::parse(lfo["shape"].as_str().unwrap_or("sine")),
            rate_hz: number(lfo, "rateHz"),
            depth: number(lfo, "depth"),
        });
        inner.set_envelope_params(EnvelopeParams {
            attack_ms: number(envelope, "attackMs"),
            release_ms: number(envelope, "releaseMs"),
            amount: number(envelope, "amount"),
        });
        Self {
            inner,
            left: Vec::new(),
            right: Vec::new(),
        }
    }
}

impl PcmProcessor for VectorModulationMatrix {
    fn name(&self) -> &'static str {
        "modulation-matrix"
    }

    fn prepare(
        &mut self,
        format: PcmFormat,
        max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        if format.channels != 2 {
            return Err(hyperplayer_engine::EngineError::Unsupported(
                "modulation vectors require stereo".into(),
            ));
        }
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        let frames = block.interleaved.len() / 2;
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        let targets = self
            .inner
            .process_block(&self.left[..frames], &self.right[..frames]);
        let gain = targets.master_gain;
        if gain != 1.0 {
            for i in 0..frames {
                self.left[i] = (f64::from(self.left[i]) * gain) as f32;
                self.right[i] = (f64::from(self.right[i]) * gain) as f32;
            }
        }
        for (index, frame) in block
            .interleaved
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .enumerate()
        {
            frame[0] = self.left[index];
            frame[1] = self.right[index];
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn processor(meta: &VectorMeta) -> Box<dyn PcmProcessor> {
    match meta.module.as_str() {
        "biquad" => {
            let filter_type = meta.params["type"].as_str().expect("type must be a string");
            let create = || {
                BiquadStage::new(
                    f64::from(meta.sample_rate),
                    filter_type,
                    number(&meta.params, "f0"),
                    number(&meta.params, "q"),
                    number(&meta.params, "gainDb"),
                )
                .unwrap()
            };
            Box::new(VectorBiquad {
                left: create(),
                right: create(),
                left_buffer: Vec::new(),
                right_buffer: Vec::new(),
            })
        }
        "chorus" => Box::new(
            ChorusProcessor::new(
                f64::from(meta.sample_rate),
                ChorusSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    rate_hz: number(&meta.params, "rateHz"),
                    depth_ms: number(&meta.params, "depthMs"),
                    mix: number(&meta.params, "mix"),
                },
            )
            .unwrap(),
        ),
        "delay" => Box::new(
            DelayProcessor::new(
                f64::from(meta.sample_rate),
                DelaySettings {
                    enabled: boolean(&meta.params, "enabled"),
                    delay_ms: number(&meta.params, "delayMs"),
                    feedback: number(&meta.params, "feedback"),
                    mix: number(&meta.params, "mix"),
                },
            )
            .unwrap(),
        ),
        "flanger" => Box::new(
            FlangerProcessor::new(
                f64::from(meta.sample_rate),
                FlangerSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    rate_hz: number(&meta.params, "rateHz"),
                    depth_ms: number(&meta.params, "depthMs"),
                    feedback: number(&meta.params, "feedback"),
                    mix: number(&meta.params, "mix"),
                },
            )
            .unwrap(),
        ),
        "loudness-normalization" => {
            let shared = Arc::new(SharedLufsState::new());
            let settings = LoudnessNormalizationSettings {
                enabled: boolean(&meta.params, "enabled"),
                target_lufs: number(&meta.params, "targetLufs"),
                max_gain_db: number(&meta.params, "maxGainDb"),
                min_gain_db: number(&meta.params, "minGainDb"),
                use_realtime_meter: boolean(&meta.params, "useRealtimeMeter"),
                external_gain_db: number(&meta.params, "externalGainDb"),
            };
            Box::new(VectorLoudnessNormalization {
                normalization: LoudnessNormalizationProcessor::new(
                    meta.sample_rate,
                    settings,
                    Arc::clone(&shared),
                )
                .unwrap(),
                meter: LufsMeterProcessor::new(meta.sample_rate, shared).unwrap(),
            })
        }
        "night-mode" => {
            let base = &meta.params["compressor"];
            Box::new(
                NightModeProcessor::new(
                    meta.sample_rate,
                    NightModeSettings {
                        enabled: boolean(&meta.params, "enabled"),
                        amount: number(&meta.params, "amount"),
                    },
                    CompressorSettings {
                        enabled: boolean(base, "enabled"),
                        threshold_db: number(base, "thresholdDb"),
                        ratio: number(base, "ratio"),
                        knee_db: number(base, "kneeDb"),
                        attack_ms: number(base, "attackMs"),
                        release_ms: number(base, "releaseMs"),
                        makeup_db: number(base, "makeupDb"),
                        output_gain: number(base, "outputGain"),
                        sidechain_enabled: boolean(base, "sidechainEnabled"),
                    },
                )
                .unwrap(),
            )
        }
        "phaser" => Box::new(
            PhaserProcessor::new(
                f64::from(meta.sample_rate),
                PhaserSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    rate_hz: number(&meta.params, "rateHz"),
                    depth: number(&meta.params, "depth"),
                    feedback: number(&meta.params, "feedback"),
                    mix: number(&meta.params, "mix"),
                    stages: number(&meta.params, "stages"),
                },
            )
            .unwrap(),
        ),
        "tremolo" => Box::new(
            TremoloProcessor::new(
                f64::from(meta.sample_rate),
                TremoloSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    rate_hz: number(&meta.params, "rateHz"),
                    depth: number(&meta.params, "depth"),
                    mix: number(&meta.params, "mix"),
                },
            )
            .unwrap(),
        ),
        "surround3d" => Box::new(
            Surround3dProcessor::with_settings(
                meta.sample_rate,
                Surround3dSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    distance: number(&meta.params, "distance"),
                    speed: number(&meta.params, "speed"),
                    angle: number(&meta.params, "angle"),
                    direction: number(&meta.params, "direction"),
                },
            )
            .unwrap(),
        ),
        "mid-side" => Box::new(MidSideProcessor::new(
            number(&meta.params, "width"),
            number(&meta.params, "voiceBalance"),
        )),
        "compressor" => {
            let settings = CompressorSettings {
                enabled: boolean(&meta.params, "enabled"),
                threshold_db: number(&meta.params, "thresholdDb"),
                ratio: number(&meta.params, "ratio"),
                knee_db: number(&meta.params, "kneeDb"),
                attack_ms: number(&meta.params, "attackMs"),
                release_ms: number(&meta.params, "releaseMs"),
                makeup_db: number(&meta.params, "makeupDb"),
                output_gain: number(&meta.params, "outputGain"),
                sidechain_enabled: boolean(&meta.params, "sidechainEnabled"),
            };
            Box::new(VectorCompressor {
                inner: CompressorStage::from_settings(f64::from(meta.sample_rate), settings.into())
                    .unwrap(),
                derive_mono_sum: settings.sidechain_enabled,
                left: Vec::new(),
                right: Vec::new(),
                side_left: Vec::new(),
                side_right: Vec::new(),
            })
        }
        "deesser" => Box::new(
            DeesserProcessor::new(
                meta.sample_rate,
                DeesserSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    center_hz: number(&meta.params, "centerHz"),
                    q: number(&meta.params, "q"),
                    threshold_db: number(&meta.params, "thresholdDb"),
                    ratio: number(&meta.params, "ratio"),
                    attack_ms: number(&meta.params, "attackMs"),
                    release_ms: number(&meta.params, "releaseMs"),
                    split_band: boolean(&meta.params, "splitBand"),
                    mix: number(&meta.params, "mix"),
                    sidechain_enabled: boolean(&meta.params, "sidechainEnabled"),
                },
            )
            .unwrap(),
        ),
        "bass-enhancer" => Box::new(
            BassEnhancerProcessor::new(
                meta.sample_rate,
                BassEnhancerSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    cutoff_hz: number(&meta.params, "cutoffHz"),
                    q: number(&meta.params, "q"),
                    harmonic_type: match meta.params["harmonicType"].as_str().unwrap() {
                        "odd" => HarmonicType::Odd,
                        "even" => HarmonicType::Even,
                        "atan" => HarmonicType::Atan,
                        "soft" => HarmonicType::Soft,
                        value => panic!("unsupported harmonic type {value}"),
                    },
                    harmonic_gain: number(&meta.params, "harmonicGain"),
                    mix: number(&meta.params, "mix"),
                    level_db: number(&meta.params, "levelDb"),
                    low_boost_db: meta.params.get("lowBoostDb").and_then(Value::as_f64),
                },
            )
            .unwrap(),
        ),
        "eq-chain" => {
            let bands = meta.params["bands"]
                .as_array()
                .expect("bands must be an array")
                .iter()
                .map(|band| EqBandParam {
                    frequency: number(band, "frequency"),
                    gain: number(band, "gain"),
                    q: number(band, "q"),
                })
                .collect::<Vec<_>>();
            Box::new(
                EqChainProcessor::new(
                    meta.sample_rate,
                    EqChainConfig {
                        enabled: true,
                        band_count: number(&meta.params, "bandCount") as usize,
                        q_compensation: boolean(&meta.params, "qCompensation"),
                        stereo_mode: EqStereoMode::HseShared,
                        bands,
                    },
                )
                .unwrap(),
            )
        }
        "loudness-comp" => {
            // 冻结向量按模块恒处理语义回放；enabled 属引擎门控（同 dsp_loudness_comp.rs）。
            let mode = match meta.params["mode"].as_str().unwrap_or("auto") {
                "preset" => LoudnessCompMode::Preset,
                "custom" => LoudnessCompMode::Custom,
                _ => LoudnessCompMode::Auto,
            };
            let bands = meta.params["bands"]
                .as_array()
                .map(|bands| {
                    bands
                        .iter()
                        .map(|band| LoudnessBandParam {
                            frequency: number(band, "frequency"),
                            gain: number(band, "gain"),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Box::new(
                LoudnessCompProcessor::new(
                    meta.sample_rate,
                    LoudnessCompSettings {
                        enabled: true,
                        mode,
                        volume_percent: number(&meta.params, "volumePercent"),
                        max_boost_db: number(&meta.params, "maxBoostDb"),
                        preset: meta.params["preset"].as_str().unwrap_or("flat").to_string(),
                        smoothing_seconds: number(&meta.params, "smoothingSeconds"),
                        bands,
                    },
                )
                .unwrap(),
            )
        }
        "dynamic-eq" => {
            // 输出依赖驱动分块：harness 本就按向量顶层 blockSize 回放（规格 §4.5）。
            let bands = meta.params["bands"]
                .as_array()
                .expect("bands must be an array")
                .iter()
                .map(
                    |band| hyperplayer_engine::dsp_algorithms::dynamic_eq::DynamicEqBandSettings {
                        enabled: boolean(band, "enabled"),
                        frequency: number(band, "frequency"),
                        target_gain_db: number(band, "targetGainDb"),
                    },
                )
                .collect::<Vec<_>>();
            Box::new(
                DynamicEqProcessor::new(
                    meta.sample_rate,
                    DynamicEqSettings {
                        enabled: boolean(&meta.params, "enabled"),
                        strength: number(&meta.params, "strength"),
                        threshold_db: number(&meta.params, "thresholdDb"),
                        ratio: number(&meta.params, "ratio"),
                        knee_db: number(&meta.params, "kneeDb"),
                        attack_ms: number(&meta.params, "attackMs"),
                        release_ms: number(&meta.params, "releaseMs"),
                        block_size: number(&meta.params, "blockSize"),
                        bands: bands.try_into().expect("fixed 5-band array"),
                    },
                )
                .unwrap(),
            )
        }
        "reverb-simple" | "fdn-reverb" | "convolver" => {
            // 冻结向量携带核心侧会被钳制的越界值（如 preDelayMs=1200→1000、
            // wet=4.5→4、clamp01(roomSize/damping)）；适配器按 HyperPlayer 边界
            // fail-closed 拒绝越界，这里先按核心 clamp 语义收进适配器范围，
            // 与向量导出时的核心行为逐值一致。convolver 向量不含算法段字段，
            // 缺失时回落默认值（卷积引擎不消费这些字段）。
            let optional_number = |field: &str, fallback: f64| {
                meta.params
                    .get(field)
                    .and_then(Value::as_f64)
                    .unwrap_or(fallback)
            };
            let shared = ReverbSettings {
                enabled: true,
                room_size: optional_number("roomSize", 0.5).clamp(0.0, 1.0),
                damping: optional_number("damping", 0.5).clamp(0.0, 1.0),
                wet: optional_number("wet", 0.3).clamp(0.0, 4.0),
                dry: optional_number("dry", 0.7).clamp(0.0, 4.0),
                pre_delay_ms: optional_number("preDelayMs", 0.0).clamp(0.0, 1_000.0),
                width: optional_number("width", 1.0).clamp(0.0, 2.0),
                reverb_type: match meta.params["type"].as_str().unwrap_or("hall") {
                    "room" => ReverbType::Room,
                    "plate" => ReverbType::Plate,
                    "spring" => ReverbType::Spring,
                    "stage" => ReverbType::Stage,
                    _ => ReverbType::Hall,
                },
                ..ReverbSettings::default()
            };
            let settings = match meta.module.as_str() {
                "reverb-simple" => ReverbSettings {
                    mode: ReverbMode::Algorithmic,
                    ..shared
                },
                "fdn-reverb" => ReverbSettings {
                    mode: ReverbMode::Fdn,
                    fdn_lines: number(&meta.params, "lines") as u32,
                    ..shared
                },
                _ => ReverbSettings {
                    mode: ReverbMode::Convolution,
                    mix: number(&meta.params, "mix"),
                    pre_delay_ms: shared.pre_delay_ms,
                    partition_size: number(&meta.params, "partitionSize"),
                    long_partition_size: number(&meta.params, "longPartitionSize"),
                    short_region_ms: number(&meta.params, "shortRegionMs"),
                    de_periodize: meta.params["dePeriodize"].as_bool().unwrap_or(true),
                    ir_recipe: Some(match meta.params["ir"]["kind"].as_str().expect("ir.kind") {
                        "delta" => IrRecipe::Delta {
                            delay: number(&meta.params["ir"], "delay"),
                        },
                        "expNoise" => IrRecipe::ExpNoise {
                            length: number(&meta.params["ir"], "length"),
                            seed: meta.params["ir"]["seed"].as_u64().expect("ir.seed") as u32,
                            decay: number(&meta.params["ir"], "decay"),
                            amp: number(&meta.params["ir"], "amp"),
                        },
                        other => panic!("unsupported ir recipe kind {other}"),
                    }),
                    ..shared
                },
            };
            Box::new(ReverbProcessor::new(f64::from(meta.sample_rate), settings).unwrap())
        }
        "limiter" => Box::new(
            LimiterProcessor::new(
                f64::from(meta.sample_rate),
                LimiterSettings {
                    enabled: boolean(&meta.params, "enabled"),
                    threshold_db: number(&meta.params, "thresholdDb"),
                    lookahead_ms: number(&meta.params, "lookaheadMs"),
                    attack_ms: number(&meta.params, "attackMs"),
                    release_ms: number(&meta.params, "releaseMs"),
                    true_peak: boolean(&meta.params, "truePeak"),
                },
            )
            .unwrap(),
        ),
        "modulation-matrix" => Box::new(VectorModulationMatrix::new(meta)),
        module => panic!("unsupported DSP parity module {module}"),
    }
}

fn read_segments(path: &Path, frames: usize) -> [Vec<f32>; 4] {
    let bytes = fs::read(path).unwrap();
    assert_eq!(bytes.len(), frames * 4 * size_of::<f32>());
    let samples = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect::<Vec<_>>();
    std::array::from_fn(|segment| {
        let start = segment * frames;
        samples[start..start + frames].to_vec()
    })
}

fn assert_close(
    label: &str,
    channel: &str,
    actual: &[f32],
    expected: &[f32],
    tolerance: &Tolerance,
) {
    for (index, (&actual, &expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            actual.is_finite(),
            "{label} {channel}[{index}] is not finite"
        );
        let bound = tolerance.value * f64::from(expected).abs().max(tolerance.floor);
        let difference = f64::from(actual).abs_diff(f64::from(expected));
        assert!(
            difference <= bound,
            "{label} {channel}[{index}]: got {actual}, want {expected}, diff {difference}, bound {bound}"
        );
    }
}

trait AbsoluteDifference {
    fn abs_diff(self, other: Self) -> Self;
}

impl AbsoluteDifference for f64 {
    fn abs_diff(self, other: Self) -> Self {
        (self - other).abs()
    }
}

#[test]
fn hse_group_one_matches_shared_frozen_vectors() {
    let root = fixture_root();
    let mut json_paths = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    json_paths.sort();
    assert_eq!(
        json_paths.len(),
        80,
        "migrated DSP stages and Biquad foundation must have 80 vectors"
    );
    for (prefix, expected) in [
        (
            "reverb-simple.",
            &[
                "reverb-simple.case1",
                "reverb-simple.case2",
                "reverb-simple.case3",
            ][..],
        ),
        (
            "fdn-reverb.",
            &[
                "fdn-reverb.case1",
                "fdn-reverb.case2",
                "fdn-reverb.case3",
                "fdn-reverb.case4",
            ][..],
        ),
        (
            "convolver.",
            &[
                "convolver.case1",
                "convolver.case2",
                "convolver.case3",
                "convolver.case4",
            ][..],
        ),
        (
            "loudness-comp.",
            &[
                "loudness-comp.case1",
                "loudness-comp.case2",
                "loudness-comp.case3",
                "loudness-comp.case4",
            ][..],
        ),
        (
            "dynamic-eq.",
            &[
                "dynamic-eq.case1",
                "dynamic-eq.case2",
                "dynamic-eq.case3",
                "dynamic-eq.case4",
            ][..],
        ),
        (
            "limiter.",
            &[
                "limiter.case1",
                "limiter.case2",
                "limiter.case3",
                "limiter.case4",
            ][..],
        ),
        (
            "modulation-matrix.",
            &[
                "modulation-matrix.case1",
                "modulation-matrix.case2",
                "modulation-matrix.case3",
                "modulation-matrix.case4",
            ][..],
        ),
    ] {
        assert_eq!(
            json_paths
                .iter()
                .filter_map(|path| path.file_stem().and_then(|value| value.to_str()))
                .filter(|label| label.starts_with(prefix))
                .collect::<Vec<_>>(),
            expected,
            "{prefix} 向量清单必须完整"
        );
    }
    assert_eq!(
        json_paths
            .iter()
            .filter_map(|path| path.file_stem().and_then(|value| value.to_str()))
            .filter(|label| label.starts_with("phaser."))
            .collect::<Vec<_>>(),
        [
            "phaser.case1",
            "phaser.case2",
            "phaser.case3",
            "phaser.case4"
        ]
    );
    assert_eq!(
        json_paths
            .iter()
            .filter_map(|path| path.file_stem().and_then(|value| value.to_str()))
            .filter(|label| label.starts_with("tremolo."))
            .collect::<Vec<_>>(),
        [
            "tremolo.case1",
            "tremolo.case2",
            "tremolo.case3",
            "tremolo.case4"
        ]
    );

    for json_path in json_paths {
        let meta: VectorMeta = serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(meta.schema_version, 1);
        assert_eq!(meta.channels, 2);
        assert!(meta.frames > 0 && meta.block_size > 0);
        assert_eq!(meta.tolerance.kind, "relative");
        let label = format!("{}.{}", meta.module, meta.case);
        assert_eq!(meta.source.project, "HyperSoundEngine");
        assert_eq!(meta.source.version, "1.5.1");
        assert_eq!(
            meta.source.commit,
            "f7017621b7d84005fbfed8a3c42a119487a17326"
        );
        assert_eq!(
            json_path.file_stem().and_then(|value| value.to_str()),
            Some(label.as_str())
        );
        let segments = read_segments(&json_path.with_extension("f32"), meta.frames);
        let [input_left, input_right, expected_left, expected_right] = segments;
        let mut interleaved = input_left
            .iter()
            .zip(&input_right)
            .flat_map(|(&left, &right)| [left, right])
            .collect::<Vec<_>>();
        let format = PcmFormat {
            sample_rate: meta.sample_rate,
            channels: meta.channels,
            sample_format: PcmSampleFormat::F32,
        };
        let mut processor = processor(&meta);
        processor.prepare(format, meta.block_size).unwrap();
        for chunk in interleaved.chunks_mut(meta.block_size * 2) {
            processor
                .process(hyperplayer_engine::dsp::PcmBlock {
                    format,
                    interleaved: chunk,
                })
                .unwrap();
        }
        let actual_left = interleaved.iter().step_by(2).copied().collect::<Vec<_>>();
        let actual_right = interleaved
            .iter()
            .skip(1)
            .step_by(2)
            .copied()
            .collect::<Vec<_>>();
        assert_close(&label, "L", &actual_left, &expected_left, &meta.tolerance);
        assert_close(&label, "R", &actual_right, &expected_right, &meta.tolerance);
    }
}
