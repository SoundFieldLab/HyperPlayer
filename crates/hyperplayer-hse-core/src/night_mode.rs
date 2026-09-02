//! HSE v1.5.1 Stage 7 夜间模式：增强压缩后衰减 6 kHz 以上高频。

use crate::{
    biquad::{BiquadRuntimeState, BiquadRuntimeStateMismatch, BiquadStage},
    compressor::{
        CompressorRuntimeState, CompressorRuntimeStateMismatch, CompressorSettings, CompressorStage,
    },
    Stage,
};
use std::fmt;

#[derive(Debug, Clone)]
pub struct NightModeSettings {
    pub enabled: bool,
    pub amount: f64,
    pub base_compressor: CompressorSettings,
}

impl Default for NightModeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            amount: 0.0,
            base_compressor: CompressorSettings {
                enabled: true,
                threshold_db: -20.0,
                ratio: 4.0,
                knee_db: 6.0,
                attack_ms: 10.0,
                release_ms: 150.0,
                makeup_db: 0.0,
                output_gain: 1.0,
                sidechain_enabled: false,
            },
        }
    }
}

#[derive(Clone, Copy)]
pub struct NightModeRuntimeState {
    sample_rate_bits: u64,
    compressor: CompressorRuntimeState,
    shelf_left: BiquadRuntimeState,
    shelf_right: BiquadRuntimeState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NightModeRuntimeStateMismatch;

impl fmt::Display for NightModeRuntimeStateMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("night mode runtime state shape mismatch")
    }
}

impl std::error::Error for NightModeRuntimeStateMismatch {}

impl From<CompressorRuntimeStateMismatch> for NightModeRuntimeStateMismatch {
    fn from(_: CompressorRuntimeStateMismatch) -> Self {
        Self
    }
}

impl From<BiquadRuntimeStateMismatch> for NightModeRuntimeStateMismatch {
    fn from(_: BiquadRuntimeStateMismatch) -> Self {
        Self
    }
}

pub struct NightModeStage {
    sample_rate: f64,
    settings: NightModeSettings,
    active: bool,
    compressor: CompressorStage,
    shelf_left: BiquadStage,
    shelf_right: BiquadStage,
}

impl NightModeStage {
    pub fn new(sample_rate: f64, settings: NightModeSettings) -> Result<Self, String> {
        validate_settings(&settings)?;
        let active = settings.enabled && settings.amount > 0.0;
        let compressor =
            CompressorStage::from_settings(sample_rate, derive_compressor_settings(&settings))?;
        let shelf_left = shelf(sample_rate, settings.amount)?;
        let shelf_right = shelf(sample_rate, settings.amount)?;
        Ok(Self {
            sample_rate,
            settings,
            active,
            compressor,
            shelf_left,
            shelf_right,
        })
    }

    pub fn settings(&self) -> &NightModeSettings {
        &self.settings
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn derived_compressor_settings(&self) -> CompressorSettings {
        derive_compressor_settings(&self.settings)
    }

    pub fn set_params(&mut self, settings: NightModeSettings) -> Result<(), String> {
        validate_settings(&settings)?;
        let mut shelf_left = shelf(self.sample_rate, settings.amount)?;
        let mut shelf_right = shelf(self.sample_rate, settings.amount)?;
        let was_active = self.active;
        let is_active = settings.enabled && settings.amount > 0.0;
        if was_active && is_active {
            shelf_left
                .copy_runtime_state_from(&self.shelf_left)
                .map_err(|error| error.to_string())?;
            shelf_right
                .copy_runtime_state_from(&self.shelf_right)
                .map_err(|error| error.to_string())?;
        }
        self.compressor
            .configure(derive_compressor_settings(&settings));
        self.shelf_left = shelf_left;
        self.shelf_right = shelf_right;
        self.settings = settings;
        self.active = is_active;
        if !was_active && is_active {
            self.reset_runtime_state();
        }
        Ok(())
    }

    pub fn snapshot_runtime_state(&self) -> NightModeRuntimeState {
        NightModeRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            compressor: self.compressor.snapshot_runtime_state(),
            shelf_left: self.shelf_left.snapshot_runtime_state(),
            shelf_right: self.shelf_right.snapshot_runtime_state(),
        }
    }

