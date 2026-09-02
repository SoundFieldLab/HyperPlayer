//! HSE v1.5.1 Stage 7 夜间模式的 HyperPlayer PCM 适配层。

use super::compressor::CompressorSettings;
use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result};
use hse_core::{
    compressor::CompressorSettings as CoreCompressorSettings,
    night_mode::{
        NightModeRuntimeState as CoreNightModeRuntimeState,
        NightModeSettings as CoreNightModeSettings, NightModeStage,
    },
    Stage as HseStage,
};

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

#[derive(Clone, Copy)]
struct NightModeRuntimeState {
    sample_rate: u32,
    core: CoreNightModeRuntimeState,
}

pub struct NightModeProcessor {
    sample_rate: u32,
    settings: NightModeSettings,
    base_compressor: CompressorSettings,
    active: bool,
    enabled_transition: EnabledTransition,
    core: NightModeStage,
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
        let core = NightModeStage::new(
            f64::from(sample_rate),
            core_settings(settings, base_compressor),
        )
        .map_err(EngineError::InvalidInput)?;
        Ok(Self {
            sample_rate,
            settings,
            base_compressor,
            active,
            enabled_transition: EnabledTransition {
                was_active: false,
                is_active: active,
            },
            core,
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
        let settings = self.core.derived_compressor_settings();
        CompressorSettings {
            enabled: settings.enabled,
            threshold_db: settings.threshold_db,
            ratio: settings.ratio,
            knee_db: settings.knee_db,
            attack_ms: settings.attack_ms,
            release_ms: settings.release_ms,
            makeup_db: settings.makeup_db,
            output_gain: settings.output_gain,
            sidechain_enabled: settings.sidechain_enabled,
        }
    }

    pub fn set_params(
        &mut self,
        settings: NightModeSettings,
        base_compressor: CompressorSettings,
    ) -> Result<()> {
        validate_settings(settings)?;
        let was_active = self.active;
        let is_active = settings.enabled && settings.amount > 0.0;
        self.core
            .set_params(core_settings(settings, base_compressor))
            .map_err(EngineError::InvalidInput)?;
        self.settings = settings;
        self.base_compressor = base_compressor;
        self.active = is_active;
        self.enabled_transition = EnabledTransition {
            was_active,
            is_active,
        };
        Ok(())
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
            self.core.copy_runtime_state_from(&previous.core).is_ok()
        } else {
            if self.active {
                self.core.reset();
            }
            true
        }
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(NightModeRuntimeState {
            sample_rate: self.sample_rate,
            core: self.core.snapshot_runtime_state(),
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
        self.core.save_runtime_state(&mut state.core).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<NightModeRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.core.restore_runtime_state(&state.core).is_ok()
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        self.core.prepare(max_block_frames);
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

        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.core
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
        self.core.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn core_settings(settings: NightModeSettings, base: CompressorSettings) -> CoreNightModeSettings {
    CoreNightModeSettings {
        enabled: settings.enabled,
        amount: settings.amount,
        base_compressor: CoreCompressorSettings {
            enabled: base.enabled,
            threshold_db: base.threshold_db,
            ratio: base.ratio,
            knee_db: base.knee_db,
            attack_ms: base.attack_ms,
            release_ms: base.release_ms,
            makeup_db: base.makeup_db,
            output_gain: base.output_gain,
            sidechain_enabled: false,
        },
    }
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
    fn active_adoption_and_checkpoint_restore_preserve_runtime_only() {
        let base = CompressorSettings::default();
        let mut previous =
            NightModeProcessor::with_settings(48_000, active_settings(8.0), base).unwrap();
        previous.prepare(FORMAT, 4).unwrap();
        process(
            &mut previous,
            &mut [0.8, -0.6, 0.4, -0.2, 0.7, -0.5, 0.3, -0.1],
        );

        let mut adopted =
            NightModeProcessor::with_settings(48_000, active_settings(3.0), base).unwrap();
        adopted.prepare(FORMAT, 4).unwrap();
        assert!(adopted.adopt_runtime_state_from(&mut previous));
        assert_eq!(adopted.settings(), active_settings(3.0));
        assert_eq!(adopted.derived_compressor_settings().threshold_db, -21.8);

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
