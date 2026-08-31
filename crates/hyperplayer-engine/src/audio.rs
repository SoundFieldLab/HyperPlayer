use crate::dsp::PcmFormat;
use crate::error::{EngineError, Result};
use crate::media::TrustedResolvedMedia;
use crate::model::Track;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodecTrim {
    pub delay_frames: u32,
    pub padding_frames: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecoderDescriptor {
    pub track: Track,
    pub format: PcmFormat,
    pub trim: CodecTrim,
}

pub trait Decoder: Send {
    fn descriptor(&self) -> &DecoderDescriptor;
    fn total_frames(&self) -> u64;
    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize>;
    fn seek(&mut self, frame: u64) -> Result<()>;
}

pub trait DecoderFactory: Send + Sync {
    fn open(&self, media: &TrustedResolvedMedia) -> Result<Box<dyn Decoder>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalAudioFormat {
    Wav,
    Flac,
    Mp3,
    Aac,
    Mp4,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LocalDecoderFactory;

impl DecoderFactory for LocalDecoderFactory {
    fn open(&self, media: &TrustedResolvedMedia) -> Result<Box<dyn Decoder>> {
        match probe_local_format(media)? {
            LocalAudioFormat::Wav => Ok(Box::new(WavDecoder::open(media)?)),
            LocalAudioFormat::Flac => Ok(Box::new(FlacDecoder::open(media)?)),
            LocalAudioFormat::Mp3 => Ok(Box::new(Mp3Decoder::open(media)?)),
            LocalAudioFormat::Aac | LocalAudioFormat::Mp4 => Err(EngineError::Unsupported(
                "AAC/M4A decoding is unavailable with the current license-compatible decoders"
                    .into(),
            )),
        }
    }
}

fn probe_local_format(media: &TrustedResolvedMedia) -> Result<LocalAudioFormat> {
    let mut file = media.handle.try_clone_file()?;
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0_u8; 12];
    let count = file.read(&mut header)?;
    let bytes = &header[..count];
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Ok(LocalAudioFormat::Wav);
    }
    if bytes.starts_with(b"fLaC") {
        return Ok(LocalAudioFormat::Flac);
    }
    if bytes.starts_with(b"ID3") || has_mp3_frame_sync(bytes) {
        return Ok(LocalAudioFormat::Mp3);
    }
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        return Ok(LocalAudioFormat::Mp4);
    }
    if bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xf6) == 0xf0 {
        return Ok(LocalAudioFormat::Aac);
    }
    Err(EngineError::Unsupported(format!(
        "unrecognized local audio container: {}",
        media.handle.label().display()
    )))
}

fn has_mp3_frame_sync(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe6) == 0xe2
}

pub trait AudioOutput: Send {
    fn format(&self) -> PcmFormat;
    fn start(&mut self) -> Result<()>;
    fn pause(&mut self) -> Result<()>;
    fn stop(&mut self) -> Result<()>;
    fn write(&mut self, interleaved_pcm: &[f32]) -> Result<usize>;
    fn set_volume(&mut self, volume: f32) -> Result<()> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err(EngineError::InvalidInput(
                "volume must be finite and between 0 and 1".into(),
            ));
        }
        Ok(())
    }
    fn buffered_samples(&self) -> usize {
        0
    }
}

struct RingState {
    samples: VecDeque<f32>,
    closed: bool,
}

struct SharedRing {
    state: Mutex<RingState>,
    space_available: Condvar,
    capacity: usize,
}

pub struct CpalAudioOutput {
    format: PcmFormat,
    ring: Arc<SharedRing>,
    volume_bits: Arc<AtomicU32>,
    stream_error: Arc<Mutex<Option<String>>>,
    stream: cpal::Stream,
}

impl CpalAudioOutput {
    pub fn open(format: PcmFormat, capacity_frames: usize) -> Result<Self> {
        use cpal::traits::{DeviceTrait, HostTrait};

        if capacity_frames == 0 || format.channels == 0 || format.sample_rate == 0 {
            return Err(EngineError::InvalidInput(
                "audio output format and ring capacity must be non-zero".into(),
            ));
        }
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| EngineError::AudioBackend("no default output device".into()))?;
        let supported = device
            .supported_output_configs()
            .map_err(audio_backend)?
            .any(|range| {
                range.channels() == format.channels
                    && range.sample_format() == cpal::SampleFormat::F32
                    && range.min_sample_rate() <= format.sample_rate
                    && range.max_sample_rate() >= format.sample_rate
            });
        if !supported {
            return Err(EngineError::Unsupported(format!(
                "output device does not support F32 {} Hz / {} channels",
                format.sample_rate, format.channels
            )));
        }

