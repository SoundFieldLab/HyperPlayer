//! HyperSoundEngine v1.5.1 第一算法组及播放链适配。

pub mod bass_enhancer;
pub mod chorus;
pub mod compressor;
pub mod deesser;
pub mod delay;
pub mod flanger;
pub mod loudness_normalization;
pub mod lufs_meter;
pub mod night_mode;
pub mod phaser;
pub mod surround3d;
pub mod tremolo;

use crate::dsp::{
    PcmBlock, PcmFormat, PcmProcessor, PreparedProcessorChain, ResetReason, RuntimeStateCapability,
};
use crate::error::{EngineError, Result};
use bass_enhancer::BassEnhancerSettings;
use chorus::{ChorusProcessor, ChorusSettings};
use compressor::CompressorSettings;
use deesser::DeesserSettings;
use delay::{DelayProcessor, DelaySettings};
use flanger::{FlangerProcessor, FlangerSettings};
use hse_core::bass_enhancer::{BassEnhancerRuntimeState, BassEnhancerStage};
use hse_core::compressor::{CompressorRuntimeState, CompressorStage};
use hse_core::deesser::{DeesserRuntimeState, DeesserStage};
pub use hse_core::eq_chain::EqBandParam;
use hse_core::eq_chain::{EqChainRuntimeState, EqChainStage};
use hse_core::mid_side::MidSideStage;
use hse_core::Stage as HseStage;
use loudness_normalization::{LoudnessNormalizationProcessor, LoudnessNormalizationSettings};
use lufs_meter::{LufsMeterProcessor, SharedLufsState};
use night_mode::{NightModeProcessor, NightModeSettings};
use phaser::{PhaserProcessor, PhaserSettings};
use std::sync::Arc;
use surround3d::{Surround3dProcessor, Surround3dSettings};
use tremolo::{TremoloProcessor, TremoloSettings};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EqStereoMode {
    #[default]
    Independent,
    HseShared,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EqChainConfig {
    pub enabled: bool,
    pub band_count: usize,
    pub q_compensation: bool,
    pub stereo_mode: EqStereoMode,
    pub bands: Vec<EqBandParam>,
}

impl Default for EqChainConfig {
    fn default() -> Self {
        const FREQUENCIES: [f64; 10] = [
            31.5, 63.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0,
        ];
        Self {
            enabled: true,
            band_count: FREQUENCIES.len(),
            q_compensation: true,
            stereo_mode: EqStereoMode::Independent,
            bands: FREQUENCIES
                .into_iter()
                .map(|frequency| EqBandParam {
                    frequency,
                    gain: 0.0,
                    q: 1.1,
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DspConfig {
    pub loudness_normalization: LoudnessNormalizationSettings,
    pub surround3d: Surround3dSettings,
    pub stereo_width: f64,
    pub voice_balance: f64,
    pub pre_eq: EqChainConfig,
    pub deesser: DeesserSettings,
    pub compressor: CompressorSettings,
    pub night_mode: NightModeSettings,
    pub delay: DelaySettings,
    pub chorus: ChorusSettings,
    pub flanger: FlangerSettings,
    pub phaser: PhaserSettings,
    pub tremolo: TremoloSettings,
    pub bass_enhancer: BassEnhancerSettings,
}

pub type GroupOneConfig = DspConfig;

impl Default for DspConfig {
    fn default() -> Self {
        Self {
            loudness_normalization: LoudnessNormalizationSettings::default(),
            surround3d: Surround3dSettings::default(),
            stereo_width: 1.0,
            voice_balance: 0.0,
            pre_eq: EqChainConfig::default(),
            deesser: DeesserSettings {
                enabled: false,
                ..DeesserSettings::default()
            },
            compressor: CompressorSettings {
                enabled: false,
                ..CompressorSettings::default()
            },
            night_mode: NightModeSettings::default(),
            delay: DelaySettings::default(),
            chorus: ChorusSettings::default(),
            flanger: FlangerSettings::default(),
            phaser: PhaserSettings::default(),
            tremolo: TremoloSettings::default(),
            bass_enhancer: BassEnhancerSettings {
                enabled: false,
                ..BassEnhancerSettings::default()
            },
        }
    }
}

pub(crate) fn validate_dsp_config(config: &DspConfig) -> Result<()> {
    config
        .loudness_normalization
        .validate()
        .map_err(EngineError::InvalidInput)?;
    config.surround3d.validate()?;
    if !config.night_mode.amount.is_finite() {
        return Err(EngineError::InvalidInput(
            "night mode amount must be finite".into(),
        ));
    }
    if (config.compressor.enabled && config.compressor.sidechain_enabled)
        || (config.deesser.enabled && config.deesser.sidechain_enabled)
    {
        return Err(EngineError::Unsupported(
            "external DSP sidechain bus is not available".into(),
        ));
    }
    if !(1..=20).contains(&config.pre_eq.band_count) {
        return Err(EngineError::InvalidInput(
            "EQ band count must be between 1 and 20".into(),
        ));
    }
    Ok(())
}

/// 按 HSE 固定阶段相对顺序构建当前已迁入处理链：响度归一化(1) → Surround3D(2) → M/S(3) → pre-EQ(4) → De-esser(5) → Compressor(6) → Night Mode(7) → Delay(8) → Chorus(9) → Flanger(10) → Phaser(11) → Tremolo(12) → Bass(14) → LUFS tap(19)。
pub fn prepare_dsp_chain(
    revision: u64,
    format: PcmFormat,
    max_block_frames: usize,
    config: DspConfig,
) -> Result<PreparedProcessorChain> {
    require_stereo(format)?;
    validate_dsp_config(&config)?;
    let lufs_state = Arc::new(SharedLufsState::new());
    PreparedProcessorChain::prepare(
        revision,
        format,
        max_block_frames,
        vec![
            Box::new(LoudnessNormalizationProcessor::new(
                format.sample_rate,
                config.loudness_normalization,
                Arc::clone(&lufs_state),
            )?),
            Box::new(Surround3dProcessor::with_settings(
                format.sample_rate,
                config.surround3d,
            )?),
            Box::new(MidSideProcessor::new(
                config.stereo_width,
                config.voice_balance,
            )),
            Box::new(EqChainProcessor::new(format.sample_rate, config.pre_eq)?),
            Box::new(DeesserProcessor::new(format.sample_rate, config.deesser)?),
            Box::new(CompressorProcessor::new(
                format.sample_rate,
                config.compressor,
            )?),
            Box::new(NightModeProcessor::new(
                format.sample_rate,
                config.night_mode,
                config.compressor,
            )?),
            Box::new(DelayProcessor::new(
                f64::from(format.sample_rate),
                config.delay,
            )?),
            Box::new(ChorusProcessor::new(
                f64::from(format.sample_rate),
                config.chorus,
            )?),
            Box::new(FlangerProcessor::new(
                f64::from(format.sample_rate),
                config.flanger,
            )?),
            Box::new(PhaserProcessor::new(
                f64::from(format.sample_rate),
                config.phaser,
            )?),
            Box::new(TremoloProcessor::new(
                f64::from(format.sample_rate),
                config.tremolo,
            )?),
            Box::new(BassEnhancerProcessor::new(
                format.sample_rate,
                config.bass_enhancer,
            )?),
            Box::new(LufsMeterProcessor::new(format.sample_rate, lufs_state)?),
        ],
    )
}

fn require_stereo(format: PcmFormat) -> Result<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "HSE 第一算法组当前要求双声道 PCM".into(),
        ));
    }
    Ok(())
}

pub struct MidSideProcessor {
    inner: MidSideStage,
}

impl MidSideProcessor {
    pub fn new(width: f64, voice_balance: f64) -> Self {
        let mut inner = MidSideStage::new();
        inner.set_params(width, voice_balance);
        Self { inner }
    }
}

impl PcmProcessor for MidSideProcessor {
    fn name(&self) -> &'static str {
        "mid-side"
    }

    fn runtime_state_capability(&self) -> RuntimeStateCapability {
        RuntimeStateCapability::Stateless
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        require_stereo(format)?;
        self.inner.prepare(max_block_frames);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        require_stereo(block.format)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "mid-side requires complete stereo frames".into(),
            ));
        }
        if self.inner.gains() != (1.0, 1.0) {
            self.inner.process_interleaved_stereo(block.interleaved);
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

struct EqRuntimeState {
    sample_rate: u32,
    band_count: usize,
    stereo_mode: EqStereoMode,
    left_chain: EqChainRuntimeState,
    right_chain: Option<EqChainRuntimeState>,
}

pub struct EqChainProcessor {
    sample_rate: u32,
    band_count: usize,
    enabled: bool,
    flat: bool,
    stereo_mode: EqStereoMode,
    left_chain: EqChainStage,
    right_chain: Option<EqChainStage>,
    max_block_frames: usize,
}

impl EqChainProcessor {
    pub fn new(sample_rate: u32, config: EqChainConfig) -> Result<Self> {
        if !(1..=20).contains(&config.band_count) {
            return Err(EngineError::InvalidInput(
                "EQ band count must be between 1 and 20".into(),
            ));
        }
        let build = || -> Result<EqChainStage> {
            let mut chain = EqChainStage::new(f64::from(sample_rate), config.band_count as f64)
                .map_err(EngineError::InvalidInput)?;
            chain.set_bands(&config.bands);
            chain.set_q_compensation(config.q_compensation);
            Ok(chain)
        };
        let left_chain = build()?;
        let right_chain = (config.stereo_mode == EqStereoMode::Independent)
            .then(&build)
            .transpose()?;
        let flat = config.bands.iter().all(|band| band.gain == 0.0);
        Ok(Self {
            sample_rate,
            band_count: config.band_count,
            enabled: config.enabled,
            flat,
            stereo_mode: config.stereo_mode,
            left_chain,
            right_chain,
            max_block_frames: 0,
        })
    }

    fn topology_matches(&self, other: &Self) -> bool {
        self.sample_rate == other.sample_rate
            && self.band_count == other.band_count
            && self.stereo_mode == other.stereo_mode
            && self.right_chain.is_some() == other.right_chain.is_some()
    }

    fn checkpoint_topology_matches(&self, state: &EqRuntimeState) -> bool {
        self.sample_rate == state.sample_rate
            && self.band_count == state.band_count
            && self.stereo_mode == state.stereo_mode
            && self.right_chain.is_some() == state.right_chain.is_some()
    }
}

impl PcmProcessor for EqChainProcessor {
    fn name(&self) -> &'static str {
        "pre-eq"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<EqChainProcessor>() else {
            return false;
        };
        if !self.topology_matches(previous) {
            return false;
        }
        if self.enabled && !previous.enabled {
            return true;
        }
        if self
            .left_chain
            .copy_runtime_state_from(&previous.left_chain)
            .is_err()
        {
            return false;
        }
        let adopted = match (&mut self.right_chain, &previous.right_chain) {
            (Some(target), Some(source)) => target.copy_runtime_state_from(source).is_ok(),
            (None, None) => true,
            _ => false,
        };
        if adopted {
            self.flat &= previous.flat;
        }
        adopted
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(EqRuntimeState {
            sample_rate: self.sample_rate,
            band_count: self.band_count,
            stereo_mode: self.stereo_mode,
            left_chain: self.left_chain.snapshot_runtime_state(),
            right_chain: self
                .right_chain
                .as_ref()
                .map(EqChainStage::snapshot_runtime_state),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<EqRuntimeState>()
            .is_some_and(|state| self.checkpoint_topology_matches(state))
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<EqRuntimeState>() else {
            return false;
        };
        if !self.checkpoint_topology_matches(state) {
            return false;
        }
        if self
            .left_chain
            .save_runtime_state(&mut state.left_chain)
            .is_err()
        {
            return false;
        }
        match (&mut state.right_chain, &self.right_chain) {
            (Some(target), Some(source)) => source.save_runtime_state(target).is_ok(),
            (None, None) => true,
            _ => false,
        }
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<EqRuntimeState>() else {
            return false;
        };
        if !self.checkpoint_topology_matches(state) {
            return false;
        }
        if self
            .left_chain
            .restore_runtime_state(&state.left_chain)
            .is_err()
        {
            return false;
        }
        match (&mut self.right_chain, &state.right_chain) {
            (Some(target), Some(source)) => target.restore_runtime_state(source).is_ok(),
            (None, None) => true,
            _ => false,
        }
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        require_stereo(format)?;
        if format.sample_rate != self.sample_rate {
            return Err(EngineError::InvalidInput(
                "EQ sample rate does not match the prepared PCM format".into(),
            ));
        }
        self.max_block_frames = max_block_frames;
        self.left_chain.prepare(max_block_frames);
        if let Some(right_chain) = &mut self.right_chain {
            right_chain.prepare(max_block_frames);
        }
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        require_stereo(block.format)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "EQ requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.max_block_frames {
            return Err(EngineError::InvalidInput(
                "EQ block exceeds the prepared frame capacity".into(),
            ));
        }
        if !self.enabled || self.flat {
            return Ok(());
        }
        match self.stereo_mode {
            EqStereoMode::HseShared => self
                .left_chain
                .process_interleaved_stereo_shared(block.interleaved),
            EqStereoMode::Independent => {
                self.left_chain
                    .process_interleaved_channel(block.interleaved, 0);
                self.right_chain
                    .as_mut()
                    .expect("independent mode has a right-channel chain")
                    .process_interleaved_channel(block.interleaved, 1);
            }
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.left_chain.reset();
        if let Some(right_chain) = &mut self.right_chain {
            right_chain.reset();
        }
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

struct DeesserProcessorRuntimeState {
    sample_rate: u32,
    inner: DeesserRuntimeState,
}

pub struct DeesserProcessor {
    sample_rate: u32,
    enabled: bool,
    inner: DeesserStage,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl DeesserProcessor {
    pub fn new(sample_rate: u32, settings: DeesserSettings) -> Result<Self> {
        if settings.enabled && settings.sidechain_enabled {
            return Err(EngineError::Unsupported(
                "external de-esser sidechain bus is not available".into(),
            ));
        }
        DeesserStage::from_settings(f64::from(sample_rate), settings.into())
            .map(|inner| Self {
                sample_rate,
                enabled: settings.enabled,
                inner,
                left: Vec::new(),
                right: Vec::new(),
            })
            .map_err(EngineError::InvalidInput)
    }
}

impl PcmProcessor for DeesserProcessor {
    fn name(&self) -> &'static str {
        "deesser"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<DeesserProcessor>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.enabled && !previous.enabled {
            return true;
        }
        self.inner.copy_runtime_state_from(&previous.inner).is_ok()
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(DeesserProcessorRuntimeState {
            sample_rate: self.sample_rate,
            inner: self.inner.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<DeesserProcessorRuntimeState>()
            .is_some_and(|state| self.sample_rate == state.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<DeesserProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.save_runtime_state(&mut state.inner).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<DeesserProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.restore_runtime_state(&state.inner).is_ok()
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        require_stereo(format)?;
        if format.sample_rate != self.sample_rate {
            return Err(EngineError::InvalidInput(
                "de-esser sample rate does not match the prepared PCM format".into(),
            ));
        }
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        self.inner.prepare(max_block_frames);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        require_stereo(block.format)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "de-esser requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "de-esser block exceeds the prepared frame capacity".into(),
            ));
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.inner
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
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

struct CompressorProcessorRuntimeState {
    sample_rate: u32,
    inner: CompressorRuntimeState,
}

pub struct CompressorProcessor {
    sample_rate: u32,
    enabled: bool,
    inner: CompressorStage,
}

impl CompressorProcessor {
    pub fn new(sample_rate: u32, settings: CompressorSettings) -> Result<Self> {
        if settings.enabled && settings.sidechain_enabled {
            return Err(EngineError::Unsupported(
                "external compressor sidechain bus is not available".into(),
            ));
        }
        CompressorStage::from_settings(f64::from(sample_rate), settings.into())
            .map(|inner| Self {
                sample_rate,
                enabled: settings.enabled,
                inner,
            })
            .map_err(EngineError::InvalidInput)
    }
}

impl PcmProcessor for CompressorProcessor {
    fn name(&self) -> &'static str {
        "compressor"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<CompressorProcessor>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.enabled && !previous.enabled {
            return true;
        }
        self.inner.copy_runtime_state_from(&previous.inner).is_ok()
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(CompressorProcessorRuntimeState {
            sample_rate: self.sample_rate,
            inner: self.inner.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<CompressorProcessorRuntimeState>()
            .is_some_and(|state| self.sample_rate == state.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<CompressorProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.save_runtime_state(&mut state.inner).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<CompressorProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.restore_runtime_state(&state.inner).is_ok()
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        require_stereo(format)?;
        if format.sample_rate != self.sample_rate {
            return Err(EngineError::InvalidInput(
                "compressor sample rate does not match the prepared PCM format".into(),
            ));
        }
        self.inner.prepare(max_block_frames);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        require_stereo(block.format)?;
        for frame in block.interleaved.as_chunks_mut::<2>().0.iter_mut() {
            let (left, right) = frame.split_at_mut(1);
            self.inner.process(left, right);
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

struct BassEnhancerProcessorRuntimeState {
    sample_rate: u32,
    inner: BassEnhancerRuntimeState,
}

pub struct BassEnhancerProcessor {
    sample_rate: u32,
    enabled: bool,
    inner: BassEnhancerStage,
}

impl BassEnhancerProcessor {
    pub fn new(sample_rate: u32, settings: BassEnhancerSettings) -> Result<Self> {
        BassEnhancerStage::from_settings(f64::from(sample_rate), settings.into())
            .map(|inner| Self {
                sample_rate,
                enabled: settings.enabled,
                inner,
            })
            .map_err(EngineError::InvalidInput)
    }
}

impl PcmProcessor for BassEnhancerProcessor {
    fn name(&self) -> &'static str {
        "bass-enhancer"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous
            .as_any_mut()
            .downcast_mut::<BassEnhancerProcessor>()
        else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        if self.enabled && !previous.enabled {
            return true;
        }
        self.inner.copy_runtime_state_from(&previous.inner).is_ok()
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(BassEnhancerProcessorRuntimeState {
            sample_rate: self.sample_rate,
            inner: self.inner.snapshot_runtime_state(),
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<BassEnhancerProcessorRuntimeState>()
            .is_some_and(|state| self.sample_rate == state.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_mut::<BassEnhancerProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.save_runtime_state(&mut state.inner).is_ok()
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(state) = state.downcast_ref::<BassEnhancerProcessorRuntimeState>() else {
            return false;
        };
        if self.sample_rate != state.sample_rate {
            return false;
        }
        self.inner.restore_runtime_state(&state.inner).is_ok()
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()> {
        require_stereo(format)?;
        if format.sample_rate != self.sample_rate {
            return Err(EngineError::InvalidInput(
                "bass enhancer sample rate does not match the prepared PCM format".into(),
            ));
        }
        self.inner.prepare(max_block_frames);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
        require_stereo(block.format)?;
        for frame in block.interleaved.as_chunks_mut::<2>().0.iter_mut() {
            let (left, right) = frame.split_at_mut(1);
            self.inner.process(left, right);
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::PcmSampleFormat;

    fn format(sample_rate: u32) -> PcmFormat {
        PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    #[test]
    fn mid_side_adapter_matches_vendored_interleaved_stage() {
        let input = [-0.0_f32, 0.25, -0.5, 1.0, 0.75, -0.25];
        let mut expected = input;
        let mut core = MidSideStage::new();
        core.set_params(1.35, -0.2);
        core.process_interleaved_stereo(&mut expected);

        let mut actual = input;
        let mut processor = MidSideProcessor::new(1.35, -0.2);
        processor.prepare(format(48_000), 3).unwrap();
        processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut actual,
            })
            .unwrap();
        processor.reset(ResetReason::Seek);

        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
    }

    #[test]
    fn mid_side_adapter_rejects_partial_frames_before_delegation() {
        let mut samples = [0.5_f32, 0.25, 1.0];
        let original = samples;
        let result = MidSideProcessor::new(1.0, 0.0).process(PcmBlock {
            format: format(48_000),
            interleaved: &mut samples,
        });

        assert!(matches!(result, Err(EngineError::InvalidInput(_))));
        assert_eq!(samples, original);
    }

    #[test]
    fn mid_side_product_default_is_bit_transparent() {
        let mut samples = [-0.0_f32, 0.0, f32::MIN_POSITIVE, -1.0];
        let expected = samples.map(f32::to_bits);
        MidSideProcessor::new(1.0, 0.0)
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut samples,
            })
            .unwrap();

        assert_eq!(samples.map(f32::to_bits), expected);
    }

    #[test]
    fn product_default_group_is_bit_transparent() {
        let prepared = prepare_dsp_chain(1, format(48_000), 4, DspConfig::default()).unwrap();
        let mut chain = crate::dsp::ProcessorChain::from_prepared(prepared);
        let mut samples = [-0.0_f32, 0.25, -0.5, 1.0, 0.75, -0.25];
        let expected = samples.map(f32::to_bits);
        chain.process(format(48_000), &mut samples, 0).unwrap();
        assert_eq!(samples.map(f32::to_bits), expected);
    }

    #[test]
    fn production_chain_preserves_canonical_hse_stage_order() {
        let prepared = prepare_dsp_chain(1, format(48_000), 4, DspConfig::default()).unwrap();
        assert_eq!(
            prepared.processor_names(),
            [
                "loudness-normalization",
                "surround3d",
                "mid-side",
                "pre-eq",
                "deesser",
                "compressor",
                "night-mode",
                "delay",
                "chorus",
                "flanger",
                "phaser",
                "tremolo",
                "bass-enhancer",
                "lufs",
            ]
        );
    }

    #[test]
    fn production_chain_runs_loudness_normalization_before_other_audio_stages() {
        let config = DspConfig {
            loudness_normalization: LoudnessNormalizationSettings {
                enabled: true,
                use_realtime_meter: false,
                external_gain_db: 6.0,
                ..LoudnessNormalizationSettings::default()
            },
            ..DspConfig::default()
        };
        let mut chain = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 2, config).unwrap(),
        );
        let mut samples = [0.25_f32, -0.5, 0.75, -1.0];
        let alpha = 1.0 - (-(2.0_f64 / 48_000.0) / 0.08).exp();
        let gain = 1.0 + alpha * (10.0_f64.powf(6.0 / 20.0) - 1.0);
        chain.process(format(48_000), &mut samples, 0).unwrap();
        assert_eq!(samples[0], (0.25_f64 * gain) as f32);
        assert_eq!(samples[1], (-0.5_f64 * gain) as f32);
        assert_eq!(chain.snapshot().latency_frames, 0);
        assert_eq!(chain.snapshot().tail_frames, 0);
    }

    #[test]
    fn unrelated_revision_preserves_manual_normalization_gain() {
        let settings = LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: 6.0,
            ..LoudnessNormalizationSettings::default()
        };
        let config = DspConfig {
            loudness_normalization: settings,
            ..DspConfig::default()
        };
        let mut chain = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 128, config.clone()).unwrap(),
        );
        let mut first = [0.25_f32; 256];
        chain.process(format(48_000), &mut first, 0).unwrap();

        let mut next_config = config;
        next_config.stereo_width = 1.1;
        chain
            .queue_prepared(prepare_dsp_chain(2, format(48_000), 128, next_config).unwrap())
            .unwrap();
        let mut actual = [0.25_f32; 256];
        chain.process(format(48_000), &mut actual, 128).unwrap();

        let block_alpha = 1.0 - (-(128.0_f64 / 48_000.0) / 0.08).exp();
        let target = 10.0_f64.powf(6.0 / 20.0);
        let first_gain = 1.0 + block_alpha * (target - 1.0);
        let second_gain = first_gain + block_alpha * (target - first_gain);
        assert_eq!(actual[0], (0.25_f64 * second_gain) as f32);
    }

    #[test]
    fn enabling_realtime_normalization_reuses_disabled_meter_history() {
        let mut chain = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 4_800, DspConfig::default()).unwrap(),
        );
        for block_index in 0..4 {
            let mut block = vec![0.1_f32; 9_600];
            chain
                .process(format(48_000), &mut block, block_index * 4_800)
                .unwrap();
        }

        let config = DspConfig {
            loudness_normalization: LoudnessNormalizationSettings {
                enabled: true,
                ..LoudnessNormalizationSettings::default()
            },
            ..DspConfig::default()
        };
        chain
            .queue_prepared(prepare_dsp_chain(2, format(48_000), 4_800, config).unwrap())
            .unwrap();
        let mut first_enabled_block = vec![0.1_f32; 9_600];
        chain
            .process(format(48_000), &mut first_enabled_block, 19_200)
            .unwrap();
        assert_ne!(first_enabled_block[0], 0.1);
    }

    #[test]
    fn surround_phase_survives_prepared_chain_revision_swap() {
        let config = DspConfig {
            surround3d: Surround3dSettings {
                enabled: true,
                distance: 0.85,
                speed: 0.7,
                angle: 11.0,
                direction: -1.0,
            },
            ..DspConfig::default()
        };
        let mut uninterrupted = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 4, config.clone()).unwrap(),
        );
        let mut replaced = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 4, config.clone()).unwrap(),
        );
        let first_input = [0.25_f32, -0.5, 0.75, 0.125, -0.3, 0.6, 0.4, -0.2];
        let mut first_uninterrupted = first_input;
        let mut first_replaced = first_input;
        uninterrupted
            .process(format(48_000), &mut first_uninterrupted, 0)
            .unwrap();
        replaced
            .process(format(48_000), &mut first_replaced, 0)
            .unwrap();
        assert_eq!(first_replaced, first_uninterrupted);

        replaced
            .queue_prepared(prepare_dsp_chain(2, format(48_000), 4, config).unwrap())
            .unwrap();
        let second_input = [-0.6_f32, 0.2, 0.1, 0.8, 0.35, -0.45, -0.9, 0.7];
        let mut expected = second_input;
        let mut actual = second_input;
        uninterrupted
            .process(format(48_000), &mut expected, 4)
            .unwrap();
        replaced.process(format(48_000), &mut actual, 4).unwrap();
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    #[test]
    fn production_eq_has_independent_channels_and_is_chunk_invariant() {
        let config = EqChainConfig {
            enabled: true,
            band_count: 1,
            q_compensation: false,
            stereo_mode: EqStereoMode::Independent,
            bands: vec![EqBandParam {
                frequency: 1_000.0,
                gain: 6.0,
                q: 1.0,
            }],
        };
        let input = (0..97)
            .flat_map(|index| [((index as f64 * 0.13).sin() * 0.7) as f32, 0.0])
            .collect::<Vec<_>>();
        let run = |chunks: &[usize]| {
            let mut processor = EqChainProcessor::new(48_000, config.clone()).unwrap();
            processor.prepare(format(48_000), 97).unwrap();
            let mut samples = input.clone();
            let mut offset = 0;
            for &frames in chunks {
                processor
                    .process(PcmBlock {
                        format: format(48_000),
                        interleaved: &mut samples[offset * 2..(offset + frames) * 2],
                    })
                    .unwrap();
                offset += frames;
            }
            samples
        };
        let whole = run(&[97]);
        let chunked = run(&[31, 17, 49]);
        assert_eq!(whole, chunked);
        assert!(whole.iter().skip(1).step_by(2).all(|sample| *sample == 0.0));
    }

    #[test]
    fn eq_adapter_matches_vendored_interleaved_modes() {
        let bands = vec![EqBandParam {
            frequency: 1_000.0,
            gain: 6.0,
            q: 1.0,
        }];
        let input = (0..31)
            .flat_map(|index| {
                let sample = (index as f64 * 0.19).sin() as f32;
                [sample, sample * -0.4]
            })
            .collect::<Vec<_>>();

        for mode in [EqStereoMode::Independent, EqStereoMode::HseShared] {
            let config = EqChainConfig {
                enabled: true,
                band_count: 1,
                q_compensation: false,
                stereo_mode: mode,
                bands: bands.clone(),
            };
            let mut processor = EqChainProcessor::new(48_000, config).unwrap();
            processor.prepare(format(48_000), 31).unwrap();
            let mut actual = input.clone();
            processor
                .process(PcmBlock {
                    format: format(48_000),
                    interleaved: &mut actual,
                })
                .unwrap();

            let build = || {
                let mut chain = EqChainStage::new(48_000.0, 1.0).unwrap();
                chain.set_bands(&bands);
                chain
            };
            let mut left = build();
            let mut expected = input.clone();
            match mode {
                EqStereoMode::Independent => {
                    let mut right = build();
                    left.process_interleaved_channel(&mut expected, 0);
                    right.process_interleaved_channel(&mut expected, 1);
                }
                EqStereoMode::HseShared => {
                    left.process_interleaved_stereo_shared(&mut expected);
                }
            }
            assert_eq!(actual, expected, "adapter mode {mode:?}");
        }
    }

    #[test]
    fn eq_rejects_malformed_and_oversized_blocks_before_bypass() {
        for config in [
            EqChainConfig {
                enabled: false,
                ..EqChainConfig::default()
            },
            EqChainConfig::default(),
        ] {
            let mut processor = EqChainProcessor::new(48_000, config).unwrap();
            processor.prepare(format(48_000), 1).unwrap();
            let malformed = processor.process(PcmBlock {
                format: format(48_000),
                interleaved: &mut [0.0],
            });
            assert!(matches!(malformed, Err(EngineError::InvalidInput(_))));

            let oversized = processor.process(PcmBlock {
                format: format(48_000),
                interleaved: &mut [0.0; 4],
            });
            assert!(matches!(oversized, Err(EngineError::InvalidInput(_))));
        }
    }

    #[test]
    fn eq_revision_adopts_state_without_overwriting_new_parameters() {
        let config = |gain| EqChainConfig {
            enabled: true,
            band_count: 1,
            q_compensation: false,
            stereo_mode: EqStereoMode::Independent,
            bands: vec![EqBandParam {
                frequency: 1_000.0,
                gain,
                q: 1.0,
            }],
        };
        let mut previous = EqChainProcessor::new(48_000, config(12.0)).unwrap();
        previous.prepare(format(48_000), 2).unwrap();
        previous
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut [1.0, -0.5, 0.0, 0.0],
            })
            .unwrap();

        let mut next = EqChainProcessor::new(48_000, config(-6.0)).unwrap();
        assert!(next.adopt_runtime_state_from(&mut previous));
        assert_eq!(next.left_chain.bands_snapshot()[0].2, -6.0);
        assert_eq!(
            next.right_chain.as_ref().unwrap().bands_snapshot()[0].2,
            -6.0
        );
    }

    #[test]
    fn eq_checkpoint_restore_and_reset_preserve_adapter_contracts() {
        let config = EqChainConfig {
            enabled: true,
            band_count: 1,
            q_compensation: false,
            stereo_mode: EqStereoMode::Independent,
            bands: vec![EqBandParam {
                frequency: 1_000.0,
                gain: 6.0,
                q: 1.0,
            }],
        };
        let mut processor = EqChainProcessor::new(48_000, config.clone()).unwrap();
        processor.prepare(format(48_000), 2).unwrap();
        processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut [1.0, -0.5, 0.0, 0.0],
            })
            .unwrap();
        let mut checkpoint = processor.create_runtime_checkpoint().unwrap();
        assert!(processor.save_runtime_state(checkpoint.as_mut()));

        let input = [0.2_f32, -0.3, 0.4, -0.1];
        let mut expected = input;
        processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut expected,
            })
            .unwrap();
        assert!(processor.restore_runtime_state(checkpoint.as_ref()));
        let mut actual = input;
        processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut actual,
            })
            .unwrap();
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));

        processor.reset(ResetReason::Seek);
        let mut fresh = EqChainProcessor::new(48_000, config).unwrap();
        fresh.prepare(format(48_000), 2).unwrap();
        let mut reset_output = input;
        let mut fresh_output = input;
        processor
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut reset_output,
            })
            .unwrap();
        fresh
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut fresh_output,
            })
            .unwrap();
        assert_eq!(reset_output, fresh_output);
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
    }

    #[test]
    fn flanger_state_survives_active_revision_swap() {
        let config = DspConfig {
            flanger: FlangerSettings {
                enabled: true,
                rate_hz: 2.5,
                depth_ms: 4.0,
                feedback: 0.6,
                mix: 0.5,
            },
            ..DspConfig::default()
        };
        let mut uninterrupted = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let mut replaced = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let first = (0..31)
            .flat_map(|index| {
                let sample = index as f32 / 31.0;
                [sample, -sample]
            })
            .collect::<Vec<_>>();
        let mut first_a = first.clone();
        let mut first_b = first;
        uninterrupted
            .process(format(8_000), &mut first_a, 0)
            .unwrap();
        replaced.process(format(8_000), &mut first_b, 0).unwrap();
        replaced
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, config).unwrap())
            .unwrap();
        let second = (0..31)
            .flat_map(|index| {
                let sample = (31 - index) as f32 / 31.0;
                [sample, sample * 0.5]
            })
            .collect::<Vec<_>>();
        let mut expected = second.clone();
        let mut actual = second;
        uninterrupted
            .process(format(8_000), &mut expected, 31)
            .unwrap();
        replaced.process(format(8_000), &mut actual, 31).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn flanger_reenable_starts_with_empty_ring_and_zero_phase() {
        let inactive = DspConfig::default();
        let active = DspConfig {
            flanger: FlangerSettings {
                enabled: true,
                rate_hz: 2.5,
                depth_ms: 4.0,
                feedback: 0.6,
                mix: 0.5,
            },
            ..DspConfig::default()
        };
        let mut toggled = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, inactive).unwrap(),
        );
        toggled
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, active.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(8_000), 31, active).unwrap(),
        );
        let input = (0..31)
            .flat_map(|index| {
                let sample = index as f32 / 31.0;
                [sample, -sample]
            })
            .collect::<Vec<_>>();
        let mut actual = input.clone();
        let mut expected = input;
        toggled.process(format(8_000), &mut actual, 0).unwrap();
        fresh.process(format(8_000), &mut expected, 0).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn phaser_state_survives_active_revision_swap() {
        let config = DspConfig {
            phaser: PhaserSettings {
                enabled: true,
                rate_hz: 1.5,
                depth: 0.8,
                feedback: 0.5,
                mix: 0.5,
                stages: 6.0,
            },
            ..DspConfig::default()
        };
        let mut uninterrupted = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let mut replaced = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let first = (0..31)
            .flat_map(|index| {
                let sample = (index as f64 * 0.37).sin() as f32 * 0.7;
                [sample, -sample * 0.75]
            })
            .collect::<Vec<_>>();
        let mut first_a = first.clone();
        let mut first_b = first;
        uninterrupted
            .process(format(8_000), &mut first_a, 0)
            .unwrap();
        replaced.process(format(8_000), &mut first_b, 0).unwrap();
        assert_eq!(first_a, first_b);

        replaced
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, config.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(8_000), 31, config).unwrap(),
        );
        let second = (0..31)
            .flat_map(|index| {
                let sample = ((31 - index) as f64 * 0.23).cos() as f32 * 0.5;
                [sample, sample * 0.4]
            })
            .collect::<Vec<_>>();
        let mut expected = second.clone();
        let mut actual = second.clone();
        let mut reset_output = second;
        uninterrupted
            .process(format(8_000), &mut expected, 31)
            .unwrap();
        replaced.process(format(8_000), &mut actual, 31).unwrap();
        fresh.process(format(8_000), &mut reset_output, 31).unwrap();
        let actual_bits = actual
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        let expected_bits = expected
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        let reset_bits = reset_output
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        assert_eq!(actual_bits, expected_bits);
        assert_ne!(actual_bits, reset_bits);
    }

    #[test]
    fn phaser_reenable_starts_with_zero_state_and_phase() {
        let inactive = DspConfig::default();
        let active = DspConfig {
            phaser: PhaserSettings {
                enabled: true,
                rate_hz: 1.5,
                depth: 0.8,
                feedback: 0.5,
                mix: 0.5,
                stages: 6.0,
            },
            ..DspConfig::default()
        };
        let mut toggled = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, inactive).unwrap(),
        );
        toggled
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, active.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(8_000), 31, active).unwrap(),
        );
        let input = (0..31)
            .flat_map(|index| {
                let sample = (index as f64 * 0.37).sin() as f32 * 0.7;
                [sample, -sample * 0.75]
            })
            .collect::<Vec<_>>();
        let mut actual = input.clone();
        let mut expected = input;
        toggled.process(format(8_000), &mut actual, 0).unwrap();
        fresh.process(format(8_000), &mut expected, 0).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn tremolo_phase_survives_active_revision_swap() {
        let config = DspConfig {
            tremolo: TremoloSettings {
                enabled: true,
                rate_hz: 5.0,
                depth: 0.8,
                mix: 0.75,
            },
            ..DspConfig::default()
        };
        let mut uninterrupted = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let mut replaced = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let first = (0..31)
            .flat_map(|index| {
                let sample = (index as f64 * 0.37).sin() as f32 * 0.7;
                [sample, -sample * 0.75]
            })
            .collect::<Vec<_>>();
        let mut first_a = first.clone();
        let mut first_b = first;
        uninterrupted
            .process(format(8_000), &mut first_a, 0)
            .unwrap();
        replaced.process(format(8_000), &mut first_b, 0).unwrap();
        assert_eq!(first_a, first_b);

        replaced
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, config.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(8_000), 31, config).unwrap(),
        );
        let second = (0..31)
            .flat_map(|index| {
                let sample = ((31 - index) as f64 * 0.23).cos() as f32 * 0.5;
                [sample, sample * 0.4]
            })
            .collect::<Vec<_>>();
        let mut expected = second.clone();
        let mut actual = second.clone();
        let mut reset_output = second;
        uninterrupted
            .process(format(8_000), &mut expected, 31)
            .unwrap();
        replaced.process(format(8_000), &mut actual, 31).unwrap();
        fresh.process(format(8_000), &mut reset_output, 31).unwrap();
        let actual_bits = actual
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        let expected_bits = expected
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        let reset_bits = reset_output
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        assert_eq!(actual_bits, expected_bits);
        assert_ne!(actual_bits, reset_bits);
    }

    #[test]
    fn tremolo_reenable_starts_with_zero_phase() {
        let active = DspConfig {
            tremolo: TremoloSettings {
                enabled: true,
                rate_hz: 5.0,
                depth: 0.8,
                mix: 0.75,
            },
            ..DspConfig::default()
        };
        let mut toggled = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, DspConfig::default()).unwrap(),
        );
        toggled
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, active.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(8_000), 31, active).unwrap(),
        );
        let input = (0..31)
            .flat_map(|index| {
                let sample = (index as f64 * 0.37).sin() as f32 * 0.7;
                [sample, -sample * 0.75]
            })
            .collect::<Vec<_>>();
        let mut actual = input.clone();
        let mut expected = input;
        toggled.process(format(8_000), &mut actual, 0).unwrap();
        fresh.process(format(8_000), &mut expected, 0).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn chorus_state_survives_active_revision_swap() {
        let config = DspConfig {
            chorus: ChorusSettings {
                enabled: true,
                rate_hz: 4.0,
                depth_ms: 5.0,
                mix: 0.5,
            },
            ..DspConfig::default()
        };
        let mut uninterrupted = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let mut replaced = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, config.clone()).unwrap(),
        );
        let first = (0..31)
            .flat_map(|index| {
                let sample = index as f32 / 31.0;
                [sample, -sample]
            })
            .collect::<Vec<_>>();
        let mut first_a = first.clone();
        let mut first_b = first;
        uninterrupted
            .process(format(8_000), &mut first_a, 0)
            .unwrap();
        replaced.process(format(8_000), &mut first_b, 0).unwrap();
        replaced
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, config).unwrap())
            .unwrap();
        let second = (0..31)
            .flat_map(|index| {
                let sample = (31 - index) as f32 / 31.0;
                [sample, sample * 0.5]
            })
            .collect::<Vec<_>>();
        let mut expected = second.clone();
        let mut actual = second;
        uninterrupted
            .process(format(8_000), &mut expected, 31)
            .unwrap();
        replaced.process(format(8_000), &mut actual, 31).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn chorus_reenable_starts_with_empty_ring_and_zero_phase() {
        let inactive = DspConfig::default();
        let active = DspConfig {
            chorus: ChorusSettings {
                enabled: true,
                rate_hz: 4.0,
                depth_ms: 5.0,
                mix: 0.5,
            },
            ..DspConfig::default()
        };
        let mut toggled = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 31, inactive).unwrap(),
        );
        toggled
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 31, active.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(8_000), 31, active).unwrap(),
        );
        let input = (0..31)
            .flat_map(|index| {
                let sample = index as f32 / 31.0;
                [sample, -sample]
            })
            .collect::<Vec<_>>();
        let mut actual = input.clone();
        let mut expected = input;
        toggled.process(format(8_000), &mut actual, 0).unwrap();
        fresh.process(format(8_000), &mut expected, 0).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn delay_state_survives_active_revision_swap() {
        let config = DspConfig {
            delay: DelaySettings {
                enabled: true,
                delay_ms: 0.125,
                feedback: 0.6,
                mix: 0.75,
            },
            ..DspConfig::default()
        };
        let mut uninterrupted = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 4, config.clone()).unwrap(),
        );
        let mut replaced = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 4, config.clone()).unwrap(),
        );
        let first = [1.0_f32, -0.5, 0.0, 0.0, 0.25, -0.125, 0.0, 0.0];
        let mut first_a = first;
        let mut first_b = first;
        uninterrupted
            .process(format(8_000), &mut first_a, 0)
            .unwrap();
        replaced.process(format(8_000), &mut first_b, 0).unwrap();
        replaced
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 4, config).unwrap())
            .unwrap();
        let second = [0.0_f32, 0.0, 0.5, -0.25, 0.0, 0.0, -0.1, 0.2];
        let mut expected = second;
        let mut actual = second;
        uninterrupted
            .process(format(8_000), &mut expected, 4)
            .unwrap();
        replaced.process(format(8_000), &mut actual, 4).unwrap();
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    #[test]
    fn delay_reenable_starts_with_empty_ring() {
        let inactive = DspConfig::default();
        let active = DspConfig {
            delay: DelaySettings {
                enabled: true,
                delay_ms: 0.125,
                feedback: 0.6,
                mix: 0.75,
            },
            ..DspConfig::default()
        };
        let mut toggled = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(8_000), 4, inactive).unwrap(),
        );
        toggled
            .queue_prepared(prepare_dsp_chain(2, format(8_000), 4, active.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(8_000), 4, active).unwrap(),
        );
        let input = [1.0_f32, -0.5, 0.0, 0.0, 0.25, -0.125, 0.0, 0.0];
        let mut actual = input;
        let mut expected = input;
        toggled.process(format(8_000), &mut actual, 0).unwrap();
        fresh.process(format(8_000), &mut expected, 0).unwrap();
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    #[test]
    fn night_mode_accepts_disabled_base_compressor_sidechain_snapshot() {
        let config = DspConfig {
            compressor: CompressorSettings {
                enabled: false,
                sidechain_enabled: true,
                ..CompressorSettings::default()
            },
            night_mode: NightModeSettings {
                enabled: true,
                amount: 8.0,
            },
            ..DspConfig::default()
        };
        assert!(prepare_dsp_chain(1, format(48_000), 4, config).is_ok());

        let rejected = DspConfig {
            compressor: CompressorSettings {
                enabled: true,
                sidechain_enabled: true,
                ..CompressorSettings::default()
            },
            ..DspConfig::default()
        };
        assert!(matches!(
            prepare_dsp_chain(1, format(48_000), 4, rejected),
            Err(EngineError::Unsupported(_))
        ));
    }

    #[test]
    fn night_mode_state_survives_active_revision_swap() {
        let config = DspConfig {
            night_mode: NightModeSettings {
                enabled: true,
                amount: 8.0,
            },
            ..DspConfig::default()
        };
        let mut uninterrupted = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 4, config.clone()).unwrap(),
        );
        let mut replaced = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 4, config.clone()).unwrap(),
        );
        let first = [0.8_f32, -0.6, 0.4, -0.2, 0.7, -0.5, 0.3, -0.1];
        let mut first_a = first;
        let mut first_b = first;
        uninterrupted
            .process(format(48_000), &mut first_a, 0)
            .unwrap();
        replaced.process(format(48_000), &mut first_b, 0).unwrap();
        replaced
            .queue_prepared(prepare_dsp_chain(2, format(48_000), 4, config).unwrap())
            .unwrap();
        let second = [-0.7_f32, 0.5, -0.3, 0.1, 0.9, -0.8, 0.2, -0.4];
        let mut expected = second;
        let mut actual = second;
        uninterrupted
            .process(format(48_000), &mut expected, 4)
            .unwrap();
        replaced.process(format(48_000), &mut actual, 4).unwrap();
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    #[test]
    fn night_mode_reenable_starts_from_reset_state() {
        let inactive = DspConfig::default();
        let active = DspConfig {
            night_mode: NightModeSettings {
                enabled: true,
                amount: 8.0,
            },
            ..DspConfig::default()
        };
        let mut toggled = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(48_000), 4, inactive).unwrap(),
        );
        toggled
            .queue_prepared(prepare_dsp_chain(2, format(48_000), 4, active.clone()).unwrap())
            .unwrap();
        let mut fresh = crate::dsp::ProcessorChain::from_prepared(
            prepare_dsp_chain(2, format(48_000), 4, active).unwrap(),
        );
        let input = [0.8_f32, -0.6, 0.4, -0.2, 0.7, -0.5, 0.3, -0.1];
        let mut actual = input;
        let mut expected = input;
        toggled.process(format(48_000), &mut actual, 0).unwrap();
        fresh.process(format(48_000), &mut expected, 0).unwrap();
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    #[test]
    fn flat_eq_keeps_running_after_nonflat_state_migration() {
        let nonflat = EqChainConfig {
            enabled: true,
            band_count: 1,
            q_compensation: false,
            stereo_mode: EqStereoMode::Independent,
            bands: vec![EqBandParam {
                frequency: 1_000.0,
                gain: 12.0,
                q: 1.0,
            }],
        };
        let flat = EqChainConfig {
            enabled: true,
            band_count: 1,
            q_compensation: false,
            stereo_mode: EqStereoMode::Independent,
            bands: vec![EqBandParam {
                frequency: 1_000.0,
                gain: 0.0,
                q: 1.0,
            }],
        };
        let mut previous = EqChainProcessor::new(48_000, nonflat).unwrap();
        previous.prepare(format(48_000), 4).unwrap();
        previous
            .process(PcmBlock {
                format: format(48_000),
                interleaved: &mut [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            })
            .unwrap();
        let mut next = EqChainProcessor::new(48_000, flat).unwrap();
        next.prepare(format(48_000), 4).unwrap();
        assert!(next.adopt_runtime_state_from(&mut previous));
        assert!(!next.flat);
    }

    #[test]
    fn incompatible_eq_topology_is_not_partially_migrated() {
        let shared = EqChainConfig {
            stereo_mode: EqStereoMode::HseShared,
            ..EqChainConfig::default()
        };
        let mut previous = EqChainProcessor::new(48_000, shared).unwrap();
        let mut next = EqChainProcessor::new(48_000, EqChainConfig::default()).unwrap();
        assert!(!next.adopt_runtime_state_from(&mut previous));
        assert!(next.flat);

        let nonflat_two_band = EqChainConfig {
            band_count: 2,
            bands: vec![
                EqBandParam {
                    frequency: 500.0,
                    gain: 6.0,
                    q: 1.0,
                },
                EqBandParam {
                    frequency: 2_000.0,
                    gain: -3.0,
                    q: 1.0,
                },
            ],
            ..EqChainConfig::default()
        };
        let mut previous = EqChainProcessor::new(48_000, nonflat_two_band).unwrap();
        let mut next = EqChainProcessor::new(48_000, EqChainConfig::default()).unwrap();
        assert!(!next.adopt_runtime_state_from(&mut previous));
        assert!(next.flat);
    }

    #[test]
    fn eq_band_count_is_bounded() {
        let config = EqChainConfig {
            band_count: 21,
            ..EqChainConfig::default()
        };
        assert!(EqChainProcessor::new(48_000, config).is_err());
    }

    #[test]
    fn deesser_sidechain_policy_depends_on_enabled_state() {
        let disabled = DeesserSettings {
            enabled: false,
            sidechain_enabled: true,
            ..DeesserSettings::default()
        };
        assert!(DeesserProcessor::new(48_000, disabled).is_ok());
        assert!(prepare_dsp_chain(
            1,
            format(48_000),
            4,
            DspConfig {
                deesser: disabled,
                ..DspConfig::default()
            },
        )
        .is_ok());

        let enabled = DeesserSettings {
            enabled: true,
            sidechain_enabled: true,
            ..DeesserSettings::default()
        };
        assert!(matches!(
            DeesserProcessor::new(48_000, enabled),
            Err(EngineError::Unsupported(_))
        ));
        assert!(matches!(
            prepare_dsp_chain(
                1,
                format(48_000),
                4,
                DspConfig {
                    deesser: enabled,
                    ..DspConfig::default()
                },
            ),
            Err(EngineError::Unsupported(_))
        ));
    }

    #[test]
    fn deesser_rejects_partial_frames_without_mutating_input() {
        let mut processor = DeesserProcessor::new(48_000, DeesserSettings::default()).unwrap();
        processor.prepare(format(48_000), 2).unwrap();
        let mut samples = [0.75_f32, -0.25, 0.5];
        let original = samples;

        let result = processor.process(PcmBlock {
            format: format(48_000),
            interleaved: &mut samples,
        });

        assert!(matches!(result, Err(EngineError::InvalidInput(_))));
        assert_eq!(samples, original);
    }

    #[test]
    fn dynamics_processors_reject_cross_sample_rate_state() {
        let mut deesser_source = DeesserProcessor::new(48_000, DeesserSettings::default()).unwrap();
        let mut deesser_target = DeesserProcessor::new(44_100, DeesserSettings::default()).unwrap();
        let deesser_checkpoint = deesser_source.create_runtime_checkpoint().unwrap();
        assert!(!deesser_target.adopt_runtime_state_from(&mut deesser_source));
        assert!(!deesser_target.runtime_checkpoint_compatible(deesser_checkpoint.as_ref()));
        assert!(!deesser_target.restore_runtime_state(deesser_checkpoint.as_ref()));

        let mut compressor_source =
            CompressorProcessor::new(48_000, CompressorSettings::default()).unwrap();
        let mut compressor_target =
            CompressorProcessor::new(44_100, CompressorSettings::default()).unwrap();
        let compressor_checkpoint = compressor_source.create_runtime_checkpoint().unwrap();
        assert!(!compressor_target.adopt_runtime_state_from(&mut compressor_source));
        assert!(!compressor_target.runtime_checkpoint_compatible(compressor_checkpoint.as_ref()));
        assert!(!compressor_target.restore_runtime_state(compressor_checkpoint.as_ref()));

        let mut bass_source =
            BassEnhancerProcessor::new(48_000, BassEnhancerSettings::default()).unwrap();
        let mut bass_target =
            BassEnhancerProcessor::new(44_100, BassEnhancerSettings::default()).unwrap();
        let bass_checkpoint = bass_source.create_runtime_checkpoint().unwrap();
        assert!(!bass_target.adopt_runtime_state_from(&mut bass_source));
        assert!(!bass_target.runtime_checkpoint_compatible(bass_checkpoint.as_ref()));
        assert!(!bass_target.restore_runtime_state(bass_checkpoint.as_ref()));
    }

    #[test]
    fn dynamics_checkpoints_use_core_runtime_state() {
        let deesser_settings = DeesserSettings {
            center_hz: 4_200.0,
            threshold_db: -18.0,
            ..DeesserSettings::default()
        };
        let mut deesser = DeesserProcessor::new(48_000, deesser_settings).unwrap();
        let deesser_checkpoint = deesser.create_runtime_checkpoint().unwrap();
        assert!(deesser_checkpoint.is::<DeesserProcessorRuntimeState>());
        assert!(deesser.restore_runtime_state(deesser_checkpoint.as_ref()));

        let compressor_settings = CompressorSettings {
            threshold_db: -8.0,
            ratio: 2.0,
            ..CompressorSettings::default()
        };
        let mut compressor = CompressorProcessor::new(48_000, compressor_settings).unwrap();
        let compressor_checkpoint = compressor.create_runtime_checkpoint().unwrap();
        assert!(compressor_checkpoint.is::<CompressorProcessorRuntimeState>());
        assert!(compressor.restore_runtime_state(compressor_checkpoint.as_ref()));

        let bass_settings = BassEnhancerSettings {
            harmonic_type: bass_enhancer::HarmonicType::Soft,
            mix: 0.25,
            ..BassEnhancerSettings::default()
        };
        let mut bass = BassEnhancerProcessor::new(48_000, bass_settings).unwrap();
        let bass_checkpoint = bass.create_runtime_checkpoint().unwrap();
        assert!(bass_checkpoint.is::<BassEnhancerProcessorRuntimeState>());
        assert!(bass.restore_runtime_state(bass_checkpoint.as_ref()));
    }

    #[test]
    fn processors_reject_a_mismatched_prepare_sample_rate() {
        let settings = CompressorSettings::default();
        let result = PreparedProcessorChain::prepare(
            1,
            format(44_100),
            4,
            vec![Box::new(
                CompressorProcessor::new(48_000, settings).unwrap(),
            )],
        );
        assert!(result.is_err());
    }
}
