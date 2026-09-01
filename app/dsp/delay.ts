/**
 * HSE v1.5.1 环形延迟效果。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 `DelayEffect`。
 */

export interface DelaySettings {
  enabled: boolean
  delayMs: number
  feedback: number
  mix: number
}

export const DEFAULT_DELAY_SETTINGS: Readonly<DelaySettings> = {
  enabled: false,
  delayMs: 250,
  feedback: 0.3,
  mix: 0.3,
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`delay: ${name} must be finite`)
  return value
}

export class DelayEffect {
  private readonly sampleRate: number
  private readonly bufferLeft: Float32Array
  private readonly bufferRight: Float32Array
  private enabled = false
  private position = 0
  private delaySamples = 0
  private feedback = 0.3
  private mix = 0.3

  constructor(sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    const bufferLength = Math.ceil(sampleRate * 2) + 1
    this.bufferLeft = new Float32Array(bufferLength)
    this.bufferRight = new Float32Array(bufferLength)
    this.setParams(DEFAULT_DELAY_SETTINGS)
  }

  setParams(settings: DelaySettings): void {
    const delayMs = requireFinite(settings.delayMs, 'delayMs')
    const feedback = requireFinite(settings.feedback, 'feedback')
    const mix = requireFinite(settings.mix, 'mix')
    const wasEnabled = this.enabled

    this.delaySamples = (clamp(delayMs, 0, 2000) / 1000) * this.sampleRate
    this.feedback = clamp(feedback, 0, 0.98)
    this.mix = clamp(mix, 0, 1)
    this.enabled = settings.enabled

    if (!wasEnabled && this.enabled) this.reset()
  }

  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    if (left.length !== right.length) throw new Error('delay: L/R length mismatch')
    if (!this.enabled) return

    const requestedFrames = frameCount ?? left.length
    if (!Number.isFinite(requestedFrames)) throw new Error('delay: frameCount must be finite')
    const frames = Math.max(0, Math.min(Math.floor(requestedFrames), left.length))
    const bufferLeft = this.bufferLeft
    const bufferRight = this.bufferRight
    const bufferLength = bufferLeft.length
    const delaySamples = clamp(this.delaySamples, 0, bufferLength - 1)
    const delayFloor = Math.floor(delaySamples)
    const fraction = delaySamples - delayFloor
    const feedback = this.feedback
    const mix = this.mix
    let position = this.position

    for (let index = 0; index < frames; index++) {
      const inputLeft = left[index]
      const inputRight = right[index]
      const readIndex0 = (position - delayFloor + bufferLength) % bufferLength
      const readIndex1 = (readIndex0 - 1 + bufferLength) % bufferLength
      const wetLeft = bufferLeft[readIndex0] * (1 - fraction) + bufferLeft[readIndex1] * fraction
      const wetRight = bufferRight[readIndex0] * (1 - fraction) + bufferRight[readIndex1] * fraction

      bufferLeft[position] = inputLeft + wetLeft * feedback
      bufferRight[position] = inputRight + wetRight * feedback
      left[index] = inputLeft * (1 - mix) + wetLeft * mix
      right[index] = inputRight * (1 - mix) + wetRight * mix
      position = (position + 1) % bufferLength
    }

    this.position = position
  }

  reset(): void {
    this.bufferLeft.fill(0)
    this.bufferRight.fill(0)
    this.position = 0
  }
}
