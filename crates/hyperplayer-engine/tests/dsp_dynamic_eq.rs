//! Stage 18 Dynamic EQ 引擎适配器独立测试（parity、连续性、checkpoint、零分配）。
//!
//! 注册路径说明：`dsp_algorithms/dynamic_eq.rs` 在 `dsp_algorithms/mod.rs` 注册
//! 之前不会被引擎 crate 编译；本文件在注册落地前通过 `#[path]` 直接纳入适配器
//! 源码进行编译与测试（`crate::dsp`/`crate::error` 由下方 shim 模块解析）。集成
//! 代理完成 `pub mod dynamic_eq;` 注册后，本文件可改为直接
//! `use hyperplayer_engine::dsp_algorithms::dynamic_eq::{...}`，行为不变。
//!
//! parity 向量来源：temp/hse-v1.5.1/specs/dsp/vectors/dynamic-eq.case1–4
//! （HyperSoundEngine v1.5.1，commit f7017621b7d84005fbfed8a3c42a119487a17326，
//! 冻结副本随本测试入库于 tests/fixtures/dsp/）。f32 布局与 dsp_parity 相同：
//! inputL / inputR / expectedL / expectedR 四段 × frames。
//! 注意：dynamic-eq 输出依赖驱动分块（内部分析块边界 = min(params.blockSize,
//! 本次调用剩余样本数)），故必须按向量顶层 blockSize 回放（规格 §4.5）。

#[path = "../src/dsp_algorithms/dynamic_eq.rs"]
mod adapter;

/// shim：适配器源码内的 `crate::dsp` / `crate::error` / `crate::telemetry`
/// 在本测试（`#[path]` 直接纳入适配器源码）中的解析。
mod dsp {
    pub use hyperplayer_engine::dsp::*;
}
mod error {
    pub use hyperplayer_engine::error::*;
}
/// telemetry 只暴露写门与读数发布接口给适配器源码；本测试不订阅遥测，写门
/// 恒为 false（发布路径零成本跳过），把广播语义隔离在引擎 lib 之外。
mod telemetry {
    use super::adapter::BAND_COUNT;
    pub(crate) fn chain_metering_hot() -> bool {
        false
    }
    pub(crate) fn publish_dynamic_eq_reading(
        _generation: u64,
        _gains: &[f64; BAND_COUNT],
        _levels_db: &[f64; BAND_COUNT],
        _reduction_db: &[f64; BAND_COUNT],
    ) {
    }
}

use adapter::{DynamicEqProcessor, DynamicEqSettings, BAND_COUNT};
use hyperplayer_engine::dsp::{PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat};
use serde::Deserialize;
use serde_json::Value;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    fs,
    path::{Path, PathBuf},
};

