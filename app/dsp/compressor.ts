/**
 * HSE v1.5.1 动态压缩器。
 *
 * 经项目专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 `src/dsp/Compressor.ts`。
 */

export interface CompressorSettings {
  enabled: boolean
  thresholdDb: number
  ratio: number
  kneeDb: number
  attackMs: number
  releaseMs: number
  makeupDb: number
  outputGain: number
  /** 接线层标志；便捷入口据此从处理前输入派生 mono-sum sidechain。 */
  sidechainEnabled?: boolean
}

export const DEFAULT_COMPRESSOR_SETTINGS: Readonly<CompressorSettings> = {
  enabled: true,
  thresholdDb: -20,
  ratio: 4,
  kneeDb: 6,
  attackMs: 10,
  releaseMs: 150,
  makeupDb: 0,
  outputGain: 1,
  sidechainEnabled: false,
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function onePoleCoef(timeMs: number, sampleRate: number): number {
  const ms = Math.max(timeMs, 0.05)
  return 1 - Math.exp(-1 / ((ms / 1000) * sampleRate))
}

export class Compressor {
  private readonly sampleRate: number
  private enabled = true
  private thresholdDb = -20
  private ratio = 4
  private kneeDb = 6
  private attackCoef = 0
  private releaseCoef = 0
  private makeupLinear = 1
  private outputGain = 1
  private env = 0
  private reductionDb = 0

  constructor(sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    this.applyParams(DEFAULT_COMPRESSOR_SETTINGS)
  }

  /** 该算法没有块工作缓冲；保留 prepare 入口用于统一生命周期。 */
  prepare(_maxBlockFrames: number): void {}

  setParams(params: CompressorSettings): void {
    this.applyParams(params)
  }

  private applyParams(params: CompressorSettings): void {
    this.enabled = params.enabled
    this.thresholdDb = clamp(params.thresholdDb, -80, 0)
    this.ratio = clamp(params.ratio, 1, 100)
    this.kneeDb = clamp(params.kneeDb, 0, 40)
    this.attackCoef = onePoleCoef(params.attackMs, this.sampleRate)
    this.releaseCoef = onePoleCoef(params.releaseMs, this.sampleRate)
    this.makeupLinear = Math.pow(10, clamp(params.makeupDb, -24, 24) / 20)
    this.outputGain = clamp(params.outputGain, 0, 2)
  }

  /** HSE 原始 planar API；显式 sidechain 仅在两条通道都提供时生效。 */
  processStereo(
    left: Float32Array,
    right: Float32Array,
    sideLeft?: Float32Array,
    sideRight?: Float32Array,
    frameCount?: number,
  ): void {
    if (!this.enabled) {
      this.reductionDb = 0
      return
    }
    const useExplicitSidechain = sideLeft !== undefined && sideRight !== undefined
    const n = Math.max(0, Math.min(
      Math.floor(frameCount ?? left.length),
      left.length,
      right.length,
      useExplicitSidechain ? sideLeft.length : Infinity,
      useExplicitSidechain ? sideRight.length : Infinity,
    ))
    const detectorLeft = useExplicitSidechain ? sideLeft : undefined
    const detectorRight = useExplicitSidechain ? sideRight : undefined
    this.processPlanar(left, right, detectorLeft, detectorRight, n)
  }

  /** 双声道交错 PCM 适配入口。sidechain 传入时也必须为双声道交错布局。 */
  processInterleavedStereo(
    interleaved: Float32Array,
    sidechain?: Float32Array,
    frameCount?: number,
  ): void {
    if (!this.enabled) {
      this.reductionDb = 0
      return
    }
    const availableFrames = Math.floor(interleaved.length / 2)
    const sideFrames = sidechain === undefined ? Infinity : Math.floor(sidechain.length / 2)
    const n = Math.max(0, Math.min(Math.floor(frameCount ?? availableFrames), availableFrames, sideFrames))
    this.processInterleaved(interleaved, sidechain, n)
  }

  getReductionDb(): number {
    return this.reductionDb
  }

  reset(): void {
    this.env = 0
    this.reductionDb = 0
  }

  private processPlanar(
    left: Float32Array,
    right: Float32Array,
    sideLeft: Float32Array | undefined,
    sideRight: Float32Array | undefined,
    frames: number,
  ): void {
    const useSidechain = sideLeft !== undefined && sideRight !== undefined
    const attack = this.attackCoef
    const release = this.releaseCoef
    const threshold = this.thresholdDb
    const inverseRatio = 1 - 1 / this.ratio
    const knee = this.kneeDb
    const kneeHalf = knee * 0.5
    const twoKnee = 2 * knee
    const gainScale = this.makeupLinear * this.outputGain
    for (let i = 0; i < frames; i++) {
      const xl = left[i]
      const xr = right[i]
      const el = useSidechain ? sideLeft[i] : xl
      const er = useSidechain ? sideRight[i] : xr
      const gain = this.nextGain(el, er, attack, release, threshold, inverseRatio, knee, kneeHalf, twoKnee, gainScale)
      left[i] = xl * gain
      right[i] = xr * gain
    }
  }

  private processInterleaved(interleaved: Float32Array, sidechain: Float32Array | undefined, frames: number): void {
    const attack = this.attackCoef
    const release = this.releaseCoef
    const threshold = this.thresholdDb
    const inverseRatio = 1 - 1 / this.ratio
    const knee = this.kneeDb
    const kneeHalf = knee * 0.5
    const twoKnee = 2 * knee
    const gainScale = this.makeupLinear * this.outputGain
    for (let i = 0; i < frames; i++) {
      const offset = i * 2
      const xl = interleaved[offset]
      const xr = interleaved[offset + 1]
      const el = sidechain === undefined ? xl : sidechain[offset]
      const er = sidechain === undefined ? xr : sidechain[offset + 1]
      const gain = this.nextGain(el, er, attack, release, threshold, inverseRatio, knee, kneeHalf, twoKnee, gainScale)
      interleaved[offset] = xl * gain
      interleaved[offset + 1] = xr * gain
    }
  }

  private nextGain(
    detectorLeft: number,
    detectorRight: number,
    attack: number,
    release: number,
    threshold: number,
    inverseRatio: number,
    knee: number,
    kneeHalf: number,
    twoKnee: number,
    gainScale: number,
  ): number {
    const detector = Math.abs(detectorLeft) > Math.abs(detectorRight)
      ? Math.abs(detectorLeft)
      : Math.abs(detectorRight)
    if (detector > this.env) this.env += attack * (detector - this.env)
    else this.env += release * (detector - this.env)
    const levelDb = 20 * Math.log10(this.env + 1e-12)
    let reduction: number
    if (knee <= 0) reduction = levelDb > threshold ? (levelDb - threshold) * inverseRatio : 0
    else if (levelDb < threshold - kneeHalf) reduction = 0
    else if (levelDb > threshold + kneeHalf) reduction = (levelDb - threshold) * inverseRatio
    else {
      const x = levelDb - (threshold - kneeHalf)
      reduction = (inverseRatio * x * x) / twoKnee
    }
    this.reductionDb = -reduction
    return Math.pow(10, -reduction / 20) * gainScale
  }
}
