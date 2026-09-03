//! 音频阶（Stage 14：增量解码 / 真正 gapless）集成测试的通用测试基座。
//!
//! 本模块只提供**与真实代码路径解耦**的测试基建，供 `gapless_backend.rs` 与
//! `gapless_continuity.rs` 复用：
//!
//! - [`ScriptedStream`] + [`FakeDecoder`]：一个可控的假后端解码器状态机，可脚本化
//!   分段吐样本、人为制造欠载（部分返回）、EOF 与 seek，无需真实文件。
//! - [`SlowIoDecoder`]：慢 IO 包装，模拟慢磁盘/网络流出（延迟 + 限长部分返回），
//!   验证解码线程按需返回部分样本而不被永久阻塞。
//! - 权威 PCM 对比助手：给定已知数学信号（正弦/线性斜坡），由真实 `WavDecoder`
//!   增量分段读出并与权威参考序列比对，验证边界无重复、无缺失采样。
//! - [`write_float32_wav`] / [`write_pcm16_wav`]：最小 WAV 编码器，用于在测试里
//!   静态生成已知信号的 fixture。
//! - [`FakeAudioOutput`]：无音频设备的假输出，允许驱动 `RuntimeCoordinator` 的
//!   真实 standby / 格式统一路径而无需 CPAL。
//!
//! 本模块不依赖任何真实输出设备，可在无音频环境运行。
//!
//! 由于该模块被多个独立的集成测试二进制（`gapless_backend`、`gapless_continuity`）
//! 各自以 `mod common;` 整体编译，同一个二进制内未必用到全部工具（例如只管后端语义
//! 的二进制不会用 `FakeAudioOutput`）。故按测试基建惯例在此消除整模块的
//! `dead_code` 告警。
#![allow(dead_code)]

use hyperplayer_engine::audio::{
    AudioOutput, CodecTrim, Decoder, DecoderDescriptor, DecoderFactory, WavDecoderFactory,
};
use hyperplayer_engine::dsp::{PcmFormat, PcmSampleFormat};
use hyperplayer_engine::error::Result;
use hyperplayer_engine::media::{MediaHandle, TrustedResolvedMedia};
use hyperplayer_engine::model::{MediaId, MediaSource, Track};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 用于测试的标准采样率。
pub const SAMPLE_RATE: u32 = 44_100;
/// 正弦测试频率（Hz）。
pub const SINE_FREQ: f32 = 440.0;
/// 权威比较的默认容差。
pub const DEFAULT_TOL: f32 = 1e-5;

// ---------------------------------------------------------------------------
// 权威数学信号
// ---------------------------------------------------------------------------

/// 正弦在给定帧索引处的权威参考值。
pub fn sine_reference(frame: u64) -> f32 {
    (2.0 * std::f32::consts::PI * SINE_FREQ * frame as f32 / SAMPLE_RATE as f32).sin()
}

/// 线性斜坡（单调递增，用于刻度精确性验证）在给定帧索引处的值。
pub fn ramp_reference(frame: u64) -> f32 {
    // 映射到 [-0.8, 0.8]，随帧稳定增长。
    -0.8 + (frame as f32 / (SAMPLE_RATE as f32 * 0.5)) * 1.6
}

/// 生成单声道正弦样本序列（len == frame_count）。
pub fn sine_signal(frames: usize) -> Vec<f32> {
    (0..frames as u64).map(sine_reference).collect()
}

/// 生成单声道线性斜坡样本序列（len == frame_count）。
pub fn ramp_signal(frames: usize) -> Vec<f32> {
    (0..frames as u64).map(ramp_reference).collect()
}

// ---------------------------------------------------------------------------
// Track / TrustedResolvedMedia 构造（外部集成测试无法访问 crate 私有 test_item）
// ---------------------------------------------------------------------------

