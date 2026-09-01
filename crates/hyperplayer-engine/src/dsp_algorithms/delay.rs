//! HSE v1.5.1 Stage 8 Delay 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::mod_effects::DelayEffect` 权威实现；本模块仅负责
//! HyperPlayer 参数快照、生命周期、立体声交错/平面转换和实时缓冲管理。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::mod_effects::{
    DelayEffect, DelayRuntimeState as CoreDelayRuntimeState, DelaySettings as CoreDelaySettings,
};

const TAIL_FLOOR_DB: f64 = -120.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DelaySettings {
    pub enabled: bool,
    pub delay_ms: f64,
    pub feedback: f64,
    pub mix: f64,
}

impl Default for DelaySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            delay_ms: 250.0,
            feedback: 0.3,
            mix: 0.3,
        }
    }
}

#[derive(Clone)]
struct DelayRuntimeState {
    sample_rate_bits: u64,
    core: CoreDelayRuntimeState,
}

pub struct DelayProcessor {
    sample_rate: f64,
    settings: DelaySettings,
    effect: DelayEffect,
    left: Vec<f32>,
    right: Vec<f32>,
    buffer_len: usize,
    delay_samples: f64,
}

impl DelayProcessor {
    pub fn new(sample_rate: f64, settings: DelaySettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(settings)?;
        let buffer_len = delay_buffer_len(sample_rate)?;
        let effect = DelayEffect::new(sample_rate).map_err(EngineError::InvalidInput)?;
        let mut processor = Self {
            sample_rate,
            settings: DelaySettings::default(),
            effect,
            left: Vec::new(),
            right: Vec::new(),
            buffer_len,
            delay_samples: 0.0,
        };
        processor.apply_params(settings);
        Ok(processor)
    }

    pub fn settings(&self) -> DelaySettings {
        self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 更新参数但保留核心延迟状态；仅从禁用切换为启用时重置核心状态。
    pub fn set_params(&mut self, settings: DelaySettings) -> Result<()> {
        validate_settings(settings)?;
        let became_active = !self.is_active() && settings.enabled;
        self.apply_params(settings);
        if became_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    fn apply_params(&mut self, settings: DelaySettings) {
        self.settings = DelaySettings {
            enabled: settings.enabled,
            delay_ms: settings.delay_ms.clamp(0.0, 2_000.0),
            feedback: settings.feedback.clamp(0.0, 0.98),
            mix: settings.mix.clamp(0.0, 1.0),
        };
        self.delay_samples = self.settings.delay_ms / 1_000.0 * self.sample_rate;
        self.sync_core_params();
    }

    fn sync_core_params(&mut self) {
        self.effect.set_params(CoreDelaySettings {
            enabled: self.settings.enabled,
            delay_ms: self.settings.delay_ms,
            feedback: self.settings.feedback,
            mix: self.settings.mix,
        });
    }

    fn reset_runtime_state(&mut self) {
        self.effect.reset();
    }
}

impl PcmProcessor for DelayProcessor {
    fn name(&self) -> &'static str {
        "delay"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.is_active() && previous.is_active() {
            self.effect
                .copy_runtime_state_from(&previous.effect)
                .is_ok()
        } else {
            if self.is_active() {
                self.reset_runtime_state();
            }
            true
        }
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(DelayRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            core: self.effect.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<DelayRuntimeState>()
            .is_some_and(|state| state.sample_rate_bits == self.sample_rate.to_bits())
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<DelayRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        self.effect.save_runtime_state(&mut state.core).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<DelayRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
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
                "delay requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "delay block exceeds the prepared frame capacity".into(),
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
        let effective_delay = if self.delay_samples < 1.0 {
            self.buffer_len as f64
        } else {
            self.delay_samples.ceil()
        };
        let repeats = if self.settings.feedback == 0.0 {
            1.0
        } else {
            let floor_linear = 10.0_f64.powf(TAIL_FLOOR_DB / 20.0);
            (floor_linear.ln() / self.settings.feedback.ln())
                .ceil()
                .max(1.0)
        };
        (effective_delay * repeats).ceil().min(f64::from(u32::MAX)) as u32
    }
}

fn validate_sample_rate(sample_rate: f64) -> Result<()> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(EngineError::InvalidInput(
            "delay sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

fn delay_buffer_len(sample_rate: f64) -> Result<usize> {
    let length = (sample_rate * 2.0).ceil();
    if length >= usize::MAX as f64 {
        return Err(EngineError::InvalidInput(
            "delay sample rate is too large for the delay line".into(),
        ));
    }
    Ok(length as usize + 1)
}

fn validate_settings(settings: DelaySettings) -> Result<()> {
    if [settings.delay_ms, settings.feedback, settings.mix]
        .into_iter()
        .any(|value| !value.is_finite())
    {
        return Err(EngineError::InvalidInput(
            "delay settings must be finite".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported("delay requires stereo PCM".into()));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "delay sample rate does not match PCM format".into(),
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

    fn enabled(delay_ms: f64, feedback: f64, mix: f64) -> DelaySettings {
        DelaySettings {
            enabled: true,
            delay_ms,
            feedback,
            mix,
        }
    }

    fn prepared(sample_rate: f64, settings: DelaySettings, capacity: usize) -> DelayProcessor {
        let mut processor = DelayProcessor::new(sample_rate, settings).unwrap();
        processor
            .prepare(format(sample_rate as u32), capacity)
            .unwrap();
        processor
    }

    fn process(processor: &mut DelayProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate as u32),
            interleaved: samples,
        })
    }

    fn signal(frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let x = ((i as f64 * 0.37).sin() * 0.7) as f32;
                [x, -x * 0.75]
            })
            .collect()
    }

    #[test]
    fn defaults_validation_and_clamping_match_stage_8() {
        assert_eq!(
            DelaySettings::default(),
            DelaySettings {
                enabled: false,
                delay_ms: 250.0,
                feedback: 0.3,
                mix: 0.3
            }
        );
        for sample_rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(DelayProcessor::new(sample_rate, DelaySettings::default()).is_err());
        }
        for settings in [
            enabled(f64::INFINITY, 0.3, 0.3),
            enabled(250.0, f64::NAN, 0.3),
            enabled(250.0, 0.3, f64::NEG_INFINITY),
        ] {
            assert!(DelayProcessor::new(48_000.0, settings).is_err());
        }
        let mut processor = DelayProcessor::new(4.0, DelaySettings::default()).unwrap();
        processor.set_params(enabled(5_000.0, 2.0, -1.0)).unwrap();
        assert_eq!(processor.settings(), enabled(2_000.0, 0.98, 0.0));
        assert_eq!(processor.delay_samples, 8.0);
        assert_eq!(processor.buffer_len, 9);
    }

