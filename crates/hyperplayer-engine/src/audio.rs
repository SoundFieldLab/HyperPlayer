use crate::dsp::PcmFormat;
use crate::error::{EngineError, Result};
use crate::media::TrustedResolvedMedia;
use crate::model::Track;
use crossbeam_queue::ArrayQueue;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use symphonia::core::codecs::audio::well_known::CODEC_ID_FLAC;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, RawValue};
use symphonia::core::units::Timestamp;

pub const PLAYABLE_LOCAL_EXTENSIONS: &[&str] = &["wav", "flac", "mp3"];

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
    /// 复制一个独立工厂实例：preparation worker 与 runtime 各持一份打开 decoder 的
    /// 能力（worker 在 actor 控制路径之外执行 open/probe）。
    fn clone_factory(&self) -> Box<dyn DecoderFactory>;
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

    fn clone_factory(&self) -> Box<dyn DecoderFactory> {
        Box::new(*self)
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
    fn check_health(&self) -> Result<()> {
        Ok(())
    }
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

fn render_output_callback(
    ring: &ArrayQueue<[f32; 2]>,
    volume_bits: &AtomicU32,
    output: &mut [f32],
) {
    let volume = f32::from_bits(volume_bits.load(Ordering::Relaxed));
    let (frames, remainder) = output.as_chunks_mut::<2>();
    for frame in frames {
        let [left, right] = ring.pop().unwrap_or([0.0, 0.0]);
        frame[0] = left * volume;
        frame[1] = right * volume;
    }
    remainder.fill(0.0);
}

fn select_output_sample_rate(ranges: &[(u32, u32)], default_rate: u32) -> Option<u32> {
    for preferred in [default_rate, 48_000] {
        if ranges
            .iter()
            .any(|(minimum, maximum)| (*minimum..=*maximum).contains(&preferred))
        {
            return Some(preferred);
        }
    }
    ranges
        .iter()
        .flat_map(|(minimum, maximum)| [*minimum, *maximum])
        .min_by_key(|rate| rate.abs_diff(default_rate))
}

pub struct CpalAudioOutput {
    format: PcmFormat,
    ring: Arc<ArrayQueue<[f32; 2]>>,
    volume_bits: Arc<AtomicU32>,
    stream_failed: Arc<AtomicBool>,
    stopped: bool,
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
        let default_rate = device
            .default_output_config()
            .map_err(audio_backend)?
            .sample_rate();
        let ranges = device
            .supported_output_configs()
            .map_err(audio_backend)?
            .filter(|range| {
                range.channels() == 2 && range.sample_format() == cpal::SampleFormat::F32
            })
            .map(|range| (range.min_sample_rate(), range.max_sample_rate()))
            .collect::<Vec<_>>();
        let sample_rate = select_output_sample_rate(&ranges, default_rate).ok_or_else(|| {
            EngineError::Unsupported("output device has no stereo F32 format".into())
        })?;
        let format = PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: crate::dsp::PcmSampleFormat::F32,
        };

        let ring = Arc::new(ArrayQueue::new(capacity_frames));
        let callback_ring = Arc::clone(&ring);
        let volume_bits = Arc::new(AtomicU32::new(1.0_f32.to_bits()));
        let callback_volume = Arc::clone(&volume_bits);
        let stream_failed = Arc::new(AtomicBool::new(false));
        let callback_failed = Arc::clone(&stream_failed);
        let config = cpal::StreamConfig {
            channels: format.channels,
            sample_rate: format.sample_rate,
            buffer_size: cpal::BufferSize::Default,
        };
        let stream = device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    render_output_callback(&callback_ring, &callback_volume, data);
                },
                move |_error| {
                    callback_failed.store(true, Ordering::Release);
                },
                None,
            )
            .map_err(audio_backend)?;
        Ok(Self {
            format,
            ring,
            volume_bits,
            stream_failed,
            stopped: true,
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
        self.stream.play().map_err(audio_backend)?;
        self.stopped = false;
        Ok(())
    }

    fn pause(&mut self) -> Result<()> {
        use cpal::traits::StreamTrait;
        self.stream.pause().map_err(audio_backend)
    }

    fn stop(&mut self) -> Result<()> {
        use cpal::traits::StreamTrait;
        self.stream.pause().map_err(audio_backend)?;
        while self.ring.pop().is_some() {}
        self.stopped = true;
        Ok(())
    }

    fn write(&mut self, interleaved_pcm: &[f32]) -> Result<usize> {
        self.check_health()?;
        if self.stopped {
            return Err(EngineError::AudioBackend("audio output is stopped".into()));
        }
        if !interleaved_pcm.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "audio output requires complete stereo frames".into(),
            ));
        }
        let mut written = 0;
        for frame in interleaved_pcm.as_chunks::<2>().0 {
            if self.ring.push([frame[0], frame[1]]).is_err() {
                break;
            }
            written += 2;
        }
        Ok(written)
    }

    fn check_health(&self) -> Result<()> {
        if self.stream_failed.swap(false, Ordering::AcqRel) {
            Err(EngineError::AudioBackend(
                "audio output stream failed".into(),
            ))
        } else {
            Ok(())
        }
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
        self.ring.len().saturating_mul(2)
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

    fn clone_factory(&self) -> Box<dyn DecoderFactory> {
        Box::new(*self)
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
    read_buffer: Vec<u8>,
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
            read_buffer: Vec::new(),
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
        let byte_count = sample_count * bytes_per_sample;
        self.read_buffer.resize(byte_count, 0);
        self.file.read_exact(&mut self.read_buffer)?;
        for (sample, encoded) in output[..sample_count]
            .iter_mut()
            .zip(self.read_buffer.chunks_exact(bytes_per_sample))
        {
            *sample = match self.encoding {
                WavEncoding::Pcm16 => {
                    f32::from(i16::from_le_bytes(encoded.try_into().unwrap())) / 32768.0
                }
                WavEncoding::Float32 => f32::from_le_bytes(encoded.try_into().unwrap()),
            };
        }
        self.data_position += byte_count as u64;
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

/// 基于 symphonia 的**真增量** FLAC 解码器。
///
/// 与旧的 `MemoryDecoder` 一次性把整首 FLAC 解成 `Vec<f32>` 不同，本实现自持一个
/// symphonia 解码头（`MediaSourceStream` + probe + `AudioDecoder`），`read_pcm` 只按需
/// 逐 packet/block 增量拉取，永远不把整曲驻留内存。`seek` 通过 symphonia 的
/// `FormatReader::seek` 重新定位到采样边界后继续增量拉取。
///
/// 语义约定（与 `runtime.rs` 现有 gapless 模型一致）：
/// - `total_frames()` 返回**原始**可解码帧总数（含 encoder delay/padding）；
///   `runtime.rs` 会以 `total_frames − delay − padding` 计算 playable 帧数。
/// - `read_pcm` 返回**原始**交错 PCM；`runtime.rs` 根据 `CodecTrim` 在其 `seek(delay)`
///   起点与 `playable_frames` 终点处裁剪 delay/padding。
/// - `seek(frame)` 的 `frame` 是**原始**流帧序号（`runtime.rs` 传入 `delay + frame`）。
///   trim 读数如实放进 `descriptor().trim`，由上层统一应用，避免在解码器内二次裁剪
///   造成 playable 帧数与 seek 偏移双重扣除。
struct FlacDecoder {
    descriptor: DecoderDescriptor,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    channels: u16,
    sample_rate: u32,
    raw_total: u64,
    raw_position: u64,
    skip_frames: u64,
    block: Vec<f32>,
    block_offset: usize,
    eof: bool,
}

impl FlacDecoder {
    fn open(media: &TrustedResolvedMedia) -> Result<Self> {
        // 与 MP3 一致：畸形输入在解开头不 panic，转为 Decode 错误。
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            FlacDecoder::open_inner(media)
        }))
        .map_err(|_| EngineError::Decode("FLAC decoder rejected malformed input".into()))?
    }

    fn open_inner(media: &TrustedResolvedMedia) -> Result<Self> {
        let mut file = media.handle.try_clone_file()?;
        file.seek(SeekFrom::Start(0))?;
        let source = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        hint.with_extension("flac");
        let mut format = symphonia::default::get_probe()
            .probe(
                &hint,
                source,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|error| EngineError::Decode(format!("FLAC probe: {error}")))?;
        let track = format
            .default_track(TrackType::Audio)
            .and_then(|candidate| {
                candidate
                    .codec_params
                    .as_ref()
                    .and_then(|params| params.audio())
                    .filter(|params| params.codec == CODEC_ID_FLAC)
                    .map(|_| candidate)
            })
            .ok_or_else(|| EngineError::Decode("FLAC contains no audio track".into()))?;
        let track_id = track.id;
        let codec_params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .cloned()
            .ok_or_else(|| EngineError::Decode("FLAC codec parameters are missing".into()))?;
        let sample_rate = codec_params
            .sample_rate
            .ok_or_else(|| EngineError::Decode("FLAC sample rate is unknown".into()))?;
        let channels = u16::try_from(
            codec_params
                .channels
                .as_ref()
                .map(|channels| channels.count())
                .ok_or_else(|| EngineError::Decode("FLAC channels are unknown".into()))?,
        )
        .map_err(|_| EngineError::Unsupported("FLAC channel count exceeds u16".into()))?;
        if channels == 0 || sample_rate == 0 {
            return Err(EngineError::Decode(
                "FLAC stream info contains zero values".into(),
            ));
        }

        // 读取 gapless trim。symphonia 0.6 的 FLAC 轨道头不携带 delay/padding（该字段仅
        // 有 LAME gaugeless 的 MP3 会填充，FLAC 通常为 None），此时回退读取 Vorbis Comment
        // 私有 tag `ENCODER_DELAY` / `ENCODER_PADDING`（若存在），否则保持默认 0。
        let header_delay = track.delay.unwrap_or(0);
        let header_padding = track.padding.unwrap_or(0);
        let num_frames = track.num_frames;
        let trim = FlacDecoder::read_flac_trim(format.as_mut(), header_delay, header_padding);

        let mut decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
            .map_err(|error| EngineError::Decode(format!("FLAC decoder: {error}")))?;

        // 无声道/未知时长的文件：整流转一圈计数原始帧（不驻留内存），再回到起点，
        // 使 `total_frames()` 仍能返回整曲可解码帧数（streaminfo 已知时跳过扫描）。
        let raw_total = match num_frames {
            Some(n) if n > 0 => n,
            _ => {
                let mut count = 0_u64;
                loop {
                    let packet = match format.next_packet() {
                        Ok(Some(packet)) => packet,
                        Ok(None) => break,
                        Err(SymphoniaError::IoError(error))
                            if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                        {
                            break;
                        }
                        Err(error) => {
                            return Err(EngineError::Decode(format!("FLAC scan packet: {error}")))
                        }
                    };
                    if packet.track_id != track_id {
                        continue;
                    }
                    let decoded = decoder.decode(&packet).map_err(|error| {
                        EngineError::Decode(format!("FLAC scan frame: {error}"))
                    })?;
                    count += decoded.frames() as u64;
                }
                decoder.reset();
                format
                    .seek(
                        SeekMode::Accurate,
                        SeekTo::Timestamp {
                            ts: Timestamp::new(0),
                            track_id,
                        },
                    )
                    .map_err(|error| EngineError::Decode(format!("FLAC scan rewind: {error}")))?;
                count
            }
        };

        Ok(Self {
            descriptor: DecoderDescriptor {
                track: media.track.clone(),
                format: PcmFormat {
                    sample_rate,
                    channels,
                    sample_format: crate::dsp::PcmSampleFormat::F32,
                },
                trim,
            },
            format,
            decoder,
            track_id,
            channels,
            sample_rate,
            raw_total,
            raw_position: 0,
            skip_frames: 0,
            block: Vec::new(),
            block_offset: 0,
            eof: false,
        })
    }

    /// 从轨道头与 Vorbis Comment 私有 tag 读取 encoder delay/padding（读不到为 0）。
    fn read_flac_trim(
        format: &mut dyn FormatReader,
        header_delay: u32,
        header_padding: u32,
    ) -> CodecTrim {
        let mut delay = header_delay;
        let mut padding = header_padding;
        if delay == 0 || padding == 0 {
            if let Some(revision) = format.metadata().current() {
                for tag in &revision.media.tags {
                    let key = tag.raw.key.to_ascii_lowercase();
                    if delay == 0 && (key == "encoder_delay" || key == "encodedelay") {
                        if let RawValue::String(value) = &tag.raw.value {
                            delay = value.trim().parse().unwrap_or(0);
                        }
                    } else if padding == 0 && (key == "encoder_padding" || key == "encoderpadding")
                    {
                        if let RawValue::String(value) = &tag.raw.value {
                            padding = value.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
        }
        CodecTrim {
            delay_frames: delay,
            padding_frames: padding,
        }
    }

    /// 真实增量拉取：解出下一 packet/block 的样本到 `block`，返回是否有新样本。
    fn pull(&mut self) -> Result<bool> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => {
                    self.eof = true;
                    return Ok(false);
                }
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.eof = true;
                    return Ok(false);
                }
                Err(error) => return Err(EngineError::Decode(format!("FLAC packet: {error}"))),
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let decoded = self
                .decoder
                .decode(&packet)
                .map_err(|error| EngineError::Decode(format!("FLAC frame: {error}")))?;
            let spec = decoded.spec();
            let current = (spec.rate(), spec.channels().count());
            let expected = (self.sample_rate, usize::from(self.channels));
            if current != expected {
                return Err(EngineError::Unsupported(
                    "FLAC streams that change sample rate or channels are unsupported".into(),
                ));
            }
            let frames = decoded.frames();
            if frames == 0 {
                continue;
            }
            let channels = usize::from(self.channels);
            // seek 后丢弃定位 packet 前导的 `skip_frames` 帧，达到采样级精确。
            let skip_u64 = self.skip_frames.min(frames as u64);
            let skip = skip_u64 as usize;
            self.skip_frames -= skip_u64;
            if skip >= frames {
                continue;
            }
            // `copy_to_slice_interleaved` 会整块写入（不可写子块），故复制整包后仅偏移游标，
            // 前导 `skip` 帧由 `block_offset` 跳过，尾随帧仍按原始语义交由 `read_pcm` 全量交付。
            let all_samples = decoded.samples_interleaved();
            if self.block.len() < all_samples {
                self.block.resize(all_samples, 0.0);
            } else {
                self.block.truncate(all_samples);
            }
            decoded.copy_to_slice_interleaved::<f32, _>(&mut self.block[..all_samples]);
            self.block_offset = skip * channels;
            return Ok(true);
        }
    }

    /// 增量 seek：重新定位解码器，使下一次 `read_pcm` 从 `frame`（原始流帧号）开始。
    fn seek_inner(&mut self, frame: u64) -> Result<()> {
        let frame = frame.min(self.raw_total);
        if frame == self.raw_total {
            // seek 到流末（runtime 在 padding=0 时会到达此处）：直接短路进入 eof 态，
            // 避免 demuxer 对「恰好等于流末的 ts」报 OutOfRange。
            self.decoder.reset();
            self.raw_position = self.raw_total;
            self.skip_frames = 0;
            self.block.clear();
            self.block_offset = 0;
            self.eof = true;
            return Ok(());
        }
        self.decoder.reset();
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Timestamp {
                    ts: Timestamp::new(frame.min(u64::from(u32::MAX)) as i64),
                    track_id: self.track_id,
                },
            )
            .map_err(|error| EngineError::Decode(format!("FLAC seek: {error}")))?;
        let actual = u64::try_from(seeked.actual_ts.get()).unwrap_or(0);
        self.raw_position = frame;
        self.skip_frames = frame.saturating_sub(actual);
        self.block.clear();
        self.block_offset = 0;
        self.eof = false;
        Ok(())
    }
}

