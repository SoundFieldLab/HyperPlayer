//! Stage 14 回归复现：实机「歌曲只能放一次，再放不能放」。
//!
//! 用真实 flacenc 编码文件走完整 actor 线程（EngineHandle::spawn_with_output），
//! 模拟 app 层重播序列：LoadContext → Ready → 泵到自然 EOF（actor 自动 stop）→
//! 再次 LoadContext → Ready，断言第二次仍进入 Playing 且产出全部样本。

mod common;

use flacenc::component::{BitRepr, Stream};
use flacenc::config::Encoder;
use flacenc::error::Verify;
use flacenc::source::MemSource;
use hyperplayer_engine::actor::{EngineCommand, EngineHandle};
use hyperplayer_engine::audio::{AudioOutput, DecoderFactory, LocalDecoderFactory};
use hyperplayer_engine::media::MediaHandle;
use hyperplayer_engine::model::{MediaId, MediaSource, QueueItem, Track};
use hyperplayer_engine::playback::PlaybackState;
use hyperplayer_engine::{EngineError, Result, TrustedResolvedMedia};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tempfile::tempdir;

const SAMPLE_RATE: u32 = 44_100;
const TRACK_SAMPLES: usize = 8_192;

struct RecordingOutput {
    samples: Arc<Mutex<Vec<f32>>>,
    started: Arc<Mutex<bool>>,
}

impl AudioOutput for RecordingOutput {
    fn format(&self) -> hyperplayer_engine::dsp::PcmFormat {
        hyperplayer_engine::dsp::PcmFormat {
            sample_rate: SAMPLE_RATE,
            channels: 2,
            sample_format: hyperplayer_engine::dsp::PcmSampleFormat::F32,
        }
    }
    fn start(&mut self) -> Result<()> {
        *self.started.lock().unwrap() = true;
        Ok(())
    }
    fn pause(&mut self) -> Result<()> {
        *self.started.lock().unwrap() = false;
        Ok(())
    }
    fn stop(&mut self) -> Result<()> {
        *self.started.lock().unwrap() = false;
        Ok(())
    }
    fn write(&mut self, pcm: &[f32]) -> Result<usize> {
        self.samples.lock().unwrap().extend_from_slice(pcm);
        Ok(pcm.len())
    }
}

fn encode_real_flac(interleaved: &[i32]) -> Vec<u8> {
    let source = MemSource::from_samples(interleaved, 2, 16, SAMPLE_RATE as usize);
    let config = Encoder::default().into_verified().expect("encoder config");
    let stream: Stream =
        flacenc::encode_with_fixed_block_size(&config, source, 4_096).expect("encode");
    let mut sink = flacenc::bitsink::MemSink::<u64>::new();
    sink.reserve(stream.count_bits());
    stream.write(&mut sink).expect("FLAC stream serialization");
    let mut bytes = vec![0_u8; sink.len() >> 3];
    sink.write_to_byte_slice(&mut bytes);
    bytes
}

fn make_track(id: u64, path: &Path) -> Track {
    Track {
        id: MediaId::new(format!("track-{id}")),
        source: MediaSource::Local {
            path: path.to_path_buf(),
        },
        title: format!("Track {id}"),
        artists: vec![],
        album: None,
        album_id: None,
        artist_ids: vec![],
        artwork_hash: None,
        artwork_mime: None,
        duration_ms: None,
    }
}

fn media_for(track: &Track) -> TrustedResolvedMedia {
    let path = match &track.source {
        MediaSource::Local { path } => path.clone(),
        _ => panic!("test only builds local tracks"),
    };
    TrustedResolvedMedia::new(
        track.clone(),
        MediaHandle::local(fs::File::open(&path).unwrap(), path),
    )
}

