/**
 * HyperSoundEngine 音频引擎 —— 组合场景预设（ScenePresets）
 *
 * 出处/许可：
 *  - 场景预设概念为本项目自研历史功能；
 *  - 各场景参数语义依据《音频算法设计文档.md》功能清单与听感目标设计（自研）。
 *
 * 说明：
 *  - 每个场景 = createDefaultParams(48000) 派生后覆盖 EQ 曲线 + 混响 + 压缩 +
 *    低音 + 齿音等，构成完整参数快照（快照语义，params.sceneId = 自身 id）；
 *  - ieq/dynamicEq/modulation/limiter 四个新 stage 同样逐场景显式取值
 *    （保持关闭的场景也写出与默认一致的完整字段），便于与 Rust scenes.rs 镜像；
 *  - 快照不含 IR 数据（卷积 IR 一律 null，混响走算法混响，符合"用 irName 引用"约定）；
 *  - params.sampleRate 为快照标称采样率；HyperSoundEngine 实际以构造时采样率处理。
 */

import { createDefaultParams, PRO_EQ_DEFAULT_BANDS } from '../types'
import type { ScenePreset, HyperSoundEngineParams, IeqTargetCurve } from '../types'

/** 12 个场景 id（顺序固定，与 SCENE_PRESETS 一一对应） */
export const SCENE_IDS = [
  'pop',
  'enhance',
  'jazz',
  'dance',
  'classical',
  'livehouse',
  'studio',
  'warm',
  'dts',
  'vocal-stage',
  'night-bass',
  'heavy-bass',
] as const

/** 快照标称采样率 */
const SNAPSHOT_FS = 48000

/** 由默认参数派生一个场景基础快照 */
function base(): HyperSoundEngineParams {
  const p = createDefaultParams(SNAPSHOT_FS)
  return p
}

/** 用 10 段增益（对应 PRO_EQ_DEFAULT_BANDS 频率）覆盖专业 EQ 曲线 */
function applyEqCurve(p: HyperSoundEngineParams, gains: number[]): void {
  const list = PRO_EQ_DEFAULT_BANDS.map((f, i) => ({
    frequency: f,
    gain: gains[i] ?? 0,
    q: 1.1,
  }))
  p.eq.enabled = true
  p.eq.mode = 'pro'
  p.eq.bandCount = 10
  p.eq.proBands = list
}

/** 便捷函数：开启算法混响并设定参数（仅空间类场景使用——混响是空间语义，非空间场景保持干声） */
function setReverb(p: HyperSoundEngineParams, opts: {
  type: 'hall' | 'room' | 'plate' | 'spring' | 'stage'
  roomSize: number
  damping: number
  wet: number
  dry: number
  preDelayMs?: number
  width?: number
}): void {
  p.reverb.enabled = true
  p.reverb.mode = 'algorithmic'
  p.reverb.algorithmic.type = opts.type
  p.reverb.algorithmic.roomSize = opts.roomSize
  p.reverb.algorithmic.damping = opts.damping
  p.reverb.algorithmic.wet = opts.wet
  p.reverb.algorithmic.dry = opts.dry
  p.reverb.algorithmic.preDelayMs = opts.preDelayMs ?? 0
  p.reverb.algorithmic.width = opts.width ?? 1
}

/** 关闭混响（干声直通）：非空间类场景的默认姿态 */
function disableReverb(p: HyperSoundEngineParams): void {
  p.reverb.enabled = false
  p.reverb.mode = 'off'
}

function setCompressor(p: HyperSoundEngineParams, opts: {
  thresholdDb: number
  ratio: number
  kneeDb?: number
  attackMs?: number
  releaseMs?: number
  makeupDb?: number
}): void {
  p.compressor.enabled = true
  p.compressor.thresholdDb = opts.thresholdDb
  p.compressor.ratio = opts.ratio
  p.compressor.kneeDb = opts.kneeDb ?? 6
  p.compressor.attackMs = opts.attackMs ?? 10
  p.compressor.releaseMs = opts.releaseMs ?? 150
  p.compressor.makeupDb = opts.makeupDb ?? 0
}

