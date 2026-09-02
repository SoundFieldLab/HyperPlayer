//! HSE Stage 21 Limiter 冻结向量对拍：共享根目录 `tests/fixtures/dsp/` 下的
//! 4 条 limiter v1.5.1 官方向量（commit f7017621b7d84005fbfed8a3c42a119487a17326）。
//! 集成后向量与 `dsp_parity.rs` 共用同一根目录；本文件保留为独立对拍
//! （不经适配器直接以核心参数构造，作为适配器分发的对照）。

use hyperplayer_engine::dsp::{PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat};
use hyperplayer_engine::dsp_algorithms::limiter::{LimiterProcessor, LimiterSettings};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorMeta {
    schema_version: u32,
    module: String,
    case: String,
    sample_rate: u32,
    block_size: usize,
    channels: u16,
    frames: usize,
    params: Value,
    tolerance: Tolerance,
    source: VectorSource,
}

#[derive(Deserialize)]
struct VectorSource {
    project: String,
    version: String,
    commit: String,
}

#[derive(Deserialize)]
struct Tolerance {
    kind: String,
    value: f64,
    floor: f64,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("tests/fixtures/dsp")
}

fn number(params: &Value, field: &str) -> f64 {
    params[field]
        .as_f64()
        .unwrap_or_else(|| panic!("{field} must be numeric"))
}

fn boolean(params: &Value, field: &str) -> bool {
    params[field]
        .as_bool()
        .unwrap_or_else(|| panic!("{field} must be boolean"))
}

fn read_segments(path: &Path, frames: usize) -> [Vec<f32>; 4] {
    let bytes = fs::read(path).unwrap();
    assert_eq!(bytes.len(), frames * 4 * size_of::<f32>());
    let samples = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect::<Vec<_>>();
    std::array::from_fn(|segment| {
        let start = segment * frames;
        samples[start..start + frames].to_vec()
    })
}

fn assert_close(
    label: &str,
    channel: &str,
    actual: &[f32],
    expected: &[f32],
    tolerance: &Tolerance,
) {
    for (index, (&actual, &expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            actual.is_finite(),
            "{label} {channel}[{index}] is not finite"
        );
        let bound = tolerance.value * f64::from(expected).abs().max(tolerance.floor);
        let difference = (f64::from(actual) - f64::from(expected)).abs();
        assert!(
            difference <= bound,
            "{label} {channel}[{index}]: got {actual}, want {expected}, diff {difference}, bound {bound}"
        );
    }
}

#[test]
fn limiter_matches_frozen_stage21_vectors() {
    let root = fixture_root();
    let mut json_paths = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| stem.starts_with("limiter."))
                && path.extension().and_then(|value| value.to_str()) == Some("json")
        })
        .collect::<Vec<_>>();
    json_paths.sort();
    assert_eq!(
        json_paths
            .iter()
            .map(|path| path.file_stem().unwrap().to_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        [
            "limiter.case1",
            "limiter.case2",
            "limiter.case3",
            "limiter.case4",
        ]
    );

    for json_path in json_paths {
        let meta: VectorMeta = serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(meta.schema_version, 1);
        assert_eq!(meta.module, "limiter");
        assert_eq!(meta.channels, 2);
        assert!(meta.frames > 0 && meta.block_size > 0);
        assert_eq!(meta.tolerance.kind, "relative");
        assert_eq!(meta.source.project, "HyperSoundEngine");
        assert_eq!(meta.source.version, "1.5.1");
        assert_eq!(
            meta.source.commit,
            "f7017621b7d84005fbfed8a3c42a119487a17326"
        );
        let label = format!("{}.{}", meta.module, meta.case);
        assert_eq!(
            json_path.file_stem().and_then(|value| value.to_str()),
            Some(label.as_str())
        );

        let settings = LimiterSettings {
            enabled: boolean(&meta.params, "enabled"),
            threshold_db: number(&meta.params, "thresholdDb"),
            lookahead_ms: number(&meta.params, "lookaheadMs"),
            attack_ms: number(&meta.params, "attackMs"),
            release_ms: number(&meta.params, "releaseMs"),
            true_peak: boolean(&meta.params, "truePeak"),
        };
        let mut processor = LimiterProcessor::new(f64::from(meta.sample_rate), settings).unwrap();
        let format = PcmFormat {
            sample_rate: meta.sample_rate,
            channels: meta.channels,
            sample_format: PcmSampleFormat::F32,
        };
        processor.prepare(format, meta.block_size).unwrap();

        let segments = read_segments(&json_path.with_extension("f32"), meta.frames);
        let [input_left, input_right, expected_left, expected_right] = segments;
        let mut interleaved = input_left
            .iter()
            .zip(&input_right)
            .flat_map(|(&left, &right)| [left, right])
            .collect::<Vec<_>>();
        for chunk in interleaved.chunks_mut(meta.block_size * 2) {
            processor
                .process(PcmBlock {
                    format,
                    interleaved: chunk,
                })
                .unwrap();
        }
        let actual_left = interleaved.iter().step_by(2).copied().collect::<Vec<_>>();
        let actual_right = interleaved
            .iter()
            .skip(1)
            .step_by(2)
            .copied()
            .collect::<Vec<_>>();
        assert_close(&label, "L", &actual_left, &expected_left, &meta.tolerance);
        assert_close(&label, "R", &actual_right, &expected_right, &meta.tolerance);
    }
}
