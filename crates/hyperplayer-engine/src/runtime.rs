use crate::audio::{AudioOutput, Decoder, DecoderFactory, GaplessCoordinator, StandbyState};
use crate::dsp::{
    PcmFormat, PreparedProcessorChain, ProcessorChain, ProcessorChainSnapshot, ResetReason,
};
use crate::dsp_algorithms::lufs_meter::SharedLufsState;
use crate::dsp_algorithms::{prepare_dsp_chain_with_lufs, DspConfig};
use crate::error::{EngineError, Result};
use crate::media::TrustedResolvedMedia;
use crate::model::Track;
use crate::telemetry::{TelemetryHub, TelemetryProducer, TelemetrySubscriber};
use std::collections::VecDeque;
use std::sync::Arc;

pub(crate) const DECODE_BUFFER_FRAMES: usize = 2048;
const TERMINAL_DRAIN_MAX_SECONDS: u64 = 12;
const TERMINAL_DRAIN_FADE_SECONDS: u64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DrainPlan {
    total_frames: u64,
    fade_start_frame: Option<u64>,
}

fn terminal_drain_plan(natural_frames: u64, sample_rate: u32) -> DrainPlan {
    let maximum = u64::from(sample_rate).saturating_mul(TERMINAL_DRAIN_MAX_SECONDS);
    if natural_frames <= maximum {
        return DrainPlan {
            total_frames: natural_frames,
            fade_start_frame: None,
        };
    }
    let fade_frames = u64::from(sample_rate).saturating_mul(TERMINAL_DRAIN_FADE_SECONDS);
    DrainPlan {
        total_frames: maximum,
        fade_start_frame: Some(maximum.saturating_sub(fade_frames)),
    }
}

