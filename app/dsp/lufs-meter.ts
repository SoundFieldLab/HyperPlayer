/**
 * HSE v1.5.1 ITU-R BS.1770-4 / EBU R128 响度计。
 *
 * 经 `LICENSE-HSE-AUTHORIZATION.md` 专项授权，移植自 HyperSoundEngine v1.5.1
 * (`f7017621b7d84005fbfed8a3c42a119487a17326`) 的 `src/dsp/LufsMeter.ts`。
 * Number 保持 f64 运算语义，历史与音频缓冲保持 Float32Array 语义。
 */

function rbjHighPass(f0: number, q: number, fs: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const w0 = (2 * Math.PI * f0) / fs
  const alpha = Math.sin(w0) / (2 * q)
  const cw = Math.cos(w0)
  const b0 = (1 + cw) / 2
  const b1 = -(1 + cw)
  const b2 = b0
  const a0 = 1 + alpha
  const a1 = -2 * cw
  const a2 = 1 - alpha
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

function shelfCoeffs(fs: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const f0 = 1681.974450955533
  const gDb = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan((Math.PI * f0) / fs)
  const vh = Math.pow(10, gDb / 20)
  const vb = Math.pow(vh, 0.4996667741545416)
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

const TRUE_PEAK_OVS = 4
const TRUE_PEAK_TAPS_PER_PHASE = 24
const TRUE_PEAK_HIST = 2 * TRUE_PEAK_TAPS_PER_PHASE

interface BiquadState {
  c: { b0: number; b1: number; b2: number; a1: number; a2: number }
  z1: number
  z2: number
}

export class LufsMeter {
  private readonly blockLen: number
  private readonly hopLen: number
  private readonly rlbL: BiquadState
  private readonly shelfL: BiquadState
  private readonly rlbR: BiquadState
  private readonly shelfR: BiquadState
  private readonly zBuf: Float32Array
  private zPos = 0
  private sumSq = 0
  private totalSamples = 0
  private static readonly BLOCK_CAP = 36000
  private readonly blockLoud = new Float32Array(LufsMeter.BLOCK_CAP)
  private readonly blockPower = new Float32Array(LufsMeter.BLOCK_CAP)
  private blockWrite = 0
  private blockCount = 0
  private static readonly SHORT_CAP = 30
  private readonly shortPower = new Float32Array(LufsMeter.SHORT_CAP)
  private shortWrite = 0
  private shortCount = 0
  private peak = 0
  private truePeak = 0
  private readonly tpKernel = new Float32Array(TRUE_PEAK_OVS * TRUE_PEAK_HIST)
  private readonly histL = new Float32Array(TRUE_PEAK_HIST)
  private readonly histR = new Float32Array(TRUE_PEAK_HIST)
  private histPos = 0
  private histFull = false
  private readonly sortScratch = new Float32Array(LufsMeter.BLOCK_CAP)

  constructor(fs: number) {
    if (fs <= 0 || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    const useFs = fs === 44100 || fs === 48000 ? fs : 48000
    const rlb = rbjHighPass(38.135822, 0.5, useFs)
    const shelf = shelfCoeffs(useFs)
    this.rlbL = { c: rlb, z1: 0, z2: 0 }
    this.shelfL = { c: shelf, z1: 0, z2: 0 }
    this.rlbR = { c: rlb, z1: 0, z2: 0 }
    this.shelfR = { c: shelf, z1: 0, z2: 0 }
    this.blockLen = Math.max(1, Math.round(0.4 * fs))
    this.hopLen = Math.max(1, Math.round(0.1 * fs))
    this.zBuf = new Float32Array(this.blockLen)

    for (let phi = 0; phi < TRUE_PEAK_OVS; phi++) {
      let sum = 0
      const base = phi * TRUE_PEAK_HIST
      for (let j = 0; j < TRUE_PEAK_HIST; j++) {
        const u = j - (TRUE_PEAK_TAPS_PER_PHASE - 1) + phi / TRUE_PEAK_OVS
        let c
        if (Math.abs(u) < 1e-9) c = 1
        else c = Math.sin((Math.PI * u) / TRUE_PEAK_OVS) / ((Math.PI * u) / TRUE_PEAK_OVS)
        const xw = u / TRUE_PEAK_TAPS_PER_PHASE
        if (Math.abs(xw) <= 1) c *= 0.42 + 0.5 * Math.cos(Math.PI * xw) + 0.08 * Math.cos(2 * Math.PI * xw)
        else c = 0
        this.tpKernel[base + j] = c
        sum += c
      }
      if (sum !== 0) {
        for (let j = 0; j < TRUE_PEAK_HIST; j++) this.tpKernel[base + j] /= sum
      }
    }
  }

  /** 所有工作缓冲均已在构造函数中预分配。 */
  prepare(_maxBlockFrames: number): void {}

  /** 就地分析立体声，不改写输入。 */
  processStereo(l: Float32Array, r: Float32Array, frameCount?: number): void {
    const B = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length))
    for (let i = 0; i < B; i++) {
      const xl = l[i]
      const xr = r[i]
      const rl = this.rlbL
      const y1l = rl.c.b0 * xl + rl.z1
      rl.z1 = rl.c.b1 * xl - rl.c.a1 * y1l + rl.z2
      rl.z2 = rl.c.b2 * xl - rl.c.a2 * y1l
      const sl = this.shelfL
      const yl = sl.c.b0 * y1l + sl.z1
      sl.z1 = sl.c.b1 * y1l - sl.c.a1 * yl + sl.z2
      sl.z2 = sl.c.b2 * y1l - sl.c.a2 * yl
      const rr = this.rlbR
      const y1r = rr.c.b0 * xr + rr.z1
      rr.z1 = rr.c.b1 * xr - rr.c.a1 * y1r + rr.z2
      rr.z2 = rr.c.b2 * xr - rr.c.a2 * y1r
      const sr = this.shelfR
      const yr = sr.c.b0 * y1r + sr.z1
      sr.z1 = sr.c.b1 * y1r - sr.c.a1 * yr + sr.z2
      sr.z2 = sr.c.b2 * y1r - sr.c.a2 * yr

      const z = yl + yr
      const zsq = z * z
      const evict = this.zBuf[this.zPos]
      this.zBuf[this.zPos] = z
      this.zPos++
      if (this.zPos >= this.blockLen) this.zPos = 0
      this.sumSq += zsq - evict * evict
      this.totalSamples++

      const aL = xl < 0 ? -xl : xl
      const aR = xr < 0 ? -xr : xr
      if (aL > this.peak) this.peak = aL
      if (aR > this.peak) this.peak = aR

      this.histL[this.histPos] = xl
      this.histR[this.histPos] = xr
      this.histPos++
      if (this.histPos >= TRUE_PEAK_HIST) {
        this.histPos = 0
        this.histFull = true
      }
      this.updateTruePeakInterp(this.histL)
      this.updateTruePeakInterp(this.histR)

      if (this.totalSamples >= this.blockLen && (this.totalSamples - this.blockLen) % this.hopLen === 0) this.recordBlock()
    }
  }

  getIntegratedLufs(): number {
    if (this.blockCount === 0) return NaN
    const cap = LufsMeter.BLOCK_CAP
    const start = (this.blockWrite - this.blockCount + cap) % cap
    let sumP1 = 0
    let sumL1 = 0
    let n1 = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70) {
        sumP1 += this.blockPower[idx]
        sumL1 += lk
        n1++
      }
    }
    if (n1 === 0) return NaN
    const gate = sumL1 / n1 - 10
    let sumP2 = 0
    let n2 = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70 && lk >= gate) {
        sumP2 += this.blockPower[idx]
        n2++
      }
    }
    if (n2 === 0) return NaN
    return -0.691 + 10 * Math.log10(sumP2 / n2)
  }

  getMomentaryLufs(): number {
    if (this.blockCount === 0) return NaN
    const last = (this.blockWrite - 1 + LufsMeter.BLOCK_CAP) % LufsMeter.BLOCK_CAP
    const value = this.blockLoud[last]
    return Number.isNaN(value) ? NaN : value
  }

  getShortTermLufs(): number {
    if (this.shortCount < LufsMeter.SHORT_CAP) return NaN
    let sum = 0
    const cap = LufsMeter.SHORT_CAP
    for (let k = 0; k < cap; k++) {
      const idx = (this.shortWrite - cap + k + 2 * cap) % cap
      sum += this.shortPower[idx]
    }
    if (sum <= 1e-30) return NaN
    return -0.691 + 10 * Math.log10(sum / cap)
  }

  getLra(): number {
    if (this.blockCount < 2) return NaN
    const cap = LufsMeter.BLOCK_CAP
    const start = (this.blockWrite - this.blockCount + cap) % cap
    let sumL = 0
    let n1 = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70) {
        sumL += lk
        n1++
      }
    }
    if (n1 < 2) return NaN
    const gate = sumL / n1 - 20
    let count = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70 && lk >= gate) this.sortScratch[count++] = lk
    }
    if (count < 2) return NaN
    const sorted = this.sortScratch.subarray(0, count)
    sorted.sort()
    return this.percentile(sorted, 0.95) - this.percentile(sorted, 0.1)
  }

  getPeakDb(): number {
    if (this.peak <= 0) return -Infinity
    return 20 * Math.log10(this.peak)
  }

  getTruePeakDb(): number {
    if (this.truePeak <= 0) return -Infinity
    return 20 * Math.log10(this.truePeak)
  }

  reset(): void {
    this.zBuf.fill(0)
    this.zPos = 0
    this.sumSq = 0
    this.totalSamples = 0
    this.blockLoud.fill(0)
    this.blockPower.fill(0)
    this.blockWrite = 0
    this.blockCount = 0
    this.shortPower.fill(0)
    this.shortWrite = 0
    this.shortCount = 0
    this.peak = 0
    this.truePeak = 0
    this.histL.fill(0)
    this.histR.fill(0)
    this.histPos = 0
    this.histFull = false
    this.rlbL.z1 = 0
    this.rlbL.z2 = 0
    this.shelfL.z1 = 0
    this.shelfL.z2 = 0
    this.rlbR.z1 = 0
    this.rlbR.z2 = 0
    this.shelfR.z1 = 0
    this.shelfR.z2 = 0
  }

  private recordBlock(): void {
    const power = this.sumSq / this.blockLen
    const loudness = power > 1e-30 ? -0.691 + 10 * Math.log10(power) : NaN
    const cap = LufsMeter.BLOCK_CAP
    this.blockLoud[this.blockWrite] = loudness
    this.blockPower[this.blockWrite] = power
    this.blockWrite++
    if (this.blockWrite >= cap) this.blockWrite = 0
    if (this.blockCount < cap) this.blockCount++
    const shortCap = LufsMeter.SHORT_CAP
    this.shortPower[this.shortWrite] = power
    this.shortWrite++
    if (this.shortWrite >= shortCap) this.shortWrite = 0
    if (this.shortCount < shortCap) this.shortCount++
  }

  private percentile(sorted: Float32Array, percentile: number): number {
    const length = sorted.length
    if (length === 1) return sorted[0]
    const rank = percentile * (length - 1)
    const low = Math.floor(rank)
    const high = Math.min(length - 1, low + 1)
    const fraction = rank - low
    return sorted[low] + fraction * (sorted[high] - sorted[low])
  }

  private updateTruePeakInterp(history: Float32Array): void {
    if (!this.histFull) return
    const position = this.totalSamples - 1 - TRUE_PEAK_TAPS_PER_PHASE
    if (position < 0) return
    for (let phase = 0; phase < TRUE_PEAK_OVS; phase++) {
      const base = phase * TRUE_PEAK_HIST
      let interpolated = 0
      for (let tap = 0; tap < TRUE_PEAK_HIST; tap++) {
        const index = position - tap + TRUE_PEAK_TAPS_PER_PHASE - 1
        const ringIndex = ((index % TRUE_PEAK_HIST) + TRUE_PEAK_HIST) % TRUE_PEAK_HIST
        interpolated += this.tpKernel[base + tap] * history[ringIndex]
      }
      if (interpolated < 0) interpolated = -interpolated
      if (interpolated > this.truePeak) this.truePeak = interpolated
    }
  }
}
