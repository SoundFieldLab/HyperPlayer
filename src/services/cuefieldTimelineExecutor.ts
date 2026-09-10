/**
 * Cuefield Timeline Executor - 时间轴执行器
 * 执行 DJ 混音时间轴中的各种操作（音量、滤波、切换等）
 */

import type { CuefieldTimelineAction, CuefieldTimelineExecution } from './cuefieldAutoMix'

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, digits = 3): number {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

function normalizeAction(
  action: CuefieldTimelineAction,
  leadSec: number,
  targetVolume: number
): CuefieldTimelineAction & { delayMs: number; durationMs: number; target?: number } {
  const value = clamp(action.value ?? 1, 0, 1)
  const normalized = {
    ...action,
    t: round(toNumber(action.t, 0)),
    delayMs: Math.max(0, Math.round((toNumber(action.t, 0) + leadSec) * 1000)),
    durationMs: Math.max(0, Math.round(toNumber(action.durationMs, 0))),
    deck: action.deck === 'A' ? 'A' : action.deck === 'AB' ? 'AB' : 'B',
    op: action.op,
    type: action.type || '',
    value,
    at: Math.max(0, toNumber(action.at, 0)),
  } as CuefieldTimelineAction & { delayMs: number; durationMs: number; target?: number }

  if (normalized.op === 'volume') {
    normalized.target = round(targetVolume * value)
  }

  return normalized
}

function leadFromTimeline(timeline: CuefieldTimelineAction[], fallback: number): number {
  let lead = 0
  for (const action of timeline) {
    const t = toNumber(action.t, 0)
    if (t < 0) lead = Math.max(lead, Math.abs(t))
  }
  return lead > 0 ? round(lead) : fallback
}

function bStartFromTimeline(timeline: CuefieldTimelineAction[], fallback: number): number {
  for (const action of timeline) {
    if (action.deck === 'B' && action.op === 'play') {
      return Math.max(0, toNumber(action.at, fallback))
    }
  }
  return fallback
}

interface FallbackTimelineOptions {
  executionMode: string
  entryTime: number
}

function fallbackTimeline(opts: FallbackTimelineOptions): {
  leadSec: number
  bStart: number
  actions: CuefieldTimelineAction[]
} {
  const mode = opts.executionMode || 'filtered-pickup'
  const entryTime = Math.max(0, toNumber(opts.entryTime, 0))

  if (mode === 'intro-bed') {
    // 增加 intro-bed 模式的过渡时长：从 5.2s 提升到 10s（更符合 DJ 混音风格）
    const introLead = 10.0
    return {
      leadSec: introLead,
      bStart: Math.max(0, entryTime - Math.min(10.0, Math.max(4.0, entryTime * 0.7))),
      actions: [
        { t: -introLead, deck: 'B', op: 'play', at: Math.max(0, entryTime - introLead), value: 0 },
        { t: -introLead, deck: 'B', op: 'volume', value: 0.25, durationMs: 3000 },
        { t: -7.0, deck: 'A', op: 'volume', value: 0, durationMs: 6000 },
        { t: -7.0, deck: 'B', op: 'volume', value: 1, durationMs: 6000 },
        { t: -1.0, deck: 'B', op: 'handoff' },
      ],
    }
  }

  // 增加默认过渡时长：从 2.8s 提升到 8s（符合论文建议的 8-16 秒范围）
  return {
    leadSec: 8.0,
    bStart: Math.max(0, entryTime - Math.min(7.0, Math.max(2.0, entryTime * 0.6))),
    actions: [
      { t: -8.0, deck: 'B', op: 'play', at: Math.max(0, entryTime - 8.0), value: 0 },
      { t: -8.0, deck: 'B', op: 'volume', value: 1, durationMs: 7000 },
      { t: -8.0, deck: 'A', op: 'volume', value: 0, durationMs: 7000 },
      { t: -1.0, deck: 'B', op: 'handoff' },
    ],
  }
}

export interface BuildTimelineOptions {
  timeline?: CuefieldTimelineAction[]
  entryTime?: number
  executionMode?: string
  targetVolume?: number
}

export function buildCuefieldTimelineExecution(opts: BuildTimelineOptions): CuefieldTimelineExecution {
  const rawTimeline = Array.isArray(opts.timeline) ? opts.timeline.slice() : []
  const targetVolume = clamp(opts.targetVolume ?? 1, 0, 1)
  const fallback = rawTimeline.length ? null : fallbackTimeline({
    executionMode: opts.executionMode || 'filtered-pickup',
    entryTime: opts.entryTime || 0,
  })

  const timeline = rawTimeline.length ? rawTimeline : fallback!.actions
  const leadSec = rawTimeline.length
    ? leadFromTimeline(timeline, 8.0)
    : fallback!.leadSec
  const entryTime = Math.max(0, toNumber(opts.entryTime, 0))
  const bStart = rawTimeline.length
    ? bStartFromTimeline(timeline, entryTime)
    : fallback!.bStart

  const actions = timeline
    .map((action) => normalizeAction(action, leadSec, targetVolume))
    .filter((action) => !!action.op)
    .sort((a, b) => a.delayMs - b.delayMs || a.t - b.t)

  const requiresBGraph = actions.some(
    (action) => action.deck === 'B' && (action.op === 'filter' || action.op === 'bass')
  )

  const handoff = actions.filter((action) => action.op === 'handoff').slice(-1)[0]
  const crossfade = actions.filter((action) => action.op === 'crossfade')[0] || null
  const lastAction = actions[actions.length - 1] || null

  const handoffDelayMs = handoff
    ? handoff.delayMs
    : lastAction
    ? lastAction.delayMs + Math.max(520, lastAction.durationMs)
    : Math.round(leadSec * 1000)

  return {
    leadSec: round(leadSec),
    bStart: round(bStart),
    handoffDelayMs: Math.max(520, handoffDelayMs),
    fadeStartDelayMs: crossfade ? crossfade.delayMs : 0,
    fadeDurationMs: crossfade ? Math.max(320, crossfade.durationMs) : 0,
    requiresBGraph,
    actions,
  }
}

export class CuefieldTimelineExecutor {
  private delayWaiters: Array<{
    timer: number
    resolve: (ok: boolean) => void
  }> = []

  private generation = 0
  private fadeSerial = 0
  private fadeRaf = 0
  private fadeTimer = 0
  private fadeResolve: ((ok: boolean) => void) | null = null
  private gainRampId = 0
  private gainRamps = new Map<number, {
    frame: number
    timer: number
    resolve: (ok: boolean) => void
  }>()

  constructor() {}

  async delay(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter = {
        timer: 0,
        resolve: (ok: boolean) => {
          const index = this.delayWaiters.indexOf(waiter)
          if (index >= 0) this.delayWaiters.splice(index, 1)
          resolve(ok)
        },
      }

      waiter.timer = window.setTimeout(() => {
        waiter.resolve(true)
      }, Math.max(0, delayMs))

      this.delayWaiters.push(waiter)
    })
  }

  clearTimers(): void {
    while (this.delayWaiters.length) {
      const waiter = this.delayWaiters.pop()!
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    this.cancelFade()
    this.cancelGainRamps()
  }

  cancelGainRamps(): void {
    for (const ramp of this.gainRamps.values()) {
      if (ramp.frame) cancelAnimationFrame(ramp.frame)
      if (ramp.timer) clearInterval(ramp.timer)
      ramp.resolve(false)
    }
    this.gainRamps.clear()
  }

  runGainRamp(
    getCurrentGain: () => number,
    setGain: (gain: number) => void,
    targetGain: number,
    durationMs: number
  ): Promise<boolean> {
    const startGain = clamp(getCurrentGain(), 0, 1)
    const target = clamp(targetGain, 0, 1)
    const duration = Math.max(0, durationMs)
    if (duration === 0 || Math.abs(target - startGain) < 0.0001) {
      setGain(target)
      return Promise.resolve(true)
    }

    const id = ++this.gainRampId
    const startedAt = performance.now()
    return new Promise(resolve => {
      let settled = false
      const ramp = { frame: 0, timer: 0, resolve }
      this.gainRamps.set(id, ramp)

      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        if (ramp.frame) cancelAnimationFrame(ramp.frame)
        if (ramp.timer) clearInterval(ramp.timer)
        this.gainRamps.delete(id)
        if (ok) setGain(target)
        resolve(ok)
      }

      const applyStep = (now: number) => {
        if (settled || !this.gainRamps.has(id)) return finish(false)
        const progress = clamp((now - startedAt) / duration, 0, 1)
        const curve = target >= startGain
          ? Math.sin(progress * Math.PI * 0.5)
          : 1 - Math.cos(progress * Math.PI * 0.5)
        setGain(startGain + (target - startGain) * curve)
        if (progress >= 1) finish(true)
      }

      const tick = (now: number) => {
        applyStep(now)
        if (!settled) ramp.frame = requestAnimationFrame(tick)
      }
      ramp.timer = window.setInterval(() => applyStep(performance.now()), 40)
      ramp.frame = requestAnimationFrame(tick)
    })
  }

  cancelFade(): void {
    this.fadeSerial++
    if (this.fadeRaf) cancelAnimationFrame(this.fadeRaf)
    if (this.fadeTimer) clearInterval(this.fadeTimer)
    this.fadeRaf = 0
    this.fadeTimer = 0
    if (this.fadeResolve) {
      const resolve = this.fadeResolve
      this.fadeResolve = null
      resolve(false)
    }
  }

  async runEqualPowerCrossfade(
    outgoingMedia: HTMLAudioElement,
    incomingMedia: HTMLAudioElement,
    durationMs: number,
    targetVolume: number,
    fadeStartA: number,
    setOutgoingGain: (gain: number) => void,
    setIncomingGain: (gain: number) => void,
    getCurrentOutgoingGain: () => number,
    mixType = 'crossfade'
  ): Promise<boolean> {
    this.cancelFade()

    const serial = this.fadeSerial
    const initialTarget = Math.max(0.0001, targetVolume)
    const outgoingRatio = clamp(getCurrentOutgoingGain() / initialTarget, 0, 1)
    const headroomDepth = mixType === 'beatmix' ? 0.16 : 0.10
    const fadeWatchdogAt = Date.now() + durationMs + 1800

    durationMs = Math.max(1, durationMs)

    return new Promise((resolve) => {
      let settled = false
      this.fadeResolve = resolve

      const finish = (ok: boolean) => {
        if (settled) return
        settled = true

        if (this.fadeResolve === resolve) this.fadeResolve = null
        if (this.fadeRaf) cancelAnimationFrame(this.fadeRaf)
        if (this.fadeTimer) clearInterval(this.fadeTimer)
        this.fadeRaf = 0
        this.fadeTimer = 0
        resolve(ok)
      }

      const applyStep = () => {
        if (settled || serial !== this.fadeSerial) {
          finish(false)
          return
        }

        if (Date.now() >= fadeWatchdogAt) {
          finish(false)
          return
        }

        const mediaNow = outgoingMedia.currentTime
        let t = clamp((mediaNow - fadeStartA) / (durationMs / 1000), 0, 1)

        if (outgoingMedia.ended || (isFinite(outgoingMedia.duration) && outgoingMedia.duration - mediaNow <= 0.025)) {
          t = 1
        }

        // Smoothstep 缓动
        const eased = t * t * (3 - 2 * t)
        const theta = eased * Math.PI * 0.5
        const liveTarget = clamp(targetVolume, 0, 1)

        // Overlap headroom（防止爆音）
        const overlapHeadroom = 1 - Math.sin(Math.PI * eased) * headroomDepth

        const outgoing = liveTarget * outgoingRatio * Math.cos(theta) * overlapHeadroom
        const incoming = liveTarget * Math.sin(theta) * overlapHeadroom

        setOutgoingGain(outgoing)
        setIncomingGain(incoming)

        if (t >= 1) {
          setOutgoingGain(0)
          setIncomingGain(liveTarget)
          finish(true)
        }
      }

      const tick = () => {
        applyStep()
        if (!settled) this.fadeRaf = requestAnimationFrame(tick)
      }

      this.fadeTimer = window.setInterval(() => {
        applyStep()
      }, 40)

      this.fadeRaf = requestAnimationFrame(tick)
    })
  }

  reset(): void {
    this.generation++
    this.clearTimers()
  }
}