        let capacity = capacity_frames
            .checked_mul(usize::from(format.channels))
            .ok_or_else(|| EngineError::InvalidInput("audio ring capacity overflow".into()))?;
        let ring = Arc::new(SharedRing {
            state: Mutex::new(RingState {
                samples: VecDeque::with_capacity(capacity),
                closed: false,
            }),
            space_available: Condvar::new(),
            capacity,
        });
        let callback_ring = Arc::clone(&ring);
        let volume_bits = Arc::new(AtomicU32::new(1.0_f32.to_bits()));
        let callback_volume = Arc::clone(&volume_bits);
        let stream_error = Arc::new(Mutex::new(None));
        let callback_error = Arc::clone(&stream_error);
        let config = cpal::StreamConfig {
            channels: format.channels,
            sample_rate: format.sample_rate,
            buffer_size: cpal::BufferSize::Default,
        };
        let stream = device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    let volume = f32::from_bits(callback_volume.load(Ordering::Relaxed));
                    let mut state = callback_ring
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    for sample in data {
                        *sample = state.samples.pop_front().unwrap_or(0.0) * volume;
                    }
                    callback_ring.space_available.notify_all();
                },
                move |error| {
                    *callback_error.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(error.to_string());
                },
                None,
            )
            .map_err(audio_backend)?;
        Ok(Self {
            format,
            ring,
            volume_bits,
            stream_error,
            stream,
        })
    }
}

impl AudioOutput for CpalAudioOutput {
    fn format(&self) -> PcmFormat {
        self.format
    }

    fn start(&mut self) -> Result<()> {
        use cpal::traits::StreamTrait;
        self.ring
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .closed = false;
        self.stream.play().map_err(audio_backend)
    }

    fn pause(&mut self) -> Result<()> {
        use cpal::traits::StreamTrait;
        self.stream.pause().map_err(audio_backend)
    }

    fn stop(&mut self) -> Result<()> {
        use cpal::traits::StreamTrait;
        self.stream.pause().map_err(audio_backend)?;
        let mut state = self.ring.state.lock().unwrap_or_else(|e| e.into_inner());
        state.samples.clear();
        state.closed = true;
        self.ring.space_available.notify_all();
        Ok(())
    }

    fn write(&mut self, interleaved_pcm: &[f32]) -> Result<usize> {
        if let Some(error) = self
            .stream_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            return Err(EngineError::AudioBackend(error));
        }
        let deadline = Instant::now() + Duration::from_millis(100);
        let mut state = self.ring.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.samples.len() == self.ring.capacity && !state.closed {
            let now = Instant::now();
            if now >= deadline {
                return Ok(0);
            }
            let (next, _) = self
                .ring
                .space_available
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
        }
        if state.closed {
            return Err(EngineError::AudioBackend("audio output is stopped".into()));
        }
        let written = interleaved_pcm
            .len()
            .min(self.ring.capacity - state.samples.len());
        state.samples.extend(&interleaved_pcm[..written]);
        Ok(written)
    }

    fn set_volume(&mut self, volume: f32) -> Result<()> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err(EngineError::InvalidInput(
                "volume must be finite and between 0 and 1".into(),
            ));
        }
        self.volume_bits.store(volume.to_bits(), Ordering::Relaxed);
        Ok(())
    }

    fn buffered_samples(&self) -> usize {
        self.ring
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .samples
            .len()
    }
}

fn audio_backend(error: impl std::fmt::Display) -> EngineError {
    EngineError::AudioBackend(error.to_string())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct WavDecoderFactory;

impl DecoderFactory for WavDecoderFactory {
    fn open(&self, media: &TrustedResolvedMedia) -> Result<Box<dyn Decoder>> {
        let path = media.handle.label();
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("wav"))
        {
            return Err(EngineError::Unsupported(format!(
                "WAV decoder does not accept this path: {}",
                path.display()
            )));
        }
        if probe_local_format(media)? != LocalAudioFormat::Wav {
            return Err(EngineError::Unsupported(format!(
                "local audio is not RIFF/WAVE: {}",
                path.display()
            )));
        }
        Ok(Box::new(WavDecoder::open(media)?))
    }
}

