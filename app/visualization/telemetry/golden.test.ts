import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { activityRate } from "./activity";
import {
  decodeTelemetryFrame,
  TELEMETRY_FRAME_BYTES,
  TELEMETRY_SPECTRUM_BINS,
  TELEMETRY_WAVEFORM_BINS,
} from "./schema";

const fixturePath = resolve("tests/fixtures/telemetry/hptm_v4_golden.bin");
const golden = readFileSync(fixturePath);
const frames = Array.from({ length: 3 }, (_, index) => (
  golden.subarray(index * TELEMETRY_FRAME_BYTES, (index + 1) * TELEMETRY_FRAME_BYTES)
));

describe("Rust HPTM v3 golden bytes", () => {
  it("contains exactly three fixed-size frames", () => {
    expect(golden.byteLength).toBe(3 * TELEMETRY_FRAME_BYTES);
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.byteLength === TELEMETRY_FRAME_BYTES)).toBe(true);
  });

  it("decodes frame A waveform, sample peak, RMS, and unavailable fields", () => {
    const frame = decodeTelemetryFrame(frames[0]);

    expect(frame).toMatchObject({
      epoch: 1n,
      sequence: 2n,
      sampleFrame: 48_000n,
      revision: 3n,
      sampleRate: 48_000,
    });
    expect(frame.waveform).toHaveLength(TELEMETRY_WAVEFORM_BINS);
    expect(frame.waveform?.[0]).toEqual({
      leftMin: -1,
      leftMax: 1,
      rightMin: 0,
      rightMax: 0,
    });
    expect(frame.waveform?.[1]).toEqual({
      leftMin: 0,
      leftMax: 0,
      rightMin: -16_384 / 32_767,
      rightMax: 16_384 / 32_767,
    });
    expect(frame.waveform?.[63]).toEqual({
      leftMin: -1_024 / 32_767,
      leftMax: 2_048 / 32_767,
      rightMin: 0,
      rightMax: 0,
    });
    expect(frame.meters).toEqual({
      peakLeft: 0.75,
      peakRight: 0.5,
      truePeakLeft: null,
      truePeakRight: null,
      rmsLeft: 0.25,
      rmsRight: 0.125,
      limiterReduction: null,
    });
    expect(frame.spectrum).toBeNull();
    expect(frame.dynamicEq).toBeNull();
    expect(frame.lufs).toBeNull();
    expect(activityRate({
      open: true,
      visible: true,
      focused: true,
      reducedMotion: false,
      powerSave: false,
    })).toBe(30);
  });

  it("decodes frame B full legal fields and preserves large u64 clocks", () => {
    const frame = decodeTelemetryFrame(frames[1]);

    expect(frame.epoch).toBe(18_446_744_073_709_551_613n);
    expect(frame.sequence).toBe(9_007_199_254_740_993n);
    expect(frame.sampleFrame).toBe(18_446_744_073_709_551_612n);
    expect(frame.revision).toBe(18_446_744_073_709_551_614n);
    expect(frame.sampleRate).toBe(192_000);
    expect(frame.waveform).toHaveLength(TELEMETRY_WAVEFORM_BINS);
    expect(frame.waveform?.[0]).toEqual({
      leftMin: -256 / 32_767,
      leftMax: 256 / 32_767,
      rightMin: -128 / 32_767,
      rightMax: 128 / 32_767,
    });
    expect(frame.waveform?.[63]).toEqual({
      leftMin: -16_384 / 32_767,
      leftMax: 16_384 / 32_767,
      rightMin: -8_192 / 32_767,
      rightMax: 8_192 / 32_767,
    });
    expect(frame.spectrum).toHaveLength(TELEMETRY_SPECTRUM_BINS);
    expect(frame.spectrum?.[0]).toBe(-90);
    expect(frame.spectrum?.[1]).toBeCloseTo(-6.0205, 3);
    expect(frame.spectrum?.[2]).toBe(0);
    expect(frame.meters).toEqual({
      peakLeft: 1,
      peakRight: 0.875,
      truePeakLeft: 1.125,
      truePeakRight: 1,
      rmsLeft: 0.5,
      rmsRight: 0.25,
      limiterReduction: 6.25,
    });
    expect(frame.dynamicEq).not.toBeNull();
    expect(frame.dynamicEq?.generation).toBe(0xaabbccdd);
    expect(frame.dynamicEq?.bands[0]).toEqual({
      gainDb: -1,
      levelDb: -30,
      reductionDb: 0.5,
    });
    expect(frame.dynamicEq?.bands[4]).toEqual({
      gainDb: -5,
      levelDb: -34,
      reductionDb: 4.5,
    });
    expect(frame.lufs).not.toBeNull();
    expect(frame.lufs?.integrated).toBeCloseTo(-17.5, 3);
    expect(frame.lufs?.momentary).toBeCloseTo(-17.4, 3);
    expect(frame.lufs?.shortTerm).toBeCloseTo(-17.6, 3);
  });

  it("decodes frame C while 0 Hz activity means paused delivery", () => {
    const frame = decodeTelemetryFrame(frames[2]);

    expect(frame).toMatchObject({
      epoch: 7n,
      sequence: 11n,
      sampleFrame: 96_000n,
      revision: 13n,
      sampleRate: 48_000,
      waveform: null,
      spectrum: null,
      meters: {
        peakLeft: null,
        peakRight: null,
        truePeakLeft: null,
        truePeakRight: null,
        rmsLeft: null,
        rmsRight: null,
        limiterReduction: null,
      },
      dynamicEq: null,
      lufs: null,
    });
    expect(activityRate({
      open: false,
      visible: true,
      focused: true,
      reducedMotion: false,
      powerSave: false,
    })).toBe(0);
  });
});
