/**
 * HSE v1.5.1 M/S 立体声处理算法。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`)。M/S 中间计算使用 Number，
 * 仅在写回 Float32Array 时发生 f32 量化。
 */
export class MidSide {
  private midGain = 1
  private sideGain = 1

  /** width 0..2（1 为原始宽度），voiceBalance -1..1（-1 去中，+1 去侧）。 */
  setParams(width: number, voiceBalance: number): void {
    const w = Math.min(Math.max(width, 0), 2)
    const vb = Math.min(Math.max(voiceBalance, -1), 1)
    this.midGain = 1 + Math.min(0, vb)
    this.sideGain = w * (1 - Math.max(0, vb))
  }

  /** 就地处理等长左右声道；frameCount 缺省时处理完整缓冲。 */
  processStereo(l: Float32Array, r: Float32Array, frameCount?: number): void {
    if (l.length !== r.length) throw new Error('midside: L/R length mismatch')

    if (this.midGain === 1 && this.sideGain === 1) return
    const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length))
    const midGain = this.midGain
    const sideGain = this.sideGain
    for (let i = 0; i < n; i++) {
      const left = l[i]
      const right = r[i]
      const mid = (left + right) * 0.5
      const side = (left - right) * 0.5
      l[i] = mid * midGain + side * sideGain
      r[i] = mid * midGain - side * sideGain
    }
  }

  /** 算法无内部状态，复位为空操作且保留当前参数。 */
  reset(): void {}
}