function setBass(p: HyperSoundEngineParams, opts: {
  cutoffHz?: number
  q?: number
  harmonicType?: 'odd' | 'even' | 'atan' | 'soft'
  harmonicGain?: number
  mix?: number
  levelDb?: number
}): void {
  p.bassEnhancer.enabled = true
  p.bassEnhancer.cutoffHz = opts.cutoffHz ?? 90
  p.bassEnhancer.q = opts.q ?? 0.7
  p.bassEnhancer.harmonicType = opts.harmonicType ?? 'odd'
  p.bassEnhancer.harmonicGain = opts.harmonicGain ?? 0.6
  p.bassEnhancer.mix = opts.mix ?? 0.5
  p.bassEnhancer.levelDb = opts.levelDb ?? 0
}

function setDeesser(p: HyperSoundEngineParams, opts: {
  centerHz?: number
  q?: number
  thresholdDb?: number
  ratio?: number
  splitBand?: boolean
  mix?: number
}): void {
  p.deesser.enabled = true
  p.deesser.centerHz = opts.centerHz ?? 6000
  p.deesser.q = opts.q ?? 0.7
  p.deesser.thresholdDb = opts.thresholdDb ?? -30
  p.deesser.ratio = opts.ratio ?? 8
  p.deesser.splitBand = opts.splitBand ?? true
  p.deesser.mix = opts.mix ?? 1
}

/**
 * 新 stage（ieq/dynamicEq/modulation/limiter）逐场景显式取值：
 * 每个场景都完整写出这四个 stage 的全部字段（哪怕 disabled，取值与默认快照一致），
 * 与 Rust `hyperplayer-hse-core/src/scenes.rs` 逐字段镜像；冻结夹具
 * `scenes.48000.json` 由 `scripts/export-scenes-fixture.mjs` 从本文件重新导出。
 */

/** 智能均衡 IEQ：全参数显式传入（慢速自适应频谱对齐） */
function setIeq(p: HyperSoundEngineParams, opts: {
  enabled: boolean
  strength: number
  targetCurve: IeqTargetCurve
  timeConstantSec: number
}): void {
  p.ieq.enabled = opts.enabled
  p.ieq.strength = opts.strength
  p.ieq.targetCurve = opts.targetCurve
  p.ieq.timeConstantSec = opts.timeConstantSec
}

/** 动态 EQ 频带构造：5 带全部参与、无静态目标增益（默认姿态） */
function dynEqAllBands(): { enabled: boolean; targetGainDb: number }[] {
  return [0, 1, 2, 3, 4].map(() => ({ enabled: true, targetGainDb: 0 }))
}

/** 动态 EQ 频带构造：仅低频带（<200 Hz 固定交叉）参与动态控制，其余带关闭 */
function dynEqLowBandOnly(): { enabled: boolean; targetGainDb: number }[] {
  return [
    { enabled: true, targetGainDb: 0 },
    { enabled: false, targetGainDb: 0 },
    { enabled: false, targetGainDb: 0 },
    { enabled: false, targetGainDb: 0 },
    { enabled: false, targetGainDb: 0 },
  ]
}

/** 自适应动态均衡：全参数显式传入（bands 用 dynEqAllBands/dynEqLowBandOnly 构造） */
function setDynamicEq(p: HyperSoundEngineParams, opts: {
  enabled: boolean
  strength: number
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  bands: { enabled: boolean; targetGainDb: number }[]
}): void {
  p.dynamicEq.enabled = opts.enabled
  p.dynamicEq.strength = opts.strength
  p.dynamicEq.thresholdDb = opts.thresholdDb
  p.dynamicEq.ratio = opts.ratio
  p.dynamicEq.attackMs = opts.attackMs
  p.dynamicEq.releaseMs = opts.releaseMs
  p.dynamicEq.bands = opts.bands
}