impl Decoder for FlacDecoder {
    fn descriptor(&self) -> &DecoderDescriptor {
        &self.descriptor
    }

    fn total_frames(&self) -> u64 {
        self.raw_total
    }

    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        let channels = usize::from(self.channels);
        // 只交付完整帧（runtime.rs 拒绝不完整的 PCM 帧）。
        let max_samples = output.len() - output.len() % channels;
        if max_samples == 0 {
            return Ok(0);
        }
        let mut written = 0;
        while written < max_samples {
            if self.block_offset >= self.block.len() {
                if self.eof {
                    break;
                }
                if !self.pull()? {
                    self.eof = true;
                    break;
                }
            }
            let available = &self.block[self.block_offset..];
            let count = available.len().min(max_samples - written);
            output[written..written + count].copy_from_slice(&available[..count]);
            written += count;
            self.block_offset += count;
            self.raw_position += (count / channels) as u64;
        }
        Ok(written)
    }

    fn seek(&mut self, frame: u64) -> Result<()> {
        self.seek_inner(frame)
    }
}

/// 真增量 MP3 解码器（raw 时间轴契约）。
///
/// 与旧实现（`open` 时把整首 MP3 一次解成 `Vec<f32>` 常驻内存）不同，本解码器在 `open`
/// 只做 probe、构建解码器、解析头部元数据（Xing/Info/LAME 的 encoder delay / padding 与
/// 帧数），然后**立即返回**，不解音频主体。`read_pcm` 按需逐 packet 增量拉取，仅把当前
/// 帧暂存到内部一帧缓冲；`seek` 经 demuxer 精确定位到包含目标帧的参考帧（demuxer 自带
/// bit reservoir 预热回退），帧内偏差由解码侧逐采样 skip 补齐；`total_frames` 返回整曲
/// raw 帧数。全程不整包常驻内存。
///
/// 语义约定（与 FLAC / WAV 及 `runtime.rs` 的统一 gapless 模型一致，均为 raw 时间轴）：
/// - `total_frames()` 返回**原始**可解码帧总数（含 encoder delay/padding）；
///   `runtime.rs` 以 `total − delay − padding` 计算 playable 帧数。
/// - `read_pcm` 返回**原始**交错 PCM（首部 delay 段与尾部 padding 段原样交付，由
///   `runtime.rs` 统一裁剪）；`seek(frame)` 的 `frame` 是**原始**流帧号。
/// - Xing/Info/LAME 头解析出的 `enc_delay` / `enc_padding`（单位为每声道一个 sample）
///   只如实上报到 `descriptor().trim`。为避免双重裁剪，解码器以 `gapless(false)` 打开，
///   关闭 symphonia 的包级 trim（其默认开启）。
/// - demuxer 时间轴从 `-delay` 开始（raw 帧 0 对应 ts = `-delay`），故 `seek(raw)` 映射为
///   `ts = raw − delay`；MP3 seek 只能落到参考帧边界（`actual_ts ≤ required_ts`），帧内
///   偏差由 `skip_frames` 在解码块内逐采样补齐。
struct Mp3Decoder {
    descriptor: DecoderDescriptor,
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::audio::AudioDecoder>,
    track_id: u32,
    /// encoder delay（samples）：raw 帧号与 demuxer ts 的偏移（ts = raw − delay）。
    delay_frames: u32,
    /// raw 总帧数（含 delay/padding；`total − delay − padding` 才是可播放帧数）。
    raw_total: u64,
    /// seek 落点在帧内时的前导跳过帧数（采样级精确定位）。
    skip_frames: u64,
    frame_buf: Vec<f32>,
    frame_samples: usize,
    frame_pos: usize,
    eof: bool,
}

