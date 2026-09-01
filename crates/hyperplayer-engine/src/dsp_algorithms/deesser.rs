//! HSE de-esser 的 HyperPlayer 适配层。
//!
//! DSP 算法由 `hse_core::deesser::DeesserStage` 唯一实现；本模块仅保留 HyperPlayer
//! 已发布的参数、生命周期和校验接口。

use super::Stage;

pub use hse_core::deesser::{DeesserRuntimeState, DeesserRuntimeStateMismatch};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeesserSettings {
    pub enabled: bool,
    pub center_hz: f64,
    pub q: f64,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub split_band: bool,
    pub mix: f64,
    /// 引擎接线标志；算法仅在显式提供外部 sidechain 时使用外部检测信号。
    pub sidechain_enabled: bool,
}

impl Default for DeesserSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            center_hz: 6_000.0,
            q: 0.7,
            threshold_db: -30.0,
            ratio: 8.0,
            attack_ms: 1.0,
            release_ms: 80.0,
            split_band: true,
            mix: 1.0,
            sidechain_enabled: false,
        }
    }
}

impl From<DeesserSettings> for hse_core::deesser::DeesserSettings {
    fn from(settings: DeesserSettings) -> Self {
        Self {
            enabled: settings.enabled,
            center_hz: settings.center_hz,
            q: settings.q,
            threshold_db: settings.threshold_db,
            ratio: settings.ratio,
            attack_ms: settings.attack_ms,
            release_ms: settings.release_ms,
            split_band: settings.split_band,
            mix: settings.mix,
            sidechain_enabled: settings.sidechain_enabled,
        }
    }
}

pub struct DeesserStage {
    sample_rate: f64,
    settings: DeesserSettings,
    inner: hse_core::deesser::DeesserStage,
}

impl Clone for DeesserStage {
    fn clone(&self) -> Self {
        let state = self.inner.snapshot_runtime_state();
        let mut clone = Self::from_settings(self.sample_rate, self.settings)
            .expect("an existing de-esser always has a valid sample rate");
        clone
            .inner
            .restore_runtime_state(&state)
            .expect("the cloned de-esser has the same sample rate");
        clone
    }
}

impl DeesserStage {
    pub fn new(sample_rate: f64) -> Result<Self, String> {
        Self::from_settings(sample_rate, DeesserSettings::default())
    }

    pub fn from_settings(sample_rate: f64, settings: DeesserSettings) -> Result<Self, String> {
        hse_core::deesser::DeesserStage::from_settings(sample_rate, settings.into()).map(|inner| {
            Self {
                sample_rate,
                settings,
                inner,
            }
        })
    }

    pub fn settings(&self) -> DeesserSettings {
        self.settings
    }

    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), DeesserRuntimeStateMismatch> {
        self.inner.copy_runtime_state_from(&source.inner)
    }

    pub fn snapshot_runtime_state(&self) -> DeesserRuntimeState {
        self.inner.snapshot_runtime_state()
    }

    pub fn save_runtime_state(
        &self,
        state: &mut DeesserRuntimeState,
    ) -> Result<(), DeesserRuntimeStateMismatch> {
        self.inner.save_runtime_state(state)
    }

    pub fn restore_runtime_state(
        &mut self,
        state: &DeesserRuntimeState,
    ) -> Result<(), DeesserRuntimeStateMismatch> {
        self.inner.restore_runtime_state(state)
    }

    /// 参数即时生效，保留包络和全部滤波器状态。
    pub fn set_params(&mut self, settings: DeesserSettings) {
        self.settings = settings;
        self.inner.configure(settings.into());
    }

    /// HSE Rust 端兼容参数更新名。
    pub fn configure(&mut self, settings: DeesserSettings) {
        self.set_params(settings);
    }

    pub fn process_with_sidechain(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        side_left: &[f32],
        side_right: &[f32],
    ) {
        assert_eq!(left.len(), right.len(), "左右声道帧数必须一致");
        assert!(side_left.len() >= left.len() && side_right.len() >= left.len());
        self.inner
            .process_with_sidechain(left, right, side_left, side_right);
    }
}

