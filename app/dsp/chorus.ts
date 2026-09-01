/**
 * HSE v1.5.1 合唱效果。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 `ChorusEffect`。
 */

export interface ChorusSettings {
  enabled: boolean
  rateHz: number
  depthMs: number
  mix: number
}

export const DEFAULT_CHORUS_SETTINGS: Readonly<ChorusSettings> = {
  enabled: false,
  rateHz: 1,
  depthMs: 3,
  mix: 0.4,
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`chorus: ${name} must be finite`)
  return value
}

export class ChorusEffect {
  private readonly sampleRate: number
  private readonly bufferLeft: Float32Array
  private readonly bufferRight: Float32Array
  private enabled = false
  private position = 0
  private phase = 0
  private rateHz = 1
  private depthSamples = 0
  private mix = 0.4

  constructor(sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    const bufferLength = Math.ceil(sampleRate * 0.1) + 2
    this.bufferLeft = new Float32Array(bufferLength)
    this.bufferRight = new Float32Array(bufferLength)
    this.setParams(DEFAULT_CHORUS_SETTINGS)
  }

  setParams(settings: ChorusSettings): void {
    const rateHz = requireFinite(settings.rateHz, 'rateHz')
    const depthMs = requireFinite(settings.depthMs, 'depthMs')
    const mix = requireFinite(settings.mix, 'mix')
    const wasEnabled = this.enabled

    this.rateHz = clamp(rateHz, 0.01, 20)
    this.depthSamples = (clamp(depthMs, 0, 50) / 1000) * this.sampleRate
    this.mix = clamp(mix, 0, 1)
    this.enabled = settings.enabled

    if (!wasEnabled && this.enabled) this.reset()
  }

  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    if (left.length !== right.length) throw new Error('chorus: L/R length mismatch')
    if (!this.enabled) return

    const requestedFrames = frameCount ?? left.length
    if (!Number.isFinite(requestedFrames)) throw new Error('chorus: frameCount must be finite')
    const frames = Math.max(0, Math.min(Math.floor(requestedFrames), left.length))
    const bufferLeft = this.bufferLeft
    const bufferRight = this.bufferRight
    const bufferLength = bufferLeft.length
    const delaySamples = clamp(
      0.02 * this.sampleRate + this.depthSamples * Math.sin(2 * Math.PI * this.phase),
      0,
      bufferLength - 1,
    )
    const delayFloor = Math.floor(delaySamples)
    const fraction = delaySamples - delayFloor
    const mix = this.mix
    let position = this.position

    for (let index = 0; index < frames; index++) {
      const inputLeft = left[index]
      const inputRight = right[index]
      const readIndex0 = (position - delayFloor + bufferLength) % bufferLength
      const readIndex1 = (readIndex0 - 1 + bufferLength) % bufferLength
      const wetLeft = bufferLeft[readIndex0] * (1 - fraction) + bufferLeft[readIndex1] * fraction
      const wetRight = bufferRight[readIndex0] * (1 - fraction) + bufferRight[readIndex1] * fraction

      bufferLeft[position] = inputLeft
      bufferRight[position] = inputRight
      left[index] = inputLeft * (1 - mix) + wetLeft * mix
      right[index] = inputRight * (1 - mix) + wetRight * mix
      position = (position + 1) % bufferLength
    }

    this.position = position
    this.phase = (this.phase + (this.rateHz * frames) / this.sampleRate) % 1
  }

  reset(): void {
    this.bufferLeft.fill(0)
    this.bufferRight.fill(0)
    this.position = 0
    this.phase = 0
  }
}