impl Mp3Decoder {
    fn open(media: &TrustedResolvedMedia) -> Result<Self> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_mp3(media)))
            .map_err(|_| EngineError::Decode("MP3 decoder rejected malformed input".into()))?
    }
}

/// 从 symphonia format reader 拉取下一个音频包；把流尾的 `UnexpectedEof` 归一化为 `Ok(None)`。
fn next_mp3_packet(
    format: &mut Box<dyn symphonia::core::formats::FormatReader>,
) -> Result<Option<symphonia::core::packet::Packet>> {
    match format.next_packet() {
        Ok(packet) => Ok(packet),
        Err(SymphoniaError::IoError(error))
            if error.kind() == std::io::ErrorKind::UnexpectedEof =>
        {
            // MPEG 流没有确定的结尾，读到流尾视为正常结束。
            Ok(None)
        }
        Err(error) => Err(EngineError::Decode(format!("MP3 packet: {error}"))),
    }
}

fn decode_mp3(media: &TrustedResolvedMedia) -> Result<Mp3Decoder> {
    use symphonia::core::codecs::audio::well_known::CODEC_ID_MP3;

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

    // 以 gapless(false) 打开：关闭 symphonia 的包级 trim（默认开启会逐样本裁掉首帧 delay
    // 与尾帧 padding），使本解码器交付 raw PCM，delay/padding 只上报到 descriptor().trim，
    // 由 runtime.rs 统一裁剪，避免双重扣除。
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(
            &codec_params,
            &AudioDecoderOptions::default().gapless(false),
        )
        .map_err(|error| EngineError::Decode(format!("MP3 decoder: {error}")))?;

    // 读取 Xing/Info/LAME 头解析出的 delay / padding（samples）。注意 demuxer 对 Xing 文件
    // 已把 `num_frames` 归一化为「已减 delay + padding」的可播放帧数（无 LAME 时 delay/padding
    // 为 0，num_frames 即 raw），故 raw 总帧数 = num_frames + delay + padding。此处仅拷出标量，
    // 避免 `track` 持有对 `format` 的借用而阻塞后续逐包扫描。
    let (delay_frames, padding_frames, known_frames) = format
        .tracks()
        .iter()
        .find(|track| track.id == track_id)
        .map(|track| {
            (
                track.delay.unwrap_or(0),
                track.padding.unwrap_or(0),
                track.num_frames,
            )
        })
        .ok_or_else(|| EngineError::Decode("MP3 audio track disappeared".into()))?;

    // 增量解码第一个非空音频包以确定采样率 / 声道数，同时验证流确实可解码（拒绝完全无法解码
    // 的畸形流，保持既有 malformed 测试语义）。该包样本暂存，供 `read_pcm` 从 raw 帧 0 继续
    // 输出。注意：demuxer 已把 Xing/Info 头帧剔除，`next_packet` 返回的首帧就是第一个音频帧。
    let mut stream_format = None;
    let mut first_samples = 0;
    let mut first_buf = Vec::new();
    while stream_format.is_none() {
        let packet = match next_mp3_packet(&mut format)? {
            Some(packet) => packet,
            None => break,
        };
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
        if decoded.samples_interleaved() == 0 {
            // 防御：完全空的首帧（gapless=false 下不应出现）——继续找下一个非空帧确定格式。
            continue;
        }
        stream_format = Some((channels, spec.rate()));
        first_samples = decoded.samples_interleaved();
        first_buf.resize(first_samples, 0.0);
        decoded.copy_to_slice_interleaved(&mut first_buf);
    }
    let (channels, sample_rate) = stream_format
        .ok_or_else(|| EngineError::Decode("MP3 contains no decodable audio frames".into()))?;

    // raw 总帧数：有 Xing/Info/VBRI/CBR 估计时由 num_frames + delay + padding 反推；完全拿不到
    // （不可 seek 或无头）时做一轮「解码即弃」扫描统计 raw 帧（样本不驻留内存），再回退到
    // 曲首（ts = -delay），使 `total_frames()` 对无头文件也有意义。
    let raw_total = match known_frames {
        Some(known) => {
            // num_frames 是已减 delay+padding 的可播放帧数；饱和加回得到 raw 近似。
            known
                .saturating_add(u64::from(delay_frames))
                .saturating_add(u64::from(padding_frames))
        }
        None => {
            let mut total_samples = first_samples as u64;
            while let Some(packet) = next_mp3_packet(&mut format)? {
                if packet.track_id != track_id {
                    continue;
                }
                let decoded = decoder
                    .decode(&packet)
                    .map_err(|error| EngineError::Decode(format!("MP3 frame: {error}")))?;
                total_samples += u64::try_from(decoded.samples_interleaved())
                    .map_err(|_| EngineError::Decode("MP3 sample count overflow".into()))?;
            }
            let count = total_samples / u64::from(channels);
            // 扫描已把解码头推到流尾：重置解码器并回退到曲首（raw 帧 0 ↔ ts = -delay）。
            decoder.reset();
            format
                .seek(
                    SeekMode::Accurate,
                    SeekTo::Timestamp {
                        ts: Timestamp::from(-i64::from(delay_frames)),
                        track_id,
                    },
                )
                .map_err(|error| EngineError::Decode(format!("MP3 scan rewind: {error}")))?;
            first_samples = 0;
            first_buf.clear();
            count
        }
    };

    Ok(Mp3Decoder {
        descriptor: DecoderDescriptor {
            track: media.track.clone(),
            format: PcmFormat {
                sample_rate,
                channels,
                sample_format: crate::dsp::PcmSampleFormat::F32,
            },
            trim: CodecTrim {
                delay_frames,
                padding_frames,
            },
        },
        format,
        decoder,
        track_id,
        delay_frames,
        raw_total,
        skip_frames: 0,
        frame_buf: first_buf,
        frame_samples: first_samples,
        frame_pos: 0,
        eof: false,
    })
}