struct WavDecoder {
    descriptor: DecoderDescriptor,
    file: File,
    data_start: u64,
    data_len: u64,
    data_position: u64,
    encoding: WavEncoding,
    block_align: u16,
}

#[derive(Clone, Copy)]
enum WavEncoding {
    Pcm16,
    Float32,
}

impl WavDecoder {
    fn open(media: &TrustedResolvedMedia) -> Result<Self> {
        let mut file = media.handle.try_clone_file()?;
        file.seek(SeekFrom::Start(0))?;
        let mut riff = [0_u8; 12];
        file.read_exact(&mut riff)?;
        if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
            return Err(EngineError::Unsupported(
                "only RIFF/WAVE files are supported".into(),
            ));
        }

        let mut format = None;
        let mut data = None;
        loop {
            let mut header = [0_u8; 8];
            match file.read_exact(&mut header) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            }
            let chunk_len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64;
            let chunk_start = file.stream_position()?;
            match &header[0..4] {
                b"fmt " => {
                    if chunk_len < 16 {
                        return Err(EngineError::Decode("WAV fmt chunk is truncated".into()));
                    }
                    let mut bytes = [0_u8; 16];
                    file.read_exact(&mut bytes)?;
                    let tag = u16::from_le_bytes(bytes[0..2].try_into().unwrap());
                    let channels = u16::from_le_bytes(bytes[2..4].try_into().unwrap());
                    let sample_rate = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
                    let block_align = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
                    let bits = u16::from_le_bytes(bytes[14..16].try_into().unwrap());
                    let encoding = match (tag, bits) {
                        (1, 16) => WavEncoding::Pcm16,
                        (3, 32) => WavEncoding::Float32,
                        _ => {
                            return Err(EngineError::Unsupported(format!(
                                "unsupported WAV encoding tag {tag} with {bits} bits"
                            )));
                        }
                    };
                    if channels == 0 || sample_rate == 0 || block_align == 0 {
                        return Err(EngineError::Decode(
                            "WAV format contains zero values".into(),
                        ));
                    }
                    let expected_align = channels.checked_mul(bits / 8).ok_or_else(|| {
                        EngineError::Decode("WAV block alignment overflow".into())
                    })?;
                    if block_align != expected_align {
                        return Err(EngineError::Decode("WAV block alignment is invalid".into()));
                    }
                    format = Some((
                        PcmFormat {
                            sample_rate,
                            channels,
                            sample_format: crate::dsp::PcmSampleFormat::F32,
                        },
                        encoding,
                        block_align,
                    ));
                }
                b"data" => data = Some((chunk_start, chunk_len)),
                _ => {}
            }
            file.seek(SeekFrom::Start(chunk_start + chunk_len + (chunk_len % 2)))?;
        }

        let (format, encoding, block_align) =
            format.ok_or_else(|| EngineError::Decode("WAV file has no fmt chunk".into()))?;
        let (data_start, data_len) =
            data.ok_or_else(|| EngineError::Decode("WAV file has no data chunk".into()))?;
        if data_len % u64::from(block_align) != 0 {
            return Err(EngineError::Decode(
                "WAV data is not aligned to complete frames".into(),
            ));
        }
        file.seek(SeekFrom::Start(data_start))?;
        Ok(Self {
            descriptor: DecoderDescriptor {
                track: media.track.clone(),
                format,
                trim: CodecTrim::default(),
            },
            file,
            data_start,
            data_len,
            data_position: 0,
            encoding,
            block_align,
        })
    }
}

impl Decoder for WavDecoder {
    fn descriptor(&self) -> &DecoderDescriptor {
        &self.descriptor
    }

