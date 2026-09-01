/**
 * HSE v1.5.1 移相效果。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 `PhaserEffect`。
 */

export interface PhaserSettings {
  enabled: boolean
  rateHz: number
  depth: number
  feedback: number
  mix: number
  stages: number
}

export const DEFAULT_PHASER_SETTINGS: Readonly<PhaserSettings> = {
  enabled: false,
  rateHz: 0.5,
  depth: 0.5,
  feedback: 0.4,
  mix: 0.5,
  stages: 4,
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`phaser: ${name} must be finite`)
  return value
}

export class PhaserEffect {
  private readonly sampleRate: number
  private readonly stateLeft = new Float32Array(16)
  private readonly stateRight = new Float32Array(16)
  private enabled = false
  private rateHz = 0.5
  private depth = 0.5
  private feedback = 0.4
  private mix = 0.5
  private stages = 4
  private phase = 0
  private lastOutLeft = 0
  private lastOutRight = 0

  constructor(sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    this.setParams(DEFAULT_PHASER_SETTINGS)
  }

  setParams(settings: PhaserSettings): void {
    const rateHz = requireFinite(settings.rateHz, 'rateHz')
    const depth = requireFinite(settings.depth, 'depth')
    const feedback = requireFinite(settings.feedback, 'feedback')
    const mix = requireFinite(settings.mix, 'mix')
    const stages = requireFinite(settings.stages, 'stages')
    const wasEnabled = this.enabled

    this.rateHz = clamp(rateHz, 0.01, 20)
    this.depth = clamp(depth, 0, 1)
    this.feedback = clamp(feedback, 0, 0.98)
    this.mix = clamp(mix, 0, 1)
    this.stages = clamp(Math.round(stages), 2, 8)
    this.enabled = settings.enabled

    if (!wasEnabled && this.enabled) this.reset()
  }

  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    const requestedFrames = frameCount ?? Math.min(left.length, right.length)
    if (!Number.isFinite(requestedFrames)) throw new Error('phaser: frameCount must be finite')
    if (!this.enabled) return

    const frames = Math.max(0, Math.min(Math.floor(requestedFrames), left.length, right.length))
    const sampleRate = this.sampleRate
    const rateHz = this.rateHz
    const depth = this.depth
    const feedback = this.feedback
    const mix = this.mix
    const stages = this.stages
    const stateLeft = this.stateLeft
    const stateRight = this.stateRight
    let phase = this.phase
    let lastOutLeft = this.lastOutLeft
    let lastOutRight = this.lastOutRight

    for (let index = 0; index < frames; index++) {
      const inputLeft = left[index]
      const inputRight = right[index]
      const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * phase)
      const frequency = 200 + 1800 * (0.2 + 0.8 * lfo * depth)
      const tangent = Math.tan((Math.PI * frequency) / sampleRate)
      const coefficient = (1 - tangent) / (1 + tangent)
      const feedbackInputLeft = inputLeft + feedback * lastOutLeft
      const feedbackInputRight = inputRight + feedback * lastOutRight
      let wetLeft = feedbackInputLeft
      let wetRight = feedbackInputRight

      for (let stage = 0; stage < stages; stage++) {
        const base = stage * 2
        wetLeft = this.allpass(feedbackInputLeft, stateLeft, base, coefficient)
        wetRight = this.allpass(feedbackInputRight, stateRight, base, coefficient)
      }

      lastOutLeft = wetLeft
      lastOutRight = wetRight
      left[index] = inputLeft * (1 - mix) + wetLeft * mix
      right[index] = inputRight * (1 - mix) + wetRight * mix
      phase = (phase + rateHz / sampleRate) % 1
    }

    this.phase = phase
    this.lastOutLeft = lastOutLeft
    this.lastOutRight = lastOutRight
  }

  reset(): void {
    this.stateLeft.fill(0)
    this.stateRight.fill(0)
    this.phase = 0
    this.lastOutLeft = 0
    this.lastOutRight = 0
  }

  private allpass(input: number, state: Float32Array, base: number, coefficient: number): number {
    const previousInput = state[base]
    const previousOutput = state[base + 1]
    const output = -coefficient * input + previousInput + coefficient * previousOutput
    state[base] = input
    state[base + 1] = output
    return output
  }
}
