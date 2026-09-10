/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 HyperPlayer，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 过渡计划层（减配后）。
 *
 * 本文件保留 planTransition / planTransitionV2 两个导出（调用方签名兼容），但
 * smart-rendered / smart-rendered-v2 / beat-crossfade 策略生成分支已整体移除——
 * 计划只产出 `fixed-crossfade`（Fixed Crossfade 固定交叉淡化）。窗口选择、等功率
 * 增益曲线、响度补偿等通用逻辑保留，供固定交叉淡化消费。
 */
import type { BeatFeatureFrame, SectionMarker, TrackAnalysis, TransitionPlan, TransitionStrategy } from './types'

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const safeBpm = (value: number) => Math.max(40, Math.min(240, value || 120))
const DEFAULT_BEAT_COUNTS = [8, 16, 24, 32]
// 智能混音 BPM 差上限：仅用于生成 fallbackReason 文案（计划恒为 fixed-crossfade）。
const MAX_SMART_MIX_BPM_DIFFERENCE = 5
const MIN_ANALYSIS_CONFIDENCE = 0.55
// 渲染器/算法版本标识：并入 plan.id，避免不同版本结果在缓存中互相碰撞。
const RENDERER_VERSION = 'fixed-crossfade-v1'

interface CandidatePoint {
  time: number
  beatIndex: number
  downbeatIndex: number
  confidence: number
}

interface BeatWindow {
  point: CandidatePoint
  startTime: number
  endTime: number
  beatTimes: number[]
  frames: Array<BeatFeatureFrame | undefined>
}

interface CandidatePair {
  source: BeatWindow
  target: BeatWindow
  sourceSection?: SectionMarker
  targetSection?: SectionMarker
  sourceVocalness: number
  targetVocalness: number
  components: Record<string, number>
  cost: number
}

function cosineDistance(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 1
  const size = Math.min(a.length, b.length)
  let dot = 0
  let lengthA = 0
  let lengthB = 0
  for (let index = 0; index < size; index += 1) {
    const left = a[index] || 0
    const right = b[index] || 0
    dot += left * right
    lengthA += left * left
    lengthB += right * right
  }
  if (lengthA < 1e-12 || lengthB < 1e-12) return 1
  return clamp01(1 - dot / Math.sqrt(lengthA * lengthB))
}

function nearestBeatIndex(beats: number[], time: number): number {
  if (!beats.length) return 0
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < beats.length; index += 1) {
    const nextDistance = Math.abs(beats[index] - time)
    if (nextDistance < bestDistance) {
      bestIndex = index
      bestDistance = nextDistance
    }
  }
  return bestIndex
}

function candidatePoints(analysis: TrackAnalysis, start: number, end: number): CandidatePoint[] {
  const downbeats = analysis.downbeats
    .map((time, downbeatIndex) => {
      const beatIndex = nearestBeatIndex(analysis.beats, time)
      return {
        time: analysis.beats[beatIndex] ?? time,
        beatIndex,
        downbeatIndex,
        confidence: analysis.downbeatConfidence[downbeatIndex] ?? analysis.confidence,
      }
    })
    .filter(point => point.time >= start && point.time <= end)
  if (downbeats.length) return downbeats

  return analysis.beats
    .map((time, beatIndex) => ({
      time,
      beatIndex,
      downbeatIndex: -1,
      confidence: analysis.beatConfidence[beatIndex] ?? analysis.confidence,
    }))
    .filter(point => point.time >= start && point.time <= end)
}

function buildWindow(
  analysis: TrackAnalysis,
  point: CandidatePoint,
  beatCount: number,
  frameByBeat: Map<number, BeatFeatureFrame>,
): BeatWindow | null {
  const beatTimes = analysis.beats.slice(point.beatIndex, point.beatIndex + beatCount + 1)
  if (beatTimes.length !== beatCount + 1) return null
  if (beatTimes.some((time, index) => index > 0 && time <= beatTimes[index - 1])) return null

  return {
    point,
    startTime: beatTimes[0],
    endTime: beatTimes[beatTimes.length - 1],
    beatTimes,
    frames: Array.from({ length: beatCount }, (_, offset) => frameByBeat.get(point.beatIndex + offset)),
  }
}

function nearestSection(sections: SectionMarker[], time: number): SectionMarker | undefined {
  return sections
    .filter(section => Math.abs(section.time - time) <= 2.5)
    .sort((left, right) => Math.abs(left.time - time) - Math.abs(right.time - time))[0]
}

function boundaryCost(section: SectionMarker | undefined): number {
  if (!section) return 0.7
  if (section.type === 'drop') return 0
  if (section.type === 'chorus' || section.type === 'break') return 0.08
  if (section.type === 'intro' || section.type === 'outro') return 0.18
  return 0.4
}

