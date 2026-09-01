//! HSE v1.5.1 Stage 7 夜间模式：增强压缩后衰减 6 kHz 以上高频。
//!
//! 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
//! (`f7017621b7d84005fbfed8a3c42a119487a17326`)。中间运算保持 `f64`，只在
//! PCM 缓冲写回时量化为 `f32`。

use super::biquad::{design_biquad, BiquadCoeffs};
use super::compressor::{Compressor, CompressorRuntimeState, CompressorSettings};
use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NightModeSettings {
    pub enabled: bool,
    pub amount: f64,
}

impl Default for NightModeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            amount: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EnabledTransition {
    pub was_active: bool,
    pub is_active: bool,
}

impl EnabledTransition {
    pub fn became_active(self) -> bool {
        !self.was_active && self.is_active
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct MonoBiquadState {
    s1: f64,
    s2: f64,
}

impl MonoBiquadState {
    fn process(&mut self, coeffs: BiquadCoeffs, samples: &mut [f32]) {
        let (mut s1, mut s2) = (self.s1, self.s2);
        for sample in samples {
            let input = f64::from(*sample);
            let output = coeffs.b0 * input + s1;
            s1 = coeffs.b1 * input - coeffs.a1 * output + s2;
            s2 = coeffs.b2 * input - coeffs.a2 * output;
            *sample = output as f32;
        }
        self.s1 = s1;
        self.s2 = s2;
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

#[derive(Clone)]
struct NightModeRuntimeState {
    sample_rate: u32,
    compressor: CompressorRuntimeState,
    shelf_left: MonoBiquadState,
    shelf_right: MonoBiquadState,
}

pub struct NightModeProcessor {
    sample_rate: u32,
    settings: NightModeSettings,
    base_compressor: CompressorSettings,
    active: bool,
    enabled_transition: EnabledTransition,
    compressor: Compressor,
    shelf_coeffs: BiquadCoeffs,
    shelf_left: MonoBiquadState,
    shelf_right: MonoBiquadState,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl NightModeProcessor {
    pub fn new(
        sample_rate: u32,
        settings: NightModeSettings,
        base_compressor: CompressorSettings,
    ) -> Result<Self> {
        Self::with_settings(sample_rate, settings, base_compressor)
    }

    pub fn with_settings(
        sample_rate: u32,
        settings: NightModeSettings,
        base_compressor: CompressorSettings,
    ) -> Result<Self> {
        validate_sample_rate(sample_rate)?;
        validate_settings(settings)?;
        let active = settings.enabled && settings.amount > 0.0;
        let compressor_settings = derive_compressor_settings(settings, base_compressor);
        let compressor = Compressor::with_settings(f64::from(sample_rate), compressor_settings)
            .map_err(|error| EngineError::InvalidInput(error.into()))?;
        let shelf_coeffs = design_shelf(sample_rate, settings.amount)?;
        Ok(Self {
            sample_rate,
            settings,
            base_compressor,
            active,
            enabled_transition: EnabledTransition {
                was_active: false,
                is_active: active,
            },
            compressor,
            shelf_coeffs,
            shelf_left: MonoBiquadState::default(),
            shelf_right: MonoBiquadState::default(),
            left: Vec::new(),
            right: Vec::new(),
        })
    }

    pub fn settings(&self) -> NightModeSettings {
        self.settings
    }

    pub fn base_compressor_settings(&self) -> CompressorSettings {
        self.base_compressor
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn enabled_transition(&self) -> EnabledTransition {
        self.enabled_transition
    }

    pub fn derived_compressor_settings(&self) -> CompressorSettings {
        derive_compressor_settings(self.settings, self.base_compressor)
    }

    pub fn set_params(
        &mut self,
        settings: NightModeSettings,
        base_compressor: CompressorSettings,
    ) -> Result<()> {
        validate_settings(settings)?;
        let was_active = self.active;
        let is_active = settings.enabled && settings.amount > 0.0;
        let shelf_coeffs = design_shelf(self.sample_rate, settings.amount)?;

        self.settings = settings;
        self.base_compressor = base_compressor;
        self.active = is_active;
        self.enabled_transition = EnabledTransition {
            was_active,
            is_active,
        };
        self.compressor
            .set_params(derive_compressor_settings(settings, base_compressor));
        self.shelf_coeffs = shelf_coeffs;
        if !was_active && is_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    fn reset_runtime_state(&mut self) {
        self.compressor.reset();
        self.shelf_left.reset();
        self.shelf_right.reset();
    }

    fn copy_runtime_state_from(&mut self, source: &Self) -> bool {
        if self
            .compressor
            .copy_runtime_state_from(&source.compressor)
            .is_err()
        {
            return false;
        }
        self.shelf_left = source.shelf_left;
        self.shelf_right = source.shelf_right;
        true
    }
}

impl PcmProcessor for NightModeProcessor {
    fn name(&self) -> &'static str {
        "night-mode"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        self.enabled_transition = EnabledTransition {
            was_active: previous.active,
            is_active: self.active,
        };
        if self.active && previous.active {
            return self.copy_runtime_state_from(previous);
        } else if self.active {
            self.reset_runtime_state();
        }
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(NightModeRuntimeState {
            sample_rate: self.sample_rate,
            compressor: self.compressor.snapshot_runtime_state(),
            shelf_left: self.shelf_left,
            shelf_right: self.shelf_right,
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<NightModeRuntimeState>()
            .is_some_and(|state| self.sample_rate == state.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<NightModeRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        if self
            .compressor
            .save_runtime_state(&mut state.compressor)
            .is_err()
        {
            return false;
        }
        state.shelf_left = self.shelf_left;
        state.shelf_right = self.shelf_right;
        true
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<NightModeRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        if self
            .compressor
            .restore_runtime_state(&state.compressor)
            .is_err()
        {
            return false;
        }
        self.shelf_left = state.shelf_left;
        self.shelf_right = state.shelf_right;
        true
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        self.compressor.prepare(max_block_frames);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "night mode requires complete stereo frames".into(),
            ));
        }
        if !self.active {
            return Ok(());
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "night mode block exceeds the prepared frame capacity".into(),
            ));
        }

        self.compressor
            .process_interleaved_stereo(block.interleaved);
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.shelf_left
            .process(self.shelf_coeffs, &mut self.left[..frames]);
        self.shelf_right
            .process(self.shelf_coeffs, &mut self.right[..frames]);
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

fn derive_compressor_settings(
    settings: NightModeSettings,
    base: CompressorSettings,
) -> CompressorSettings {
    let k = settings.amount / 10.0;
    CompressorSettings {
        enabled: true,
        threshold_db: base.threshold_db - 6.0 * k,
        ratio: js_max(1.0, base.ratio * (1.0 + 0.5 * k)),
        knee_db: base.knee_db,
        attack_ms: base.attack_ms,
        release_ms: base.release_ms,
        makeup_db: base.makeup_db,
        output_gain: 1.0,
        sidechain_enabled: false,
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

fn design_shelf(sample_rate: u32, amount: f64) -> Result<BiquadCoeffs> {
    design_biquad(
        "highshelf",
        6_000.0,
        0.707,
        -1.5 * amount,
        f64::from(sample_rate),
    )
    .map_err(EngineError::InvalidInput)
}

fn validate_sample_rate(sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(EngineError::InvalidInput(
            "night mode sample rate must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_settings(settings: NightModeSettings) -> Result<()> {
    if !settings.amount.is_finite() {
        return Err(EngineError::InvalidInput(
            "night mode amount must be finite".into(),
        ));
    }
    Ok(())
}

fn validate_stereo_format(format: PcmFormat, sample_rate: u32) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "night mode requires stereo PCM".into(),
        ));
    }
    if format.sample_rate != sample_rate {
        return Err(EngineError::InvalidInput(
            "night mode sample rate does not match the prepared PCM format".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::PcmSampleFormat;

    const FORMAT: PcmFormat = PcmFormat {
        sample_rate: 48_000,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    };

    fn active_settings(amount: f64) -> NightModeSettings {
        NightModeSettings {
            enabled: true,
            amount,
        }
    }

    fn process(processor: &mut NightModeProcessor, samples: &mut [f32]) {
        processor
            .process(PcmBlock {
                format: FORMAT,
                interleaved: samples,
            })
            .unwrap();
    }

    #[test]
    fn derives_stage_seven_parameters_from_the_full_base_compressor() {
        let base = CompressorSettings {
            enabled: false,
            threshold_db: -18.0,
            ratio: 3.0,
            knee_db: 7.0,
            attack_ms: 12.0,
            release_ms: 240.0,
            makeup_db: 2.5,
            output_gain: 0.25,
            sidechain_enabled: true,
        };
        let processor =
            NightModeProcessor::with_settings(48_000, active_settings(10.0), base).unwrap();

        assert_eq!(
            processor.derived_compressor_settings(),
            CompressorSettings {
                enabled: true,
                threshold_db: -24.0,
                ratio: 4.5,
                knee_db: 7.0,
                attack_ms: 12.0,
                release_ms: 240.0,
                makeup_db: 2.5,
                output_gain: 1.0,
                sidechain_enabled: false,
            }
        );
        assert!(processor.is_active());
    }

    #[test]
    fn bypasses_unless_enabled_with_positive_amount() {
        for settings in [
            NightModeSettings::default(),
            NightModeSettings {
                enabled: true,
                amount: 0.0,
            },
            NightModeSettings {
                enabled: true,
                amount: -1.0,
            },
        ] {
            let mut processor =
                NightModeProcessor::with_settings(48_000, settings, CompressorSettings::default())
                    .unwrap();
            processor.prepare(FORMAT, 2).unwrap();
            let mut samples = [0.75, -0.5, 0.25, -0.125];
            let original = samples;
            process(&mut processor, &mut samples);
            assert_eq!(samples, original);
        }
    }

    #[test]
    fn processes_compressor_before_independent_channel_shelves() {
        let base = CompressorSettings {
            threshold_db: -80.0,
            ratio: 1.0,
            knee_db: 0.0,
            attack_ms: 0.05,
            release_ms: 0.05,
            ..CompressorSettings::default()
        };
        let settings = active_settings(6.0);
        let mut processor = NightModeProcessor::with_settings(48_000, settings, base).unwrap();
        processor.prepare(FORMAT, 4).unwrap();

        let mut actual = [1.0, 0.0, 0.25, 0.0, -0.5, 0.0, 0.125, 0.0];
        let mut expected = actual;
        let derived = derive_compressor_settings(settings, base);
        let mut compressor = Compressor::with_settings(48_000.0, derived).unwrap();
        compressor.process_interleaved_stereo(&mut expected);
        let coeffs = design_shelf(48_000, settings.amount).unwrap();
        let mut left = expected
            .as_chunks::<2>()
            .0
            .iter()
            .map(|frame| frame[0])
            .collect::<Vec<_>>();
        let mut right = expected
            .as_chunks::<2>()
            .0
            .iter()
            .map(|frame| frame[1])
            .collect::<Vec<_>>();
        MonoBiquadState::default().process(coeffs, &mut left);
        MonoBiquadState::default().process(coeffs, &mut right);
        for (index, frame) in expected.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            frame[0] = left[index];
            frame[1] = right[index];
        }

        process(&mut processor, &mut actual);
        assert_eq!(actual, expected);
        assert!(actual
            .as_chunks::<2>()
            .0
            .iter()
            .all(|frame| frame[1] == 0.0));
    }

    #[test]
    fn active_adoption_and_checkpoint_restore_preserve_runtime_only() {
        let settings = active_settings(8.0);
        let base = CompressorSettings::default();
        let mut previous = NightModeProcessor::with_settings(48_000, settings, base).unwrap();
        previous.prepare(FORMAT, 4).unwrap();
        process(
            &mut previous,
            &mut [0.8, -0.6, 0.4, -0.2, 0.7, -0.5, 0.3, -0.1],
        );

        let mut adopted = NightModeProcessor::with_settings(48_000, settings, base).unwrap();
        adopted.prepare(FORMAT, 4).unwrap();
        assert!(adopted.adopt_runtime_state_from(&mut previous));
        assert_eq!(
            adopted.enabled_transition(),
            EnabledTransition {
                was_active: true,
                is_active: true,
            }
        );

        let mut checkpoint = adopted.create_runtime_checkpoint().unwrap();
        assert!(adopted.save_runtime_state(checkpoint.as_mut()));
        let mut first = [0.35, -0.3, 0.2, -0.15];
        process(&mut adopted, &mut first);
        assert!(adopted.restore_runtime_state(checkpoint.as_ref()));
        let mut replay = [0.35, -0.3, 0.2, -0.15];
        process(&mut adopted, &mut replay);
        assert_eq!(first, replay);
    }

    #[test]
    fn incompatible_compressor_state_is_propagated_without_partial_adoption() {
        let settings = active_settings(8.0);
        let base = CompressorSettings::default();
        let mut source = NightModeProcessor::with_settings(48_000, settings, base).unwrap();
        let mut target = NightModeProcessor::with_settings(44_100, settings, base).unwrap();
        let original_transition = target.enabled_transition();
        let checkpoint = source.create_runtime_checkpoint().unwrap();

        assert!(!target.adopt_runtime_state_from(&mut source));
        assert_eq!(target.enabled_transition(), original_transition);
        assert!(!target.runtime_checkpoint_compatible(checkpoint.as_ref()));
        assert!(!target.restore_runtime_state(checkpoint.as_ref()));
    }

    #[test]
    fn checkpoint_uses_compressor_runtime_state_and_preserves_parameters() {
        let settings = active_settings(7.0);
        let base = CompressorSettings {
            threshold_db: -11.0,
            ratio: 2.5,
            ..CompressorSettings::default()
        };
        let mut processor = NightModeProcessor::with_settings(48_000, settings, base).unwrap();
        let checkpoint = processor.create_runtime_checkpoint().unwrap();
        let state = checkpoint
            .downcast_ref::<NightModeRuntimeState>()
            .expect("night-mode checkpoint type");
        let _: CompressorRuntimeState = state.compressor;

        assert!(processor.restore_runtime_state(checkpoint.as_ref()));
        assert_eq!(processor.settings(), settings);
        assert_eq!(processor.base_compressor_settings(), base);
        assert_eq!(
            processor.compressor.settings(),
            derive_compressor_settings(settings, base)
        );
    }

    #[test]
    fn inactive_to_active_adoption_resets_runtime_state() {
        let base = CompressorSettings::default();
        let mut inactive =
            NightModeProcessor::with_settings(48_000, NightModeSettings::default(), base).unwrap();
        let mut activated =
            NightModeProcessor::with_settings(48_000, active_settings(5.0), base).unwrap();
        let mut fresh =
            NightModeProcessor::with_settings(48_000, active_settings(5.0), base).unwrap();
        activated.prepare(FORMAT, 2).unwrap();
        fresh.prepare(FORMAT, 2).unwrap();

        assert!(activated.adopt_runtime_state_from(&mut inactive));
        assert!(activated.enabled_transition().became_active());
        let mut adopted_output = [0.75, -0.25, 0.5, -0.125];
        let mut fresh_output = adopted_output;
        process(&mut activated, &mut adopted_output);
        process(&mut fresh, &mut fresh_output);
        assert_eq!(adopted_output, fresh_output);
    }
}