impl Decoder for Mp3Decoder {
    fn descriptor(&self) -> &DecoderDescriptor {
        &self.descriptor
    }

    fn total_frames(&self) -> u64 {
        // raw 总帧数（含 encoder delay/padding）；runtime.rs 以 total − delay − padding
        // 计算 playable。
        self.raw_total
    }

    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        let channels = usize::from(self.descriptor.format.channels);
        if output.is_empty() {
            return Ok(0);
        }
        let mut written = 0;
        while written < output.len() {
            // 先排空上一次已解码到暂存的一帧。
            if self.frame_pos < self.frame_samples {
                let take = (self.frame_samples - self.frame_pos).min(output.len() - written);
                output[written..written + take]
                    .copy_from_slice(&self.frame_buf[self.frame_pos..self.frame_pos + take]);
                self.frame_pos += take;
                written += take;
                continue;
            }
            if self.eof {
                break;
            }
            // 增量拉取下一个 packet，只解码一帧到内部暂存，不整包常驻内存。
            let packet = match next_mp3_packet(&mut self.format)? {
                Some(packet) => packet,
                None => {
                    self.eof = true;
                    break;
                }
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let decoded = self
                .decoder
                .decode(&packet)
                .map_err(|error| EngineError::Decode(format!("MP3 frame: {error}")))?;
            let spec = decoded.spec();
            let current_channels = spec.channels().count();
            if current_channels != channels || spec.rate() != self.descriptor.format.sample_rate {
                // MP3 中途改变采样率 / 声道数：与既有语义一致地明确拒绝。
                return Err(EngineError::Unsupported(
                    "MP3 streams that change sample rate or channels are unsupported".into(),
                ));
            }
            let samples = decoded.samples_interleaved();
            if samples == 0 {
                continue;
            }
            if samples > self.frame_buf.len() {
                self.frame_buf.resize(samples, 0.0);
            }
            decoded.copy_to_slice_interleaved(&mut self.frame_buf[..samples]);
            self.frame_samples = samples;
            self.frame_pos = 0;
            // seek 落点在帧内时：跳过目标帧之前的整段前导采样（采样级精确定位）。
            // demuxer 只能落到参考帧边界（actual_ts ≤ required_ts，含 bit reservoir 预热
            // 回退），帧内偏差在此逐样本补齐。
            if self.skip_frames > 0 {
                let block_frames = (samples / channels) as u64;
                let skip = self.skip_frames.min(block_frames);
                self.skip_frames -= skip;
                self.frame_pos = skip as usize * channels;
                if self.frame_pos >= self.frame_samples {
                    // 整块都被跳过：继续拉下一个 packet。
                    continue;
                }
            }
        }
        Ok(written)
    }

