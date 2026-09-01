//! HSE 虚拟低频增强的 HyperPlayer 兼容外观。
//!
//! DSP 算法由 `hse_core::bass_enhancer::BassEnhancerStage` 唯一实现；本模块仅保留
//! HyperPlayer 已发布的参数、生命周期、状态和交错 PCM 适配接口。

use super::Stage;
use hse_core::bass_enhancer::{
    BassEnhancerSettings as CoreBassEnhancerSettings, BassEnhancerStage as CoreBassEnhancerStage,
};

pub use hse_core::bass_enhancer::{BassEnhancerRuntimeState, BassEnhancerRuntimeStateMismatch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HarmonicType {
    Odd,
    Even,
    Atan,
    Soft,
}

impl HarmonicType {
    fn core_name(self) -> &'static str {
        match self {
            Self::Odd => "odd",
            Self::Even => "even",
            Self::Atan => "atan",
            Self::Soft => "soft",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BassEnhancerSettings {
    pub enabled: bool,
    pub cutoff_hz: f64,
    pub q: f64,
    pub harmonic_type: HarmonicType,
    pub harmonic_gain: f64,
    pub mix: f64,
    pub level_db: f64,
    pub low_boost_db: Option<f64>,
}

impl Default for BassEnhancerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            cutoff_hz: 90.0,
            q: 0.7,
            harmonic_type: HarmonicType::Odd,
            harmonic_gain: 0.6,
            mix: 0.5,
            level_db: 0.0,
            low_boost_db: None,
        }
    }
}

impl From<BassEnhancerSettings> for CoreBassEnhancerSettings {
    fn from(settings: BassEnhancerSettings) -> Self {
        Self {
            enabled: settings.enabled,
            cutoff_hz: settings.cutoff_hz,
            q: settings.q,
            harmonic_type: settings.harmonic_type.core_name().to_owned(),
            harmonic_gain: settings.harmonic_gain,
            mix: settings.mix,
            level_db: settings.level_db,
            low_boost_db: settings.low_boost_db,
        }
    }
}

pub struct BassEnhancer {
    sample_rate: f64,
    settings: BassEnhancerSettings,
    inner: CoreBassEnhancerStage,
}

impl Clone for BassEnhancer {
    fn clone(&self) -> Self {
        let state = self.snapshot_runtime_state();
        let mut clone = Self::with_settings(self.sample_rate, self.settings)
            .expect("an existing bass enhancer always has a valid sample rate");
        clone
            .restore_runtime_state(&state)
            .expect("the cloned bass enhancer has the same sample rate");
        clone
    }
}

impl BassEnhancer {
    pub fn new(sample_rate: f64) -> Result<Self, &'static str> {
        Self::with_settings(sample_rate, BassEnhancerSettings::default())
    }

    pub fn with_settings(
        sample_rate: f64,
        settings: BassEnhancerSettings,
    ) -> Result<Self, &'static str> {
        let inner = CoreBassEnhancerStage::from_settings(sample_rate, settings.into())
            .map_err(|_| "invalid sample rate")?;
        Ok(Self {
            sample_rate,
            settings,
            inner,
        })
    }

    pub fn settings(&self) -> BassEnhancerSettings {
        self.settings
    }

    pub fn set_params(&mut self, settings: BassEnhancerSettings) {
        self.settings = settings;
        self.inner.configure(settings.into());
    }

    pub fn configure(&mut self, settings: BassEnhancerSettings) {
        self.set_params(settings);
    }

    pub fn prepare(&mut self, max_block_frames: usize) {
        hse_core::Stage::prepare(&mut self.inner, max_block_frames);
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "左右声道帧数必须一致");
        hse_core::Stage::process(&mut self.inner, left, right);
    }

    pub fn process_planar_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.process_stereo(left, right);
    }

    pub fn process_interleaved_stereo(&mut self, interleaved: &mut [f32]) {
        assert!(
            interleaved.len().is_multiple_of(2),
            "bass-enhancer 要求完整的交错立体声帧"
        );
        for frame in interleaved.as_chunks_mut::<2>().0.iter_mut() {
            let (left, right) = frame.split_at_mut(1);
            hse_core::Stage::process(&mut self.inner, left, right);
        }
    }

    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), BassEnhancerRuntimeStateMismatch> {
        self.inner.copy_runtime_state_from(&source.inner)
    }

    pub fn snapshot_runtime_state(&self) -> BassEnhancerRuntimeState {
        self.inner.snapshot_runtime_state()
    }

    pub fn save_runtime_state(
        &self,
        state: &mut BassEnhancerRuntimeState,
    ) -> Result<(), BassEnhancerRuntimeStateMismatch> {
        self.inner.save_runtime_state(state)
    }

    pub fn restore_runtime_state(
        &mut self,
        state: &BassEnhancerRuntimeState,
    ) -> Result<(), BassEnhancerRuntimeStateMismatch> {
        self.inner.restore_runtime_state(state)
    }

    pub fn reset(&mut self) {
        hse_core::Stage::reset(&mut self.inner);
    }
}

impl Stage for BassEnhancer {
    fn prepare(&mut self, max_block_size: usize) {
        BassEnhancer::prepare(self, max_block_size);
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.process_stereo(left, right);
    }