    fn total_frames(&self) -> u64 {
        self.data_len / u64::from(self.block_align)
    }

    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        let bytes_per_sample = match self.encoding {
            WavEncoding::Pcm16 => 2,
            WavEncoding::Float32 => 4,
        };
        let remaining_samples = ((self.data_len - self.data_position) as usize) / bytes_per_sample;
        let sample_count = remaining_samples.min(output.len());
        if sample_count == 0 {
            return Ok(0);
        }
        let mut bytes = vec![0_u8; sample_count * bytes_per_sample];
        self.file.read_exact(&mut bytes)?;
        for (sample, encoded) in output[..sample_count]
            .iter_mut()
            .zip(bytes.chunks_exact(bytes_per_sample))
        {
            *sample = match self.encoding {
                WavEncoding::Pcm16 => {
                    f32::from(i16::from_le_bytes(encoded.try_into().unwrap())) / 32768.0
                }
                WavEncoding::Float32 => f32::from_le_bytes(encoded.try_into().unwrap()),
            };
        }
        self.data_position += bytes.len() as u64;
        Ok(sample_count)
    }

    fn seek(&mut self, frame: u64) -> Result<()> {
        let byte_offset = frame
            .checked_mul(u64::from(self.block_align))
            .ok_or_else(|| EngineError::InvalidInput("seek frame overflows WAV length".into()))?;
        if byte_offset > self.data_len {
            return Err(EngineError::InvalidInput(
                "seek frame is past the end of the WAV file".into(),
            ));
        }
        self.file
            .seek(SeekFrom::Start(self.data_start + byte_offset))?;
        self.data_position = byte_offset;
        Ok(())
    }
}

struct MemoryDecoder {
    descriptor: DecoderDescriptor,
    samples: Vec<f32>,
    position: usize,
}

impl Decoder for MemoryDecoder {
    fn descriptor(&self) -> &DecoderDescriptor {
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
                EngineError::InvalidInput("seek position overflows audio length".into())
            })?;
        if position > self.samples.len() {
            return Err(EngineError::InvalidInput(
                "seek frame is past the end of the audio file".into(),
            ));
        }
        self.position = position;
        Ok(())
    }
}

struct FlacDecoder(MemoryDecoder);

impl FlacDecoder {
    fn open(media: &TrustedResolvedMedia) -> Result<Self> {
        let mut file = media.handle.try_clone_file()?;
        file.seek(SeekFrom::Start(0))?;
        let mut reader = claxon::FlacReader::new(file)
            .map_err(|error| EngineError::Decode(format!("FLAC: {error}")))?;
        let info = reader.streaminfo();
        let channels = u16::try_from(info.channels)
            .map_err(|_| EngineError::Unsupported("FLAC channel count exceeds u16".into()))?;
        if channels == 0 || info.sample_rate == 0 || !(1..=32).contains(&info.bits_per_sample) {
            return Err(EngineError::Decode("invalid FLAC stream info".into()));
        }
        let scale = 2_f32.powi(info.bits_per_sample as i32 - 1);
        let samples = reader
            .samples()
            .map(|sample| {
                sample
                    .map(|value| value as f32 / scale)
                    .map_err(|error| EngineError::Decode(format!("FLAC: {error}")))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self(MemoryDecoder {
            descriptor: DecoderDescriptor {
                track: media.track.clone(),
                format: PcmFormat {
                    sample_rate: info.sample_rate,
                    channels,
                    sample_format: crate::dsp::PcmSampleFormat::F32,
                },
                trim: CodecTrim::default(),
            },
            samples,
            position: 0,
        }))
    }
}

impl Decoder for FlacDecoder {
    fn descriptor(&self) -> &DecoderDescriptor {
        self.0.descriptor()
    }
    fn total_frames(&self) -> u64 {
        self.0.total_frames()
    }
    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        self.0.read_pcm(output)
    }
    fn seek(&mut self, frame: u64) -> Result<()> {
        self.0.seek(frame)
    }
}

struct Mp3Decoder(MemoryDecoder);

impl Mp3Decoder {
    fn open(media: &TrustedResolvedMedia) -> Result<Self> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_mp3(media)))
            .map_err(|_| EngineError::Decode("MP3 decoder rejected malformed input".into()))?
    }
}

