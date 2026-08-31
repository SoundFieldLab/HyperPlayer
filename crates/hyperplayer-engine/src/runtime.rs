use crate::audio::{AudioOutput, Decoder, DecoderFactory, GaplessCoordinator, StandbyState};
use crate::dsp::{PcmFormat, ProcessorChain};
use crate::error::{EngineError, Result};
use crate::media::TrustedResolvedMedia;
use crate::model::Track;
use std::collections::VecDeque;

const DECODE_BUFFER_FRAMES: usize = 2048;

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
    position_frames: u64,
    pending: VecDeque<f32>,
    decoder_eof: bool,
}

struct StandbyPlayback {
    decoder: Box<dyn Decoder>,
    format: PcmFormat,
    playable_frames: u64,
    position_frames: u64,
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
    standby_pcm: VecDeque<f32>,
    started: bool,
}

impl RuntimeCoordinator {
    pub fn new(decoder_factory: Box<dyn DecoderFactory>, output: Box<dyn AudioOutput>) -> Self {
        let output_format = output.format();
        Self {
            decoder_factory,
            output,
            dsp: ProcessorChain::bypass_only(),
            gapless: GaplessCoordinator::new(output_format),
            active: None,
            standby: None,
            standby_pcm: VecDeque::new(),
            started: false,
        }
    }

    pub fn output_format(&self) -> PcmFormat {
        self.output.format()
    }

    pub fn standby(&self) -> &StandbyState {
        self.gapless.standby()
    }

    pub fn load(&mut self, media: &TrustedResolvedMedia) -> Result<()> {
        if self.active.is_some() {
            self.output.stop()?;
            self.started = false;
        }
        let decoder = self.decoder_factory.open(media)?;
        self.active = Some(self.prepare_decoder(decoder)?);
        self.invalidate_standby();
        self.dsp.reset();
        Ok(())
    }

    pub fn start(&mut self) -> Result<u64> {
        if self.active.is_none() {
            return Err(EngineError::InvalidInput("no track is loaded".into()));
        }
        if self.started {
            return Ok(self.position_ms());
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
        self.invalidate_standby();
        self.dsp.reset();
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
            active.position_frames = frame;
            active.pending.clear();
            active.decoder_eof = frame == active.playable_frames;
            frame
        };
        self.invalidate_standby();
        self.dsp.reset();
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

    pub fn position_ms(&self) -> u64 {
        self.active
            .as_ref()
            .map(|active| {
                active.position_frames.saturating_mul(1000) / u64::from(active.format.sample_rate)
            })
            .unwrap_or(0)
    }

    pub fn pump_once(&mut self) -> Result<PumpResult> {
        if self.active.is_none() {
            return Err(EngineError::InvalidInput("no track is loaded".into()));
        }
        self.fill_active_pending()?;
        let active = self.active.as_mut().expect("active checked above");
        if active.pending.is_empty() && active.decoder_eof {
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
        if written % channels != 0 {
            return Err(EngineError::AudioBackend(
                "audio output reported an incomplete PCM frame".into(),
            ));
        }
        active.pending.drain(..written);
        active.position_frames += (written / channels) as u64;
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
        if frames == 0 {
            return Err(EngineError::InvalidInput(
                "standby frame count must be greater than zero".into(),
            ));
        }
        self.invalidate_standby();
        let decoder = self.decoder_factory.open(media)?;
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
        self.dsp.process(standby.format, &mut pcm)?;
        let buffered_frames = samples / usize::from(standby.format.channels);
        if buffered_frames == 0 {
            return Err(EngineError::Decode(
                "standby track contains no playable PCM frames".into(),
            ));
        }
        standby.position_frames = buffered_frames as u64;
        self.standby_pcm.extend(pcm);
        self.gapless.mark_primed(buffered_frames)?;
        self.standby = Some(StandbyPlayback {
            decoder: standby.decoder,
            format: standby.format,
            playable_frames: standby.playable_frames,
            position_frames: standby.position_frames,
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
        self.active = Some(ActivePlayback {
            decoder: standby.decoder,
            format: standby.format,
            playable_frames: standby.playable_frames,
            position_frames: 0,
            pending: std::mem::take(&mut self.standby_pcm),
            decoder_eof: standby.position_frames >= standby.playable_frames,
        });
        self.dsp.reset();
        Ok(true)
    }

    pub fn take_standby_at_sample_boundary(&mut self) -> Result<(Track, Vec<f32>)> {
        let state = self.gapless.take_at_sample_boundary()?;
        let track = match state {
            StandbyState::Primed { track, .. } => track,
            _ => unreachable!("gapless coordinator only returns a primed state"),
        };
        self.standby = None;
        Ok((track, self.standby_pcm.drain(..).collect()))
    }

    pub fn play_to_end(&mut self, media: &TrustedResolvedMedia) -> Result<PlaybackReport> {
        self.load(media)?;
        self.start()?;
        loop {
            if matches!(self.pump_once()?, PumpResult::Eof { .. }) {
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
            position_frames: 0,
            pending: VecDeque::new(),
            decoder_eof: playable_frames == 0,
        })
    }

    fn fill_active_pending(&mut self) -> Result<()> {
        let active = self
            .active
            .as_mut()
            .expect("caller requires active playback");
        if !active.pending.is_empty() || active.decoder_eof {
            return Ok(());
        }
        let remaining = active.playable_frames - active.position_frames;
        if remaining == 0 {
            active.decoder_eof = true;
            return Ok(());
        }
        let frames = remaining.min(DECODE_BUFFER_FRAMES as u64) as usize;
        let channels = usize::from(active.format.channels);
        let mut pcm = vec![0.0; frames * channels];
        let samples = active.decoder.read_pcm(&mut pcm)?;
        if samples % channels != 0 {
            return Err(EngineError::Decode(
                "decoder returned an incomplete PCM frame".into(),
            ));
        }
        pcm.truncate(samples.min(frames * channels));
        self.dsp.process(active.format, &mut pcm)?;
        active.pending.extend(pcm);
        active.decoder_eof = samples == 0 || samples < frames * channels;
        Ok(())
    }

    fn invalidate_standby(&mut self) {
        self.gapless.invalidate();
        self.standby = None;
        self.standby_pcm.clear();
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
    use crate::dsp::{PcmFormat, PcmSampleFormat};
    use crate::media::{MediaHandle, TrustedResolvedMedia};
    use crate::model::{MediaId, MediaSource};
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