/** 等功率交叉曲线（固定交叉淡化的增益曲线来源）。 */
function powerCurve(length: number, fadeIn: boolean): number[] {
  const count = Math.max(2, length)
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1)
    return fadeIn ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2)
  })
}

function chooseBeatCount(beatDuration: number, minDuration: number, maxDuration: number): number {
  const viable = DEFAULT_BEAT_COUNTS.filter(count => {
    const duration = count * beatDuration
    return duration >= minDuration && duration <= maxDuration
  })
  if (viable.length) return viable.includes(16) ? 16 : viable.includes(24) ? 24 : viable.includes(32) ? 32 : viable[0]
  const targetDuration = Math.max(minDuration, Math.min(maxDuration, 16 * beatDuration))
  return DEFAULT_BEAT_COUNTS.reduce((best, count) => {
    const nextDistance = Math.abs(count * beatDuration - targetDuration)
    return nextDistance < best.distance ? { count, distance: nextDistance } : best
  }, { count: 16, distance: Number.POSITIVE_INFINITY }).count
}

function loudnessNormalizer(analysis: TrackAnalysis): (frame?: BeatFeatureFrame) => number {
  const values = analysis.beatFeatures.map(frame => frame.loudness).filter(Number.isFinite)
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 1
  const range = max - min
  return frame => {
    if (!frame || !Number.isFinite(frame.loudness)) return 0
    return range < 1e-9 ? 0.5 : clamp01((frame.loudness - min) / range)
  }
}

function averageWindowCost(
  source: BeatWindow,
  target: BeatWindow,
  sourceLoudness: (frame?: BeatFeatureFrame) => number,
  targetLoudness: (frame?: BeatFeatureFrame) => number,
) {
  let timbre = 0
  let chroma = 0
  let loudness = 0
  let vocal = 0
  let sourceVocalness = 0
  let targetVocalness = 0
  const count = Math.max(1, Math.min(source.frames.length, target.frames.length))

  for (let index = 0; index < count; index += 1) {
    const sourceFrame = source.frames[index]
    const targetFrame = target.frames[index]
    timbre += cosineDistance(sourceFrame?.timbre || [], targetFrame?.timbre || [])
    chroma += cosineDistance(sourceFrame?.chroma || [], targetFrame?.chroma || [])
    // Prefer regions where both tracks have usable energy, not merely similar silence.
    loudness += 1 - Math.min(sourceLoudness(sourceFrame), targetLoudness(targetFrame))
    const sourceVocal = clamp01(sourceFrame?.vocalness ?? 0.5)
    const targetVocal = clamp01(targetFrame?.vocalness ?? 0.5)
    sourceVocalness += sourceVocal
    targetVocalness += targetVocal
    vocal += sourceVocal * targetVocal
  }

  return {
    timbre: timbre / count,
    chroma: chroma / count,
    loudness: loudness / count,
    vocal: vocal / count,
    sourceVocalness: sourceVocalness / count,
    targetVocalness: targetVocalness / count,
  }
}

function normalizeComponent(pairs: CandidatePair[], component: string) {
  const values = pairs.map(pair => pair.components[component] ?? 0)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  for (const pair of pairs) {
    pair.components[component] = range < 1e-6 ? 0 : clamp01((pair.components[component] - min) / range)
  }
}

function fallbackReason(
  settings: { beatMatching: boolean },
  bpmDifference: number,
  reliableGrid: boolean,
  confidence: number,
  maxBpmDifference = MAX_SMART_MIX_BPM_DIFFERENCE,
  minConfidence = 0.5,
): string | undefined {
  if (!settings.beatMatching) return 'Beat matching is disabled'
  if (bpmDifference > maxBpmDifference) {
    return `BPM difference ${bpmDifference.toFixed(1)} exceeds the ${maxBpmDifference} BPM smart-mix limit`
  }
  if (!reliableGrid) return 'Reliable beat/downbeat features are unavailable'
  if (confidence < minConfidence) return 'Transition confidence is below the smart-render threshold'
  return undefined
}

/**
 * 响度补偿（借鉴 Echo Automix）：用 ITU-R BS.1770 积分响度（LUFS）差计算
 * 过渡段 target 相对 source 的增益补偿。target 更响则压（负），更轻则抬（正）。
 * 无 LUFS 数据时返回 0（不补偿）。clamp ±3.5dB。
 */
function computeGainOffsetDb(source: TrackAnalysis, target: TrackAnalysis): number {
  const sourceLufs = typeof source.integratedLufs === 'number' && Number.isFinite(source.integratedLufs) ? source.integratedLufs : null
  const targetLufs = typeof target.integratedLufs === 'number' && Number.isFinite(target.integratedLufs) ? target.integratedLufs : null
  if (sourceLufs === null || targetLufs === null) return 0
  return Math.max(-3.5, Math.min(3.5, sourceLufs - targetLufs))
}