    fn seek(&mut self, frame: u64) -> Result<()> {
        // raw 帧号映射回 demuxer 时间轴：ts = raw − delay（raw 帧 0 ↔ ts = -delay，即可
        // 播放时间轴的 0 点）。runtime.rs 按 raw 契约传入 `delay + frame`，映射后恰好落在
        // 裁剪后时间轴的 frame 处。
        let frame = frame.min(self.raw_total);
        if frame == self.raw_total {
            // seek 到流末（runtime 在 padding=0 时 `seek(delay + playable)` 会到达此处）：
            // demuxer 无法 seek 到恰好等于流末的 ts（其循环会越过最后一帧撞 EOF 报
            // OutOfRange），故直接短路进入 eof 态，read_pcm 返回 0。
            self.decoder.reset();
            self.frame_pos = self.frame_samples;
            self.frame_samples = 0;
            self.skip_frames = 0;
            self.eof = true;
            return Ok(());
        }
        let ts = i64::try_from(frame)
            .ok()
            .and_then(|raw| raw.checked_sub(i64::from(self.delay_frames)))
            .ok_or_else(|| EngineError::InvalidInput("seek frame overflows MP3 timeline".into()))?;
        self.decoder.reset();
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Timestamp {
                    ts: Timestamp::from(ts),
                    track_id: self.track_id,
                },
            )
            .map_err(|error| EngineError::Decode(format!("MP3 seek: {error}")))?;
        // 实际落点是参考帧边界（含 reservoir 预热），与目标的帧内差记为 skip，由 read_pcm
        // 在解码块内逐采样补齐。
        let delta = ts.saturating_sub(seeked.actual_ts.get());
        self.skip_frames = u64::try_from(delta).unwrap_or(0);
        // 丢弃暂存帧并复位 eof：下一次 read_pcm 从新位置重新增量拉取。
        self.frame_pos = self.frame_samples;
        self.frame_samples = 0;
        self.eof = false;
        Ok(())
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
    fn output_callback_drains_lock_free_ring_and_zero_fills_underrun() {
        let ring = ArrayQueue::new(2);
        ring.push([0.5, -0.25]).unwrap();
        let volume = AtomicU32::new(0.5_f32.to_bits());
        let mut output = [9.0_f32; 4];

        render_output_callback(&ring, &volume, &mut output);

        assert_eq!(output, [0.25, -0.125, 0.0, 0.0]);
        assert!(ring.is_empty());
    }

