//! HSE v1.5.1 Stage 11 Phaser 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::mod_effects::PhaserEffect` 权威实现；本模块仅负责
//! HyperPlayer 参数快照、生命周期、立体声交错/平面转换和实时缓冲管理。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::mod_effects::{
    PhaserEffect, PhaserRuntimeState as CorePhaserRuntimeState,
    PhaserSettings as CorePhaserSettings,
};

const MAX_TAIL_SECONDS: f64 = 12.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhaserSettings {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth: f64,
    pub feedback: f64,
    pub mix: f64,
    pub stages: f64,
}

impl Default for PhaserSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            rate_hz: 0.5,
            depth: 0.5,
            feedback: 0.4,
            mix: 0.5,
            stages: 4.0,
        }
    }
}

#[derive(Clone)]
struct PhaserRuntimeState {
    sample_rate: f64,
    core: CorePhaserRuntimeState,
}

pub struct PhaserProcessor {
    sample_rate: f64,
    settings: PhaserSettings,
    effect: PhaserEffect,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl PhaserProcessor {
    pub fn new(sample_rate: f64, settings: PhaserSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(settings)?;
        let effect = PhaserEffect::new(sample_rate).map_err(EngineError::InvalidInput)?;
        let mut processor = Self {
            sample_rate,
            settings: PhaserSettings::default(),
            effect,
            left: Vec::new(),
            right: Vec::new(),
        };
        processor.apply_params(settings);
        Ok(processor)
    }

    pub fn settings(&self) -> PhaserSettings {
        self.settings
    }
    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 参数即时生效并保留核心状态；仅从禁用切换为启用时重置核心状态。
    pub fn set_params(&mut self, settings: PhaserSettings) -> Result<()> {
        validate_settings(settings)?;
        let became_active = !self.is_active() && settings.enabled;
        self.apply_params(settings);
        if became_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    fn apply_params(&mut self, settings: PhaserSettings) {
        self.settings = PhaserSettings {
            enabled: settings.enabled,
            rate_hz: settings.rate_hz.clamp(0.01, 20.0),
            depth: settings.depth.clamp(0.0, 1.0),
            feedback: settings.feedback.clamp(0.0, 0.98),
            mix: settings.mix.clamp(0.0, 1.0),
            stages: (settings.stages + 0.5).floor().clamp(2.0, 8.0),
        };
        self.sync_core_params();
    }

    fn sync_core_params(&mut self) {
        self.effect.set_params(CorePhaserSettings {
            enabled: self.settings.enabled,
            rate_hz: self.settings.rate_hz,
            depth: self.settings.depth,
            feedback: self.settings.feedback,
            mix: self.settings.mix,
            stages: self.settings.stages,
        });
    }

    fn reset_runtime_state(&mut self) {
        self.effect.reset();
    }
}

impl PcmProcessor for PhaserProcessor {
    fn name(&self) -> &'static str {
        "phaser"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.is_active() && previous.is_active() {
            return self
                .effect
                .copy_runtime_state_from(&previous.effect)
                .is_ok();
        } else if self.is_active() {
            self.reset_runtime_state();
        }
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(PhaserRuntimeState {
            sample_rate: self.sample_rate,
            core: self.effect.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<PhaserRuntimeState>()
            .is_some_and(|state| state.sample_rate == self.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<PhaserRuntimeState>() else {
            return false;
        };
        self.effect.save_runtime_state(&mut state.core).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<PhaserRuntimeState>() else {
            return false;
        };
        self.effect.restore_runtime_state(&state.core).is_ok()
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
                "phaser requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "phaser block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.is_active() {
            return Ok(());
        }
        for (index, frame) in block.interleaved.chunks_exact(2).enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.effect
            .process_stereo(&mut self.left[..frames], &mut self.right[..frames]);
        for (index, frame) in block.interleaved.chunks_exact_mut(2).enumerate() {
            frame[0] = self.left[index];
            frame[1] = self.right[index];
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.reset_runtime_state();
    }
    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        if !self.is_active() || self.settings.mix == 0.0 {
            return 0;
        }
        (self.sample_rate * MAX_TAIL_SECONDS)
            .ceil()
            .min(f64::from(u32::MAX - 1)) as u32
            + 1
    }
}

fn validate_sample_rate(sample_rate: f64) -> Result<()> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(EngineError::InvalidInput(
            "phaser sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_settings(settings: PhaserSettings) -> Result<()> {
    if [
        settings.rate_hz,
        settings.depth,
        settings.feedback,
        settings.mix,
        settings.stages,
    ]
    .into_iter()
    .any(|value| !value.is_finite())
    {
        return Err(EngineError::InvalidInput(
            "phaser settings must be finite".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "phaser requires stereo PCM".into(),
        ));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "phaser sample rate does not match PCM format".into(),
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
    fn enabled(rate_hz: f64, depth: f64, feedback: f64, mix: f64, stages: f64) -> PhaserSettings {
        PhaserSettings {
            enabled: true,
            rate_hz,
            depth,
            feedback,
            mix,
            stages,
        }
    }
    fn prepared(sample_rate: f64, settings: PhaserSettings, capacity: usize) -> PhaserProcessor {
        let mut processor = PhaserProcessor::new(sample_rate, settings).unwrap();
        processor
            .prepare(format(sample_rate as u32), capacity)
            .unwrap();
        processor
    }
    fn process(processor: &mut PhaserProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate as u32),
            interleaved: samples,
        })
    }
    fn signal(frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|index| {
                let sample = ((index as f64 * 0.37).sin() * 0.7) as f32;
                [sample, -sample * 0.75]
            })
            .collect()
    }

    #[test]
    fn validation_clamping_and_stage_rounding_are_preserved() {
        for rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(PhaserProcessor::new(rate, PhaserSettings::default()).is_err());
        }
        let mut processor = PhaserProcessor::new(48_000.0, PhaserSettings::default()).unwrap();
        processor
            .set_params(enabled(-1.0, 2.0, 4.0, -1.0, 3.5))
            .unwrap();
        assert_eq!(processor.settings(), enabled(0.01, 1.0, 0.98, 0.0, 4.0));
        assert!(processor
            .set_params(enabled(1.0, f64::NAN, 0.4, 0.5, 4.0))
            .is_err());
        assert_eq!(processor.settings(), enabled(0.01, 1.0, 0.98, 0.0, 4.0));
    }

    #[test]
    fn facade_matches_core_and_is_block_invariant() {
        let settings = enabled(1.5, 0.8, 0.5, 0.5, 6.0);
        let mut processor = prepared(44_100.0, settings, 1_024);
        let mut core = PhaserEffect::new(44_100.0).unwrap();
        core.set_params(CorePhaserSettings {
            enabled: true,
            rate_hz: 1.5,
            depth: 0.8,
            feedback: 0.5,
            mix: 0.5,
            stages: 6.0,
        });
        let mut interleaved = signal(1_024);
        let mut left: Vec<_> = interleaved.chunks_exact(2).map(|frame| frame[0]).collect();
        let mut right: Vec<_> = interleaved.chunks_exact(2).map(|frame| frame[1]).collect();
        let mut offset = 0;
        for frames in [333, 333, 333, 25] {
            process(
                &mut processor,
                &mut interleaved[offset * 2..(offset + frames) * 2],
            )
            .unwrap();
            core.process_stereo(
                &mut left[offset..offset + frames],
                &mut right[offset..offset + frames],
            );
            offset += frames;
        }
        let expected: Vec<_> = left
            .into_iter()
            .zip(right)
            .flat_map(|(left, right)| [left, right])
            .collect();
        assert_eq!(interleaved, expected);
    }

    #[test]
    fn lifecycle_migration_and_checkpoints_preserve_core_state() {
        let old = enabled(2.0, 0.8, 0.5, 0.25, 6.0);
        let new = enabled(7.0, 0.2, 0.1, 0.9, 3.0);
        let mut previous = prepared(48_000.0, old, 64);
        let mut reference = prepared(48_000.0, old, 64);
        let mut prefix = signal(37);
        let mut reference_prefix = prefix.clone();
        process(&mut previous, &mut prefix).unwrap();
        process(&mut reference, &mut reference_prefix).unwrap();
        let mut next = prepared(48_000.0, new, 64);
        assert!(next.adopt_runtime_state_from(&mut previous));
        reference.set_params(new).unwrap();
        let mut adopted = signal(19);
        let mut expected = adopted.clone();
        process(&mut next, &mut adopted).unwrap();
        process(&mut reference, &mut expected).unwrap();
        assert_eq!(adopted, expected);
        let checkpoint = next.create_runtime_checkpoint().unwrap();
        let mut first = signal(13);
        process(&mut next, &mut first).unwrap();
        assert!(next.restore_runtime_state(checkpoint.as_ref()));
        let mut replay = signal(13);
        process(&mut next, &mut replay).unwrap();
        assert_eq!(first, replay);
        let mut reusable = next.create_runtime_checkpoint().unwrap();
        let mut advance = signal(7);
        process(&mut next, &mut advance).unwrap();
        assert!(next.save_runtime_state(reusable.as_mut()));
        let mut saved = signal(9);
        process(&mut next, &mut saved).unwrap();
        assert!(next.restore_runtime_state(reusable.as_ref()));
        let mut saved_replay = signal(9);
        process(&mut next, &mut saved_replay).unwrap();
        assert_eq!(saved, saved_replay);
        assert_eq!(next.settings(), new);
        let mut wrong_rate = prepared(44_100.0, new, 64);
        assert!(!wrong_rate.adopt_runtime_state_from(&mut next));
        assert!(!wrong_rate.runtime_checkpoint_compatible(reusable.as_ref()));
        let mut wrong = BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut wrong));
        assert!(!next.restore_runtime_state(&0_u32));
    }

    #[test]
    fn disabled_freezes_and_reenable_restarts() {
        let active = enabled(2.0, 0.8, 0.5, 0.5, 6.0);
        let mut processor = prepared(48_000.0, active, 32);
        let mut prefix = signal(32);
        process(&mut processor, &mut prefix).unwrap();
        processor
            .set_params(PhaserSettings {
                enabled: false,
                ..active
            })
            .unwrap();
        let mut bypassed = signal(8);
        let expected = bypassed.clone();
        process(&mut processor, &mut bypassed).unwrap();
        assert_eq!(bypassed, expected);
        processor.set_params(active).unwrap();
        let mut restarted = signal(8);
        process(&mut processor, &mut restarted).unwrap();
        let mut fresh = prepared(48_000.0, active, 8);
        let mut fresh_output = signal(8);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(restarted, fresh_output);
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.settings(), active);
    }

    #[test]
    fn validates_capacity_and_keeps_tail_policy() {
        let mut processor = prepared(48_000.0, enabled(0.5, 0.5, 0.4, 0.5, 4.0), 2);
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 576_001);
        let mut oversized = signal(3);
        let unchanged = oversized.clone();
        assert!(process(&mut processor, &mut oversized).is_err());
        assert_eq!(oversized, unchanged);
        let mut partial = [0.0; 3];
        assert!(process(&mut processor, &mut partial).is_err());
        assert!(processor
            .prepare(
                PcmFormat {
                    channels: 1,
                    ..format(48_000)
                },
                2
            )
            .is_err());
        processor
            .set_params(enabled(0.5, 0.5, 0.4, 0.0, 4.0))
            .unwrap();
        assert_eq!(processor.tail_frames(), 0);
    }
}
