/**
 * HSE v1.5.1 第 7 级 NightMode：压缩增强后独立处理左右声道的高频搁架。
 *
 * 经项目专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 Stage 7 实现。
 */

import { Biquad } from './biquad'
import { Compressor, type CompressorSettings } from './compressor'

export interface NightModeSettings {
  enabled: boolean
  amount: number
}

export const DEFAULT_NIGHT_MODE_SETTINGS: Readonly<NightModeSettings> = {
  enabled: false,
  amount: 0,
}

export class NightMode {
  private readonly compressor: Compressor
  private readonly shelfL: Biquad
  private readonly shelfR: Biquad
  private active = false

  constructor(sampleRate: number, baseCompressorSettings: CompressorSettings) {
    this.compressor = new Compressor(sampleRate)
    this.shelfL = new Biquad('highshelf', 6000, 0.707, 0, sampleRate)
    this.shelfR = new Biquad('highshelf', 6000, 0.707, 0, sampleRate)
    this.setParams(DEFAULT_NIGHT_MODE_SETTINGS, baseCompressorSettings)
  }

  setParams(night: NightModeSettings, baseCompressor: CompressorSettings): void {
    if (!Number.isFinite(night.amount)) throw new Error('night mode: amount must be finite')

    const wasActive = this.active
    this.active = night.enabled && night.amount > 0
    if (this.active) {
      const k = night.amount / 10
      this.compressor.setParams({
        enabled: true,
        thresholdDb: baseCompressor.thresholdDb - 6 * k,
        ratio: Math.max(1, baseCompressor.ratio * (1 + 0.5 * k)),
        kneeDb: baseCompressor.kneeDb,
        attackMs: baseCompressor.attackMs,
        releaseMs: baseCompressor.releaseMs,
        makeupDb: baseCompressor.makeupDb,
        outputGain: 1,
        sidechainEnabled: false,
      })
      const shelfGainDb = -1.5 * night.amount
      this.shelfL.setParams('highshelf', 6000, 0.707, shelfGainDb)
      this.shelfR.setParams('highshelf', 6000, 0.707, shelfGainDb)
    }

    if (!wasActive && this.active) this.reset()
  }

  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    if (!this.active) return
    const n = Math.max(0, Math.min(Math.floor(frameCount ?? left.length), left.length, right.length))
    this.compressor.processStereo(left, right, undefined, undefined, n)
    this.shelfL.processBlock(left, left, n)
    this.shelfR.processBlock(right, right, n)
  }

  reset(): void {
    this.compressor.reset()
    this.shelfL.reset()
    this.shelfR.reset()
  }
}
