//! Stage 22 Spatial/HRTF 生产接线测试（engine 链级 + 适配器契约）。
//!
//! 覆盖：链级 22 位顺序与默认透明、真实渲染路径（合成 SOFA 资源经 SHA-256
//! 校验加载）、资源缺失/hash 错误的显式回退、latency/tail 如实上报、块切分
//! 逐位一致、checkpoint 往返与零分配（分区卷积稳态路径）。
//!
//! 真实 MIT KEMAR 资产的端到端验证为 ignored 测试（全网格解析耗时，不进默认
//! 测试路径），见文件尾 `real_kemar_asset_end_to_end` 与
//! `provenance/hrtf-mit-kemar/README.md`。

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    path::{Path, PathBuf},
};

use hyperplayer_engine::dsp::{PcmFormat, PcmSampleFormat, ProcessorChain, ResetReason};
use hyperplayer_engine::dsp_algorithms::limiter::LimiterSettings;
use hyperplayer_engine::dsp_algorithms::{
    prepare_dsp_chain, spatial::SpatialResourceSpec, DspConfig, SpatialMode, SpatialSettings,
};

// ---------------------------------------------------------------------------
// 零分配计数分配器（范式同 hrtf-core tests/realtime_alloc.rs）。
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

// ---------------------------------------------------------------------------
// fixture：合成 SimpleFreeFieldHRIR SOFA（hrtf-core test-fixtures 生成器）。
// ---------------------------------------------------------------------------

const SAMPLE_RATE: u32 = 48_000;
const FILTER_LEN: usize = 16;

fn format() -> PcmFormat {
    PcmFormat {
        sample_rate: SAMPLE_RATE,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    }
}

fn fixture_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hyperplayer-engine-spatial-{}-{label}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("create fixture dir");
    dir
}

/// 生成合成 SOFA 并以「文件实际 hash」构造资源引用（验证合法路径）。
fn verified_spec(dir: &Path, name: &str) -> SpatialResourceSpec {
    let bytes =
        hrtf_core::fixtures::synthetic_hrir_sofa(SAMPLE_RATE as f32, FILTER_LEN, 1.0, 0.5, 0.0);
    let path = dir.join(name);
    std::fs::write(&path, &bytes).expect("write synthetic sofa");
    SpatialResourceSpec {
        path,
        expected_sha256_hex: hrtf_core::sha256_digest_hex(&bytes),
    }
}

fn spatial_settings(mode: SpatialMode, resource: Option<SpatialResourceSpec>) -> SpatialSettings {
    SpatialSettings {
        mode,
        resource,
        ..SpatialSettings::default()
    }
}

fn config_with_spatial(settings: SpatialSettings) -> DspConfig {
    DspConfig {
        spatial: settings,
        ..DspConfig::default()
    }
}

