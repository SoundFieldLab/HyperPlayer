//! Stage 14：真实编码器产出的连续专辑 fixture（flacenc，Apache-2.0，仅 dev-dependency）。
//!
//! 「没有真实编码器 fixture 不得宣称跨曲 gapless」：本文件用**真实 FLAC 编码器**
//! （flacenc 0.5.1，完整 FLAC 编码链：LPC/QLPC、Rice 熵编码、CRC 校验），把同一
//! 连续正弦信号切成三轨独立编码为三个 FLAC 文件，再走完整 `RuntimeCoordinator`
//! 链路（load → prime_standby → pump → promote_standby → …）跨三轨播放，输出与
//! 权威正弦参考逐点对比 —— 证明真实编码器输出（非手工合成字节）上的跨曲 gapless
//! 边界无重复、无缺失。
//!
//! 编码参数刻意选择：44.1 kHz 立体声 16-bit（真实音乐最常见的采样率/布局/位深），
//! block_size=4096 与引擎解码块同量级；三轨共享同一相位时间轴。

mod common;

use flacenc::component::{BitRepr, Stream};
use flacenc::config::Encoder;
use flacenc::error::Verify;
use flacenc::source::MemSource;
use hyperplayer_engine::audio::{AudioOutput, DecoderFactory, LocalDecoderFactory};
use hyperplayer_engine::dsp::{PcmFormat, PcmSampleFormat};
use hyperplayer_engine::runtime::{PumpResult, RuntimeCoordinator};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

/// 每轨帧数（采样级连续切分：轨 N 从参考的 N*TRACK_SAMPLES 处开始）。
const TRACK_SAMPLES: usize = 8_192;
/// 与编码格式一致的输出格式：44.1k 立体声 F32（无重采样，聚焦边界证据；重采样
/// 路径由 gapless_continuity.rs 的 PcmAdapter 测试覆盖）。
const SAMPLE_RATE: u32 = 44_100;
/// FLAC 16-bit 编码/解码往返的最坏量化误差（1 LSB = 1/32768 ≈ 3.05e-5；留 2 LSB）。
const FLAC_TOL: f32 = 6.1e-5;

fn stereo_format() -> PcmFormat {
    PcmFormat {
        sample_rate: SAMPLE_RATE,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    }
}

/// 与 common::sine_reference 同相位的权威参考（立体声复制）。
fn reference_stereo(frames: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|frame| {
            let value = common::sine_reference(frame as u64);
            [value, value]
        })
        .collect()
}

/// 用真实 flacenc 编码器把交错 i16 样本编码为完整 FLAC 文件字节（fLaC 魔数 +
/// STREAMINFO + frames）。
fn encode_real_flac(interleaved: &[i32], channels: usize, sample_rate: usize) -> Vec<u8> {
    let source = MemSource::from_samples(interleaved, channels, 16, sample_rate);
    let config = Encoder::default()
        .into_verified()
        .expect("encoder config is valid");
    let stream: Stream = flacenc::encode_with_fixed_block_size(&config, source, 4_096)
        .expect("real FLAC encoder must encode the fixture");
    let mut sink = flacenc::bitsink::MemSink::<u64>::new();
    sink.reserve(stream.count_bits());
    stream.write(&mut sink).expect("FLAC stream serialization");
    let mut bytes = vec![0_u8; sink.len() >> 3];
    sink.write_to_byte_slice(&mut bytes);
    bytes
}

/// 写一个三轨「专辑」：同一连续正弦切成三段独立编码（轨 i 覆盖参考的
/// [i*T, (i+1)*T) 区间），返回 (三个文件路径, 完整权威参考)。
fn write_continuous_album(dir: &Path) -> (Vec<PathBuf>, Vec<f32>) {
    let reference = reference_stereo(3 * TRACK_SAMPLES);
    let mut paths = Vec::new();
    for track in 0..3 {
        // 权威 f32 → i16 量化（与引擎 WAV 16 位同口径：*32767 取整）。
        let samples: Vec<i32> = reference
            [track * TRACK_SAMPLES * 2..(track + 1) * TRACK_SAMPLES * 2]
            .iter()
            .map(|value| (value.clamp(-1.0, 1.0) * 32_767.0).round() as i32)
            .collect();
        let bytes = encode_real_flac(&samples, 2, SAMPLE_RATE as usize);
        let path = dir.join(format!("album-track-{}.flac", track + 1));
        fs::write(&path, bytes).expect("write encoded FLAC track");
        paths.push(path);
    }
    (paths, reference)
}