    pub fn save_runtime_state(
        &self,
        state: &mut NightModeRuntimeState,
    ) -> Result<(), NightModeRuntimeStateMismatch> {
        self.preflight(state)?;
        let mut compressor = state.compressor;
        let mut shelf_left = state.shelf_left;
        let mut shelf_right = state.shelf_right;
        self.compressor.save_runtime_state(&mut compressor)?;
        self.shelf_left.save_runtime_state(&mut shelf_left)?;
        self.shelf_right.save_runtime_state(&mut shelf_right)?;
        state.compressor = compressor;
        state.shelf_left = shelf_left;
        state.shelf_right = shelf_right;
        Ok(())
    }

    pub fn restore_runtime_state(
        &mut self,
        state: &NightModeRuntimeState,
    ) -> Result<(), NightModeRuntimeStateMismatch> {
        self.preflight(state)?;
        self.compressor.restore_runtime_state(&state.compressor)?;
        self.shelf_left.restore_runtime_state(&state.shelf_left)?;
        self.shelf_right.restore_runtime_state(&state.shelf_right)?;
        Ok(())
    }

    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), NightModeRuntimeStateMismatch> {
        if self.sample_rate.to_bits() != source.sample_rate.to_bits() {
            return Err(NightModeRuntimeStateMismatch);
        }
        self.restore_runtime_state(&source.snapshot_runtime_state())
    }

    fn preflight(
        &self,
        state: &NightModeRuntimeState,
    ) -> Result<(), NightModeRuntimeStateMismatch> {
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return Err(NightModeRuntimeStateMismatch);
        }
        Ok(())
    }

    fn reset_runtime_state(&mut self) {
        self.compressor.reset();
        self.shelf_left.reset();
        self.shelf_right.reset();
    }
}

impl Stage for NightModeStage {
    fn prepare(&mut self, max_block_size: usize) {
        self.compressor.prepare(max_block_size);
        self.shelf_left.prepare(max_block_size);
        self.shelf_right.prepare(max_block_size);
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        debug_assert_eq!(left.len(), right.len(), "左右声道块长必须一致");
        if !self.active {
            return;
        }
        self.compressor.process(left, right);
        self.shelf_left.process_mono(left);
        self.shelf_right.process_mono(right);
    }

    fn reset(&mut self) {
        self.reset_runtime_state();
    }
}

fn derive_compressor_settings(settings: &NightModeSettings) -> CompressorSettings {
    let base = &settings.base_compressor;
    let k = settings.amount / 10.0;
    CompressorSettings {
        enabled: true,
        threshold_db: base.threshold_db - 6.0 * k,
        ratio: (base.ratio * (1.0 + 0.5 * k)).max(1.0),
        knee_db: base.knee_db,
        attack_ms: base.attack_ms,
        release_ms: base.release_ms,
        makeup_db: base.makeup_db,
        output_gain: 1.0,
        sidechain_enabled: false,
    }
}

fn shelf(sample_rate: f64, amount: f64) -> Result<BiquadStage, String> {
    BiquadStage::new(sample_rate, "highshelf", 6000.0, 0.707, -1.5 * amount)
}

