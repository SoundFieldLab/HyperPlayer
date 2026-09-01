//! HSE v1.5.1 动态压缩器的 HyperPlayer 兼容外观。

use hse_core::compressor::{
    CompressorSettings as CoreCompressorSettings, CompressorStage as CoreCompressorStage,
};
use hse_core::Stage;
use std::fmt;

pub use hse_core::compressor::{CompressorRuntimeState, CompressorRuntimeStateMismatch};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompressorSettings {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub knee_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
    pub output_gain: f64,
    /// 接线层元数据；普通处理入口始终使用压缩器自身的立体声联合包络。
    pub sidechain_enabled: bool,
}

impl Default for CompressorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_db: -20.0,
            ratio: 4.0,
            knee_db: 6.0,
            attack_ms: 10.0,
            release_ms: 150.0,
            makeup_db: 0.0,
            output_gain: 1.0,
            sidechain_enabled: false,
        }
    }
}

impl From<CompressorSettings> for CoreCompressorSettings {
    fn from(settings: CompressorSettings) -> Self {
        Self {
            enabled: settings.enabled,
            threshold_db: settings.threshold_db,
            ratio: settings.ratio,
            knee_db: settings.knee_db,
            attack_ms: settings.attack_ms,
            release_ms: settings.release_ms,
            makeup_db: settings.makeup_db,
            output_gain: settings.output_gain,
            // HyperPlayer 的该字段仅描述路由；外部总线只由显式入口接入。
            sidechain_enabled: false,
        }
    }
}

pub struct Compressor {
    sample_rate: f64,
    settings: CompressorSettings,
    inner: CoreCompressorStage,
}

impl fmt::Debug for Compressor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Compressor")
            .field("sample_rate", &self.sample_rate)
            .field("settings", &self.settings)
            .field("reduction_db", &self.reduction_db())
            .finish_non_exhaustive()
    }
}

impl Clone for Compressor {
    fn clone(&self) -> Self {
        let state = self.snapshot_runtime_state();
        let mut clone = Self::from_settings(self.sample_rate, self.settings)
            .expect("已构造的压缩器采样率必须保持有效");
        clone
            .restore_runtime_state(&state)
            .expect("克隆压缩器的采样率必须与源实例一致");
        clone
    }
}

impl Compressor {
    pub fn new(sample_rate: f64) -> Result<Self, &'static str> {
        Self::with_settings(sample_rate, CompressorSettings::default())
    }

    pub fn with_settings(
        sample_rate: f64,
        settings: CompressorSettings,
    ) -> Result<Self, &'static str> {
        Self::from_settings(sample_rate, settings)
    }

    /// HSE Rust 端兼容构造名，便于中央 DSP 模块直接接线。
    pub fn from_settings(
        sample_rate: f64,
        settings: CompressorSettings,
    ) -> Result<Self, &'static str> {
        let inner = CoreCompressorStage::from_settings(sample_rate, settings.into())
            .map_err(|_| "invalid sample rate")?;
        Ok(Self {
            sample_rate,
            settings,
            inner,
        })
    }

    pub fn prepare(&mut self, max_block_frames: usize) {
        self.inner.prepare(max_block_frames);
    }

    pub fn settings(&self) -> CompressorSettings {
        self.settings
    }

    /// 参数即时生效，但保留核心中的包络和衰减报告状态。
    pub fn set_params(&mut self, settings: CompressorSettings) {
        self.settings = settings;
        self.inner.configure(settings.into());
    }

    pub fn configure(&mut self, settings: CompressorSettings) {
        self.set_params(settings);
    }

    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), CompressorRuntimeStateMismatch> {
        self.inner.copy_runtime_state_from(&source.inner)
    }

    pub fn snapshot_runtime_state(&self) -> CompressorRuntimeState {
        self.inner.snapshot_runtime_state()
    }

    pub fn save_runtime_state(
        &self,
        state: &mut CompressorRuntimeState,
    ) -> Result<(), CompressorRuntimeStateMismatch> {
        self.inner.save_runtime_state(state)
    }

    pub fn restore_runtime_state(
        &mut self,
        state: &CompressorRuntimeState,
    ) -> Result<(), CompressorRuntimeStateMismatch> {
        self.inner.restore_runtime_state(state)
    }

    pub fn reduction_db(&self) -> f64 {
        self.inner.reduction_db()
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "左右声道帧数必须一致");
        self.inner.process(left, right);
    }

    pub fn process_stereo_with_sidechain(
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

    /// 就地处理双声道交错 PCM；适配 HyperPlayer `PcmBlock.interleaved`。
    pub fn process_interleaved_stereo(&mut self, interleaved: &mut [f32]) {
        assert!(
            interleaved.len().is_multiple_of(2),
            "双声道交错缓冲长度必须为偶数"
        );
        for frame in interleaved.chunks_exact_mut(2) {
            let (left, right) = frame.split_at_mut(1);
            self.inner.process(left, right);
        }
    }

    /// 外部 sidechain 也是双声道交错 PCM；主信号与检测信号帧数必须一致。
    pub fn process_interleaved_stereo_with_sidechain(
        &mut self,
        interleaved: &mut [f32],
        sidechain: &[f32],
    ) {
        assert!(interleaved.len().is_multiple_of(2));
        assert_eq!(
            interleaved.len(),
            sidechain.len(),
            "sidechain 帧数必须与主信号一致"
        );
        for (frame, side_frame) in interleaved
            .chunks_exact_mut(2)
            .zip(sidechain.chunks_exact(2))
        {
            let (left, right) = frame.split_at_mut(1);
            self.inner
                .process_with_sidechain(left, right, &side_frame[..1], &side_frame[1..]);
        }
    }
}

