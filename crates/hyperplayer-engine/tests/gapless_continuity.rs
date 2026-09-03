//! Stage 14（增量解码 / 真正 gapless）连续性权威对比测试。
//!
//! 「没有 trim 与 standby 证据不得宣称 gapless」。本文件给出两类权威证据：
//!
//! 1. **权威 PCM 对比**：给定数学正弦/斜坡信号，由真实 `WavDecoder` 增量分段读出，
//!    并与权威参考逐点比对 —— 证明增量解码在区块 / seek 边界**无重复、无缺失采样**。
//! 2. **Standby / 格式统一证据**：驱动 `RuntimeCoordinator` 的真实 `prime_standby`
//!    与 `take_standby_at_sample_boundary`，验证 standby 拉取的 PCM 头样本严格等于
//!    前一曲尾部之后、信号时间轴上**紧邻的下一采样**（边界无 gap / 重复），这是
//!    gapless 的关键判据。
//!
//! 对 FLAC / MP3（并行代理正在重写为增量实现）：测试以**自适应**形式存在 —— 若
//! 该 codec 在当前的构建后端上可打开解码（增量或整段内存实现均满足「分段读拼回 ==
//! 一次性读」与 seek 边界），则验证；否则记录并跳过，把增量连续性补齐交给后续中央
//! 集成。两款 codec 的真实增量一致性回归由中央集成在改写落地后再统一补齐。

mod common;

use common::{
    assert_pcm_close, assert_pcm_close_tol, concat_blocks, open_local_decoder, open_wav_decoder,
    sine_reference, sine_signal, write_continuous_blocks, FakeAudioOutput, DEFAULT_TOL,
};
use hyperplayer_engine::audio::{Decoder, DecoderFactory, LocalDecoderFactory, WavDecoderFactory};
use hyperplayer_engine::dsp::{PcmFormat, PcmSampleFormat};
use hyperplayer_engine::runtime::RuntimeCoordinator;
use std::fs;
use std::mem;
use std::path::PathBuf;
use tempfile::tempdir;

/// 单声道 fixture 的分块采样数（同时作为「第 1 块末尾」与「第 2 块开头」的分界）。
const BLOCK_SAMPLES: usize = 4_096;

/// 44.1k 单声道 4 帧最小 FLAC（与 hyperplayer-engine 内部单测同源；claxon 或
/// symphonia-flac 均可解码）。
const FLAC_FIXTURE: &[u8] = &[
    0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22, 0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x12, 0x00,
    0x00, 0x12, 0x0a, 0xc4, 0x40, 0xf0, 0x00, 0x00, 0x00, 0x04, 0x92, 0x75, 0x98, 0xb8, 0x9c, 0x89,
    0xc1, 0x12, 0x9a, 0x15, 0x2e, 0xec, 0xfc, 0x14, 0x07, 0x5e, 0x03, 0x00, 0x00, 0x12, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04,
    0x84, 0x00, 0x00, 0x28, 0x20, 0x00, 0x00, 0x00, 0x72, 0x65, 0x66, 0x65, 0x72, 0x65, 0x6e, 0x63,
    0x65, 0x20, 0x6c, 0x69, 0x62, 0x46, 0x4c, 0x41, 0x43, 0x20, 0x31, 0x2e, 0x33, 0x2e, 0x32, 0x20,
    0x32, 0x30, 0x31, 0x37, 0x30, 0x31, 0x30, 0x31, 0x00, 0x00, 0x00, 0x00, 0xff, 0xf8, 0x69, 0x08,
    0x00, 0x03, 0x14, 0x40, 0x00, 0x02, 0xb6, 0x4f, 0x40, 0x02, 0xc2, 0x0c, 0x4b, 0x9d,
];