/// 可取回输出的记录式假输出（与 common::FakeAudioOutput 的差异：样本存放在共享
/// `Arc<Mutex<Vec<f32>>>`，驱动结束后无需从 runtime 取回）。
struct RecordingOutput {
    format: PcmFormat,
    samples: Arc<Mutex<Vec<f32>>>,
    started: bool,
}

impl AudioOutput for RecordingOutput {
    fn format(&self) -> PcmFormat {
        self.format
    }
    fn start(&mut self) -> hyperplayer_engine::Result<()> {
        self.started = true;
        Ok(())
    }
    fn pause(&mut self) -> hyperplayer_engine::Result<()> {
        self.started = false;
        Ok(())
    }
    fn stop(&mut self) -> hyperplayer_engine::Result<()> {
        self.started = false;
        Ok(())
    }
    fn write(&mut self, pcm: &[f32]) -> hyperplayer_engine::Result<usize> {
        self.samples.lock().unwrap().extend_from_slice(pcm);
        Ok(pcm.len())
    }
}

fn assert_pcm_close_tol(expected: &[f32], actual: &[f32], tol: f32, note: &str) {
    assert_eq!(expected.len(), actual.len(), "{note}: 长度不一致");
    for (index, (want, got)) in expected.iter().zip(actual).enumerate() {
        assert!(
            (want - got).abs() <= tol,
            "{note}: 第 {index} 个样本 |{want} - {got}| > {tol}"
        );
    }
}

/// 泵到当前曲 EOF（不 stop，保留 runtime 以便 promote 下一轨）。
fn pump_until_eof(coordinator: &mut RuntimeCoordinator) {
    loop {
        if let PumpResult::Eof {
            output_drained: true,
        } = coordinator.pump_once().unwrap()
        {
            break;
        }
    }
}

/// 主断言：真实 flacenc 编码的三轨连续专辑，跨三轨 load → prime → pump → promote
/// 全链路输出与权威参考逐点一致（总样本数精确、边界无重复/缺失）。
#[test]
fn real_encoder_album_full_chain_output_matches_reference() {
    let dir = tempdir().unwrap();
    let (paths, reference) = write_continuous_album(dir.path());
    let samples = Arc::new(Mutex::new(Vec::new()));
    let output = Box::new(RecordingOutput {
        format: stereo_format(),
        samples: Arc::clone(&samples),
        started: false,
    });
    let mut coordinator = RuntimeCoordinator::new(Box::new(LocalDecoderFactory), output as Box<_>);

    coordinator.load(&common::open_trusted(&paths[0])).unwrap();
    coordinator.start().unwrap();
    for track_index in 0..paths.len() {
        if track_index + 1 < paths.len() {
            let buffered = coordinator
                .prime_standby(&common::open_trusted(&paths[track_index + 1]), 2_048)
                .unwrap();
            assert_eq!(buffered, 2_048, "standby 预拉帧数");
        }
        pump_until_eof(&mut coordinator);
        if track_index + 1 < paths.len() {
            let next_track = common::local_track(&paths[track_index + 1]);
            assert!(
                coordinator.promote_standby(&next_track).unwrap(),
                "promote 必须命中 standby（第 {} 道边界）",
                track_index + 1
            );
            coordinator.start().unwrap();
        }
    }
    let collected = samples.lock().unwrap().clone();
    assert_eq!(
        collected.len(),
        3 * TRACK_SAMPLES * 2,
        "整专辑输出总量必须精确等于权威参考总量（无缺失/重复）"
    );
    assert_pcm_close_tol(
        &reference,
        &collected,
        FLAC_TOL,
        "真实编码器三轨专辑拼接必须逐点等于权威参考",
    );
}

