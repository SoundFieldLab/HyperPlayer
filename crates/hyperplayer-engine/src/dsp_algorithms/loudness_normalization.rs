//! HSE v1.5.1 第 1 级响度归一化播放链适配。
//!
//! 增益、平滑和采样写回由 `hse_core::loudness_normalization` 权威实现；本模块只负责
//! PCM 格式检查、交错/平面转换、每块一次原子读数桥接与 revision/checkpoint 适配。

use super::lufs_meter::SharedLufsState;
use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
pub use hse_core::loudness_normalization::LoudnessNormalizationSettings;
use hse_core::loudness_normalization::{
    LoudnessNormalizationReadings, LoudnessNormalizationRuntimeState, LoudnessNormalizationStage,
};
use std::sync::Arc;

pub struct LoudnessNormalizationProcessor {
    sample_rate: u32,
    core: LoudnessNormalizationStage,
    shared: Arc<SharedLufsState>,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl LoudnessNormalizationProcessor {
    pub fn new(
        sample_rate: u32,
        settings: LoudnessNormalizationSettings,
        shared: Arc<SharedLufsState>,
    ) -> Result<Self> {
        let mut core = LoudnessNormalizationStage::new(f64::from(sample_rate))
            .map_err(EngineError::InvalidInput)?;
        core.set_params(settings)
            .map_err(EngineError::InvalidInput)?;
        Ok(Self {
            sample_rate,
            core,
            shared,
            left: Vec::new(),
            right: Vec::new(),
        })
    }

    pub fn gain(&self) -> f64 {
        self.core.gain()
    }

    pub fn settings(&self) -> LoudnessNormalizationSettings {
        self.core.settings()
    }

    pub fn set_settings(&mut self, settings: LoudnessNormalizationSettings) -> Result<()> {
        self.core
            .set_params(settings)
            .map_err(EngineError::InvalidInput)
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
        if !self.core.settings().enabled {
            return true;
        }
        self.core.copy_runtime_state_from(&previous.core).is_ok()
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(self.core.snapshot_runtime_state()))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<LoudnessNormalizationRuntimeState>()
            .is_some_and(|state| {
                let mut probe = self.core.clone();
                probe.restore_runtime_state(state).is_ok()
            })
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        state
            .downcast_mut::<LoudnessNormalizationRuntimeState>()
            .is_some_and(|state| self.core.save_runtime_state(state).is_ok())
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<LoudnessNormalizationRuntimeState>()
            .is_some_and(|state| self.core.restore_runtime_state(state).is_ok())
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "loudness normalization requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if !self.core.settings().enabled {
            return Ok(());
        }
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "loudness normalization block exceeds the prepared frame capacity".into(),
            ));
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        let (integrated_lufs, momentary_lufs) = self.shared.realtime_loudness();
        self.core.process(
            &mut self.left[..frames],
            &mut self.right[..frames],
            LoudnessNormalizationReadings {
                integrated_lufs,
                momentary_lufs,
            },
        );
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
        self.core.reset();
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
    fn adapter_matches_core_manual_processing_bit_for_bit() {
        let shared = Arc::new(SharedLufsState::new());
        let settings = LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: 6.0,
            ..LoudnessNormalizationSettings::default()
        };
        let mut processor =
            LoudnessNormalizationProcessor::new(48_000, settings, Arc::clone(&shared)).unwrap();
        processor.prepare(format(), 2).unwrap();
        let mut samples = [0.25_f32, -0.5, 0.75, -1.0];
        processor
            .process(PcmBlock {
                format: format(),
                interleaved: &mut samples,
            })
            .unwrap();

        let mut core = LoudnessNormalizationStage::new(48_000.0).unwrap();
        core.set_params(settings).unwrap();
        let mut left = [0.25_f32, 0.75];
        let mut right = [-0.5_f32, -1.0];
        core.process(
            &mut left,
            &mut right,
            LoudnessNormalizationReadings::unmeasured(),
        );
        assert_eq!(
            samples.map(f32::to_bits),
            [
                left[0].to_bits(),
                right[0].to_bits(),
                left[1].to_bits(),
                right[1].to_bits(),
            ]
        );
        assert_eq!(processor.gain().to_bits(), core.gain().to_bits());
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
    fn checkpoint_and_revision_preserve_gain_but_keep_new_parameters() {
        let shared = Arc::new(SharedLufsState::new());
        let settings = LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: 6.0,
            ..LoudnessNormalizationSettings::default()
        };
        let mut source =
            LoudnessNormalizationProcessor::new(48_000, settings, Arc::clone(&shared)).unwrap();
        source.prepare(format(), 2).unwrap();
        source
            .process(PcmBlock {
                format: format(),
                interleaved: &mut [0.25_f32; 4],
            })
            .unwrap();
        let saved_gain = source.gain();
        let mut checkpoint = source.create_runtime_checkpoint().unwrap();
        assert!(source.save_runtime_state(checkpoint.as_mut()));

        let next_settings = LoudnessNormalizationSettings {
            external_gain_db: -3.0,
            ..settings
        };
        let mut restored =
            LoudnessNormalizationProcessor::new(48_000, next_settings, Arc::clone(&shared))
                .unwrap();
        assert!(restored.restore_runtime_state(checkpoint.as_ref()));
        assert_eq!(restored.gain(), saved_gain);
        assert_eq!(restored.settings(), next_settings);

        let mut adopted =
            LoudnessNormalizationProcessor::new(48_000, next_settings, shared).unwrap();
        assert!(adopted.adopt_runtime_state_from(&mut source));
        assert_eq!(adopted.gain(), saved_gain);
        assert_eq!(adopted.settings(), next_settings);

        let mut disabled = LoudnessNormalizationProcessor::new(
            48_000,
            LoudnessNormalizationSettings::default(),
            Arc::new(SharedLufsState::new()),
        )
        .unwrap();
        assert!(disabled.adopt_runtime_state_from(&mut source));
        assert_eq!(disabled.gain(), 1.0);
    }
}
