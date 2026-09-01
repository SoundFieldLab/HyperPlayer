/**
 * HSE v1.5.1 stage 2 轻量 3D 环绕。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，从 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的引擎处理级独立移植。
 */

export interface Surround3dSettings {
  enabled: boolean
  distance: number
  speed: number
  angle: number
  direction: 1 | -1
}

/** 与 HSE v1.5.1 `createDefaultParams()` 完全一致。 */
export const DEFAULT_SURROUND3D_SETTINGS: Readonly<Surround3dSettings> = {
  enabled: false,
  distance: 0.5,
  speed: 1,
  angle: 0,
  direction: 1,
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`surround3d: ${name} must be finite`)
  return value
}

export class Surround3d {
  private readonly sampleRate: number
  private enabled = false
  private distance = 0.5
  private speed = 1
  private angle = 0
  private direction = 1
  private currentPhase = 0

  constructor(sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.sampleRate = sampleRate
    this.setParams(DEFAULT_SURROUND3D_SETTINGS)
  }

  /** 该级只有 Number 标量状态，无块工作缓冲；保留统一 DSP 生命周期入口。 */
  prepare(_maxBlockFrames: number): void {}

  /** 更新参数但保留连续旋转相位；所有有限值均按 HSE 原语义直接使用。 */
  setParams(settings: Surround3dSettings): void {
    const distance = requireFinite(settings.distance, 'distance')
    const speed = requireFinite(settings.speed, 'speed')
    const angle = requireFinite(settings.angle, 'angle')
    const direction = requireFinite(settings.direction, 'direction')
    if (direction !== -1 && direction !== 1) throw new Error('surround3d: direction must be -1 or 1')

    this.enabled = settings.enabled
    this.distance = distance
    this.speed = speed
    this.angle = angle
    this.direction = direction
  }

  /** 就地处理等长左右声道；旁路时保持样本与相位不变。 */
  processStereo(left: Float32Array, right: Float32Array, frameCount?: number): void {
    if (left.length !== right.length) throw new Error('surround3d: L/R length mismatch')
    if (!this.enabled) return

    const requestedFrames = frameCount ?? left.length
    if (!Number.isFinite(requestedFrames)) throw new Error('surround3d: frameCount must be finite')
    const frames = Math.max(0, Math.min(Math.floor(requestedFrames), left.length))
    this.currentPhase += 2 * Math.PI * this.speed * (frames / this.sampleRate) * 0.125

    const theta = this.angle * Math.PI / 180 + this.direction * this.currentPhase
    const cosine = Math.cos(theta)
    const sine = Math.sin(theta)
    const scale = 0.5 + 0.5 * this.distance

    for (let index = 0; index < frames; index++) {
      const inputLeft = left[index]
      const inputRight = right[index]
      left[index] = (inputLeft * cosine - inputRight * sine) * scale
      right[index] = (inputLeft * sine + inputRight * cosine) * scale
    }
  }

  reset(): void {
    this.currentPhase = 0
  }

  get phase(): number {
    return this.currentPhase
  }
}
