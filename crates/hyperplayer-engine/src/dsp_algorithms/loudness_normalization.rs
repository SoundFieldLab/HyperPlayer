//! HSE v1.5.1 第 1 级响度归一化与播放链适配。

use super::lufs_meter::SharedLufsState;
use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use std::sync::Arc;

const REALTIME_SMOOTH_SECONDS: f64 = 3.0;
const MANUAL_SMOOTH_SECONDS: f64 = 0.08;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessNormalizationSettings {
    pub enabled: bool,
    pub target_lufs: f64,
    pub max_gain_db: f64,
    pub min_gain_db: f64,
    pub use_realtime_meter: bool,
    pub external_gain_db: f64,
}

impl Default for LoudnessNormalizationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            target_lufs: -14.0,
            max_gain_db: 9.0,
            min_gain_db: -9.0,
            use_realtime_meter: true,
            external_gain_db: 0.0,
        }
    }
}

impl LoudnessNormalizationSettings {
    pub fn validate(self) -> Result<Self> {
        for (name, value) in [
            ("target_lufs", self.target_lufs),
            ("max_gain_db", self.max_gain_db),
            ("min_gain_db", self.min_gain_db),
            ("external_gain_db", self.external_gain_db),
        ] {
            if !value.is_finite() {
                return Err(EngineError::InvalidInput(format!(
                    "loudness normalization {name} must be finite"
                )));
            }
        }
        if !(-40.0..=0.0).contains(&self.target_lufs) {
            return Err(EngineError::InvalidInput(
                "loudness normalization target_lufs must be between -40 and 0".into(),
            ));
        }
        if !(0.0..=24.0).contains(&self.max_gain_db) {
            return Err(EngineError::InvalidInput(
                "loudness normalization max_gain_db must be between 0 and 24".into(),
            ));
        }
        if !(-24.0..=0.0).contains(&self.min_gain_db) {
            return Err(EngineError::InvalidInput(
                "loudness normalization min_gain_db must be between -24 and 0".into(),
            ));
        }
        if !(-24.0..=24.0).contains(&self.external_gain_db) {
            return Err(EngineError::InvalidInput(
                "loudness normalization external_gain_db must be between -24 and 24".into(),
            ));
        }
        if self.min_gain_db > self.max_gain_db {
            return Err(EngineError::InvalidInput(
                "loudness normalization min_gain_db cannot exceed max_gain_db".into(),
            ));
        }
        Ok(self)
    }
}

/// 第 1 级归一化处理器。
///
/// 与后置 `LufsMeterProcessor` 共用原子快照。此处理器在块首读取一次，因此后置 tap 在
/// 当前块末发布的读数只能从下一块开始生效，保持 HSE 主链的 prior-block 语义。
pub struct LoudnessNormalizationProcessor {
    sample_rate: u32,
    settings: LoudnessNormalizationSettings,
    shared: Arc<SharedLufsState>,
    gain: f64,
}

impl LoudnessNormalizationProcessor {
    pub fn new(
        sample_rate: u32,
        settings: LoudnessNormalizationSettings,
        shared: Arc<SharedLufsState>,
    ) -> Result<Self> {
        if sample_rate == 0 {
            return Err(EngineError::InvalidInput(
                "loudness normalization sample rate must be greater than zero".into(),
            ));
        }
        let settings = settings.validate()?;
        Ok(Self {
            sample_rate,
            settings,
            shared,
            gain: 1.0,
        })
    }

    pub fn gain(&self) -> f64 {
        self.gain
    }

    pub fn settings(&self) -> LoudnessNormalizationSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: LoudnessNormalizationSettings) -> Result<()> {
        let settings = settings.validate()?;
        if !settings.enabled {
            self.gain = 1.0;
        }
        self.settings = settings;
        Ok(())
    }

    fn process_samples(&mut self, samples: &mut [f32]) {
        if !self.settings.enabled {
            return;
        }
        let frames = samples.len() / 2;
        let (gain_db, seconds) = if self.settings.use_realtime_meter {
            let (integrated_lufs, momentary_lufs) = self.shared.realtime_loudness();
            let measured = if integrated_lufs.is_finite() {
                integrated_lufs
            } else {
                momentary_lufs
            };
            let gain_db = if measured.is_finite() {
                (self.settings.target_lufs - measured)
                    .clamp(self.settings.min_gain_db, self.settings.max_gain_db)
            } else {
                0.0
            };
            (gain_db, REALTIME_SMOOTH_SECONDS)
        } else {
            (
                self.settings
                    .external_gain_db
                    .clamp(self.settings.min_gain_db, self.settings.max_gain_db),
                MANUAL_SMOOTH_SECONDS,
            )
        };
        let alpha = 1.0 - (-(frames as f64 / f64::from(self.sample_rate)) / seconds).exp();
        self.gain += alpha * (10.0_f64.powf(gain_db / 20.0) - self.gain);
        for frame in samples.chunks_exact_mut(2) {
            frame[0] = (f64::from(frame[0]) * self.gain) as f32;
            frame[1] = (f64::from(frame[1]) * self.gain) as f32;
        }
    }
}

