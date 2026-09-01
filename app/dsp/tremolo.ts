/**
 * HSE v1.5.1 颤音效果。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 `TremoloEffect`。
 */

export interface TremoloSettings {
  enabled: boolean
  rateHz: number
  depth: number
  mix: number
}

export const DEFAULT_TREMOLO_SETTINGS: Readonly<TremoloSettings> = {
  enabled: false,
  rateHz: 5,
  depth: 0.5,
  mix: 1,
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`tremolo: ${name} must be finite`)
  return value
}

export class TremoloEffect {
  private readonly sampleRate: number
  private enabled = false
  private rateHz = 5
  private depth = 0.5
  private mix = 1
  private phase = 0

  constructor(sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    this.setParams(DEFAULT_TREMOLO_SETTINGS)
  }

  setParams(settings: TremoloSettings): void {
    const rateHz = requireFinite(settings.rateHz, 'rateHz')
    const depth = requireFinite(settings.depth, 'depth')
    const mix = requireFinite(settings.mix, 'mix')
    const wasEnabled = this.enabled

    this.rateHz = clamp(rateHz, 0.01, 30)
    this.depth = clamp(depth, 0, 1)
    this.mix = clamp(mix, 0, 1)
    this.enabled = settings.enabled

    if (!wasEnabled && this.enabled) this.reset()
  }

  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    const requestedFrames = frameCount ?? Math.min(left.length, right.length)
    if (!Number.isFinite(requestedFrames)) throw new Error('tremolo: frameCount must be finite')
    if (!this.enabled) return

    const frames = Math.max(0, Math.min(Math.floor(requestedFrames), left.length, right.length))
    const sampleRate = this.sampleRate
    const rateHz = this.rateHz
    const depth = this.depth
    const mix = this.mix
    let phase = this.phase

    for (let index = 0; index < frames; index++) {
      const gain = 1 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * phase))
      const mixedGain = 1 - mix + mix * gain
      left[index] = left[index] * mixedGain
      right[index] = right[index] * mixedGain
      phase = (phase + rateHz / sampleRate) % 1
    }

    this.phase = phase
  }

  reset(): void {
    this.phase = 0
  }
}
