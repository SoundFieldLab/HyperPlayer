//! HSE v1.5.1 Stage 9 Chorus 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::mod_effects::ChorusEffect` 权威实现；本模块仅负责
//! HyperPlayer 参数快照、生命周期、立体声交错/平面转换和实时缓冲管理。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::mod_effects::{
    ChorusEffect, ChorusRuntimeState as CoreChorusRuntimeState,
    ChorusSettings as CoreChorusSettings,
};

const MAX_DELAY_SECONDS: f64 = 0.1;
const BASE_DELAY_MS: f64 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChorusSettings {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth_ms: f64,
    pub mix: f64,
}

impl Default for ChorusSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            rate_hz: 1.0,
            depth_ms: 3.0,
            mix: 0.4,
        }
    }
}

#[derive(Clone)]
struct ChorusRuntimeState {
    sample_rate_bits: u64,
    core: CoreChorusRuntimeState,
}

pub struct ChorusProcessor {
    sample_rate: f64,
    settings: ChorusSettings,
    effect: ChorusEffect,
    left: Vec<f32>,
    right: Vec<f32>,
    buffer_len: usize,
    base_delay_samples: f64,
    depth_samples: f64,
}

impl ChorusProcessor {
    pub fn new(sample_rate: f64, settings: ChorusSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(settings)?;
        let buffer_len = chorus_buffer_len(sample_rate)?;
        let effect = ChorusEffect::new(sample_rate).map_err(EngineError::InvalidInput)?;
        let mut processor = Self {
            sample_rate,
            settings: ChorusSettings::default(),
            effect,
            left: Vec::new(),
            right: Vec::new(),
            buffer_len,
            base_delay_samples: BASE_DELAY_MS / 1_000.0 * sample_rate,
            depth_samples: 0.0,
        };
        processor.apply_params(settings);
        Ok(processor)
    }

