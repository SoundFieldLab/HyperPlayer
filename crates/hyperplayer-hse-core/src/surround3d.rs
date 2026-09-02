//! HSE v1.5.1 Stage 2 轻量 3D 环绕旋转。
//!
//! 相位按块推进，整块共用一次旋转矩阵；中间计算保持 `f64`，仅在写回平面
//! `f32` PCM 时量化。此模块是生产采样数学与连续运行状态的唯一实现。

use crate::Stage;
use std::fmt;

/// Stage 2 参数快照。参数不做范围钳制，以保持 HSE 整链原有行为。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Surround3dSettings {
    pub enabled: bool,
    pub distance: f64,
    pub speed: f64,
    pub angle: f64,
    pub direction: f64,
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

impl Surround3dSettings {
    fn validate(self) -> Result<(), String> {
        if [self.distance, self.speed, self.angle, self.direction]
            .into_iter()
            .any(|value| !value.is_finite())
        {
            return Err("surround3d settings must be finite".into());
        }
        Ok(())
    }
}

/// 固定大小的连续处理状态；不包含参数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Surround3dRuntimeState {
    sample_rate_bits: u64,
    phase: f64,
}

/// Surround3D 状态与目标实例的采样率不兼容。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Surround3dRuntimeStateMismatch;

impl fmt::Display for Surround3dRuntimeStateMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("surround3d runtime state sample rate mismatch")
    }
}

impl std::error::Error for Surround3dRuntimeStateMismatch {}

#[derive(Debug, Clone)]
pub struct Surround3dStage {
    sample_rate: f64,
    settings: Surround3dSettings,
    phase: f64,
}

impl Surround3dStage {
    pub fn new(sample_rate: f64) -> Result<Self, String> {
        if !(sample_rate.is_finite() && sample_rate > 0.0) {
            return Err("invalid sample rate".into());
        }
        Ok(Self {
            sample_rate,
            settings: Surround3dSettings::default(),
            phase: 0.0,
        })
    }

    /// 原子替换参数；失败时目标参数与运行状态均保持不变。
    pub fn set_params(&mut self, settings: Surround3dSettings) -> Result<(), String> {
        settings.validate()?;
        self.settings = settings;
        Ok(())
    }

    pub fn settings(&self) -> Surround3dSettings {
        self.settings
    }

    pub fn phase(&self) -> f64 {
        self.phase
    }

    pub fn snapshot_runtime_state(&self) -> Surround3dRuntimeState {
        Surround3dRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            phase: self.phase,
        }
    }

    /// 将当前状态写入已有快照；不兼容时原子拒绝，不修改快照。
    pub fn save_runtime_state(
        &self,
        state: &mut Surround3dRuntimeState,
    ) -> Result<(), Surround3dRuntimeStateMismatch> {
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return Err(Surround3dRuntimeStateMismatch);
        }
        state.phase = self.phase;
        Ok(())
    }

    /// 恢复相位但保留目标参数；不兼容时不修改目标。
    pub fn restore_runtime_state(
        &mut self,
        state: &Surround3dRuntimeState,
    ) -> Result<(), Surround3dRuntimeStateMismatch> {
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return Err(Surround3dRuntimeStateMismatch);
        }
        self.phase = state.phase;
        Ok(())
    }

    /// 从同采样率实例复制相位，保留目标参数。
    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), Surround3dRuntimeStateMismatch> {
        if self.sample_rate.to_bits() != source.sample_rate.to_bits() {
            return Err(Surround3dRuntimeStateMismatch);
        }
        self.phase = source.phase;
        Ok(())
    }
}