    #[test]
    fn output_callback_zero_fills_an_incomplete_device_buffer_tail() {
        let ring = ArrayQueue::new(1);
        ring.push([0.5, -0.25]).unwrap();
        let volume = AtomicU32::new(1.0_f32.to_bits());
        let mut output = [9.0_f32; 3];

        render_output_callback(&ring, &volume, &mut output);

        assert_eq!(output, [0.5, -0.25, 0.0]);
        assert!(ring.is_empty());
    }

    #[test]
    fn output_format_prefers_default_then_48khz_then_nearest_boundary() {
        assert_eq!(
            select_output_sample_rate(&[(44_100, 96_000)], 44_100),
            Some(44_100)
        );
        assert_eq!(
            select_output_sample_rate(&[(48_000, 48_000)], 44_100),
            Some(48_000)
        );
        assert_eq!(
            select_output_sample_rate(&[(32_000, 32_000), (96_000, 96_000)], 44_100),
            Some(32_000)
        );
        assert_eq!(select_output_sample_rate(&[], 48_000), None);
    }

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

    /// 构造一个带 Xing + LAME 头的真实小 MP3：第一个 72B 帧是 Xing/Info + LAME 扩展，
    /// 后跟 `n_audio` 个 72B 全零音频帧（MPEG-2.5 Layer III / 8 kHz / mono / 576 采样/帧）。
    /// 与 `mp3_fixture` 一致，Xing 帧本身不计入 `num_frames`。
    fn mp3_xing_fixture(n_audio: usize, enc_delay: u32, enc_padding: u32) -> Vec<u8> {
        const FRAME_SIZE: usize = 72;
        const HEADER: [u8; 4] = [0xff, 0xe3, 0x18, 0xc0];
        let mut encoded = Vec::with_capacity(FRAME_SIZE * (1 + n_audio));

        // ---- Xing + LAME 帧 ----
        let mut xing = [0_u8; FRAME_SIZE];
        xing[..4].copy_from_slice(&HEADER);
        // MPEG-2.5 mono 的 side info 为 9B，必须全零，Xing 头紧随其后（offset = 4 + 9 = 13）。
        xing[13..17].copy_from_slice(b"Xing");
        // flags：只声明存在 num_frames。
        xing[17..21].copy_from_slice(&[0, 0, 0, 1]);
        // num_frames（大端）：音频（非 Xing）帧数。
        xing[21..25].copy_from_slice(&(n_audio as u32).to_be_bytes());
        // ---- LAME 扩展（从偏移 25 起，至少 24B 核心）----
        xing[25..34].copy_from_slice(b"LAME3.99r");
        // revision / lowpass 全 0；replaygain_peak / radio / audiophile / encoding_flags / abr 全 0。
        // trim（24-bit u24）：symphonia 按 delay = 529 + (trim >> 12)、
        // padding = (trim & 0xFFF).saturating_sub(529) 反推 enc_delay / enc_padding。
        let delay_msb: u32 = enc_delay.saturating_sub(529);
        let pad_low: u32 = enc_padding.saturating_add(529);
        let trim24 = (delay_msb << 12) | pad_low;
        xing[46..49].copy_from_slice(&[(trim24 >> 16) as u8, (trim24 >> 8) as u8, trim24 as u8]);
        // 其余扩展字段（misc / gain / surround / music_len / music_crc / tag_crc）保持 0：
        // tag_crc=0 即忽略 CRC。剩余补零填满 72B。
        encoded.extend_from_slice(&xing);

        // ---- 后跟 n_audio 个音频帧 ----
        for _ in 0..n_audio {
            let mut frame = [0_u8; FRAME_SIZE];
            frame[..4].copy_from_slice(&HEADER);
            encoded.extend_from_slice(&frame);
        }
        encoded
    }

    #[test]
    fn incremental_pull_matches_oneshot_and_seek_is_continuous() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("incr.mp3");
        fs::write(&path, mp3_fixture()).unwrap();
        let channels = usize::from(
            LocalDecoderFactory
                .open(&trusted_local(&path))
                .unwrap()
                .descriptor()
                .format
                .channels,
        );
        // 一次性读完整曲。
        let mut decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        let total = decoder.total_frames();
        assert!(total >= 2_304);
        let mut whole = vec![0.0; total as usize * channels];
        let read = decoder.read_pcm(&mut whole).unwrap();
        whole.truncate(read);

