// 遥测帧编码器（HPTM v4）：从 HSE 引擎 stats/analysis 编码为 856 字节帧，
// 对齐 schema.ts 的 decodeTelemetryFrame 校验（magic/version/布局/有效位）。

import {
  TELEMETRY_MAGIC,
  TELEMETRY_VERSION,
  TELEMETRY_FRAME_BYTES,
  TELEMETRY_WAVEFORM_BINS,
  TELEMETRY_SPECTRUM_BINS,
  TELEMETRY_VALID_WAVEFORM,
  TELEMETRY_VALID_SAMPLE_PEAK,
  TELEMETRY_VALID_RMS,
  TELEMETRY_VALID_SPECTRUM,
  TELEMETRY_VALID_TRUE_PEAK,
  TELEMETRY_VALID_LIMITER_REDUCTION,
  TELEMETRY_VALID_DYNAMIC_EQ,
  TELEMETRY_VALID_LUFS,
} from './schema'

export interface TelemetrySource {
  epoch: bigint
  sequence: bigint
  sampleFrame: bigint
  revision: bigint
  sampleRate: number
  waveform: Array<{ leftMin: number; leftMax: number; rightMin: number; rightMax: number }> | null
  spectrum: Float32Array | null
  peakLeft: number | null
  peakRight: number | null
  truePeakLeft: number | null
  truePeakRight: number | null
  rmsLeft: number | null
  rmsRight: number | null
  limiterReduction: number | null
  lufsIntegrated: number | null
  lufsMomentary: number | null
  lufsShortTerm: number | null
}

const HEADER_BYTES = 48
const WAVEFORM_ARRAY_BYTES = TELEMETRY_WAVEFORM_BINS * 2
const SPECTRUM_OFFSET = HEADER_BYTES + WAVEFORM_ARRAY_BYTES * 4
const METERS_OFFSET = SPECTRUM_OFFSET + TELEMETRY_SPECTRUM_BINS * 2
const DYNAMIC_EQ_OFFSET = TELEMETRY_FRAME_BYTES - 76
const LUFS_OFFSET = TELEMETRY_FRAME_BYTES - 12

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)))
}

function waveToInt16(value: number): number {
  return clamp16(value * 32767)
}

function spectrumToU16(db: number): number {
  const clamped = Math.max(-90, Math.min(0, db))
  const linear = Math.pow(10, clamped / 20)
  return Math.round(linear * 65535)
}