impl Stage for DeesserStage {
    fn prepare(&mut self, max_block_size: usize) {
        hse_core::Stage::prepare(&mut self.inner, max_block_size);
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "左右声道帧数必须一致");
        hse_core::Stage::process(&mut self.inner, left, right);
    }

    fn reset(&mut self) {
        hse_core::Stage::reset(&mut self.inner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(length: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        (0..length)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((f64::from(state) / 4_294_967_296.0) * 1.8 - 0.9) as f32
            })
            .collect()
    }

    fn process(stage: &mut DeesserStage, left: &[f32], right: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut output_left = left.to_vec();
        let mut output_right = right.to_vec();
        stage.process(&mut output_left, &mut output_right);
        (output_left, output_right)
    }

    #[test]
    fn facade_matches_hse_core() {
        let settings = DeesserSettings {
            center_hz: 7_200.0,
            threshold_db: -42.0,
            sidechain_enabled: true,
            ..DeesserSettings::default()
        };
        let left = signal(257, 1);
        let right = signal(257, 2);
        let side_left = signal(257, 3);
        let side_right = signal(257, 4);
        let mut facade = DeesserStage::from_settings(44_100.0, settings).unwrap();
        let mut core =
            hse_core::deesser::DeesserStage::from_settings(44_100.0, settings.into()).unwrap();
        let mut facade_left = left.clone();
        let mut facade_right = right.clone();
        let mut core_left = left;
        let mut core_right = right;

        facade.process_with_sidechain(&mut facade_left, &mut facade_right, &side_left, &side_right);
        core.process_with_sidechain(&mut core_left, &mut core_right, &side_left, &side_right);

        assert_eq!((facade_left, facade_right), (core_left, core_right));
    }

    #[test]
    fn clone_copy_snapshot_and_reset_preserve_lifecycle() {
        let prefix_left = signal(191, 5);
        let prefix_right = signal(191, 6);
        let continuation_left = signal(127, 7);
        let continuation_right = signal(127, 8);
        let mut source = DeesserStage::new(48_000.0).unwrap();
        process(&mut source, &prefix_left, &prefix_right);

        let mut cloned = source.clone();
        let checkpoint = source.snapshot_runtime_state();
        let mut restored = DeesserStage::new(48_000.0).unwrap();
        restored.restore_runtime_state(&checkpoint).unwrap();
        let mut copied = DeesserStage::new(48_000.0).unwrap();
        copied.copy_runtime_state_from(&source).unwrap();

        let expected = process(&mut source, &continuation_left, &continuation_right);
        assert_eq!(
            process(&mut cloned, &continuation_left, &continuation_right),
            expected
        );
        assert_eq!(
            process(&mut restored, &continuation_left, &continuation_right),
            expected
        );
        assert_eq!(
            process(&mut copied, &continuation_left, &continuation_right),
            expected
        );

        copied.reset();
        let mut fresh = DeesserStage::new(48_000.0).unwrap();
        assert_eq!(
            process(&mut copied, &continuation_left, &continuation_right),
            process(&mut fresh, &continuation_left, &continuation_right)
        );
    }

    #[test]
    fn configure_preserves_runtime_state() {
        let left = signal(223, 9);
        let right = signal(223, 10);
        let mut configured = DeesserStage::new(48_000.0).unwrap();
        process(&mut configured, &left, &right);
        let mut copied = configured.clone();
        let settings = DeesserSettings {
            center_hz: 4_200.0,
            q: 2.0,
            ..DeesserSettings::default()
        };
        configured.configure(settings);
        copied.set_params(settings);

        assert_eq!(
            process(&mut configured, &left, &right),
            process(&mut copied, &left, &right)
        );
    }

    #[test]
    fn cross_sample_rate_copy_returns_an_error() {
        let source = DeesserStage::new(48_000.0).unwrap();
        let mut target = DeesserStage::new(44_100.0).unwrap();

        assert_eq!(
            target.copy_runtime_state_from(&source),
            Err(DeesserRuntimeStateMismatch)
        );
    }

    #[test]
    #[should_panic(expected = "左右声道帧数必须一致")]
    fn channel_length_validation_is_active_in_release_builds() {
        let mut stage = DeesserStage::new(48_000.0).unwrap();
        stage.process(&mut [0.0], &mut []);
    }

    #[test]
    #[should_panic]
    fn sidechain_length_validation_is_active_in_release_builds() {
        let mut stage = DeesserStage::new(48_000.0).unwrap();
        stage.process_with_sidechain(&mut [0.0], &mut [0.0], &[], &[]);
    }
}