/** 调制矩阵显式关闭：全子结构按默认值写出（场景不使用 LFO/包络调制） */
function disableModulation(p: HyperSoundEngineParams): void {
  p.modulation.enabled = false
  p.modulation.lfo = { enabled: false, shape: 'sine', rateHz: 1, depth: 0.5 }
  p.modulation.envelope = { enabled: false, attackMs: 10, releaseMs: 200, amount: 0.5 }
  p.modulation.routes = []
}

/** 前瞻限幅器：全参数显式传入（按各场景响度余量差异化阈值与恢复） */
function setLimiter(p: HyperSoundEngineParams, opts: {
  enabled: boolean
  thresholdDb: number
  lookaheadMs: number
  attackMs: number
  releaseMs: number
  truePeak: boolean
}): void {
  p.limiter.enabled = opts.enabled
  p.limiter.thresholdDb = opts.thresholdDb
  p.limiter.lookaheadMs = opts.lookaheadMs
  p.limiter.attackMs = opts.attackMs
  p.limiter.releaseMs = opts.releaseMs
  p.limiter.truePeak = opts.truePeak
}

function finish(p: HyperSoundEngineParams, id: string): ScenePreset {
  p.sceneId = id
  p.customized = false
  return { id, name: '', builtin: true, params: p }
}

