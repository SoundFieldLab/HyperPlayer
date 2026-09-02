//! HSE Stage 13 Reverb 实时路径零分配验证（计数分配器法，与
//! `hyperplayer-hse-core/tests/realtime_alloc.rs` 同源范式；独立文件避免改动
//! 共享测试）。
//!
//! 覆盖面：
//! - 三种混响模式核心 stage 的 `process` 稳态零分配、零释放；
//! - typed runtime state 的 `save/restore/copy` 在快照缓冲已定容后零分配
//!   （`clone_from` 复用分配）。

use hse_core::convolver::{ConvolverOptions, ConvolverStage};
use hse_core::fdn_reverb::{FdnReverbParams, FdnReverbStage};
use hse_core::reverb_simple::{ReverbSimpleParams, ReverbSimpleStage};
use hse_core::Stage;
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

fn lcg_noise(n: usize, seed: u32) -> Vec<f32> {
    let mut u = seed;
    (0..n)
        .map(|_| {
            u = u.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (f64::from(u) / f64::from(u32::MAX) * 2.0 - 1.0) as f32
        })
        .collect()
}

#[test]
fn algorithmic_reverb_process_and_state_save_restore_are_allocation_free() {
    let frames = 256;
    let mut stage = ReverbSimpleStage::from_params(
        48_000.0,
        ReverbSimpleParams {
            room_size: 0.5,
            damping: 0.5,
            wet: 0.3,
            dry: 0.7,
            pre_delay_ms: 12.0,
            width: 1.0,
            reverb_type: "hall".into(),
        },
    )
    .unwrap();
    stage.prepare(frames);
    let mut left = lcg_noise(frames, 11);
    let mut right = lcg_noise(frames, 22);

    // 预热 + 首次快照定容（分配发生在测量窗口之外）。
    stage.process(&mut left, &mut right);
    let mut checkpoint = stage.snapshot_runtime_state();
    let mut target = ReverbSimpleStage::from_params(
        48_000.0,
        ReverbSimpleParams {
            wet: 0.9,
            ..ReverbSimpleParams {
                room_size: 0.5,
                damping: 0.5,
                wet: 0.3,
                dry: 0.7,
                pre_delay_ms: 12.0,
                width: 1.0,
                reverb_type: "hall".into(),
            }
        },
    )
    .unwrap();
    target.prepare(frames);

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            stage.process(&mut left, &mut right);
            stage.save_runtime_state(&mut checkpoint).unwrap();
            target.restore_runtime_state(&checkpoint).unwrap();
            target.copy_runtime_state_from(&stage).unwrap();
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "algorithmic reverb steady path allocated {allocations} times and deallocated {deallocations} times"
    );
}

#[test]
fn fdn_reverb_process_and_state_save_restore_are_allocation_free() {
    let frames = 256;
    let mut stage = FdnReverbStage::from_params(
        48_000.0,
        FdnReverbParams {
            room_size: 0.5,
            damping: 0.5,
            wet: 0.3,
            dry: 0.7,
            pre_delay_ms: 12.0,
            width: 1.0,
            reverb_type: "hall".into(),
            lines: Some(8.0),
        },
    )
    .unwrap();
    stage.prepare(frames);
    let mut left = lcg_noise(frames, 33);
    let mut right = lcg_noise(frames, 44);

    stage.process(&mut left, &mut right);
    let mut checkpoint = stage.snapshot_runtime_state();
    let mut target = FdnReverbStage::from_params(
        48_000.0,
        FdnReverbParams {
            wet: 0.9,
            ..FdnReverbParams {
                room_size: 0.5,
                damping: 0.5,
                wet: 0.3,
                dry: 0.7,
                pre_delay_ms: 12.0,
                width: 1.0,
                reverb_type: "hall".into(),
                lines: Some(8.0),
            }
        },
    )
    .unwrap();
    target.prepare(frames);

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            stage.process(&mut left, &mut right);
            stage.save_runtime_state(&mut checkpoint).unwrap();
            target.restore_runtime_state(&checkpoint).unwrap();
            target.copy_runtime_state_from(&stage).unwrap();
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "fdn reverb steady path allocated {allocations} times and deallocated {deallocations} times"
    );
}

#[test]
fn convolver_process_and_state_save_restore_are_allocation_free() {
    let frames = 4096;
    let mut stage = ConvolverStage::new(
        48_000.0,
        ConvolverOptions {
            partition_size: 64.0,
            long_partition_size: 256.0,
            short_region_ms: 100.0,
            de_periodize: true,
        },
    )
    .unwrap();
    let mut seed = 0x1e_f00d_u32;
    let ir: Vec<f32> = (0..512)
        .map(|index| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (f64::from(seed) / f64::from(u32::MAX) * (-6.0 * index as f64 / 512.0).exp()) as f32
        })
        .collect();
    stage.load_ir(&ir, Some("alloc-test")).unwrap();
    stage.prepare(frames);
    let mut left = lcg_noise(frames, 55);
    let mut right = lcg_noise(frames, 66);

    stage.process(&mut left, &mut right);
    let mut checkpoint = stage.snapshot_runtime_state();
    let mut target = ConvolverStage::new(
        48_000.0,
        ConvolverOptions {
            partition_size: 64.0,
            long_partition_size: 256.0,
            short_region_ms: 100.0,
            de_periodize: true,
        },
    )
    .unwrap();
    target.load_ir(&ir, Some("alloc-test")).unwrap();
    target.prepare(frames);

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..16 {
            stage.process(&mut left, &mut right);
            stage.save_runtime_state(&mut checkpoint).unwrap();
            target.restore_runtime_state(&checkpoint).unwrap();
            target.copy_runtime_state_from(&stage).unwrap();
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "convolver steady path allocated {allocations} times and deallocated {deallocations} times"
    );
}