        // 小段增量拉取：序列应与一次性读一致，结尾返回 0。
        let mut decoder2 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        let mut incremental = Vec::new();
        let mut chunk = [0.0; 100];
        loop {
            let n = decoder2.read_pcm(&mut chunk).unwrap();
            incremental.extend_from_slice(&chunk[..n]);
            if n == 0 {
                break;
            }
        }
        assert_eq!(incremental, whole);

        // seek 后连续：seek(1152) 后读出的样本应等于从头逢 1152 处的区段。
        let mut decoder3 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        let skip = 1_152;
        decoder3.seek(skip).unwrap();
        let mut after = [0.0; 64];
        let n = decoder3.read_pcm(&mut after).unwrap();
        let expected_start = (skip as usize) * channels;
        let expected = &whole[expected_start..expected_start + n];
        assert_eq!(&after[..n], expected);
        assert!(after[..n].iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn mp3_seek_to_non_frame_aligned_position_keeps_exact_sample_accounting() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("misaligned.mp3");
        // delay=676（= 576 + 100，非 576 的整数倍）使 runtime 的 seek(delay) 落在帧内，
        // 必须依赖 demuxer actual_ts 差值 + 解码块内逐样本 skip 精确定位。
        const AUDIO_FRAMES: usize = 8;
        const DELAY: u32 = 676;
        fs::write(&path, mp3_xing_fixture(AUDIO_FRAMES, DELAY, 47)).unwrap();

        let raw_total = AUDIO_FRAMES as u64 * 576;
        for position in [0_u64, 100, 576, 676, 1_500, raw_total] {
            let mut decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
            decoder.seek(position).unwrap();
            // 位置记账：从 position 读到流尾，总样本数必须恰好等于 raw_total − position。
            // skip 多跳或少跳一个采样都会使剩余计数偏离。
            let mut remaining = Vec::new();
            let mut chunk = [0.0; 333];
            loop {
                let n = decoder.read_pcm(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                remaining.extend_from_slice(&chunk[..n]);
            }
            assert_eq!(
                remaining.len() as u64,
                raw_total - position,
                "seek({position}) 后剩余样本数必须精确等于 raw_total − position"
            );
        }

        // 流末 seek 后再 seek 回中部仍可继续增量读出（eof 可复位、skip 重新计算）。
        let mut decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        decoder.seek(raw_total).unwrap();
        decoder.seek(1_000).unwrap();
        let mut resumed = Vec::new();
        let mut chunk = [0.0; 333];
        loop {
            let n = decoder.read_pcm(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            resumed.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(resumed.len() as u64, raw_total - 1_000);
    }

    #[test]
    fn applies_xing_lame_gapless_trim_at_sample_boundary() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("xing.mp3");
        const AUDIO_FRAMES: usize = 8;
        const DELAY: u32 = 576;
        const PADDING: u32 = 47;
        fs::write(&path, mp3_xing_fixture(AUDIO_FRAMES, DELAY, PADDING)).unwrap();

        let decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        // 读到 Xing/LAME 的 enc_delay / enc_padding。
        assert_eq!(decoder.descriptor().trim.delay_frames, DELAY);
        assert_eq!(decoder.descriptor().trim.padding_frames, PADDING);
        // raw 总帧数含 delay/padding（runtime 以 total − delay − padding 计算 playable）。
        let raw_total = AUDIO_FRAMES as u64 * 576;
        assert_eq!(decoder.total_frames(), raw_total);

        // raw 全量解码返回全部样本（trim 未在解码层应用，由 runtime 统一裁剪）。
        let raw = decode_all(LocalDecoderFactory.open(&trusted_local(&path)).unwrap());
        assert_eq!(raw.len(), raw_total as usize);

        // 按 runtime.rs 的 gapless 模型应用 trim：playable = total − delay − padding；
        // seek(delay) 后读到 playable 个样本，逐采样等于 raw 去掉首 delay 段与尾 padding 段。
        let playable = raw_total - u64::from(DELAY) - u64::from(PADDING);
        let mut decoder2 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        decoder2.seek(u64::from(DELAY)).unwrap();
        let mut trimmed = vec![0.0; playable as usize];
        assert_eq!(decoder2.read_pcm(&mut trimmed).unwrap(), playable as usize);
        assert_eq!(
            trimmed,
            raw[DELAY as usize..(DELAY as usize + playable as usize)]
        );
        // raw 契约：padding 段仍可继续读出（裁剪是 runtime 的职责，不是解码器的），
        // 恰好读完 padding 个样本后流才真正结束。
        let mut padding_tail = vec![0.0; PADDING as usize];
        assert_eq!(
            decoder2.read_pcm(&mut padding_tail).unwrap(),
            PADDING as usize
        );
        assert_eq!(padding_tail, raw[(DELAY as usize + playable as usize)..]);
        let mut extra = [0.0; 8];
        assert_eq!(decoder2.read_pcm(&mut extra).unwrap(), 0);
    }

    #[test]
    fn mp3_without_gapless_metadata_defaults_to_no_trim() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("no-trim.mp3");
        fs::write(&path, mp3_fixture()).unwrap();
        let mut decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        assert_eq!(decoder.descriptor().trim.delay_frames, 0);
        assert_eq!(decoder.descriptor().trim.padding_frames, 0);
        let mut buffer = [0.0; 16];
        assert_eq!(decoder.read_pcm(&mut buffer).unwrap(), 16);
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

    /// 在 `FLAC_FIXTURE` 的 STREAMINFO 之后插入一个带 `ENCODER_DELAY` / `ENCODER_PADDING`
    /// Vorbis Comment 元数据块，构造带 gapless 元数据的小 FLAC fixture。
    fn flac_fixture_with_delay_padding(delay: u32, padding: u32) -> Vec<u8> {
        // 仅复用 fixture 的开头：`fLaC` 标记 + STREAMINFO 块（其 is_last=false）。
        // 不整体复用 `FLAC_FIXTURE[..frame]`，否则会把 fixture 自带的 is_last=true 元数据块
        // 一并带上，导致其后插入的 Vorbis Comment 块不会被 symphonia 解析。
        let streaminfo_end = 4 + 4 + 34;
        let frame_start = FLAC_FIXTURE
            .windows(2)
            .position(|w| w[0] == 0xff && w[1] == 0xf8)
            .expect("FLAC fixture contains an audio frame");
        let mut out = FLAC_FIXTURE[..streaminfo_end].to_vec();

        // Vorbis Comment 块体：vendor 串 + comments 计数 + “KEY=VALUE” 注释。
        let vendor = b"hyperplayer-test";
        let comment1 = format!("ENCODER_DELAY={delay}");
        let comment2 = format!("ENCODER_PADDING={padding}");
        let mut body = Vec::new();
        body.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        body.extend_from_slice(vendor);
        body.extend_from_slice(&2_u32.to_le_bytes());
        for comment in [&comment1, &comment2] {
            body.extend_from_slice(&(comment.len() as u32).to_le_bytes());
            body.extend_from_slice(comment.as_bytes());
        }

        // 元数据块头：type=4（VORBIS_COMMENT），is_last=1；其后为 3 字节大端长度。
        out.push(0x80 | 4);
        out.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
        out.extend_from_slice(&body);
        out.extend_from_slice(&FLAC_FIXTURE[frame_start..]);
        out
    }

    #[test]
    fn flac_incremental_pull_matches_oneshot_and_seek_is_continuous() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("incr.data");
        fs::write(&path, FLAC_FIXTURE).unwrap();

        // 一次性读完整曲作为基准（mono，原始 4 帧）。
        let mut decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        let mut whole = vec![0.0; decoder.total_frames() as usize];
        let read = decoder.read_pcm(&mut whole).unwrap();
        whole.truncate(read);
        assert_eq!(whole.len(), 4);

        // 逐采样增量拉取：序列应与一次性读一致，且读到真正的末尾返回 0。
        let mut decoder2 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        let mut incremental = Vec::new();
        let mut chunk = [0.0; 1];
        loop {
            let n = decoder2.read_pcm(&mut chunk).unwrap();
            incremental.extend_from_slice(&chunk[..n]);
            if n == 0 {
                break;
            }
        }
        assert_eq!(incremental, whole);

        // seek 到中部（原始帧 2）后读出的样本应与整曲对应位置连续。
        let mut decoder3 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        decoder3.seek(2).unwrap();
        let mut after = [0.0; 3];
        let n = decoder3.read_pcm(&mut after).unwrap();
        assert_eq!(n, 2);
        assert_eq!(&after[..n], &whole[2..4]);
        // 已到流尾：继续读返回 0。
        assert_eq!(decoder3.read_pcm(&mut after).unwrap(), 0);

        // 流末 / 越界 seek 的位置记账：seek(raw_total) 与 seek(超出) 后剩余样本数为 0
        // 且不报错（runtime 在 padding=0 时 seek(delay + playable) 会到达流末）。
        let mut decoder4 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        decoder4.seek(4).unwrap();
        assert_eq!(decoder4.read_pcm(&mut after).unwrap(), 0);
        let mut decoder5 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        decoder5.seek(999).unwrap();
        assert_eq!(decoder5.read_pcm(&mut after).unwrap(), 0);
        // 流末 seek 后再 seek 回中部仍可继续增量读出（eof 可复位）。
        let mut decoder6 = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        decoder6.seek(4).unwrap();
        decoder6.seek(1).unwrap();
        let mut resumed = [0.0; 3];
        let n = decoder6.read_pcm(&mut resumed).unwrap();
        assert_eq!(n, 3);
        assert_eq!(&resumed[..n], &whole[1..4]);
    }

    #[test]
    fn flac_applies_vorbis_comment_delay_and_padding_trim() {
        let directory = tempdir().unwrap();
        let trimmed_path = directory.path().join("trim.data");
        fs::write(&trimmed_path, flac_fixture_with_delay_padding(1, 1)).unwrap();

        // 先从无 gapless 元数据的同一 fixture 全量读出原始帧序列作为逐采样基准。
        let plain_path = directory.path().join("plain.data");
        fs::write(&plain_path, FLAC_FIXTURE).unwrap();
        let raw = decode_all(
            LocalDecoderFactory
                .open(&trusted_local(&plain_path))
                .unwrap(),
        );
        assert_eq!(raw.len(), 4);

        // 读到 Vorbis Comment 的 ENCODER_DELAY / ENCODER_PADDING。
        let decoder = LocalDecoderFactory
            .open(&trusted_local(&trimmed_path))
            .unwrap();
        assert_eq!(decoder.descriptor().trim.delay_frames, 1);
        assert_eq!(decoder.descriptor().trim.padding_frames, 1);
        // 原始总计仍为 4（trim 交上层 runtime 应用）。
        assert_eq!(decoder.total_frames(), 4);

        // 按 runtime.rs 的 gapless 模型应用 trim：可播放 = total − delay − padding；
        // seek(delay) 后读到 playable 个样本，逐采样等于原始帧去掉首尾 delay/padding。
        let mut decoder = decoder;
        decoder.seek(1).unwrap();
        let playable = 2;
        let mut trimmed = vec![0.0; playable];
        assert_eq!(decoder.read_pcm(&mut trimmed).unwrap(), playable);
        assert_eq!(trimmed, raw[1..3]);
    }

    #[test]
    fn flac_without_gapless_metadata_defaults_to_zero_trim() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("no-trim.data");
        fs::write(&path, FLAC_FIXTURE).unwrap();
        let decoder = LocalDecoderFactory.open(&trusted_local(&path)).unwrap();
        assert_eq!(decoder.descriptor().trim.delay_frames, 0);
        assert_eq!(decoder.descriptor().trim.padding_frames, 0);
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
