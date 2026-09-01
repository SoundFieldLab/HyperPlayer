//! HSE v1.5.1 Stage 2 轻量 3D 环绕立体声旋转。
//!
//! 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
//! (`f7017621b7d84005fbfed8a3c42a119487a17326`)。每块只计算一次旋转矩阵，
//! 中间计算保持 `f64`，只在写回交错 PCM 时量化为 `f32`。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};

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

pub struct Surround3dProcessor {
    sample_rate: u32,
    settings: Surround3dSettings,
    phase: f64,
}

impl Surround3dProcessor {
    pub fn new(sample_rate: u32) -> Result<Self> {
        Self::with_settings(sample_rate, Surround3dSettings::default())
    }

    pub fn with_settings(sample_rate: u32, settings: Surround3dSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        settings.validate()?;
        Ok(Self {
            sample_rate,
            settings,
            phase: 0.0,
        })
    }

    pub fn settings(&self) -> Surround3dSettings {
        self.settings
    }

    pub fn set_params(&mut self, settings: Surround3dSettings) -> Result<()> {
        settings.validate()?;
        self.settings = settings;
        Ok(())
    }

    pub fn phase(&self) -> f64 {
        self.phase
    }

    fn process_samples(&mut self, samples: &mut [f32]) {
        if !self.settings.enabled {
            return;
        }

        let frames = samples.len() / 2;
        self.phase += std::f64::consts::TAU
            * self.settings.speed
            * (frames as f64 / f64::from(self.sample_rate))
            * 0.125;
        let theta = self.settings.angle * std::f64::consts::PI / 180.0
            + self.settings.direction * self.phase;
        let cosine = theta.cos();
        let sine = theta.sin();
        let scale = 0.5 + 0.5 * self.settings.distance;

        for frame in samples.as_chunks_mut::<2>().0.iter_mut() {
            let left = f64::from(frame[0]);
            let right = f64::from(frame[1]);
            frame[0] = ((left * cosine - right * sine) * scale) as f32;
            frame[1] = ((left * sine + right * cosine) * scale) as f32;
        }
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
        self.phase = previous.phase;
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(self.phase))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state.is::<f64>()
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(phase) = state.downcast_mut::<f64>() else {
            return false;
        };
        *phase = self.phase;
        true
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(phase) = state.downcast_ref::<f64>() else {
            return false;
        };
        self.phase = *phase;
        true
    }

    fn prepare(&mut self, format: PcmFormat, _max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "surround3d requires complete stereo frames".into(),
            ));
        }
        self.process_samples(block.interleaved);
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.phase = 0.0;
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
        let mut processor = Surround3dProcessor::new(48_000).unwrap();
        let mut samples = [-0.0_f32, f32::from_bits(1), -0.25, 1.0];
        let expected = samples.map(f32::to_bits);
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(samples.map(f32::to_bits), expected);
        assert_eq!(processor.phase(), 0.0);
    }

    #[test]
    fn first_block_advances_before_one_matrix_including_short_block() {
        let settings = Surround3dSettings {
            enabled: true,
            distance: 0.4,
            speed: 0.7,
            angle: 11.0,
            direction: -1.0,
        };
        let mut processor = Surround3dProcessor::with_settings(48_000, settings).unwrap();
        let input = [0.25_f32, -0.75, -0.5, 0.125, 1.0, 0.5];
        let mut actual = input;
        process(&mut processor, &mut actual).unwrap();

        let phase = std::f64::consts::TAU * 0.7 * (3.0 / 48_000.0) * 0.125;
        let theta = 11.0 * std::f64::consts::PI / 180.0 - phase;
        let (sine, cosine) = theta.sin_cos();
        let scale = 0.7;
        let mut expected = input;
        for frame in expected.as_chunks_mut::<2>().0.iter_mut() {
            let left = f64::from(frame[0]);
            let right = f64::from(frame[1]);
            frame[0] = ((left * cosine - right * sine) * scale) as f32;
            frame[1] = ((left * sine + right * cosine) * scale) as f32;
        }

        assert_eq!(processor.phase(), phase);
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    #[test]
    fn reset_replays_initial_block() {
        let settings = Surround3dSettings {
            enabled: true,
            ..Surround3dSettings::default()
        };
        let mut processor = Surround3dProcessor::with_settings(44_100, settings).unwrap();
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
    fn adopts_phase_across_parameter_revision() {
        let old_settings = Surround3dSettings {
            enabled: true,
            ..Surround3dSettings::default()
        };
        let mut previous = Surround3dProcessor::with_settings(48_000, old_settings).unwrap();
        let mut samples = [
            0.25_f32, -0.5, 0.25, -0.5, 0.25, -0.5, 0.25, -0.5, 0.25, -0.5, 0.25, -0.5, 0.25, -0.5,
            0.25, -0.5,
        ];
        process(&mut previous, &mut samples).unwrap();
        let expected_phase = previous.phase();

        let new_settings = Surround3dSettings {
            enabled: false,
            speed: 2.5,
            angle: 90.0,
            ..Surround3dSettings::default()
        };
        let mut next = Surround3dProcessor::with_settings(48_000, new_settings).unwrap();
        assert!(next.adopt_runtime_state_from(&mut previous));
        assert_eq!(next.phase(), expected_phase);
        assert_eq!(next.settings(), new_settings);

        let mut bypass = BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut bypass));
    }

    #[test]
    fn process_rejects_incomplete_frames_and_format_mismatch() {
        let mut processor = Surround3dProcessor::new(48_000).unwrap();
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