// ---------------------------------------------------------------------------
// 冻结向量 parity
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorMeta {
    #[allow(dead_code)]
    schema_version: u32,
    #[allow(dead_code)]
    module: String,
    #[allow(dead_code)]
    case: String,
    sample_rate: u32,
    block_size: usize,
    channels: u16,
    frames: usize,
    params: Value,
    tolerance: Tolerance,
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

fn settings_from_params(params: &Value) -> DynamicEqSettings {
    let bands = params["bands"]
        .as_array()
        .expect("bands must be an array")
        .iter()
        .map(|band| adapter::DynamicEqBandSettings {
            enabled: boolean(band, "enabled"),
            frequency: number(band, "frequency"),
            target_gain_db: number(band, "targetGainDb"),
        })
        .collect::<Vec<_>>();
    assert_eq!(bands.len(), BAND_COUNT, "vectors must carry 5 bands");
    DynamicEqSettings {
        enabled: boolean(params, "enabled"),
        strength: number(params, "strength"),
        threshold_db: number(params, "thresholdDb"),
        ratio: number(params, "ratio"),
        knee_db: number(params, "kneeDb"),
        attack_ms: number(params, "attackMs"),
        release_ms: number(params, "releaseMs"),
        block_size: number(params, "blockSize"),
        bands: bands.try_into().expect("fixed 5-band array"),
    }
}

/// inputL / inputR / expectedL / expectedR 四段 f32（小端）。
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
fn dynamic_eq_adapter_matches_frozen_hse_vectors() {
    let root = fixture_root();
    let mut json_paths = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| stem.starts_with("dynamic-eq."))
                && path.extension().and_then(|value| value.to_str()) == Some("json")
        })
        .collect::<Vec<_>>();
    json_paths.sort();
    assert_eq!(json_paths.len(), 4, "must carry dynamic-eq case1–4 vectors");

    for json_path in json_paths {
        let meta: VectorMeta = serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(meta.channels, 2);
        assert!(meta.frames > 0 && meta.block_size > 0);
        assert_eq!(meta.tolerance.kind, "relative");
        let label = json_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap()
            .to_owned();
        let segments = read_segments(&json_path.with_extension("f32"), meta.frames);
        let [input_left, input_right, expected_left, expected_right] = segments;
        let mut interleaved = input_left
            .iter()
            .zip(&input_right)
            .flat_map(|(&left, &right)| [left, right])
            .collect::<Vec<_>>();
        let format = PcmFormat {
            sample_rate: meta.sample_rate,
            channels: meta.channels,
            sample_format: PcmSampleFormat::F32,
        };
        let mut processor =
            DynamicEqProcessor::new(meta.sample_rate, settings_from_params(&meta.params)).unwrap();
        processor.prepare(format, meta.block_size).unwrap();
        // 与冻结向量导出器同一驱动分块（末块短块）。
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

// ---------------------------------------------------------------------------
// 稳态零分配
// ---------------------------------------------------------------------------

struct CountingAllocator;

thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    static DEALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNTING.with(|enabled| {
            if enabled.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        COUNTING.with(|enabled| {
            if enabled.get() {
                DEALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        COUNTING.with(|enabled| {
            if enabled.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocator_operations_during(run: impl FnOnce()) -> (usize, usize) {
    ALLOCATIONS.with(|count| count.set(0));
    DEALLOCATIONS.with(|count| count.set(0));
    COUNTING.with(|enabled| enabled.set(true));
    run();
    COUNTING.with(|enabled| enabled.set(false));
    (ALLOCATIONS.with(Cell::get), DEALLOCATIONS.with(Cell::get))
}

#[test]
fn steady_process_checkpoint_and_readings_are_allocation_free() {
    let settings = DynamicEqSettings {
        enabled: true,
        strength: 0.8,
        threshold_db: -30.0,
        ratio: 8.0,
        ..DynamicEqSettings::default()
    };
    let frames = 128;
    let mut processor = DynamicEqProcessor::new(48_000, settings).unwrap();
    processor
        .prepare(
            PcmFormat {
                sample_rate: 48_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            frames,
        )
        .unwrap();
    let mut samples = vec![0.125_f32; frames * 2];
    processor
        .process(PcmBlock {
            format: PcmFormat {
                sample_rate: 48_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            interleaved: &mut samples,
        })
        .unwrap();
    let mut checkpoint = processor.create_runtime_checkpoint().unwrap();
    let mut target = DynamicEqProcessor::new(48_000, settings).unwrap();
    target
        .prepare(
            PcmFormat {
                sample_rate: 48_000,
                channels: 2,
                sample_format: PcmSampleFormat::F32,
            },
            frames,
        )
        .unwrap();

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            processor
                .process(PcmBlock {
                    format: PcmFormat {
                        sample_rate: 48_000,
                        channels: 2,
                        sample_format: PcmSampleFormat::F32,
                    },
                    interleaved: &mut samples,
                })
                .unwrap();
            let _ = processor.band_readings();
            assert!(processor.save_runtime_state(checkpoint.as_mut()));
            assert!(target.restore_runtime_state(checkpoint.as_ref()));
            assert!(target.adopt_runtime_state_from(&mut processor));
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "steady process/checkpoint/readings path allocated {allocations} times and deallocated {deallocations} times"
    );
}
