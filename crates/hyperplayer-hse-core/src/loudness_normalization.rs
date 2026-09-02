//! HSE v1.5.1 Stage 1 响度归一化。
//!
//! 每块显式接收 Stage 19 在上一块结束后产生的 integrated/momentary 读数；本模块
//! 不持有发布层或线程同步原语，是生产增益、平滑与采样写回数学的唯一实现。

use std::fmt;

const REALTIME_SMOOTH_SECONDS: f64 = 3.0;
const MANUAL_SMOOTH_SECONDS: f64 = 0.08;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessNormalizationSettings {
    pub enabled: bool,
    pub target_lufs: f64,
    pub max_gain_db: f64,
    pub min_gain_db: f64,
    pub use_realtime_meter: bool,
    pub external_gain_db: f64,
}

impl Default for LoudnessNormalizationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            target_lufs: -14.0,
            max_gain_db: 9.0,
            min_gain_db: -9.0,
            use_realtime_meter: true,
            external_gain_db: 0.0,
        }
    }
}

impl LoudnessNormalizationSettings {
    pub fn validate(self) -> Result<Self, String> {
        for (name, value) in [
            ("target_lufs", self.target_lufs),
            ("max_gain_db", self.max_gain_db),
            ("min_gain_db", self.min_gain_db),
            ("external_gain_db", self.external_gain_db),
        ] {
            if !value.is_finite() {
                return Err(format!("loudness normalization {name} must be finite"));
            }
        }
        if !(-40.0..=0.0).contains(&self.target_lufs) {
            return Err("loudness normalization target_lufs must be between -40 and 0".into());
        }
        if !(0.0..=24.0).contains(&self.max_gain_db) {
            return Err("loudness normalization max_gain_db must be between 0 and 24".into());
        }
        if !(-24.0..=0.0).contains(&self.min_gain_db) {
            return Err("loudness normalization min_gain_db must be between -24 and 0".into());
        }
        if !(-24.0..=24.0).contains(&self.external_gain_db) {
            return Err(
                "loudness normalization external_gain_db must be between -24 and 24".into(),
            );
        }
        if self.min_gain_db > self.max_gain_db {
            return Err("loudness normalization min_gain_db cannot exceed max_gain_db".into());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessNormalizationReadings {
    pub integrated_lufs: f64,
    pub momentary_lufs: f64,
}

impl LoudnessNormalizationReadings {
    pub const fn unmeasured() -> Self {
        Self {
            integrated_lufs: f64::NAN,
            momentary_lufs: f64::NAN,
        }
    }
}

/// 固定大小的连续处理状态；参数更新或恢复 checkpoint 时不随状态覆盖。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessNormalizationRuntimeState {
    sample_rate_bits: u64,
    gain: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoudnessNormalizationRuntimeStateMismatch;

impl fmt::Display for LoudnessNormalizationRuntimeStateMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("loudness normalization runtime state sample rate mismatch")
    }
}

impl std::error::Error for LoudnessNormalizationRuntimeStateMismatch {}

#[derive(Debug, Clone)]
pub struct LoudnessNormalizationStage {
    sample_rate: f64,
    settings: LoudnessNormalizationSettings,
    gain: f64,
}

impl LoudnessNormalizationStage {
    pub fn new(sample_rate: f64) -> Result<Self, String> {
        if !(sample_rate.is_finite() && sample_rate > 0.0) {
            return Err("invalid sample rate".into());
        }
        Ok(Self {
            sample_rate,
            settings: LoudnessNormalizationSettings::default(),
            gain: 1.0,
        })
    }

    pub fn set_params(&mut self, settings: LoudnessNormalizationSettings) -> Result<(), String> {
        let settings = settings.validate()?;
        if !settings.enabled {
            self.gain = 1.0;
        }
        self.settings = settings;
        Ok(())
    }

    pub fn settings(&self) -> LoudnessNormalizationSettings {
        self.settings
    }

    pub fn gain(&self) -> f64 {
        self.gain
    }

    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        prior: LoudnessNormalizationReadings,
    ) {
        assert_eq!(left.len(), right.len(), "左右声道块长必须一致");
        if !self.settings.enabled {
            return;
        }
        let realtime = self.settings.use_realtime_meter;
        let gain_db = if realtime {
            let measured = if prior.integrated_lufs.is_finite() {
                prior.integrated_lufs
            } else {
                prior.momentary_lufs
            };
            if measured.is_finite() {
                (self.settings.target_lufs - measured)
                    .clamp(self.settings.min_gain_db, self.settings.max_gain_db)
            } else {
                0.0
            }
        } else {
            self.settings
                .external_gain_db
                .clamp(self.settings.min_gain_db, self.settings.max_gain_db)
        };
        let seconds = if realtime {
            REALTIME_SMOOTH_SECONDS
        } else {
            MANUAL_SMOOTH_SECONDS
        };
        let alpha = 1.0 - (-(left.len() as f64 / self.sample_rate) / seconds).exp();
        self.gain += alpha * (10f64.powf(gain_db / 20.0) - self.gain);
        for index in 0..left.len() {
            left[index] = (f64::from(left[index]) * self.gain) as f32;
            right[index] = (f64::from(right[index]) * self.gain) as f32;
        }
    }