fn decode_mp3(media: &TrustedResolvedMedia) -> Result<Mp3Decoder> {
    use symphonia::core::audio::sample::Sample;
    use symphonia::core::codecs::audio::{well_known::CODEC_ID_MP3, AudioDecoderOptions};
    use symphonia::core::errors::Error as SymphoniaError;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::{FormatOptions, TrackType};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    let mut file = media.handle.try_clone_file()?;
    file.seek(SeekFrom::Start(0))?;
    let source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| EngineError::Decode(format!("MP3 probe: {error}")))?;
    let track_info = format
        .default_track(TrackType::Audio)
        .and_then(|candidate| {
            candidate
                .codec_params
                .as_ref()
                .and_then(|params| params.audio())
                .filter(|params| params.codec == CODEC_ID_MP3)
                .map(|params| (candidate.id, params.clone()))
        })
        .ok_or_else(|| EngineError::Decode("MP3 contains no Layer III audio track".into()))?;
    let (track_id, codec_params) = track_info;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .map_err(|error| EngineError::Decode(format!("MP3 decoder: {error}")))?;
    let mut samples = Vec::new();
    let mut stream_format = None;

    while let Some(packet) = match format.next_packet() {
        Ok(packet) => packet,
        Err(SymphoniaError::IoError(error))
            if error.kind() == std::io::ErrorKind::UnexpectedEof =>
        {
            None
        }
        Err(error) => return Err(EngineError::Decode(format!("MP3 packet: {error}"))),
    } {
        if packet.track_id != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|error| EngineError::Decode(format!("MP3 frame: {error}")))?;
        let spec = decoded.spec();
        let channels = u16::try_from(spec.channels().count())
            .map_err(|_| EngineError::Unsupported("MP3 channel count exceeds u16".into()))?;
        if channels == 0 || spec.rate() == 0 {
            return Err(EngineError::Decode(
                "MP3 stream format contains zero values".into(),
            ));
        }
        let current_format = (spec.rate(), channels);
        if let Some(expected) = stream_format {
            if expected != current_format {
                return Err(EngineError::Unsupported(
                    "MP3 streams that change sample rate or channels are unsupported".into(),
                ));
            }
        } else {
            stream_format = Some(current_format);
        }
        let start = samples.len();
        samples.resize(start + decoded.samples_interleaved(), f32::MID);
        decoded.copy_to_slice_interleaved(&mut samples[start..]);
    }

    let (sample_rate, channels) = stream_format
        .ok_or_else(|| EngineError::Decode("MP3 contains no decodable audio frames".into()))?;
    Ok(Mp3Decoder(MemoryDecoder {
        descriptor: DecoderDescriptor {
            track: media.track.clone(),
            format: PcmFormat {
                sample_rate,
                channels,
                sample_format: crate::dsp::PcmSampleFormat::F32,
            },
            trim: CodecTrim::default(),
        },
        samples,
        position: 0,
    }))
}

