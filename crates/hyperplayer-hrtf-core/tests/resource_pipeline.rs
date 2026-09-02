//! 外部 HRTF 资源注入 API 的验收测试（Stage 22 受限范围）。
//!
//! 覆盖：正常加载与 identity 记录、hash 不匹配、文件缺失、损坏数据、
//! 采样率不支持、重载切换与失败回退、资源失败后的渲染旁路（零分配）。
//!
//! 全部使用 `common::synthetic_hrir_sofa` 程序化生成的合成
//! SimpleFreeFieldHRIR 数据，不依赖任何真实 SOFA 资产（资产合规审计
//! 未完成，产品接线受阻）。

mod common;

use std::path::PathBuf;

use hrtf_core::{
    sha256_digest_hex, BinauralRenderer, DistanceModel, DistanceParams, HrtfResourceDescriptor,
    HrtfResourceManager, HrtfResourceProvenance, ObjectInput, RenderProfile, ResourceError,
    SofaError, SofaGridOptions,
};

/// 合成资源的渲染参数。
const SAMPLE_RATE: u32 = 48_000;
const FILTER_LEN: usize = 16;

fn grid_options(sample_rate: u32) -> SofaGridOptions {
    SofaGridOptions {
        sample_rate,
        ..SofaGridOptions::default()
    }
}

fn provenance(label: &str) -> HrtfResourceProvenance {
    HrtfResourceProvenance::new(
        format!("synthetic-fixture-{label}"),
        "1.0.0-test",
        "generated in-test (no redistributable asset)",
        "Apache-2.0 (test code only)",
        "合成测试数据，不代表任何真实 HRTF 资产；产品资产待合规审计",
    )
}

/// 按文件实际内容计算 hash 并构造描述符。
fn descriptor_for(path: PathBuf, label: &str) -> HrtfResourceDescriptor {
    let bytes = std::fs::read(&path).expect("read fixture file");
    let hash = sha256_digest_hex(&bytes);
    HrtfResourceDescriptor::new(
        path,
        hash,
        SAMPLE_RATE,
        provenance(label),
        grid_options(SAMPLE_RATE),
    )
    .expect("descriptor must be valid")
}

/// 生成并落盘一份默认合成资源。
fn fixture(dir: &std::path::Path, name: &str, left_peak: f32, right_peak: f32) -> PathBuf {
    let bytes =
        common::synthetic_hrir_sofa(SAMPLE_RATE as f32, FILTER_LEN, left_peak, right_peak, 0.0);
    common::write_synthetic_sofa(dir, name, &bytes)
}