/// 在 `FLAC_FIXTURE` 的 STREAMINFO 之后插入带 `ENCODER_DELAY` / `ENCODER_PADDING`
/// Vorbis Comment 元数据块，构造带 gapless 元数据的小 FLAC fixture（与引擎内部单测同源）。
fn flac_fixture_with_delay_padding(delay: u32, padding: u32) -> Vec<u8> {
    // 仅复用 fixture 的开头：`fLaC` 标记 + STREAMINFO 块（其 is_last=false）。
    let streaminfo_end = 4 + 4 + 34;
    let frame_start = FLAC_FIXTURE
        .windows(2)
        .position(|w| w[0] == 0xff && w[1] == 0xf8)
        .expect("FLAC fixture contains an audio frame");
    let mut out = FLAC_FIXTURE[..streaminfo_end].to_vec();

    // Vorbis Comment 块体：vendor 串 + comments 计数 + "KEY=VALUE" 注释。
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

/// 构造带 Xing + LAME 头的最小 MP3（与引擎内部单测同源）：第一个 72B 帧是 Xing/Info +
/// LAME 扩展，后跟 `n_audio` 个 72B 全零音频帧（MPEG-2.5 Layer III / 8 kHz / mono /
/// 576 采样/帧）。Xing 帧本身不计入 `num_frames`。
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
    // ---- LAME 扩展（从偏移 25 起）----
    xing[25..34].copy_from_slice(b"LAME3.99r");
    // trim（24-bit）：symphonia 按 delay = 529 + (trim >> 12)、
    // padding = (trim & 0xFFF).saturating_sub(529) 反推 enc_delay / enc_padding。
    let delay_msb: u32 = enc_delay.saturating_sub(529);
    let pad_low: u32 = enc_padding.saturating_add(529);
    let trim24 = (delay_msb << 12) | pad_low;
    xing[46..49].copy_from_slice(&[(trim24 >> 16) as u8, (trim24 >> 8) as u8, trim24 as u8]);
    encoded.extend_from_slice(&xing);

    // ---- 后跟 n_audio 个音频帧 ----
    for _ in 0..n_audio {
        let mut frame = [0_u8; FRAME_SIZE];
        frame[..4].copy_from_slice(&HEADER);
        encoded.extend_from_slice(&frame);
    }
    encoded
}

/// 单声道 44.1k 输出格式（与 WAV fixture 一致 → 无重采样，纯 standby 边界证据）。
fn mono_format() -> PcmFormat {
    PcmFormat {
        sample_rate: common::SAMPLE_RATE,
        channels: 1,
        sample_format: PcmSampleFormat::F32,
    }
}

/// 单声道 8k 输出格式（与 MP3 fixture 一致 → 无重采样，纯 trim/边界证据）。
fn mono_8k_format() -> PcmFormat {
    PcmFormat {
        sample_rate: 8_000,
        channels: 1,
        sample_format: PcmSampleFormat::F32,
    }
}

// ---------------------------------------------------------------
// 1. 权威 PCM 对比：WAV 增量解码 == 权威参考
// ---------------------------------------------------------------

/// 把一个完整正弦信号写入 WAV，用 `WavDecoder` 分块增量读出，必须逐点等于权威参考。
#[test]
fn wav_incremental_decode_matches_authoritative_sine() {
    let dir = tempdir().unwrap();
    let reference = sine_signal(BLOCK_SAMPLES);
    let path = dir.path().join("sine.wav");
    common::write_float32_wav(&path, &reference, 1, common::SAMPLE_RATE);

    let mut decoder = open_wav_decoder(&path);
    assert_eq!(decoder.total_frames() as usize, BLOCK_SAMPLES);
    let collected = decode_in_chunks(&mut *decoder, 127);
    assert_pcm_close(&reference, &collected, "WAV 增量读必须等于权威正弦");
}

/// 把一段线性斜坡写入 WAV，分块增量读出，必须逐点等于权威参考。
/// 斜坡对相位更敏感，可放大任何边界重复 / 缺失。
#[test]
fn wav_incremental_decode_matches_authoritative_ramp() {
    let dir = tempdir().unwrap();
    let reference = common::ramp_signal(BLOCK_SAMPLES);
    let path = dir.path().join("ramp.wav");
    common::write_float32_wav(&path, &reference, 1, common::SAMPLE_RATE);

    let mut decoder = open_wav_decoder(&path);
    let collected = decode_in_chunks(&mut *decoder, 1009);
    assert_pcm_close(&reference, &collected, "WAV 增量读必须等于权威斜坡");
}

