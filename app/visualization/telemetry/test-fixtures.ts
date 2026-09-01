import {
  TELEMETRY_FRAME_BYTES,
  TELEMETRY_MAGIC,
  TELEMETRY_SPECTRUM_BINS,
  TELEMETRY_VALID_RMS,
  TELEMETRY_VALID_SAMPLE_PEAK,
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
  view.setUint8(45, validityFlags & (1 << 3) ? TELEMETRY_SPECTRUM_BINS : 0);
  view.setUint16(46, 0, true);

  const arrayBytes = TELEMETRY_WAVEFORM_BINS * 2;
  for (let index = 0; index < TELEMETRY_WAVEFORM_BINS; index += 1) {
    const magnitude = Math.round(index / (TELEMETRY_WAVEFORM_BINS - 1) * 32_767);
    view.setInt16(48 + index * 2, -magnitude, true);
    view.setInt16(48 + arrayBytes + index * 2, -16_384, true);
    view.setInt16(48 + arrayBytes * 2 + index * 2, magnitude, true);
    view.setInt16(48 + arrayBytes * 3 + index * 2, 16_384, true);
  }

  const spectrumAvailable = (validityFlags & (1 << 3)) !== 0;
  if (spectrumAvailable) {
    const spectrum = options.spectrum ?? Array.from(
      { length: TELEMETRY_SPECTRUM_BINS },
      (_, index) => Math.round(index / (TELEMETRY_SPECTRUM_BINS - 1) * 65_535),
    );
    if (spectrum.length !== TELEMETRY_SPECTRUM_BINS) {
      throw new RangeError(`Fixture spectrum must contain ${TELEMETRY_SPECTRUM_BINS} bins`);
    }
    spectrum.forEach((value, index) => view.setUint16(560 + index * 2, value, true));
  } else {
    for (let index = 0; index < TELEMETRY_SPECTRUM_BINS; index += 1) {
      view.setUint16(560 + index * 2, 0, true);
    }
  }

  const meters = { ...DEFAULT_METERS, ...options.meters };
  Object.values(meters).forEach((value, index) => view.setFloat32(752 + index * 4, value ?? 0, true));
  return buffer;
}
