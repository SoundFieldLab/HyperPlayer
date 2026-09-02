use hrtf_core::HrtfGrid;
use hse_core::{
    biquad::BiquadStage,
    convolver::{ConvolverOptions, ConvolverStage},
    engine_chain::{EngineChainParams, EngineChainStage},
    loudness_normalization::{
        LoudnessNormalizationReadings, LoudnessNormalizationSettings, LoudnessNormalizationStage,
    },
    mod_effects::{ChorusEffect, ChorusSettings, TremoloEffect, TremoloSettings},
    night_mode::{NightModeSettings, NightModeStage},
    surround3d::{Surround3dSettings, Surround3dStage},
    Stage,
};
use serde_json::json;
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
fn checkpoint_save_restore_copy_and_process_are_allocation_free() {
    let frames = 128;
    let mut left = vec![0.125; frames];
    let mut right = vec![-0.125; frames];

    let mut biquad_source = BiquadStage::new(48_000.0, "peaking", 1000.0, 1.2, 4.0).unwrap();
    let mut biquad_target = BiquadStage::new(48_000.0, "notch", 60.0, 8.0, 0.0).unwrap();
    biquad_source.process(&mut left, &mut right);
    let mut biquad_checkpoint = biquad_source.snapshot_runtime_state();

    let mut chorus_source = ChorusEffect::new(48_000.0).unwrap();
    chorus_source.set_params(ChorusSettings {
        enabled: true,
        rate_hz: 4.0,
        depth_ms: 5.0,
        mix: 0.5,
    });
    let mut chorus_target = ChorusEffect::new(48_000.0).unwrap();
    chorus_target.set_params(ChorusSettings {
        enabled: true,
        rate_hz: 9.0,
        depth_ms: 2.0,
        mix: 0.8,
    });
    chorus_source.process_stereo(&mut left, &mut right);
    let mut chorus_checkpoint = chorus_source.snapshot_runtime_state();

    let mut tremolo_source = TremoloEffect::new(48_000.0).unwrap();
    tremolo_source.set_params(TremoloSettings {
        enabled: true,
        rate_hz: 7.0,
        depth: 0.8,
        mix: 0.7,
    });
    let mut tremolo_target = TremoloEffect::new(48_000.0).unwrap();
    tremolo_target.set_params(TremoloSettings {
        enabled: true,
        rate_hz: 19.0,
        depth: 0.3,
        mix: 0.9,
    });
    tremolo_source.process_stereo(&mut left, &mut right);
    let mut tremolo_checkpoint = tremolo_source.snapshot_runtime_state();

    let mut loudness_source = LoudnessNormalizationStage::new(48_000.0).unwrap();
    loudness_source
        .set_params(LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: 6.0,
            ..LoudnessNormalizationSettings::default()
        })
        .unwrap();
    let mut loudness_target = LoudnessNormalizationStage::new(48_000.0).unwrap();
    loudness_target
        .set_params(LoudnessNormalizationSettings {
            enabled: true,
            use_realtime_meter: false,
            external_gain_db: -3.0,
            ..LoudnessNormalizationSettings::default()
        })
        .unwrap();
    loudness_source.process(
        &mut left,
        &mut right,
        LoudnessNormalizationReadings::unmeasured(),
    );
    let mut loudness_checkpoint = loudness_source.snapshot_runtime_state();

    let surround_settings = Surround3dSettings {
        enabled: true,
        distance: 0.85,
        speed: 0.7,
        angle: 11.0,
        direction: -1.0,
    };
    let mut surround_source = Surround3dStage::new(48_000.0).unwrap();
    surround_source.set_params(surround_settings).unwrap();
    let mut surround_target = Surround3dStage::new(48_000.0).unwrap();
    surround_target
        .set_params(Surround3dSettings {
            speed: 2.5,
            angle: 90.0,
            ..surround_settings
        })
        .unwrap();
    surround_source.process(&mut left, &mut right);
    let mut surround_checkpoint = surround_source.snapshot_runtime_state();

    let night_settings = NightModeSettings {
        enabled: true,
        amount: 8.0,
        ..NightModeSettings::default()
    };
    let mut night_source = NightModeStage::new(48_000.0, night_settings.clone()).unwrap();
    let mut night_target = NightModeStage::new(
        48_000.0,
        NightModeSettings {
            amount: 3.0,
            ..night_settings
        },
    )
    .unwrap();
    night_source.prepare(frames);
    night_target.prepare(frames);
    night_source.process(&mut left, &mut right);
    let mut night_checkpoint = night_source.snapshot_runtime_state();

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            biquad_source.process(&mut left, &mut right);
            biquad_source
                .save_runtime_state(&mut biquad_checkpoint)
                .unwrap();
            biquad_target
                .restore_runtime_state(&biquad_checkpoint)
                .unwrap();
            biquad_target
                .copy_runtime_state_from(&biquad_source)
                .unwrap();

            chorus_source.process_stereo(&mut left, &mut right);
            chorus_source
                .save_runtime_state(&mut chorus_checkpoint)
                .unwrap();
            chorus_target
                .restore_runtime_state(&chorus_checkpoint)
                .unwrap();
            chorus_target
                .copy_runtime_state_from(&chorus_source)
                .unwrap();

            tremolo_source.process_stereo(&mut left, &mut right);
            tremolo_source
                .save_runtime_state(&mut tremolo_checkpoint)
                .unwrap();
            tremolo_target
                .restore_runtime_state(&tremolo_checkpoint)
                .unwrap();
            tremolo_target
                .copy_runtime_state_from(&tremolo_source)
                .unwrap();

            loudness_source.process(
                &mut left,
                &mut right,
                LoudnessNormalizationReadings::unmeasured(),
            );
            loudness_source
                .save_runtime_state(&mut loudness_checkpoint)
                .unwrap();
            loudness_target
                .restore_runtime_state(&loudness_checkpoint)
                .unwrap();
            loudness_target
                .copy_runtime_state_from(&loudness_source)
                .unwrap();

            surround_source.process(&mut left, &mut right);
            surround_source
                .save_runtime_state(&mut surround_checkpoint)
                .unwrap();
            surround_target
                .restore_runtime_state(&surround_checkpoint)
                .unwrap();
            surround_target
                .copy_runtime_state_from(&surround_source)
                .unwrap();

            night_source.process(&mut left, &mut right);
            night_source
                .save_runtime_state(&mut night_checkpoint)
                .unwrap();
            night_target
                .restore_runtime_state(&night_checkpoint)
                .unwrap();
            night_target.copy_runtime_state_from(&night_source).unwrap();
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "steady process/checkpoint path allocated {allocations} times and deallocated {deallocations} times"
    );
}

