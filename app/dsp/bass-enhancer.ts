/**
 * HSE v1.5.1 虚拟低频增强。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`)。内部滤波器保持原实现的固定
 * 48 kHz 系数设计行为。
 */

export type HarmonicType = 'odd' | 'even' | 'atan' | 'soft'

export interface BassEnhancerSettings {
  enabled: boolean
  cutoffHz: number
  q: number
  harmonicType: HarmonicType
  harmonicGain: number
  mix: number
  levelDb: number
  lowBoostDb?: number
}

interface Coefficients {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

const DESIGN_SAMPLE_RATE = 48_000

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function designFilter(highpass: boolean, frequency: number, q: number): Coefficients {
  const nyquist = DESIGN_SAMPLE_RATE / 2
  const f = Math.min(Math.max(frequency, 10), nyquist * (1 - 1e-9))
  const effectiveQ = Math.max(q, 1e-6)
  const omega = 2 * Math.PI * f / DESIGN_SAMPLE_RATE
  const cosine = Math.cos(omega)
  const alpha = Math.sin(omega) / (2 * effectiveQ)
  const a0 = 1 + alpha
  if (!(a0 > 0) || !Number.isFinite(a0)) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
  const b0 = highpass ? (1 + cosine) / 2 : (1 - cosine) / 2
  const b1 = highpass ? -(1 + cosine) : 1 - cosine
  const b2 = b0
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  }
}

class MonoBiquad {
  private coefficients: Coefficients = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
  private s1 = 0
  private s2 = 0

  configure(highpass: boolean, frequency: number, q: number): void {
    this.coefficients = designFilter(highpass, frequency, q)
  }

  process(input: number): number {
    const output = this.coefficients.b0 * input + this.s1
    this.s1 = this.coefficients.b1 * input - this.coefficients.a1 * output + this.s2
    this.s2 = this.coefficients.b2 * input - this.coefficients.a2 * output
    return output
  }

  reset(): void {
    this.s1 = 0
    this.s2 = 0
  }
}

export class BassEnhancer {
  private enabled = true
  private harmonicType: HarmonicType = 'odd'
  private harmonicGain = 0.6
  private mix = 0.5
  private levelLinear = 1
  private lowLinear = 0
  private readonly lowpassLeft = new MonoBiquad()
  private readonly lowpassRight = new MonoBiquad()
  private readonly highpassLeft = new MonoBiquad()
  private readonly highpassRight = new MonoBiquad()

  constructor(private readonly sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.setParams({
      enabled: true,
      cutoffHz: 90,
      q: 0.7,
      harmonicType: 'odd',
      harmonicGain: 0.6,
      mix: 0.5,
      levelDb: 0,
    })
  }

  setParams(settings: BassEnhancerSettings): void {
    this.enabled = settings.enabled
    const cutoff = clamp(settings.cutoffHz, 20, this.sampleRate * 0.45)
    const q = clamp(settings.q, 0.1, 20)
    this.harmonicType = settings.harmonicType
    this.harmonicGain = clamp(settings.harmonicGain, 0, 1)
    this.mix = clamp(settings.mix, 0, 1)
    this.levelLinear = Math.pow(10, clamp(settings.levelDb, -6, 6) / 20)
    const lowBoost = typeof settings.lowBoostDb === 'number' && Number.isFinite(settings.lowBoostDb)
      ? settings.lowBoostDb
      : 0
    this.lowLinear = Math.pow(10, clamp(lowBoost, -6, 12) / 20) - 1
    const highpassCutoff = clamp(Math.max(150, cutoff * 1.5), 20, this.sampleRate * 0.45)
    this.lowpassLeft.configure(false, cutoff, q)
    this.lowpassRight.configure(false, cutoff, q)
    this.highpassLeft.configure(true, highpassCutoff, 0.707)
    this.highpassRight.configure(true, highpassCutoff, 0.707)
  }

  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    if (left.length !== right.length) throw new Error('bass-enhancer: L/R length mismatch')
    if (!this.enabled) return
    const frames = Math.max(0, Math.min(Math.floor(frameCount ?? left.length), left.length))
    const harmonicScale = this.mix * this.harmonicGain * this.levelLinear
    for (let index = 0; index < frames; index++) {
      const inputLeft = left[index]
      const inputRight = right[index]
      const bassLeft = this.lowpassLeft.process(inputLeft)
      const bassRight = this.lowpassRight.process(inputRight)
      const harmonicLeft = this.highpassLeft.process(this.nonlinearity(bassLeft))
      const harmonicRight = this.highpassRight.process(this.nonlinearity(bassRight))
      left[index] = inputLeft + harmonicScale * harmonicLeft + this.lowLinear * bassLeft
      right[index] = inputRight + harmonicScale * harmonicRight + this.lowLinear * bassRight
    }
  }

  reset(): void {
    this.lowpassLeft.reset()
    this.lowpassRight.reset()
    this.highpassLeft.reset()
    this.highpassRight.reset()
  }

  private nonlinearity(input: number): number {
    switch (this.harmonicType) {
      case 'even': return Math.abs(input)
      case 'atan': return Math.atan(Math.sqrt(Math.abs(input))) * Math.sign(input)
      case 'soft': return Math.tanh(2 * input)
      default: return input * input * input
    }
  }
}
