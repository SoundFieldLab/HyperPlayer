//! Stage 20 Modulation 适配器实时安全门禁：稳态 process（禁用直通、启用含
//! 宽度与增益应用、路由平滑开启）全程零堆分配（对齐
//! `hse-core/tests/modulation_realtime_alloc.rs` 的计数分配器范式）。

use hyperplayer_engine::dsp::{
    PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat, ResetReason, RuntimeStateCapability,
};
use hyperplayer_engine::dsp_algorithms::modulation::{
    ModRouteSettings, ModRouteSource, ModRouteTarget, ModulationProcessor, ModulationSettings,
};
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

fn format() -> PcmFormat {
    PcmFormat {
        sample_rate: 48_000,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    }
}

fn settings(enabled: bool) -> ModulationSettings {
    ModulationSettings {
        enabled,
        lfo_shape: hyperplayer_engine::dsp_algorithms::modulation::ModLfoShape::Triangle,
        lfo_rate_hz: 3.0,
        lfo_depth: 0.8,
        envelope_attack_ms: 3.0,
        envelope_release_ms: 90.0,
        envelope_amount: 0.9,
        routes: vec![
            ModRouteSettings {
                source: ModRouteSource::Lfo,
                target: ModRouteTarget::MasterGain,
                depth: 0.35,
                polarity: 1.0,
                smoothing_ms: 30.0,
            },
            ModRouteSettings {
                source: ModRouteSource::Envelope,
                target: ModRouteTarget::StereoWidth,
                depth: 0.9,
                polarity: -1.0,
                smoothing_ms: 0.0,
            },
        ],
    }
}

#[test]
fn modulation_adapter_steady_path_is_allocation_free() {
    let capacity = 256;
    let mut active = ModulationProcessor::new(48_000.0, settings(true)).unwrap();
    let mut disabled = ModulationProcessor::new(48_000.0, settings(false)).unwrap();
    active.prepare(format(), capacity).unwrap();
    disabled.prepare(format(), capacity).unwrap();
    assert_eq!(
        active.runtime_state_capability(),
        RuntimeStateCapability::Stateful
    );

    let mut samples = vec![0.125_f32; capacity * 2];
    // 预热：读数发布与所有惰性路径就位（计数窗口外）。
    active
        .process(PcmBlock {
            format: format(),
            interleaved: &mut samples,
        })
        .unwrap();
    disabled
        .process(PcmBlock {
            format: format(),
            interleaved: &mut samples,
        })
        .unwrap();
    assert!(active.master_gain_reading().is_some());
    assert!(disabled.master_gain_reading().is_none());

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            active
                .process(PcmBlock {
                    format: format(),
                    interleaved: &mut samples,
                })
                .unwrap();
            disabled
                .process(PcmBlock {
                    format: format(),
                    interleaved: &mut samples,
                })
                .unwrap();
            active.reset(ResetReason::Stop);
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "modulation adapter steady path performed {allocations} allocations and {deallocations} deallocations"
    );
}
