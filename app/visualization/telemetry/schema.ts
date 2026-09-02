export const TELEMETRY_MAGIC = 0x4d545048;
export const TELEMETRY_VERSION = 4;
export const TELEMETRY_FRAME_BYTES = 856;
export const TELEMETRY_MAX_FRAME_BYTES = 1024;
export const TELEMETRY_WAVEFORM_BINS = 64;
export const TELEMETRY_SPECTRUM_BINS = 96;
export const TELEMETRY_SPECTRUM_FLOOR_DB = -90;
export const TELEMETRY_VALID_WAVEFORM = 1 << 0;
export const TELEMETRY_VALID_SAMPLE_PEAK = 1 << 1;
export const TELEMETRY_VALID_RMS = 1 << 2;
export const TELEMETRY_VALID_SPECTRUM = 1 << 3;
export const TELEMETRY_VALID_TRUE_PEAK = 1 << 4;
export const TELEMETRY_VALID_LIMITER_REDUCTION = 1 << 5;
export const TELEMETRY_VALID_DYNAMIC_EQ = 1 << 6;
export const TELEMETRY_VALID_LUFS = 1 << 7;

const TELEMETRY_KNOWN_VALIDITY_FLAGS = TELEMETRY_VALID_WAVEFORM
  | TELEMETRY_VALID_SAMPLE_PEAK
  | TELEMETRY_VALID_RMS
  | TELEMETRY_VALID_SPECTRUM
  | TELEMETRY_VALID_TRUE_PEAK
  | TELEMETRY_VALID_LIMITER_REDUCTION
  | TELEMETRY_VALID_DYNAMIC_EQ
  | TELEMETRY_VALID_LUFS;

const HEADER_BYTES = 48;
const WAVEFORM_ARRAY_BYTES = TELEMETRY_WAVEFORM_BINS * 2;
const SPECTRUM_OFFSET = HEADER_BYTES + WAVEFORM_ARRAY_BYTES * 4;
const METERS_OFFSET = SPECTRUM_OFFSET + TELEMETRY_SPECTRUM_BINS * 2;

// HPTM v4 追加块（v3 固定区 0..844 原样保留）：dynamic-eq 块 [780..844] +
// LUFS 块 [844..856]（integrated/momentary/short-term 各 f32）。
export const TELEMETRY_DYNAMIC_EQ_BANDS = 5;
const DYNAMIC_EQ_OFFSET = TELEMETRY_FRAME_BYTES - 76;
const DYNAMIC_EQ_GENERATION_OFFSET = DYNAMIC_EQ_OFFSET;
const DYNAMIC_EQ_GAIN_OFFSET = DYNAMIC_EQ_GENERATION_OFFSET + 4;
const DYNAMIC_EQ_LEVEL_OFFSET = DYNAMIC_EQ_GAIN_OFFSET + TELEMETRY_DYNAMIC_EQ_BANDS * 4;
const DYNAMIC_EQ_REDUCTION_OFFSET = DYNAMIC_EQ_LEVEL_OFFSET + TELEMETRY_DYNAMIC_EQ_BANDS * 4;
// LUFS 块紧随 dynamic-eq 块：[844..856]。
const LUFS_OFFSET = TELEMETRY_FRAME_BYTES - 12;
const LUFS_INTEGRATED_OFFSET = LUFS_OFFSET;
const LUFS_MOMENTARY_OFFSET = LUFS_INTEGRATED_OFFSET + 4;
const LUFS_SHORT_TERM_OFFSET = LUFS_MOMENTARY_OFFSET + 4;

export interface WaveformBin {
  leftMin: number;
  leftMax: number;
  rightMin: number;
  rightMax: number;
}

export interface TelemetryMeters {
  peakLeft: number | null;
  peakRight: number | null;
  truePeakLeft: number | null;
  truePeakRight: number | null;
  rmsLeft: number | null;
  rmsRight: number | null;
  limiterReduction: number | null;
}

export interface TelemetryDynamicEqBand {
  gainDb: number;
  levelDb: number;
  reductionDb: number;
}