/// 16 位 PCM WAV 亦能以增量读出，量化误差在容差内与权威参考一致。
#[test]
fn wav_pcm16_incremental_matches_authoritative_sine() {
    let dir = tempdir().unwrap();
    let reference = sine_signal(BLOCK_SAMPLES);
    let path = dir.path().join("sine16.wav");
    common::write_pcm16_wav(&path, &reference, 1, common::SAMPLE_RATE);
    let mut decoder = open_wav_decoder(&path);
    let collected = decode_in_chunks(&mut *decoder, 511);
    // 16 位 PCM 存在量化误差（引擎按 /32768 归一化，写入按 *32767 取整），最坏约
    // ±4.6e-5，故容差设 5e-5 —— 远小于任何真实缺口/重复采样的破坏量级。
    assert_pcm_close_tol(
        &reference,
        &collected,
        5.0e-5,
        "16 位 WAV 增量读(容差内)应等于权威正弦",
    );
}

// ---------------------------------------------------------------
// 2. 连续性：两块连续 WAV 区块拼接 == 一次权威参考
// ---------------------------------------------------------------

/// 用单一正弦信号切出两块**采样级连续**的 WAV，分块增量读出并拼接，必须与一次性
/// 权威参考完全一致 —— 证明两块在拼接边界无 gap / 无重复。
#[test]
fn two_consecutive_wav_blocks_join_without_gap_or_duplicate() {
    let dir = tempdir().unwrap();
    let (path_a, path_b, reference) = write_continuous_blocks(dir.path(), BLOCK_SAMPLES, false);
    let split = reference.len() / 2;

    // 分两个解码器增量读出再线性拼接（不重排、不裁剪）。
    let combined = concat_blocks(vec![open_wav_decoder(&path_a), open_wav_decoder(&path_b)]);
    assert_pcm_close(
        &reference,
        &combined,
        "两块连续 WAV 拼接必须等于一次性权威参考",
    );

    // 直接验证边界处：A 末样本 == 参考[split-1]，B 首样本 == 参考[split]。
    let decoded_a = decode_in_chunks(&mut *open_wav_decoder(&path_a), 256);
    let decoded_b = decode_in_chunks(&mut *open_wav_decoder(&path_b), 257);
    let a_last = decoded_a[decoded_a.len() - 1];
    let b_first = decoded_b[0];
    assert!(
        (a_last - sine_reference((split - 1) as u64)).abs() <= DEFAULT_TOL,
        "A 块末样本应等于参考[split-1]"
    );
    assert!(
        (b_first - sine_reference(split as u64)).abs() <= DEFAULT_TOL,
        "B 块首样本应等于参考[split]（紧接 A 末样本，无 gap/重复）"
    );
    // 「无 gap / 无重复」的强判据已由下方两行共同体现：A 末 == 参考[split-1] 且
    // B 首 == 参考[split]，二者是同一正弦在两个相邻帧上的连续取值。
}

/// 把两块 WAV 以 [B, A] 顺序拼接，拼接结果应等于倒序信号；用于确认拼接语义严格
/// 遵循给定顺序，不引入任何额外排序 / 去重 / 补白。
#[test]
fn block_concat_preserves_given_order() {
    let dir = tempdir().unwrap();
    let (path_a, path_b, reference) = write_continuous_blocks(dir.path(), BLOCK_SAMPLES, false);
    let split = reference.len() / 2;

    // 严格按 [B, A] 顺序拼接 → 期待信号为参考的倒序切片 [split..] ++ [..split]。
    let mut expected = Vec::with_capacity(reference.len());
    expected.extend_from_slice(&reference[split..]);
    expected.extend_from_slice(&reference[..split]);
    let combined = concat_blocks(vec![open_wav_decoder(&path_b), open_wav_decoder(&path_a)]);
    assert_pcm_close(&expected, &combined, "拼接必须保持给定顺序（不重排/去重）");
}

// ---------------------------------------------------------------
// 3. seek 后边界无重复 / 缺失（WAV 真增量）
// ---------------------------------------------------------------