fn signal(frames: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|index| {
            let sample = ((index as f64 * 0.37).sin() * 0.6) as f32;
            [sample, sample * -0.75]
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 测试。
// ---------------------------------------------------------------------------

#[test]
fn chain_default_is_transparent_and_reports_zero_latency() {
    // 22 位顺序断言在 dsp_algorithms::tests 的链级金样（含 "spatial" 链尾）；
    // 这里验证默认配置的全链透明与零延迟折叠。
    let prepared = prepare_dsp_chain(1, format(), 8, DspConfig::default()).unwrap();
    assert_eq!(prepared.snapshot().latency_frames, 0);
    assert_eq!(prepared.snapshot().tail_frames, 0);
    let mut chain = ProcessorChain::from_prepared(prepared);
    let mut samples = [
        -0.0_f32,
        0.25,
        -0.5,
        1.0,
        0.75,
        -0.25,
        0.0,
        f32::MIN_POSITIVE,
    ];
    let expected = samples.map(f32::to_bits);
    chain.process(format(), &mut samples, 0).unwrap();
    assert_eq!(samples.map(f32::to_bits), expected);
}

#[test]
fn verified_resource_builds_active_renderer_with_honest_latency() {
    let dir = fixture_dir("verified");
    let spec = verified_spec(&dir, "kemar-synthetic.sofa");
    let settings = spatial_settings(SpatialMode::Instant, Some(spec));
    let prepared = prepare_dsp_chain(1, format(), 256, config_with_spatial(settings)).unwrap();
    // 默认 partitioned 卷积：延迟 = 分区大小（64），tail = 延迟 + HRIR 长度。
    assert_eq!(prepared.snapshot().latency_frames, 64);
    assert_eq!(prepared.snapshot().tail_frames, (64 + FILTER_LEN) as u32);
    let mut chain = ProcessorChain::from_prepared(prepared);
    let mut samples = signal(256);
    chain.process(format(), &mut samples, 0).unwrap();
    // 空间渲染在参与（非直通）：输出与输入不同，且有限值。
    assert_ne!(samples, signal(256));
    assert!(samples.iter().all(|sample| sample.is_finite()));
}

#[test]
fn hash_mismatch_and_missing_file_fall_back_to_explicit_bypass() {
    let dir = fixture_dir("fallback");
    // hash 错误：文件在、期望 hash 是合法格式但与内容不符。
    let wrong_hash = SpatialResourceSpec {
        path: {
            let bytes = hrtf_core::fixtures::synthetic_hrir_sofa(
                SAMPLE_RATE as f32,
                FILTER_LEN,
                1.0,
                0.5,
                0.0,
            );
            let path = dir.join("wrong-hash.sofa");
            std::fs::write(&path, &bytes).unwrap();
            path
        },
        expected_sha256_hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            .into(),
    };
    let missing = SpatialResourceSpec {
        path: dir.join("missing.sofa"),
        expected_sha256_hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            .into(),
    };
    for spec in [wrong_hash, missing] {
        let settings = spatial_settings(SpatialMode::World, Some(spec));
        let prepared = prepare_dsp_chain(1, format(), 64, config_with_spatial(settings)).unwrap();
        // 渲染器不可用 → 逐位直通、无 latency/tail；播放不受影响。
        assert_eq!(prepared.snapshot().latency_frames, 0);
        assert_eq!(prepared.snapshot().tail_frames, 0);
        let mut chain = ProcessorChain::from_prepared(prepared);
        let mut samples = signal(64);
        let expected = samples.clone();
        chain.process(format(), &mut samples, 0).unwrap();
        assert_eq!(samples, expected, "资源不可用必须逐位直通");
    }
}

#[test]
fn spatial_is_chunk_invariant_in_partitioned_mode() {
    let dir = fixture_dir("chunks");
    let spec = verified_spec(&dir, "kemar-synthetic.sofa");
    let config = config_with_spatial(spatial_settings(SpatialMode::Stage, Some(spec)));
    let input = signal(1_503);
    let run = |chunks: &[usize]| {
        let mut chain = ProcessorChain::from_prepared(
            prepare_dsp_chain(1, format(), 1_503, config.clone()).unwrap(),
        );
        let mut samples = input.clone();
        let mut offset = 0_usize;
        for (index, &frames) in chunks.iter().enumerate() {
            chain
                .process(
                    format(),
                    &mut samples[offset * 2..(offset + frames) * 2],
                    (index * 1_503) as u64,
                )
                .unwrap();
            offset += frames;
        }
        samples
    };
    let whole = run(&[1_503]);
    let split = run(&[521, 521, 461]);
    assert_eq!(whole, split, "分块必须与整块逐位一致");
}

#[test]
fn checkpoint_roundtrip_restores_clean_renderer_state() {
    let dir = fixture_dir("checkpoint");
    let spec = verified_spec(&dir, "kemar-synthetic.sofa");
    let config = config_with_spatial(spatial_settings(SpatialMode::Instant, Some(spec)));
    let mut chain =
        ProcessorChain::from_prepared(prepare_dsp_chain(1, format(), 128, config).unwrap());
    let prefix = signal(128);
    let mut warmed = prefix.clone();
    chain.process(format(), &mut warmed, 0).unwrap();

    chain.begin_speculative_processing().unwrap();
    let mut speculative = signal(128);
    chain.process(format(), &mut speculative, 128).unwrap();
    chain.restore_speculative_processing().unwrap();

    // 回滚后重放同一输入，与「从未投机」的等价新链逐位一致
    // （干净渲染器状态 + 确定性 slot/布局语义）。
    let mut fresh = ProcessorChain::from_prepared(
        prepare_dsp_chain(
            1,
            format(),
            128,
            config_with_spatial(spatial_settings(
                SpatialMode::Instant,
                Some(verified_spec(
                    &fixture_dir("checkpoint-fresh"),
                    "kemar-synthetic.sofa",
                )),
            )),
        )
        .unwrap(),
    );
    let mut replay = signal(128);
    chain.process(format(), &mut replay, 128).unwrap();
    let mut fresh_out = signal(128);
    fresh.process(format(), &mut fresh_out, 128).unwrap();
    assert_eq!(replay, fresh_out, "回滚后重放必须回到确定性状态");
    assert!(chain.snapshot().fault.is_none());
}

#[test]
fn spatial_process_is_allocation_free_after_prepare() {
    let dir = fixture_dir("alloc");
    let spec = verified_spec(&dir, "kemar-synthetic.sofa");
    let config = config_with_spatial(spatial_settings(SpatialMode::Instant, Some(spec)));
    let mut chain =
        ProcessorChain::from_prepared(prepare_dsp_chain(1, format(), 256, config).unwrap());
    let mut warmup = vec![0.0_f32; 512];
    chain.process(format(), &mut warmup, 0).unwrap();

    let mut samples = signal(256);
    let (allocations, deallocations) = allocator_operations_during(|| {
        for index in 0..16 {
            chain.process(format(), &mut samples, index * 256).unwrap();
        }
    });
    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "spatial 稳态 process 执行了 {allocations} 次分配 / {deallocations} 次释放"
    );
}

#[test]
fn reset_reason_clears_renderer_state_and_matches_fresh_instance() {
    let dir = fixture_dir("reset");
    let spec = verified_spec(&dir, "kemar-synthetic.sofa");
    let config = config_with_spatial(spatial_settings(SpatialMode::Instant, Some(spec)));
    let mut chain =
        ProcessorChain::from_prepared(prepare_dsp_chain(1, format(), 64, config.clone()).unwrap());
    let mut warmed = signal(64);
    chain.process(format(), &mut warmed, 0).unwrap();
    chain.reset(ResetReason::Seek);
    let mut next = signal(32);
    chain.process(format(), &mut next, 0).unwrap();

    let mut fresh =
        ProcessorChain::from_prepared(prepare_dsp_chain(1, format(), 64, config).unwrap());
    let mut fresh_expected = signal(32);
    fresh.process(format(), &mut fresh_expected, 0).unwrap();
    assert_eq!(next, fresh_expected, "reset 后必须与等价新链一致");
}

#[test]
fn disabled_limiter_and_active_spatial_summarize_chain_latency() {
    // 空间开启 + limiter 关闭：链级 latency 全部来自 spatial（如实折叠）。
    let dir = fixture_dir("latency");
    let spec = verified_spec(&dir, "kemar-synthetic.sofa");
    let mut config = config_with_spatial(spatial_settings(SpatialMode::HeadLocked, Some(spec)));
    config.limiter = LimiterSettings {
        enabled: false,
        ..LimiterSettings::default()
    };
    let prepared = prepare_dsp_chain(1, format(), 128, config).unwrap();
    assert_eq!(prepared.snapshot().latency_frames, 64);
}

/// 真实 MIT KEMAR 资产端到端（ignored：完整网格解析 + 重采样耗时不进默认路径）。
///
/// 运行：`HSE_TEST_SOFA=assets/hrtf/mit-kemar-normal-pinna.sofa cargo test -p
/// hyperplayer-engine --test dsp_spatial_adapter -- --ignored`（默认路径即仓库
/// 资产，环境变量仅用于显式覆盖）。
#[test]
#[ignore = "真实 MIT KEMAR 全网格验证，耗时较长；按 provenance README 门禁手动运行"]
fn real_kemar_asset_end_to_end() {
    let path = std::env::var_os("HSE_TEST_SOFA").map_or_else(
        || {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest
                .join("..")
                .join("..")
                .join("assets")
                .join("hrtf")
                .join("mit-kemar-normal-pinna.sofa")
        },
        PathBuf::from,
    );
    let bytes = std::fs::read(&path).expect("读取仓库 MIT KEMAR 资产");
    let spec = SpatialResourceSpec {
        path,
        expected_sha256_hex: hrtf_core::sha256_digest_hex(&bytes),
    };
    let config = config_with_spatial(spatial_settings(SpatialMode::Stage, Some(spec)));
    let mut chain =
        ProcessorChain::from_prepared(prepare_dsp_chain(1, format(), 512, config).unwrap());
    assert_eq!(chain.snapshot().latency_frames, 64);
    let mut samples = signal(512);
    chain.process(format(), &mut samples, 0).unwrap();
    assert!(samples.iter().all(|sample| sample.is_finite()));
    assert_ne!(samples, signal(512), "真实资产渲染必须产生双耳差异");
}