/// 依据本地路径构造一条本地 Track。
pub fn local_track(path: &Path) -> Track {
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

/// 依据已打开的 File 与路径构造可信解析媒体。
pub fn trusted_local(path: &Path, file: File) -> TrustedResolvedMedia {
    TrustedResolvedMedia::new(
        local_track(path),
        MediaHandle::local(file, path.to_path_buf()),
    )
}

/// 从磁盘打开并包装为可信解析媒体。
pub fn open_trusted(path: &Path) -> TrustedResolvedMedia {
    trusted_local(
        path,
        File::open(path)
            .unwrap_or_else(|error| panic!("打开 fixture {} 失败: {error}", path.display())),
    )
}

// ---------------------------------------------------------------------------
// 受控假后端状态机
// ---------------------------------------------------------------------------

/// 一份受控样本流：内存中的已知信号 + 模拟欠载/EOF 的读写状态机。
///
/// - `max_out_per_call` 非 0 时，`read` 每次最多吐这么多样本，模拟解码线程按需
///   返回部分样本（欠载/慢读）。
/// - 读尽后返回 0（EOF）。
/// - `seek_frame` 按帧复位，清除 EOF 状态，用于验证 seek 后欠载状态复位。
pub struct ScriptedStream {
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
    position: usize,
    max_out_per_call: usize,
    eof_reached: bool,
}

impl ScriptedStream {
    /// 用已知样本序列构造（len 必须为 channels 的整数倍）。
    pub fn new(samples: Vec<f32>, channels: u16, sample_rate: u32) -> Self {
        assert!(
            samples.len().is_multiple_of(channels as usize),
            "样本数必须是声道数的整数倍"
        );
        Self {
            samples,
            channels,
            sample_rate,
            position: 0,
            max_out_per_call: 0,
            eof_reached: false,
        }
    }

    /// 构造单声道正弦流。
    pub fn sine(frames: usize) -> Self {
        Self::new(sine_signal(frames), 1, SAMPLE_RATE)
    }

    /// 设置每次读的最大采样数（>0 模拟欠载/慢读，0 = 不限）。
    pub fn set_max_out_per_call(&mut self, n: usize) {
        self.max_out_per_call = n;
    }

    /// 当前是否已越过 EOF。
    pub fn eof_reached(&self) -> bool {
        self.eof_reached
    }

    pub fn total_frames(&self) -> u64 {
        (self.samples.len() / self.channels as usize) as u64
    }

    /// 请求最多 `output.len()` 个样本，返回实际读取数；末尾返回 0。
    pub fn read(&mut self, output: &mut [f32]) -> Result<usize> {
        let available = self.samples.len() - self.position;
        let cap = if self.max_out_per_call == 0 {
            available
        } else {
            available.min(self.max_out_per_call)
        };
        let count = cap.min(output.len());
        if count == 0 {
            self.eof_reached = true;
            return Ok(0);
        }
        output[..count].copy_from_slice(&self.samples[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }

    /// 按帧 seek；越界报 [`hyperplayer_engine::EngineError::InvalidInput`]。
    pub fn seek_frame(&mut self, frame: u64) -> Result<()> {
        let pos = frame
            .checked_mul(u64::from(self.channels))
            .and_then(|s| usize::try_from(s).ok())
            .ok_or_else(|| hyperplayer_engine::EngineError::InvalidInput("seek 位置溢出".into()))?;
        if pos > self.samples.len() {
            return Err(hyperplayer_engine::EngineError::InvalidInput(
                "seek 帧越过流末尾".into(),
            ));
        }
        self.position = pos;
        // seek 后复位 EOF 与欠载状态。
        self.eof_reached = false;
        Ok(())
    }
}

/// 可控假后端解码器：包装 [`ScriptedStream`] 并实现引擎 `Decoder` trait。
pub struct FakeDecoder {
    stream: ScriptedStream,
    descriptor: DecoderDescriptor,
}

impl FakeDecoder {
    /// 用脚本化样本流构造假解码器。
    pub fn new(stream: ScriptedStream, track: Track) -> Self {
        let descriptor = DecoderDescriptor {
            track,
            format: PcmFormat {
                sample_rate: stream.sample_rate,
                channels: stream.channels,
                sample_format: PcmSampleFormat::F32,
            },
            trim: CodecTrim::default(),
        };
        Self { stream, descriptor }
    }

    /// 用单声道正弦 + 本地 track 快速构造。
    pub fn sine_tracked(frames: usize, path: &Path) -> Self {
        Self::new(ScriptedStream::sine(frames), local_track(path))
    }

    pub fn stream(&mut self) -> &mut ScriptedStream {
        &mut self.stream
    }
}

impl Decoder for FakeDecoder {
    fn descriptor(&self) -> &DecoderDescriptor {
        &self.descriptor
    }

    fn total_frames(&self) -> u64 {
        self.stream.total_frames()
    }

    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        self.stream.read(output)
    }

    fn seek(&mut self, frame: u64) -> Result<()> {
        self.stream.seek_frame(frame)
    }
}

// ---------------------------------------------------------------------------
// 慢 IO 包装
// ---------------------------------------------------------------------------

/// 慢 IO 解码器包装：每读一次先 sleep 一段时间，并可限制每次返回的样本数
/// （模拟慢磁盘/网络流出）。验证解码线程会以部分样本增量推进而不被永久阻塞。
pub struct SlowIoDecoder {
    inner: Box<dyn Decoder>,
    delay: Duration,
    max_out: Option<usize>,
}

impl SlowIoDecoder {
    /// `delay`：每次 `read_pcm` 前的阻塞时长；`max_out`：每次最多返回的样本数。
    pub fn new(inner: Box<dyn Decoder>, delay: Duration, max_out: Option<usize>) -> Self {
        Self {
            inner,
            delay,
            max_out,
        }
    }
}

impl Decoder for SlowIoDecoder {
    fn descriptor(&self) -> &DecoderDescriptor {
        self.inner.descriptor()
    }

    fn total_frames(&self) -> u64 {
        self.inner.total_frames()
    }

    fn read_pcm(&mut self, output: &mut [f32]) -> Result<usize> {
        std::thread::sleep(self.delay);
        match self.max_out {
            Some(limit) => {
                let limit = limit.min(output.len());
                let mut tmp = vec![0.0; limit];
                let read = self.inner.read_pcm(&mut tmp)?;
                output[..read].copy_from_slice(&tmp[..read]);
                Ok(read)
            }
            None => self.inner.read_pcm(output),
        }
    }

    fn seek(&mut self, frame: u64) -> Result<()> {
        self.inner.seek(frame)
    }
}

// ---------------------------------------------------------------------------
// 权威 PCM 对比助手
// ---------------------------------------------------------------------------

/// 断言实际样本序列与权威参考在容差内逐点相等（无缺失、无重复、无多白）。
pub fn assert_pcm_close(expected: &[f32], actual: &[f32], note: &str) {
    assert_pcm_close_tol(expected, actual, DEFAULT_TOL, note);
}

/// 同上，但允许显式指定容差（例如 16 位 PCM 的量化误差需要更宽容差）。
pub fn assert_pcm_close_tol(expected: &[f32], actual: &[f32], tol: f32, note: &str) {
    assert_eq!(
        expected.len(),
        actual.len(),
        "{note}: 长度不一致（预期 {}，实际 {}）",
        expected.len(),
        actual.len()
    );
    for (index, (want, got)) in expected.iter().zip(actual).enumerate() {
        let delta = (want - got).abs();
        assert!(
            delta <= tol,
            "{note}: 样本 {index} 不一致：期望 {want}，实际 {got}，误差 {delta}"
        );
    }
}

/// 把若干段解码器按顺序拼成一个「无裁剪保持」的样本流（模拟 gapless 分段拼接）。
/// 返回逐段一览（每段的 len 会记录），供调用方与一次性权威参考比对是否在
/// 拼接边界无重复/缺失。
pub fn concat_blocks(decoders: Vec<Box<dyn Decoder>>) -> Vec<f32> {
    let mut out = Vec::new();
    for mut decoder in decoders {
        let channels = usize::from(decoder.descriptor().format.channels);
        let mut buf = vec![0.0; 4096 * channels];
        loop {
            let read = decoder.read_pcm(&mut buf).expect("增量读取必须成功");
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read]);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 最小 WAV 编码器（测试静态生成已知信号 fixture）
// ---------------------------------------------------------------------------

/// 写最小 32 位浮点 RIFF/WAVE 到 `path`。样本为交错布局。
pub fn write_float32_wav(path: &Path, samples: &[f32], channels: u16, sample_rate: u32) {
    assert!(channels > 0);
    assert!(samples.len().is_multiple_of(channels as usize));
    let data_len = samples.len() as u32 * 4;
    let byte_rate = sample_rate * u32::from(channels) * 4;
    let block_align = channels * 4;

    let pad = if data_len % 2 == 1 { 1 } else { 0 };
    let mut bytes = Vec::with_capacity(44 + data_len as usize + pad);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&block_align.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes.extend(std::iter::repeat_n(0, pad));
    let mut file =
        File::create(path).unwrap_or_else(|e| panic!("创建 WAV {} 失败: {e}", path.display()));
    file.write_all(&bytes)
        .unwrap_or_else(|e| panic!("写入 WAV {} 失败: {e}", path.display()));
}

/// 写最小 16 位 PCM RIFF/WAVE 到 `path`。样本为交错布局，[-1,1] 映射到 i16。
pub fn write_pcm16_wav(path: &Path, samples: &[f32], channels: u16, sample_rate: u32) {
    assert!(channels > 0);
    assert!(samples.len().is_multiple_of(channels as usize));
    let data_len = samples.len() as u32 * 2;
    let byte_rate = sample_rate * u32::from(channels) * 2;
    let block_align = channels * 2;

    let pad = if data_len % 2 == 1 { 1 } else { 0 };
    let mut bytes = Vec::with_capacity(44 + data_len as usize + pad);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&block_align.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend(std::iter::repeat_n(0, pad));
    let mut file =
        File::create(path).unwrap_or_else(|e| panic!("创建 WAV {} 失败: {e}", path.display()));
    file.write_all(&bytes)
        .unwrap_or_else(|e| panic!("写入 WAV {} 失败: {e}", path.display()));
}

/// 用单一连续数学信号生成两个「连续区块」的 WAV fixture：
/// 区块 A 覆盖帧 [0, split)，区块 B 覆盖帧 [split, 2*split)，二者拼接即完整信号
/// （两条 WAV 之间在采样层面严格连续，无 gap / 无重复）。返回 (A 路径, B 路径, 完整参考)。
pub fn write_continuous_blocks(
    directory: &Path,
    split: usize,
    reverse: bool,
) -> (PathBuf, PathBuf, Vec<f32>) {
    let total_frames = split * 2;
    let reference = sine_signal(total_frames);
    let (a, b) = if reverse {
        (reference[split..].to_vec(), reference[..split].to_vec())
    } else {
        (reference[..split].to_vec(), reference[split..].to_vec())
    };
    let path_a = directory.join("block_a.wav");
    let path_b = directory.join("block_b.wav");
    write_float32_wav(&path_a, &a, 1, SAMPLE_RATE);
    write_float32_wav(&path_b, &b, 1, SAMPLE_RATE);
    (path_a, path_b, reference)
}

// ---------------------------------------------------------------------------
// 假音频输出（无设备环境）
// ---------------------------------------------------------------------------

/// 无音频设备的假输出：记录写入的 PCM，`start/pause/stop` 均为无操作成功。
pub struct FakeAudioOutput {
    format: PcmFormat,
    started: bool,
    written: Vec<f32>,
    failed: bool,
}

impl FakeAudioOutput {
    pub fn new(format: PcmFormat) -> Self {
        Self {
            format,
            started: false,
            written: Vec::new(),
            failed: false,
        }
    }

    pub fn written(&self) -> &[f32] {
        &self.written
    }

    pub fn fail_next(&mut self) {
        self.failed = true;
    }
}

impl AudioOutput for FakeAudioOutput {
    fn format(&self) -> PcmFormat {
        self.format
    }

    fn start(&mut self) -> Result<()> {
        self.started = true;
        Ok(())
    }

    fn pause(&mut self) -> Result<()> {
        self.started = false;
        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        self.started = false;
        Ok(())
    }

    fn write(&mut self, interleaved_pcm: &[f32]) -> Result<usize> {
        if self.failed {
            self.failed = false;
            return Err(hyperplayer_engine::EngineError::AudioBackend(
                "fake output failed by test".into(),
            ));
        }
        if !self.started {
            return Err(hyperplayer_engine::EngineError::AudioBackend(
                "fake audio output is stopped".into(),
            ));
        }
        if !interleaved_pcm
            .len()
            .is_multiple_of(self.format.channels as usize)
        {
            return Err(hyperplayer_engine::EngineError::InvalidInput(
                "fake output requires complete frames".into(),
            ));
        }
        self.written.extend_from_slice(interleaved_pcm);
        Ok(interleaved_pcm.len())
    }

    fn check_health(&self) -> Result<()> {
        Ok(())
    }

    fn buffered_samples(&self) -> usize {
        0
    }
}

/// 一次性打开 `path` 的 WAV 并返回解码器。
pub fn open_wav_decoder(path: &Path) -> Box<dyn Decoder> {
    WavDecoderFactory
        .open(&open_trusted(path))
        .unwrap_or_else(|e| panic!("打开 WAV {} 失败: {e}", path.display()))
}

/// 返回能够打开类型为 `path` 的媒体文件的本地解码器。
pub fn open_local_decoder(path: &Path) -> Box<dyn Decoder> {
    use hyperplayer_engine::audio::LocalDecoderFactory;
    LocalDecoderFactory
        .open(&open_trusted(path))
        .unwrap_or_else(|e| panic!("打开 {} 失败: {e}", path.display()))
}