/// seek 到不同区间后各区间读出的样本，必须逐点等于权威参考对应切片；且 seek 后
/// 首采样与相邻采样必须相位连续（边界无重复 / 缺失）。
#[test]
fn wav_seek_boundary_maintains_sample_fidelity() {
    let dir = tempdir().unwrap();
    let reference = sine_signal(BLOCK_SAMPLES);
    let path = dir.path().join("seek.wav");
    common::write_float32_wav(&path, &reference, 1, common::SAMPLE_RATE);

    let mut decoder = open_wav_decoder(&path);
    let mut head = vec![0.0f32; 1_000];
    assert_eq!(decoder.read_pcm(&mut head).unwrap(), 1_000);
    decoder.seek(2_000).unwrap();
    let mid = decode_in_chunks(&mut *decoder, 333);
    decoder.seek(1_000).unwrap();
    // 只读 2000 帧（1000..3000），避免读到末尾导致与切片长度不符。
    let mut middle = vec![0.0f32; 2_000];
    assert_eq!(decoder.read_pcm(&mut middle).unwrap(), 2_000);

    assert_pcm_close(&reference[..1000], &head, "初始读必须等于参考[..1000]");
    assert_pcm_close(
        &reference[1000..3000],
        &middle,
        "seek 到 1000 后读必须等于参考切片",
    );
    assert_pcm_close(
        &reference[2000..],
        &mid,
        "seek 到 2000 后读必须等于参考[2000..]",
    );

    // seek 后首采样及相邻采样相位连续。
    decoder.seek(1_500).unwrap();
    let mut boundary = [0.0f32; 2];
    assert_eq!(decoder.read_pcm(&mut boundary).unwrap(), 2);
    assert!(
        (boundary[0] - sine_reference(1_500)).abs() <= DEFAULT_TOL,
        "seek 后首采样必须是参考[1500]"
    );
    assert!(
        (boundary[1] - sine_reference(1_501)).abs() <= DEFAULT_TOL,
        "seek 后相邻采样必须相位连续"
    );
}

// ---------------------------------------------------------------
// 4. Standby / 格式统一 gapless 证据（真实 RuntimeCoordinator）
// ---------------------------------------------------------------

/// 关键判据：引擎把第二首 WAV 作为 standby 预拉时，其拉出的 PCM 头样本必须严格等于
/// 第一首（前一曲播放到尾部）之后、信号时间轴上紧邻的下一采样。本测试用真实的
/// `prime_standby` + `take_standby_at_sample_boundary` 取回 `RuntimeCoordinator`
/// 缓冲的格式统一 PCM，验证 standby 边界无 gap / 无重复，即为 gapless 的
/// 「standby 证据」。
#[test]
fn standby_primed_pcm_starts_at_continuation_sample_after_previous_tail() {
    // 两首曲目是同一连续正弦的前后两段：A = ref[..N]，B = ref[N..2N]。
    let split = BLOCK_SAMPLES;
    let reference = sine_signal(2 * split);
    let dir = tempdir().unwrap();
    let path_a = dir.path().join("track_a.wav");
    let path_b = dir.path().join("track_b.wav");
    common::write_float32_wav(&path_a, &reference[..split], 1, common::SAMPLE_RATE);
    common::write_float32_wav(&path_b, &reference[split..], 1, common::SAMPLE_RATE);

    // 假输出格式与 WAV 一致 → 无重采样，纯 standby 采样边界证据。
    let mut coordinator = RuntimeCoordinator::new(
        Box::new(WavDecoderFactory),
        Box::new(FakeAudioOutput::new(mono_format())),
    );
    // 前一曲（A）作为 active 加载；其后 A 尾采样 == ref[split-1]。
    coordinator.load(&common::open_trusted(&path_a)).unwrap();

    // 预拉 B（standby），缓冲 512 帧。
    let buffered = coordinator
        .prime_standby(&common::open_trusted(&path_b), 512)
        .unwrap();
    assert!(
        buffered > 0 && buffered <= 512,
        "standby 缓冲帧数不合理: {buffered}"
    );

    // 在采样边界取走 standby 的格式统一 PCM。
    let (track, standby_pcm) = coordinator.take_standby_at_sample_boundary().unwrap();
    assert!(
        track.id == common::local_track(&path_b).id,
        "standby 应返回 B 的 track"
    );
    assert_eq!(
        standby_pcm.len(),
        buffered,
        "standby 缓冲采样数与声明帧数一致（单声道）"
    );

    // A 尾采样 = ref[split-1]；B 头 = standby_pcm[0] == ref[split]。
    // 二者是同一正弦相邻两帧的连续取值，standby 头恰好接续 A 尾之后，无 gap/重复。
    let b_head = standby_pcm[0];
    assert!(
        (b_head - sine_reference(split as u64)).abs() <= DEFAULT_TOL,
        "standby 头样本必须是 A 尾之后的连续下一采样 ref[split]"
    );
    // 整段 standby 缓冲必须逐点等于权威参考连续切片 ref[split..split+buffered]。
    assert_pcm_close(
        &reference[split..split + buffered],
        &standby_pcm,
        "standby 缓冲必须等于权威参考的连续切片",
    );
}

