import { describe, expect, it } from "vitest";
import {
  decodeTelemetryFrame,
  TELEMETRY_DYNAMIC_EQ_BANDS,
  TELEMETRY_FRAME_BYTES,
  TELEMETRY_MAGIC,
  TELEMETRY_MAX_FRAME_BYTES,
  TELEMETRY_SPECTRUM_BINS,
  TELEMETRY_VALID_DYNAMIC_EQ,
  TELEMETRY_VALID_LIMITER_REDUCTION,
  TELEMETRY_VALID_RMS,
  TELEMETRY_VALID_SAMPLE_PEAK,
  TELEMETRY_VALID_SPECTRUM,
  TELEMETRY_VALID_TRUE_PEAK,
  TELEMETRY_VALID_WAVEFORM,
  TELEMETRY_VERSION,
  TELEMETRY_WAVEFORM_BINS,
} from "./schema";
import { makeTelemetryFrame } from "./test-fixtures";

describe("decodeTelemetryFrame", () => {
  it("decodes the fixed HPTM v4 frame without losing u64 identifiers", () => {
    const binary = makeTelemetryFrame({
      epoch: 18_446_744_073_709_551_613n,
      sequence: 9_007_199_254_740_993n,
      sampleFrame: 18_446_744_073_709_551_612n,
      revision: 18_446_744_073_709_551_614n,
      validityFlags: TELEMETRY_VALID_WAVEFORM
        | TELEMETRY_VALID_SAMPLE_PEAK
        | TELEMETRY_VALID_RMS
        | TELEMETRY_VALID_SPECTRUM
        | TELEMETRY_VALID_TRUE_PEAK
        | TELEMETRY_VALID_LIMITER_REDUCTION,
      spectrum: Array.from({ length: TELEMETRY_SPECTRUM_BINS }, (_, index) => (
        index === 0 ? 0 : index === 1 ? 32_768 : 65_535
      )),
      meters: {
        peakLeft: 0.8,
        peakRight: 0.7,
        truePeakLeft: 0.82,
        truePeakRight: 0.72,
        rmsLeft: 0.4,
        rmsRight: 0.35,
        limiterReduction: 2.3,
      },
    });
    const frame = decodeTelemetryFrame(binary);

    expect(binary.byteLength).toBe(TELEMETRY_FRAME_BYTES);
    expect(binary.byteLength).toBeLessThanOrEqual(TELEMETRY_MAX_FRAME_BYTES);
    expect(frame.epoch).toBe(18_446_744_073_709_551_613n);
    expect(frame.sequence).toBe(9_007_199_254_740_993n);
    expect(frame.sampleFrame).toBe(18_446_744_073_709_551_612n);
    expect(frame.revision).toBe(18_446_744_073_709_551_614n);
    expect(frame.sampleRate).toBe(48_000);
    expect(frame.waveform).toHaveLength(TELEMETRY_WAVEFORM_BINS);
    expect(frame.waveform?.[63]).toEqual({
      leftMin: -1,
      leftMax: 1,
      rightMin: -16_384 / 32_767,
      rightMax: 16_384 / 32_767,
    });
    expect(frame.spectrum).toHaveLength(TELEMETRY_SPECTRUM_BINS);
    expect(frame.spectrum?.[0]).toBe(-90);
    expect(frame.spectrum?.[1]).toBeCloseTo(-6.0205, 3);
    expect(frame.spectrum?.[2]).toBe(0);
    expect(frame.meters.rmsLeft).toBeCloseTo(0.4);
    expect(frame.meters.limiterReduction).toBeCloseTo(2.3);
  });

  it.each([
    ["bad magic", (view: DataView) => view.setUint32(0, 0, true)],
    ["bad version", (view: DataView) => view.setUint16(4, TELEMETRY_VERSION + 1, true)],
    ["unknown validity flag", (view: DataView) => view.setUint16(6, 1 << 15, true)],
    ["unallocated validity flag", (view: DataView) => view.setUint16(6, 1 << 8, true)],
    ["wrong waveform count", (view: DataView) => view.setUint8(44, TELEMETRY_WAVEFORM_BINS - 1)],
    ["wrong spectrum count", (view: DataView) => view.setUint8(45, TELEMETRY_SPECTRUM_BINS - 1)],
    ["nonzero reserved", (view: DataView) => view.setUint16(46, 1, true)],
    ["nonzero reserved spectrum", (view: DataView) => view.setUint16(560, 1, true)],
    ["zero sample rate", (view: DataView) => view.setUint32(40, 0, true)],
    ["inverted waveform range", (view: DataView) => {
      view.setInt16(48, 1, true);
      view.setInt16(48 + TELEMETRY_WAVEFORM_BINS * 4, -1, true);
    }],
    ["non-finite meter", (view: DataView) => view.setFloat32(752, Number.NaN, true)],
    ["nonzero dynamic-eq area without validity", (view: DataView) => view.setFloat32(780 + 4, 1, true)],
  ])("rejects %s", (_label, corrupt) => {
    const binary = makeTelemetryFrame();
    corrupt(new DataView(binary));
    expect(() => decodeTelemetryFrame(binary)).toThrow();
  });

  it("decodes the dynamic-eq block when DYNAMIC_EQ is present", () => {
    const binary = makeTelemetryFrame({
      validityFlags: TELEMETRY_VALID_DYNAMIC_EQ,
      dynamicEq: {
        generation: 42,
        gainDb: [-1, -2, -3, -4, -5],
        levelDb: [-30, -31, -32, -33, -34],
        reductionDb: [0.5, 1, 1.5, 2, 2.5],
      },
    });
    const frame = decodeTelemetryFrame(binary);

    expect(frame.dynamicEq).not.toBeNull();
    expect(frame.dynamicEq?.generation).toBe(42);
    expect(frame.dynamicEq?.bands).toHaveLength(TELEMETRY_DYNAMIC_EQ_BANDS);
    expect(frame.dynamicEq?.bands[0]).toEqual({
      gainDb: -1,
      levelDb: -30,
      reductionDb: 0.5,
    });
    expect(frame.dynamicEq?.bands[4]).toEqual({
      gainDb: -5,
      levelDb: -34,
      reductionDb: 2.5,
    });
  });

  it("keeps dynamic-eq absent when the validity flag is missing", () => {
    const frame = decodeTelemetryFrame(
      makeTelemetryFrame({ validityFlags: TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS }),
    );
    expect(frame.dynamicEq).toBeNull();
  });

  it("treats zero counts as unavailable fixed-layout sections", () => {
    const binary = makeTelemetryFrame({
      validityFlags: TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS,
      spectrum: Array(TELEMETRY_SPECTRUM_BINS).fill(0),
    });
    const view = new DataView(binary);
    view.setInt16(48, 12_345, true);

    const frame = decodeTelemetryFrame(binary);
    expect(binary.byteLength).toBe(TELEMETRY_FRAME_BYTES);
    expect(view.getUint8(44)).toBe(0);
    expect(view.getUint8(45)).toBe(0);
    expect(frame.waveform).toBeNull();
    expect(frame.spectrum).toBeNull();
  });

  it.each([
    ["waveform count without validity", 44, TELEMETRY_WAVEFORM_BINS],
    ["spectrum count without validity", 45, TELEMETRY_SPECTRUM_BINS],
  ])("rejects %s", (_label, offset, count) => {
    const binary = makeTelemetryFrame({
      validityFlags: TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS,
    });
    new DataView(binary).setUint8(offset, count);
    expect(() => decodeTelemetryFrame(binary)).toThrow(/count/);
  });

  it("keeps unavailable HPTM sections absent instead of decoding placeholders", () => {
    const frame = decodeTelemetryFrame(makeTelemetryFrame());

    expect(frame.waveform).toHaveLength(TELEMETRY_WAVEFORM_BINS);
    expect(frame.spectrum).toBeNull();
    expect(frame.meters).toMatchObject({
      peakLeft: expect.any(Number),
      peakRight: expect.any(Number),
      rmsLeft: expect.any(Number),
      rmsRight: expect.any(Number),
      truePeakLeft: null,
      truePeakRight: null,
      limiterReduction: null,
    });
  });

  it("ignores non-finite placeholders when their validity flag is absent", () => {
    const binary = makeTelemetryFrame();
    new DataView(binary).setFloat32(752 + 2 * 4, Number.NaN, true);
    expect(decodeTelemetryFrame(binary).meters.truePeakLeft).toBeNull();
  });

  it("rejects truncated, extended, and oversized inputs", () => {
    expect(() => decodeTelemetryFrame(makeTelemetryFrame().slice(0, -1))).toThrow(/length/);
    const extended = new Uint8Array(TELEMETRY_FRAME_BYTES + 1);
    extended.set(new Uint8Array(makeTelemetryFrame()));
    expect(() => decodeTelemetryFrame(extended)).toThrow(/length/);
    expect(() => decodeTelemetryFrame(new ArrayBuffer(TELEMETRY_MAX_FRAME_BYTES + 1))).toThrow(/exceeds/);
  });

  it("decodes an ArrayBufferView at its own byte offset", () => {
    const frameBytes = new Uint8Array(makeTelemetryFrame({ epoch: 7n }));
    const wrapped = new Uint8Array(frameBytes.byteLength + 8);
    wrapped.set(frameBytes, 4);
    expect(decodeTelemetryFrame(wrapped.subarray(4, 4 + TELEMETRY_FRAME_BYTES)).epoch).toBe(7n);
  });

  it("encodes magic as ASCII HPTM", () => {
    const view = new DataView(makeTelemetryFrame());
    expect(view.getUint32(0, true)).toBe(TELEMETRY_MAGIC);
    expect(new TextDecoder().decode(new Uint8Array(view.buffer, 0, 4))).toBe("HPTM");
  });
});