fn apply_terminal_drain_fade(
    samples: &mut [f32],
    channels: usize,
    drained_before: u64,
    plan: DrainPlan,
) {
    let Some(fade_start) = plan.fade_start_frame else {
        return;
    };
    let fade_frames = plan.total_frames.saturating_sub(fade_start);
    let denominator = fade_frames.saturating_sub(1).max(1);
    for (frame_index, frame) in samples.chunks_exact_mut(channels).enumerate() {
        let position = drained_before + frame_index as u64;
        if position >= fade_start {
            let progress = (position - fade_start).min(denominator) as f64 / denominator as f64;
            let gain = (progress * std::f64::consts::FRAC_PI_2).cos();
            for sample in frame {
                *sample = (f64::from(*sample) * gain) as f32;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlaybackReport {
    pub frames_written: u64,
    pub standby_frames: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PumpResult {
    Progress { position_ms: u64 },
    Pending,
    Eof { output_drained: bool },
}

struct ActivePlayback {
    decoder: Box<dyn Decoder>,
    format: PcmFormat,
    playable_frames: u64,
    decoded_frames: u64,
    position_frames: u64,
    output_frames_written: u64,
    pending: VecDeque<f32>,
    decode_buffer: Vec<f32>,
    pending_source_samples: usize,
    decoder_eof: bool,
    dsp_drain_frames_remaining: u64,
    dsp_drain_total_frames: u64,
    dsp_drain_fade_start_frame: Option<u64>,
    dsp_drained: bool,
}

struct StandbyPlayback {
    decoder: Box<dyn Decoder>,
    format: PcmFormat,
    playable_frames: u64,
    position_frames: u64,
    dsp_revision: Option<u64>,
}

struct PcmAdapter {
    descriptor: crate::audio::DecoderDescriptor,
    samples: Vec<f32>,
    position: usize,
}

impl PcmAdapter {
    fn new(mut decoder: Box<dyn Decoder>, target: PcmFormat) -> Result<Self> {
        let source = decoder.descriptor().clone();
        if source.format.sample_format != target.sample_format {
            return Err(EngineError::Unsupported(
                "PCM sample format conversion is unavailable".into(),
            ));
        }
        decoder.seek(0)?;
        let source_channels = usize::from(source.format.channels);
        let source_sample_count = usize::try_from(decoder.total_frames())
            .ok()
            .and_then(|frames| frames.checked_mul(source_channels))
            .ok_or_else(|| EngineError::Decode("decoded PCM size overflows memory".into()))?;
        let mut source_pcm = vec![0.0; source_sample_count];
        let mut filled = 0;
        while filled < source_pcm.len() {
            let read = decoder.read_pcm(&mut source_pcm[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        source_pcm.truncate(filled - filled % source_channels);
        let mapped = map_channels(&source_pcm, source.format.channels, target.channels);
        let samples = resample_linear(
            &mapped,
            target.channels,
            source.format.sample_rate,
            target.sample_rate,
        );
        let scale_frame = |frame: u32| {
            (u64::from(frame) * u64::from(target.sample_rate)
                / u64::from(source.format.sample_rate)) as u32
        };
        Ok(Self {
            descriptor: crate::audio::DecoderDescriptor {
                track: source.track,
                format: target,
                trim: crate::audio::CodecTrim {
                    delay_frames: scale_frame(source.trim.delay_frames),
                    padding_frames: scale_frame(source.trim.padding_frames),
                },
            },
            samples,
            position: 0,
        })
    }
}

impl Decoder for PcmAdapter {
    fn descriptor(&self) -> &crate::audio::DecoderDescriptor {
        &self.descriptor
    }

    fn total_frames(&self) -> u64 {
        self.samples.len() as u64 / u64::from(self.descriptor.format.channels)
    }

    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        let count = output.len().min(self.samples.len() - self.position);
        output[..count].copy_from_slice(&self.samples[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }

    fn seek(&mut self, frame: u64) -> Result<()> {
        let position = frame
            .checked_mul(u64::from(self.descriptor.format.channels))
            .and_then(|sample| usize::try_from(sample).ok())
            .ok_or_else(|| {
                EngineError::InvalidInput("seek position overflows PCM length".into())
            })?;
        if position > self.samples.len() {
            return Err(EngineError::InvalidInput(
                "seek frame is past the end of the adapted PCM".into(),
            ));
        }
        self.position = position;
        Ok(())
    }
}

fn map_channels(samples: &[f32], source_channels: u16, target_channels: u16) -> Vec<f32> {
    let source_channels = usize::from(source_channels);
    let target_channels = usize::from(target_channels);
    let mut output = Vec::with_capacity(samples.len() / source_channels * target_channels);
    for frame in samples.chunks_exact(source_channels) {
        if target_channels == 1 {
            output.push(frame.iter().sum::<f32>() / source_channels as f32);
        } else if source_channels == 1 {
            output.extend(std::iter::repeat_n(frame[0], target_channels));
        } else {
            output.extend(
                (0..target_channels).map(|channel| frame[channel.min(source_channels - 1)]),
            );
        }
    }
    output
}

fn resample_linear(samples: &[f32], channels: u16, source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let channels = usize::from(channels);
    let source_frames = samples.len() / channels;
    let target_frames =
        (source_frames as u64 * u64::from(target_rate)).div_ceil(u64::from(source_rate)) as usize;
    let mut output = Vec::with_capacity(target_frames * channels);
    for target_frame in 0..target_frames {
        let numerator = target_frame as u64 * u64::from(source_rate);
        let left = (numerator / u64::from(target_rate)) as usize;
        let right = (left + 1).min(source_frames - 1);
        let fraction = (numerator % u64::from(target_rate)) as f32 / target_rate as f32;
        for channel in 0..channels {
            let a = samples[left * channels + channel];
            let b = samples[right * channels + channel];
            output.push(a + (b - a) * fraction);
        }
    }
    output
}

pub struct RuntimeCoordinator {
    decoder_factory: Box<dyn DecoderFactory>,
    output: Box<dyn AudioOutput>,
    dsp: ProcessorChain,
    gapless: GaplessCoordinator,
    active: Option<ActivePlayback>,
    standby: Option<StandbyPlayback>,
    standby_raw_pcm: VecDeque<f32>,
    standby_pcm: VecDeque<f32>,
    standby_dsp_checkpointed: bool,
    telemetry: TelemetryProducer,
    started: bool,
}

impl RuntimeCoordinator {
    pub fn new(decoder_factory: Box<dyn DecoderFactory>, output: Box<dyn AudioOutput>) -> Self {
        Self::with_telemetry(decoder_factory, output, TelemetryHub::new())
    }

    pub(crate) fn with_telemetry(
        decoder_factory: Box<dyn DecoderFactory>,
        output: Box<dyn AudioOutput>,
        telemetry: TelemetryHub,
    ) -> Self {
        let output_format = output.format();
        Self {
            decoder_factory,
            output,
            dsp: ProcessorChain::bypass_only(output_format, DECODE_BUFFER_FRAMES)
                .expect("the fixed runtime DSP block contract is valid"),
            gapless: GaplessCoordinator::new(output_format),
            active: None,
            standby: None,
            standby_raw_pcm: VecDeque::new(),
            standby_pcm: VecDeque::new(),
            standby_dsp_checkpointed: false,
            telemetry: TelemetryProducer::new(telemetry),
            started: false,
        }
    }

    pub(crate) fn into_decoder_factory(self) -> Box<dyn DecoderFactory> {
        self.decoder_factory
    }

    pub fn output_format(&self) -> PcmFormat {
        self.output.format()
    }

    pub fn subscribe_telemetry(&self) -> TelemetrySubscriber {
        self.telemetry.subscribe()
    }

    pub fn standby(&self) -> &StandbyState {
        self.gapless.standby()
    }

    pub fn load(&mut self, media: &TrustedResolvedMedia) -> Result<()> {
        let decoder = self.decoder_factory.open(media)?;
        self.load_opened(decoder)
    }

    pub(crate) fn load_opened(&mut self, decoder: Box<dyn Decoder>) -> Result<()> {
        if self.active.is_some() {
            self.output.stop()?;
            self.started = false;
        }
        self.active = Some(self.prepare_decoder(decoder)?);
        self.invalidate_standby()?;
        self.dsp.reset(ResetReason::Load);
        self.telemetry.begin_epoch();
        Ok(())
    }

    pub fn start(&mut self) -> Result<u64> {
        if self.active.is_none() {
            return Err(EngineError::InvalidInput("no track is loaded".into()));
        }
        if self.started {
            return Ok(self.position_ms());
        }
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.playable_frames == 0)
        {
            return Err(EngineError::Decode(
                "track contains no playable PCM frames after codec trim".into(),
            ));
        }
        self.output.start()?;
        self.started = true;
        match self.pump_once() {
            Ok(PumpResult::Eof { .. }) => {
                self.output.stop()?;
                self.started = false;
                Err(EngineError::Decode(
                    "track contains no playable PCM frames after codec trim".into(),
                ))
            }
            Ok(_) => Ok(self.position_ms()),
            Err(error) => {
                let _ = self.output.stop();
                self.started = false;
                Err(error)
            }
        }
    }

    pub fn pause(&mut self) -> Result<()> {
        if !self.started {
            return Err(EngineError::InvalidInput(
                "audio output is not playing".into(),
            ));
        }
        self.output.pause()?;
        self.started = false;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<()> {
        if self.active.is_none() {
            return Err(EngineError::InvalidInput("no track is loaded".into()));
        }
        self.output.start()?;
        self.started = true;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<()> {
        self.output.stop()?;
        self.started = false;
        self.active = None;
        self.invalidate_standby()?;
        self.dsp.reset(ResetReason::Stop);
        self.telemetry.begin_epoch();
        Ok(())
    }

    pub fn seek(&mut self, position_ms: u64) -> Result<u64> {
        let was_started = self.started;
        self.output.stop()?;
        self.started = false;
        let frame = {
            let active = self
                .active
                .as_mut()
                .ok_or_else(|| EngineError::InvalidInput("no track is loaded".into()))?;
            let requested = position_ms.saturating_mul(u64::from(active.format.sample_rate)) / 1000;
            let frame = requested.min(active.playable_frames);
            let delay = u64::from(active.decoder.descriptor().trim.delay_frames);
            active.decoder.seek(delay + frame)?;
            active.decoded_frames = frame;
            active.position_frames = frame;
            active.output_frames_written = frame;
            active.pending.clear();
            active.pending_source_samples = 0;
            active.decoder_eof = frame == active.playable_frames;
            active.dsp_drain_frames_remaining = 0;
            active.dsp_drain_total_frames = 0;
            active.dsp_drain_fade_start_frame = None;
            active.dsp_drained = false;
            frame
        };
        self.invalidate_standby()?;
        self.dsp.reset(ResetReason::Seek);
        self.telemetry.begin_epoch();
        let playable_frames = self
            .active
            .as_ref()
            .expect("active playback survives seek")
            .playable_frames;
        if was_started && frame < playable_frames {
            self.start()?;
        }
        Ok(self.position_ms())
    }

    pub fn set_volume(&mut self, volume: f32) -> Result<()> {
        self.output.set_volume(volume)
    }

    pub fn configure_dsp(
        &mut self,
        revision: u64,
        config: DspConfig,
    ) -> Result<ProcessorChainSnapshot> {
        self.invalidate_standby_dsp()?;
        // 每次 DSP 配置为链新建独立的 LUFS 发布状态：LufsMeterProcessor 为单写者，
        // 不能与旧链共享同一状态（旧链处理器仍持有 writer 直至 Drop）。状态随新链生效，
        // 并同步交给 telemetry 读取（Stage 19 读数闭环）。
        let lufs = Arc::new(SharedLufsState::new());
        let prepared = prepare_dsp_chain_with_lufs(
            revision,
            self.output.format(),
            DECODE_BUFFER_FRAMES,
            config,
            Arc::clone(&lufs),
        )?;
        self.telemetry.set_lufs_source(lufs);
        let _retired = self.dsp.reclaim_retired();
        let _superseded = self.dsp.queue_prepared(prepared)?;
        if self
            .standby
            .as_ref()
            .is_some_and(|standby| standby.dsp_revision.is_some())
        {
            self.standby_pcm.clone_from(&self.standby_raw_pcm);
            self.standby
                .as_mut()
                .expect("standby was checked above")
                .dsp_revision = None;
        }
        Ok(self.dsp.snapshot())
    }

    pub fn queue_prepared_dsp(&mut self, prepared: PreparedProcessorChain) -> Result<()> {
        self.invalidate_standby_dsp()?;
        let _retired = self.dsp.reclaim_retired();
        let _superseded = self.dsp.queue_prepared(prepared)?;
        Ok(())
    }

    pub fn dsp_snapshot(&self) -> ProcessorChainSnapshot {
        self.dsp.snapshot()
    }

    pub fn take_dsp_fault(&mut self) -> Option<(u64, crate::dsp::ProcessorFault, u64)> {
        self.dsp.take_unreported_fault()
    }

    pub fn reclaim_retired_dsp(&mut self) -> Option<PreparedProcessorChain> {
        self.dsp.reclaim_retired()
    }

    pub fn position_ms(&self) -> u64 {
        self.active
            .as_ref()
            .map(|active| {
                active.position_frames.saturating_mul(1000) / u64::from(active.format.sample_rate)
            })
            .unwrap_or(0)
    }

    pub fn pump_once(&mut self) -> Result<PumpResult> {
        self.output.check_health()?;
        if self.active.is_none() {
            return Err(EngineError::InvalidInput("no track is loaded".into()));
        }
        self.fill_active_pending()?;
        let dsp_revision = self.dsp.snapshot().revision;
        let active = self.active.as_mut().expect("active checked above");
        if active.pending.is_empty() && active.decoder_eof && active.dsp_drained {
            return Ok(PumpResult::Eof {
                output_drained: self.output.buffered_samples() == 0,
            });
        }
        let channels = usize::from(active.format.channels);
        let pending = active.pending.make_contiguous();
        let written = self.output.write(pending)?;
        if written > pending.len() {
            return Err(EngineError::AudioBackend(
                "audio output reported writing beyond the supplied buffer".into(),
            ));
        }
        if !written.is_multiple_of(channels) {
            return Err(EngineError::AudioBackend(
                "audio output reported an incomplete PCM frame".into(),
            ));
        }
        self.telemetry.ingest(
            active.format,
            &pending[..written],
            dsp_revision,
            active.output_frames_written,
        );
        active.output_frames_written += (written / channels) as u64;
        active.pending.drain(..written);
        let source_written = written.min(active.pending_source_samples);
        active.pending_source_samples -= source_written;
        active.position_frames += (source_written / channels) as u64;
        if written == 0 {
            Ok(PumpResult::Pending)
        } else {
            Ok(PumpResult::Progress {
                position_ms: active.position_frames.saturating_mul(1000)
                    / u64::from(active.format.sample_rate),
            })
        }
    }

    pub fn prime_standby(&mut self, media: &TrustedResolvedMedia, frames: usize) -> Result<usize> {
        let decoder = self.decoder_factory.open(media)?;
        self.prime_standby_with_opened(decoder, frames)
    }

    /// 用**已在外部（preparation worker）打开的 decoder** 预填 standby：open/probe 等阻塞
    /// 操作已在 actor 控制路径之外完成，此处只做格式统一、裁剪定位与 PCM 预拉。
    /// 语义与 `prime_standby` 完全一致（先失效旧 standby，再走相同的 priming 流程）。
    pub fn prime_standby_with_opened(
        &mut self,
        decoder: Box<dyn Decoder>,
        frames: usize,
    ) -> Result<usize> {
        if frames == 0 {
            return Err(EngineError::InvalidInput(
                "standby frame count must be greater than zero".into(),
            ));
        }
        self.invalidate_standby()?;
        let descriptor = decoder.descriptor().clone();
        self.gapless.decoder_opened(descriptor);
        let target_format = self.output.format();
        self.gapless.confirm_format_unified(target_format)?;
        let mut standby = self.prepare_decoder(decoder)?;
        let requested = frames.min(standby.playable_frames as usize);
        let sample_capacity = requested
            .checked_mul(usize::from(standby.format.channels))
            .ok_or_else(|| EngineError::InvalidInput("standby buffer size overflow".into()))?;
        let mut pcm = vec![0.0; sample_capacity];
        let samples = standby.decoder.read_pcm(&mut pcm)?;
        pcm.truncate(samples);
        let buffered_frames = samples / usize::from(standby.format.channels);
        if buffered_frames == 0 {
            return Err(EngineError::Decode(
                "standby track contains no playable PCM frames".into(),
            ));
        }
        standby.position_frames = buffered_frames as u64;
        self.standby_raw_pcm.extend(pcm.iter().copied());
        self.standby_pcm.extend(pcm);
        self.gapless.mark_primed(buffered_frames)?;
        self.standby = Some(StandbyPlayback {
            decoder: standby.decoder,
            format: standby.format,
            playable_frames: standby.playable_frames,
            position_frames: standby.position_frames,
            dsp_revision: None,
        });
        Ok(buffered_frames)
    }

    pub fn promote_standby(&mut self, track: &Track) -> Result<bool> {
        let matches = matches!(
            self.gapless.standby(),
            StandbyState::Primed { track: primed, .. } if primed == track
        );
        if !matches {
            return Ok(false);
        }
        self.gapless.take_at_sample_boundary()?;
        let standby = self
            .standby
            .take()
            .ok_or_else(|| EngineError::Decode("primed standby decoder is missing".into()))?;
        let current_snapshot = self.dsp.snapshot();
        let requires_reprocessing = current_snapshot.pending_revision.is_some()
            || standby.dsp_revision != Some(current_snapshot.revision);
        if requires_reprocessing {
            self.restore_standby_dsp_checkpoint()?;
        } else {
            self.dsp.commit_speculative_processing();
            self.standby_dsp_checkpointed = false;
        }
        let mut pending = if requires_reprocessing {
            std::mem::take(&mut self.standby_raw_pcm)
        } else {
            std::mem::take(&mut self.standby_pcm)
        };
        if requires_reprocessing {
            self.process_active_pcm(standby.format, &mut pending, 0)?;
        }
        self.telemetry.begin_epoch();
        self.active = Some(ActivePlayback {
            decoder: standby.decoder,
            format: standby.format,
            playable_frames: standby.playable_frames,
            decoded_frames: standby.position_frames,
            position_frames: 0,
            output_frames_written: 0,
            pending,
            decode_buffer: vec![0.0; DECODE_BUFFER_FRAMES * usize::from(standby.format.channels)],
            pending_source_samples: usize::try_from(standby.position_frames)
                .ok()
                .and_then(|frames| frames.checked_mul(usize::from(standby.format.channels)))
                .ok_or_else(|| EngineError::Decode("standby PCM position overflow".into()))?,
            decoder_eof: standby.position_frames >= standby.playable_frames,
            dsp_drain_frames_remaining: 0,
            dsp_drain_total_frames: 0,
            dsp_drain_fade_start_frame: None,
            dsp_drained: false,
        });
        Ok(true)
    }

    pub fn take_standby_at_sample_boundary(&mut self) -> Result<(Track, Vec<f32>)> {
        let state = self.gapless.take_at_sample_boundary()?;
        let track = match state {
            StandbyState::Primed { track, .. } => track,
            _ => unreachable!("gapless coordinator only returns a primed state"),
        };
        self.standby = None;
        self.restore_standby_dsp_checkpoint()?;
        Ok((track, self.standby_pcm.drain(..).collect()))
    }

    pub fn play_to_end(&mut self, media: &TrustedResolvedMedia) -> Result<PlaybackReport> {
        self.load(media)?;
        self.start()?;
        loop {
            if matches!(
                self.pump_once()?,
                PumpResult::Eof {
                    output_drained: true
                }
            ) {
                break;
            }
        }
        let frames_written = self
            .active
            .as_ref()
            .map(|active| active.position_frames)
            .unwrap_or(0);
        self.output.stop()?;
        self.started = false;
        Ok(PlaybackReport {
            frames_written,
            standby_frames: standby_frames(self.gapless.standby()),
        })
    }

    fn prepare_decoder(&self, decoder: Box<dyn Decoder>) -> Result<ActivePlayback> {
        let output_format = self.output.format();
        let mut decoder: Box<dyn Decoder> = if decoder.descriptor().format == output_format {
            decoder
        } else {
            Box::new(PcmAdapter::new(decoder, output_format)?)
        };
        let descriptor = decoder.descriptor().clone();
        let total = decoder.total_frames();
        let delay = u64::from(descriptor.trim.delay_frames);
        let padding = u64::from(descriptor.trim.padding_frames);
        let playable_frames = total.checked_sub(delay + padding).ok_or_else(|| {
            EngineError::Decode("codec delay and padding exceed decoded frame count".into())
        })?;
        decoder.seek(delay)?;
        Ok(ActivePlayback {
            decoder,
            format: descriptor.format,
            playable_frames,
            decoded_frames: 0,
            position_frames: 0,
            output_frames_written: 0,
            pending: VecDeque::with_capacity(
                DECODE_BUFFER_FRAMES * usize::from(descriptor.format.channels),
            ),
            decode_buffer: vec![
                0.0;
                DECODE_BUFFER_FRAMES * usize::from(descriptor.format.channels)
            ],
            pending_source_samples: 0,
            decoder_eof: playable_frames == 0,
            dsp_drain_frames_remaining: 0,
            dsp_drain_total_frames: 0,
            dsp_drain_fade_start_frame: None,
            dsp_drained: false,
        })
    }

    fn fill_active_pending(&mut self) -> Result<()> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| !active.pending.is_empty())
        {
            return Ok(());
        }
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.decoder_eof)
            && self
                .standby
                .as_ref()
                .is_some_and(|standby| standby.dsp_revision.is_none())
        {
            self.prepare_standby_dsp_after_active_tail()?;
        }
        let gapless_continuation = self
            .standby
            .as_ref()
            .is_some_and(|standby| standby.dsp_revision.is_some());
        let active = self
            .active
            .as_mut()
            .expect("caller requires active playback");
        if active.decoder_eof {
            if gapless_continuation {
                active.dsp_drained = true;
                return Ok(());
            }
            if !active.dsp_drained {
                let channels = usize::from(active.format.channels);
                if active.dsp_drain_frames_remaining == 0 {
                    let snapshot = self.dsp.snapshot();
                    let natural_frames =
                        u64::from(snapshot.latency_frames) + u64::from(snapshot.tail_frames);
                    let plan = terminal_drain_plan(natural_frames, active.format.sample_rate);
                    active.dsp_drain_frames_remaining = plan.total_frames;
                    active.dsp_drain_total_frames = plan.total_frames;
                    active.dsp_drain_fade_start_frame = plan.fade_start_frame;
                }
                let frames = active
                    .dsp_drain_frames_remaining
                    .min(self.dsp.max_block_frames() as u64) as usize;
                if frames == 0 {
                    active.dsp_drained = true;
                    return Ok(());
                }
                let sample_count = frames * channels;
                let pcm = &mut active.decode_buffer[..sample_count];
                self.dsp.drain(active.format, pcm, active.decoded_frames)?;
                if let Some(fade_start) = active.dsp_drain_fade_start_frame {
                    let drained_before = active
                        .dsp_drain_total_frames
                        .saturating_sub(active.dsp_drain_frames_remaining);
                    apply_terminal_drain_fade(
                        pcm,
                        channels,
                        drained_before,
                        DrainPlan {
                            total_frames: active.dsp_drain_total_frames,
                            fade_start_frame: Some(fade_start),
                        },
                    );
                }
                active.pending.extend(pcm.iter().copied());
                active.dsp_drain_frames_remaining -= frames as u64;
                active.dsp_drained = active.dsp_drain_frames_remaining == 0;
            }
            return Ok(());
        }
        let remaining = active.playable_frames - active.decoded_frames;
        if remaining == 0 {
            active.decoder_eof = true;
            return Ok(());
        }
        let frames = remaining.min(DECODE_BUFFER_FRAMES as u64) as usize;
        let channels = usize::from(active.format.channels);
        let sample_capacity = frames * channels;
        let samples = active
            .decoder
            .read_pcm(&mut active.decode_buffer[..sample_capacity])?;
        if !samples.is_multiple_of(channels) {
            return Err(EngineError::Decode(
                "decoder returned an incomplete PCM frame".into(),
            ));
        }
        let sample_count = samples.min(sample_capacity);
        let pcm = &mut active.decode_buffer[..sample_count];
        self.dsp
            .process(active.format, pcm, active.decoded_frames)?;
        let decoded_frames = (sample_count / channels) as u64;
        active.decoded_frames += decoded_frames;
        active.pending_source_samples += sample_count;
        active.pending.extend(pcm.iter().copied());
        active.decoder_eof = samples == 0 || active.decoded_frames >= active.playable_frames;
        if active.decoder_eof {
            self.prepare_standby_dsp_after_active_tail()?;
        }
        Ok(())
    }

    fn prepare_standby_dsp_after_active_tail(&mut self) -> Result<()> {
        let Some((format, None)) = self
            .standby
            .as_ref()
            .map(|standby| (standby.format, standby.dsp_revision))
        else {
            return Ok(());
        };
        let mut pcm = std::mem::take(&mut self.standby_pcm);
        self.dsp.begin_speculative_processing()?;
        self.standby_dsp_checkpointed = true;
        if let Err(error) = self.process_applied_pcm(format, &mut pcm) {
            self.restore_standby_dsp_checkpoint()?;
            return Err(error);
        }
        if self.dsp.speculative_processing_fault().is_some() {
            self.dsp.restore_speculative_processing_to_safe_bypass()?;
            self.standby_dsp_checkpointed = false;
            self.standby_pcm.clone_from(&self.standby_raw_pcm);
            let applied_revision = self.dsp.snapshot().revision;
            self.standby
                .as_mut()
                .expect("standby survives synchronous DSP preparation")
                .dsp_revision = Some(applied_revision);
            return Ok(());
        }
        let applied_revision = self.dsp.snapshot().revision;
        self.standby_pcm = pcm;
        self.standby
            .as_mut()
            .expect("standby survives synchronous DSP preparation")
            .dsp_revision = Some(applied_revision);
        Ok(())
    }

    fn invalidate_standby_dsp(&mut self) -> Result<()> {
        self.restore_standby_dsp_checkpoint()?;
        if self
            .standby
            .as_ref()
            .is_some_and(|standby| standby.dsp_revision.is_some())
        {
            self.standby_pcm.clone_from(&self.standby_raw_pcm);
            self.standby
                .as_mut()
                .expect("standby was checked above")
                .dsp_revision = None;
        }
        Ok(())
    }

    fn process_active_pcm(
        &mut self,
        format: PcmFormat,
        pending: &mut VecDeque<f32>,
        stream_frame: u64,
    ) -> Result<()> {
        let channels = usize::from(format.channels);
        let max_samples = self.dsp.max_block_frames() * channels;
        let contiguous = pending.make_contiguous();
        for (block_index, block) in contiguous.chunks_mut(max_samples).enumerate() {
            let block_frame = stream_frame + (block_index * self.dsp.max_block_frames()) as u64;
            self.dsp.process(format, block, block_frame)?;
        }
        Ok(())
    }

    fn process_applied_pcm(
        &mut self,
        format: PcmFormat,
        pending: &mut VecDeque<f32>,
    ) -> Result<()> {
        let channels = usize::from(format.channels);
        let max_samples = self.dsp.max_block_frames() * channels;
        let contiguous = pending.make_contiguous();
        for (block_index, block) in contiguous.chunks_mut(max_samples).enumerate() {
            let stream_frame = (block_index * self.dsp.max_block_frames()) as u64;
            self.dsp.process_applied(format, block, stream_frame)?;
        }
        Ok(())
    }

    fn restore_standby_dsp_checkpoint(&mut self) -> Result<()> {
        if self.standby_dsp_checkpointed {
            self.dsp.restore_speculative_processing()?;
            self.standby_dsp_checkpointed = false;
        }
        Ok(())
    }

    fn invalidate_standby(&mut self) -> Result<()> {
        self.restore_standby_dsp_checkpoint()?;
        self.gapless.invalidate();
        self.standby = None;
        self.standby_raw_pcm.clear();
        self.standby_pcm.clear();
        Ok(())
    }
}

fn standby_frames(state: &StandbyState) -> usize {
    match state {
        StandbyState::Primed {
            buffered_frames, ..
        } => *buffered_frames,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{CodecTrim, DecoderDescriptor, WavDecoderFactory};
    use crate::dsp::{
        PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat, PreparedProcessorChain, ResetReason,
    };
    use crate::dsp_algorithms::DspConfig;
    use crate::media::{MediaHandle, TrustedResolvedMedia};
    use crate::model::{MediaId, MediaSource};
    use crate::telemetry::{
        reset_chain_metering_for_tests, TelemetryActivity, TELEMETRY_VALID_RMS,
        TELEMETRY_VALID_SAMPLE_PEAK, TELEMETRY_VALID_WAVEFORM,
    };
    use std::fs;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    #[derive(Default)]
    struct OutputState {
        starts: usize,
        stops: usize,
        samples: Vec<f32>,
    }

    struct RecordingOutput {
        format: PcmFormat,
        state: Arc<Mutex<OutputState>>,
        max_write: usize,
    }

    impl AudioOutput for RecordingOutput {
        fn format(&self) -> PcmFormat {
            self.format
        }
        fn start(&mut self) -> Result<()> {
            self.state.lock().unwrap().starts += 1;
            Ok(())
        }
        fn pause(&mut self) -> Result<()> {
            Ok(())
        }
        fn stop(&mut self) -> Result<()> {
            self.state.lock().unwrap().stops += 1;
            Ok(())
        }
        fn write(&mut self, pcm: &[f32]) -> Result<usize> {
            let written = pcm.len().min(self.max_write);
            self.state
                .lock()
                .unwrap()
                .samples
                .extend_from_slice(&pcm[..written]);
            Ok(written)
        }
    }

    fn format() -> PcmFormat {
        PcmFormat {
            sample_rate: 8_000,
            channels: 1,
            sample_format: PcmSampleFormat::F32,
        }
    }

    fn local_track(path: &Path) -> Track {
        Track {
            id: MediaId::new(path.display().to_string()),
            source: MediaSource::Local {
                path: path.to_path_buf(),
            },
            title: "Fixture".into(),
            artists: Vec::new(),
            album: None,
            album_id: None,
            artist_ids: Vec::new(),
            artwork_hash: None,
            artwork_mime: None,
            duration_ms: None,
        }
    }

    fn trusted_local(path: &Path) -> TrustedResolvedMedia {
        TrustedResolvedMedia::new(
            local_track(path),
            MediaHandle::local(fs::File::open(path).unwrap(), path.to_path_buf()),
        )
    }

    #[test]
    fn output_failure_is_reported_before_eof_or_buffer_checks() {
        struct FailedOutput(PcmFormat);
        impl AudioOutput for FailedOutput {
            fn format(&self) -> PcmFormat {
                self.0
            }
            fn start(&mut self) -> Result<()> {
                Ok(())
            }
            fn pause(&mut self) -> Result<()> {
                Ok(())
            }
            fn stop(&mut self) -> Result<()> {
                Ok(())
            }
            fn write(&mut self, _pcm: &[f32]) -> Result<usize> {
                Ok(0)
            }
            fn check_health(&self) -> Result<()> {
                Err(EngineError::AudioBackend("simulated stream failure".into()))
            }
            fn buffered_samples(&self) -> usize {
                128
            }
        }

        let mut runtime = RuntimeCoordinator::new(
            Box::new(WavDecoderFactory),
            Box::new(FailedOutput(format())),
        );
        assert!(matches!(
            runtime.pump_once(),
            Err(EngineError::AudioBackend(_))
        ));
    }

    #[test]
    fn real_wav_runs_through_decoder_bypass_dsp_and_injected_output() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("fixture.wav");
        let source = [-32768_i16, -16384, 0, 16384, 32767];
        fs::write(&path, pcm16_wav(&source)).unwrap();
        let state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&state),
            max_write: 2,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        let media = trusted_local(&path);
        let report = runtime.play_to_end(&media).unwrap();
        let state = state.lock().unwrap();
        assert_eq!(report.frames_written, source.len() as u64);
        assert_eq!(state.starts, 1);
        assert_eq!(state.stops, 1);
        assert_eq!(
            state.samples,
            source
                .iter()
                .map(|sample| f32::from(*sample) / 32768.0)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn primes_real_wav_through_gapless_coordinator() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("next.wav");
        fs::write(&path, pcm16_wav(&[1, 2, 3, 4])).unwrap();
        let state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state,
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        let media = trusted_local(&path);
        let track = media.track.clone();
        assert_eq!(runtime.prime_standby(&media, 3).unwrap(), 3);
        assert!(runtime.standby().is_gapless_ready());
        let (taken_track, pcm) = runtime.take_standby_at_sample_boundary().unwrap();
        assert_eq!(taken_track, track);
        assert_eq!(pcm, vec![1.0 / 32768.0, 2.0 / 32768.0, 3.0 / 32768.0]);
        assert_eq!(runtime.standby(), &StandbyState::Empty);
    }

    #[test]
    fn standby_pcm_is_processed_only_after_gapless_promotion_without_reset() {
        #[derive(Default)]
        struct DspState {
            process_calls: usize,
            resets: Vec<ResetReason>,
        }

        struct StatefulProcessor(Arc<Mutex<DspState>>);
        impl PcmProcessor for StatefulProcessor {
            fn name(&self) -> &'static str {
                "stateful_test"
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
                let mut state = self.0.lock().unwrap();
                state.process_calls += 1;
                for sample in block.interleaved {
                    *sample += state.process_calls as f32;
                }
                Ok(())
            }
            fn reset(&mut self, reason: ResetReason) {
                self.0.lock().unwrap().resets.push(reason);
            }
            fn latency_frames(&self) -> u32 {
                0
            }
            fn tail_frames(&self) -> u32 {
                0
            }
        }

        let directory = tempdir().unwrap();
        let current_path = directory.path().join("current.wav");
        let next_path = directory.path().join("next.wav");
        fs::write(&current_path, pcm16_wav(&[0, 0])).unwrap();
        fs::write(&next_path, pcm16_wav(&[1, 2, 3])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let dsp_state = Arc::new(Mutex::new(DspState::default()));
        let prepared = PreparedProcessorChain::prepare(
            1,
            format(),
            DECODE_BUFFER_FRAMES,
            vec![Box::new(StatefulProcessor(Arc::clone(&dsp_state)))],
        )
        .unwrap();
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime.queue_prepared_dsp(prepared).unwrap();
        runtime.load(&trusted_local(&current_path)).unwrap();
        runtime.start().unwrap();
        assert_eq!(dsp_state.lock().unwrap().process_calls, 1);

        let next = trusted_local(&next_path);
        let next_track = next.track.clone();
        runtime.prime_standby(&next, 3).unwrap();
        assert_eq!(dsp_state.lock().unwrap().process_calls, 1);
        assert!(runtime.promote_standby(&next_track).unwrap());

        let state = dsp_state.lock().unwrap();
        assert_eq!(state.process_calls, 2);
        assert_eq!(state.resets, vec![ResetReason::Load]);
        drop(state);
        runtime.pump_once().unwrap();
        assert_eq!(
            output_state.lock().unwrap().samples,
            vec![
                1.0,
                1.0,
                2.0 + 1.0 / 32768.0,
                2.0 + 2.0 / 32768.0,
                2.0 + 3.0 / 32768.0
            ]
        );
    }

    #[test]
    fn seek_resets_active_dsp_with_explicit_reason() {
        struct ResetRecorder(Arc<Mutex<Vec<ResetReason>>>);
        impl PcmProcessor for ResetRecorder {
            fn name(&self) -> &'static str {
                "reset_recorder"
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, _block: PcmBlock<'_>) -> Result<()> {
                Ok(())
            }
            fn reset(&mut self, reason: ResetReason) {
                self.0.lock().unwrap().push(reason);
            }
            fn latency_frames(&self) -> u32 {
                0
            }
            fn tail_frames(&self) -> u32 {
                0
            }
        }

        let directory = tempdir().unwrap();
        let path = directory.path().join("seek.wav");
        fs::write(&path, pcm16_wav(&[0, 1, 2, 3])).unwrap();
        let output = RecordingOutput {
            format: format(),
            state: Arc::new(Mutex::new(OutputState::default())),
            max_write: usize::MAX,
        };
        let resets = Arc::new(Mutex::new(Vec::new()));
        let prepared = PreparedProcessorChain::prepare(
            2,
            format(),
            DECODE_BUFFER_FRAMES,
            vec![Box::new(ResetRecorder(Arc::clone(&resets)))],
        )
        .unwrap();
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime.queue_prepared_dsp(prepared).unwrap();
        runtime.load(&trusted_local(&path)).unwrap();
        runtime.start().unwrap();
        runtime.seek(0).unwrap();
        assert_eq!(
            *resets.lock().unwrap(),
            vec![ResetReason::Load, ResetReason::Seek]
        );
    }

    #[test]
    fn terminal_playback_drains_latency_and_tail_without_extending_track_position() {
        struct DrainMarker;
        impl PcmProcessor for DrainMarker {
            fn name(&self) -> &'static str {
                "drain_marker"
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
                for sample in block.interleaved {
                    if *sample == 0.0 {
                        *sample = 0.5;
                    }
                }
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                2
            }
            fn tail_frames(&self) -> u32 {
                3
            }
        }

        let directory = tempdir().unwrap();
        let path = directory.path().join("drain.wav");
        fs::write(&path, pcm16_wav(&[8192, 16384])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let prepared = PreparedProcessorChain::prepare(
            3,
            format(),
            DECODE_BUFFER_FRAMES,
            vec![Box::new(DrainMarker)],
        )
        .unwrap();
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime.queue_prepared_dsp(prepared).unwrap();
        let report = runtime.play_to_end(&trusted_local(&path)).unwrap();
        assert_eq!(report.frames_written, 2);
        assert_eq!(runtime.position_ms(), 0);
        assert_eq!(
            output_state.lock().unwrap().samples,
            vec![0.25, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
        );
    }

    #[test]
    fn terminal_drain_plan_caps_long_tails_and_fades_only_the_final_two_seconds() {
        assert_eq!(
            terminal_drain_plan(24_000, 48_000),
            DrainPlan {
                total_frames: 24_000,
                fade_start_frame: None,
            }
        );
        let plan = terminal_drain_plan(65_664_000, 48_000);
        assert_eq!(plan.total_frames, 576_000);
        assert_eq!(plan.fade_start_frame, Some(480_000));

        let mut samples = [1.0_f32, -1.0, 1.0, -1.0];
        apply_terminal_drain_fade(&mut samples, 2, 480_000, plan);
        assert_eq!(samples[0], 1.0);
        assert_eq!(samples[1], -1.0);
        let mut final_frame = [1.0_f32, -1.0];
        apply_terminal_drain_fade(&mut final_frame, 2, 575_999, plan);
        assert!(final_frame[0].abs() < 1e-6);
        assert!(final_frame[1].abs() < 1e-6);
    }

    #[test]
    fn terminal_playback_drains_delay_echo_without_extending_track_position() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("delay-tail.wav");
        fs::write(&path, pcm16_stereo_wav(&[(16384, -8192)])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime
            .configure_dsp(
                1,
                DspConfig {
                    delay: crate::dsp_algorithms::delay::DelaySettings {
                        enabled: true,
                        delay_ms: 1.0,
                        feedback: 0.0,
                        mix: 1.0,
                    },
                    ..DspConfig::default()
                },
            )
            .unwrap();

        let report = runtime.play_to_end(&trusted_local(&path)).unwrap();
        assert_eq!(report.frames_written, 1);
        assert_eq!(runtime.position_ms(), 0);
        let samples = &output_state.lock().unwrap().samples;
        assert_eq!(samples.len(), 18);
        assert!(samples[..16].iter().all(|sample| *sample == 0.0));
        assert_eq!(samples[16], 0.5);
        assert_eq!(samples[17], -0.25);
    }

    #[test]
    fn terminal_playback_drains_chorus_wet_path_without_extending_track_position() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("chorus-tail.wav");
        fs::write(&path, pcm16_stereo_wav(&[(16384, -8192)])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime
            .configure_dsp(
                1,
                DspConfig {
                    chorus: crate::dsp_algorithms::chorus::ChorusSettings {
                        enabled: true,
                        rate_hz: 0.01,
                        depth_ms: 0.0,
                        mix: 1.0,
                    },
                    ..DspConfig::default()
                },
            )
            .unwrap();

        let report = runtime.play_to_end(&trusted_local(&path)).unwrap();
        assert_eq!(report.frames_written, 1);
        assert_eq!(runtime.position_ms(), 0);
        let samples = &output_state.lock().unwrap().samples;
        assert_eq!(samples.len(), 322);
        assert!(samples[..320].iter().all(|sample| *sample == 0.0));
        assert_eq!(samples[320], 0.5);
        assert_eq!(samples[321], -0.25);
    }

    #[test]
    fn terminal_playback_drains_phaser_to_twelve_second_budget() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("phaser-tail.wav");
        fs::write(&path, pcm16_stereo_wav(&[(16384, -8192)])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime
            .configure_dsp(
                1,
                DspConfig {
                    phaser: crate::dsp_algorithms::phaser::PhaserSettings {
                        enabled: true,
                        rate_hz: 1.5,
                        depth: 0.8,
                        feedback: 0.5,
                        mix: 1.0,
                        stages: 6.0,
                    },
                    ..DspConfig::default()
                },
            )
            .unwrap();

        let report = runtime.play_to_end(&trusted_local(&path)).unwrap();
        assert_eq!(report.frames_written, 1);
        assert_eq!(runtime.position_ms(), 0);
        let samples = &output_state.lock().unwrap().samples;
        assert_eq!(samples.len(), (1 + 12 * 8_000) * 2);
        assert!(samples.iter().all(|sample| sample.is_finite()));
        assert!(samples[samples.len() - 2].abs() < 1e-6);
        assert!(samples[samples.len() - 1].abs() < 1e-6);
    }

    #[test]
    fn unsupported_container_fails_instead_of_claiming_playback() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("song.mp3");
        fs::write(&path, b"not a wave").unwrap();
        let media = trusted_local(&path);
        let state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        let error = runtime.play_to_end(&media).unwrap_err();
        assert!(matches!(error, EngineError::Unsupported(_)));
        assert_eq!(state.lock().unwrap().starts, 0);
    }

    struct ShortReadFactory {
        track: Track,
        samples: Vec<f32>,
        max_read: usize,
    }

    impl DecoderFactory for ShortReadFactory {
        fn open(&self, _media: &TrustedResolvedMedia) -> Result<Box<dyn Decoder>> {
            Ok(Box::new(ShortReadDecoder {
                descriptor: DecoderDescriptor {
                    track: self.track.clone(),
                    format: format(),
                    trim: CodecTrim::default(),
                },
                samples: self.samples.clone(),
                position: 0,
                max_read: self.max_read,
            }))
        }

        fn clone_factory(&self) -> Box<dyn DecoderFactory> {
            Box::new(Self {
                track: self.track.clone(),
                samples: self.samples.clone(),
                max_read: self.max_read,
            })
        }
    }

    struct ShortReadDecoder {
        descriptor: DecoderDescriptor,
        samples: Vec<f32>,
        position: usize,
        max_read: usize,
    }

    impl Decoder for ShortReadDecoder {
        fn descriptor(&self) -> &DecoderDescriptor {
            &self.descriptor
        }
        fn total_frames(&self) -> u64 {
            self.samples.len() as u64
        }
        fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
            let count = output
                .len()
                .min(self.max_read)
                .min(self.samples.len() - self.position);
            output[..count].copy_from_slice(&self.samples[self.position..self.position + count]);
            self.position += count;
            Ok(count)
        }
        fn seek(&mut self, frame: u64) -> Result<()> {
            self.position = frame as usize;
            Ok(())
        }
    }

    #[test]
    fn legal_short_decoder_reads_do_not_truncate_playback() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("short.wav");
        fs::write(&path, pcm16_wav(&[0])).unwrap();
        let track = local_track(&path);
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(
            Box::new(ShortReadFactory {
                track,
                samples: vec![0.1, 0.2, 0.3, 0.4],
                max_read: 1,
            }),
            Box::new(output),
        );
        let report = runtime.play_to_end(&trusted_local(&path)).unwrap();
        assert_eq!(report.frames_written, 4);
        assert_eq!(
            output_state.lock().unwrap().samples,
            vec![0.1, 0.2, 0.3, 0.4]
        );
    }

    #[test]
    fn empty_track_is_rejected_before_dsp_drain_or_output_start() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("empty.wav");
        fs::write(&path, pcm16_wav(&[0])).unwrap();
        let track = local_track(&path);
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(
            Box::new(ShortReadFactory {
                track,
                samples: Vec::new(),
                max_read: 1,
            }),
            Box::new(output),
        );
        runtime.load(&trusted_local(&path)).unwrap();
        let error = runtime.start().unwrap_err();
        assert!(matches!(error, EngineError::Decode(_)));
        assert_eq!(output_state.lock().unwrap().starts, 0);
    }

    struct TrimDecoder {
        descriptor: DecoderDescriptor,
        samples: Vec<f32>,
        frame: usize,
    }

    impl Decoder for TrimDecoder {
        fn descriptor(&self) -> &DecoderDescriptor {
            &self.descriptor
        }
        fn total_frames(&self) -> u64 {
            self.samples.len() as u64
        }
        fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
            let count = output.len().min(self.samples.len() - self.frame);
            output[..count].copy_from_slice(&self.samples[self.frame..self.frame + count]);
            self.frame += count;
            Ok(count)
        }
        fn seek(&mut self, frame: u64) -> Result<()> {
            self.frame = frame as usize;
            Ok(())
        }
    }

    struct TrimFactory(Track);
    impl DecoderFactory for TrimFactory {
        fn open(&self, _media: &TrustedResolvedMedia) -> Result<Box<dyn Decoder>> {
            Ok(Box::new(TrimDecoder {
                descriptor: DecoderDescriptor {
                    track: self.0.clone(),
                    format: format(),
                    trim: CodecTrim {
                        delay_frames: 2,
                        padding_frames: 2,
                    },
                },
                samples: (0..8).map(|value| value as f32).collect(),
                frame: 0,
            }))
        }

        fn clone_factory(&self) -> Box<dyn DecoderFactory> {
            Box::new(Self(self.0.clone()))
        }
    }

    #[test]
    fn adapts_sample_rate_and_channels_before_bypass_dsp() {
        let source_format = PcmFormat {
            sample_rate: 4_000,
            channels: 1,
            sample_format: PcmSampleFormat::F32,
        };
        let target_format = PcmFormat {
            sample_rate: 8_000,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        };
        let track = local_track(Path::new("adapt.wav"));
        let decoder = TrimDecoder {
            descriptor: DecoderDescriptor {
                track,
                format: source_format,
                trim: CodecTrim::default(),
            },
            samples: vec![0.0, 1.0, 0.0],
            frame: 0,
        };
        let mut adapter = PcmAdapter::new(Box::new(decoder), target_format).unwrap();
        let mut actual = vec![0.0; adapter.total_frames() as usize * 2];
        let read = adapter.read_pcm(&mut actual).unwrap();
        actual.truncate(read);
        assert_eq!(adapter.descriptor().format, target_format);
        assert_eq!(
            actual,
            vec![0.0, 0.0, 0.5, 0.5, 1.0, 1.0, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0]
        );
    }

    #[test]
    fn codec_delay_and_padding_are_physically_trimmed() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("trim.wav");
        fs::write(&path, pcm16_wav(&[0])).unwrap();
        let media = trusted_local(&path);
        let track = media.track.clone();
        let state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&state),
            max_write: usize::MAX,
        };
        let mut runtime =
            RuntimeCoordinator::new(Box::new(TrimFactory(track.clone())), Box::new(output));
        let report = runtime.play_to_end(&media).unwrap();
        assert_eq!(report.frames_written, 4);
        assert_eq!(state.lock().unwrap().samples, vec![2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn configured_group_one_changes_pcm_in_the_real_runtime_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("group-one.wav");
        fs::write(&path, pcm16_stereo_wav(&[(16384, 0), (0, 16384)])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        let config = DspConfig {
            stereo_width: 0.0,
            ..DspConfig::default()
        };
        runtime.configure_dsp(1, config).unwrap();
        runtime.play_to_end(&trusted_local(&path)).unwrap();
        assert_eq!(
            output_state.lock().unwrap().samples,
            vec![0.25, 0.25, 0.25, 0.25]
        );
    }

    #[test]
    fn standby_dsp_fault_promotes_raw_pcm_in_safe_bypass() {
        struct FaultOnSecondBlock {
            calls: usize,
        }

        impl PcmProcessor for FaultOnSecondBlock {
            fn name(&self) -> &'static str {
                "fault-on-standby"
            }
            fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
                Some(Box::new(self.calls))
            }
            fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
                state.is::<usize>()
            }
            fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
                let Some(calls) = state.downcast_mut::<usize>() else {
                    return false;
                };
                *calls = self.calls;
                true
            }
            fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
                let Some(calls) = state.downcast_ref::<usize>() else {
                    return false;
                };
                self.calls = *calls;
                true
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
                self.calls += 1;
                if self.calls == 2 {
                    block.interleaved[0] = f32::NAN;
                }
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                7
            }
            fn tail_frames(&self) -> u32 {
                11
            }
        }

        let directory = tempdir().unwrap();
        let current_path = directory.path().join("fault-current.wav");
        let next_path = directory.path().join("fault-next.wav");
        fs::write(&current_path, pcm16_wav(&[0])).unwrap();
        fs::write(&next_path, pcm16_wav(&[8192, -8192])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: format(),
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let prepared = PreparedProcessorChain::prepare(
            1,
            format(),
            DECODE_BUFFER_FRAMES,
            vec![Box::new(FaultOnSecondBlock { calls: 0 })],
        )
        .unwrap();
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime.queue_prepared_dsp(prepared).unwrap();
        runtime.load(&trusted_local(&current_path)).unwrap();
        runtime.start().unwrap();

        let next = trusted_local(&next_path);
        let next_track = next.track.clone();
        runtime.prime_standby(&next, 2).unwrap();
        runtime.prepare_standby_dsp_after_active_tail().unwrap();

        let snapshot = runtime.dsp_snapshot();
        assert_eq!(snapshot.revision, 1);
        assert!(snapshot.safe_bypass_active);
        assert_eq!(snapshot.latency_frames, 0);
        assert_eq!(snapshot.tail_frames, 0);
        assert_eq!(snapshot.fault_stream_frame, Some(0));
        assert_eq!(runtime.standby.as_ref().unwrap().dsp_revision, Some(1));
        assert_eq!(
            runtime.standby_pcm.iter().copied().collect::<Vec<_>>(),
            vec![0.25, -0.25]
        );
        let fault = runtime.take_dsp_fault().unwrap();
        assert_eq!(fault.0, 1);
        assert_eq!(fault.1.processor_name, "fault-on-standby");
        assert_eq!(fault.2, 0);

        assert!(runtime.promote_standby(&next_track).unwrap());
        runtime.pump_once().unwrap();
        assert_eq!(output_state.lock().unwrap().samples, vec![0.0, 0.25, -0.25]);
    }

    #[test]
    fn reconfiguration_restores_raw_standby_before_promotion() {
        let directory = tempdir().unwrap();
        let current_path = directory.path().join("standby-current.wav");
        let next_path = directory.path().join("standby-next.wav");
        fs::write(&current_path, pcm16_stereo_wav(&[(0, 0)])).unwrap();
        fs::write(&next_path, pcm16_stereo_wav(&[(16384, 0), (0, 16384)])).unwrap();
        let output_state = Arc::new(Mutex::new(OutputState::default()));
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::clone(&output_state),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime.load(&trusted_local(&current_path)).unwrap();
        runtime.configure_dsp(1, DspConfig::default()).unwrap();
        runtime.start().unwrap();
        let next = trusted_local(&next_path);
        let next_track = next.track.clone();
        runtime.prime_standby(&next, 2).unwrap();
        runtime.prepare_standby_dsp_after_active_tail().unwrap();
        assert_eq!(runtime.standby.as_ref().unwrap().dsp_revision, Some(1));

        runtime
            .configure_dsp(
                2,
                DspConfig {
                    stereo_width: 0.0,
                    ..DspConfig::default()
                },
            )
            .unwrap();
        assert_eq!(runtime.standby.as_ref().unwrap().dsp_revision, None);
        assert_eq!(
            runtime.standby_pcm.iter().copied().collect::<Vec<_>>(),
            vec![0.5, 0.0, 0.0, 0.5]
        );
        assert!(runtime.promote_standby(&next_track).unwrap());
        assert_eq!(runtime.dsp_snapshot().revision, 2);
        runtime.pump_once().unwrap();
        assert_eq!(
            output_state.lock().unwrap().samples,
            vec![0.0, 0.0, 0.25, 0.25, 0.25, 0.25]
        );
    }

    #[test]
    fn discarding_processed_standby_restores_state_before_reprime() {
        let directory = tempdir().unwrap();
        let current_path = directory.path().join("discard-current.wav");
        let next_path = directory.path().join("discard-next.wav");
        fs::write(&current_path, pcm16_stereo_wav(&[(8192, -4096)])).unwrap();
        fs::write(
            &next_path,
            pcm16_stereo_wav(&[(16384, 0), (0, 16384), (-8192, 4096)]),
        )
        .unwrap();
        let config = DspConfig {
            surround3d: crate::dsp_algorithms::surround3d::Surround3dSettings {
                enabled: true,
                distance: 0.85,
                speed: 0.7,
                angle: 11.0,
                direction: -1.0,
            },
            delay: crate::dsp_algorithms::delay::DelaySettings {
                enabled: true,
                delay_ms: 0.125,
                feedback: 0.6,
                mix: 0.75,
            },
            chorus: crate::dsp_algorithms::chorus::ChorusSettings {
                enabled: true,
                rate_hz: 4.0,
                depth_ms: 5.0,
                mix: 0.5,
            },
            flanger: crate::dsp_algorithms::flanger::FlangerSettings {
                enabled: true,
                rate_hz: 2.5,
                depth_ms: 4.0,
                feedback: 0.6,
                mix: 0.5,
            },
            phaser: crate::dsp_algorithms::phaser::PhaserSettings {
                enabled: true,
                rate_hz: 1.5,
                depth: 0.8,
                feedback: 0.5,
                mix: 0.5,
                stages: 6.0,
            },
            tremolo: crate::dsp_algorithms::tremolo::TremoloSettings {
                enabled: true,
                rate_hz: 5.0,
                depth: 0.8,
                mix: 0.75,
            },
            ..DspConfig::default()
        };

        let run = |discard_first: bool| {
            let output_state = Arc::new(Mutex::new(OutputState::default()));
            let output = RecordingOutput {
                format: PcmFormat {
                    sample_rate: 8_000,
                    channels: 2,
                    sample_format: PcmSampleFormat::F32,
                },
                state: Arc::clone(&output_state),
                max_write: usize::MAX,
            };
            let mut runtime =
                RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
            runtime.load(&trusted_local(&current_path)).unwrap();
            runtime.configure_dsp(1, config.clone()).unwrap();
            runtime.start().unwrap();
            let next = trusted_local(&next_path);
            if discard_first {
                runtime.prime_standby(&next, 3).unwrap();
                runtime.prepare_standby_dsp_after_active_tail().unwrap();
                runtime.take_standby_at_sample_boundary().unwrap();
            }
            let next_track = next.track.clone();
            runtime.prime_standby(&next, 3).unwrap();
            runtime.prepare_standby_dsp_after_active_tail().unwrap();
            assert!(runtime.promote_standby(&next_track).unwrap());
            runtime.pump_once().unwrap();
            let samples = output_state.lock().unwrap().samples.clone();
            samples
        };

        assert_eq!(run(true), run(false));
    }

    #[test]
    fn standby_reprocessing_restores_stateful_dsp_before_revision_swap() {
        let directory = tempdir().unwrap();
        let current_path = directory.path().join("stateful-standby-current.wav");
        let next_path = directory.path().join("stateful-standby-next.wav");
        fs::write(&current_path, pcm16_stereo_wav(&[(8192, -4096)])).unwrap();
        fs::write(
            &next_path,
            pcm16_stereo_wav(&[(16384, 0), (0, 16384), (-8192, 4096)]),
        )
        .unwrap();
        let config = DspConfig {
            surround3d: crate::dsp_algorithms::surround3d::Surround3dSettings {
                enabled: true,
                distance: 0.85,
                speed: 0.7,
                angle: 11.0,
                direction: -1.0,
            },
            delay: crate::dsp_algorithms::delay::DelaySettings {
                enabled: true,
                delay_ms: 0.125,
                feedback: 0.6,
                mix: 0.75,
            },
            chorus: crate::dsp_algorithms::chorus::ChorusSettings {
                enabled: true,
                rate_hz: 4.0,
                depth_ms: 5.0,
                mix: 0.5,
            },
            flanger: crate::dsp_algorithms::flanger::FlangerSettings {
                enabled: true,
                rate_hz: 2.5,
                depth_ms: 4.0,
                feedback: 0.6,
                mix: 0.5,
            },
            phaser: crate::dsp_algorithms::phaser::PhaserSettings {
                enabled: true,
                rate_hz: 1.5,
                depth: 0.8,
                feedback: 0.5,
                mix: 0.5,
                stages: 6.0,
            },
            tremolo: crate::dsp_algorithms::tremolo::TremoloSettings {
                enabled: true,
                rate_hz: 5.0,
                depth: 0.8,
                mix: 0.75,
            },
            ..DspConfig::default()
        };

        let run = |reconfigure: bool| {
            let output_state = Arc::new(Mutex::new(OutputState::default()));
            let output = RecordingOutput {
                format: PcmFormat {
                    sample_rate: 8_000,
                    channels: 2,
                    sample_format: PcmSampleFormat::F32,
                },
                state: Arc::clone(&output_state),
                max_write: usize::MAX,
            };
            let mut runtime =
                RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
            runtime.load(&trusted_local(&current_path)).unwrap();
            runtime.configure_dsp(1, config.clone()).unwrap();
            runtime.start().unwrap();
            let next = trusted_local(&next_path);
            let next_track = next.track.clone();
            runtime.prime_standby(&next, 3).unwrap();
            runtime.prepare_standby_dsp_after_active_tail().unwrap();
            if reconfigure {
                runtime.configure_dsp(2, config.clone()).unwrap();
            }
            assert!(runtime.promote_standby(&next_track).unwrap());
            runtime.pump_once().unwrap();
            let samples = output_state.lock().unwrap().samples.clone();
            samples
        };

        assert_eq!(run(true), run(false));
    }

    #[test]
    fn rapid_monotonic_revisions_coalesce_before_the_next_active_block() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("revisions.wav");
        let frames = vec![(8192, -8192); DECODE_BUFFER_FRAMES * 3];
        fs::write(&path, pcm16_stereo_wav(&frames)).unwrap();
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::new(Mutex::new(OutputState::default())),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        runtime.load(&trusted_local(&path)).unwrap();
        runtime.configure_dsp(1, DspConfig::default()).unwrap();
        runtime.configure_dsp(2, DspConfig::default()).unwrap();
        runtime.configure_dsp(3, DspConfig::default()).unwrap();
        assert_eq!(runtime.dsp_snapshot().revision, 0);
        assert_eq!(runtime.dsp_snapshot().pending_revision, Some(3));

        runtime.start().unwrap();
        assert_eq!(runtime.dsp_snapshot().revision, 3);
        assert_eq!(runtime.dsp_snapshot().pending_revision, None);

        runtime.stop().unwrap();
        runtime.configure_dsp(4, DspConfig::default()).unwrap();
        runtime.configure_dsp(5, DspConfig::default()).unwrap();
        runtime.configure_dsp(6, DspConfig::default()).unwrap();
        assert_eq!(runtime.dsp_snapshot().revision, 3);
        assert_eq!(runtime.dsp_snapshot().pending_revision, Some(6));

        runtime.load(&trusted_local(&path)).unwrap();
        runtime.start().unwrap();
        assert_eq!(runtime.dsp_snapshot().revision, 6);
        assert_eq!(runtime.dsp_snapshot().pending_revision, None);
    }

    #[test]
    fn telemetry_analyzes_only_the_prefix_accepted_by_output() {
        // 复位进程级读数槽：本测试断言「无处理器读数时 validity 恰为基础位」，
        // 不受其它测试通过 hot 门写入全局槽的残留影响（测试顺序无关）。
        reset_chain_metering_for_tests();
        let directory = tempdir().unwrap();
        let path = directory.path().join("telemetry-prefix.wav");
        let mut samples = vec![(8192, -8192); 267];
        samples.extend(vec![(32767, -32768); DECODE_BUFFER_FRAMES - 267]);
        fs::write(&path, pcm16_stereo_wav(&samples)).unwrap();
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 8_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::new(Mutex::new(OutputState::default())),
            max_write: 267 * 2,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        let telemetry = runtime.subscribe_telemetry();
        telemetry.set_activity(TelemetryActivity::Active30Hz);

        runtime.load(&trusted_local(&path)).unwrap();
        runtime.start().unwrap();
        let frame = telemetry.latest().unwrap();
        assert_eq!(frame.sample_frame, 266);
        assert_eq!(frame.peak, [0.25, 0.25]);
        assert_eq!(frame.meter, [0.25, 0.25]);
        assert_eq!(
            frame.validity_flags,
            TELEMETRY_VALID_WAVEFORM | TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS
        );
        assert!(frame.spectrum.iter().all(|value| *value == 0));
        assert_eq!(frame.true_peak, [0.0; 2]);
        assert_eq!(frame.limiter_reduction_db, 0.0);
    }

    #[test]
    fn preparing_standby_never_publishes_telemetry() {
        let directory = tempdir().unwrap();
        let current_path = directory.path().join("telemetry-current.wav");
        let next_path = directory.path().join("telemetry-standby.wav");
        fs::write(&current_path, pcm16_stereo_wav(&[(0, 0)])).unwrap();
        fs::write(&next_path, pcm16_stereo_wav(&[(32767, -32768)])).unwrap();
        let output = RecordingOutput {
            format: PcmFormat {
                sample_rate: 30,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            state: Arc::new(Mutex::new(OutputState::default())),
            max_write: usize::MAX,
        };
        let mut runtime = RuntimeCoordinator::new(Box::new(WavDecoderFactory), Box::new(output));
        let telemetry = runtime.subscribe_telemetry();
        telemetry.set_activity(TelemetryActivity::Active30Hz);

        runtime.load(&trusted_local(&current_path)).unwrap();
        let next = trusted_local(&next_path);
        runtime.prime_standby(&next, 1).unwrap();
        runtime.prepare_standby_dsp_after_active_tail().unwrap();
        assert!(telemetry.latest().is_none());
    }

    fn pcm16_stereo_wav(frames: &[(i16, i16)]) -> Vec<u8> {
        let data_size = (frames.len() * 4) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&8_000_u32.to_le_bytes());
        wav.extend_from_slice(&32_000_u32.to_le_bytes());
        wav.extend_from_slice(&4_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for (left, right) in frames {
            wav.extend_from_slice(&left.to_le_bytes());
            wav.extend_from_slice(&right.to_le_bytes());
        }
        wav
    }

    fn pcm16_wav(samples: &[i16]) -> Vec<u8> {
        let data_size = std::mem::size_of_val(samples) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&8_000_u32.to_le_bytes());
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    }
}
