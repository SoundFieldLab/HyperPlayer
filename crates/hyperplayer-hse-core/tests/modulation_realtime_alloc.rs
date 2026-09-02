//! modulation-matrix 实时安全门禁：稳态 process（含路由平滑开/关两条路径）与
//! checkpoint save-restore-copy 全程零堆分配（对齐 `limiter_realtime_alloc.rs`
//! 的计数分配器范式）。

use hse_core::modulation_matrix::{
    EnvelopeParams, LfoParams, LfoShape, ModSource, ModTarget, ModulationMatrixStage,
    ModulationRoute,
};
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

fn route(source: ModSource, target: ModTarget, amount: f64) -> ModulationRoute {
    ModulationRoute {
        source,
        target,
        amount,
        offset: 0.0,
    }
}

#[test]
fn modulation_process_checkpoint_and_smoothing_are_allocation_free() {
    let frames = 256;
    let mut left = vec![0.125_f32; frames];
    let mut right = vec![-0.125_f32; frames];

    let build = |smoothing: bool| {
        let mut stage = ModulationMatrixStage::new(48_000.0).unwrap();
        let routes = vec![
            route(ModSource::Lfo, ModTarget::MasterGain, 0.5),
            route(ModSource::Envelope, ModTarget::StereoWidth, 0.9),
        ];
        if smoothing {
            stage.set_routes_with_smoothing(routes, vec![30.0, 0.0]);
        } else {
            stage.set_routes(routes);
        }
        stage.set_lfo_params(LfoParams {
            shape: LfoShape::Triangle,
            rate_hz: 3.0,
            depth: 0.8,
        });
        stage.set_envelope_params(EnvelopeParams {
            attack_ms: 3.0,
            release_ms: 90.0,
            amount: 0.9,
        });
        stage
    };

    let mut source = build(true);
    let mut target = build(false);

    // 预热：让快照 Vec 建立容量、让所有惰性路径就位（计数窗口外）。
    source.process(&mut left, &mut right);
    target.process(&mut left, &mut right);
    let mut checkpoint = source.snapshot_runtime_state();
    target.restore_runtime_state(&checkpoint).unwrap();
    target.copy_runtime_state_from(&source).unwrap();

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            // 平滑开启路径（route_smoothed 推进）与关闭路径（raw 旁路）。
            source.process(&mut left, &mut right);
            target.process(&mut left, &mut right);
            source.save_runtime_state(&mut checkpoint).unwrap();
            target.restore_runtime_state(&checkpoint).unwrap();
            target.copy_runtime_state_from(&source).unwrap();
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "modulation steady path performed {allocations} allocations and {deallocations} deallocations"
    );
}