    pub fn settings(&self) -> ChorusSettings {
        self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 参数即时生效并保留核心状态；仅从禁用切换为启用时重置核心状态。
    pub fn set_params(&mut self, settings: ChorusSettings) -> Result<()> {
        validate_settings(settings)?;
        let became_active = !self.is_active() && settings.enabled;
        self.apply_params(settings);
        if became_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    fn apply_params(&mut self, settings: ChorusSettings) {
        self.settings = ChorusSettings {
            enabled: settings.enabled,
            rate_hz: settings.rate_hz.clamp(0.01, 20.0),
            depth_ms: settings.depth_ms.clamp(0.0, 50.0),
            mix: settings.mix.clamp(0.0, 1.0),
        };
        self.depth_samples = self.settings.depth_ms / 1_000.0 * self.sample_rate;
        self.sync_core_params();
    }

    fn sync_core_params(&mut self) {
        self.effect.set_params(CoreChorusSettings {
            enabled: self.settings.enabled,
            rate_hz: self.settings.rate_hz,
            depth_ms: self.settings.depth_ms,
            mix: self.settings.mix,
        });
    }

    fn reset_runtime_state(&mut self) {
        self.effect.reset();
    }
}

impl PcmProcessor for ChorusProcessor {
    fn name(&self) -> &'static str {
        "chorus"
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
        Some(Box::new(ChorusRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            core: self.effect.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<ChorusRuntimeState>()
            .is_some_and(|state| state.sample_rate_bits == self.sample_rate.to_bits())
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<ChorusRuntimeState>() else {
            return false;
        };
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        self.effect.save_runtime_state(&mut state.core).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<ChorusRuntimeState>() else {
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
                "chorus requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "chorus block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.is_active() {
            return Ok(());
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.effect
            .process_stereo(&mut self.left[..frames], &mut self.right[..frames]);
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
        self.reset_runtime_state();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        if !self.is_active() || self.settings.mix == 0.0 {
            return 0;
        }
        let maximum_delay = if self.base_delay_samples - self.depth_samples < 1.0 {
            self.buffer_len as f64
        } else {
            self.base_delay_samples + self.depth_samples
        };
        maximum_delay.ceil().min(f64::from(u32::MAX)) as u32
    }
}

fn validate_sample_rate(sample_rate: f64) -> Result<()> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(EngineError::InvalidInput(
            "chorus sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

fn chorus_buffer_len(sample_rate: f64) -> Result<usize> {
    let length = (sample_rate * MAX_DELAY_SECONDS).ceil();
    if length >= (usize::MAX - 2) as f64 {
        return Err(EngineError::InvalidInput(
            "chorus sample rate is too large for the delay line".into(),
        ));
    }
    Ok(length as usize + 2)
}

fn validate_settings(settings: ChorusSettings) -> Result<()> {
    if [settings.rate_hz, settings.depth_ms, settings.mix]
        .into_iter()
        .any(|value| !value.is_finite())
    {
        return Err(EngineError::InvalidInput(
            "chorus settings must be finite".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "chorus requires stereo PCM".into(),
        ));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "chorus sample rate does not match PCM format".into(),
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

    fn enabled(rate_hz: f64, depth_ms: f64, mix: f64) -> ChorusSettings {
        ChorusSettings {
            enabled: true,
            rate_hz,
            depth_ms,
            mix,
        }
    }

    fn prepared(sample_rate: f64, settings: ChorusSettings, capacity: usize) -> ChorusProcessor {
        let mut processor = ChorusProcessor::new(sample_rate, settings).unwrap();
        processor
            .prepare(format(sample_rate as u32), capacity)
            .unwrap();
        processor
    }

    fn process(processor: &mut ChorusProcessor, samples: &mut [f32]) -> Result<()> {
        processor.process(PcmBlock {
            format: format(processor.sample_rate as u32),
            interleaved: samples,
        })
    }

    fn signal(frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let x = (i as f32 + 1.0) / frames as f32;
                [x, -x]
            })
            .collect()
    }

    #[test]
    fn defaults_validation_clamping_and_buffer_shape_match_stage_9() {
        assert_eq!(
            ChorusSettings::default(),
            ChorusSettings {
                enabled: false,
                rate_hz: 1.0,
                depth_ms: 3.0,
                mix: 0.4
            }
        );
        for sample_rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(ChorusProcessor::new(sample_rate, ChorusSettings::default()).is_err());
        }
        for settings in [
            enabled(f64::INFINITY, 3.0, 0.4),
            enabled(1.0, f64::NAN, 0.4),
            enabled(1.0, 3.0, f64::NEG_INFINITY),
        ] {
            assert!(ChorusProcessor::new(48_000.0, settings).is_err());
        }
        let mut processor = ChorusProcessor::new(1_000.0, ChorusSettings::default()).unwrap();
        processor.set_params(enabled(-1.0, 80.0, 2.0)).unwrap();
        assert_eq!(processor.settings(), enabled(0.01, 50.0, 1.0));
        assert_eq!(processor.base_delay_samples, 20.0);
        assert_eq!(processor.depth_samples, 50.0);
        assert_eq!(processor.buffer_len, 102);
    }

    #[test]
    fn facade_output_and_block_lfo_are_bit_exact_with_authorized_core() {
        let settings = enabled(5.0, 50.0, 1.0);
        let input = signal(100);
        let mut facade = prepared(1_000.0, settings, 100);
        let mut output = input.clone();
        process(&mut facade, &mut output).unwrap();
        let mut core = ChorusEffect::new(1_000.0).unwrap();
        core.set_params(CoreChorusSettings {
            enabled: true,
            rate_hz: 5.0,
            depth_ms: 50.0,
            mix: 1.0,
        });
        let mut left = input
            .as_chunks::<2>()
            .0
            .iter()
            .map(|frame| frame[0])
            .collect::<Vec<_>>();
        let mut right = input
            .as_chunks::<2>()
            .0
            .iter()
            .map(|frame| frame[1])
            .collect::<Vec<_>>();
        core.process_stereo(&mut left, &mut right);
        let expected = left
            .into_iter()
            .zip(right)
            .flat_map(|(l, r)| [l, r])
            .collect::<Vec<_>>();
        assert_eq!(output, expected);

        let mut split = prepared(1_000.0, settings, 100);
        let mut split_output = input;
        process(&mut split, &mut split_output[..100]).unwrap();
        process(&mut split, &mut split_output[100..]).unwrap();
        assert_eq!(output[..100], split_output[..100]);
        assert_ne!(output[100..], split_output[100..]);
    }

    #[test]
    fn disabled_freezes_and_false_to_true_or_reset_clears_core_state() {
        let active = enabled(5.0, 10.0, 0.5);
        let mut processor = prepared(1_000.0, active, 32);
        let mut first = signal(32);
        process(&mut processor, &mut first).unwrap();
        processor
            .set_params(ChorusSettings {
                enabled: false,
                ..active
            })
            .unwrap();
        let mut bypassed = signal(4);
        let expected = bypassed.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        process(&mut processor, &mut bypassed).unwrap();
        assert_eq!(
            bypassed.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
            expected
        );
        processor.set_params(active).unwrap();
        let mut restarted = signal(8);
        process(&mut processor, &mut restarted).unwrap();
        let mut fresh = prepared(1_000.0, active, 8);
        let mut fresh_output = signal(8);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(restarted, fresh_output);
        let mut advance = signal(11);
        process(&mut processor, &mut advance).unwrap();
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.settings(), active);
        let mut reset_output = signal(8);
        process(&mut processor, &mut reset_output).unwrap();
        assert_eq!(reset_output, fresh_output);
    }

    #[test]
    fn migration_and_checkpoint_preserve_opaque_core_state() {
        let old_settings = enabled(2.0, 4.0, 0.25);
        let next_settings = enabled(7.0, 12.0, 0.8);
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
            ChorusSettings {
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
        let mut processor = ChorusProcessor::new(48_000.0, enabled(1.0, 3.0, 0.4)).unwrap();
        assert_eq!(processor.name(), "chorus");
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 1_104);
        processor.set_params(enabled(1.0, 50.0, 1.0)).unwrap();
        assert_eq!(processor.tail_frames(), 4_802);
        processor.set_params(enabled(1.0, 50.0, 0.0)).unwrap();
        assert_eq!(processor.tail_frames(), 0);
        processor
            .set_params(ChorusSettings {
                enabled: false,
                mix: 1.0,
                ..processor.settings()
            })
            .unwrap();
        assert_eq!(processor.tail_frames(), 0);
        assert_eq!(
            ChorusProcessor::new(4.0, enabled(1.0, 50.0, 1.0))
                .unwrap()
                .tail_frames(),
            3
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
        let mut unprepared = ChorusProcessor::new(48_000.0, enabled(1.0, 3.0, 0.4)).unwrap();
        let mut frame = [1.0_f32, -1.0];
        assert!(process(&mut unprepared, &mut frame).is_err());
    }
}