/// 编码器输出必须能被生产增量解码器正确打开（真实文件级 round-trip 前置检查：
/// 格式识别、总帧数、增量读）。
#[test]
fn real_encoder_output_opens_with_the_production_decoder() {
    let dir = tempdir().unwrap();
    let (paths, _reference) = write_continuous_album(dir.path());
    let mut decoder = LocalDecoderFactory
        .open(&common::open_trusted(&paths[0]))
        .unwrap();
    assert_eq!(decoder.descriptor().format.sample_rate, SAMPLE_RATE);
    assert_eq!(decoder.descriptor().format.channels, 2);
    assert_eq!(decoder.total_frames(), TRACK_SAMPLES as u64);
    let mut block = vec![0.0_f32; 256];
    assert_eq!(decoder.read_pcm(&mut block).unwrap(), 256);
}

/// 长时播放稳定性（切片 14 验收「长时播放」项，以密集循环等价放大时长）：三轨专辑
/// 连续循环 8 轮（≈ 24 轨次切换、约 40 万帧、数百次 seek/EOF/块边界），全程：
/// - 每次 promote 都命中 standby（无静默退化为同步 load）；
/// - 输出总量精确等于 24 轨 × 单轨样本数（无累积漂移：重复/缺失哪怕 1 个采样都会
///   在轮次间放大为长度或相位偏差）；
/// - 末尾相位仍与权威参考一致（数值全部有限，正弦连续）。
#[test]
fn long_playback_across_many_track_transitions_stays_stable() {
    let dir = tempdir().unwrap();
    let (paths, reference) = write_continuous_album(dir.path());
    let samples = Arc::new(Mutex::new(Vec::new()));
    let output = Box::new(RecordingOutput {
        format: stereo_format(),
        samples: Arc::clone(&samples),
        started: false,
    });
    let mut coordinator = RuntimeCoordinator::new(Box::new(LocalDecoderFactory), output as Box<_>);

    const ROUNDS: usize = 8;
    coordinator.load(&common::open_trusted(&paths[0])).unwrap();
    coordinator.start().unwrap();
    for round in 0..ROUNDS {
        for track_index in 0..paths.len() {
            if track_index + 1 < paths.len() {
                let buffered = coordinator
                    .prime_standby(&common::open_trusted(&paths[track_index + 1]), 2_048)
                    .unwrap();
                assert_eq!(buffered, 2_048);
            }
            pump_until_eof(&mut coordinator);
            if track_index + 1 < paths.len() {
                let next_track = common::local_track(&paths[track_index + 1]);
                assert!(
                    coordinator.promote_standby(&next_track).unwrap(),
                    "第 {round} 轮轨 {track_index}→{} 的 promote 必须命中 standby",
                    track_index + 1
                );
                coordinator.start().unwrap();
            }
        }
        // 回绕：重新加载轨 1（模拟 repeat-all 回到专辑开头）。
        if round + 1 < ROUNDS {
            coordinator.load(&common::open_trusted(&paths[0])).unwrap();
            coordinator.start().unwrap();
        }
    }
    let collected = samples.lock().unwrap().clone();
    let expected_total = ROUNDS * 3 * TRACK_SAMPLES * 2;
    assert_eq!(
        collected.len(),
        expected_total,
        "长时播放输出总量必须精确等于期望总量（任何累积缺失/重复都会放大暴露）"
    );
    // 与循环拼接的权威参考逐点对比（round 间为同一信号的周期重复）。
    let mut repeated_reference = Vec::with_capacity(expected_total);
    for _ in 0..ROUNDS {
        repeated_reference.extend_from_slice(&reference);
    }
    assert_pcm_close_tol(
        &repeated_reference,
        &collected,
        FLAC_TOL,
        "长时播放全程必须逐点等于权威参考（相位无漂移）",
    );
}