/** 12 个组合场景：流行/增强/爵士/舞曲/古典/LiveHouse/录音棚/温暖/DTS 浩渺/悠扬舞台/深夜低音/重低音 */
export const SCENE_PRESETS: ScenePreset[] = [
  (() => {
    const p = base()
    // 流行：轻微微笑曲线（低音+中高音突出），中等压缩，轻虚拟低音（干声，不加空间混响）
    applyEqCurve(p, [3.5, 2.5, 1.5, 0.5, -0.5, 0, 1, 2, 2.5, 1.5])
    setCompressor(p, { thresholdDb: -18, ratio: 2.5, kneeDb: 8, attackMs: 12, releaseMs: 180, makeupDb: 5 })
    disableReverb(p)
    setBass(p, { cutoffHz: 100, harmonicGain: 0.35, mix: 0.3 })
    setDeesser(p, { centerHz: 6500 })
    // 新 stage：全默认克制——ieq/dynamicEq/modulation 关闭，透明安全限幅（-1 dB）
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'pop')
    sc.name = '流行'
    sc.description = '流行乐通用：微笑 EQ 曲线 + 人声突出 + 干净直达人声'
    return sc
  })(),
  (() => {
    const p = base()
    // 增强：中频凹陷（吉他/人声让位），中高频锐利，重压缩，低频下潜有力
    // （干声保冲击；关闭齿音限制保留高频空气感；超低频 EQ + bass cutoff 下潜）
    applyEqCurve(p, [3.5, 3, 0.5, -1.5, -1.5, 0, 1.5, 2.5, 3, 2])
    setCompressor(p, { thresholdDb: -22, ratio: 5, kneeDb: 4, attackMs: 5, releaseMs: 120, makeupDb: 13 })
    disableReverb(p)
    setBass(p, { cutoffHz: 70, harmonicType: 'odd', harmonicGain: 0.6, mix: 0.5 })
    // 新 stage：全默认克制（13 dB makeup 已由总线压缩承担，限幅器保持透明 -1 dB）
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'enhance')
    sc.name = '增强'
    sc.description = '增强：中频凹陷 + 强压缩 + 低频下潜冲击（干声，无齿音限制）'
    return sc
  })(),
  (() => {
    const p = base()
    // 爵士：温暖柔和，高频略收，俱乐部轻大厅混响，轻压缩（保留动态）
    applyEqCurve(p, [2, 1.5, 1, 0.5, 0, 0, 0.5, 0.5, -0.5, -1])
    setCompressor(p, { thresholdDb: -16, ratio: 1.8, kneeDb: 10, attackMs: 20, releaseMs: 250, makeupDb: 4 })
    setReverb(p, { type: 'hall', roomSize: 0.55, damping: 0.45, wet: 0.35, dry: 0.8, preDelayMs: 10 })
    // 新 stage：全默认克制——爵士重动态，不做自适应处理，限幅器只作透明保护
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'jazz')
    sc.name = '爵士'
    sc.description = '爵士俱乐部：温暖音色 + 轻大厅空间 + 柔和动态'
    return sc
  })(),
  (() => {
    const p = base()
    // 舞曲：大低音 + 明亮高频 + 泵感压缩 + 立体声加宽（干声保舞池冲击力）
    applyEqCurve(p, [4, 3, 1.5, 0.5, -0.5, 0, 1, 2, 3, 3])
    setCompressor(p, { thresholdDb: -14, ratio: 4, kneeDb: 4, attackMs: 8, releaseMs: 90, makeupDb: 4 })
    disableReverb(p)
    setBass(p, { cutoffHz: 100, harmonicType: 'even', harmonicGain: 0.7, mix: 0.6, levelDb: 1 })
    setDeesser(p, { centerHz: 7500, thresholdDb: -26 })
    p.stereoWidth = 1.2
    // 新 stage：dynamicEq 只动态收敛低频带（<200 Hz）抑制低音堆积、保留泵感；
    // 限幅器收 1.5 dB 余量 + 快恢复，匹配舞曲高能量连续输出
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: true, strength: 0.4, thresholdDb: -18, ratio: 3, attackMs: 20, releaseMs: 250, bands: dynEqLowBandOnly() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1.5, lookaheadMs: 5, attackMs: 0.5, releaseMs: 120, truePeak: true })
    const sc = finish(p, 'dance')
    sc.name = '舞曲'
    sc.description = '舞池能量：重低音 + 泵感压缩 + 高频光泽 + 宽声场（干声）'
    return sc
  })(),
  (() => {
    const p = base()
    // 古典：接近平直 + 长尾大厅混响 + 极轻压缩 + 宽声场（保留动态与定位）
    applyEqCurve(p, [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0.5, 0.5])
    setCompressor(p, { thresholdDb: -24, ratio: 1.5, kneeDb: 12, attackMs: 30, releaseMs: 400, makeupDb: 1 })
    setReverb(p, { type: 'hall', roomSize: 0.75, damping: 0.3, wet: 0.55, dry: 0.7, preDelayMs: 15 })
    p.stereoWidth = 1.15
    // 新 stage：ieq 轻度平直化（低强度 + 5 s 慢速），长时间聆听的音色一致性，
    // 不破坏厅堂动态；限幅器保持透明 -1 dB 保护
    setIeq(p, { enabled: true, strength: 0.3, targetCurve: 'flat', timeConstantSec: 5 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'classical')
    sc.name = '古典'
    sc.description = '音乐厅演绎：平直频响 + 长混响尾音 + 宽广声场'
    return sc
  })(),
  (() => {
    const p = base()
    // LiveHouse：大空间感 + 中高频临场感 + 中等压缩
    applyEqCurve(p, [1, 1, 0.5, 0, 0, 0.5, 1.5, 2, 2, 1])
    setCompressor(p, { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 200, makeupDb: 3 })
    setReverb(p, { type: 'stage', roomSize: 0.7, damping: 0.35, wet: 0.6, dry: 0.65, preDelayMs: 20 })
    // 新 stage：全默认克制——现场感靠 EQ + 混响，不做自适应处理
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'livehouse')
    sc.name = '现场'
    sc.description = 'LiveHouse 现场：大房间混响 + 临场中高频 + 稳健压缩'
    return sc
  })(),
  (() => {
    const p = base()
    // 录音棚：监听级平直 + 最小化处理 + 轻微齿音控制（完全干声，忠于原声）
    applyEqCurve(p, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    setCompressor(p, { thresholdDb: -16, ratio: 2, kneeDb: 10, attackMs: 15, releaseMs: 200, makeupDb: 4 })
    disableReverb(p)
    setDeesser(p, { centerHz: 7000, mix: 0.5 })
    // 新 stage：监听参考必须中性——ieq/dynamicEq/modulation 显式关闭，限幅器只作
    // 透明安全档（-1 dB），不引入任何音染色
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'studio')
    sc.name = '录音棚'
    sc.description = '录音棚监听：平直频响 + 极轻处理，完全干声忠于原声'
    return sc
  })(),
  (() => {
    const p = base()
    // 温暖：低频/中低频饱满，高频柔和滚降（干声，温暖靠音色不靠空间）
    applyEqCurve(p, [3, 2.5, 2, 1, 0.5, 0, -0.5, -1.5, -2.5, -3])
    setCompressor(p, { thresholdDb: -18, ratio: 2, kneeDb: 10, attackMs: 20, releaseMs: 300, makeupDb: 5 })
    disableReverb(p)
    setBass(p, { cutoffHz: 110, harmonicGain: 0.4, mix: 0.35 })
    // 新 stage：全默认克制——温暖感已由静态 EQ + 低音增强承担，不做自适应处理
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'warm')
    sc.name = '温暖'
    sc.description = '温暖模拟味：饱满低音 + 柔和高频（干声）'
    return sc
  })(),
  (() => {
    const p = base()
    // DTS 浩渺：开阔大空间 + 明亮空气感 + 加宽声场 + 长混响（最强的空间向场景）
    applyEqCurve(p, [1, 1, 0.5, 0, 0, 0, 1, 2, 3, 3])
    setCompressor(p, { thresholdDb: -20, ratio: 2.5, kneeDb: 8, attackMs: 15, releaseMs: 250, makeupDb: 2 })
    setReverb(p, { type: 'hall', roomSize: 0.85, damping: 0.25, wet: 0.7, dry: 0.55, preDelayMs: 25, width: 1.4 })
    p.stereoWidth = 1.3
    // 新 stage：限幅器收 2 dB 余量 + 慢恢复——极高混响湿量与 1.3 倍声场抬峰明显，
    // 需要防削波且避免泵感破坏长尾；ieq/dynamicEq/modulation 保持关闭
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -2, lookaheadMs: 5, attackMs: 0.5, releaseMs: 200, truePeak: true })
    const sc = finish(p, 'dts')
    sc.name = '浩渺'
    sc.description = 'DTS 浩渺：极开阔混响 + 空气感高频 + 超宽声场'
    return sc
  })(),
  (() => {
    const p = base()
    // 悠扬舞台：人声中心化（1–4kHz 临场提升）+ 齿音抑制 + 舞台混响
    applyEqCurve(p, [-0.5, 0, 0, 1, 1.5, 2.5, 2, 1.5, 0.5, 0])
    setCompressor(p, { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 8, releaseMs: 150, makeupDb: 0 })
    setReverb(p, { type: 'stage', roomSize: 0.5, damping: 0.45, wet: 0.45, dry: 0.75, preDelayMs: 8 })
    setDeesser(p, { centerHz: 6500, ratio: 10, thresholdDb: -32 })
    // 新 stage：ieq 轻度人声曲线（低强度 + 4 s 慢速）呼应人声中心定位，不与静态
    // EQ/压缩抢戏；其余保持克制默认
    setIeq(p, { enabled: true, strength: 0.25, targetCurve: 'vocal', timeConstantSec: 4 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const sc = finish(p, 'vocal-stage')
    sc.name = '悠扬舞台'
    sc.description = '悠扬舞台：人声临场提升 + 齿音收敛 + 舞台空间'
    return sc
  })(),
  (() => {
    const p = base()
    // 深夜低音：夜间模式开启 + 重低音 + 高频收敛 + 强压缩（低音量下保持均衡，干声不添空间感）
    // 审计修复（C 报告）：原参数高频堆叠过暗（EQ -3dB@16k + night 预设 -3dB@16k +
    // nightMode shelf -12dB + deesser 6kHz 压制 → 10-15kHz 响应 -33.5dB 越出 ±24dB 契约界），
    // 现调平：EQ 高频 -2、nightMode 5（shelf -7.5dB）、deesser 阈值放宽、补偿预设换 warm
    applyEqCurve(p, [4, 3.5, 2, 0.5, 0, 0, -0.5, -1, -0.5, 0]) // 12.5k −0.5 / 16k 0（收敛迭代到契约界内）
    setCompressor(p, { thresholdDb: -24, ratio: 6, kneeDb: 4, attackMs: 5, releaseMs: 200, makeupDb: 15 })
    disableReverb(p)
    setBass(p, { cutoffHz: 120, harmonicType: 'even', harmonicGain: 0.8, mix: 0.7, levelDb: 1 })
    setDeesser(p, { centerHz: 6000, thresholdDb: -36, ratio: 6 }) // 阈值放宽 + 比率降为 6，减少白噪声下的高频压制
    p.nightMode.enabled = true
    p.nightMode.amount = 1 // 6kHz shelf −1.5dB（验收复验迭代收敛：5→3→2→1 进入契约界）
    p.loudnessCompensation.enabled = true
    p.loudnessCompensation.mode = 'preset'
    p.loudnessCompensation.preset = 'warm'
    p.loudnessCompensation.volumePercent = 30
    p.loudnessCompensation.maxBoostDb = 12
    // 新 stage：限幅器与响度链组合——15 dB makeup + 低音量补偿(≤12 dB)抬峰凶猛，
    // 收 3 dB 余量 + 慢恢复，深夜小音量下限幅动作更平滑；其余保持克制默认
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: false, strength: 0.5, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200, bands: dynEqAllBands() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -3, lookaheadMs: 5, attackMs: 0.5, releaseMs: 250, truePeak: true })
    const sc = finish(p, 'night-bass')
    sc.name = '深夜低音'
    sc.description = '深夜低音：夜间模式 + 虚拟低频增强 + 高频收敛，低音量均衡耐听'
    return sc
  })(),
  (() => {
    const p = base()
    // 重低音：超低频大幅提升 + 虚拟低频谐波增强 + 适中压缩 + 略宽声场
    // （纯低频冲击力，干声不加空间感；无齿音限制）
    applyEqCurve(p, [6, 5, 3, 1, 0, 0, 0.5, 0.5, 0, -1])
    setCompressor(p, { thresholdDb: -20, ratio: 3.5, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 6 })
    disableReverb(p)
    setBass(p, { cutoffHz: 60, harmonicType: 'even', harmonicGain: 0.9, mix: 0.75, levelDb: 2 })
    p.stereoWidth = 1.1
    // 新 stage：dynamicEq 只动态收敛低频带（<200 Hz）——超低频 EQ + 0.9 谐波增强
    // 的峰值堆积由它兜底；限幅器收 1.5 dB 余量 + 稍慢恢复控住次低频真峰值
    setIeq(p, { enabled: false, strength: 0.5, targetCurve: 'flat', timeConstantSec: 3 })
    setDynamicEq(p, { enabled: true, strength: 0.5, thresholdDb: -16, ratio: 4, attackMs: 15, releaseMs: 300, bands: dynEqLowBandOnly() })
    disableModulation(p)
    setLimiter(p, { enabled: true, thresholdDb: -1.5, lookaheadMs: 5, attackMs: 0.5, releaseMs: 200, truePeak: true })
    const sc = finish(p, 'heavy-bass')
    sc.name = '重低音'
    sc.description = '重低音：超低频提升 + 虚拟低频谐波增强 + 略宽声场，纯低频冲击力'
    return sc
  })(),
]

/** 按 id 查找场景；未找到返回 null。 */
export function getSceneById(id: string | null): ScenePreset | null {
  if (id === null) return null
  for (const sc of SCENE_PRESETS) {
    if (sc.id === id) return sc
  }
  return null
}