#[test]
fn convolver_process_is_allocation_free_after_prepare() {
    let frames = 4096;
    let mut stage = ConvolverStage::new(
        48_000.0,
        ConvolverOptions {
            partition_size: 32.0,
            long_partition_size: 32.0,
            short_region_ms: 0.0,
            de_periodize: false,
        },
    )
    .unwrap();
    stage.load_ir(&[1.0], None).unwrap();
    stage.prepare(frames);
    let mut left = vec![0.25; frames];
    let mut right = vec![-0.25; frames];

    let (allocations, deallocations) =
        allocator_operations_during(|| stage.process(&mut left, &mut right));

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "convolver process performed {allocations} allocations and {deallocations} deallocations"
    );
}

#[test]
fn default_engine_chain_is_allocation_free_after_prepare() {
    assert_chain_process_is_allocation_free("default", json!({}), 64);
}

#[test]
fn representative_all_enabled_engine_chain_is_allocation_free_after_prepare() {
    assert_chain_process_is_allocation_free(
        "all-enabled",
        json!({
            "loudnessNormalization": {"enabled": true},
            "surround3d": {"enabled": true},
            "deesser": {"enabled": true},
            "compressor": {"enabled": true},
            "nightMode": {"enabled": true, "amount": 0.8},
            "modEffects": {
                "delay": {"enabled": true},
                "chorus": {"enabled": true},
                "flanger": {"enabled": true},
                "phaser": {"enabled": true},
                "tremolo": {"enabled": true}
            },
            "reverb": {
                "enabled": true,
                "mode": "convolution",
                "convolution": {"ir": [1.0], "dePeriodize": false}
            },
            "bassEnhancer": {"enabled": true},
            "loudnessCompensation": {"enabled": true},
            "ieq": {"enabled": true},
            "dynamicEq": {"enabled": true},
            "pitch": {"enabled": true, "voiceBalance": 0.25},
            "modulation": {
                "enabled": true,
                "routes": [
                    {"source": "lfo", "target": "masterGain", "amount": 0.2},
                    {"source": "envelope", "target": "stereoWidth", "amount": 0.2}
                ]
            }
        }),
        64,
    );
}