impl Decoder for Mp3Decoder {
    fn descriptor(&self) -> &DecoderDescriptor {
        self.0.descriptor()
    }
    fn total_frames(&self) -> u64 {
        self.0.total_frames()
    }
    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        self.0.read_pcm(output)
    }
    fn seek(&mut self, frame: u64) -> Result<()> {
        self.0.seek(frame)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StandbyState {
    Empty,
    DecoderOpened {
        track: Track,
        format: PcmFormat,
        trim: CodecTrim,
    },
    FormatUnified {
        track: Track,
        target_format: PcmFormat,
        trim: CodecTrim,
    },
    Primed {
        track: Track,
        target_format: PcmFormat,
        trim: CodecTrim,
        buffered_frames: usize,
    },
}

impl StandbyState {
    pub fn is_gapless_ready(&self) -> bool {
        matches!(
            self,
            Self::Primed {
                buffered_frames,
                ..
            } if *buffered_frames > 0
        )
    }
}

pub struct GaplessCoordinator {
    output_format: PcmFormat,
    standby: StandbyState,
}

impl GaplessCoordinator {
    pub fn new(output_format: PcmFormat) -> Self {
        Self {
            output_format,
            standby: StandbyState::Empty,
        }
    }

    pub fn standby(&self) -> &StandbyState {
        &self.standby
    }

    pub fn decoder_opened(&mut self, descriptor: DecoderDescriptor) {
        self.standby = StandbyState::DecoderOpened {
            track: descriptor.track,
            format: descriptor.format,
            trim: descriptor.trim,
        };
    }

    pub fn confirm_format_unified(&mut self, target_format: PcmFormat) -> Result<()> {
        if target_format != self.output_format {
            return Err(EngineError::InvalidInput(
                "standby PCM format does not match output format".into(),
            ));
        }
        let (track, trim) = match &self.standby {
            StandbyState::DecoderOpened { track, trim, .. } => (track.clone(), *trim),
            _ => {
                return Err(EngineError::InvalidInput(
                    "standby decoder must be opened before format unification".into(),
                ));
            }
        };
        self.standby = StandbyState::FormatUnified {
            track,
            target_format,
            trim,
        };
        Ok(())
    }

    pub fn mark_primed(&mut self, buffered_frames: usize) -> Result<()> {
        if buffered_frames == 0 {
            return Err(EngineError::InvalidInput(
                "standby ring buffer must contain PCM frames".into(),
            ));
        }
        let (track, target_format, trim) = match &self.standby {
            StandbyState::FormatUnified {
                track,
                target_format,
                trim,
            } => (track.clone(), *target_format, *trim),
            _ => {
                return Err(EngineError::InvalidInput(
                    "standby format must be unified before priming".into(),
                ));
            }
        };
        self.standby = StandbyState::Primed {
            track,
            target_format,
            trim,
            buffered_frames,
        };
        Ok(())
    }

    pub fn take_at_sample_boundary(&mut self) -> Result<StandbyState> {
        if !self.standby.is_gapless_ready() {
            return Err(EngineError::InvalidInput(
                "standby decoder is not gapless ready".into(),
            ));
        }
        Ok(std::mem::replace(&mut self.standby, StandbyState::Empty))
    }

    pub fn invalidate(&mut self) {
        self.standby = StandbyState::Empty;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::PcmSampleFormat;
    use crate::media::MediaHandle;
    use crate::model::{test_item, MediaId, MediaSource};
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    fn format() -> PcmFormat {
        PcmFormat {
            sample_rate: 48_000,
            channels: 2,
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
            MediaHandle::local(File::open(path).unwrap(), path.to_path_buf()),
        )
    }

    fn decode_all(mut decoder: Box<dyn Decoder>) -> Vec<f32> {
        let mut samples = vec![
            0.0;
            decoder.total_frames() as usize
                * usize::from(decoder.descriptor().format.channels)
        ];
        let read = decoder.read_pcm(&mut samples).unwrap();
        samples.truncate(read);
        samples
    }

    fn mp3_fixture() -> Vec<u8> {
        const FRAME_SIZE: usize = 72;
        let mut encoded = Vec::with_capacity(FRAME_SIZE * 8);
        for _ in 0..8 {
            let mut frame = [0_u8; FRAME_SIZE];
            // MPEG-2.5 Layer III, 8 kbps, 8 kHz, mono.
            frame[..4].copy_from_slice(&[0xff, 0xe3, 0x18, 0xc0]);
            encoded.extend_from_slice(&frame);
        }
        encoded
    }

    const FLAC_FIXTURE: &[u8] = &[
        0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22, 0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x12,
        0x00, 0x00, 0x12, 0x0a, 0xc4, 0x40, 0xf0, 0x00, 0x00, 0x00, 0x04, 0x92, 0x75, 0x98, 0xb8,
        0x9c, 0x89, 0xc1, 0x12, 0x9a, 0x15, 0x2e, 0xec, 0xfc, 0x14, 0x07, 0x5e, 0x03, 0x00, 0x00,
        0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x04, 0x84, 0x00, 0x00, 0x28, 0x20, 0x00, 0x00, 0x00, 0x72, 0x65, 0x66,
        0x65, 0x72, 0x65, 0x6e, 0x63, 0x65, 0x20, 0x6c, 0x69, 0x62, 0x46, 0x4c, 0x41, 0x43, 0x20,
        0x31, 0x2e, 0x33, 0x2e, 0x32, 0x20, 0x32, 0x30, 0x31, 0x37, 0x30, 0x31, 0x30, 0x31, 0x00,
        0x00, 0x00, 0x00, 0xff, 0xf8, 0x69, 0x08, 0x00, 0x03, 0x14, 0x40, 0x00, 0x02, 0xb6, 0x4f,
        0x40, 0x02, 0xc2, 0x0c, 0x4b, 0x9d,
    ];

    #[test]
    fn probes_and_decodes_real_mp3_without_using_extension() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("audio.bin");
        fs::write(&path, mp3_fixture()).unwrap();
        let mut decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        assert_eq!(decoder.descriptor().format.sample_rate, 8_000);
        assert_eq!(decoder.descriptor().format.channels, 1);
        assert!(decoder.total_frames() >= 2_304);
        let mut first = [0.0; 32];
        assert_eq!(decoder.read_pcm(&mut first).unwrap(), first.len());
        decoder.seek(1_152).unwrap();
        let mut after_seek = [0.0; 32];
        assert_eq!(decoder.read_pcm(&mut after_seek).unwrap(), after_seek.len());
        assert!(first
            .iter()
            .chain(&after_seek)
            .all(|sample| sample.is_finite()));
    }

    #[test]
    fn malformed_mp3_inputs_return_errors_without_panicking() {
        let directory = tempdir().unwrap();
        let cases = [
            ("truncated.mp3", vec![0xff, 0xe3, 0x18, 0xc0]),
            (
                "oversized-id3.mp3",
                vec![b'I', b'D', b'3', 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f],
            ),
            (
                "corrupt-frame.mp3",
                [vec![0xff, 0xe3, 0x18, 0xc0], vec![0xff; 256]].concat(),
            ),
        ];

        for (name, bytes) in cases {
            let path = directory.path().join(name);
            fs::write(&path, bytes).unwrap();
            let media = trusted_local(&path);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                LocalDecoderFactory.open(&media)
            }));
            assert!(result.is_ok(), "malformed MP3 panicked: {name}");
            assert!(result.unwrap().is_err(), "malformed MP3 opened: {name}");
        }
    }

    #[test]
    fn probes_and_decodes_real_flac_without_using_extension() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("audio.data");
        fs::write(&path, FLAC_FIXTURE).unwrap();
        let mut decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        assert_eq!(decoder.descriptor().format.sample_rate, 44_100);
        assert_eq!(decoder.descriptor().format.channels, 1);
        assert_eq!(decoder.total_frames(), 4);
        assert_eq!(
            decode_all(LocalDecoderFactory.open(&trusted_local(&path)).unwrap()).len(),
            4
        );
        decoder.seek(2).unwrap();
        let mut tail = [0.0; 2];
        assert_eq!(decoder.read_pcm(&mut tail).unwrap(), 2);
    }

    #[test]
    fn content_probe_rejects_aac_and_m4a_explicitly() {
        let directory = tempdir().unwrap();
        for (name, bytes) in [
            ("audio.aac", &[0xff, 0xf1, 0x50, 0x80][..]),
            (
                "audio.m4a",
                &[0, 0, 0, 24, b'f', b't', b'y', b'p', b'M', b'4', b'A', b' '][..],
            ),
        ] {
            let path = directory.path().join(name);
            fs::write(&path, bytes).unwrap();
            let error = match LocalDecoderFactory.open(&trusted_local(&path)) {
                Ok(_) => panic!("AAC/M4A unexpectedly opened"),
                Err(error) => error,
            };
            assert!(
                matches!(error, EngineError::Unsupported(message) if message.contains("AAC/M4A"))
            );
        }
    }

    #[test]
    fn cached_track_is_not_gapless_until_decoder_format_and_pcm_are_ready() {
        let mut coordinator = GaplessCoordinator::new(format());
        assert!(!coordinator.standby().is_gapless_ready());
        coordinator.decoder_opened(DecoderDescriptor {
            track: test_item(1).track,
            format: format(),
            trim: CodecTrim {
                delay_frames: 529,
                padding_frames: 100,
            },
        });
        assert!(!coordinator.standby().is_gapless_ready());
        coordinator.confirm_format_unified(format()).unwrap();
        coordinator.mark_primed(2048).unwrap();
        assert!(coordinator.standby().is_gapless_ready());
        coordinator.take_at_sample_boundary().unwrap();
        assert_eq!(coordinator.standby(), &StandbyState::Empty);
    }

    #[test]
    fn refuses_to_claim_readiness_without_pcm() {
        let mut coordinator = GaplessCoordinator::new(format());
        coordinator.decoder_opened(DecoderDescriptor {
            track: test_item(1).track,
            format: format(),
            trim: CodecTrim::default(),
        });
        coordinator.confirm_format_unified(format()).unwrap();
        assert!(coordinator.mark_primed(0).is_err());
    }
}
