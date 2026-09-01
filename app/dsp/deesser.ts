/**
 * HSE v1.5.1 动态齿音抑制器。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 `src/dsp/Deesser.ts`。
 */

import { Biquad } from './biquad'

export interface DeesserSettings {
  enabled: boolean
  centerHz: number
  q: number
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  splitBand: boolean
  mix: number
  /** 接线层标志；模块本身根据是否传入 sidechain 缓冲决定检测信号。 */
  sidechainEnabled?: boolean
}

export const DEFAULT_DEESSER_SETTINGS: Readonly<DeesserSettings> = {
  enabled: true,
  centerHz: 6000,
  q: 0.7,
  thresholdDb: -30,
  ratio: 8,
  attackMs: 1,
  releaseMs: 80,
  splitBand: true,
  mix: 1,
  sidechainEnabled: false,
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function onePoleCoef(timeMs: number, sampleRate: number, floorMs: number): number {
  const ms = Math.max(timeMs, floorMs)
  return 1 - Math.exp(-1 / ((ms / 1000) * sampleRate))
}

export class Deesser {
  private readonly sampleRate: number
  private enabled = true
  private centerHz = 6000
  private q = 0.7
  private thresholdDb = -30
  private ratio = 8
  private splitBand = true
  private mix = 1
  private attackCoef = 0
  private releaseCoef = 0
  private env = 0
  private readonly bandpass = new Biquad()
  private readonly lowpassLeft1 = new Biquad()
  private readonly lowpassLeft2 = new Biquad()
  private readonly lowpassRight1 = new Biquad()
  private readonly lowpassRight2 = new Biquad()
  private readonly highpassLeft1 = new Biquad()
  private readonly highpassLeft2 = new Biquad()
  private readonly highpassRight1 = new Biquad()
  private readonly highpassRight2 = new Biquad()

  constructor(sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    this.applyParams(DEFAULT_DEESSER_SETTINGS)
  }

  setParams(settings: DeesserSettings): void {
    this.applyParams(settings)
  }

  private applyParams(settings: DeesserSettings): void {
    this.enabled = settings.enabled
    this.centerHz = clamp(settings.centerHz, 100, this.sampleRate * 0.45)
    this.q = clamp(settings.q, 0.1, 20)
    this.thresholdDb = clamp(settings.thresholdDb, -80, 0)
    this.ratio = clamp(settings.ratio, 1, 100)
    this.splitBand = settings.splitBand
    this.mix = clamp(settings.mix, 0, 1)
    this.attackCoef = onePoleCoef(settings.attackMs, this.sampleRate, 0.05)
    this.releaseCoef = onePoleCoef(settings.releaseMs, this.sampleRate, 1)
    this.bandpass.setParams('bandpass', this.centerHz, this.q, 0)
    const crossover = clamp(this.centerHz * 0.6, 2500, this.sampleRate * 0.45)
    this.lowpassLeft1.setParams('lowpass', crossover, 0.7071, 0)
    this.lowpassLeft2.setParams('lowpass', crossover, 0.7071, 0)
    this.lowpassRight1.setParams('lowpass', crossover, 0.7071, 0)
    this.lowpassRight2.setParams('lowpass', crossover, 0.7071, 0)
    this.highpassLeft1.setParams('highpass', crossover, 0.7071, 0)
    this.highpassLeft2.setParams('highpass', crossover, 0.7071, 0)
    this.highpassRight1.setParams('highpass', crossover, 0.7071, 0)
    this.highpassRight2.setParams('highpass', crossover, 0.7071, 0)
  }

  processStereo(
    left: Float32Array,
    right: Float32Array,
    sideLeft?: Float32Array,
    sideRight?: Float32Array,
    frameCount?: number,
  ): void {
    if (!this.enabled) return
    const useSidechain = sideLeft !== undefined && sideRight !== undefined
    const frames = Math.max(0, Math.min(
      Math.floor(frameCount ?? left.length),
      left.length,
      right.length,
      useSidechain ? sideLeft.length : Infinity,
      useSidechain ? sideRight.length : Infinity,
    ))
    const attack = this.attackCoef
    const release = this.releaseCoef
    const thresholdDb = this.thresholdDb
    const inverseRatio = 1 - 1 / this.ratio
    const mix = this.mix
    const splitBand = this.splitBand

    for (let index = 0; index < frames; index++) {
      const inputLeft = left[index]
      const inputRight = right[index]
      const detectorLeft = useSidechain ? sideLeft![index] : inputLeft
      const detectorRight = useSidechain ? sideRight![index] : inputRight
      const detector = this.bandpass.process(0.5 * (detectorLeft + detectorRight))
      const power = detector * detector
      if (power > this.env) this.env += attack * (power - this.env)
      else this.env += release * (power - this.env)
      const levelDb = 10 * Math.log10(this.env + 1e-12)
      const over = levelDb - thresholdDb
      const reduction = over > 0 ? over * inverseRatio : 0
      const gain = Math.pow(10, -reduction / 20)

      if (splitBand) {
        const lowLeft = this.lowpassLeft2.process(this.lowpassLeft1.process(inputLeft))
        const lowRight = this.lowpassRight2.process(this.lowpassRight1.process(inputRight))
        const highLeft = this.highpassLeft2.process(this.highpassLeft1.process(inputLeft))
        const highRight = this.highpassRight2.process(this.highpassRight1.process(inputRight))
        const outputLeft = lowLeft + gain * highLeft
        const outputRight = lowRight + gain * highRight
        left[index] = inputLeft + mix * (outputLeft - inputLeft)
        right[index] = inputRight + mix * (outputRight - inputRight)
      } else {
        left[index] = inputLeft + mix * (inputLeft * gain - inputLeft)
        right[index] = inputRight + mix * (inputRight * gain - inputRight)
      }
    }
  }

  reset(): void {
    this.env = 0
    this.bandpass.reset()
    this.lowpassLeft1.reset()
    this.lowpassLeft2.reset()
    this.lowpassRight1.reset()
    this.lowpassRight2.reset()
    this.highpassLeft1.reset()
    this.highpassLeft2.reset()
    this.highpassRight1.reset()
    this.highpassRight2.reset()
  }
}
