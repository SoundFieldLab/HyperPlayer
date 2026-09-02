//! HSE v1.5.1 Stage 2 Surround3D 的 HyperPlayer PCM 适配器。
//!
//! DSP 采样数学与相位状态由 `hse_core::surround3d::Surround3dStage` 权威实现；本模块
//! 仅负责产品参数校验、立体声交错/平面转换、生命周期与实时缓冲管理。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::surround3d::{
    Surround3dRuntimeState, Surround3dSettings as CoreSurround3dSettings, Surround3dStage,
};
use hse_core::Stage;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Surround3dSettings {
    pub enabled: bool,
    pub distance: f64,
    pub speed: f64,
    pub angle: f64,
    pub direction: f64,
}

impl Surround3dSettings {
    pub fn validate(&self) -> Result<()> {
        if [self.distance, self.speed, self.angle, self.direction]
            .into_iter()
            .any(|value| !value.is_finite())
            || !matches!(self.direction, -1.0 | 1.0)
        {
            return Err(EngineError::InvalidInput(
                "surround3d settings must be finite and direction must be -1 or 1".into(),
            ));
        }
        Ok(())
    }
}

impl Default for Surround3dSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            distance: 0.5,
            speed: 1.0,
            angle: 0.0,
            direction: 1.0,
        }
    }
}

impl From<Surround3dSettings> for CoreSurround3dSettings {
    fn from(settings: Surround3dSettings) -> Self {
        Self {
            enabled: settings.enabled,
            distance: settings.distance,
            speed: settings.speed,
            angle: settings.angle,
            direction: settings.direction,
        }
    }
}

pub struct Surround3dProcessor {
    sample_rate: u32,
    settings: Surround3dSettings,
    stage: Surround3dStage,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl Surround3dProcessor {
    pub fn new(sample_rate: u32) -> Result<Self> {
        Self::with_settings(sample_rate, Surround3dSettings::default())
    }

    pub fn with_settings(sample_rate: u32, settings: Surround3dSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        settings.validate()?;
        let mut stage =
            Surround3dStage::new(f64::from(sample_rate)).map_err(EngineError::InvalidInput)?;
        stage
            .set_params(settings.into())
            .map_err(EngineError::InvalidInput)?;
        Ok(Self {
            sample_rate,
            settings,
            stage,
            left: Vec::new(),
            right: Vec::new(),
        })
    }

    pub fn settings(&self) -> Surround3dSettings {
        self.settings
    }

    pub fn set_params(&mut self, settings: Surround3dSettings) -> Result<()> {
        settings.validate()?;
        self.stage
            .set_params(settings.into())
            .map_err(EngineError::InvalidInput)?;
        self.settings = settings;
        Ok(())
    }

    pub fn phase(&self) -> f64 {
        self.stage.phase()
    }
}

impl PcmProcessor for Surround3dProcessor {
    fn name(&self) -> &'static str {
        "surround3d"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.settings.enabled && previous.settings.enabled {
            return self.stage.copy_runtime_state_from(&previous.stage).is_ok();
        }
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(self.stage.snapshot_runtime_state()))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<Surround3dRuntimeState>() else {
            return false;
        };
        let mut probe = self.stage.clone();
        probe.restore_runtime_state(state).is_ok()
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<Surround3dRuntimeState>() else {
            return false;
        };
        self.stage.save_runtime_state(state).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<Surround3dRuntimeState>() else {
            return false;
        };
        self.stage.restore_runtime_state(state).is_ok()
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        self.stage.prepare(max_block_frames);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "surround3d requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "surround3d block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.settings.enabled {
            return Ok(());
        }

        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.stage
            .process(&mut self.left[..frames], &mut self.right[..frames]);
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
        self.stage.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn validate_sample_rate(sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(EngineError::InvalidInput(
            "surround3d sample rate must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: u32) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "surround3d requires stereo PCM".into(),
        ));
    }
    if format.sample_rate != sample_rate {
        return Err(EngineError::InvalidInput(
            "surround3d sample rate does not match PCM format".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::{BypassProcessor, PcmSampleFormat};

    fn format(sample_rate: u32) -> PcmFormat {
        PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    fn process(processor: &mut Surround3dProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate),
            interleaved: samples,
        })
    }

    fn prepared(settings: Surround3dSettings) -> Surround3dProcessor {
        let mut processor = Surround3dProcessor::with_settings(48_000, settings).unwrap();
        processor.prepare(format(48_000), 128).unwrap();
        processor
    }

    #[test]
    fn defaults_match_hse_stage_two() {
        let settings = Surround3dSettings::default();
        assert!(!settings.enabled);
        assert_eq!(settings.distance, 0.5);
        assert_eq!(settings.speed, 1.0);
        assert_eq!(settings.angle, 0.0);
        assert_eq!(settings.direction, 1.0);
        assert_eq!(Surround3dProcessor::new(48_000).unwrap().phase(), 0.0);
    }

    #[test]
    fn disabled_is_bit_exact_and_freezes_phase() {
        let mut processor = prepared(Surround3dSettings::default());
        let mut samples = [-0.0_f32, f32::from_bits(1), -0.25, 1.0];
        let expected = samples.map(f32::to_bits);
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(samples.map(f32::to_bits), expected);
        assert_eq!(processor.phase(), 0.0);
    }

    #[test]
    fn adapter_matches_core_planar_output_bit_for_bit() {
        let settings = Surround3dSettings {
            enabled: true,
            distance: 0.4,
            speed: 0.7,
            angle: 11.0,
            direction: -1.0,
        };
        let mut processor = prepared(settings);
        let mut actual = [0.25_f32, -0.75, -0.5, 0.125, 1.0, 0.5];
        process(&mut processor, &mut actual).unwrap();

        let mut core = Surround3dStage::new(48_000.0).unwrap();
        core.set_params(settings.into()).unwrap();
        let mut left = [0.25_f32, -0.5, 1.0];
        let mut right = [-0.75_f32, 0.125, 0.5];
        core.process(&mut left, &mut right);
        let expected = [left[0], right[0], left[1], right[1], left[2], right[2]];
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
        assert_eq!(processor.phase(), core.phase());
    }

    #[test]
    fn reset_replays_initial_block() {
        let settings = Surround3dSettings {
            enabled: true,
            ..Surround3dSettings::default()
        };
        let mut processor = Surround3dProcessor::with_settings(44_100, settings).unwrap();
        processor.prepare(format(44_100), 2).unwrap();
        let input = [0.5_f32, -0.25, 0.75, 0.125];
        let mut first = input;
        process(&mut processor, &mut first).unwrap();
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.phase(), 0.0);
        let mut replay = input;
        process(&mut processor, &mut replay).unwrap();
        assert_eq!(replay.map(f32::to_bits), first.map(f32::to_bits));
    }

