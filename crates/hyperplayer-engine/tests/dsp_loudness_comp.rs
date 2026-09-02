//! HSE v1.5.1 Stage 15 Loudness Compensation 适配器测试：冻结向量 parity、
//! 块长调度契约、音量 latest-wins 平滑、checkpoint/迁移、极端采样率、零分配
//! 与异常安全旁路。

use hyperplayer_engine::dsp::{
    PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat, ResetReason, RuntimeStateCapability,
};
use hyperplayer_engine::dsp_algorithms::loudness_comp::{
    LoudnessBandParam, LoudnessCompMode, LoudnessCompProcessor, LoudnessCompSettings,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    fs,
    path::{Path, PathBuf},
};

// ==================== 零分配计数分配器（参照 hse-core tests/realtime_alloc.rs） ====================

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

// ==================== 测试工具 ====================

fn format(sample_rate: u32) -> PcmFormat {
    PcmFormat {
        sample_rate,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    }
}

fn enabled_auto(volume_percent: f64, smoothing: f64) -> LoudnessCompSettings {
    LoudnessCompSettings {
        enabled: true,
        mode: LoudnessCompMode::Auto,
        volume_percent,
        max_boost_db: 12.0,
        preset: "flat".to_string(),
        smoothing_seconds: smoothing,
        bands: Vec::new(),
    }
}

fn interleaved_signal(frames: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|index| {
            let sample = ((index as f64 * 0.37).sin() * 0.7) as f32;
            [sample, -sample * 0.75]
        })
        .collect()
}

fn process(
    processor: &mut LoudnessCompProcessor,
    samples: &mut [f32],
    sample_rate: u32,
) -> hyperplayer_engine::Result<()> {
    processor.process(PcmBlock {
        format: format(sample_rate),
        interleaved: samples,
    })
}

fn drive_by_chunks(
    processor: &mut LoudnessCompProcessor,
    input: &[f32],
    block_frames: usize,
    sample_rate: u32,
) -> Vec<f32> {
    let mut samples = input.to_vec();
    let mut offset = 0;
    while offset < samples.len() {
        let end = (offset + block_frames * 2).min(samples.len());
        process(processor, &mut samples[offset..end], sample_rate).unwrap();
        offset = end;
    }
    samples
}

fn bits(samples: &[f32]) -> Vec<u32> {
    samples.iter().map(|sample| sample.to_bits()).collect()
}

// ==================== 冻结向量 parity ====================

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
    #[allow(dead_code)]
    channels: u16,
    frames: usize,
    params: Value,
    tolerance: Tolerance,
}