export function encodeTelemetryFrame(source: TelemetrySource): ArrayBuffer {
  const buffer = new ArrayBuffer(TELEMETRY_FRAME_BYTES)
  const view = new DataView(buffer)
  const waveformAvailable = source.waveform !== null && source.waveform.length === TELEMETRY_WAVEFORM_BINS
  const spectrumAvailable = source.spectrum !== null && source.spectrum.length === TELEMETRY_SPECTRUM_BINS

  let validity = 0
  if (waveformAvailable) validity |= TELEMETRY_VALID_WAVEFORM
  if (spectrumAvailable) validity |= TELEMETRY_VALID_SPECTRUM
  if (source.peakLeft !== null && source.peakRight !== null) validity |= TELEMETRY_VALID_SAMPLE_PEAK
  if (source.rmsLeft !== null && source.rmsRight !== null) validity |= TELEMETRY_VALID_RMS
  if (source.truePeakLeft !== null && source.truePeakRight !== null) validity |= TELEMETRY_VALID_TRUE_PEAK
  if (source.limiterReduction !== null) validity |= TELEMETRY_VALID_LIMITER_REDUCTION
  if (source.lufsIntegrated !== null) validity |= TELEMETRY_VALID_LUFS

  view.setUint32(0, TELEMETRY_MAGIC, true)
  view.setUint16(4, TELEMETRY_VERSION, true)
  view.setUint16(6, validity, true)
  view.setBigUint64(8, source.epoch, true)
  view.setBigUint64(16, source.sequence, true)
  view.setBigUint64(24, source.sampleFrame, true)
  view.setBigUint64(32, source.revision, true)
  view.setUint32(40, source.sampleRate, true)
  view.setUint8(44, waveformAvailable ? TELEMETRY_WAVEFORM_BINS : 0)
  view.setUint8(45, spectrumAvailable ? TELEMETRY_SPECTRUM_BINS : 0)
  view.setUint16(46, 0, true)

  if (waveformAvailable && source.waveform) {
    const leftMinOffset = HEADER_BYTES
    const rightMinOffset = leftMinOffset + WAVEFORM_ARRAY_BYTES
    const leftMaxOffset = rightMinOffset + WAVEFORM_ARRAY_BYTES
    const rightMaxOffset = leftMaxOffset + WAVEFORM_ARRAY_BYTES
    for (let index = 0; index < TELEMETRY_WAVEFORM_BINS; index += 1) {
      const bin = source.waveform[index]
      view.setInt16(leftMinOffset + index * 2, waveToInt16(bin.leftMin), true)
      view.setInt16(rightMinOffset + index * 2, waveToInt16(bin.rightMin), true)
      view.setInt16(leftMaxOffset + index * 2, waveToInt16(bin.leftMax), true)
      view.setInt16(rightMaxOffset + index * 2, waveToInt16(bin.rightMax), true)
    }
  }

  if (spectrumAvailable && source.spectrum) {
    for (let index = 0; index < TELEMETRY_SPECTRUM_BINS; index += 1) {
      view.setUint16(SPECTRUM_OFFSET + index * 2, spectrumToU16(source.spectrum[index]), true)
    }
  }

  const meter = (index: number, value: number | null, flag: number) => {
    if (value !== null && (validity & flag) !== 0) {
      view.setFloat32(METERS_OFFSET + index * 4, value, true)
    }
  }
  meter(0, source.peakLeft, TELEMETRY_VALID_SAMPLE_PEAK)
  meter(1, source.peakRight, TELEMETRY_VALID_SAMPLE_PEAK)
  meter(2, source.truePeakLeft, TELEMETRY_VALID_TRUE_PEAK)
  meter(3, source.truePeakRight, TELEMETRY_VALID_TRUE_PEAK)
  meter(4, source.rmsLeft, TELEMETRY_VALID_RMS)
  meter(5, source.rmsRight, TELEMETRY_VALID_RMS)
  meter(6, source.limiterReduction, TELEMETRY_VALID_LIMITER_REDUCTION)

  // dynamic-eq 区域：HSE 未暴露该读数前保持全零（解码器接受）
  // LUFS 区域
  if (source.lufsIntegrated !== null) view.setFloat32(LUFS_OFFSET, source.lufsIntegrated, true)
  if (source.lufsMomentary !== null) view.setFloat32(LUFS_OFFSET + 4, source.lufsMomentary, true)
  if (source.lufsShortTerm !== null) view.setFloat32(LUFS_OFFSET + 8, source.lufsShortTerm, true)

  return buffer
}

export function createTelemetrySource(
  epoch: bigint,
  sequence: bigint,
  sampleFrame: bigint,
  revision: bigint,
  sampleRate: number,
  stats: {
    peakDb?: number
    truePeakDb?: number
    limiterReductionDb?: number
    lufsIntegrated?: number
    lufsMomentary?: number
  },
  spectrum: Float32Array | null,
): TelemetrySource {
  // 峰值 dBFS → 线性幅度（-inf 视为无数据）
  const dbToLinear = (db: number | undefined | null): number | null => (
    db === undefined || db === null || !Number.isFinite(db) ? null : Math.pow(10, db / 20)
  )
  return {
    epoch,
    sequence,
    sampleFrame,
    revision,
    sampleRate,
    waveform: null,
    spectrum,
    peakLeft: dbToLinear(stats.peakDb),
    peakRight: dbToLinear(stats.peakDb),
    truePeakLeft: dbToLinear(stats.truePeakDb),
    truePeakRight: dbToLinear(stats.truePeakDb),
    rmsLeft: null,
    rmsRight: null,
    limiterReduction: stats.limiterReductionDb ?? null,
    lufsIntegrated: stats.lufsIntegrated ?? null,
    lufsMomentary: stats.lufsMomentary ?? null,
    lufsShortTerm: null,
  }
}