    pub fn reset(&mut self) {
        self.gain = 1.0;
    }

    pub fn snapshot_runtime_state(&self) -> LoudnessNormalizationRuntimeState {
        LoudnessNormalizationRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            gain: self.gain,
        }
    }

    pub fn save_runtime_state(
        &self,
        state: &mut LoudnessNormalizationRuntimeState,
    ) -> Result<(), LoudnessNormalizationRuntimeStateMismatch> {
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return Err(LoudnessNormalizationRuntimeStateMismatch);
        }
        state.gain = self.gain;
        Ok(())
    }

    pub fn restore_runtime_state(
        &mut self,
        state: &LoudnessNormalizationRuntimeState,
    ) -> Result<(), LoudnessNormalizationRuntimeStateMismatch> {
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return Err(LoudnessNormalizationRuntimeStateMismatch);
        }
        self.gain = state.gain;
        Ok(())
    }

    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), LoudnessNormalizationRuntimeStateMismatch> {
        if self.sample_rate.to_bits() != source.sample_rate.to_bits() {
            return Err(LoudnessNormalizationRuntimeStateMismatch);
        }
        self.gain = source.gain;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual() -> LoudnessNormalizationSettings {
        LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: 6.0,
            ..LoudnessNormalizationSettings::default()
        }
    }

    #[test]
    fn manual_external_and_realtime_paths_match_hse_v1_5_1_math() {
        let cases = [
            (
                manual(),
                LoudnessNormalizationReadings::unmeasured(),
                0.08,
                6.0,
            ),
            (
                LoudnessNormalizationSettings {
                    enabled: true,
                    ..LoudnessNormalizationSettings::default()
                },
                LoudnessNormalizationReadings {
                    integrated_lufs: -20.0,
                    momentary_lufs: -9.0,
                },
                3.0,
                6.0,
            ),
            (
                LoudnessNormalizationSettings {
                    enabled: true,
                    ..LoudnessNormalizationSettings::default()
                },
                LoudnessNormalizationReadings {
                    integrated_lufs: f64::NAN,
                    momentary_lufs: -18.0,
                },
                3.0,
                4.0,
            ),
        ];
        for (settings, readings, seconds, db) in cases {
            let mut stage = LoudnessNormalizationStage::new(48_000.0).unwrap();
            stage.set_params(settings).unwrap();
            let mut left = [0.25_f32, 0.75];
            let mut right = [-0.5_f32, -1.0];
            stage.process(&mut left, &mut right, readings);
            let alpha = 1.0 - (-(2.0_f64 / 48_000.0) / seconds).exp();
            let gain = 1.0 + alpha * (10.0_f64.powf(db / 20.0) - 1.0);
            assert_eq!(stage.gain().to_bits(), gain.to_bits());
            assert_eq!(left[0].to_bits(), ((0.25_f64 * gain) as f32).to_bits());
            assert_eq!(right[0].to_bits(), ((-0.5_f64 * gain) as f32).to_bits());
        }
    }

    #[test]
    fn disabled_is_transparent_and_checkpoint_preserves_new_parameters() {
        let mut source = LoudnessNormalizationStage::new(48_000.0).unwrap();
        source.set_params(manual()).unwrap();
        source.process(
            &mut [0.25; 128],
            &mut [-0.5; 128],
            LoudnessNormalizationReadings::unmeasured(),
        );
        let checkpoint = source.snapshot_runtime_state();

        let target_settings = LoudnessNormalizationSettings {
            external_gain_db: -3.0,
            ..manual()
        };
        let mut target = LoudnessNormalizationStage::new(48_000.0).unwrap();
        target.set_params(target_settings).unwrap();
        target.restore_runtime_state(&checkpoint).unwrap();
        assert_eq!(target.settings(), target_settings);
        assert_eq!(target.gain(), source.gain());

        target
            .set_params(LoudnessNormalizationSettings::default())
            .unwrap();
        let mut left = [-0.0_f32, f32::from_bits(1)];
        let mut right = [f32::NAN, 1.0];
        let expected_left = left.map(f32::to_bits);
        let expected_right = right.map(f32::to_bits);
        target.process(
            &mut left,
            &mut right,
            LoudnessNormalizationReadings::unmeasured(),
        );
        assert_eq!(left.map(f32::to_bits), expected_left);
        assert_eq!(right.map(f32::to_bits), expected_right);
        assert_eq!(target.gain(), 1.0);
    }
}