/// 与 HSE 命名兼容，便于后续链路接线。
pub type CompressorStage = Compressor;

#[cfg(test)]
mod tests {
    use super::*;

    fn core(settings: CompressorSettings) -> CoreCompressorStage {
        CoreCompressorStage::from_settings(48_000.0, settings.into()).unwrap()
    }

    fn planar_input() -> (Vec<f32>, Vec<f32>) {
        (
            vec![0.0, 0.2, -0.7, 0.9, -0.1, 0.4],
            vec![0.1, -0.3, 0.8, -0.6, 0.2, -0.5],
        )
    }

    #[test]
    fn ordinary_processing_is_bit_identical_to_core() {
        let settings = CompressorSettings {
            threshold_db: -14.0,
            ratio: 7.0,
            knee_db: 3.0,
            attack_ms: 2.0,
            release_ms: 80.0,
            makeup_db: 1.5,
            output_gain: 0.8,
            ..CompressorSettings::default()
        };
        let (left, right) = planar_input();
        let mut actual_left = left.clone();
        let mut actual_right = right.clone();
        let mut expected_left = left;
        let mut expected_right = right;
        let mut facade = Compressor::with_settings(48_000.0, settings).unwrap();
        let mut expected = core(settings);

        facade.process_stereo(&mut actual_left, &mut actual_right);
        expected.process(&mut expected_left, &mut expected_right);

        assert_eq!(actual_left, expected_left);
        assert_eq!(actual_right, expected_right);
        assert_eq!(facade.reduction_db(), expected.reduction_db());
    }

    #[test]
    fn explicit_sidechain_is_bit_identical_to_core() {
        let settings = CompressorSettings::default();
        let (left, right) = planar_input();
        let side_left = [0.9, -0.8, 0.7, -0.6, 0.5, -0.4];
        let side_right = [-0.4, 0.5, -0.6, 0.7, -0.8, 0.9];
        let mut actual_left = left.clone();
        let mut actual_right = right.clone();
        let mut expected_left = left;
        let mut expected_right = right;
        let mut facade = Compressor::with_settings(48_000.0, settings).unwrap();
        let mut expected = core(settings);

        facade.process_stereo_with_sidechain(
            &mut actual_left,
            &mut actual_right,
            &side_left,
            &side_right,
        );
        expected.process_with_sidechain(
            &mut expected_left,
            &mut expected_right,
            &side_left,
            &side_right,
        );

        assert_eq!(actual_left, expected_left);
        assert_eq!(actual_right, expected_right);
        assert_eq!(facade.reduction_db(), expected.reduction_db());
    }