/**
 * 过渡计划生成器（减配后恒为 Fixed Crossfade）。
 *
 * @param strategy 兼容参数：调用方仍可能传入历史策略名，本实现忽略并始终产出
 *                 `fixed-crossfade`（smart / beat-crossfade 生成分支已移除）。
 */
export function planTransition(
  source: TrackAnalysis,
  target: TrackAnalysis,
  settings: { beatMatching: boolean; skipSilence: boolean; minDuration?: number; maxDuration?: number },
  strategy: TransitionStrategy = 'fixed-crossfade',
): TransitionPlan {
  void strategy // 保留签名；策略不再影响输出（仅 Fixed Crossfade）。
  const sourceBpm = safeBpm(source.estimatedBpm)
  const targetBpm = safeBpm(target.estimatedBpm)
  const bpmDifference = Math.abs(sourceBpm - targetBpm)
  const beatDuration = 60 / safeBpm((sourceBpm + targetBpm) / 2)
  const tempoSimilarity = 1 - Math.min(bpmDifference / 40, 1)
  const baseDuration = tempoSimilarity > 0.8 ? 12 : tempoSimilarity > 0.5 ? 10 : 8
  const requestedMin = Number.isFinite(settings.minDuration) ? settings.minDuration! : Math.max(6, baseDuration - 2)
  const requestedMax = Number.isFinite(settings.maxDuration) ? settings.maxDuration! : Math.min(20, baseDuration + 8)
  const minDuration = Math.max(1, Math.min(20, requestedMin))
  const maxDuration = Math.max(minDuration, Math.min(20, requestedMax))
  const beatCount = chooseBeatCount(beatDuration, minDuration, maxDuration)

  const sourceFrameByBeat = new Map(source.beatFeatures.map(frame => [frame.beatIndex, frame]))
  const targetFrameByBeat = new Map(target.beatFeatures.map(frame => [frame.beatIndex, frame]))
  const sourceLoudness = loudnessNormalizer(source)
  const targetLoudness = loudnessNormalizer(target)

  // 尾部静音确定性裁剪（skipSilence）：过渡窗口不进入 outroSilence 静音区，
  // out 点落在真静音边界前（-45dBFS 语义，QQ 无缝"跳过首尾静音"同款）。
  // 分析缺失/无尾静音时 cap=duration，与原行为一致。
  const sourceEndCap = settings.skipSilence && Number.isFinite(source.outroSilence) && source.outroSilence > 0
    ? Math.max(0, source.duration - source.outroSilence)
    : source.duration
  // 过滤阈值跟随 cap 收缩：大段尾静音被裁掉后，避免候选窗被 75% 过滤器全部排除
  const sourceEndFilter = Math.min(source.duration * 0.75, Math.max(0, sourceEndCap - 1))
  const sourceWindows = candidatePoints(source, 0, sourceEndCap)
    .map(point => buildWindow(source, point, beatCount, sourceFrameByBeat))
    .filter((window): window is BeatWindow => Boolean(window && window.endTime >= sourceEndFilter))
  const targetStartMin = settings.skipSilence ? Math.max(0, target.introSilence) : 0
  const targetStartMax = Math.max(targetStartMin, target.duration * 0.2)
  const targetWindows = candidatePoints(target, targetStartMin, targetStartMax)
    .map(point => buildWindow(target, point, beatCount, targetFrameByBeat))
    .filter((window): window is BeatWindow => Boolean(window))

  const pairs: CandidatePair[] = []
  for (const sourceWindow of sourceWindows) {
    for (const targetWindow of targetWindows) {
      const sourceSection = nearestSection(source.sections, sourceWindow.endTime)
      const targetSection = nearestSection(target.sections, targetWindow.startTime)
      const windowCosts = averageWindowCost(sourceWindow, targetWindow, sourceLoudness, targetLoudness)
      pairs.push({
        source: sourceWindow,
        target: targetWindow,
        sourceSection,
        targetSection,
        sourceVocalness: windowCosts.sourceVocalness,
        targetVocalness: windowCosts.targetVocalness,
        components: {
          timbre: windowCosts.timbre,
          chroma: windowCosts.chroma,
          loudness: windowCosts.loudness,
          vocal: windowCosts.vocal,
          section: (boundaryCost(sourceSection) + boundaryCost(targetSection)) / 2,
          confidence: 1 - (
            source.confidence
            + target.confidence
            + sourceWindow.point.confidence
            + targetWindow.point.confidence
          ) / 4,
        },
        cost: 0,
      })
    }
  }

  if (pairs.length) {
    for (const component of ['timbre', 'chroma', 'loudness', 'vocal', 'section', 'confidence']) {
      normalizeComponent(pairs, component)
    }
    for (const pair of pairs) {
      pair.cost = pair.components.timbre * 0.23
        + pair.components.chroma * 0.15
        + pair.components.loudness * 0.14
        + pair.components.vocal * 0.20
        + pair.components.section * 0.24
        + pair.components.confidence * 0.04
    }
  }

  const chosen = pairs.length
    ? pairs.reduce((best, pair) => pair.cost < best.cost ? pair : best, pairs[0])
    : undefined
  const approximateDuration = beatCount * beatDuration
  const sourceStartTime = chosen?.source.startTime ?? Math.max(0, source.duration - approximateDuration)
  const sourceEndTime = chosen?.source.endTime ?? source.duration
  const targetStartTime = chosen?.target.startTime ?? targetStartMin
  const targetEndTime = chosen?.target.endTime ?? Math.min(target.duration, targetStartTime + approximateDuration)
  const sourceBeatTimes = chosen?.source.beatTimes ?? []
  const targetBeatTimes = chosen?.target.beatTimes ?? []
  const chosenCost = chosen?.cost ?? 1
  const confidence = clamp01(((source.confidence + target.confidence) / 2) * (1 - chosenCost * 0.35))
  const reliableGrid = Boolean(
    chosen
    && source.confidence >= MIN_ANALYSIS_CONFIDENCE
    && target.confidence >= MIN_ANALYSIS_CONFIDENCE
    && source.downbeats.length >= 2
    && target.downbeats.length >= 2
    && sourceBeatTimes.length === beatCount + 1
    && targetBeatTimes.length === beatCount + 1
  )
  const reason = fallbackReason(settings, bpmDifference, reliableGrid, confidence)
  const finalStrategy: TransitionStrategy = 'fixed-crossfade'

  const tempoRamp = Array.from({ length: Math.max(2, beatCount) }, (_, index) => {
    if (sourceBeatTimes.length !== beatCount + 1 || targetBeatTimes.length !== beatCount + 1) {
      const progress = index / Math.max(1, beatCount - 1)
      return sourceBpm * (1 - progress) + targetBpm * progress
    }
    const sourceDuration = sourceBeatTimes[index + 1] - sourceBeatTimes[index]
    const targetDuration = targetBeatTimes[index + 1] - targetBeatTimes[index]
    const progress = index / beatCount
    const outputDuration = (1 - progress) * sourceDuration + progress * targetDuration
    return 60 / Math.max(0.001, outputDuration)
  })

  const gainOffsetDb = computeGainOffsetDb(source, target)

  return {
    id: `${source.trackKey}->${target.trackKey}:${finalStrategy}:${sourceStartTime.toFixed(3)}-${sourceEndTime.toFixed(3)}:${targetStartTime.toFixed(3)}-${targetEndTime.toFixed(3)}:${beatCount}:${gainOffsetDb.toFixed(1)}:${RENDERER_VERSION}`,
    sourceTrackKey: source.trackKey,
    targetTrackKey: target.trackKey,
    sourceStartTime,
    sourceEndTime,
    targetStartTime,
    targetEndTime,
    beatCount,
    sourceBpm,
    targetBpm,
    tempoRamp,
    sourceDownbeatIndex: chosen?.source.point.downbeatIndex ?? -1,
    targetDownbeatIndex: chosen?.target.point.downbeatIndex ?? -1,
    sourceSection: chosen?.sourceSection,
    targetSection: chosen?.targetSection,
    sourceBeatTimes,
    targetBeatTimes,
    gainCurve: {
      source: powerCurve(Math.max(32, beatCount * 16), false),
      target: powerCurve(Math.max(32, beatCount * 16), true),
    },
    gainOffsetDb,
    confidence,
    strategy: finalStrategy,
    fallbackReason: reason,
    analysisVersion: source.analysisVersion === target.analysisVersion ? source.analysisVersion : 'mixed-analysis',
    rendererVersion: RENDERER_VERSION,
  }
}

/**
 * 兼容导出：AutoMix 增强版（v2）计划生成器。
 *
 * smart-rendered-v2 分支已移除，本函数保留导出与签名以免调用方悬空，内部委托
 * planTransition，产出与标准路径一致的 Fixed Crossfade 计划（无 v2 编排字段）。
 */
export function planTransitionV2(
  source: TrackAnalysis,
  target: TrackAnalysis,
  settings: {
    beatMatching: boolean
    skipSilence: boolean
    minDuration?: number
    maxDuration?: number
    intensity?: 'subtle' | 'standard' | 'strong'
    aiMix?: boolean
  },
  strategy: 'smart-rendered-v2' = 'smart-rendered-v2',
): TransitionPlan {
  void settings.intensity
  void settings.aiMix
  return planTransition(source, target, {
    beatMatching: settings.beatMatching,
    skipSilence: settings.skipSilence,
    minDuration: settings.minDuration,
    maxDuration: settings.maxDuration,
  }, strategy)
}