impl PcmProcessor for LoudnessNormalizationProcessor {
    fn name(&self) -> &'static str {
        "loudness-normalization"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous
            .as_any_mut()
            .downcast_mut::<LoudnessNormalizationProcessor>()
        else {
            return false;
        };
        if self.settings.enabled {
            self.gain = previous.gain;
        }
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(self.gain))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state.is::<f64>()
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(gain) = state.downcast_mut::<f64>() else {
            return false;
        };
        *gain = self.gain;
        true
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(gain) = state.downcast_ref::<f64>() else {
            return false;
        };
        self.gain = *gain;
        true
    }

    fn prepare(&mut self, format: PcmFormat, _max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "loudness normalization requires complete stereo frames".into(),
            ));
        }
        self.process_samples(block.interleaved);
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.gain = 1.0;
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn validate_stereo_format(format: PcmFormat, sample_rate: u32) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "loudness normalization requires stereo PCM".into(),
        ));
    }
    if format.sample_rate != sample_rate {
        return Err(EngineError::InvalidInput(
            "loudness normalization sample rate does not match PCM format".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::{PcmProcessor, PcmSampleFormat};
    use crate::dsp_algorithms::lufs_meter::LufsMeterProcessor;

    fn format() -> PcmFormat {
        PcmFormat {
            sample_rate: 48_000,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    #[test]
    fn defaults_and_validation_match_hse_contract() {
        let defaults = LoudnessNormalizationSettings::default();
        assert_eq!(defaults.target_lufs, -14.0);
        assert_eq!(defaults.max_gain_db, 9.0);
        assert_eq!(defaults.min_gain_db, -9.0);
        assert!(defaults.use_realtime_meter);
        assert_eq!(defaults.external_gain_db, 0.0);
        assert!(defaults.validate().is_ok());
        assert!(LoudnessNormalizationSettings {
            target_lufs: f64::NAN,
            ..defaults
        }
        .validate()
        .is_err());
        assert!(LoudnessNormalizationSettings {
            min_gain_db: 1.0,
            ..defaults
        }
        .validate()
        .is_err());
    }

    #[test]
    fn manual_branch_uses_exact_block_smoothing_and_f32_write_boundary() {
        let shared = Arc::new(SharedLufsState::new());
        let settings = LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: 6.0,
            ..LoudnessNormalizationSettings::default()
        };
        let mut processor = LoudnessNormalizationProcessor::new(48_000, settings, shared).unwrap();
        let mut samples = [0.25_f32, -0.5, 0.75, -1.0];
        processor
            .process(PcmBlock {
                format: format(),
                interleaved: &mut samples,
            })
            .unwrap();
        let alpha = 1.0 - (-(2.0_f64 / 48_000.0) / 0.08).exp();
        let gain = 1.0 + alpha * (10.0_f64.powf(6.0 / 20.0) - 1.0);
        assert_eq!(processor.gain().to_bits(), gain.to_bits());
        assert_eq!(
            samples[0].to_bits(),
            ((f64::from(0.25_f32) * gain) as f32).to_bits()
        );
        assert_eq!(samples[1], (f64::from(-0.5_f32) * gain) as f32);
    }

    #[test]
    fn realtime_meter_reading_starts_on_the_following_block() {
        let shared = Arc::new(SharedLufsState::new());
        let settings = LoudnessNormalizationSettings {
            enabled: true,
            ..LoudnessNormalizationSettings::default()
        };
        let mut normalization =
            LoudnessNormalizationProcessor::new(48_000, settings, Arc::clone(&shared)).unwrap();
        let mut meter = LufsMeterProcessor::new(48_000, shared).unwrap();
        normalization.prepare(format(), 128).unwrap();
        meter.prepare(format(), 128).unwrap();

        for _ in 0..150 {
            let mut block = vec![0.1_f32; 256];
            normalization
                .process(PcmBlock {
                    format: format(),
                    interleaved: &mut block,
                })
                .unwrap();
            assert_eq!(normalization.gain(), 1.0);
            meter
                .process(PcmBlock {
                    format: format(),
                    interleaved: &mut block,
                })
                .unwrap();
        }

        let mut next = vec![0.1_f32; 256];
        normalization
            .process(PcmBlock {
                format: format(),
                interleaved: &mut next,
            })
            .unwrap();
        assert_ne!(normalization.gain(), 1.0);
    }

    #[test]
    fn reset_and_disable_restore_unity_gain() {
        let shared = Arc::new(SharedLufsState::new());
        let settings = LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: 9.0,
            ..LoudnessNormalizationSettings::default()
        };
        let mut processor = LoudnessNormalizationProcessor::new(48_000, settings, shared).unwrap();
        let mut samples = [1.0_f32, 1.0];
        processor.process_samples(&mut samples);
        assert_ne!(processor.gain(), 1.0);
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.gain(), 1.0);
        processor
            .set_settings(LoudnessNormalizationSettings::default())
            .unwrap();
        assert_eq!(processor.gain(), 1.0);
    }
}
