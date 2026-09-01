use hse_core::{biquad::BiquadStage, Stage as HseStage};
use hyperplayer_engine::dsp::{PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat, ResetReason};
use hyperplayer_engine::dsp_algorithms::bass_enhancer::{BassEnhancerSettings, HarmonicType};
use hyperplayer_engine::dsp_algorithms::chorus::{ChorusProcessor, ChorusSettings};
use hyperplayer_engine::dsp_algorithms::compressor::{Compressor, CompressorSettings};
use hyperplayer_engine::dsp_algorithms::deesser::DeesserSettings;
use hyperplayer_engine::dsp_algorithms::delay::{DelayProcessor, DelaySettings};
use hyperplayer_engine::dsp_algorithms::eq_chain::EqBandParam;
use hyperplayer_engine::dsp_algorithms::flanger::{FlangerProcessor, FlangerSettings};
use hyperplayer_engine::dsp_algorithms::loudness_normalization::{
    LoudnessNormalizationProcessor, LoudnessNormalizationSettings,
};
use hyperplayer_engine::dsp_algorithms::lufs_meter::{LufsMeterProcessor, SharedLufsState};
use hyperplayer_engine::dsp_algorithms::night_mode::{NightModeProcessor, NightModeSettings};
use hyperplayer_engine::dsp_algorithms::phaser::{PhaserProcessor, PhaserSettings};
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
    source: Option<VectorSource>,
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
    inner: Compressor,
    derive_mono_sum: bool,
    sidechain: Vec<f32>,
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
        self.sidechain.resize(max_block_frames * 2, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        if self.derive_mono_sum {
            for (frame, side) in block
                .interleaved
                .as_chunks::<2>()
                .0
                .iter()
                .zip(self.sidechain.as_chunks_mut::<2>().0.iter_mut())
            {
                let mono = (f64::from(frame[0]) + f64::from(frame[1])) as f32;
                side.copy_from_slice(&[mono, mono]);
            }
            self.inner.process_interleaved_stereo_with_sidechain(
                block.interleaved,
                &self.sidechain[..block.interleaved.len()],
            );
        } else {
            self.inner.process_interleaved_stereo(block.interleaved);
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
                inner: Compressor::with_settings(f64::from(meta.sample_rate), settings).unwrap(),
                derive_mono_sum: settings.sidechain_enabled,
                sidechain: Vec::new(),
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
        53,
        "migrated DSP stages and Biquad foundation must have 53 vectors"
    );
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
        if matches!(
            meta.module.as_str(),
            "night-mode" | "delay" | "chorus" | "flanger" | "phaser" | "tremolo"
        ) {
            let source = meta
                .source
                .as_ref()
                .expect("HSE-derived vector source is required");
            assert_eq!(source.project, "HyperSoundEngine");
            assert_eq!(source.version, "1.5.1");
            assert_eq!(source.commit, "f7017621b7d84005fbfed8a3c42a119487a17326");
        }
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