    #[test]
    fn facade_output_is_bit_exact_with_authorized_core_and_frozen_parity() {
        let settings = enabled(375.0, 0.5, 0.5);
        let mut facade = prepared(4.0, settings, 3);
        let mut output = [1.0_f32, -0.5, 0.0, 0.0, 0.0, 0.0];
        process(&mut facade, &mut output).unwrap();
        let mut core = DelayEffect::new(4.0).unwrap();
        core.set_params(CoreDelaySettings {
            enabled: true,
            delay_ms: 375.0,
            feedback: 0.5,
            mix: 0.5,
        });
        let mut left = [1.0_f32, 0.0, 0.0];
        let mut right = [-0.5_f32, 0.0, 0.0];
        core.process_stereo(&mut left, &mut right);
        assert_eq!(
            output,
            [left[0], right[0], left[1], right[1], left[2], right[2]]
        );
        assert_eq!(output, [0.5, -0.25, 0.25, -0.125, 0.3125, -0.15625]);
    }

    #[test]
    fn disabled_freezes_and_false_to_true_or_reset_clears_core_state() {
        let active = enabled(250.0, 0.5, 1.0);
        let mut processor = prepared(4.0, active, 4);
        let mut impulse = [1.0_f32, -1.0];
        process(&mut processor, &mut impulse).unwrap();
        processor
            .set_params(DelaySettings {
                enabled: false,
                ..active
            })
            .unwrap();
        let mut bypassed = [0.25_f32, -0.75, 0.5, -0.125];
        let expected = bypassed.map(f32::to_bits);
        process(&mut processor, &mut bypassed).unwrap();
        assert_eq!(bypassed.map(f32::to_bits), expected);
        processor.set_params(active).unwrap();
        let mut restarted = [0.0_f32; 4];
        process(&mut processor, &mut restarted).unwrap();
        assert_eq!(restarted, [0.0; 4]);
        let mut refill = [1.0_f32, -1.0];
        process(&mut processor, &mut refill).unwrap();
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.settings(), active);
        let mut reset_output = [0.0_f32; 4];
        process(&mut processor, &mut reset_output).unwrap();
        assert_eq!(reset_output, [0.0; 4]);
    }

    #[test]
    fn migration_and_checkpoint_preserve_opaque_core_state() {
        let old_settings = enabled(250.0, 0.7, 0.6);
        let next_settings = enabled(500.0, 0.2, 0.4);
        let mut previous = prepared(1_000.0, old_settings, 64);
        let mut reference = prepared(1_000.0, old_settings, 64);
        let mut prefix = signal(37);
        let mut reference_prefix = prefix.clone();
        process(&mut previous, &mut prefix).unwrap();
        process(&mut reference, &mut reference_prefix).unwrap();
        let mut next = prepared(1_000.0, next_settings, 64);
        assert!(next.adopt_runtime_state_from(&mut previous));
        reference.set_params(next_settings).unwrap();
        let mut adopted = signal(19);
        let mut expected = adopted.clone();
        process(&mut next, &mut adopted).unwrap();
        process(&mut reference, &mut expected).unwrap();
        assert_eq!(adopted, expected);

        let initial = next.create_runtime_checkpoint().unwrap();
        assert!(next.runtime_checkpoint_compatible(initial.as_ref()));
        let mut after = signal(13);
        process(&mut next, &mut after).unwrap();
        assert!(next.restore_runtime_state(initial.as_ref()));
        let mut replay = signal(13);
        process(&mut next, &mut replay).unwrap();
        assert_eq!(replay, after);
        let mut checkpoint = next.create_runtime_checkpoint().unwrap();
        let mut more = signal(11);
        process(&mut next, &mut more).unwrap();
        assert!(next.save_runtime_state(checkpoint.as_mut()));
        let mut saved = signal(17);
        process(&mut next, &mut saved).unwrap();
        assert!(next.restore_runtime_state(checkpoint.as_ref()));
        let mut replayed = signal(17);
        process(&mut next, &mut replayed).unwrap();
        assert_eq!(replayed, saved);

        let mut disabled = prepared(
            1_000.0,
            DelaySettings {
                enabled: false,
                ..next_settings
            },
            16,
        );
        assert!(disabled.adopt_runtime_state_from(&mut previous));
        let mut activated = prepared(1_000.0, next_settings, 16);
        assert!(activated.adopt_runtime_state_from(&mut disabled));
        let mut from_disabled = signal(9);
        process(&mut activated, &mut from_disabled).unwrap();
        let mut fresh = prepared(1_000.0, next_settings, 9);
        let mut fresh_output = signal(9);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(from_disabled, fresh_output);
        let mut wrong_rate = prepared(2_000.0, next_settings, 16);
        assert!(!wrong_rate.adopt_runtime_state_from(&mut next));
        let mut bypass = BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut bypass));
        let mut wrong: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!next.save_runtime_state(wrong.as_mut()));
        assert!(!next.restore_runtime_state(wrong.as_ref()));
    }

    #[test]
    fn format_capacity_latency_and_tail_policies_are_preserved() {
        let mut processor = DelayProcessor::new(48_000.0, enabled(250.0, 0.3, 0.3)).unwrap();
        assert_eq!(processor.name(), "delay");
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 144_000);
        assert_eq!(
            DelayProcessor::new(4.0, enabled(0.0, 0.0, 1.0))
                .unwrap()
                .tail_frames(),
            9
        );
        assert_eq!(
            DelayProcessor::new(48_000.0, enabled(250.0, 0.3, 0.0))
                .unwrap()
                .tail_frames(),
            0
        );
        assert!(processor.prepare(format(48_000), 2).is_ok());
        assert!(processor
            .prepare(
                PcmFormat {
                    channels: 1,
                    ..format(48_000)
                },
                2
            )
            .is_err());
        assert!(processor.prepare(format(44_100), 2).is_err());
        let mut partial = [0.0_f32; 3];
        assert!(process(&mut processor, &mut partial).is_err());
        let mut oversized = [0.0_f32; 6];
        assert!(process(&mut processor, &mut oversized).is_err());
        let mut unprepared = DelayProcessor::new(48_000.0, enabled(250.0, 0.3, 0.3)).unwrap();
        let mut frame = [1.0_f32, -1.0];
        assert!(process(&mut unprepared, &mut frame).is_err());
    }
}