#[test]
fn verified_resource_loads_and_reports_identity() {
    let dir = common::temp_dir("load-identity");
    let path = fixture(&dir, "primary.sofa", 1.0, 1.0);

    let mut manager = HrtfResourceManager::new();
    assert!(!manager.is_available());
    assert!(manager.identity().is_none());
    assert!(manager.grid().is_none());

    let descriptor = descriptor_for(path, "primary");
    let expected_hash = descriptor.expected_sha256_hex.clone();
    let identity = manager.install(&descriptor).expect("install must succeed");

    assert!(manager.is_available());
    assert_eq!(identity.sha256_hex, expected_hash);
    assert_eq!(identity.sample_rate, SAMPLE_RATE);
    // 默认网格：方位角 -180..175 步进 5° → 72 个；仰角 -90..90 步进 5° → 37 个。
    assert_eq!(identity.azimuth_count, 72);
    assert_eq!(identity.elevation_count, 37);
    assert_eq!(identity.hrir_length, FILTER_LEN);
    assert_eq!(identity.provenance.name, "synthetic-fixture-primary");
    assert_eq!(identity.provenance.license, "Apache-2.0 (test code only)");
    assert!(manager.identity().is_some());

    // 身份查询 API 返回同一份记录。
    assert_eq!(manager.identity().unwrap(), &identity);

    // 网格可直接构建渲染器并产出非零双声道输出。
    let grid = manager.grid().expect("grid available").clone();
    let mut renderer = BinauralRenderer::new(
        grid,
        RenderProfile::LowLatency,
        DistanceModel::Inverse,
        DistanceParams::default(),
    )
    .expect("renderer construction");
    renderer.prepare(1, 8).expect("prepare");
    let input = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let mut left = [0.0; 8];
    let mut right = [0.0; 8];
    renderer
        .process(
            &[ObjectInput {
                slot: 0,
                mono: &input,
                azimuth_deg: 0.0,
                elevation_deg: 0.0,
                distance: 1.0,
                gain: 1.0,
            }],
            &mut left,
            &mut right,
            8,
        )
        .expect("render");
    assert!(left.iter().any(|sample| *sample != 0.0));
    assert!(right.iter().any(|sample| *sample != 0.0));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hash_mismatch_rejects_load_and_keeps_previous_resource() {
    let dir = common::temp_dir("hash-mismatch");
    let path = fixture(&dir, "primary.sofa", 1.0, 1.0);

    let mut manager = HrtfResourceManager::new();
    let first = descriptor_for(path.clone(), "primary");
    manager.install(&first).expect("initial install");
    let original_identity = manager.identity().cloned().expect("identity");

    // 内容被替换（峰值不同）但期望 hash 仍是旧文件的：必须拒绝。
    let altered = common::synthetic_hrir_sofa(SAMPLE_RATE as f32, FILTER_LEN, 0.5, 1.0, 0.0);
    std::fs::write(&path, &altered).expect("rewrite fixture");
    let stale_descriptor = HrtfResourceDescriptor::new(
        path,
        first.expected_sha256_hex.clone(),
        SAMPLE_RATE,
        provenance("stale-hash"),
        grid_options(SAMPLE_RATE),
    )
    .expect("descriptor valid");

    let error = manager
        .install(&stale_descriptor)
        .expect_err("hash mismatch must fail");
    match &error {
        ResourceError::HashMismatch { expected, actual } => {
            assert_eq!(expected, &first.expected_sha256_hex);
            assert_eq!(actual, &sha256_digest_hex(&altered));
        }
        other => panic!("expected HashMismatch, got {other:?}"),
    }

    // 失败回退：上一个已验证资源保持原样，绝不静默使用新数据。
    assert_eq!(manager.identity(), Some(&original_identity));
    assert!(manager.is_available());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_file_is_reported_and_manager_falls_back() {
    let dir = common::temp_dir("missing-file");
    let path = fixture(&dir, "primary.sofa", 1.0, 1.0);

    // 无任何已验证资源时失败 → 不可用状态。
    let mut manager = HrtfResourceManager::new();
    let ghost = HrtfResourceDescriptor::new(
        dir.join("does-not-exist.sofa"),
        "0".repeat(64),
        SAMPLE_RATE,
        provenance("ghost"),
        grid_options(SAMPLE_RATE),
    )
    .expect("descriptor valid");
    assert!(matches!(
        manager.install(&ghost),
        Err(ResourceError::FileMissing { .. })
    ));
    assert!(!manager.is_available());

    // 已有资源时失败 → 保留上一个已验证资源。
    manager.install(&descriptor_for(path, "primary")).unwrap();
    assert!(matches!(
        manager.install(&ghost),
        Err(ResourceError::FileMissing { .. })
    ));
    assert!(manager.is_available());
    assert_eq!(
        manager.identity().unwrap().provenance.name,
        "synthetic-fixture-primary"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn corrupt_data_is_rejected_even_with_matching_hash() {
    let dir = common::temp_dir("corrupt-data");
    let path = fixture(&dir, "primary.sofa", 1.0, 1.0);

    // 破坏根组 OHDR 签名（结构性损坏）：hash 重算后一致，但解析必须失败。
    let mut corrupted = std::fs::read(&path).expect("read fixture");
    corrupted[80] ^= 0xFF;
    let corrupted_path = common::write_synthetic_sofa(&dir, "corrupted.sofa", &corrupted);
    let descriptor = descriptor_for(corrupted_path, "corrupted");

    let mut manager = HrtfResourceManager::new();
    let error = manager
        .install(&descriptor)
        .expect_err("corrupt data must fail");
    match &error {
        ResourceError::Sofa(SofaError::Parse(_)) => {}
        other => panic!("expected Sofa(Parse), got {other:?}"),
    }
    assert!(!manager.is_available());

    // 对照组：仅破坏数据字节而不更新 hash → hash 校验先行拒绝。
    let mut tampered = std::fs::read(&path).expect("read fixture");
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    let tampered_path = common::write_synthetic_sofa(&dir, "tampered.sofa", &tampered);
    let stale = HrtfResourceDescriptor::new(
        tampered_path,
        sha256_digest_hex(&std::fs::read(&path).expect("read fixture")),
        SAMPLE_RATE,
        provenance("tampered"),
        grid_options(SAMPLE_RATE),
    )
    .expect("descriptor valid");
    assert!(matches!(
        manager.install(&stale),
        Err(ResourceError::HashMismatch { .. })
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unsupported_sample_rates_are_rejected_explicitly() {
    let dir = common::temp_dir("sample-rate");

    // 描述符采样率不受支持（88200 Hz）。
    let path = fixture(&dir, "primary.sofa", 1.0, 1.0);
    let bytes = std::fs::read(&path).expect("read fixture");
    let descriptor = HrtfResourceDescriptor::new(
        path,
        sha256_digest_hex(&bytes),
        88_200,
        provenance("bad-rate"),
        grid_options(88_200),
    )
    .expect_err("descriptor rate must be validated");
    assert!(matches!(
        descriptor,
        ResourceError::UnsupportedSampleRate { rate: 88_200 }
    ));

    // 描述符合法但文件内部采样率不受支持（22050 Hz）→ SOFA 校验拒绝。
    let odd = common::synthetic_hrir_sofa(22_050.0, FILTER_LEN, 1.0, 1.0, 0.0);
    let odd_path = common::write_synthetic_sofa(&dir, "odd-rate.sofa", &odd);
    let odd_descriptor = descriptor_for(odd_path, "odd-rate");
    let mut manager = HrtfResourceManager::new();
    match manager
        .install(&odd_descriptor)
        .expect_err("odd rate must fail")
    {
        ResourceError::Sofa(SofaError::SampleRateMismatch { source, .. }) => {
            assert!((source - 22_050.0).abs() < 0.1);
        }
        other => panic!("expected SampleRateMismatch, got {other:?}"),
    }
    assert!(!manager.is_available());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reload_switches_resource_and_failure_falls_back_to_previous() {
    let dir = common::temp_dir("reload-fallback");
    let path_a = fixture(&dir, "a.sofa", 1.0, 1.0);
    let path_b = fixture(&dir, "b.sofa", 0.5, 1.0);

    let mut manager = HrtfResourceManager::new();
    manager.install(&descriptor_for(path_a, "a")).unwrap();
    let identity_a = manager.identity().cloned().unwrap();

    // 成功重载：identity 与网格整体切换。
    let descriptor_b = descriptor_for(path_b, "b");
    let identity_b = manager.install(&descriptor_b).expect("reload must succeed");
    assert_ne!(identity_b.sha256_hex, identity_a.sha256_hex);
    assert_eq!(manager.identity(), Some(&identity_b));

    let render_with_current = |manager: &HrtfResourceManager| -> [f32; 8] {
        let grid = manager.grid().expect("grid").clone();
        let mut renderer = BinauralRenderer::new(
            grid,
            RenderProfile::LowLatency,
            DistanceModel::Inverse,
            DistanceParams::default(),
        )
        .unwrap();
        renderer.prepare(1, 8).unwrap();
        let input = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let mut left = [0.0; 8];
        let mut right = [0.0; 8];
        renderer
            .process(
                &[ObjectInput {
                    slot: 0,
                    mono: &input,
                    azimuth_deg: 90.0,
                    elevation_deg: 0.0,
                    distance: 1.0,
                    gain: 1.0,
                }],
                &mut left,
                &mut right,
                8,
            )
            .unwrap();
        left
    };

    let output_b = render_with_current(&manager);
    assert!(output_b.iter().any(|sample| *sample != 0.0));

    // 失败重载（文件缺失）：管理器保留 B，渲染结果与之前完全一致。
    let ghost = HrtfResourceDescriptor::new(
        dir.join("missing.sofa"),
        "f".repeat(64),
        SAMPLE_RATE,
        provenance("ghost"),
        grid_options(SAMPLE_RATE),
    )
    .expect("descriptor valid");
    assert!(matches!(
        manager.install(&ghost),
        Err(ResourceError::FileMissing { .. })
    ));
    assert_eq!(manager.identity(), Some(&identity_b));
    assert_eq!(render_with_current(&manager), output_b);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unload_returns_to_unavailable_state() {
    let dir = common::temp_dir("unload");
    let path = fixture(&dir, "primary.sofa", 1.0, 1.0);

    let mut manager = HrtfResourceManager::new();
    manager.install(&descriptor_for(path, "primary")).unwrap();
    let identity = manager.identity().cloned().expect("identity");

    let unloaded = manager.unload().expect("unload returns identity");
    assert_eq!(unloaded, identity);
    assert!(!manager.is_available());
    assert!(manager.identity().is_none());
    assert!(manager.grid().is_none());
    assert!(manager.unload().is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 资源失败后的渲染旁路：沿用 realtime_alloc.rs 的计数分配器模式，断言在
// 资源重载失败、回退到上一个已验证资源后，实时 process 仍然零分配。
// ---------------------------------------------------------------------------

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

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
fn renderer_process_is_allocation_free_after_failed_reload_fallback() {
    let dir = common::temp_dir("bypass-zero-alloc");
    let path = fixture(&dir, "primary.sofa", 1.0, 1.0);

    let mut manager = HrtfResourceManager::new();
    manager.install(&descriptor_for(path, "primary")).unwrap();

    // 制造一次资源失败：文件被删除后重载必须失败且不影响当前资源。
    std::fs::remove_file(dir.join("primary.sofa")).expect("remove fixture");
    let stale = descriptor_for_from_hash(dir.join("primary.sofa"));
    assert!(matches!(
        manager.install(&stale),
        Err(ResourceError::FileMissing { .. })
    ));
    assert!(manager.is_available(), "previous resource must survive");

    // 用上一个已验证资源重建渲染器（宿主旁路决策后的正常路径）。
    let grid = manager.grid().expect("grid").clone();
    let mut renderer = BinauralRenderer::new(
        grid,
        RenderProfile::LowLatency,
        DistanceModel::Inverse,
        DistanceParams::default(),
    )
    .unwrap();
    const OBJECTS: usize = 4;
    const FRAMES: usize = 128;
    renderer.prepare(OBJECTS, FRAMES).unwrap();

    let inputs = vec![vec![0.25; FRAMES]; OBJECTS];
    let objects: Vec<_> = inputs
        .iter()
        .enumerate()
        .map(|(slot, mono)| ObjectInput {
            slot,
            mono,
            azimuth_deg: slot as f32 * 30.0,
            elevation_deg: 0.0,
            distance: 1.0 + slot as f32,
            gain: 1.0,
        })
        .collect();
    let mut left = vec![0.0; FRAMES];
    let mut right = vec![0.0; FRAMES];
    renderer
        .process(&objects, &mut left, &mut right, FRAMES)
        .unwrap();

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..16 {
            renderer
                .process(&objects, &mut left, &mut right, FRAMES)
                .unwrap();
        }
    });
    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "renderer process performed {allocations} allocations and {deallocations} deallocations"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 为已被删除的文件构造描述符（hash 用占位值：加载会先命中 FileMissing）。
fn descriptor_for_from_hash(path: PathBuf) -> HrtfResourceDescriptor {
    HrtfResourceDescriptor::new(
        path,
        "0".repeat(64),
        SAMPLE_RATE,
        provenance("stale"),
        grid_options(SAMPLE_RATE),
    )
    .expect("descriptor valid")
}