/// 等待 actor 异步进入指定状态（5s 超时，每 10ms 轮询快照）。
fn wait_for<F>(handle: &EngineHandle, predicate: F, note: &str)
where
    F: Fn(&PlaybackState) -> bool,
{
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = handle.snapshot().expect("snapshot");
        if predicate(&snapshot.state) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{note}: 超时，最终状态 = {:?}",
            snapshot.state
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn playback_started(state: &PlaybackState) -> bool {
    matches!(state, PlaybackState::Playing { .. })
}

fn playback_stopped(state: &PlaybackState) -> bool {
    matches!(state, PlaybackState::Stopped { .. } | PlaybackState::Idle)
}

/// 复现用户操作序列：播放 → 自然结束 → 再点播放同一首歌。
#[test]
fn replay_after_natural_eof_replays_full_output() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("replay.flac");
    let interleaved: Vec<i32> = (0..TRACK_SAMPLES)
        .flat_map(|frame| {
            let value = common::sine_reference(frame as u64) as i32 * 16_000;
            [value, value]
        })
        .collect();
    fs::write(&path, encode_real_flac(&interleaved)).unwrap();

    let samples = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Mutex::new(false));
    let output = RecordingOutput {
        samples: Arc::clone(&samples),
        started: Arc::clone(&started),
    };
    let handle =
        EngineHandle::spawn_with_output(8, 1, Box::new(LocalDecoderFactory), Box::new(output))
            .unwrap();

    let track = make_track(1, &path);
    let media = media_for(&track);
    let item = QueueItem::new(1, track);

    // 第一次播放。
    handle
        .request(EngineCommand::LoadContext {
            items: vec![item.clone()],
            start_index: 0,
            media: media_for(&item.track),
        })
        .expect("第一次 LoadContext");
    handle.request(EngineCommand::Ready).expect("第一次 Ready");
    wait_for(&handle, playback_started, "第一次播放未开始");
    // 单曲队列：自然播到 EOF 后 actor 应 stop（无 next）。
    wait_for(&handle, playback_stopped, "第一次播放未自然结束");
    let first_pass = samples.lock().unwrap().clone();
    assert!(
        first_pass.len() >= TRACK_SAMPLES * 2,
        "第一次播放样本不足: {}",
        first_pass.len()
    );

    // 第二次播放同一文件（app 层 play_resolved 的等价序列）。
    samples.lock().unwrap().clear();
    handle
        .request(EngineCommand::LoadContext {
            items: vec![item],
            start_index: 0,
            media,
        })
        .expect("第二次 LoadContext 不应失败");
    handle.request(EngineCommand::Ready).expect("第二次 Ready");
    wait_for(&handle, playback_started, "第二次播放未开始");
    wait_for(&handle, playback_stopped, "第二次播放未自然结束");
    let second_pass = samples.lock().unwrap().clone();
    assert!(
        second_pass.len() >= TRACK_SAMPLES * 2,
        "第二次播放样本不足: {}",
        second_pass.len()
    );

    handle.shutdown().unwrap();
}

