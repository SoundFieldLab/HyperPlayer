import {
  TELEMETRY_DYNAMIC_EQ_BANDS,
  TELEMETRY_FRAME_BYTES,
  TELEMETRY_MAGIC,
  TELEMETRY_SPECTRUM_BINS,
  TELEMETRY_VALID_DYNAMIC_EQ,
  TELEMETRY_VALID_LUFS,
  TELEMETRY_VALID_RMS,
  TELEMETRY_VALID_SAMPLE_PEAK,
  TELEMETRY_VALID_SPECTRUM,
  TELEMETRY_VALID_WAVEFORM,
  TELEMETRY_VERSION,
  TELEMETRY_WAVEFORM_BINS,
  type TelemetryMeters,
} from "./schema";

interface FrameOptions {
  epoch?: bigint;
  sequence?: bigint;
  sampleFrame?: bigint;
  revision?: bigint;
  sampleRate?: number;
  validityFlags?: number;
  spectrum?: readonly number[];
  meters?: Partial<TelemetryMeters>;
  dynamicEq?: {
    generation?: number;
    gainDb?: readonly number[];
    levelDb?: readonly number[];
    reductionDb?: readonly number[];
  };
  lufs?: {
    integrated?: number;
    momentary?: number;
    shortTerm?: number;
  };
}

const DEFAULT_METERS: TelemetryMeters = {
  peakLeft: 0.8,
  peakRight: 0.7,
  truePeakLeft: 0.82,
  truePeakRight: 0.72,
  rmsLeft: 0.4,
  rmsRight: 0.35,
  limiterReduction: 2.3,
};

const DEFAULT_DYNAMIC_EQ = {
  gainDb: [-1, -2, -3, -4, -5],
  levelDb: [-30, -31, -32, -33, -34],
  reductionDb: [0.5, 1, 1.5, 2, 2.5],
};

export function makeTelemetryFrame(options: FrameOptions = {}): ArrayBuffer {
  const buffer = new ArrayBuffer(TELEMETRY_FRAME_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, TELEMETRY_MAGIC, true);
  view.setUint16(4, TELEMETRY_VERSION, true);
  const validityFlags = options.validityFlags ?? (
    TELEMETRY_VALID_WAVEFORM | TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS
  );
  view.setUint16(6, validityFlags, true);
  view.setBigUint64(8, options.epoch ?? 4n, true);
  view.setBigUint64(16, options.sequence ?? 9n, true);
  view.setBigUint64(24, options.sampleFrame ?? 96_000n, true);
  view.setBigUint64(32, options.revision ?? 12n, true);
  view.setUint32(40, options.sampleRate ?? 48_000, true);
  view.setUint8(44, validityFlags & TELEMETRY_VALID_WAVEFORM ? TELEMETRY_WAVEFORM_BINS : 0);
  view.setUint8(45, validityFlags & TELEMETRY_VALID_SPECTRUM ? TELEMETRY_SPECTRUM_BINS : 0);
  view.setUint16(46, 0, true);

  const arrayBytes = TELEMETRY_WAVEFORM_BINS * 2;
  for (let index = 0; index < TELEMETRY_WAVEFORM_BINS; index += 1) {
    const magnitude = Math.round(index / (TELEMETRY_WAVEFORM_BINS - 1) * 32_767);
    view.setInt16(48 + index * 2, -magnitude, true);
    view.setInt16(48 + arrayBytes + index * 2, -16_384, true);
    view.setInt16(48 + arrayBytes * 2 + index * 2, magnitude, true);
    view.setInt16(48 + arrayBytes * 3 + index * 2, 16_384, true);
  }

  const spectrumAvailable = (validityFlags & TELEMETRY_VALID_SPECTRUM) !== 0;
  const spectrumOffset = 560;
  if (spectrumAvailable) {
    const spectrum = options.spectrum ?? Array.from(
      { length: TELEMETRY_SPECTRUM_BINS },
      (_, index) => Math.round(index / (TELEMETRY_SPECTRUM_BINS - 1) * 65_535),
    );
    if (spectrum.length !== TELEMETRY_SPECTRUM_BINS) {
      throw new RangeError(`Fixture spectrum must contain ${TELEMETRY_SPECTRUM_BINS} bins`);
    }
    spectrum.forEach((value, index) => view.setUint16(spectrumOffset + index * 2, value, true));
  } else {
    for (let index = 0; index < TELEMETRY_SPECTRUM_BINS; index += 1) {
      view.setUint16(spectrumOffset + index * 2, 0, true);
    }
  }

  const meters = { ...DEFAULT_METERS, ...options.meters };
  Object.values(meters).forEach((value, index) => view.setFloat32(752 + index * 4, value ?? 0, true));

  const dynamicEqAvailable = (validityFlags & TELEMETRY_VALID_DYNAMIC_EQ) !== 0;
  const dynamicEqOffset = 780;
  if (dynamicEqAvailable) {
    const eq = options.dynamicEq ?? {};
    const generation = eq.generation ?? 7;
    const gainDb = eq.gainDb ?? DEFAULT_DYNAMIC_EQ.gainDb;
    const levelDb = eq.levelDb ?? DEFAULT_DYNAMIC_EQ.levelDb;
    const reductionDb = eq.reductionDb ?? DEFAULT_DYNAMIC_EQ.reductionDb;
    if ([gainDb, levelDb, reductionDb].some((bands) => bands.length !== TELEMETRY_DYNAMIC_EQ_BANDS)) {
      throw new RangeError(`Fixture dynamic-eq bands must contain ${TELEMETRY_DYNAMIC_EQ_BANDS} values`);
    }
    view.setUint32(dynamicEqOffset, generation, true);
    gainDb.forEach((value, index) => view.setFloat32(dynamicEqOffset + 4 + index * 4, value, true));
    levelDb.forEach((value, index) => view.setFloat32(dynamicEqOffset + 4 + TELEMETRY_DYNAMIC_EQ_BANDS * 4 + index * 4, value, true));
    reductionDb.forEach((value, index) => view.setFloat32(dynamicEqOffset + 4 + TELEMETRY_DYNAMIC_EQ_BANDS * 8 + index * 4, value, true));
  }

  const lufsAvailable = (validityFlags & TELEMETRY_VALID_LUFS) !== 0;
  if (lufsAvailable) {
    const lufs = options.lufs ?? {};
    const integrated = lufs.integrated ?? -14;
    const momentary = lufs.momentary ?? -14.1;
    const shortTerm = lufs.shortTerm ?? -14.2;
    view.setFloat32(844, integrated, true);
    view.setFloat32(848, momentary, true);
    view.setFloat32(852, shortTerm, true);
  }
  return buffer;
}