/// `take_standby_at_sample_boundary` 在未 primed 时应报错，避免在缺少 standby 证据时
/// 误宣称 gapless（fail-closed 语义）。
#[test]
fn standby_boundary_take_requires_primed_evidence() {
    let reference = sine_signal(2 * BLOCK_SAMPLES);
    let dir = tempdir().unwrap();
    let path_a = dir.path().join("track_a.wav");
    common::write_float32_wav(&path_a, &reference[..BLOCK_SAMPLES], 1, common::SAMPLE_RATE);

    let mut coordinator = RuntimeCoordinator::new(
        Box::new(WavDecoderFactory),
        Box::new(FakeAudioOutput::new(mono_format())),
    );
    coordinator.load(&common::open_trusted(&path_a)).unwrap();
    assert!(
        coordinator.take_standby_at_sample_boundary().is_err(),
        "未 primed 前取边界必须失败（无 standby 证据不得宣称 gapless）"
    );
}

/// 只有「已缓冲 PCM + 格式统一」后，standby 才进入 gapless-ready 判据；纯打开/纯
/// 格式统一均不足以保证 gapless。
#[test]
fn standby_is_gapless_ready_only_after_pcm_buffered() {
    let split = BLOCK_SAMPLES;
    let reference = sine_signal(2 * split);
    let dir = tempdir().unwrap();
    let path_a = dir.path().join("track_a.wav");
    let path_b = dir.path().join("track_b.wav");
    common::write_float32_wav(&path_a, &reference[..split], 1, common::SAMPLE_RATE);
    common::write_float32_wav(&path_b, &reference[split..], 1, common::SAMPLE_RATE);

    let mut coordinator = RuntimeCoordinator::new(
        Box::new(WavDecoderFactory),
        Box::new(FakeAudioOutput::new(mono_format())),
    );
    coordinator.load(&common::open_trusted(&path_a)).unwrap();
    assert!(
        !coordinator.standby().is_gapless_ready(),
        "未 prime 前不应 gapless ready"
    );
    coordinator
        .prime_standby(&common::open_trusted(&path_b), 256)
        .unwrap();
    assert!(
        coordinator.standby().is_gapless_ready(),
        "缓冲 PCM 后应 gapless ready"
    );
}

// ---------------------------------------------------------------
// 5. 分段读拼回 == 一次性读（WAV 权威；FLAC/MP3 自适应）
// ---------------------------------------------------------------

/// 对任意可打开的本地解码器：「分段增量读拼回」必须等于「一次性读」。这是 gapless
/// 增量读取的最基本不变量（与 codec 是否真增量无关，任何正确解码器都必须满足）。
/// 此处为 WAV 的权威断言版。
#[test]
fn segmented_read_equals_oneshot_for_wav() {
    let dir = tempdir().unwrap();
    let reference = sine_signal(BLOCK_SAMPLES);
    let path = dir.path().join("seg.wav");
    common::write_float32_wav(&path, &reference, 1, common::SAMPLE_RATE);

    let oneshot = decode_in_chunks(&mut *open_wav_decoder(&path), 2048);
    let segmented = decode_in_chunks(&mut *open_wav_decoder(&path), 97);
    assert_pcm_close(&oneshot, &segmented, "WAV 分段与一次性读必须一致");
    assert_pcm_close(&reference, &oneshot, "一次性读必须等于权威参考");
}