#[derive(Deserialize)]
struct Tolerance {
    #[allow(dead_code)]
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

fn processor_from_meta(meta: &VectorMeta) -> LoudnessCompProcessor {
    let mode = match meta.params["mode"].as_str().unwrap_or("auto") {
        "preset" => LoudnessCompMode::Preset,
        "custom" => LoudnessCompMode::Custom,
        _ => LoudnessCompMode::Auto,
    };
    let bands = meta.params["bands"]
        .as_array()
        .map(|bands| {
            bands
                .iter()
                .map(|band| LoudnessBandParam {
                    frequency: number(band, "frequency"),
                    gain: number(band, "gain"),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    LoudnessCompProcessor::new(
        meta.sample_rate,
        LoudnessCompSettings {
            // 冻结向量按模块恒处理语义回放；enabled 属引擎门控。
            enabled: true,
            mode,
            volume_percent: number(&meta.params, "volumePercent"),
            max_boost_db: number(&meta.params, "maxBoostDb"),
            preset: meta.params["preset"].as_str().unwrap_or("flat").to_string(),
            smoothing_seconds: number(&meta.params, "smoothingSeconds"),
            bands,
        },
    )
    .unwrap()
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
fn frozen_hse_vectors_match_frozen_outputs() {
    let root = fixture_root();
    let mut json_paths = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("loudness-comp.") && name.ends_with(".json"))
        })
        .collect::<Vec<_>>();
    json_paths.sort();
    assert_eq!(
        json_paths.len(),
        4,
        "loudness-comp 必须有 4 条冻结向量：{json_paths:?}"
    );

    for json_path in json_paths {
        let meta: VectorMeta = serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(meta.channels, 2);
        let label = json_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap()
            .to_string();
        let [input_left, input_right, expected_left, expected_right] =
            read_segments(&json_path.with_extension("f32"), meta.frames);
        let mut interleaved = input_left
            .iter()
            .zip(&input_right)
            .flat_map(|(&left, &right)| [left, right])
            .collect::<Vec<_>>();
        let mut processor = processor_from_meta(&meta);
        processor
            .prepare(format(meta.sample_rate), meta.block_size)
            .unwrap();
        for chunk in interleaved.chunks_mut(meta.block_size * 2) {
            processor
                .process(PcmBlock {
                    format: format(meta.sample_rate),
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

#[test]
fn case1_identity_anchor_is_bit_exact() {
    // auto 满音量锚点：volumePercent=100 → 目标全 0 → 逐位恒等（向量实证）。
    let meta_json = fs::read(fixture_root().join("loudness-comp.case1.json")).unwrap();
    let meta: VectorMeta = serde_json::from_slice(&meta_json).unwrap();
    let [input_left, input_right, expected_left, expected_right] =
        read_segments(&fixture_root().join("loudness-comp.case1.f32"), meta.frames);
    assert_eq!(
        expected_left, input_left,
        "case1 期望输出 == 输入（恒等锚点）"
    );
    assert_eq!(expected_right, input_right);

    let mut interleaved = input_left
        .iter()
        .zip(&input_right)
        .flat_map(|(&left, &right)| [left, right])
        .collect::<Vec<_>>();
    let mut processor = processor_from_meta(&meta);
    processor
        .prepare(format(meta.sample_rate), meta.block_size)
        .unwrap();
    for chunk in interleaved.chunks_mut(meta.block_size * 2) {
        processor
            .process(PcmBlock {
                format: format(meta.sample_rate),
                interleaved: chunk,
            })
            .unwrap();
    }
    assert_eq!(
        bits(&interleaved),
        {
            let mut expected = Vec::new();
            for (left, right) in input_left.iter().zip(&input_right) {
                expected.push(left.to_bits());
                expected.push(right.to_bits());
            }
            expected
        },
        "case1 适配器输出必须逐位恒等"
    );
}

// ==================== 块长调度契约 ====================

#[test]
fn block_schedule_is_reproducible_and_part_of_the_contract() {
    // HSE v1.5.1 规格 §4.3/§4.5.6：逐块平滑 alpha 依赖块长 → 输出依赖调度；
    // 同一调度逐位可复现，不同调度显著可区分（爬升型参数）。
    let input = interleaved_signal(6_000);
    let run = |block_frames: usize| {
        let mut processor = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
        processor.prepare(format(48_000), 6_000).unwrap();
        drive_by_chunks(&mut processor, &input, block_frames, 48_000)
    };
    let chunked = run(384);
    let chunked_again = run(384);
    let whole = run(6_000);
    assert_eq!(
        bits(&chunked),
        bits(&chunked_again),
        "同一调度必须逐位可复现"
    );
    let max_diff = chunked
        .iter()
        .zip(whole.iter())
        .map(|(&x, &y)| (f64::from(x) - f64::from(y)).abs())
        .fold(0.0_f64, f64::max);
    assert!(
        max_diff > 1.0e-3,
        "爬升型参数下不同块长调度应显著可区分（规格 §4.5.6），实际 maxDiff={max_diff}"
    );

    // 末块短于 prepared 容量：状态跨块保持，结果与相同调度一致。
    let mut short_tail = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    short_tail.prepare(format(48_000), 384).unwrap();
    let mut samples = input.clone();
    for offset in [0, 768, 1_536, 2_304] {
        process(&mut short_tail, &mut samples[offset..offset + 768], 48_000).unwrap();
    }
    let mut reference = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    reference.prepare(format(48_000), 6_000).unwrap();
    let expected = drive_by_chunks(&mut reference, &input, 384, 48_000);
    assert_eq!(bits(&samples[..3_072]), bits(&expected[..3_072]));
}

// ==================== 音量 latest-wins 与平滑 ====================

#[test]
fn volume_change_is_latest_wins_with_smooth_convergence() {
    // latest-wins：音量 20 → 100 中途更新后，输出与「构造后立即 set_params」
    // 的参考实例逐位一致；且与保持旧目标的实例显著可区分（新目标确实生效）。
    let prefix = interleaved_signal(768);
    let continuation = interleaved_signal(384);

    let mut updated = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    updated.prepare(format(48_000), 768).unwrap();
    let mut updated_input = prefix.clone();
    process(&mut updated, &mut updated_input, 48_000).unwrap();
    updated.set_params(enabled_auto(100.0, 0.05)).unwrap();
    let mut tail = continuation.clone();
    process(&mut updated, &mut tail, 48_000).unwrap();

    let mut reference = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    reference.prepare(format(48_000), 768).unwrap();
    let mut reference_input = prefix.clone();
    process(&mut reference, &mut reference_input, 48_000).unwrap();
    reference.set_params(enabled_auto(100.0, 0.05)).unwrap();
    let mut reference_tail = continuation.clone();
    process(&mut reference, &mut reference_tail, 48_000).unwrap();
    assert_eq!(
        bits(&tail),
        bits(&reference_tail),
        "latest-wins：统一快照语义一致"
    );

    let mut unchanged = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    unchanged.prepare(format(48_000), 768).unwrap();
    let mut unchanged_input = prefix.clone();
    process(&mut unchanged, &mut unchanged_input, 48_000).unwrap();
    let mut unchanged_tail = continuation.clone();
    process(&mut unchanged, &mut unchanged_tail, 48_000).unwrap();
    let max_diff = tail
        .iter()
        .zip(unchanged_tail.iter())
        .map(|(&x, &y)| (f64::from(x) - f64::from(y)).abs())
        .fold(0.0_f64, f64::max);
    assert!(
        max_diff > 1.0e-3,
        "音量更新后的输出应与旧目标显著可区分，实际 maxDiff={max_diff}"
    );
}

// ==================== checkpoint 与迁移 ====================

#[test]
fn checkpoint_roundtrip_preserves_smoothing_state() {
    let settings = enabled_auto(20.0, 0.05);
    let mut processor = LoudnessCompProcessor::new(48_000, settings.clone()).unwrap();
    processor.prepare(format(48_000), 768).unwrap();
    let prefix = interleaved_signal(768);
    let continuation = interleaved_signal(384);
    let mut warm = prefix.clone();
    process(&mut processor, &mut warm, 48_000).unwrap();

    let checkpoint = processor.create_runtime_checkpoint().unwrap();
    assert!(processor.runtime_checkpoint_compatible(checkpoint.as_ref()));
    let mut expected = continuation.clone();
    process(&mut processor, &mut expected, 48_000).unwrap();

    let mut replay = LoudnessCompProcessor::new(48_000, settings).unwrap();
    replay.prepare(format(48_000), 768).unwrap();
    assert!(replay.restore_runtime_state(checkpoint.as_ref()));
    let mut actual = continuation.clone();
    process(&mut replay, &mut actual, 48_000).unwrap();
    assert_eq!(
        bits(&actual),
        bits(&expected),
        "checkpoint 往返不得丢失平滑状态"
    );

    // save：延续后再保存到既有快照，恢复到另一实例同样逐位一致。
    let mut reusable = replay.create_runtime_checkpoint().unwrap();
    assert!(replay.save_runtime_state(reusable.as_mut()));
    let further = interleaved_signal(129);
    let mut expected_further = further.clone();
    process(&mut replay, &mut expected_further, 48_000).unwrap();
    let mut other = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    other.prepare(format(48_000), 384).unwrap();
    assert!(other.restore_runtime_state(reusable.as_ref()));
    let mut actual_further = further.clone();
    process(&mut other, &mut actual_further, 48_000).unwrap();
    assert_eq!(bits(&actual_further), bits(&expected_further));
}

#[test]
fn revision_swap_adopts_smoothing_state_across_params() {
    let old_settings = enabled_auto(20.0, 0.05);
    let next_settings = enabled_auto(60.0, 0.08);
    let mut previous = LoudnessCompProcessor::new(48_000, old_settings.clone()).unwrap();
    previous.prepare(format(48_000), 384).unwrap();
    let mut reference = LoudnessCompProcessor::new(48_000, old_settings.clone()).unwrap();
    reference.prepare(format(48_000), 384).unwrap();
    let mut prefix = interleaved_signal(300);
    let mut reference_prefix = prefix.clone();
    process(&mut previous, &mut prefix, 48_000).unwrap();
    process(&mut reference, &mut reference_prefix, 48_000).unwrap();

    let mut next = LoudnessCompProcessor::new(48_000, next_settings.clone()).unwrap();
    next.prepare(format(48_000), 384).unwrap();
    assert!(next.adopt_runtime_state_from(&mut previous));
    reference.set_params(next_settings.clone()).unwrap();
    let mut adopted_output = interleaved_signal(151);
    let mut reference_output = adopted_output.clone();
    process(&mut next, &mut adopted_output, 48_000).unwrap();
    process(&mut reference, &mut reference_output, 48_000).unwrap();
    assert_eq!(
        bits(&adopted_output),
        bits(&reference_output),
        "revision 迁移必须携带平滑状态并向新目标收敛"
    );

    // 采样率不符 / 异类型 / 错误 checkpoint 一律拒绝（fail closed）。
    let mut other_rate = LoudnessCompProcessor::new(44_100, next_settings.clone()).unwrap();
    other_rate.prepare(format(44_100), 16).unwrap();
    assert!(!other_rate.adopt_runtime_state_from(&mut previous));
    let checkpoint = next.create_runtime_checkpoint().unwrap();
    assert!(!other_rate.runtime_checkpoint_compatible(checkpoint.as_ref()));
    assert!(!other_rate.restore_runtime_state(checkpoint.as_ref()));
    let mut wrong_checkpoint: Box<dyn std::any::Any + Send> = Box::new(0_u64);
    assert!(!next.save_runtime_state(wrong_checkpoint.as_mut()));
    assert!(!next.restore_runtime_state(wrong_checkpoint.as_ref()));
    assert_eq!(
        next.runtime_state_capability(),
        RuntimeStateCapability::Stateful
    );
}

// ==================== 禁用透明与异常安全旁路 ====================

#[test]
fn disabled_bypass_and_error_paths_leave_buffers_untouched() {
    let mut processor =
        LoudnessCompProcessor::new(48_000, LoudnessCompSettings::default()).unwrap();
    processor.prepare(format(48_000), 8).unwrap();
    assert!(!processor.is_active());
    let mut samples = interleaved_signal(8);
    let expected = bits(&samples);
    process(&mut processor, &mut samples, 48_000).unwrap();
    assert_eq!(bits(&samples), expected, "disabled 必须逐位透明");

    // 异常安全：格式/帧完整性/容量错误在改写缓冲之前报错。
    let mut incomplete = [0.5_f32, -0.25, 1.0];
    assert!(process(&mut processor, &mut incomplete, 48_000).is_err());
    assert_eq!(incomplete, [0.5, -0.25, 1.0]);
    let mut oversized = [0.5_f32; 18];
    assert!(process(&mut processor, &mut oversized, 48_000).is_err());
    let mono = PcmFormat {
        channels: 1,
        ..format(48_000)
    };
    assert!(processor
        .process(PcmBlock {
            format: mono,
            interleaved: &mut [0.0_f32; 4],
        })
        .is_err());
    assert!(processor.prepare(format(44_100), 4).is_err());

    // reset 语义：HSE v1.5.1 §4.5.5——钉到目标、TDF2 清零，之后重放确定。
    let mut active = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    active.prepare(format(48_000), 64).unwrap();
    let mut first = interleaved_signal(64);
    process(&mut active, &mut first, 48_000).unwrap();
    active.reset(ResetReason::Seek);
    let mut replay = interleaved_signal(64);
    let mut reset_reference = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    reset_reference.prepare(format(48_000), 64).unwrap();
    // reset 钉到目标后直接到位；与全新实例（从 0 爬升）不同，但自身确定可复现。
    let mut again = interleaved_signal(64);
    process(&mut reset_reference, &mut again, 48_000).unwrap();
    process(&mut active, &mut replay, 48_000).unwrap();
    assert_ne!(
        bits(&replay),
        bits(&again),
        "reset（直接到位）与首次爬升不同"
    );
    let mut replay_again = interleaved_signal(64);
    active.reset(ResetReason::Stop);
    process(&mut active, &mut replay_again, 48_000).unwrap();
    assert_eq!(bits(&replay), bits(&replay_again), "reset 后重放确定可复现");
}

// ==================== 极端采样率 ====================

#[test]
fn extreme_sample_rates_stay_finite_and_bounded() {
    for sample_rate in [8_000_u32, 44_100, 192_000] {
        let settings = LoudnessCompSettings {
            enabled: true,
            mode: LoudnessCompMode::Auto,
            volume_percent: 0.0,
            max_boost_db: 24.0,
            preset: "flat".to_string(),
            smoothing_seconds: 0.01,
            bands: Vec::new(),
        };
        let mut processor = LoudnessCompProcessor::new(sample_rate, settings).unwrap();
        processor.prepare(format(sample_rate), 256).unwrap();
        let mut samples = interleaved_signal(256);
        process(&mut processor, &mut samples, sample_rate).unwrap();
        for (index, sample) in samples.iter().enumerate() {
            assert!(
                sample.is_finite() && sample.abs() < 1.0e5,
                "sample rate {sample_rate} 输出必须有限有界 @{index}"
            );
        }
    }
    // 采样率与 prepare 格式不符必须在准备期报错。
    let mut processor = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    processor.prepare(format(48_000), 4).unwrap();
    assert!(processor.prepare(format(96_000), 4).is_err());
}

// ==================== vendored core 一致性与契约 ====================

#[test]
fn adapter_matches_vendored_core_stage() {
    use hse_core::loudness_comp::LoudnessCompStage;
    use hse_core::Stage as HseStage;

    let settings = enabled_auto(20.0, 0.05);
    let input = interleaved_signal(600);
    let mut processor = LoudnessCompProcessor::new(48_000, settings.clone()).unwrap();
    processor.prepare(format(48_000), 600).unwrap();
    let mut via_adapter = input.clone();
    process(&mut processor, &mut via_adapter, 48_000).unwrap();

    let mut core = LoudnessCompStage::from_settings(48_000.0, settings.into()).unwrap();
    let mut left = input.iter().step_by(2).copied().collect::<Vec<_>>();
    let mut right = input.iter().skip(1).step_by(2).copied().collect::<Vec<_>>();
    core.prepare(600);
    core.process(&mut left, &mut right);
    let mut via_core = Vec::with_capacity(input.len());
    for index in 0..left.len() {
        via_core.push(left[index]);
        via_core.push(right[index]);
    }
    assert_eq!(bits(&via_adapter), bits(&via_core));
    assert_eq!(processor.name(), "loudness-comp");
    assert_eq!(processor.latency_frames(), 0);
    assert_eq!(processor.tail_frames(), 0);
}

// ==================== 零分配 ====================

#[test]
fn steady_process_and_checkpoint_path_is_allocation_free() {
    let frames = 256;
    let mut processor = LoudnessCompProcessor::new(48_000, enabled_auto(20.0, 0.05)).unwrap();
    processor.prepare(format(48_000), frames).unwrap();
    let mut samples = interleaved_signal(frames);
    let mut checkpoint = processor.create_runtime_checkpoint().unwrap();

    // 预热：先各跑一遍，避免惰性初始化计入测量窗口。
    process(&mut processor, &mut samples, 48_000).unwrap();
    assert!(processor.save_runtime_state(checkpoint.as_mut()));
    assert!(processor.restore_runtime_state(checkpoint.as_ref()));

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            let mut block = [0.25_f32; 512];
            block[0] = 0.5;
            process(&mut processor, &mut block, 48_000).unwrap();
            assert!(processor.save_runtime_state(checkpoint.as_mut()));
            assert!(processor.runtime_checkpoint_compatible(checkpoint.as_ref()));
            assert!(processor.restore_runtime_state(checkpoint.as_ref()));
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "稳态 process/checkpoint 路径分配了 {allocations} 次、释放了 {deallocations} 次"
    );
}
