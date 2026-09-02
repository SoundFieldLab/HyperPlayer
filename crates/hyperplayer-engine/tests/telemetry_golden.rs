use hyperplayer_engine::telemetry::{
    TelemetryFrame, DYNAMIC_EQ_BANDS, SPECTRUM_BINS, TELEMETRY_FRAME_ENCODED_SIZE,
    TELEMETRY_KNOWN_VALIDITY_FLAGS, TELEMETRY_VALID_RMS, TELEMETRY_VALID_SAMPLE_PEAK,
    TELEMETRY_VALID_WAVEFORM, WAVEFORM_BINS,
};
use std::{env, fs, path::PathBuf};

const FRAME_COUNT: usize = 3;
const REBUILD_ENV: &str = "HYPERPLAYER_REBUILD_TELEMETRY_GOLDEN";

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/telemetry/hptm_v4_golden.bin")
}

fn golden_frames() -> [TelemetryFrame; FRAME_COUNT] {
    let mut waveform = TelemetryFrame {
        validity_flags: TELEMETRY_VALID_WAVEFORM
            | TELEMETRY_VALID_SAMPLE_PEAK
            | TELEMETRY_VALID_RMS,
        epoch: 1,
        sequence: 2,
        sample_frame: 48_000,
        dsp_revision: 3,
        sample_rate: 48_000,
        peak: [0.75, 0.5],
        meter: [0.25, 0.125],
        ..TelemetryFrame::default()
    };
    waveform.waveform_min[0][0] = -32_767;
    waveform.waveform_max[0][0] = 32_767;
    waveform.waveform_min[1][1] = -16_384;
    waveform.waveform_max[1][1] = 16_384;
    waveform.waveform_min[0][WAVEFORM_BINS - 1] = -1_024;
    waveform.waveform_max[0][WAVEFORM_BINS - 1] = 2_048;

    let mut full = TelemetryFrame {
        validity_flags: TELEMETRY_KNOWN_VALIDITY_FLAGS,
        epoch: u64::MAX - 2,
        sequence: 9_007_199_254_740_993,
        sample_frame: u64::MAX - 3,
        dsp_revision: u64::MAX - 1,
        sample_rate: 192_000,
        peak: [1.0, 0.875],
        true_peak: [1.125, 1.0],
        meter: [0.5, 0.25],
        limiter_reduction_db: 6.25,
        dynamic_eq_generation: 0xAABB_CCDD,
        integrated_lufs: -17.5,
        momentary_lufs: -17.4,
        short_term_lufs: -17.6,
        ..TelemetryFrame::default()
    };
    for index in 0..WAVEFORM_BINS {
        let magnitude = (index as i16 + 1) * 256;
        full.waveform_min[0][index] = -magnitude;
        full.waveform_max[0][index] = magnitude;
        full.waveform_min[1][index] = -(magnitude / 2);
        full.waveform_max[1][index] = magnitude / 2;
    }
    for index in 0..SPECTRUM_BINS {
        full.spectrum[index] = match index {
            0 => 0,
            1 => 32_768,
            2 => u16::MAX,
            _ => (index as u16) * 521,
        };
    }
    for index in 0..DYNAMIC_EQ_BANDS {
        full.dynamic_eq_gain_db[index] = -1.0 - index as f32;
        full.dynamic_eq_level_db[index] = -30.0 - index as f32;
        full.dynamic_eq_reduction_db[index] = 0.5 + index as f32;
    }

    let paused = TelemetryFrame {
        validity_flags: 0,
        epoch: 7,
        sequence: 11,
        sample_frame: 96_000,
        dsp_revision: 13,
        sample_rate: 48_000,
        ..TelemetryFrame::default()
    };

    [waveform, full, paused]
}

fn encoded_golden() -> Vec<u8> {
    golden_frames()
        .iter()
        .flat_map(|frame| frame.encode())
        .collect()
}

#[test]
fn rust_encoding_matches_the_cross_language_hptm_v4_golden_bytes() {
    let expected = encoded_golden();
    assert_eq!(expected.len(), FRAME_COUNT * TELEMETRY_FRAME_ENCODED_SIZE);

    let path = fixture_path();
    if env::var_os(REBUILD_ENV).is_some() {
        fs::create_dir_all(path.parent().expect("fixture has a parent directory")).unwrap();
        fs::write(&path, &expected).unwrap();
    }

    let committed = fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "failed to read {}: {error}; rebuild explicitly with {REBUILD_ENV}=1",
            path.display()
        )
    });
    assert_eq!(
        committed, expected,
        "HPTM v4 golden bytes changed; inspect the protocol change before rebuilding with {REBUILD_ENV}=1"
    );

    for frame in committed.as_chunks::<TELEMETRY_FRAME_ENCODED_SIZE>().0 {
        assert_eq!(&frame[46..48], &[0, 0], "reserved header must be zero");
    }
    assert!(
        committed[560..752].iter().all(|byte| *byte == 0),
        "frame A's unavailable spectrum storage must be zero"
    );
    assert!(
        committed
            [(2 * TELEMETRY_FRAME_ENCODED_SIZE + 560)..(2 * TELEMETRY_FRAME_ENCODED_SIZE + 752)]
            .iter()
            .all(|byte| *byte == 0),
        "frame C's unavailable spectrum storage must be zero"
    );
    // 无 DYNAMIC_EQ 有效位的帧，其追加块（780..844）必须全零；v4 LUFS 块（844..856）同理。
    let dynamic_eq_start = 780;
    assert!(
        committed[dynamic_eq_start..844]
            .iter()
            .all(|byte| *byte == 0),
        "frame A's unavailable dynamic-eq block must be zero"
    );
    assert!(
        committed[(2 * TELEMETRY_FRAME_ENCODED_SIZE + dynamic_eq_start)
            ..(2 * TELEMETRY_FRAME_ENCODED_SIZE + 844)]
            .iter()
            .all(|byte| *byte == 0),
        "frame C's unavailable dynamic-eq block must be zero"
    );
    let lufs_start = 844;
    assert!(
        committed[lufs_start..TELEMETRY_FRAME_ENCODED_SIZE]
            .iter()
            .all(|byte| *byte == 0),
        "frame A's unavailable LUFS block must be zero"
    );
    assert!(
        committed
            [(2 * TELEMETRY_FRAME_ENCODED_SIZE + lufs_start)..(3 * TELEMETRY_FRAME_ENCODED_SIZE)]
            .iter()
            .all(|byte| *byte == 0),
        "frame C's unavailable LUFS block must be zero"
    );
}