    #[test]
    fn rejects_nonfinite_settings_and_invalid_direction_without_range_clamps() {
        let base = Surround3dSettings::default();
        for settings in [
            Surround3dSettings {
                distance: f64::NAN,
                ..base
            },
            Surround3dSettings {
                speed: f64::INFINITY,
                ..base
            },
            Surround3dSettings {
                angle: f64::NEG_INFINITY,
                ..base
            },
            Surround3dSettings {
                direction: f64::NAN,
                ..base
            },
        ] {
            assert!(Surround3dProcessor::with_settings(48_000, settings).is_err());
        }
        assert!(Surround3dProcessor::with_settings(
            48_000,
            Surround3dSettings {
                distance: -3.0,
                speed: -2.0,
                angle: 720.0,
                direction: 1.0,
                ..base
            },
        )
        .is_ok());
        assert!(Surround3dProcessor::with_settings(
            48_000,
            Surround3dSettings {
                direction: 4.0,
                ..base
            },
        )
        .is_err());
        assert!(Surround3dProcessor::new(0).is_err());
    }

    #[test]
    fn adopts_phase_only_when_both_revisions_are_enabled() {
        let old_settings = Surround3dSettings {
            enabled: true,
            ..Surround3dSettings::default()
        };
        let mut previous = prepared(old_settings);
        let mut samples = [0.25_f32, -0.5, 0.25, -0.5, 0.25, -0.5, 0.25, -0.5];
        process(&mut previous, &mut samples).unwrap();
        let expected_phase = previous.phase();

        let enabled_settings = Surround3dSettings {
            enabled: true,
            speed: 2.5,
            angle: 90.0,
            ..Surround3dSettings::default()
        };
        let mut enabled_next = prepared(enabled_settings);
        assert!(enabled_next.adopt_runtime_state_from(&mut previous));
        assert_eq!(enabled_next.phase(), expected_phase);
        assert_eq!(enabled_next.settings(), enabled_settings);

        let disabled_settings = Surround3dSettings {
            enabled: false,
            ..enabled_settings
        };
        let mut disabled_next = prepared(disabled_settings);
        assert!(disabled_next.adopt_runtime_state_from(&mut previous));
        assert_eq!(disabled_next.phase(), 0.0);

        previous.set_params(disabled_settings).unwrap();
        assert_eq!(previous.phase(), expected_phase);
        let mut reenabled = prepared(enabled_settings);
        assert!(reenabled.adopt_runtime_state_from(&mut previous));
        assert_eq!(reenabled.phase(), 0.0);

        let mut disabled_from_disabled = prepared(disabled_settings);
        assert!(disabled_from_disabled.adopt_runtime_state_from(&mut previous));
        assert_eq!(disabled_from_disabled.phase(), 0.0);

        let mut bypass = BypassProcessor;
        assert!(!reenabled.adopt_runtime_state_from(&mut bypass));
    }

    #[test]
    fn checkpoint_restore_preserves_settings_and_replays() {
        let settings = Surround3dSettings {
            enabled: true,
            speed: 1.25,
            ..Surround3dSettings::default()
        };
        let mut processor = prepared(settings);
        process(&mut processor, &mut [0.25, -0.5, 0.75, 0.125]).unwrap();
        let mut checkpoint = processor.create_runtime_checkpoint().unwrap();
        assert!(processor.save_runtime_state(checkpoint.as_mut()));

        let input = [0.2_f32, -0.3, 0.4, 0.1];
        let mut expected = input;
        process(&mut processor, &mut expected).unwrap();
        assert!(processor.restore_runtime_state(checkpoint.as_ref()));
        assert_eq!(processor.settings(), settings);
        let mut actual = input;
        process(&mut processor, &mut actual).unwrap();
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    #[test]
    fn process_rejects_unprepared_capacity_incomplete_frames_and_format_mismatch() {
        let mut processor = Surround3dProcessor::new(48_000).unwrap();
        let mut complete = [0.0_f32; 2];
        assert!(process(&mut processor, &mut complete).is_err());
        processor.prepare(format(48_000), 2).unwrap();
        let mut partial = [0.0_f32; 3];
        assert!(process(&mut processor, &mut partial).is_err());
        assert!(processor.prepare(format(44_100), 128).is_err());

        let mut mono = [0.0_f32; 2];
        assert!(processor
            .process(PcmBlock {
                format: PcmFormat {
                    channels: 1,
                    ..format(48_000)
                },
                interleaved: &mut mono,
            })
            .is_err());
    }
}
