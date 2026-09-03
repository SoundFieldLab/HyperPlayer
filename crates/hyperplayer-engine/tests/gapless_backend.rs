//! Stage 14（增量解码 / 真正 gapless）后端语义测试。
//!
//! 聚焦「假后端解码器状态机」与「慢 IO 包装」的语义，不依赖真实文件或音频设备：
//!
//! - [`common::ScriptedStream`] / [`FakeDecoder`]：可人为制造欠载（部分返回）、
//!   EOF 与 seek。
//! - [`common::SlowIoDecoder`]：模拟慢磁盘/网络流出，验证读线程按需返回部分样本
//!   而不被永久阻塞。
//!
//! 这些测试验证引擎消费方（模拟 ring 填充循环）在慢读 / 欠载 / EOF 下不 panic、
//! 可继续、最终能填满或明确到达 EOF，并在 seek 后复位欠载状态。

mod common;

use common::{assert_pcm_close, sine_reference, sine_signal, FakeDecoder};
use hyperplayer_engine::audio::Decoder;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 一个有界样本环：生产者按容量填入，消费者按需取出。
/// 消费者在环空时请求数据即「欠载」，返回实际取到的数量（可为 0）而不 panic。
struct FakeRing {
    capacity: usize,
    buf: VecDeque<f32>,
}

impl FakeRing {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            buf: VecDeque::with_capacity(capacity),
        }
    }

    fn space(&self) -> usize {
        self.capacity - self.buf.len()
    }

    fn len(&self) -> usize {
        self.buf.len()
    }

    /// 生产者填入样本（调用方保证不超容量）。
    fn produce(&mut self, samples: &[f32]) {
        debug_assert!(samples.len() <= self.space());
        self.buf.extend(samples.iter().copied());
    }

    /// 消费者取出至多 `out.len()` 个样本；环空时欠载，返回 0。
    fn consume(&mut self, out: &mut [f32]) -> usize {
        let n = out.len().min(self.buf.len());
        for slot in out[..n].iter_mut() {
            *slot = self.buf.pop_front().expect("n 已按 buf.len() 收窄");
        }
        n
    }
}

// ---------------------------------------------------------------
// 欠载 / 部分读
// ---------------------------------------------------------------

/// 后端每次只吐部分样本（max_out=128）时，模拟 ring 填充循环必须持续推进、
/// 不 panic，且最终读完整个流并逐点等于权威参考（部分读不引入重复/缺失）。
#[test]
fn underrun_with_partial_reads_never_panics_and_finishes() {
    let total_frames = 8_192; // 单声道
    let mut decoder = FakeDecoder::sine_tracked(total_frames, &PathBuf::from("fake"));
    decoder.stream().set_max_out_per_call(128);

    let mut ring = FakeRing::new(512);
    let mut consumed: Vec<f32> = Vec::with_capacity(total_frames);
    let mut source_position = 0usize;
    let mut eof = false;

    // 解码线程（生产者）与消费线程交替：生产者按「空余容量」为上限拉样本（每次
    // 至多 128，可能部分返回），消费者固定取 64。EOF 后继续排空 ring。
    while consumed.len() < total_frames {
        while !eof && ring.space() > 0 {
            let cap = ring.space().min(128);
            let mut scratch = vec![0.0f32; cap];
            let read = decoder.read_pcm(&mut scratch).unwrap();
            if read == 0 {
                eof = true;
                break;
            }
            source_position += read;
            ring.produce(&scratch[..read]);
        }
        if eof && ring.len() == 0 {
            break;
        }
        let push_index = consumed.len();
        let want = 64.min(total_frames - push_index);
        consumed.resize(push_index + want, 0.0);
        let got = ring.consume(&mut consumed[push_index..]);
        consumed.truncate(push_index + got);
    }

    assert!(eof, "消费满时应已触发 EOF");
    assert_eq!(source_position, total_frames, "解码线程必须读尽全部样本");
    assert_eq!(consumed.len(), total_frames);
    assert_pcm_close(
        &sine_signal(total_frames),
        &consumed,
        "欠载部分读拼接后必须等于权威参考",
    );
}

/// 消费者先于生产者取数（ring 空）→ 欠载返回 0 而不 panic；生产者随后补满，
/// 消费者最终取到全部样本。
#[test]
fn ring_underrun_recovers_and_finally_drains() {
    let mut ring = FakeRing::new(256);
    // 空环上消费：欠载，返回 0，不 panic。
    let mut out = [0.0f32; 32];
    assert_eq!(ring.consume(&mut out), 0, "空环消费应欠载返回 0");

    // 生产者分两次补入 128 + 128。
    ring.produce(&[0.25; 128]);
    ring.produce(&[0.5; 128]);
    assert_eq!(ring.len(), 256);

    // 消费者取 64，随后继续取到空。
    let got = ring.consume(&mut out);
    assert_eq!(got, 32);
    let mut drain = vec![0.0f32; 256];
    let got = ring.consume(&mut drain);
    assert_eq!(got, 224, "消费后剩余 224 样本");
    assert_eq!(ring.len(), 0);
}

// ---------------------------------------------------------------
// 慢 IO
// ---------------------------------------------------------------