fn validate_settings(settings: &NightModeSettings) -> Result<(), String> {
    if !settings.amount.is_finite() {
        return Err("night mode amount must be finite".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(amount: f64) -> NightModeSettings {
        NightModeSettings {
            enabled: true,
            amount,
            base_compressor: CompressorSettings {
                enabled: false,
                threshold_db: -24.0,
                ratio: 5.0,
                knee_db: 6.0,
                attack_ms: 4.0,
                release_ms: 120.0,
                makeup_db: 0.0,
                output_gain: 0.25,
                sidechain_enabled: true,
            },
        }
    }

    #[test]
    fn standalone_matches_the_previous_stage_seven_composition_bit_for_bit() {
        let settings = settings(8.0);
        let mut stage = NightModeStage::new(48_000.0, settings.clone()).unwrap();
        let mut compressor =
            CompressorStage::from_settings(48_000.0, stage.derived_compressor_settings()).unwrap();
        let mut shelf_left = shelf(48_000.0, settings.amount).unwrap();
        let mut shelf_right = shelf(48_000.0, settings.amount).unwrap();
        let input_left: Vec<f32> = (0..256)
            .map(|i| ((i as f64 * 0.17).sin() * 0.7) as f32)
            .collect();
        let input_right: Vec<f32> = (0..256)
            .map(|i| ((i as f64 * 0.11).cos() * 0.5) as f32)
            .collect();
        let (mut actual_left, mut actual_right) = (input_left.clone(), input_right.clone());
        let (mut expected_left, mut expected_right) = (input_left, input_right);

        stage.process(&mut actual_left, &mut actual_right);
        compressor.process(&mut expected_left, &mut expected_right);
        shelf_left.process_mono(&mut expected_left);
        shelf_right.process_mono(&mut expected_right);

        assert_eq!(actual_left, expected_left);
        assert_eq!(actual_right, expected_right);
    }

    #[test]
    fn active_state_copy_preserves_target_parameters() {
        let mut source = NightModeStage::new(48_000.0, settings(8.0)).unwrap();
        let mut target = NightModeStage::new(48_000.0, settings(3.0)).unwrap();
        source.process(&mut [0.8, 0.4], &mut [-0.6, -0.2]);
        target.copy_runtime_state_from(&source).unwrap();

        assert_eq!(target.settings().amount, 3.0);
        assert_eq!(target.derived_compressor_settings().threshold_db, -25.8);
    }

    #[test]
    fn active_parameter_change_preserves_state_and_uses_new_parameters() {
        let mut changed = NightModeStage::new(48_000.0, settings(8.0)).unwrap();
        let mut copied = NightModeStage::new(48_000.0, settings(3.0)).unwrap();
        let mut previous = NightModeStage::new(48_000.0, settings(8.0)).unwrap();
        let (mut changed_warm_l, mut changed_warm_r) = ([0.8, 0.4], [-0.6, -0.2]);
        let (mut previous_warm_l, mut previous_warm_r) = (changed_warm_l, changed_warm_r);
        changed.process(&mut changed_warm_l, &mut changed_warm_r);
        previous.process(&mut previous_warm_l, &mut previous_warm_r);
        copied.copy_runtime_state_from(&previous).unwrap();
        changed.set_params(settings(3.0)).unwrap();
        let (mut changed_l, mut changed_r) = ([0.3, 0.2], [-0.25, -0.1]);
        let (mut copied_l, mut copied_r) = (changed_l, changed_r);
        changed.process(&mut changed_l, &mut changed_r);
        copied.process(&mut copied_l, &mut copied_r);
        assert_eq!((changed_l, changed_r), (copied_l, copied_r));
        assert_eq!(changed.settings().amount, 3.0);
    }

    #[test]
    fn inactive_to_active_parameter_change_resets_state() {
        let mut toggled = NightModeStage::new(48_000.0, settings(8.0)).unwrap();
        toggled.process(&mut [0.8, 0.4], &mut [-0.6, -0.2]);
        let mut inactive = settings(8.0);
        inactive.enabled = false;
        toggled.set_params(inactive).unwrap();
        toggled.set_params(settings(3.0)).unwrap();
        let mut fresh = NightModeStage::new(48_000.0, settings(3.0)).unwrap();
        let (mut toggled_left, mut toggled_right) = ([0.3, 0.2], [-0.25, -0.1]);
        let (mut fresh_left, mut fresh_right) = (toggled_left, toggled_right);
        toggled.process(&mut toggled_left, &mut toggled_right);
        fresh.process(&mut fresh_left, &mut fresh_right);
        assert_eq!((toggled_left, toggled_right), (fresh_left, fresh_right));
    }

    #[test]
    fn incompatible_restore_is_atomic() {
        let mut target = NightModeStage::new(44_100.0, settings(3.0)).unwrap();
        let mut control = NightModeStage::new(44_100.0, settings(3.0)).unwrap();
        let (mut target_warm_l, mut target_warm_r) = ([0.4, 0.2], [-0.3, -0.1]);
        let (mut control_warm_l, mut control_warm_r) = (target_warm_l, target_warm_r);
        target.process(&mut target_warm_l, &mut target_warm_r);
        control.process(&mut control_warm_l, &mut control_warm_r);
        let foreign = NightModeStage::new(48_000.0, settings(8.0))
            .unwrap()
            .snapshot_runtime_state();
        assert_eq!(
            target.restore_runtime_state(&foreign),
            Err(NightModeRuntimeStateMismatch)
        );
        let (mut target_l, mut target_r) = ([0.3, 0.1], [-0.25, -0.05]);
        let (mut control_l, mut control_r) = (target_l, target_r);
        target.process(&mut target_l, &mut target_r);
        control.process(&mut control_l, &mut control_r);
        assert_eq!((target_l, target_r), (control_l, control_r));
    }
}