#[test]
fn spatial_engine_chain_is_allocation_free_after_prepare() {
    let params = EngineChainParams::from_overrides(
        48_000.0,
        &json!({
            "eq":{"enabled":false}, "limiter":{"enabled":false},
            "spatial":{
                "mode":"world",
                "convolution":"time",
                "instant":{"amount":1,"room":"off","roomAmount":0},
                "world":{
                    "listener":{"position":{"x":0,"y":1.6,"z":0},"yaw":15,"pitch":5,"roll":-3},
                    "sources":[
                        {"id":"left","position":{"x":-2,"y":1.6,"z":4},"gain":1,"size":0},
                        {"id":"wide","position":{"x":3,"y":2,"z":6},"gain":0.7,"size":0.6}
                    ],
                    "playhead":1,
                    "trajectories":[],
                    "occlusion":0.4
                },
                "ambience":{"enabled":true,"amount":0.3}
            }
        }),
    )
    .unwrap();
    let grid = HrtfGrid::new(
        48_000,
        vec![-30.0, 30.0],
        vec![0.0],
        2,
        vec![1.0, 0.25, 0.5, 0.0],
        vec![0.5, 0.0, 1.0, 0.25],
    )
    .unwrap();
    let mut stage =
        EngineChainStage::from_params_with_hrtf_grid(48_000.0, params, Some(grid)).unwrap();
    stage.prepare(128);
    let mut left = vec![0.125; 128];
    let mut right = vec![-0.125; 128];

    let (allocations, deallocations) = allocator_operations_during(|| {
        for _ in 0..64 {
            stage.process(&mut left, &mut right);
        }
    });

    assert_eq!((allocations, deallocations), (0, 0));
}

#[test]
fn long_ir_release_is_allocation_free_across_continuous_blocks() {
    let mut ir = Vec::with_capacity(192_000);
    let mut state = 0x5eed_f00d_u32;
    for index in 0..192_000 {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let noise = f64::from(state) / 4_294_967_296.0 * 2.0 - 1.0;
        ir.push((noise * (-12.0 * index as f64 / 192_000.0).exp() * 0.5) as f32);
    }
    assert_chain_process_is_allocation_free(
        "long-ir-release",
        json!({
            "reverb": {"enabled": true, "mode": "convolution", "convolution": {
                "ir": ir, "mix": 1.0, "preDelayMs": 0.0, "dePeriodize": false
            }}
        }),
        1_504,
    );
}

fn assert_chain_process_is_allocation_free(
    label: &str,
    overrides: serde_json::Value,
    blocks: usize,
) {
    let frames = 128;
    let params = EngineChainParams::from_overrides(48_000.0, &overrides).unwrap();
    let mut stage = EngineChainStage::from_params(48_000.0, params).unwrap();
    stage.prepare(frames);
    let mut left = vec![0.125; frames];
    let mut right = vec![-0.125; frames];

    // Warm every lazy scheduling path before the measured steady-state window.
    stage.process(&mut left, &mut right);
    stage.reset();
    left.fill(0.0);
    right.fill(0.0);
    left[0] = 1.0;
    right[0] = -1.0;

    let (allocations, deallocations) = allocator_operations_during(|| {
        for block in 0..blocks {
            stage.process(&mut left, &mut right);
            if block == 0 {
                left.fill(0.0);
                right.fill(0.0);
            }
        }
    });

    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "{label} engine chain performed {allocations} allocations and {deallocations} deallocations across {blocks} continuous blocks"
    );
}
