//! HSE v1.5.1 Stage 12 Tremolo 的 HyperPlayer PCM 适配器。
//!
//! DSP 运算与运行状态由 `hse_core::mod_effects::TremoloEffect` 权威实现；本模块仅负责
//! HyperPlayer 参数快照、生命周期、立体声交错/平面转换和实时缓冲管理。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::mod_effects::{
    TremoloEffect, TremoloRuntimeState as CoreTremoloRuntimeState,
    TremoloSettings as CoreTremoloSettings,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TremoloSettings {
    pub enabled: bool,
    pub rate_hz: f64,
    pub depth: f64,
    pub mix: f64,
}

impl Default for TremoloSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            rate_hz: 5.0,
            depth: 0.5,
            mix: 1.0,
        }
    }
}

#[derive(Clone)]
struct TremoloRuntimeState {
    core: CoreTremoloRuntimeState,
}

pub struct TremoloProcessor {
    sample_rate: f64,
    settings: TremoloSettings,
    effect: TremoloEffect,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl TremoloProcessor {
    pub fn new(sample_rate: f64, settings: TremoloSettings) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(settings)?;

        let effect = TremoloEffect::new(sample_rate).map_err(EngineError::InvalidInput)?;
        let mut processor = Self {
            sample_rate,
            settings: TremoloSettings::default(),
            effect,
            left: Vec::new(),
            right: Vec::new(),
        };
        processor.apply_params(settings);
        Ok(processor)
    }

    pub fn settings(&self) -> TremoloSettings {
        self.settings
    }

    pub fn is_active(&self) -> bool {
        self.settings.enabled
    }

