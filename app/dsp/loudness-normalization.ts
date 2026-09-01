/**
 * HSE v1.5.1 响度归一化 stage 1。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，从 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的引擎处理级独立移植。
 */

import type { LufsMeter } from './lufs-meter'

export interface LoudnessNormalizationSettings {
  enabled: boolean
  targetLufs: number
  maxGainDb: number
  minGainDb: number
  useRealtimeMeter: boolean
  externalGainDb: number
}

/** 与 HSE v1.5.1 `createDefaultParams()` 完全一致。 */
export const DEFAULT_LOUDNESS_NORMALIZATION_SETTINGS: Readonly<LoudnessNormalizationSettings> = {
  enabled: false,
  targetLufs: -14,
  maxGainDb: 9,
  minGainDb: -9,
  useRealtimeMeter: true,
  externalGainDb: 0,
}

/** 与 HSE 原接口名兼容。 */
export type LoudnessNormSettings = LoudnessNormalizationSettings

type MeterReadings = Pick<LufsMeter, 'getIntegratedLufs' | 'getMomentaryLufs'>

const REALTIME_SMOOTH_SECONDS = 3.0
const EXTERNAL_GAIN_SMOOTH_SECONDS = 0.08

export class LoudnessNormalization {
  private readonly sampleRate: number
  private readonly meter: MeterReadings
  private enabled = false
  private targetLufs = -14
  private maxGainDb = 9
  private minGainDb = -9
  private useRealtimeMeter = true
  private externalGainDb = 0
  private gain = 1

  constructor(sampleRate: number, meter: MeterReadings) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    this.meter = meter
    this.setParams(DEFAULT_LOUDNESS_NORMALIZATION_SETTINGS)
  }

  /** 该级只有 f64 Number 标量状态，无块工作缓冲；保留统一 DSP 生命周期入口。 */
  prepare(_maxBlockFrames: number): void {}

  setParams(settings: LoudnessNormalizationSettings): void {
    this.enabled = settings.enabled
    this.targetLufs = settings.targetLufs
    this.maxGainDb = settings.maxGainDb
    this.minGainDb = settings.minGainDb
    this.useRealtimeMeter = settings.useRealtimeMeter
    this.externalGainDb = settings.externalGainDb
    if (!this.enabled) this.gain = 1
  }

  /**
   * 就地处理 stage 1。实时模式只读取 meter 中已经完成的历史块。
   * 固定调用顺序：本方法 -> 其余处理级 -> meter.processStereo(当前处理后块)。
   */
  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    if (!this.enabled) return
    const frames = Math.max(0, Math.min(Math.floor(frameCount ?? left.length), left.length, right.length))
    if (this.useRealtimeMeter) {
      const integrated = this.meter.getIntegratedLufs()
      const measured = Number.isFinite(integrated) ? integrated : this.meter.getMomentaryLufs()
      const gainDb = Number.isFinite(measured)
        ? Math.min(this.maxGainDb, Math.max(this.minGainDb, this.targetLufs - measured))
        : 0
      const targetGain = Math.pow(10, gainDb / 20)
      const alpha = 1 - Math.exp(-(frames / this.sampleRate) / REALTIME_SMOOTH_SECONDS)
      this.gain += alpha * (targetGain - this.gain)
    } else {
      const gainDb = Math.min(this.maxGainDb, Math.max(this.minGainDb, this.externalGainDb))
      const targetGain = Math.pow(10, gainDb / 20)
      const alpha = 1 - Math.exp(-(frames / this.sampleRate) / EXTERNAL_GAIN_SMOOTH_SECONDS)
      this.gain += alpha * (targetGain - this.gain)
    }

    const gain = this.gain
    for (let index = 0; index < frames; index++) {
      left[index] *= gain
      right[index] *= gain
    }
  }

  getGain(): number {
    return this.gain
  }

  getGainDb(): number {
    return 20 * Math.log10(this.gain)
  }

  reset(): void {
    this.gain = 1
  }
}