impl Stage for Surround3dStage {
    fn prepare(&mut self, _max_block_size: usize) {}

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "左右声道块长必须一致");
        if !self.settings.enabled {
            return;
        }

        self.phase += 2.0
            * std::f64::consts::PI
            * self.settings.speed
            * (left.len() as f64 / self.sample_rate)
            * 0.125;
        let theta = self.settings.angle * std::f64::consts::PI / 180.0
            + self.settings.direction * self.phase;
        let (cosine, sine) = (theta.cos(), theta.sin());
        let scale = 0.5 + 0.5 * self.settings.distance;
        for index in 0..left.len() {
            let (x, y) = (f64::from(left[index]), f64::from(right[index]));
            left[index] = ((x * cosine - y * sine) * scale) as f32;
            right[index] = ((x * sine + y * cosine) * scale) as f32;
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> Surround3dSettings {
        Surround3dSettings {
            enabled: true,
            distance: 0.4,
            speed: 0.7,
            angle: 11.0,
            direction: -1.0,
        }
    }

    #[test]
    fn matches_the_previous_inline_rotation_bit_for_bit() {
        let mut stage = Surround3dStage::new(48_000.0).unwrap();
        stage.set_params(enabled()).unwrap();
        let mut left = [0.25_f32, -0.5, 1.0];
        let mut right = [-0.75_f32, 0.125, 0.5];

        stage.process(&mut left, &mut right);

        let phase = 2.0 * std::f64::consts::PI * 0.7 * (3.0 / 48_000.0) * 0.125;
        let theta = 11.0 * std::f64::consts::PI / 180.0 - phase;
        let (cosine, sine) = (theta.cos(), theta.sin());
        let scale = 0.7;
        let input_left = [0.25_f32, -0.5, 1.0];
        let input_right = [-0.75_f32, 0.125, 0.5];
        let expected_left = std::array::from_fn::<_, 3, _>(|index| {
            ((f64::from(input_left[index]) * cosine - f64::from(input_right[index]) * sine) * scale)
                as f32
        });
        let expected_right = std::array::from_fn::<_, 3, _>(|index| {
            ((f64::from(input_left[index]) * sine + f64::from(input_right[index]) * cosine) * scale)
                as f32
        });
        assert_eq!(left.map(f32::to_bits), expected_left.map(f32::to_bits));
        assert_eq!(right.map(f32::to_bits), expected_right.map(f32::to_bits));
        assert_eq!(stage.phase(), phase);
    }

    #[test]
    fn disabled_is_bit_exact_and_freezes_phase() {
        let mut stage = Surround3dStage::new(48_000.0).unwrap();
        let mut left = [-0.0_f32, f32::from_bits(1)];
        let mut right = [f32::NAN, 1.0];
        let expected_left = left.map(f32::to_bits);
        let expected_right = right.map(f32::to_bits);
        stage.process(&mut left, &mut right);
        assert_eq!(left.map(f32::to_bits), expected_left);
        assert_eq!(right.map(f32::to_bits), expected_right);
        assert_eq!(stage.phase(), 0.0);
    }

    #[test]
    fn checkpoint_restore_copy_preserve_target_parameters_and_replay() {
        let mut source = Surround3dStage::new(48_000.0).unwrap();
        source.set_params(enabled()).unwrap();
        source.process(&mut [0.25; 4], &mut [-0.5; 4]);
        let mut checkpoint = source.snapshot_runtime_state();

        let target_settings = Surround3dSettings {
            enabled: true,
            distance: 0.9,
            speed: 2.5,
            angle: -30.0,
            direction: 1.0,
        };
        let mut restored = Surround3dStage::new(48_000.0).unwrap();
        restored.set_params(target_settings).unwrap();
        restored.restore_runtime_state(&checkpoint).unwrap();
        assert_eq!(restored.settings(), target_settings);
        assert_eq!(restored.phase(), source.phase());

        let mut copied = Surround3dStage::new(48_000.0).unwrap();
        copied.set_params(target_settings).unwrap();
        copied.copy_runtime_state_from(&source).unwrap();
        assert_eq!(copied.settings(), target_settings);

        source.process(&mut [0.1; 2], &mut [0.2; 2]);
        source.save_runtime_state(&mut checkpoint).unwrap();
        restored.restore_runtime_state(&checkpoint).unwrap();
        let mut source_left = [0.3_f32, -0.4];
        let mut source_right = [-0.2_f32, 0.6];
        let mut restored_left = source_left;
        let mut restored_right = source_right;
        source.set_params(target_settings).unwrap();
        source.process(&mut source_left, &mut source_right);
        restored.process(&mut restored_left, &mut restored_right);
        assert_eq!(
            source_left.map(f32::to_bits),
            restored_left.map(f32::to_bits)
        );
        assert_eq!(
            source_right.map(f32::to_bits),
            restored_right.map(f32::to_bits)
        );
    }

    #[test]
    fn incompatible_state_operations_are_atomic() {
        let mut source = Surround3dStage::new(44_100.0).unwrap();
        source.set_params(enabled()).unwrap();
        source.process(&mut [0.25; 3], &mut [-0.5; 3]);
        let mut checkpoint = source.snapshot_runtime_state();

        let mut target = Surround3dStage::new(48_000.0).unwrap();
        target.set_params(enabled()).unwrap();
        target.process(&mut [0.1; 2], &mut [0.2; 2]);
        let before_target = target.snapshot_runtime_state();
        let before_checkpoint = checkpoint;
        assert_eq!(
            target.restore_runtime_state(&checkpoint),
            Err(Surround3dRuntimeStateMismatch)
        );
        assert_eq!(target.snapshot_runtime_state(), before_target);
        assert_eq!(
            target.copy_runtime_state_from(&source),
            Err(Surround3dRuntimeStateMismatch)
        );
        assert_eq!(target.snapshot_runtime_state(), before_target);
        assert_eq!(
            target.save_runtime_state(&mut checkpoint),
            Err(Surround3dRuntimeStateMismatch)
        );
        assert_eq!(checkpoint, before_checkpoint);
    }

    #[test]
    fn reset_replays_the_initial_block_and_preserves_settings() {
        let mut stage = Surround3dStage::new(44_100.0).unwrap();
        stage.set_params(enabled()).unwrap();
        let mut first_left = [0.5_f32, 0.75];
        let mut first_right = [-0.25_f32, 0.125];
        stage.process(&mut first_left, &mut first_right);
        stage.reset();
        assert_eq!(stage.settings(), enabled());
        assert_eq!(stage.phase(), 0.0);
        let mut replay_left = [0.5_f32, 0.75];
        let mut replay_right = [-0.25_f32, 0.125];
        stage.process(&mut replay_left, &mut replay_right);
        assert_eq!(first_left.map(f32::to_bits), replay_left.map(f32::to_bits));
        assert_eq!(
            first_right.map(f32::to_bits),
            replay_right.map(f32::to_bits)
        );
    }
}