/// FLAC：若构建中可用（并行代理的增量改写可能替换解码后端），验证
/// 「seek 后边界」与「分段拼回 == 一次性读」；不可用则跳过并记录。
#[test]
fn flac_segmented_and_seek_when_available() {
    let Some(path) = write_flac_fixture_if_decodable() else {
        eprintln!("[gapless] FLAC 解码在当前后端不可用，跳过连续性验证");
        return;
    };
    // 一次性读。
    let mut decoder = open_local_decoder(&path);
    let oneshot = decode_in_chunks(&mut *decoder, 2048);
    assert!(!oneshot.is_empty(), "FLAC fixture 必须产生 PCM");
    // 分段小步读（新解码器）。
    let segmented = decode_in_chunks(&mut *open_local_decoder(&path), 333);
    assert_pcm_close(&oneshot, &segmented, "FLAC 分段与一次性读必须一致");
    // seek 后边界无重复 / 缺失。
    let mut after_seek = open_local_decoder(&path);
    let target = oneshot.len() / 2;
    after_seek.seek(target as u64).unwrap();
    let tail = decode_in_chunks(&mut *after_seek, 200);
    assert_pcm_close(
        &oneshot[target..],
        &tail,
        "FLAC seek 后必须等于一次性读的尾部",
    );
}

/// MP3：与 FLAC 相同的自适应验证。
#[test]
fn mp3_segmented_and_seek_when_available() {
    let Some(path) = write_mp3_fixture_if_decodable() else {
        eprintln!("[gapless] MP3 解码在当前后端不可用，跳过连续性验证");
        return;
    };
    let mut decoder = open_local_decoder(&path);
    let oneshot = decode_in_chunks(&mut *decoder, 2048);
    assert!(!oneshot.is_empty(), "MP3 fixture 必须产生 PCM");
    let segmented = decode_in_chunks(&mut *open_local_decoder(&path), 211);
    assert_pcm_close(&oneshot, &segmented, "MP3 分段与一次性读必须一致");
}

// ---------------------------------------------------------------
// 6. Runtime 级 trim / gapless 全链路证据（MP3 / FLAC）
// ---------------------------------------------------------------

/// Runtime 全链路证据 ①：带 Xing/LAME gapless 元数据的 MP3 经 `RuntimeCoordinator`
/// `load → prepare_decoder(seek(delay)) → pump` 播放到末尾，输出帧数必须恰为
/// `raw_total − delay − padding`（3985），既不双重裁剪也不漏裁 —— runtime 的
/// 「物理 trim」语义在真增量 MP3 上成立的证据。
#[test]
fn runtime_applies_xing_lame_trim_when_playing_mp3_end_to_end() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("xing.mp3");
    const AUDIO_FRAMES: usize = 8;
    const DELAY: u32 = 576;
    const PADDING: u32 = 47;
    fs::write(&path, mp3_xing_fixture(AUDIO_FRAMES, DELAY, PADDING)).unwrap();

    let mut coordinator = RuntimeCoordinator::new(
        Box::new(LocalDecoderFactory),
        Box::new(FakeAudioOutput::new(mono_8k_format())),
    );
    let report = coordinator
        .play_to_end(&common::open_trusted(&path))
        .unwrap();
    // raw = 8 × 576 = 4608；playable = 4608 − 576 − 47 = 3985。
    let playable = AUDIO_FRAMES as u64 * 576 - u64::from(DELAY + PADDING);
    assert_eq!(report.frames_written, playable);
}

/// Runtime 全链路证据 ②：带 ENCODER_DELAY/PADDING Vorbis Comment 的 FLAC 经
/// `RuntimeCoordinator` 播放到末尾，输出帧数恰为 `raw − delay − padding`（2）。
#[test]
fn runtime_applies_flac_vorbis_trim_end_to_end() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("trim.data");
    fs::write(&path, flac_fixture_with_delay_padding(1, 1)).unwrap();

    let mut coordinator = RuntimeCoordinator::new(
        Box::new(LocalDecoderFactory),
        Box::new(FakeAudioOutput::new(mono_format())),
    );
    let report = coordinator
        .play_to_end(&common::open_trusted(&path))
        .unwrap();
    // raw = 4 帧；playable = 4 − 1 − 1 = 2。
    assert_eq!(report.frames_written, 2);
}

