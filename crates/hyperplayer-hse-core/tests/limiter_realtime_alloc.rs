//! limiter 实时安全门禁：稳态 process / checkpoint save-restore-copy / drain
//! 全程零堆分配（对齐 `realtime_alloc.rs` 的计数分配器范式）。

use hse_core::limiter::{LimiterSettings, LimiterStage};
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

#[test]
fn limiter_process_checkpoint_and_drain_are_allocation_free() {
    let frames = 128;
    let mut left = vec![0.125_f32; frames];
    let mut right = vec![-0.125_f32; frames];

    let params = LimiterSettings {
        enabled: true,
        threshold_db: -3.0,
        lookahead_ms: 2.5,
        attack_ms: 0.5,
        release_ms: 80.0,
        true_peak: true,
    };
    let target_params = LimiterSettings {
        threshold_db: -6.0,
        release_ms: 120.0,
        ..params.clone()
    };
    let mut source = LimiterStage::from_settings(48_000.0, params).unwrap();
    let mut target = LimiterStage::from_settings(48_000.0, target_params).unwrap();

    // 预热：让快照 Vec 建立容量、让所有惰性路径就位（计数窗口外）。
    source.process(&mut left, &mut right);
    let mut checkpoint = source.snapshot_runtime_state();
    target.restore_runtime_state(&checkpoint).unwrap();
    target.copy_runtime_state_from(&source).unwrap();
    let mut drain_l = vec![0.0_f32; 37];
    let mut drain_r = vec![0.0_f32; 37];
    while source.drain(&mut drain_l, &mut drain_r) > 0 {}
    target.process(&mut left, &mut right);
    while target.drain(&mut drain_l, &mut drain_r) > 0 {}

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            source.process(&mut left, &mut right);
            source.save_runtime_state(&mut checkpoint).unwrap();
            target.restore_runtime_state(&checkpoint).unwrap();
            target.copy_runtime_state_from(&source).unwrap();
            // 分次排空：覆盖 drain 游标推进与完全排空后的清空分支。
            while source.drain(&mut drain_l, &mut drain_r) > 0 {}
            while target.drain(&mut drain_l, &mut drain_r) > 0 {}
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "limiter steady path performed {allocations} allocations and {deallocations} deallocations"
    );
}