    /// 参数即时生效并保留核心状态；仅从禁用切换为启用时重置核心状态。
    pub fn set_params(&mut self, settings: TremoloSettings) -> Result<()> {
        validate_settings(settings)?;
        let became_active = !self.is_active() && settings.enabled;
        self.apply_params(settings);
        if became_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    fn apply_params(&mut self, settings: TremoloSettings) {
        let applied = self.effect.set_params(CoreTremoloSettings {
            enabled: settings.enabled,
            rate_hz: settings.rate_hz,
            depth: settings.depth,
            mix: settings.mix,
        });
        self.settings = TremoloSettings {
            enabled: applied.enabled,
            rate_hz: applied.rate_hz,
            depth: applied.depth,
            mix: applied.mix,
        };
    }

    fn reset_runtime_state(&mut self) {
        self.effect.reset();
    }
}

impl PcmProcessor for TremoloProcessor {
    fn name(&self) -> &'static str {
        "tremolo"
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
        Some(Box::new(TremoloRuntimeState {
            core: self.effect.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state.is::<TremoloRuntimeState>()
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<TremoloRuntimeState>() else {
            return false;
        };
        self.effect.save_runtime_state(&mut state.core).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<TremoloRuntimeState>() else {
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
                "tremolo requires complete stereo frames".into(),
            ));
        }

        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "tremolo block exceeds the prepared frame capacity".into(),
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
        0
    }
}

fn validate_sample_rate(sample_rate: f64) -> Result<()> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(EngineError::InvalidInput(
            "tremolo sample rate must be finite and greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_settings(settings: TremoloSettings) -> Result<()> {
    if [settings.rate_hz, settings.depth, settings.mix]
        .into_iter()
        .any(|value| !value.is_finite())
    {
        return Err(EngineError::InvalidInput(
            "tremolo settings must be finite".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: f64) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "tremolo requires stereo PCM".into(),
        ));
    }
    if f64::from(format.sample_rate) != sample_rate {
        return Err(EngineError::InvalidInput(
            "tremolo sample rate does not match PCM format".into(),
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

    fn enabled(rate_hz: f64, depth: f64, mix: f64) -> TremoloSettings {
        TremoloSettings {
            enabled: true,
            rate_hz,
            depth,
            mix,
        }
    }

    fn prepared(sample_rate: f64, settings: TremoloSettings, capacity: usize) -> TremoloProcessor {
        let mut processor = TremoloProcessor::new(sample_rate, settings).unwrap();
        processor
            .prepare(format(sample_rate as u32), capacity)
            .unwrap();
        processor
    }

    fn process(processor: &mut TremoloProcessor, samples: &mut [f32]) -> Result<()> {
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
    fn defaults_validation_and_clamping_match_stage_12() {
        assert_eq!(
            TremoloSettings::default(),
            TremoloSettings {
                enabled: false,
                rate_hz: 5.0,
                depth: 0.5,
                mix: 1.0,
            }
        );

        for sample_rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(TremoloProcessor::new(sample_rate, TremoloSettings::default()).is_err());
        }
        for settings in [
            enabled(f64::INFINITY, 0.5, 1.0),
            enabled(5.0, f64::NAN, 1.0),
            enabled(5.0, 0.5, f64::NEG_INFINITY),
        ] {
            assert!(TremoloProcessor::new(48_000.0, settings).is_err());
        }

        let mut processor = TremoloProcessor::new(48_000.0, TremoloSettings::default()).unwrap();
        assert!(processor.set_params(enabled(5.0, f64::NAN, 1.0)).is_err());
        assert_eq!(processor.settings(), TremoloSettings::default());
        processor.set_params(enabled(-1.0, 2.0, -1.0)).unwrap();
        assert_eq!(processor.settings(), enabled(0.01, 1.0, 0.0));
        processor.set_params(enabled(40.0, -1.0, 2.0)).unwrap();
        assert_eq!(processor.settings(), enabled(30.0, 0.0, 1.0));
    }

    #[test]
    fn authorized_hse_rust_and_ts_golden_output_is_exact() {
        let mut processor = prepared(8.0, enabled(1.0, 0.8, 0.75), 8);
        let input = [
            1.0_f32, -1.0, 0.75, -0.5, 0.5, -0.25, 0.25, -0.125, -0.25, 0.5, -0.5, 0.75, -0.75,
            1.0, -1.0, 0.25,
        ];
        let mut samples = input;

        process(&mut processor, &mut samples).unwrap();

        assert_eq!(
            samples,
            [
                0.7,
                -0.7,
                0.36590096,
                -0.24393398,
                0.2,
                -0.1,
                0.12196699,
                -0.060983494,
                -0.175,
                0.35,
                -0.456066,
                0.684099,
                -0.75,
                1.0,
                -0.912132,
                0.228033,
            ]
        );

        let mut repeated = input;
        process(&mut processor, &mut repeated).unwrap();
        assert_eq!(repeated, samples);
    }

    #[test]
    fn per_frame_core_state_is_block_invariant() {
        let settings = enabled(7.25, 0.83, 0.61);
        let input = signal(1_003);
        let mut whole = prepared(44_100.0, settings, 1_003);
        let mut split = prepared(44_100.0, settings, 1_003);
        let mut whole_output = input.clone();
        let mut split_output = input;

        process(&mut whole, &mut whole_output).unwrap();
        process(&mut split, &mut split_output[..442]).unwrap();
        process(&mut split, &mut split_output[442..1_556]).unwrap();
        process(&mut split, &mut split_output[1_556..]).unwrap();

        assert_eq!(whole_output, split_output);
        let mut whole_continuation = signal(23);
        let mut split_continuation = whole_continuation.clone();
        process(&mut whole, &mut whole_continuation).unwrap();
        process(&mut split, &mut split_continuation).unwrap();
        assert_eq!(whole_continuation, split_continuation);
    }

    #[test]
    fn mix_zero_is_bit_exact_dry_but_advances_core_state() {
        let dry_settings = enabled(3.0, 0.9, 0.0);
        let wet_settings = enabled(3.0, 0.9, 1.0);
        let mut processor = prepared(48_000.0, dry_settings, 257);
        let mut samples = signal(257);
        let expected = samples
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();

        process(&mut processor, &mut samples).unwrap();

        assert_eq!(
            samples
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
        );
        processor.set_params(wet_settings).unwrap();
        let mut advanced = signal(16);
        process(&mut processor, &mut advanced).unwrap();
        let mut fresh = prepared(48_000.0, wet_settings, 16);
        let mut from_zero = signal(16);
        process(&mut fresh, &mut from_zero).unwrap();
        assert_ne!(advanced, from_zero);
    }

    #[test]
    fn disabled_freezes_and_false_to_true_or_reset_clears_core_state() {
        let active = enabled(2.0, 0.8, 0.5);
        let mut processor = prepared(48_000.0, active, 32);
        let mut first = signal(32);
        process(&mut processor, &mut first).unwrap();

        processor
            .set_params(TremoloSettings {
                enabled: false,
                ..active
            })
            .unwrap();
        let mut bypassed = signal(8);
        let expected = bypassed.clone();
        process(&mut processor, &mut bypassed).unwrap();
        assert_eq!(bypassed, expected);

        processor.set_params(active).unwrap();
        let mut restarted = signal(5);
        process(&mut processor, &mut restarted).unwrap();
        let mut fresh = prepared(48_000.0, active, 5);
        let mut fresh_output = signal(5);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(restarted, fresh_output);

        let mut advance = signal(11);
        process(&mut processor, &mut advance).unwrap();
        processor.reset(ResetReason::Seek);
        assert_eq!(processor.settings(), active);
        let mut reset_output = signal(5);
        process(&mut processor, &mut reset_output).unwrap();
        assert_eq!(reset_output, fresh_output);
    }

    #[test]
    fn migration_and_checkpoint_preserve_opaque_core_state() {
        let old_settings = enabled(2.0, 0.8, 0.5);
        let next_settings = enabled(7.0, 0.3, 0.9);
        let mut previous = prepared(48_000.0, old_settings, 64);
        let mut reference = prepared(48_000.0, old_settings, 64);
        let mut prefix = signal(37);
        let mut reference_prefix = prefix.clone();
        process(&mut previous, &mut prefix).unwrap();
        process(&mut reference, &mut reference_prefix).unwrap();

        let mut next = prepared(48_000.0, next_settings, 64);
        assert!(next.adopt_runtime_state_from(&mut previous));
        assert_eq!(next.settings(), next_settings);
        reference.set_params(next_settings).unwrap();
        let mut adopted_output = signal(19);
        let mut reference_output = adopted_output.clone();
        process(&mut next, &mut adopted_output).unwrap();
        process(&mut reference, &mut reference_output).unwrap();
        assert_eq!(adopted_output, reference_output);

        let initial_checkpoint = next.create_runtime_checkpoint().unwrap();
        let mut expected_after_checkpoint = signal(13);
        process(&mut next, &mut expected_after_checkpoint).unwrap();
        assert!(next.restore_runtime_state(initial_checkpoint.as_ref()));
        let mut restored_output = signal(13);
        process(&mut next, &mut restored_output).unwrap();
        assert_eq!(restored_output, expected_after_checkpoint);

        let mut checkpoint = next.create_runtime_checkpoint().unwrap();
        let mut more = signal(11);
        process(&mut next, &mut more).unwrap();
        assert!(next.save_runtime_state(checkpoint.as_mut()));
        let mut saved_output = signal(17);
        process(&mut next, &mut saved_output).unwrap();
        assert!(next.restore_runtime_state(checkpoint.as_ref()));
        let mut replayed_output = signal(17);
        process(&mut next, &mut replayed_output).unwrap();
        assert_eq!(replayed_output, saved_output);

        let mut disabled = prepared(
            48_000.0,
            TremoloSettings {
                enabled: false,
                ..next_settings
            },
            16,
        );
        assert!(disabled.adopt_runtime_state_from(&mut previous));

        let mut from_disabled = prepared(48_000.0, next_settings, 16);
        assert!(from_disabled.adopt_runtime_state_from(&mut disabled));
        let mut reset_adoption_output = signal(9);
        process(&mut from_disabled, &mut reset_adoption_output).unwrap();
        let mut fresh = prepared(48_000.0, next_settings, 9);
        let mut fresh_output = signal(9);
        process(&mut fresh, &mut fresh_output).unwrap();
        assert_eq!(reset_adoption_output, fresh_output);

        let mut other_rate = prepared(44_100.0, next_settings, 16);
        assert!(!other_rate.adopt_runtime_state_from(&mut previous));
        let mut wrong_type = BypassProcessor;
        assert!(!next.adopt_runtime_state_from(&mut wrong_type));
        let mut wrong_checkpoint: Box<dyn std::any::Any + Send> = Box::new(0_u64);
        assert!(!next.save_runtime_state(wrong_checkpoint.as_mut()));
        assert!(!next.restore_runtime_state(wrong_checkpoint.as_ref()));
    }

    #[test]
    fn format_complete_frame_and_prepared_capacity_validation_precede_bypass() {
        let mut processor = TremoloProcessor::new(48_000.0, TremoloSettings::default()).unwrap();
        assert!(processor.prepare(format(48_000), 2).is_ok());

        let mono = PcmFormat {
            channels: 1,
            ..format(48_000)
        };
        assert!(processor.prepare(mono, 2).is_err());
        assert!(processor.prepare(format(44_100), 2).is_err());

        let mut incomplete = [1.0_f32, -1.0, 0.5];
        assert!(processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut incomplete,
            })
            .is_err());

        let mut oversized = [1.0_f32, -1.0, 0.5, -0.5, 0.25, -0.25];
        let unchanged = oversized;
        assert!(process(&mut processor, &mut oversized).is_err());
        assert_eq!(oversized, unchanged);

        let mut unprepared = TremoloProcessor::new(48_000.0, enabled(5.0, 0.5, 1.0)).unwrap();
        let mut frame = [1.0_f32, -1.0];
        assert!(process(&mut unprepared, &mut frame).is_err());
    }

    #[test]
    fn tremolo_has_no_latency_or_tail() {
        let mut processor = prepared(48_000.0, enabled(5.0, 1.0, 1.0), 4);
        assert_eq!(processor.name(), "tremolo");
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
        let mut samples = signal(4);
        process(&mut processor, &mut samples).unwrap();
        assert_eq!(processor.tail_frames(), 0);
    }
}