    #[test]
    fn planar_and_interleaved_are_bit_identical() {
        let (left, right) = planar_input();
        let mut planar_left = left.clone();
        let mut planar_right = right.clone();
        let mut interleaved = left
            .iter()
            .zip(&right)
            .flat_map(|(&left, &right)| [left, right])
            .collect::<Vec<_>>();
        let mut planar = Compressor::new(48_000.0).unwrap();
        let mut adapter = Compressor::new(48_000.0).unwrap();
        planar.process_stereo(&mut planar_left, &mut planar_right);
        adapter.process_interleaved_stereo(&mut interleaved);
        for (index, frame) in interleaved.chunks_exact(2).enumerate() {
            assert_eq!(frame[0].to_bits(), planar_left[index].to_bits());
            assert_eq!(frame[1].to_bits(), planar_right[index].to_bits());
        }
        assert_eq!(planar.reduction_db(), adapter.reduction_db());
    }

    #[test]
    fn reset_reproduces_initial_output() {
        let input = [0.8_f32, -0.4, 0.2, 0.9, -0.7, 0.5];
        let mut compressor = Compressor::new(44_100.0).unwrap();
        let mut first = input;
        compressor.process_interleaved_stereo(&mut first);
        compressor.reset();
        let mut replay = input;
        compressor.process_interleaved_stereo(&mut replay);
        assert_eq!(first, replay);
    }

    #[test]
    fn sidechain_flag_does_not_replace_a_missing_external_bus() {
        let settings = CompressorSettings {
            sidechain_enabled: true,
            ..CompressorSettings::default()
        };
        let input = [0.8_f32, 0.7, -0.3, 0.4, 0.6, -0.8];
        let mut flagged = Compressor::with_settings(48_000.0, settings).unwrap();
        let mut regular = Compressor::new(48_000.0).unwrap();
        let mut flagged_output = input;
        let mut regular_output = input;
        flagged.process_interleaved_stereo(&mut flagged_output);
        regular.process_interleaved_stereo(&mut regular_output);
        assert_eq!(flagged_output, regular_output);
        assert_eq!(flagged.reduction_db(), regular.reduction_db());
    }

    #[test]
    fn copied_and_cloned_runtime_state_continue_bit_identically() {
        let prefix = [0.8_f32, -0.4, 0.2, 0.9, -0.7, 0.5];
        let continuation = [-0.2_f32, 0.7, 0.9, -0.1, 0.3, -0.8];
        let mut source = Compressor::new(48_000.0).unwrap();
        source.process_interleaved_stereo(&mut prefix.clone());
        let mut copied = Compressor::new(48_000.0).unwrap();
        copied.copy_runtime_state_from(&source).unwrap();
        let mut cloned = source.clone();
        let mut source_output = continuation;
        let mut copied_output = continuation;
        let mut cloned_output = continuation;

        source.process_interleaved_stereo(&mut source_output);
        copied.process_interleaved_stereo(&mut copied_output);
        cloned.process_interleaved_stereo(&mut cloned_output);

        assert_eq!(copied_output, source_output);
        assert_eq!(cloned_output, source_output);
        assert_eq!(copied.reduction_db(), source.reduction_db());
        assert_eq!(cloned.reduction_db(), source.reduction_db());
    }

    #[test]
    fn runtime_state_helpers_preserve_target_settings_and_validate_sample_rate() {
        let mut source = Compressor::new(48_000.0).unwrap();
        source.process_interleaved_stereo(&mut [0.8_f32, -0.4, 0.2, 0.9]);
        let checkpoint = source.snapshot_runtime_state();
        let mut reusable = Compressor::new(48_000.0).unwrap().snapshot_runtime_state();
        source.save_runtime_state(&mut reusable).unwrap();

        let target_settings = CompressorSettings {
            threshold_db: -8.0,
            ratio: 2.0,
            sidechain_enabled: true,
            ..CompressorSettings::default()
        };
        let mut target = Compressor::with_settings(48_000.0, target_settings).unwrap();
        target.restore_runtime_state(&checkpoint).unwrap();
        assert_eq!(target.settings(), target_settings);

        let mut mismatch = Compressor::new(44_100.0).unwrap();
        assert_eq!(
            mismatch.restore_runtime_state(&reusable),
            Err(CompressorRuntimeStateMismatch)
        );
        assert_eq!(
            mismatch.copy_runtime_state_from(&source),
            Err(CompressorRuntimeStateMismatch)
        );
    }
}