/// 复现变体：第二次播放前先 Stop（用户手动停止后再放）。
#[test]
fn replay_after_manual_stop_replays_full_output() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("replay-stop.flac");
    let interleaved: Vec<i32> = (0..TRACK_SAMPLES)
        .flat_map(|frame| {
            let value = common::sine_reference(frame as u64) as i32 * 16_000;
            [value, value]
        })
        .collect();
    fs::write(&path, encode_real_flac(&interleaved)).unwrap();

    let samples = Arc::new(Mutex::new(Vec::new()));
    let output = RecordingOutput {
        samples: Arc::clone(&samples),
        started: Arc::new(Mutex::new(false)),
    };
    let handle =
        EngineHandle::spawn_with_output(8, 1, Box::new(LocalDecoderFactory), Box::new(output))
            .unwrap();

    let track = make_track(2, &path);
    let item = QueueItem::new(2, track);
    handle
        .request(EngineCommand::LoadContext {
            items: vec![item.clone()],
            start_index: 0,
            media: media_for(&item.track),
        })
        .unwrap();
    handle.request(EngineCommand::Ready).unwrap();
    wait_for(&handle, playback_started, "第一次播放未开始");

    // 播放中途手动 Stop，然后重播。
    handle.request(EngineCommand::Stop).expect("手动停止");
    let snapshot = handle.snapshot().unwrap();
    assert!(
        matches!(snapshot.state, PlaybackState::Stopped { .. }),
        "手动停止后状态异常: {:?}",
        snapshot.state
    );

    let media = media_for(&item.track);
    handle
        .request(EngineCommand::LoadContext {
            items: vec![item],
            start_index: 0,
            media,
        })
        .expect("停止后重播 LoadContext 不应失败");
    handle
        .request(EngineCommand::Ready)
        .expect("停止后重播 Ready");
    wait_for(&handle, playback_started, "停止后重播未开始");
    wait_for(&handle, playback_stopped, "停止后重播未自然结束");
    let replayed = samples.lock().unwrap().len();
    assert!(replayed >= TRACK_SAMPLES * 2, "重播样本不足: {replayed}");

    handle.shutdown().unwrap();
}

/// 复现变体：播放失败（Failed 状态）后重播——实机「炸了」后 UI 再点播放的路径。
#[test]
fn replay_after_failure_recovers_with_new_load() {
    struct FailingOnceFactory {
        fail_next: Mutex<bool>,
    }
    impl DecoderFactory for FailingOnceFactory {
        fn open(
            &self,
            _media: &TrustedResolvedMedia,
        ) -> std::result::Result<Box<dyn hyperplayer_engine::audio::Decoder>, EngineError> {
            let mut fail_next = self.fail_next.lock().unwrap();
            if *fail_next {
                *fail_next = false;
                return Err(EngineError::Decode("injected open failure".into()));
            }
            LocalDecoderFactory.open(_media)
        }
        fn clone_factory(&self) -> Box<dyn DecoderFactory> {
            Box::new(FailingOnceFactory {
                fail_next: Mutex::new(*self.fail_next.lock().unwrap()),
            })
        }
    }

    let dir = tempdir().unwrap();
    let path = dir.path().join("recover.flac");
    let interleaved: Vec<i32> = (0..TRACK_SAMPLES)
        .flat_map(|frame| {
            let value = common::sine_reference(frame as u64) as i32 * 16_000;
            [value, value]
        })
        .collect();
    fs::write(&path, encode_real_flac(&interleaved)).unwrap();

    let samples = Arc::new(Mutex::new(Vec::new()));
    let output = RecordingOutput {
        samples: Arc::clone(&samples),
        started: Arc::new(Mutex::new(false)),
    };
    let handle = EngineHandle::spawn_with_output(
        8,
        1,
        Box::new(FailingOnceFactory {
            fail_next: Mutex::new(true),
        }),
        Box::new(output),
    )
    .unwrap();

    let track = make_track(3, &path);
    let item = QueueItem::new(3, track);
    // 第一次 open 注入失败 → Failed 状态。
    let first = handle.request(EngineCommand::LoadContext {
        items: vec![item.clone()],
        start_index: 0,
        media: media_for(&item.track),
    });
    assert!(first.is_err(), "注入的失败应向上返回");

    // 第二次重播：同一 runtime 下新 LoadContext 应恢复。
    let media = media_for(&item.track);
    handle
        .request(EngineCommand::LoadContext {
            items: vec![item],
            start_index: 0,
            media,
        })
        .expect("失败后重播 LoadContext 不应失败");
    handle
        .request(EngineCommand::Ready)
        .expect("失败后重播 Ready");
    wait_for(&handle, playback_started, "失败后重播未开始");
    wait_for(&handle, playback_stopped, "失败后重播未自然结束");
    assert!(samples.lock().unwrap().len() >= TRACK_SAMPLES * 2);

    handle.shutdown().unwrap();
}