    fn reset(&mut self) {
        BassEnhancer::reset(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(frames: usize) -> (Vec<f32>, Vec<f32>) {
        let left = (0..frames)
            .map(|index| ((index as f64 * 0.071).sin() * 0.7) as f32)
            .collect();
        let right = (0..frames)
            .map(|index| ((index as f64 * 0.113).cos() * 0.6) as f32)
            .collect();
        (left, right)
    }

    fn process(processor: &mut BassEnhancer, left: &[f32], right: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut output_left = left.to_vec();
        let mut output_right = right.to_vec();
        processor.process_stereo(&mut output_left, &mut output_right);
        (output_left, output_right)
    }

    #[test]
    fn harmonic_types_map_to_exact_core_names() {
        for (harmonic_type, name) in [
            (HarmonicType::Odd, "odd"),
            (HarmonicType::Even, "even"),
            (HarmonicType::Atan, "atan"),
            (HarmonicType::Soft, "soft"),
        ] {
            let core: CoreBassEnhancerSettings = BassEnhancerSettings {
                harmonic_type,
                ..BassEnhancerSettings::default()
            }
            .into();
            assert_eq!(core.harmonic_type, name);
        }
    }

    #[test]
    fn facade_matches_core_for_planar_and_interleaved_processing() {
        let settings = BassEnhancerSettings {
            cutoff_hz: 135.0,
            q: 1.2,
            harmonic_type: HarmonicType::Atan,
            harmonic_gain: 0.73,
            mix: 0.41,
            level_db: 2.0,
            low_boost_db: Some(4.0),
            ..BassEnhancerSettings::default()
        };
        let (left, right) = signal(257);
        let mut facade = BassEnhancer::with_settings(44_100.0, settings).unwrap();
        let mut core = CoreBassEnhancerStage::from_settings(44_100.0, settings.into()).unwrap();
        let mut facade_left = left.clone();
        let mut facade_right = right.clone();
        let mut core_left = left.clone();
        let mut core_right = right.clone();

        facade.process_planar_stereo(&mut facade_left, &mut facade_right);
        hse_core::Stage::process(&mut core, &mut core_left, &mut core_right);
        assert_eq!(
            (facade_left.clone(), facade_right.clone()),
            (core_left, core_right)
        );

        let mut interleaved = Vec::with_capacity(left.len() * 2);
        for (&left, &right) in left.iter().zip(&right) {
            interleaved.extend_from_slice(&[left, right]);
        }
        let mut interleaved_facade = BassEnhancer::with_settings(44_100.0, settings).unwrap();
        interleaved_facade.process_interleaved_stereo(&mut interleaved);
        for (index, frame) in interleaved.as_chunks::<2>().0.iter().enumerate() {
            assert_eq!(frame, &[facade_left[index], facade_right[index]]);
        }
    }

    #[test]
    fn clone_copy_snapshot_configure_and_reset_preserve_lifecycle() {
        let (prefix_left, prefix_right) = signal(191);
        let (continuation_left, continuation_right) = signal(127);
        let mut source = BassEnhancer::new(48_000.0).unwrap();
        process(&mut source, &prefix_left, &prefix_right);

        let mut cloned = source.clone();
        let mut copied = BassEnhancer::new(48_000.0).unwrap();
        copied.copy_runtime_state_from(&source).unwrap();
        let checkpoint = source.snapshot_runtime_state();
        let mut saved = BassEnhancer::new(48_000.0)
            .unwrap()
            .snapshot_runtime_state();
        source.save_runtime_state(&mut saved).unwrap();
        let mut restored = BassEnhancer::new(48_000.0).unwrap();
        restored.restore_runtime_state(&checkpoint).unwrap();
        let mut saved_restored = BassEnhancer::new(48_000.0).unwrap();
        saved_restored.restore_runtime_state(&saved).unwrap();

        let expected = process(&mut source, &continuation_left, &continuation_right);
        assert_eq!(
            process(&mut cloned, &continuation_left, &continuation_right),
            expected
        );
        assert_eq!(
            process(&mut copied, &continuation_left, &continuation_right),
            expected
        );
        assert_eq!(
            process(&mut restored, &continuation_left, &continuation_right),
            expected
        );
        assert_eq!(
            process(&mut saved_restored, &continuation_left, &continuation_right),
            expected
        );

        let configured = BassEnhancerSettings {
            harmonic_type: HarmonicType::Soft,
            mix: 0.25,
            ..BassEnhancerSettings::default()
        };
        source.configure(configured);
        assert_eq!(source.settings(), configured);

        let input = signal(31);
        source.reset();
        let reset_output = process(&mut source, &input.0, &input.1);
        let fresh_output = process(
            &mut BassEnhancer::with_settings(48_000.0, configured).unwrap(),
            &input.0,
            &input.1,
        );
        assert_eq!(reset_output, fresh_output);
    }

    #[test]
    fn validation_errors_and_disabled_state_are_preserved() {
        for sample_rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                BassEnhancer::new(sample_rate).err(),
                Some("invalid sample rate")
            );
        }

        let settings = BassEnhancerSettings {
            enabled: false,
            ..BassEnhancerSettings::default()
        };
        let mut processor = BassEnhancer::with_settings(48_000.0, settings).unwrap();
        let mut input = [-0.0_f32, 0.25, -0.5, 1.0];
        let bits = input.map(f32::to_bits);
        processor.process_interleaved_stereo(&mut input);
        assert_eq!(input.map(f32::to_bits), bits);

        let state = processor.snapshot_runtime_state();
        assert!(BassEnhancer::new(44_100.0)
            .unwrap()
            .restore_runtime_state(&state)
            .is_err());

        let source = BassEnhancer::new(48_000.0).unwrap();
        let mut mismatch = BassEnhancer::new(44_100.0).unwrap();
        assert_eq!(
            mismatch.copy_runtime_state_from(&source),
            Err(BassEnhancerRuntimeStateMismatch)
        );
    }
}
