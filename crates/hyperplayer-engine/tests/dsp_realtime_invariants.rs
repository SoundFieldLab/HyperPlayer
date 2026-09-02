use hse_core::eq_chain::EqBandParam;
use hyperplayer_engine::dsp::{
    PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat, PreparedProcessorChain, ProcessorChain,
    ProcessorFaultKind, ResetReason, RuntimeStateCapability,
};
use hyperplayer_engine::dsp_algorithms::bass_enhancer::{BassEnhancerSettings, HarmonicType};
use hyperplayer_engine::dsp_algorithms::chorus::ChorusSettings;
use hyperplayer_engine::dsp_algorithms::compressor::CompressorSettings;
use hyperplayer_engine::dsp_algorithms::deesser::DeesserSettings;
use hyperplayer_engine::dsp_algorithms::delay::DelaySettings;
use hyperplayer_engine::dsp_algorithms::flanger::FlangerSettings;
use hyperplayer_engine::dsp_algorithms::loudness_normalization::{
    LoudnessNormalizationProcessor, LoudnessNormalizationSettings,
};
use hyperplayer_engine::dsp_algorithms::lufs_meter::SharedLufsState;
use hyperplayer_engine::dsp_algorithms::night_mode::NightModeSettings;
use hyperplayer_engine::dsp_algorithms::phaser::PhaserSettings;
use hyperplayer_engine::dsp_algorithms::surround3d::{Surround3dProcessor, Surround3dSettings};
use hyperplayer_engine::dsp_algorithms::tremolo::TremoloSettings;
use hyperplayer_engine::dsp_algorithms::{
    prepare_dsp_chain, DspConfig, EqChainConfig, EqStereoMode,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;

struct CountingAllocator;

thread_local! {
    static COUNT_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
    static ALLOCATION_COUNT: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNT_ALLOCATIONS.with(|armed| {
            if armed.get() {
                ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        COUNT_ALLOCATIONS.with(|armed| {
            if armed.get() {
                ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        COUNT_ALLOCATIONS.with(|armed| {
            if armed.get() {
                ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

struct AllocationGuard;

impl AllocationGuard {
    fn arm() -> Self {
        ALLOCATION_COUNT.with(|count| count.set(0));
        COUNT_ALLOCATIONS.with(|armed| armed.set(true));
        Self
    }

    fn count(&self) -> usize {
        ALLOCATION_COUNT.with(Cell::get)
    }
}

impl Drop for AllocationGuard {
    fn drop(&mut self) {
        COUNT_ALLOCATIONS.with(|armed| armed.set(false));
    }
}

fn format() -> PcmFormat {
    PcmFormat {
        sample_rate: 48_000,
        channels: 2,
        sample_format: PcmSampleFormat::F32,
    }
}

struct NonFiniteProcessor;

impl PcmProcessor for NonFiniteProcessor {
    fn name(&self) -> &'static str {
        "non-finite"
    }

    fn runtime_state_capability(&self) -> RuntimeStateCapability {
        RuntimeStateCapability::Stateless
    }

    fn prepare(
        &mut self,
        _format: PcmFormat,
        _max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        block.interleaved[0] = f32::NAN;
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {}

    fn latency_frames(&self) -> u32 {
        7
    }

    fn tail_frames(&self) -> u32 {
        9
    }
}

struct StatefulCounter {
    next: f32,
}

impl PcmProcessor for StatefulCounter {
    fn name(&self) -> &'static str {
        "stateful-counter"
    }

    fn runtime_state_capability(&self) -> RuntimeStateCapability {
        RuntimeStateCapability::Stateful
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(self.next))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state.is::<f32>()
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(saved) = state.downcast_mut::<f32>() else {
            return false;
        };
        *saved = self.next;
        true
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(saved) = state.downcast_ref::<f32>() else {
            return false;
        };
        self.next = *saved;
        true
    }

    fn prepare(
        &mut self,
        _format: PcmFormat,
        _max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        for sample in block.interleaved {
            *sample += self.next;
        }
        self.next += 1.0;
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {}

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

struct AddProcessor(f32);

impl PcmProcessor for AddProcessor {
    fn name(&self) -> &'static str {
        "add"
    }

    fn prepare(
        &mut self,
        _format: PcmFormat,
        _max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        for sample in block.interleaved {
            *sample += self.0;
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {}

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

#[test]
fn speculative_public_process_keeps_pending_revision_and_restore_recovers_original_state() {
    let active = PreparedProcessorChain::prepare(
        1,
        format(),
        1,
        vec![Box::new(StatefulCounter { next: 5.0 })],
    )
    .unwrap();
    let mut chain = ProcessorChain::from_prepared(active);
    chain
        .queue_prepared(
            PreparedProcessorChain::prepare(2, format(), 1, vec![Box::new(AddProcessor(100.0))])
                .unwrap(),
        )
        .unwrap();

    chain.begin_speculative_processing().unwrap();
    let mut speculative = [0.0, 0.0];
    chain.process(format(), &mut speculative, 10).unwrap();
    assert_eq!(speculative, [5.0, 5.0]);
    assert_eq!(chain.snapshot().revision, 1);
    assert_eq!(chain.snapshot().pending_revision, Some(2));

    chain.restore_speculative_processing().unwrap();
    chain.begin_speculative_processing().unwrap();
    let mut replay = [0.0, 0.0];
    chain.process(format(), &mut replay, 10).unwrap();
    assert_eq!(replay, speculative);
    assert_eq!(chain.snapshot().revision, 1);
    assert_eq!(chain.snapshot().pending_revision, Some(2));
    chain.restore_speculative_processing().unwrap();
}

#[test]
fn restore_replays_output_while_commit_keeps_speculative_state() {
    let prepared = PreparedProcessorChain::prepare(
        1,
        format(),
        1,
        vec![Box::new(StatefulCounter { next: 1.0 })],
    )
    .unwrap();
    let mut chain = ProcessorChain::from_prepared(prepared);

    chain.begin_speculative_processing().unwrap();
    let mut discarded = [0.0, 0.0];
    chain.process(format(), &mut discarded, 0).unwrap();
    chain.restore_speculative_processing().unwrap();
    let mut restored = [0.0, 0.0];
    chain.process(format(), &mut restored, 0).unwrap();
    assert_eq!(discarded, [1.0, 1.0]);
    assert_eq!(restored, discarded);

    chain.begin_speculative_processing().unwrap();
    let mut committed = [0.0, 0.0];
    chain.process(format(), &mut committed, 1).unwrap();
    chain.commit_speculative_processing();
    let mut after_commit = [0.0, 0.0];
    chain.process(format(), &mut after_commit, 2).unwrap();
    assert_eq!(committed, [2.0, 2.0]);
    assert_eq!(after_commit, [3.0, 3.0]);
}

#[test]
fn unsupported_stateful_processor_is_rejected_but_stateless_chain_is_supported() {
    struct UnsupportedStateful;
    impl PcmProcessor for UnsupportedStateful {
        fn name(&self) -> &'static str {
            "unsupported-stateful"
        }
        fn runtime_state_capability(&self) -> RuntimeStateCapability {
            RuntimeStateCapability::Stateful
        }
        fn prepare(
            &mut self,
            _format: PcmFormat,
            _max_block_frames: usize,
        ) -> hyperplayer_engine::Result<()> {
            Ok(())
        }
        fn process(&mut self, _block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
            Ok(())
        }
        fn reset(&mut self, _reason: ResetReason) {}
        fn latency_frames(&self) -> u32 {
            0
        }
        fn tail_frames(&self) -> u32 {
            0
        }
    }

    let prepared =
        PreparedProcessorChain::prepare(1, format(), 1, vec![Box::new(UnsupportedStateful)])
            .unwrap();
    let mut unsupported = ProcessorChain::from_prepared(prepared);
    assert!(unsupported.begin_speculative_processing().is_err());

    let mut stateless = ProcessorChain::bypass_only(format(), 1).unwrap();
    stateless.begin_speculative_processing().unwrap();
    stateless.restore_speculative_processing().unwrap();
}

#[test]
fn multi_processor_failure_restores_the_original_block_and_reports_effective_bypass_timing() {
    struct FailingProcessor;
    impl PcmProcessor for FailingProcessor {
        fn name(&self) -> &'static str {
            "failing"
        }
        fn prepare(
            &mut self,
            _format: PcmFormat,
            _max_block_frames: usize,
        ) -> hyperplayer_engine::Result<()> {
            Ok(())
        }
        fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
            block.interleaved.fill(99.0);
            Err(hyperplayer_engine::EngineError::ActorUnavailable)
        }
        fn reset(&mut self, _reason: ResetReason) {}
        fn latency_frames(&self) -> u32 {
            3
        }
        fn tail_frames(&self) -> u32 {
            5
        }
    }

    let prepared = PreparedProcessorChain::prepare(
        7,
        format(),
        2,
        vec![Box::new(AddProcessor(10.0)), Box::new(FailingProcessor)],
    )
    .unwrap();
    let mut chain = ProcessorChain::from_prepared(prepared);
    let mut samples = [-0.0_f32, 1.0, -2.0, 3.0];
    let original_bits = samples.map(f32::to_bits);
    chain.process(format(), &mut samples, 40).unwrap();

    assert_eq!(samples.map(f32::to_bits), original_bits);
    let snapshot = chain.snapshot();
    assert_eq!(snapshot.revision, 7);
    assert!(snapshot.safe_bypass_active);
    assert_eq!(snapshot.latency_frames, 0);
    assert_eq!(snapshot.tail_frames, 0);
    assert_eq!(
        snapshot.fault.unwrap().kind,
        ProcessorFaultKind::ProcessingFailed
    );

    let mut terminal = [1.0, 1.0];
    chain.drain(format(), &mut terminal, 42).unwrap();
    assert_eq!(terminal, [0.0, 0.0]);
    assert_eq!(chain.snapshot().latency_frames, 0);
    assert_eq!(chain.snapshot().tail_frames, 0);
}

#[test]
fn safe_bypass_transitions_and_recovery_allocate_nothing() {
    let faulting =
        PreparedProcessorChain::prepare(1, format(), 128, vec![Box::new(NonFiniteProcessor)])
            .unwrap();
    let mut active_fault = ProcessorChain::from_prepared(faulting);
    let mut speculative_fault = ProcessorChain::from_prepared(
        PreparedProcessorChain::prepare(1, format(), 128, vec![Box::new(NonFiniteProcessor)])
            .unwrap(),
    );
    let recovery = PreparedProcessorChain::prepare(2, format(), 128, Vec::new()).unwrap();
    let mut samples = [0.25_f32; 256];

    speculative_fault.begin_speculative_processing().unwrap();
    let guard = AllocationGuard::arm();

    active_fault.process(format(), &mut samples, 0).unwrap();
    assert!(active_fault.snapshot().safe_bypass_active);
    active_fault.process(format(), &mut samples, 128).unwrap();
    active_fault.process(format(), &mut samples, 256).unwrap();

    speculative_fault
        .process(format(), &mut samples, 0)
        .unwrap();
    assert!(speculative_fault.snapshot().safe_bypass_active);
    assert!(speculative_fault
        .restore_speculative_processing_to_safe_bypass()
        .unwrap());
    assert!(speculative_fault.snapshot().safe_bypass_active);
    assert!(speculative_fault.snapshot().fault.is_some());
    assert!(speculative_fault.take_unreported_fault().is_some());

    active_fault.queue_prepared(recovery).unwrap();
    active_fault.process(format(), &mut samples, 384).unwrap();
    assert_eq!(active_fault.snapshot().revision, 2);
    assert!(!active_fault.snapshot().safe_bypass_active);
    assert!(active_fault.snapshot().fault.is_none());

    let allocations = guard.count();
    drop(guard);
    assert_eq!(
        allocations, 0,
        "safe bypass path allocated {allocations} times"
    );
}

#[test]
fn processing_error_bypass_and_recovery_allocate_nothing() {
    struct ProcessingError;
    impl PcmProcessor for ProcessingError {
        fn name(&self) -> &'static str {
            "processing-error"
        }
        fn runtime_state_capability(&self) -> RuntimeStateCapability {
            RuntimeStateCapability::Stateless
        }
        fn prepare(
            &mut self,
            _format: PcmFormat,
            _max_block_frames: usize,
        ) -> hyperplayer_engine::Result<()> {
            Ok(())
        }
        fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
            block.interleaved.fill(99.0);
            Err(hyperplayer_engine::EngineError::ActorUnavailable)
        }
        fn reset(&mut self, _reason: ResetReason) {}
        fn latency_frames(&self) -> u32 {
            11
        }
        fn tail_frames(&self) -> u32 {
            13
        }
    }

    let prepared =
        PreparedProcessorChain::prepare(1, format(), 128, vec![Box::new(ProcessingError)]).unwrap();
    let mut chain = ProcessorChain::from_prepared(prepared);
    let recovery = PreparedProcessorChain::prepare(2, format(), 128, Vec::new()).unwrap();
    let mut samples = [0.25_f32; 256];
    chain.queue_prepared(recovery).unwrap();
    chain.begin_speculative_processing().unwrap();

    let guard = AllocationGuard::arm();
    chain.process(format(), &mut samples, 0).unwrap();
    assert!(chain.snapshot().safe_bypass_active);
    assert_eq!(chain.snapshot().latency_frames, 0);
    assert_eq!(chain.snapshot().tail_frames, 0);
    chain.commit_speculative_processing();
    chain.process(format(), &mut samples, 128).unwrap();
    chain.process(format(), &mut samples, 256).unwrap();
    chain.process(format(), &mut samples, 384).unwrap();
    assert_eq!(chain.snapshot().revision, 2);
    assert!(!chain.snapshot().safe_bypass_active);
    assert_eq!(guard.count(), 0, "processing-error bypass path allocated");
}

#[test]
fn loudness_adapter_process_and_checkpoint_are_allocation_free_after_prepare() {
    let shared = Arc::new(SharedLufsState::new());
    let settings = LoudnessNormalizationSettings {
        enabled: true,
        use_realtime_meter: false,
        external_gain_db: 6.0,
        ..LoudnessNormalizationSettings::default()
    };
    let mut processor = LoudnessNormalizationProcessor::new(48_000, settings, shared).unwrap();
    processor.prepare(format(), 128).unwrap();
    let mut checkpoint = processor.create_runtime_checkpoint().unwrap();
    let mut samples = [0.25_f32; 256];

    let guard = AllocationGuard::arm();
    for _ in 0..64 {
        processor
            .process(PcmBlock {
                format: format(),
                interleaved: &mut samples,
            })
            .unwrap();
        assert!(processor.save_runtime_state(checkpoint.as_mut()));
        assert!(processor.restore_runtime_state(checkpoint.as_ref()));
    }
    let allocations = guard.count();
    drop(guard);

    assert_eq!(
        allocations, 0,
        "loudness adapter allocated {allocations} times"
    );
}

#[test]
fn surround_disabled_to_enabled_revision_swap_starts_with_fresh_phase() {
    let enabled = Surround3dSettings {
        enabled: true,
        speed: 1.25,
        angle: 17.0,
        ..Surround3dSettings::default()
    };
    let mut stale_disabled = Surround3dProcessor::with_settings(48_000, enabled).unwrap();
    stale_disabled.prepare(format(), 128).unwrap();
    stale_disabled
        .process(PcmBlock {
            format: format(),
            interleaved: &mut [0.25_f32; 256],
        })
        .unwrap();
    assert_ne!(stale_disabled.phase(), 0.0);
    stale_disabled
        .set_params(Surround3dSettings {
            enabled: false,
            ..enabled
        })
        .unwrap();

    let active =
        PreparedProcessorChain::prepare(1, format(), 128, vec![Box::new(stale_disabled)]).unwrap();
    let mut chain = ProcessorChain::from_prepared(active);
    let next = Surround3dProcessor::with_settings(48_000, enabled).unwrap();
    chain
        .queue_prepared(
            PreparedProcessorChain::prepare(2, format(), 128, vec![Box::new(next)]).unwrap(),
        )
        .unwrap();

    let input = [0.25_f32; 256];
    let mut actual = input;
    chain.process(format(), &mut actual, 128).unwrap();

    let mut fresh = Surround3dProcessor::with_settings(48_000, enabled).unwrap();
    fresh.prepare(format(), 128).unwrap();
    let mut expected = input;
    fresh
        .process(PcmBlock {
            format: format(),
            interleaved: &mut expected,
        })
        .unwrap();

    assert_eq!(chain.snapshot().revision, 2);
    assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
}

#[test]
fn prepared_swap_and_builtin_processing_allocate_nothing() {
    let config = DspConfig {
        loudness_normalization: LoudnessNormalizationSettings {
            enabled: true,
            ..LoudnessNormalizationSettings::default()
        },
        surround3d: Surround3dSettings {
            enabled: true,
            distance: 0.85,
            speed: 0.7,
            angle: 11.0,
            direction: -1.0,
        },
        stereo_width: 1.35,
        voice_balance: -0.2,
        pre_eq: EqChainConfig {
            enabled: true,
            band_count: 3,
            q_compensation: true,
            stereo_mode: EqStereoMode::Independent,
            bands: vec![
                EqBandParam {
                    frequency: 80.0,
                    gain: 3.0,
                    q: 0.8,
                },
                EqBandParam {
                    frequency: 1_000.0,
                    gain: -2.0,
                    q: 1.1,
                },
                EqBandParam {
                    frequency: 8_000.0,
                    gain: 1.5,
                    q: 0.9,
                },
            ],
        },
        compressor: CompressorSettings {
            enabled: true,
            ..CompressorSettings::default()
        },
        night_mode: NightModeSettings {
            enabled: true,
            amount: 8.0,
        },
        delay: DelaySettings {
            enabled: true,
            delay_ms: 40.5,
            feedback: 0.55,
            mix: 0.4,
        },
        chorus: ChorusSettings {
            enabled: true,
            rate_hz: 4.0,
            depth_ms: 5.0,
            mix: 0.5,
        },
        flanger: FlangerSettings {
            enabled: true,
            rate_hz: 2.5,
            depth_ms: 4.0,
            feedback: 0.6,
            mix: 0.5,
        },
        phaser: PhaserSettings {
            enabled: true,
            rate_hz: 1.5,
            depth: 0.8,
            feedback: 0.5,
            mix: 0.5,
            stages: 6.0,
        },
        tremolo: TremoloSettings {
            enabled: true,
            rate_hz: 5.0,
            depth: 0.8,
            mix: 0.75,
        },
        deesser: DeesserSettings {
            enabled: true,
            ..DeesserSettings::default()
        },
        bass_enhancer: BassEnhancerSettings {
            enabled: true,
            harmonic_type: HarmonicType::Soft,
            ..BassEnhancerSettings::default()
        },
    };
    let prepared = prepare_dsp_chain(1, format(), 128, config.clone()).unwrap();
    let mut chain = ProcessorChain::from_prepared(prepared);
    let mut samples = [0.25_f32; 256];
    for block_index in 0..150_u64 {
        chain
            .process(format(), &mut samples, block_index * 128)
            .unwrap();
    }
    let mut next_config = config;
    next_config.stereo_width = 1.2;
    chain
        .queue_prepared(prepare_dsp_chain(2, format(), 128, next_config).unwrap())
        .unwrap();

    let guard = AllocationGuard::arm();
    chain.process(format(), &mut samples, 150 * 128).unwrap();
    assert_eq!(guard.count(), 0, "DSP revision swap allocated");
    chain.begin_speculative_processing().unwrap();
    assert_eq!(guard.count(), 0, "DSP checkpoint save allocated");
    chain.process(format(), &mut samples, 151 * 128).unwrap();
    assert_eq!(guard.count(), 0, "speculative DSP processing allocated");
    chain.restore_speculative_processing().unwrap();
    assert_eq!(guard.count(), 0, "DSP checkpoint restore allocated");
    chain.process(format(), &mut samples, 151 * 128).unwrap();
    chain.begin_speculative_processing().unwrap();
    chain.process(format(), &mut samples, 152 * 128).unwrap();
    chain.commit_speculative_processing();
    assert_eq!(guard.count(), 0, "DSP checkpoint commit allocated");
    let allocations = guard.count();
    drop(guard);

    assert_eq!(
        allocations, 0,
        "DSP block boundary allocated {allocations} times"
    );
}