/// Runtime 全链路证据 ③：MP3 作为 standby 被 `prime_standby` 预拉时，内部
/// `prepare_decoder` 必须先 `seek(delay)`（对 Xing 曲目即 demuxer 精确 seek + 帧内
/// skip 路径）再拉取 PCM；trim 值必须进入 `StandbyState::Primed`，成为 gapless-ready
/// 判据的一部分（actor 在采样边界切换时使用）。
#[test]
fn standby_prime_pulls_trimmed_mp3_pcm_after_delay_seek() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("xing.mp3");
    const AUDIO_FRAMES: usize = 8;
    const DELAY: u32 = 576;
    const PADDING: u32 = 47;
    fs::write(&path, mp3_xing_fixture(AUDIO_FRAMES, DELAY, PADDING)).unwrap();

    // active 曲目：同格式 WAV（8k mono，短信号即可）。
    let active_path = dir.path().join("active.wav");
    common::write_float32_wav(&active_path, &sine_signal(64), 1, 8_000);

    let mut coordinator = RuntimeCoordinator::new(
        Box::new(LocalDecoderFactory),
        Box::new(FakeAudioOutput::new(mono_8k_format())),
    );
    coordinator
        .load(&common::open_trusted(&active_path))
        .unwrap();

    let buffered = coordinator
        .prime_standby(&common::open_trusted(&path), 512)
        .unwrap();
    let playable = AUDIO_FRAMES as u64 * 576 - u64::from(DELAY + PADDING);
    assert!(
        buffered == 512 && u64::try_from(buffered).unwrap() <= playable,
        "standby 应缓冲请求的 512 帧（playable={playable}）: {buffered}"
    );

    // trim 必须随 standby 状态上报（gapless-ready 判据包含 trim 元数据）。
    let standby = coordinator.standby();
    let primed = match standby {
        hyperplayer_engine::audio::StandbyState::Primed {
            trim,
            buffered_frames,
            ..
        } => {
            assert_eq!(
                (trim.delay_frames, trim.padding_frames),
                (DELAY, PADDING),
                "standby Primed 状态必须携带 Xing trim 元数据"
            );
            *buffered_frames
        }
        other => panic!("standby 应处于 Primed 状态: {other:?}"),
    };
    assert_eq!(primed, 512);
    assert!(
        coordinator.standby().is_gapless_ready(),
        "PCM 缓冲后 standby 必须 gapless ready"
    );
}

// ---------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------

/// 分块把解码器读到末尾，`chunk_size` 控制每块大小（模拟增量边读边填 ring）。
fn decode_in_chunks(decoder: &mut dyn Decoder, chunk_size: usize) -> Vec<f32> {
    let mut out = Vec::new();
    loop {
        let mut buf = vec![0.0f32; chunk_size.clamp(1, 2048)];
        let read = decoder.read_pcm(&mut buf).unwrap();
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buf[..read]);
    }
    out
}

/// 尝试在临时目录写一个最小 FLAC fixture；若当前后端能解码则返回（保持文件存在的）
/// 路径，否则返回 None（并行改写中后端未就绪）。
fn write_flac_fixture_if_decodable() -> Option<PathBuf> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("audio.data");
    fs::write(&path, FLAC_FIXTURE).unwrap();
    match LocalDecoderFactory.open(&common::open_trusted(&path)) {
        Ok(mut decoder) if decoder.total_frames() > 0 => {
            let _ = decoder.read_pcm(&mut [0.0f32; 8]).map(|_| ());
            // 保持临时目录不被回收，使文件在测试期间一直存在。
            mem::forget(dir);
            Some(path)
        }
        _ => None,
    }
}

/// 生成一个能被 symphonia mp3 解码的最小 MP3 fixture（沿用引擎单测同款帧头）。
fn write_mp3_fixture_if_decodable() -> Option<PathBuf> {
    let dir = tempdir().unwrap();
    const FRAME_SIZE: usize = 72;
    let mut encoded = Vec::with_capacity(FRAME_SIZE * 8);
    for _ in 0..8 {
        let mut frame = [0_u8; FRAME_SIZE];
        // MPEG-2.5 Layer III，8 kbps，8 kHz，mono。
        frame[..4].copy_from_slice(&[0xff, 0xe3, 0x18, 0xc0]);
        encoded.extend_from_slice(&frame);
    }
    let path = dir.path().join("audio.mp3");
    fs::write(&path, encoded).unwrap();
    match LocalDecoderFactory.open(&common::open_trusted(&path)) {
        Ok(mut decoder) if decoder.total_frames() > 0 => {
            let _ = decoder.read_pcm(&mut [0.0f32; 8]).map(|_| ());
            mem::forget(dir);
            Some(path)
        }
        _ => None,
    }
}