export interface TelemetryFrame {
  epoch: bigint;
  sequence: bigint;
  sampleFrame: bigint;
  revision: bigint;
  sampleRate: number;
  waveform: readonly WaveformBin[] | null;
  spectrum: Float32Array | null;
  meters: TelemetryMeters;
  dynamicEq: {
    generation: number;
    bands: readonly TelemetryDynamicEqBand[];
  } | null;
  lufs: {
    integrated: number;
    momentary: number;
    shortTerm: number;
  } | null;
}

export class TelemetryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryDecodeError";
  }
}

function fail(message: string): never {
  throw new TelemetryDecodeError(message);
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) fail(`${field} must be finite`);
  return value;
}

function normalizedWave(value: number): number {
  return Math.max(-1, Math.min(1, value / 32_767));
}

function spectrumDb(value: number): number {
  if (value === 0) return TELEMETRY_SPECTRUM_FLOOR_DB;
  const db = 20 * Math.log10(value / 65_535);
  return Math.max(TELEMETRY_SPECTRUM_FLOOR_DB, Math.min(0, db));
}

export function decodeTelemetryFrame(input: ArrayBuffer | ArrayBufferView): TelemetryFrame {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

  if (bytes.byteLength > TELEMETRY_MAX_FRAME_BYTES) fail("Telemetry frame exceeds 1024 bytes");
  if (bytes.byteLength !== TELEMETRY_FRAME_BYTES) {
    fail(`Telemetry frame length ${bytes.byteLength} does not match expected ${TELEMETRY_FRAME_BYTES}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== TELEMETRY_MAGIC) fail("Telemetry frame has invalid magic");
  const version = view.getUint16(4, true);
  if (version !== TELEMETRY_VERSION) fail(`Unsupported telemetry version ${version}`);
  const validity = view.getUint16(6, true);
  if ((validity & ~TELEMETRY_KNOWN_VALIDITY_FLAGS) !== 0) fail("Telemetry frame has unknown validity flags");
  const waveformAvailable = (validity & TELEMETRY_VALID_WAVEFORM) !== 0;
  const spectrumAvailable = (validity & TELEMETRY_VALID_SPECTRUM) !== 0;
  if (view.getUint8(44) !== (waveformAvailable ? TELEMETRY_WAVEFORM_BINS : 0)) fail("Telemetry waveform count does not match validity");
  if (view.getUint8(45) !== (spectrumAvailable ? TELEMETRY_SPECTRUM_BINS : 0)) fail("Telemetry spectrum count does not match validity");
  if (view.getUint16(46, true) !== 0) fail("Telemetry frame reserved field must be zero");
  if (!spectrumAvailable && bytes.subarray(SPECTRUM_OFFSET, METERS_OFFSET).some((byte) => byte !== 0)) {
    fail("Telemetry reserved spectrum area must be zero");
  }

  const sampleRate = view.getUint32(40, true);
  if (sampleRate === 0) fail("Telemetry sample rate must be positive");

  const waveform: WaveformBin[] | null = waveformAvailable ? new Array(TELEMETRY_WAVEFORM_BINS) : null;
  const leftMinOffset = HEADER_BYTES;
  const rightMinOffset = leftMinOffset + WAVEFORM_ARRAY_BYTES;
  const leftMaxOffset = rightMinOffset + WAVEFORM_ARRAY_BYTES;
  const rightMaxOffset = leftMaxOffset + WAVEFORM_ARRAY_BYTES;
  for (let index = 0; waveform && index < TELEMETRY_WAVEFORM_BINS; index += 1) {
    const leftMin = normalizedWave(view.getInt16(leftMinOffset + index * 2, true));
    const rightMin = normalizedWave(view.getInt16(rightMinOffset + index * 2, true));
    const leftMax = normalizedWave(view.getInt16(leftMaxOffset + index * 2, true));
    const rightMax = normalizedWave(view.getInt16(rightMaxOffset + index * 2, true));
    if (leftMin > leftMax || rightMin > rightMax) fail(`waveform[${index}] min exceeds max`);
    waveform[index] = { leftMin, leftMax, rightMin, rightMax };
  }

  const spectrum = spectrumAvailable ? new Float32Array(TELEMETRY_SPECTRUM_BINS) : null;
  for (let index = 0; spectrum && index < TELEMETRY_SPECTRUM_BINS; index += 1) {
    spectrum[index] = spectrumDb(view.getUint16(SPECTRUM_OFFSET + index * 2, true));
  }

  const meter = (index: number, field: string, flag: number) => (
    (validity & flag) !== 0 ? finite(view.getFloat32(METERS_OFFSET + index * 4, true), field) : null
  );
  const meters: TelemetryMeters = {
    peakLeft: meter(0, "peakLeft", TELEMETRY_VALID_SAMPLE_PEAK),
    peakRight: meter(1, "peakRight", TELEMETRY_VALID_SAMPLE_PEAK),
    truePeakLeft: meter(2, "truePeakLeft", TELEMETRY_VALID_TRUE_PEAK),
    truePeakRight: meter(3, "truePeakRight", TELEMETRY_VALID_TRUE_PEAK),
    rmsLeft: meter(4, "rmsLeft", TELEMETRY_VALID_RMS),
    rmsRight: meter(5, "rmsRight", TELEMETRY_VALID_RMS),
    limiterReduction: meter(6, "limiterReduction", TELEMETRY_VALID_LIMITER_REDUCTION),
  };

  // HPTM v3 追加块：dynamic-eq 5-band 读数（无有效位时保持全零/缺省）。
  const dynamicEqAvailable = (validity & TELEMETRY_VALID_DYNAMIC_EQ) !== 0;
  let dynamicEq: TelemetryFrame["dynamicEq"] = null;
  if (dynamicEqAvailable) {
    const generation = view.getUint32(DYNAMIC_EQ_GENERATION_OFFSET, true);
    const bands = new Array<TelemetryDynamicEqBand>(TELEMETRY_DYNAMIC_EQ_BANDS);
    for (let index = 0; index < TELEMETRY_DYNAMIC_EQ_BANDS; index += 1) {
      bands[index] = {
        gainDb: finite(view.getFloat32(DYNAMIC_EQ_GAIN_OFFSET + index * 4, true), `dynamicEq[${index}].gainDb`),
        levelDb: finite(view.getFloat32(DYNAMIC_EQ_LEVEL_OFFSET + index * 4, true), `dynamicEq[${index}].levelDb`),
        reductionDb: finite(view.getFloat32(DYNAMIC_EQ_REDUCTION_OFFSET + index * 4, true), `dynamicEq[${index}].reductionDb`),
      };
    }
    dynamicEq = { generation, bands };
  } else if (bytes.subarray(DYNAMIC_EQ_OFFSET, DYNAMIC_EQ_OFFSET + 64).some((byte) => byte !== 0)) {
    fail("Telemetry dynamic-eq area must be zero when unresolved");
  }

  // HPTM v4 追加块：LUFS 响度（integrated/momentary/short-term 各 f32）。
  const lufsAvailable = (validity & TELEMETRY_VALID_LUFS) !== 0;
  let lufs: TelemetryFrame["lufs"] = null;
  if (lufsAvailable) {
    lufs = {
      integrated: finite(view.getFloat32(LUFS_INTEGRATED_OFFSET, true), "lufs.integrated"),
      momentary: finite(view.getFloat32(LUFS_MOMENTARY_OFFSET, true), "lufs.momentary"),
      shortTerm: finite(view.getFloat32(LUFS_SHORT_TERM_OFFSET, true), "lufs.shortTerm"),
    };
  } else if (bytes.subarray(LUFS_OFFSET, TELEMETRY_FRAME_BYTES).some((byte) => byte !== 0)) {
    fail("Telemetry LUFS area must be zero when unresolved");
  }

  return {
    epoch: view.getBigUint64(8, true),
    sequence: view.getBigUint64(16, true),
    sampleFrame: view.getBigUint64(24, true),
    revision: view.getBigUint64(32, true),
    sampleRate,
    waveform,
    spectrum,
    meters,
    dynamicEq,
    lufs,
  };
}