/// 慢 IO：每次 `read_pcm` 前 sleep 一小段，且每次只返回少量样本。
/// 验证读线程按需推进、持续累计，最终填满整个目标缓冲区（不被永久阻塞）。
#[test]
fn slow_io_reads_advance_incrementally_and_eventually_fill() {
    let total_frames = 4_096;
    let raw = FakeDecoder::sine_tracked(total_frames, &PathBuf::from("fake"));
    let mut slow = common::SlowIoDecoder::new(Box::new(raw), Duration::from_micros(100), Some(32));

    let mut target = vec![0.0f32; total_frames];
    let mut filled = 0usize;
    let start = Instant::now();
    while filled < total_frames {
        let read = slow.read_pcm(&mut target[filled..]).unwrap();
        assert!(read > 0, "未到 EOF 却返回 0，可能导致永久阻塞");
        filled += read;
    }
    // 读尽后再读一次必须返回 0（EOF 语义）。
    let mut tail = [0.0f32; 4];
    assert_eq!(slow.read_pcm(&mut tail).unwrap(), 0, "EOF 后继续读应返回 0");

    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "慢读必须在合理时间内填满（实际 {elapsed:?}）"
    );
    assert_pcm_close(
        &sine_signal(total_frames),
        &target,
        "慢 IO 分段读拼回后必须等于权威参考",
    );
}

/// 慢 IO + seek：seek 后慢读路径恢复，样本内容从目标帧开始。
#[test]
fn slow_io_seek_restarts_from_target_frame() {
    let total_frames = 2_048;
    let raw = FakeDecoder::sine_tracked(total_frames, &PathBuf::from("fake"));
    let mut slow = common::SlowIoDecoder::new(Box::new(raw), Duration::from_micros(50), Some(64));

    slow.seek(1_000).unwrap();
    let mut tail = Vec::new();
    let mut scratch = [0.0f32; 48];
    loop {
        let read = slow.read_pcm(&mut scratch).unwrap();
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&scratch[..read]);
    }
    let mut expected = sine_signal(total_frames);
    let expected_slice = expected.split_off(1_000);
    assert_pcm_close(&expected_slice, &tail, "慢 IO seek 后必须从目标帧开始");
}

// ---------------------------------------------------------------
// EOF 语义
// ---------------------------------------------------------------

/// EOF 后继续读返回 0；多次读仍返回 0。
#[test]
fn eof_reads_return_zero_consistently() {
    let mut decoder = FakeDecoder::sine_tracked(128, &PathBuf::from("fake"));
    let mut buf = [0.0f32; 1024];
    let read = decoder.read_pcm(&mut buf).unwrap();
    assert_eq!(read, 128, "首读应取走全部 128 样本");
    assert_eq!(decoder.read_pcm(&mut buf).unwrap(), 0, "EOF 后应返回 0");
    assert_eq!(
        decoder.read_pcm(&mut buf).unwrap(),
        0,
        "多次 EOF 读仍返回 0"
    );
}

// ---------------------------------------------------------------
// seek 复位欠载 / EOF
// ---------------------------------------------------------------

/// seek 到中途后继续读应返回正常样本，EOF 状态复位。
#[test]
fn seek_resets_eof_and_underrun_state() {
    let total_frames = 1_024;
    let mut decoder = FakeDecoder::sine_tracked(total_frames, &PathBuf::from("fake"));
    decoder.stream().set_max_out_per_call(64);

    // 读尽 → EOF。
    let mut buf = [0.0f32; 4096];
    loop {
        let read = decoder.read_pcm(&mut buf).unwrap();
        if read == 0 {
            break;
        }
    }
    assert!(decoder.stream().eof_reached(), "读尽后应标记 EOF");

    // seek 到帧 512（单声道 → 样本索引 512）；seek 会复位 EOF 与欠载状态，随后
    // 以无上限的方式一次读足 512 样本到末尾。
    decoder.seek(512).unwrap();
    decoder.stream().set_max_out_per_call(0);
    assert!(!decoder.stream().eof_reached(), "seek 后 EOF 应复位");
    let mut out = vec![0.0f32; 512];
    let got = decoder.read_pcm(&mut out).unwrap();
    assert_eq!(got, 512, "seek 后应能从目标帧读到末尾");

    // 权威比对：out[i] 应为正弦在帧 512+i 的值。
    for (i, value) in out.iter().enumerate() {
        let expected = sine_reference(512 + i as u64);
        assert!(
            (value - expected).abs() <= common::DEFAULT_TOL,
            "seek 后样本 {i} 不一致：期望 {expected}，实际 {value}"
        );
    }

    // seek 越过末尾应报 InvalidInput。
    assert!(
        decoder.seek((total_frames + 10) as u64).is_err(),
        "越界 seek 应失败"
    );
}

/// seek 复位后，欠载部分读的状态机能再次从目标帧开始正常推进（不残留旧位置）。
#[test]
fn seek_then_partial_reads_continue_from_new_frame() {
    let total_frames = 2_048;
    let reference = sine_signal(total_frames);
    let mut decoder = FakeDecoder::sine_tracked(total_frames, &PathBuf::from("fake"));

    // 先以无上限读前 300 样本制造部分进度。
    let mut buf = [0.0f32; 300];
    assert_eq!(decoder.read_pcm(&mut buf).unwrap(), 300);

    // seek 到帧 1000，再开启部分读上限（96），从新帧以欠载方式读尽，
    // 必须从目标帧开始且与参考 [1000..] 一致。
    decoder.seek(1_000).unwrap();
    decoder.stream().set_max_out_per_call(96);
    let mut tail = Vec::new();
    let mut scratch = [0.0f32; 64];
    loop {
        let read = decoder.read_pcm(&mut scratch).unwrap();
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&scratch[..read]);
    }
    assert_pcm_close(&reference[1000..], &tail, "seek 后部分读必须从新帧开始");
}
