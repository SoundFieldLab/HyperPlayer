/**
 * Cuefield AutoMix - DJ级智能混音核心
 * 基于 Mineradio 的实现，使用 AI 节拍分析和 Timeline 编排
 */

export interface CuefieldSong {
  key: string
  url: string
  title?: string
  artist?: string
  album?: string
  albumId?: string
  duration?: number
  lyrics?: string
}

export interface CuefieldTransitionRecipe {
  recipe: string // 'simple-crossfade' | 'anchor-aligned-beatmix' | 'intro-bed' | 'filtered-pickup'
  mixType?: string
  confidence: number
  fadeSec?: number
  anchorLead?: number
  warmupSec?: number
  fadeStartA?: number
  bFadeStart?: number
}

export interface CuefieldTimelineAction {
  t: number // 相对时间（秒），负数表示提前
  delayMs?: number // 延迟（毫秒）
  durationMs?: number // 持续时间（毫秒）
  deck: 'A' | 'B' | 'AB' // A=当前轨道, B=下一首
  op: 'play' | 'volume' | 'filter' | 'bass' | 'handoff' | 'crossfade' // 操作类型
  type?: string
  value?: number // 0-1
  at?: number // 绝对时间（秒）
}

export interface CuefieldTransitionPlan {
  ok: boolean
  chosen?: {
    transitionRecipe?: string
    recipeCandidate?: CuefieldTransitionRecipe
    evaluation?: {
      tier: 'magic' | 'usable' | 'usable_but_not_magic' | 'weak'
      score: number
      risks: string[]
    }
    timeline?: CuefieldTimelineAction[]
    exit?: { time: number }
    entry?: { time: number }
    mixType?: string
    mixConfidence?: number
    score?: number
  }
}

export interface CuefieldPendingTransition {
  token: number
  currentIndex: number
  nextIndex: number
  fromKey: string
  toKey: string
  plan: CuefieldTransitionPlan
  timeline: CuefieldTimelineAction[]
  audioUrl: string
  executionMode: string
  mixType: string
  mixConfidence: number
  fadeSec: number
  anchorLead: number
  warmupSec: number
  fadeStartA: number
  bFadeStart: number
  entryTime: number
  exitTime: number
  triggerAt: number
  createdAt: number
  preparedAudio?: HTMLAudioElement
  timelineExecution?: CuefieldTimelineExecution
}

export interface CuefieldTimelineExecution {
  leadSec: number
  bStart: number
  handoffDelayMs: number
  fadeStartDelayMs: number
  fadeDurationMs: number
  requiresBGraph: boolean
  actions: Array<CuefieldTimelineAction & {
    delayMs: number
    durationMs: number
    target?: number
  }>
}

export type CuefieldAutoMixStatus =
  | 'disabled'
  | 'idle'
  | 'waiting'
  | 'preparing'
  | 'waiting-beatmap'
  | 'missing-audio'
  | 'fallback'
  | 'ready'
  | 'executing'
  | 'handoff'
  | 'error'

export interface CuefieldAutoMixState {
  enabled: boolean
  preparing: boolean
  pending: CuefieldPendingTransition | null
  lastStatus: CuefieldAutoMixStatus
  serial: number
}

const EXECUTABLE_TIERS = { magic: true, usable: true, usable_but_not_magic: true }
const HARD_RISKS: Record<string, boolean> = {
  'closed outgoing phrase': true,
  'near closed outgoing phrase': true,
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return isFinite(n) ? n : fallback
}

function tierOf(plan: CuefieldTransitionPlan): string {
  return plan?.chosen?.evaluation?.tier || ''
}

function hasHardRisk(plan: CuefieldTransitionPlan): boolean {
  const risks = plan?.chosen?.evaluation?.risks || []
  return risks.some(risk => HARD_RISKS[risk])
}

function isExecutablePlan(plan: CuefieldTransitionPlan, minMixConfidence: number): boolean {
  const tier = tierOf(plan)
  const chosen = plan?.chosen || {}
  const recipeCandidate = chosen.recipeCandidate as { recipe?: string; confidence?: number } | undefined || {}
  const recipe = chosen.transitionRecipe || recipeCandidate.recipe || ''
  const mixConfidence = toNumber(chosen.mixConfidence, toNumber(recipeCandidate.confidence, 0))

  if (recipe === 'simple-crossfade') return mixConfidence >= 0.8
  if (recipe === 'anchor-aligned-beatmix') {
    return !hasHardRisk(plan) && mixConfidence >= minMixConfidence
  }
  if (hasHardRisk(plan)) return false
  return !!EXECUTABLE_TIERS[tier as keyof typeof EXECUTABLE_TIERS] && mixConfidence >= minMixConfidence
}

function executionModeFor(plan: CuefieldTransitionPlan): string {
  const chosen = plan?.chosen || {}
  const recipe = chosen.transitionRecipe || chosen.recipeCandidate?.recipe || ''
  if (recipe) return recipe
  return tierOf(plan) === 'weak' ? 'intro-bed' : 'filtered-pickup'
}

function timelineLeadSec(timeline: CuefieldTimelineAction[], fallback: number): number {
  let lead = 0
  for (const action of timeline) {
    const t = toNumber(action.t, 0)
    if (t < 0) lead = Math.max(lead, Math.abs(t))
  }
  return lead > 0 ? lead : fallback
}

function timelineBStart(timeline: CuefieldTimelineAction[], fallback: number): number {
  for (const action of timeline) {
    if (action.deck === 'B' && action.op === 'play') {
      return Math.max(0, toNumber(action.at, fallback))
    }
  }
  return fallback
}

