//! HSE Stage 21 Limiter 适配器的引擎级门禁：零分配稳态、链级 latency 折叠、
//! 链级 drain 语义。核心算法行为由 hse-core 内嵌测试与冻结向量对拍覆盖；
//! 本文件聚焦 HyperPlayer `PcmProcessor` 契约。

use hyperplayer_engine::dsp::{
    PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat, PreparedProcessorChain, ProcessorChain,
    ResetReason,
};
use hyperplayer_engine::dsp_algorithms::limiter::{LimiterProcessor, LimiterSettings};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

fn format(sample_rate: u32) -> PcmFormat {
    PcmFormat {
        sample_rate,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    }
}

fn enabled(threshold_db: f64, lookahead_ms: f64, true_peak: bool) -> LimiterSettings {
    LimiterSettings {
        enabled: true,
        threshold_db,
        lookahead_ms,
        attack_ms: 0.5,
        release_ms: 150.0,
        true_peak,
    }
}

fn prepared(sample_rate: f64, settings: LimiterSettings, capacity: usize) -> Harness {
    let mut processor = LimiterProcessor::new(sample_rate, settings).unwrap();
    processor
        .prepare(format(sample_rate as u32), capacity)
        .unwrap();
    Harness {
        processor,
        sample_rate: sample_rate as u32,
    }
}

/// 记录采样率的处理器句柄（测试辅助；sample_rate 是 processor 私有字段）。
struct Harness {
    processor: LimiterProcessor,
    sample_rate: u32,
}

impl Harness {
    fn process(&mut self, samples: &mut [f32]) {
        self.processor
            .process(PcmBlock {
                format: format(self.sample_rate),
                interleaved: samples,
            })
            .unwrap();
    }

    fn drain_tail(&mut self, samples: &mut [f32]) -> usize {
        self.processor.drain_tail(samples).unwrap()
    }

    fn latency_frames(&self) -> u32 {
        self.processor.latency_frames()
    }

    fn tail_frames(&self) -> u32 {
        self.processor.tail_frames()
    }

    fn reduction_reading(&self) -> f64 {
        self.processor.reduction_reading().unwrap().value_db
    }

    fn peak_reading(&self) -> f64 {
        self.processor.peak_reading().unwrap().value_db
    }
}

// ---- 零分配门禁（独立测试二进制的计数分配器）----

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
fn limiter_adapter_steady_state_is_allocation_free() {
    let settings = enabled(-3.0, 2.5, true);
    let mut processor = prepared(48_000.0, settings, 512);
    let mut samples = vec![0.25_f32; 512];

    // 预热：checkpoint 容量建立、惰性路径就位（计数窗口外）。
    processor.process(&mut samples);
    let mut checkpoint = processor.processor.create_runtime_checkpoint().unwrap();
    assert!(processor.processor.save_runtime_state(checkpoint.as_mut()));
    let mut drain = vec![0.0_f32; 512];
    while processor.drain_tail(&mut drain) > 0 {}
    processor.process(&mut samples);

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            processor.process(&mut samples);
            assert!(processor.processor.save_runtime_state(checkpoint.as_mut()));
            assert!(processor
                .processor
                .restore_runtime_state(checkpoint.as_ref()));
            while processor.drain_tail(&mut drain) > 0 {}
            processor.process(&mut samples);
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "limiter adapter performed {allocations} allocations and {deallocations} deallocations"
    );
}

#[test]
fn chain_folds_limiter_latency_and_reports_honest_tail() {
    // 单 limiter：链 latency = lookahead（240 @5ms/48kHz）。
    let prepared = PreparedProcessorChain::prepare(
        1,
        format(48_000),
        256,
        vec![Box::new(
            LimiterProcessor::new(48_000.0, enabled(-3.0, 5.0, true)).unwrap(),
        )],
    )
    .unwrap();
    assert_eq!(prepared.snapshot().latency_frames, 240);
    assert_eq!(prepared.snapshot().tail_frames, 240);

    // 禁用 limiter：逐位直通，latency/tail 均为 0。
    let bypassed = PreparedProcessorChain::prepare(
        2,
        format(48_000),
        256,
        vec![Box::new(
            LimiterProcessor::new(48_000.0, LimiterSettings::default()).unwrap(),
        )],
    )
    .unwrap();
    assert_eq!(bypassed.snapshot().latency_frames, 0);
    assert_eq!(bypassed.snapshot().tail_frames, 0);

    // 双 limiter 级联：链级 latency 汇总为 2×240（dsp.rs 自动折叠，adapter 不补偿）。
    let doubled = PreparedProcessorChain::prepare(
        3,
        format(48_000),
        256,
        vec![
            Box::new(LimiterProcessor::new(48_000.0, enabled(-3.0, 5.0, true)).unwrap()),
            Box::new(LimiterProcessor::new(48_000.0, enabled(-3.0, 5.0, true)).unwrap()),
        ],
    )
    .unwrap();
    assert_eq!(doubled.snapshot().latency_frames, 480);
    assert_eq!(doubled.snapshot().tail_frames, 480);
}

#[test]
fn chain_drain_pushes_delayed_content_out_via_zero_stuffing() {
    let mut chain = ProcessorChain::from_prepared(
        PreparedProcessorChain::prepare(
            1,
            format(48_000),
            256,
            vec![Box::new(
                LimiterProcessor::new(48_000.0, enabled(-6.0, 5.0, true)).unwrap(),
            )],
        )
        .unwrap(),
    );
    // 满幅脉冲 + 静音：脉冲被延迟 240 帧。
    let mut samples = vec![0.0_f32; 256 * 2];
    samples[0] = 1.0;
    samples[1] = -1.0;
    chain.process(format(48_000), &mut samples, 0).unwrap();
    let left = samples.iter().step_by(2).copied().collect::<Vec<_>>();
    assert!(left[..240].iter().all(|&s| s == 0.0));
    let impulse = left[240].abs();
    assert!(
        impulse > 0.3 && impulse < 0.6,
        "脉冲应被限幅，实际 {impulse}"
    );

    // 链级 drain（零输入 stuffing）：延迟线内的剩余内容（静音）被推出，
    // 不产生新能量，且 drain 输出全程有限。
    let mut drained_total = 0_usize;
    for block in 0..4 {
        let mut tail = vec![0.0_f32; 256 * 2];
        chain.drain(format(48_000), &mut tail, 1 + block).unwrap();
        assert!(tail.iter().all(|s| s.is_finite()));
        let peak = tail.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        assert!(peak <= impulse + 1.0e-6, "drain 不得产生超过脉冲的能量");
        drained_total += 1;
    }
    assert_eq!(drained_total, 4);

    // reset 后链快照保持契约。
    chain.reset(ResetReason::Stop);
    assert_eq!(chain.snapshot().latency_frames, 240);
}

#[test]
fn harness_readouts_report_latency_tail_and_meters() {
    // 直接驱动 Harness 读数口：latency/tail 如实上报，meter 读数有限且非正 dB。
    let mut processor = prepared(48_000.0, enabled(-6.0, 5.0, true), 512);
    assert_eq!(processor.latency_frames(), 240);
    assert_eq!(processor.tail_frames(), 240);
    let mut samples = vec![0.9_f32; 512];
    processor.process(&mut samples);
    let reduction = processor.reduction_reading();
    let peak = processor.peak_reading();
    assert!(reduction <= 0.0, "增益衰减必须为非正 dB，实际 {reduction}");
    assert!(
        peak.is_finite() && peak <= 0.0,
        "峰值读数必须有限，实际 {peak}"
    );
}