export class CuefieldAutoMix {
  private state: CuefieldAutoMixState = {
    enabled: false,
    preparing: false,
    pending: null,
    lastStatus: 'idle',
    serial: 0,
  }

  private minMixConfidence = 0.64

  constructor(
    private deps: {
      ensureBeatMap?: (song: CuefieldSong) => Promise<boolean>
      planTransition: (fromKey: string, toKey: string, fromSong: CuefieldSong, toSong: CuefieldSong) => Promise<CuefieldTransitionPlan>
      prepareAudioUrl: (song: CuefieldSong) => Promise<string>
    }
  ) {}

  setEnabled(enabled: boolean): boolean {
    this.state.enabled = !!enabled
    if (!this.state.enabled) this.reset('disabled')
    return this.state.enabled
  }

  reset(status?: CuefieldAutoMixStatus): void {
    this.state.pending = null
    this.state.preparing = false
    this.state.lastStatus = status || 'idle'
    this.state.serial++
  }

  async prepare(ctx: {
    token: number
    currentIndex: number
    nextIndex: number
    currentSong: CuefieldSong
    nextSong: CuefieldSong
    leadSec?: number
    introBedLeadSec?: number
  }): Promise<{ status: CuefieldAutoMixStatus; pending?: CuefieldPendingTransition; plan?: CuefieldTransitionPlan }> {
    if (!this.state.enabled) return { status: 'disabled' }
    if (this.state.preparing) return { status: 'waiting' }

    const { currentSong, nextSong } = ctx
    if (!currentSong || !nextSong) {
      this.reset('idle')
      return { status: 'idle' }
    }

    const fromKey = currentSong.key
    const toKey = nextSong.key
    if (!fromKey || !toKey || fromKey === toKey) {
      this.reset('idle')
      return { status: 'idle' }
    }

    const serial = ++this.state.serial
    this.state.preparing = true
    this.state.lastStatus = 'preparing'

    try {
      // 1. 确保节拍分析完成
      if (this.deps.ensureBeatMap) {
        const fromReady = await this.deps.ensureBeatMap(currentSong)
        if (serial !== this.state.serial) return { status: 'idle' }
        
        const toReady = await this.deps.ensureBeatMap(nextSong)
        if (serial !== this.state.serial) return { status: 'idle' }

        if (!fromReady || !toReady) {
          this.reset('waiting-beatmap')
          return { status: 'waiting-beatmap' }
        }
      }

      // 2. 规划过渡
      const plan = await this.deps.planTransition(fromKey, toKey, currentSong, nextSong)
      if (serial !== this.state.serial) return { status: 'idle' }

      const chosen = plan?.chosen
      if (!plan?.ok || !chosen || !isExecutablePlan(plan, this.minMixConfidence)) {
        this.reset('fallback')
        return { status: 'fallback', plan }
      }

      // 3. 准备音频 URL
      const audioUrl = await this.deps.prepareAudioUrl(nextSong)
      if (serial !== this.state.serial) return { status: 'idle' }
      
      if (!audioUrl) {
        this.reset('missing-audio')
        return { status: 'missing-audio', plan }
      }

      // 4. 构建 pending transition
      const exitTime = toNumber(chosen.exit?.time, NaN)
      const executionMode = executionModeFor(plan)
      const timeline = chosen.timeline || []
      const fallbackLeadSec = executionMode === 'intro-bed'
        ? toNumber(ctx.introBedLeadSec, toNumber(ctx.leadSec, 1))
        : toNumber(ctx.leadSec, 1)
      const leadSec = timelineLeadSec(timeline, fallbackLeadSec)
      const triggerAt = isFinite(exitTime) ? Math.max(0, exitTime - leadSec) : 0
      const entryTime = timelineBStart(timeline, Math.max(0, toNumber(chosen.entry?.time, 0)))

      const pending: CuefieldPendingTransition = {
        token: ctx.token,
        currentIndex: ctx.currentIndex,
        nextIndex: ctx.nextIndex,
        fromKey,
        toKey,
        plan,
        timeline,
        audioUrl,
        executionMode,
        mixType: chosen.mixType || chosen.recipeCandidate?.mixType || '',
        mixConfidence: toNumber(chosen.mixConfidence, toNumber(chosen.recipeCandidate?.confidence, 0)),
        fadeSec: toNumber(chosen.recipeCandidate?.fadeSec, 0),
        anchorLead: toNumber(chosen.recipeCandidate?.anchorLead, 0),
        warmupSec: toNumber(chosen.recipeCandidate?.warmupSec, 0),
        fadeStartA: toNumber(chosen.recipeCandidate?.fadeStartA, NaN),
        bFadeStart: toNumber(chosen.recipeCandidate?.bFadeStart, NaN),
        entryTime,
        exitTime,
        triggerAt,
        createdAt: Date.now(),
      }

      this.state.pending = pending
      this.state.lastStatus = 'ready'
      return { status: 'ready', pending }
    } catch (err) {
      this.reset('error')
      return { status: 'error' }
    } finally {
      this.state.preparing = false
    }
  }

  shouldTrigger(ctx: { token: number; currentIndex: number; currentTime: number }): boolean {
    const pending = this.state.pending
    if (!this.state.enabled || !pending) return false
    if (pending.token !== ctx.token) return false
    if (pending.currentIndex !== ctx.currentIndex) return false
    return toNumber(ctx.currentTime, 0) >= pending.triggerAt
  }

  consumePending(): CuefieldPendingTransition | null {
    const pending = this.state.pending
    this.state.pending = null
    this.state.lastStatus = pending ? 'executing' : this.state.lastStatus
    return pending
  }

  snapshot(): CuefieldAutoMixState {
    return { ...this.state }
  }
}
