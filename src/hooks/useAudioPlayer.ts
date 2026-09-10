import { debugLog } from '../utils/debugLog'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  onStateChange as onBridgeStateChange,
  getState as getBridgeState,
  bridgePause,
  bridgeResume,
  bridgeSeek,
  bridgeVolume,
  bridgeFade,
  bridgeStopPlayback,
} from '../services/appleWebViewBridge'
import { autoMixAnalysisService } from '../services/autoMixAnalysisService'
import { releaseAppleNativeStream, type AppleNativeStream } from '../services/applePlayback'
import { isHlsUrl, attachAppleHls, detachAppleHls, getActiveAppleStream, getActiveHls } from '../services/appleHlsPlayer'
import { planTransition } from '../audio/transitionPlanner'
import { createPlaybackTimeStore } from '../audio/playbackTimeStore'
import { GaplessIntegration } from '../services/gaplessIntegration'
import { createSeamlessJoinController, type SeamlessJoinController } from '../services/gapless/seamlessJoinController'
import { runGaplessDeckFade } from '../services/gapless/gaplessTransition'
import { GAPLESS_SEAMLESS_WARMUP_SECONDS } from '../services/gapless/gaplessConstants'
import { getProxiedAudioUrl } from '../services/musicApi'
import type { GaplessSettings } from '../services/gapless/gaplessConstants'
import type {
  PlaybackEngineState,
  PreloadTrack,
  TrackAnalysis,
  TransitionCommit,
  TransitionDebugInfo,
  TransitionPlan,
  TransitionState,
  TransitionStrategy,
} from '../audio/types'

export type AudioPlayerState = PlaybackEngineState

export interface CrossfadeSettings {
  enabled: boolean
  duration: number
}

// GaplessSettings 已移入 src/services/gapless/gaplessConstants（本文件 re-export 保持兼容）

export interface AutoMixSettings {
  enabled: boolean
  mode: 'auto' | 'manual'
  enableBeatMatching: boolean
  skipSilence: boolean
  minDuration?: number
  maxDuration?: number
  /** AutoMix 增强版（v2）引擎开关：false/缺省 = 标准 v1（行为与历史一致） */
  enhanced?: boolean
  /** v2 特效强度档位 */
  intensity?: 'subtle' | 'standard' | 'strong'
  /** v2 可选 AI 混音（DJTransGAN）开关 */
  aiMix?: boolean
}

// 音频图就绪后交给外部（音效引擎）的句柄
export interface AudioGraphHandle {
  audioContext: AudioContext
  masterGain: GainNode
  analyser: AnalyserNode
  /** 最终输出增益节点（analyser 之后、destination 之前）：用于整体静音/输出控制，
   *  不影响 masterGain（效果链采集点在其之前）。 */
  outputGain?: GainNode
}

interface DeckMetadata extends PreloadTrack {
  analysis?: TrackAnalysis
}

const DEFAULT_VOLUME = 0.7
const CURVE_POINTS = 64
const EXTERNAL_HANDOFF_FADE_MS = 72
const EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS = 0.025
const CURRENT_MEDIA_LOAD_TIMEOUT_MS = 18_000
const PRELOAD_MEDIA_LOAD_TIMEOUT_MS = 15_000
// 过渡动画提前量：动画（倒计时/流光/渐变）最多提前这么久进入，
// 与音频过渡起点（可能是 AI 长混音的 ~60s 前）解耦。
const ANIMATION_LEAD_SECONDS = 10
// REPREPARE（借鉴 QQ 音乐 FromInfo PREPARE_NEXT→REPREPARE_NEXT 441/442、469/470）：
// 分析失败属瞬时性（网络抖动、解码超时），只降级不重试会让整曲周期停留在 fallback。
// 失败后延时单次重试；冷却期防抖；最多 2 次尝试。
const AUTO_MIX_REPREPARE_DELAY_MS = 20_000
const AUTO_MIX_REPREPARE_COOLDOWN_MS = 15_000
const AUTO_MIX_MAX_PREPARE_ATTEMPTS = 2

function asPreloadTrack(input: string | PreloadTrack): PreloadTrack {
  return typeof input === 'string' ? { url: input } : input
}

export function resolvePairTransitionStrategy(
  current: Pick<PreloadTrack, 'appleHls'> | null | undefined,
  next: Pick<PreloadTrack, 'appleHls'> | null | undefined,
  settings: { autoMix: boolean; crossfade: boolean; gapless: boolean },
): TransitionStrategy | 'automix' {
  const applePair = Boolean(current?.appleHls || next?.appleHls)
  if (settings.autoMix) return applePair ? 'gapless' : 'automix'
  if (settings.crossfade) return 'fixed-crossfade'
  if (settings.gapless) return 'gapless'
  return 'none'
}

function equalPowerCurve(fadeIn: boolean): Float32Array {
  const curve = new Float32Array(CURVE_POINTS)
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    const progress = i / (CURVE_POINTS - 1)
    curve[i] = fadeIn ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2)
  }
  return curve
}

/** ③ 格式/一致性预检（借鉴 QQ 音乐 addPlayer 前的格式 gate：声道不符直接放弃混音）。
 *  返回拦截原因；null = 放行。"明知会失败的组合"不进智能渲染，提前安静降级固定交叉。 */
export function describeTransitionCompatibilityIssue(
  source: TrackAnalysis,
  target: TrackAnalysis,
  current: DeckMetadata | null,
  next: DeckMetadata | null,
): string | null {
  const metadataIssue = (analysis: TrackAnalysis, label: string): string | null =>
    analysis.provider === 'metadata-only' || analysis.provider === 'tv-metadata-only' || analysis.provider === 'electron-unavailable'
      ? `${label}分析为元数据降级（provider=${analysis.provider}），无节拍网格可用`
      : null
  const providerIssue = metadataIssue(source, '当前曲') ?? metadataIssue(target, '下一曲')
  if (providerIssue) return providerIssue

  // 分析时长与流时长不一致（旧缓存/换源）：渲染窗口可能越过真实音频末尾，
  // AudioFile 读越界 → 渲染中途失败 → 只能在窗口起点后才发现
  const durationIssue = (analysis: TrackAnalysis, stream: number, label: string): string | null => {
    if (!Number.isFinite(stream) || stream <= 0) return null
    if (!Number.isFinite(analysis.duration)) return null
    if (Math.abs(analysis.duration - stream) <= 1.5) return null
    return `${label}分析时长与流时长不一致（analysis=${analysis.duration.toFixed(1)}s vs stream=${stream.toFixed(1)}s），疑似过期缓存或换源`
  }
  const streamIssue = durationIssue(source, Number(current?.duration) || 0, '当前曲')
    ?? durationIssue(target, Number(next?.duration) || 0, '下一曲')
  if (streamIssue) return streamIssue

  // 多声道（>2ch）：渲染管线（ensure_stereo 只上混单声道）按立体声数学处理，不做盲混
  const sourceChannels = source.audioFormat?.channels
  const targetChannels = target.audioFormat?.channels
  if (sourceChannels && sourceChannels > 2) return `当前曲为多声道音频（${sourceChannels}ch），智能混音仅支持立体声`
  if (targetChannels && targetChannels > 2) return `下一曲为多声道音频（${targetChannels}ch），智能混音仅支持立体声`
  return null
}

/** 渲染端 automix 事件写入后端日志文件（automix-backend.log），便于前后端合并定位。 */
function logAutomixBackend(scope: string, message: string): void {
  window.electron?.automixLog?.(scope, message).catch(() => undefined)
}

/** 从过渡计划构建调试信息（过渡调试弹窗展示用）。 */
function buildTransitionDebug(
  plan: TransitionPlan,
  engine: 'v1' | 'v2' | 'fallback',
  sourceAnalysis?: TrackAnalysis,
  targetAnalysis?: TrackAnalysis,
): TransitionDebugInfo {
  // 智能渲染（smart-rendered）路径已移除；当前仅 Fixed Crossfade，无 DJ 特效清单。
  const effects: string[] = []
  return {
    engine,
    strategy: plan.strategy,
    fallbackReason: plan.fallbackReason,
    sourceTrackKey: plan.sourceTrackKey,
    targetTrackKey: plan.targetTrackKey,
    beatCount: plan.beatCount,
    sourceBpm: plan.sourceBpm,
    targetBpm: plan.targetBpm,
    confidence: plan.confidence,
    rendererVersion: plan.rendererVersion,
    sourceStartTime: plan.sourceStartTime,
    sourceEndTime: plan.sourceEndTime,
    targetStartTime: plan.targetStartTime,
    targetEndTime: plan.targetEndTime,
    effects,
    gainOffsetDb: plan.gainOffsetDb,
    sourceProvider: sourceAnalysis?.provider,
    targetProvider: targetAnalysis?.provider,
  }
}

function waitForSeek(audio: HTMLAudioElement, timeoutMs = 120): Promise<void> {
  if (!audio.seeking) return Promise.resolve()

  return new Promise(resolve => {
    let timeoutId = 0
    const finish = () => {
      audio.removeEventListener('seeked', finish)
      if (timeoutId) window.clearTimeout(timeoutId)
      resolve()
    }

    audio.addEventListener('seeked', finish, { once: true })
    timeoutId = window.setTimeout(finish, timeoutMs)
  })
}

/**
 * 等待音频元素在当前位置具备可播数据（readyState ≥ HAVE_CURRENT_DATA）。
 * handoff 时 seek 到 AI 混音恢复点（目标曲深处，可能超出预缓冲范围）后，
 * play() 前必须确认数据就绪，否则会在未缓冲位置出声失败 → 静音断开一次。
 * 本地缓存文件瞬时返回；网络流等待 canplay（最多 timeoutMs，超时也放行，
 * 交由浏览器尽力缓冲，避免无限阻塞过渡）。
 */
function waitForPlayable(audio: HTMLAudioElement, timeoutMs = 3000): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve()
  if (!audio.src && !audio.currentSrc) return Promise.resolve()

  return new Promise(resolve => {
    let timeoutId = 0
    const cleanup = () => {
      audio.removeEventListener('canplay', finish)
      audio.removeEventListener('canplaythrough', finish)
      audio.removeEventListener('error', finish)
      if (timeoutId) window.clearTimeout(timeoutId)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    audio.addEventListener('canplay', finish, { once: true })
    audio.addEventListener('canplaythrough', finish, { once: true })
    audio.addEventListener('error', finish, { once: true })
    timeoutId = window.setTimeout(finish, timeoutMs)
  })
}

export function useAudioPlayer(
  onStateChange: (state: Partial<AudioPlayerState>) => void,
  crossfadeSettings: CrossfadeSettings = { enabled: false, duration: 4 },
  gaplessSettings: GaplessSettings = { enabled: false, albumGapless: false },
  autoMixSettings: AutoMixSettings = {
    enabled: false,
    mode: 'auto',
    enableBeatMatching: true,
    skipSilence: true,
  },
  onAudioGraphReady?: (handle: AudioGraphHandle) => void
) {
  const primaryRef = useRef<HTMLAudioElement | null>(null)
  const secondaryRef = useRef<HTMLAudioElement | null>(null)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const activePrimaryRef = useRef(true)
  const onStateChangeRef = useRef(onStateChange)
  const crossfadeRef = useRef(crossfadeSettings)
  const gaplessRef = useRef(gaplessSettings)
  const autoMixRef = useRef(autoMixSettings)
  const onAudioGraphReadyRef = useRef(onAudioGraphReady)
  const volumeRef = useRef(DEFAULT_VOLUME)
  const transitionStateRef = useRef<TransitionState>('idle')
  /** 看歌挂起（App 进出看歌时置位）：挂起期间引擎不准备/不启动任何自动过渡，
   *  保证看歌期间歌曲不会因 automix 自动推进（切回仍是原歌），退出看歌时解除 */
  const watchHoldRef = useRef(false)
  const transitionPlanRef = useRef<TransitionPlan | null>(null)
  const transitionTimerRef = useRef<number | null>(null)
  // overlap handoff：deck 提前淡入的启动 timer（AI 长混音缓冲结束前 overlap 秒触发）
  const transitionDeckStartTimerRef = useRef<number | null>(null)
  const fallbackAnimationRef = useRef<number | null>(null)
  const transitionProgressAnimationRef = useRef<number | null>(null)  // 过渡进度动画帧
  const transitionStartTimeRef = useRef<number | null>(null)  // 过渡开始时间
  // 过渡进度 emit 节流：rAF 仍每帧驱动，但仅当距上次 emit ≥30ms 才 emit（约 30fps），
  // 降低 App 整树重渲染频率；progress 到达 1 时强制 emit 最终值确保状态复位
  const transitionProgressEmitTimeRef = useRef(0)
  const retiredDeckCleanupTimerRef = useRef<number | null>(null)
  const preparationAbortRef = useRef<AbortController | null>(null)
  const autoMixPreparationKeyRef = useRef<string | null>(null)
  const acceptanceAutoMixAnalysisStartsRef = useRef(0)
  // REPREPARE 状态：组合级"已就绪"集合 + 失败尝试记录 + 定时重试句柄
  const autoMixPreparedOkRef = useRef<Set<string>>(new Set())
  const autoMixPreparationAttemptsRef = useRef<Map<string, { attempts: number; lastAt: number }>>(new Map())
  const autoMixPrepareRetryTimerRef = useRef<number | null>(null)
  const prepareAutoMixRef = useRef<() => void>(() => {})
  const preparationRevisionRef = useRef(0)
  const transitionExecutionRevisionRef = useRef(0)
  const visualSwitchTimerRef = useRef<number | null>(null)
  const preloadReadyCleanupRef = useRef<(() => void) | null>(null)
  const currentLoadWaitCancelRef = useRef<(() => void) | null>(null)
  // adoptExternalAudio 接管淡出的动画帧 id：用于卸载/取消路径 cancelAnimationFrame，防止 rAF 自循环泄漏
  const externalHandoffFadeFrameRef = useRef<number | null>(null)
  const transitionStartingRef = useRef(false)
  const isLoadingRef = useRef(false)
  const currentLoadRevisionRef = useRef(0)
  const currentMetadataRef = useRef<DeckMetadata | null>(null)
  const nextMetadataRef = useRef<DeckMetadata | null>(null)
  /** 当前曲是否为直播流（Apple 电台）：时长按 Infinity 处理，UI 显示直播态 */
  const isLiveRef = useRef(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodesRef = useRef<[GainNode | null, GainNode | null]>([null, null])
  const masterGainRef = useRef<GainNode | null>(null)
  const analyserNodeRef = useRef<AnalyserNode | null>(null)
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null)
  const gaplessIntegrationRef = useRef<GaplessIntegration | null>(null)
  // Gapless 首选无缝拼接控制器（独立模块，逻辑见 src/services/gapless/）
  const seamlessJoinControllerRef = useRef<SeamlessJoinController | null>(null)
  const playAtCallbackRef = useRef<((index: number, options: any) => Promise<boolean>) | null>(null)
  const [playbackTimeStore] = useState(createPlaybackTimeStore)

  // ── 外部播放源模式（WebView2 播放面）──
  // 音频在 WebView2 兼容播放窗口中解密播放，本地 deck 无 src；
  // 状态经 bridge 轮询 → emit 管线分发，控制命令转发 bridge（见 togglePlay/seek/setVolume 分流）。
  const externalActiveRef = useRef(false)
  const externalUnsubscribeRef = useRef<(() => void) | null>(null)
  const externalEndedFiredRef = useRef(false)
  const externalDurationRef = useRef(0)
  /** 基础交叉淡化：淡出斜坡在途标记（seek 出窗口/暂停时复位并恢复音量） */
  const externalFadeActiveRef = useRef(false)
  /** 上一首带淡出尾自然结束 → 下一首（Apple 或本地 deck）做淡入头（基础交叉的"入"半边） */
  const externalEndedWithFadeRef = useRef(false)
  useEffect(() => () => { try { externalUnsubscribeRef.current?.() } catch { /* 卸载清理 */ } }, [])

  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])
  useEffect(() => { crossfadeRef.current = crossfadeSettings }, [crossfadeSettings])
  useEffect(() => { gaplessRef.current = gaplessSettings }, [gaplessSettings])
  useEffect(() => { autoMixRef.current = autoMixSettings }, [autoMixSettings])
  useEffect(() => { onAudioGraphReadyRef.current = onAudioGraphReady }, [onAudioGraphReady])

  const emit = useCallback((state: Partial<AudioPlayerState>) => {
    if (state.currentTime !== undefined || state.duration !== undefined || state.isPlaying !== undefined) {
      playbackTimeStore.publish({
        ...(state.currentTime !== undefined ? { currentTime: state.currentTime } : {}),
        ...(state.duration !== undefined ? { duration: state.duration } : {}),
        ...(state.isPlaying !== undefined ? { isPlaying: state.isPlaying } : {}),
      })
    }
    onStateChangeRef.current(state)
  }, [])

  /** 直播流（HLS Infinity）等异常时长收敛为 0（UI 依赖有限值显示/拖动） */
  const finiteDuration = useCallback((value: number | undefined): number => {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }, [])

  const setTransitionState = useCallback((state: TransitionState, extra: Partial<AudioPlayerState> = {}) => {
    transitionStateRef.current = state
    emit({ transitionState: state, ...extra })
  }, [emit])

  const getActiveAudio = useCallback(() => activePrimaryRef.current ? primaryRef.current : secondaryRef.current, [])
  const getStandbyAudio = useCallback(() => activePrimaryRef.current ? secondaryRef.current : primaryRef.current, [])
  const getActiveGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 0 : 1], [])
  const getStandbyGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 1 : 0], [])

  // 专辑播放判定（三方案分流依据）：当前曲与下一曲属于同一专辑
  // （albumId 都存在且相等）→ 专辑场景；否则为非专辑（普通列表）场景。
  // 同专辑时即使 AutoMix 启用也优先走首尾拼接无缝方案（预热 20s + ended 拼接），
  // AutoMix 智能过渡只接管非专辑场景。
  const isAlbumPlayback = useCallback(() => {
    const currentMeta = currentMetadataRef.current
    const nextMeta = nextMetadataRef.current
    return Boolean(currentMeta?.albumId && nextMeta?.albumId && currentMeta.albumId === nextMeta.albumId)
  }, [])

  const setDeckGain = useCallback((gain: GainNode | null, audio: HTMLAudioElement | null, value: number) => {
    const next = Math.max(0, Math.min(1, value))
    if (gain && audioContextRef.current) {
      gain.gain.cancelScheduledValues(audioContextRef.current.currentTime)
      gain.gain.setValueAtTime(next, audioContextRef.current.currentTime)
      if (audio) audio.volume = 1
    } else if (audio) {
      audio.volume = next * volumeRef.current
    }
  }, [])

  const ensureAudioGraph = useCallback(async () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume().catch(() => undefined)
      return
    }
    const first = primaryRef.current
    const second = secondaryRef.current
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!first || !second || !AudioContextCtor) return
    let context: AudioContext | null = null
    try {
      context = new AudioContextCtor()
      const master = context.createGain()
      const firstGain = context.createGain()
      const secondGain = context.createGain()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.minDecibels = -90
      analyser.maxDecibels = -8
      analyser.smoothingTimeConstant = 0.58
      // 最终输出增益节点：整体输出控制（analyser 之后、destination 之前）
      const outputGain = context.createGain()
      outputGain.gain.value = 1
      context.createMediaElementSource(first).connect(firstGain).connect(master)
      context.createMediaElementSource(second).connect(secondGain).connect(master)
      master.connect(analyser).connect(outputGain).connect(context.destination)
      master.gain.value = volumeRef.current
      firstGain.gain.value = activePrimaryRef.current ? 1 : 0
      secondGain.gain.value = activePrimaryRef.current ? 0 : 1
      first.volume = 1
      second.volume = 1
      audioContextRef.current = context
      gainNodesRef.current = [firstGain, secondGain]
      masterGainRef.current = master
      analyserNodeRef.current = analyser
      setAnalyserNode(analyser)
      // 应用用户选择的音频输出设备（AudioContext.setSinkId，整体切换输出）
      void import('../services/audioOutput').then(({ applyStoredOutputDevice, registerActiveAudioContext }) => {
        registerActiveAudioContext(context)
        void applyStoredOutputDevice(context)
      })
      
      // 初始化 Gapless Integration
      if (gaplessIntegrationRef.current) {
        gaplessIntegrationRef.current.initAudioContext(context, analyser)
      }
      
      // 通知外部音效引擎：音频图已就绪（在 masterGain 与 analyser 之间插入效果链）
      onAudioGraphReadyRef.current?.({ audioContext: context, masterGain: master, analyser, outputGain })
      
      if (context.state === 'suspended') await context.resume().catch(() => undefined)
    } catch (error) {
      console.warn('[PlaybackEngine] Web Audio gain graph unavailable, using media volume fallback', error)
      if (context && context.state !== 'closed') void context.close()
      audioContextRef.current = null
      gainNodesRef.current = [null, null]
      masterGainRef.current = null
      analyserNodeRef.current = null
      setAnalyserNode(null)
    }
  }, [])


  const cancelScheduledTransition = useCallback((reason = 'playback intent changed', preserveNext = true, announceCancellation = true) => {
    preparationRevisionRef.current += 1
    transitionExecutionRevisionRef.current += 1
    transitionStartingRef.current = false
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = null
    autoMixPreparationKeyRef.current = null
    if (autoMixPrepareRetryTimerRef.current !== null) {
      window.clearTimeout(autoMixPrepareRetryTimerRef.current)
      autoMixPrepareRetryTimerRef.current = null
    }
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
    if (transitionDeckStartTimerRef.current !== null) window.clearTimeout(transitionDeckStartTimerRef.current)
    transitionDeckStartTimerRef.current = null
    if (visualSwitchTimerRef.current !== null) window.clearTimeout(visualSwitchTimerRef.current)
    visualSwitchTimerRef.current = null
    preloadReadyCleanupRef.current?.()
    preloadReadyCleanupRef.current = null
    if (externalHandoffFadeFrameRef.current !== null) {
      cancelAnimationFrame(externalHandoffFadeFrameRef.current)
      externalHandoffFadeFrameRef.current = null
    }
    seamlessJoinControllerRef.current?.reset()
    if (fallbackAnimationRef.current !== null) cancelAnimationFrame(fallbackAnimationRef.current)
    fallbackAnimationRef.current = null
    if (transitionProgressAnimationRef.current !== null) cancelAnimationFrame(transitionProgressAnimationRef.current)
    transitionProgressAnimationRef.current = null
    transitionStartTimeRef.current = null
    if (retiredDeckCleanupTimerRef.current !== null) window.clearTimeout(retiredDeckCleanupTimerRef.current)
    retiredDeckCleanupTimerRef.current = null
    const active = getActiveAudio()
    const standby = getStandbyAudio()
    setDeckGain(getActiveGain(), active, 1)
    setDeckGain(getStandbyGain(), standby, 0)
    if (standby && !standby.paused) standby.pause()
    transitionPlanRef.current = null
    if (!preserveNext) {
      const abandonedStream = nextMetadataRef.current?.appleHls
      const attachedStream = getActiveAppleStream(standby)
      if (standby) {
        detachAppleHls(standby)
        standby.removeAttribute('src')
        standby.load()
      }
      if (abandonedStream && attachedStream !== abandonedStream) releaseAppleNativeStream(abandonedStream)
      nextMetadataRef.current = null
    }
    if (announceCancellation && transitionStateRef.current !== 'idle' && transitionStateRef.current !== 'playing') {
      setTransitionState('cancelled', { transitioning: false, fallbackReason: reason, transitionStartTime: null })
      setTransitionState(active?.src ? 'playing' : 'idle', { transitioning: false, transitionStartTime: null })
    }
  }, [getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  const runFallbackGainAnimation = useCallback((source: HTMLAudioElement, target: HTMLAudioElement, duration: number, onDone: () => void) => {
    const startedAt = performance.now()
    const animate = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / Math.max(1, duration * 1000))
      source.volume = Math.cos(progress * Math.PI / 2) * volumeRef.current
      target.volume = Math.sin(progress * Math.PI / 2) * volumeRef.current
      if (progress < 1) fallbackAnimationRef.current = requestAnimationFrame(animate)
      else {
        fallbackAnimationRef.current = null
        onDone()
      }
    }
    animate()
  }, [])

  const commitTransition = useCallback((strategy: TransitionStrategy, targetTime: number, executionRevision = transitionExecutionRevisionRef.current) => {
    debugLog('✅ [Transition] commitTransition 被调用')
    debugLog('   策略:', strategy)
    debugLog('   目标时间:', targetTime.toFixed(2), 's')
    debugLog('   执行版本:', executionRevision)
    debugLog('   当前过渡状态:', transitionStateRef.current)
    
    if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
      debugLog('⚠️ [Transition] 执行版本不匹配或状态已变更，跳过提交')
      return
    }
    
    const source = getActiveAudio()
    const target = getStandbyAudio()
    const sourceMetadata = currentMetadataRef.current
    const targetMetadata = nextMetadataRef.current
    if (!target || !targetMetadata) {
      debugLog('❌ [Transition] 缺少目标音频或元数据，取消提交')
      return
    }

    debugLog('🔄 [Transition] 切换音频轨道...')
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
    if (transitionDeckStartTimerRef.current !== null) window.clearTimeout(transitionDeckStartTimerRef.current)
    transitionDeckStartTimerRef.current = null
    
    // 清理过渡进度追踪动画
    if (transitionProgressAnimationRef.current !== null) {
      cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
    }
    transitionStartTimeRef.current = null
    
    // 在 gapless 模式下，source 已经在 startTransition 中被停止了
    // 避免再次调用 load()，这会导致音频上下文短暂中断造成卡顿
    if (strategy !== 'gapless') {
      source?.pause()
      if (source) {
        detachAppleHls(source)
        source.currentTime = 0
        source.removeAttribute('src')
        source.load()
      }
    } else {
      // Gapless 模式需要给解码器留出极短的尾帧时间，再释放已经退出的媒体管线。
      // 定时器使用 deck 身份和 URL 双重校验，避免误清理随后预载到该 deck 的下一首。
      if (source) {
        const retiredSource = source.currentSrc || source.src
        source.currentTime = 0
        if (retiredDeckCleanupTimerRef.current !== null) {
          window.clearTimeout(retiredDeckCleanupTimerRef.current)
        }
        retiredDeckCleanupTimerRef.current = window.setTimeout(() => {
          retiredDeckCleanupTimerRef.current = null
          const stillStandby = getStandbyAudio() === source
          const sourceUnchanged = (source.currentSrc || source.src) === retiredSource
          if (stillStandby && sourceUnchanged && source.paused) {
            detachAppleHls(source)
            source.removeAttribute('src')
            source.load()
          }
        }, 350)
      }
    }
    setDeckGain(getActiveGain(), source, 0)
    setDeckGain(getStandbyGain(), target, 1)
    activePrimaryRef.current = !activePrimaryRef.current
    currentMetadataRef.current = targetMetadata
    nextMetadataRef.current = null
    transitionPlanRef.current = null
    setAudioElement(target)
    debugLog('✅ [Transition] 过渡提交完成，现在播放下一首')
    debugLog('   新的当前歌曲:', targetMetadata.trackKey)
    
    // 构造 TransitionCommit 对象，触发 UI 更新
    const transitionCommit: TransitionCommit = {
      sourceTrackKey: sourceMetadata?.trackKey || '',
      targetTrackKey: targetMetadata.trackKey || '',
      targetIndex: targetMetadata.index,
      targetTime: targetTime,
      strategy: strategy,
      isVisualSwitch: false,
    }
    
    // 使用单次状态更新，避免多次渲染导致的卡顿
    setTransitionState('playing', {
      isPlaying: !target.paused,
      currentTime: target.currentTime,
      duration: target.duration || targetMetadata.duration || 0,
      ended: false,
      transitioning: false,
      transitionCommit: transitionCommit,
      transitionStrategy: strategy,
      transitionStartTime: null,
    })
  }, [getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  const startTransition = useCallback(async (strategy: TransitionStrategy, plan?: TransitionPlan) => {
    debugLog('🚀 [Transition] startTransition 被调用')
    debugLog('   策略:', strategy)
    debugLog('   计划:', plan)
    debugLog('   当前过渡状态:', transitionStateRef.current)
    
    if (transitionStateRef.current === 'running-transition' || transitionStartingRef.current) {
      debugLog('⚠️ [Transition] 已经在进行过渡中，跳过')
      return
    }
    if (watchHoldRef.current) {
      // 看歌挂起：即使已武装的定时器漏网，过渡启动也被拦下（提交=切歌，看歌期间禁止）
      debugLog('⏸ [Transition] 看歌挂起：忽略 startTransition')
      return
    }
    const source = getActiveAudio()
    const target = getStandbyAudio()
    const targetMetadata = nextMetadataRef.current
    
    debugLog('🔍 [Transition] 检查音频元素:')
    debugLog('   source:', source ? '存在' : '不存在')
    debugLog('   target:', target ? '存在' : '不存在')
    debugLog('   target.src:', target?.src || '无')
    debugLog('   targetMetadata:', targetMetadata ? '存在' : '不存在')
    
    if (!source || !target || !target.src || !targetMetadata) {
      debugLog('❌ [Transition] 缺少必要的音频元素或元数据，取消过渡')
      return
    }

    // 音频过渡时长（gapless 为 0，即音频立即切换）
    const audioDuration = strategy === 'gapless' ? 0 : Math.max(0.25,
      plan ? plan.sourceEndTime - plan.sourceStartTime :
      strategy === 'fixed-crossfade' ? crossfadeRef.current.duration :
      4) // 默认 4 秒作为 fallback
    
    // 视觉过渡时长（gapless 模式下仍需要视觉动画）
    const visualDuration = strategy === 'gapless' ? 0.4 : audioDuration
    
    const targetTime = Math.max(0, Math.min(plan?.targetStartTime || 0, Math.max(0, (target.duration || targetMetadata.duration || 0) - 0.1)))

    debugLog('⏱️ [Transition] 过渡参数:')
    debugLog('   音频过渡时长:', audioDuration.toFixed(2), 's')
    debugLog('   视觉过渡时长:', visualDuration.toFixed(2), 's')
    debugLog('   目标开始时间:', targetTime.toFixed(2), 's')

    const executionRevision = ++transitionExecutionRevisionRef.current
    const targetSourceAtStart = target.currentSrc || target.src
    transitionStartingRef.current = true
    const isExecutionCurrent = () => executionRevision === transitionExecutionRevisionRef.current
      && getActiveAudio() === source
      && getStandbyAudio() === target
      && nextMetadataRef.current?.trackKey === targetMetadata.trackKey
    try {
      debugLog('🎨 [Transition] 确保音频图已初始化...')
      await ensureAudioGraph()
      if (!isExecutionCurrent()) return
      

      debugLog('🎵 [Transition] 开始标准交叉淡化过渡')
      target.currentTime = targetTime
      // gapless 也先以 0 增益启动 standby，随后在 gapless 分支做 60ms 淡入，
      // 避免以满音量硬起产生爆音（非 gapless 策略原本就是 0，语义不变）
      setDeckGain(getStandbyGain(), target, 0)
      debugLog('▶️ [Transition] 开始播放下一首歌曲...')
      await target.play()
      if (!isExecutionCurrent()) {
        const targetStillOwnedByOldRequest = getStandbyAudio() === target
          && (target.currentSrc || target.src) === targetSourceAtStart
          && nextMetadataRef.current?.trackKey === targetMetadata.trackKey
        if (targetStillOwnedByOldRequest && !target.paused) target.pause()
        return
      }
      debugLog('✅ [Transition] 下一首歌曲开始播放')
      
      // 开始过渡进度追踪
      const transitionStartTime = performance.now()
      transitionStartTimeRef.current = transitionStartTime
      
      setTransitionState('running-transition', {
        transitioning: true,
        seamlessTransition: true,
        transitionStrategy: strategy,
        fallbackReason: plan?.fallbackReason,
        transitionProgress: 0,
        transitionDuration: visualDuration,
        transitionFromTrackKey: currentMetadataRef.current?.trackKey || '',
        transitionToTrackKey: targetMetadata.trackKey || '',
      })

      // Gapless 模式：音频立即切换，但仍需视觉过渡动画
      if (strategy === 'gapless') {
        debugLog('⚡ [Transition] Gapless 模式：音频已切换，开始视觉过渡动画')
        // BUG-A1：原实现让 target.play() 满音量硬起、source.pause() 立即硬停，
        // 数字硬切落在非零交叉点会产生咔哒/爆音。这里在切换瞬间加入极短（60ms）
        // 等功率淡入淡出：source 淡出 + standby 淡入同时开始，双 deck 短暂同声，
        // 消除爆音且短到人耳听不出任何滞后（逻辑已抽到 gapless/gaplessTransition.ts）。
        runGaplessDeckFade({
          context: audioContextRef.current,
          sourceGain: getActiveGain(),
          targetGain: getStandbyGain(),
          source,
          target,
          isCurrentRevision: () => executionRevision === transitionExecutionRevisionRef.current,
          equalPowerCurve,
          runFallbackFade: runFallbackGainAnimation,
        })
        
        // 启动视觉过渡进度追踪
        let visualSwitchSent = false
        const updateVisualProgress = () => {
          if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
            return
          }
          
          const elapsed = (performance.now() - transitionStartTime) / 1000
          const progress = Math.min(elapsed / visualDuration, 1)
          
          // When progress reaches 90%, send visualSwitchCommit to update UI early
          if (!visualSwitchSent && progress >= 0.9) {
            visualSwitchSent = true
            const visualCommit: TransitionCommit = {
              sourceTrackKey: currentMetadataRef.current?.trackKey || '',
              targetTrackKey: targetMetadata.trackKey || '',
              targetIndex: targetMetadata.index,
              targetTime: targetTime,
              strategy: strategy,
              isVisualSwitch: true,
            }
            emit({
              transitionProgress: progress,
              transitionDuration: visualDuration,
              visualSwitchCommit: visualCommit,
            })
            // 一次性关键事件不节流，但刷新节流基准
            transitionProgressEmitTimeRef.current = performance.now()
          } else {
            const now = performance.now()
            // 30fps 节流：距上次 emit ≥30ms 才 emit；progress 到达 1 强制发最终值
            if (progress >= 1 || now - transitionProgressEmitTimeRef.current >= 30) {
              emit({
                transitionProgress: progress,
                transitionDuration: visualDuration,
              })
              transitionProgressEmitTimeRef.current = now
            }
          }
          
          if (progress < 1) {
            transitionProgressAnimationRef.current = requestAnimationFrame(updateVisualProgress)
          }
        }
        
        transitionProgressAnimationRef.current = requestAnimationFrame(updateVisualProgress)
        
        // 视觉过渡完成后提交
        transitionTimerRef.current = window.setTimeout(() => {
          commitTransition(strategy, targetTime, executionRevision)
        }, visualDuration * 1000)
        
        return
      }
      
      if (audioDuration <= 0.05) {
        debugLog('⚡ [Transition] 过渡时长过短，立即提交')
        commitTransition(strategy, targetTime, executionRevision)
        return
      }
      
      // 启动进度追踪动画
      let visualSwitchSent = false
      const updateTransitionProgress = () => {
        if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
          return
        }
        
        const elapsed = (performance.now() - transitionStartTime) / 1000
        const progress = Math.min(elapsed / audioDuration, 1)
        
        // When progress reaches 90%, send visualSwitchCommit to update UI early
        if (!visualSwitchSent && progress >= 0.9) {
          visualSwitchSent = true
          const visualCommit: TransitionCommit = {
            sourceTrackKey: currentMetadataRef.current?.trackKey || '',
            targetTrackKey: targetMetadata.trackKey || '',
            targetIndex: targetMetadata.index,
            targetTime: targetTime,
            strategy: strategy,
            isVisualSwitch: true,
          }
          emit({
            transitionProgress: progress,
            transitionDuration: audioDuration,
            visualSwitchCommit: visualCommit,
          })
          // 一次性关键事件不节流，但刷新节流基准
          transitionProgressEmitTimeRef.current = performance.now()
        } else {
          const now = performance.now()
          // 30fps 节流：距上次 emit ≥30ms 才 emit；progress 到达 1 强制发最终值
          if (progress >= 1 || now - transitionProgressEmitTimeRef.current >= 30) {
            emit({
              transitionProgress: progress,
              transitionDuration: audioDuration,
            })
            transitionProgressEmitTimeRef.current = now
          }
        }
        
        if (progress < 1) {
          transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
        }
      }
      
      transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)

      const context = audioContextRef.current
      const sourceGain = getActiveGain()
      const targetGain = getStandbyGain()
      if (context && sourceGain && targetGain) {
        debugLog('🎚️ [Transition] 使用 Web Audio API 进行增益曲线过渡')
        const now = context.currentTime
        sourceGain.gain.cancelScheduledValues(now)
        targetGain.gain.cancelScheduledValues(now)
        sourceGain.gain.setValueAtTime(Math.max(0.0001, sourceGain.gain.value), now)
        targetGain.gain.setValueAtTime(0.0001, now)
        sourceGain.gain.setValueCurveAtTime(equalPowerCurve(false), now, audioDuration)
        targetGain.gain.setValueCurveAtTime(equalPowerCurve(true), now, audioDuration)
        
        // 在过渡中点（50%）切换视觉信息
        const midTransitionDelay = (audioDuration * 1000) / 2
        debugLog('⏰ [Transition] 设置视觉切换定时器，', (audioDuration / 2).toFixed(2), '秒后切换显示信息')
        visualSwitchTimerRef.current = window.setTimeout(() => {
          visualSwitchTimerRef.current = null
          if (executionRevision === transitionExecutionRevisionRef.current && transitionStateRef.current === 'running-transition') {
            debugLog('🎨 [Transition] 在过渡中点切换视觉信息到下一首')
            setTransitionState('running-transition', {
              transitioning: true,
              seamlessTransition: true,
              transitionStrategy: strategy,
              fallbackReason: plan?.fallbackReason,
              visualSwitchCommit: {
                sourceTrackKey: currentMetadataRef.current?.trackKey || '',
                targetTrackKey: targetMetadata.trackKey || '',
                targetIndex: targetMetadata.index,
                targetTime: targetTime + (audioDuration / 2),
                strategy,
                isVisualSwitch: true,  // 标记为视觉切换
              },
            })
          }
        }, midTransitionDelay)
        
        debugLog('⏰ [Transition] 设置过渡完成定时器，', audioDuration.toFixed(2), '秒后提交')
        transitionTimerRef.current = window.setTimeout(() => commitTransition(strategy, targetTime + audioDuration, executionRevision), audioDuration * 1000)
      } else {
        debugLog('🎚️ [Transition] Web Audio API 不可用，使用回退动画')
        runFallbackGainAnimation(source, target, audioDuration, () => commitTransition(strategy, targetTime + audioDuration, executionRevision))
      }
    } catch (error) {
      if (!isExecutionCurrent()) return
      console.error('❌ [Transition] 过渡失败:', error)
      target.pause()
      if (nextMetadataRef.current?.trackKey === targetMetadata.trackKey) {
        detachAppleHls(target)
        nextMetadataRef.current = null
      }
      setDeckGain(getStandbyGain(), target, 0)
      setDeckGain(getActiveGain(), source, 1)
      setTransitionState('failed', {
        transitioning: false,
        transitionStrategy: strategy,
        fallbackReason: error instanceof Error ? error.message : 'next deck failed to start',
      })
    } finally {
      if (executionRevision === transitionExecutionRevisionRef.current) {
        transitionStartingRef.current = false
      }
    }
  }, [commitTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, runFallbackGainAnimation, setDeckGain, setTransitionState])

  const prepareAutoMix = useCallback(async () => {
    // 看歌挂起（见 setWatchHold）：看歌期间引擎时间线静止，任何自动过渡的“准备→提交”
    // 都不允许发生——否则已武装的过渡会在看歌期间照常 commit → 切回时已经是下一首
    //（用户实测：Shelter 进看歌约 1.8s 后自动切到下一曲）
    if (watchHoldRef.current) {
      debugLog('⏸ [AutoMix] 看歌挂起：跳过 prepareAutoMix')
      return
    }
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    const pairStrategy = resolvePairTransitionStrategy(current, next, {
      autoMix: autoMixRef.current.enabled,
      crossfade: crossfadeRef.current.enabled,
      gapless: gaplessRef.current.enabled,
    })
    if (pairStrategy === 'gapless' && (current?.appleHls || next?.appleHls)) {
      preparationRevisionRef.current += 1
      preparationAbortRef.current?.abort()
      preparationAbortRef.current = null
      autoMixPreparationKeyRef.current = null
      transitionPlanRef.current = null
      debugLog('🍎 [AutoMix] Apple CENC 相邻边降级为 Gapless，不执行离线分析或渲染')
      setTransitionState('armed', {
        transitioning: false,
        transitionStrategy: 'gapless',
        fallbackReason: 'Apple CENC pair uses gapless',
        transitionStartTime: current?.duration || null,
      })
      return
    }
    
    debugLog('🔍 [AutoMix] prepareAutoMix 被调用')
    debugLog('🔍 [AutoMix] autoMix 设置:', autoMixRef.current)
    debugLog('🔍 [AutoMix] 当前歌曲:', current)
    debugLog('🔍 [AutoMix] 下一首歌曲:', next)

    const settings = autoMixRef.current
    const callerStack = new Error().stack?.split('\n').slice(2, 5).map(l => l.trim().replace(/^at /, '').split(' ')[0]).join('|') || '?'
    logAutomixBackend('prepareAutoMix:entry', [
      `enabled=${settings.enabled}`,
      `enhanced=${settings.enhanced === true}`,
      `aiMix=${settings.aiMix === true}`,
      `intensity=${settings.intensity ?? 'standard'}`,
      `beatMatching=${settings.enableBeatMatching}`,
      `current=${String(current?.trackKey || '').slice(0, 40)}`,
      `next=${String(next?.trackKey || '').slice(0, 40)}`,
      `caller=${callerStack}`,
    ].join(' '))

    if (!autoMixRef.current.enabled) {
      debugLog('⚠️ [AutoMix] 智能混音功能未启用，退出')
      logAutomixBackend('prepareAutoMix:exit', 'automix 未启用')
      return
    }
    
    if (!current?.url || !current.trackKey) {
      debugLog('⚠️ [AutoMix] 当前歌曲信息不完整，退出')
      logAutomixBackend('prepareAutoMix:exit', '当前歌曲信息不完整')
      return
    }
    
    if (!next?.url || !next.trackKey) {
      debugLog('⚠️ [AutoMix] 下一首歌曲信息不完整，退出')
      logAutomixBackend('prepareAutoMix:exit', '下一首歌曲信息不完整')
      return
    }
    const preparationKey = [
      current.trackKey,
      next.trackKey,
      current.url,
      next.url,
      settings.enableBeatMatching,
      settings.skipSilence,
      settings.minDuration,
      settings.maxDuration,
      settings.enhanced === true,
      settings.intensity,
      settings.aiMix === true,
    ].join(':')
    if (autoMixPreparationKeyRef.current === preparationKey) {
      debugLog('⏭️ [AutoMix] 相同歌曲组合正在准备，跳过重复分析')
      return
    }
    if (autoMixPreparedOkRef.current.has(preparationKey) && transitionPlanRef.current) {
      debugLog('⏭️ [AutoMix] 相同歌曲组合已准备且计划仍有效，跳过重复分析')
      return
    }
    // REPREPARE 节流：失败后冷却期内不重复尝试（worker 冷启动窗口）；同一组合最多重试 1 次
    const previousAttempts = autoMixPreparationAttemptsRef.current.get(preparationKey)
    if (previousAttempts
      && (previousAttempts.attempts >= AUTO_MIX_MAX_PREPARE_ATTEMPTS
        || Date.now() - previousAttempts.lastAt < AUTO_MIX_REPREPARE_COOLDOWN_MS)) {
      debugLog(`⏭️ [AutoMix] 组合此前已失败 ${previousAttempts.attempts} 次，冷却/上限期内不重试`)
      return
    }
    autoMixPreparationKeyRef.current = preparationKey
    
    debugLog('✅ [AutoMix] 开始准备智能混音过渡')
    const revision = ++preparationRevisionRef.current
    preparationAbortRef.current?.abort()
    const controller = new AbortController()
    preparationAbortRef.current = controller
    // REPREPARE 记录器：失败尝试入账 + 定时重试（revision 过期即静默放弃）
    const recordFailureAndScheduleRetry = (reason: string) => {
      const attempts = (autoMixPreparationAttemptsRef.current.get(preparationKey)?.attempts ?? 0) + 1
      autoMixPreparationAttemptsRef.current.set(preparationKey, { attempts, lastAt: Date.now() })
      autoMixPreparedOkRef.current.delete(preparationKey)
      autoMixPreparationKeyRef.current = null
      logAutomixBackend('prepareAutoMix:reprepare', `attempts=${attempts} reason=${reason}`)
      if (attempts < AUTO_MIX_MAX_PREPARE_ATTEMPTS && autoMixPrepareRetryTimerRef.current === null) {
        const revisionAtFailure = revision
        autoMixPrepareRetryTimerRef.current = window.setTimeout(() => {
          autoMixPrepareRetryTimerRef.current = null
          if (revisionAtFailure !== preparationRevisionRef.current) return
          debugLog('🔁 [AutoMix] REPREPARE：定时重试准备过渡')
          prepareAutoMixRef.current()
        }, AUTO_MIX_REPREPARE_DELAY_MS)
      }
    }
    // 统一的 fallback 计划构造（格式预检拦截与准备失败共用；4 秒固定交叉安全网）
    const buildFallbackCrossfadePlan = (reason: string): TransitionPlan => {
      const active = getActiveAudio()
      const fallbackDuration = 4 // 固定 4 秒作为 fallback
      // trackKey 已由函数入口 guard 收窄（!current?.url || !current.trackKey 即 return）
      const sourceTrackKey = current.trackKey!
      const targetTrackKey = next.trackKey!
      return {
        id: `${sourceTrackKey}->${targetTrackKey}:fallback`,
        sourceTrackKey,
        targetTrackKey,
        sourceStartTime: Math.max(0, (active?.duration || current.duration || 0) - fallbackDuration),
        sourceEndTime: active?.duration || current.duration || 0,
        targetStartTime: 0,
        targetEndTime: fallbackDuration,
        beatCount: 0,
        sourceBpm: 120,
        targetBpm: 120,
        tempoRamp: [],
        sourceDownbeatIndex: 0,
        targetDownbeatIndex: 0,
        gainCurve: { source: [], target: [] },
        confidence: 0,
        strategy: 'fixed-crossfade',
        fallbackReason: reason,
        analysisVersion: 'unavailable',
        rendererVersion: 'browser-crossfade-v1',
      }
    }
    setTransitionState('preparing-next', { transitioning: false, fallbackReason: undefined, transitionStartTime: null })
    acceptanceAutoMixAnalysisStartsRef.current += 1
    try {
      debugLog('🎵 [AutoMix] 开始分析歌曲节拍和 BPM...')
      const [sourceAnalysis, targetAnalysis] = await Promise.all([
        current.analysis || autoMixAnalysisService.analyze({ trackKey: current.trackKey, url: current.url, duration: current.duration, signal: controller.signal }),
        next.analysis || autoMixAnalysisService.analyze({ trackKey: next.trackKey, url: next.url, duration: next.duration, signal: controller.signal }),
      ])
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      
      // 检查分析结果是否有效
      if (!sourceAnalysis || !targetAnalysis) {
        console.error('❌ [AutoMix] 分析结果无效，使用回退方案')
        debugLog('   sourceAnalysis:', sourceAnalysis)
        debugLog('   targetAnalysis:', targetAnalysis)
        throw new Error('Analysis failed: invalid results')
      }
      
      debugLog('✅ [AutoMix] 歌曲分析完成:')
      debugLog('   当前歌曲 BPM:', sourceAnalysis.estimatedBpm, 'provider:', sourceAnalysis.provider)
      debugLog('   下一首 BPM:', targetAnalysis.estimatedBpm, 'provider:', targetAnalysis.provider)
      
      current.analysis = sourceAnalysis
      next.analysis = targetAnalysis

      // ③ 格式/一致性预检：provider/时长/声道 sanity——拦截即提前武装固定交叉（确定性，不重试）
      const compatibilityIssue = describeTransitionCompatibilityIssue(sourceAnalysis, targetAnalysis, current, next)
      if (compatibilityIssue) {
        transitionPlanRef.current = buildFallbackCrossfadePlan(compatibilityIssue)
        const blockedPlan = transitionPlanRef.current
        console.warn(`⛔ [AutoMix] 格式预检拦截，降级固定交叉：${compatibilityIssue}`)
        logAutomixBackend('prepareAutoMix:compat-block', compatibilityIssue)
        const blockedAnimationStart = Math.max(blockedPlan.sourceStartTime, blockedPlan.sourceEndTime - ANIMATION_LEAD_SECONDS)
        setTransitionState('armed', {
          transitionStrategy: 'fixed-crossfade',
          fallbackReason: blockedPlan.fallbackReason,
          transitionStartTime: blockedAnimationStart,
          transitionDebug: buildTransitionDebug(blockedPlan, 'fallback'),
        })
        autoMixPreparedOkRef.current.add(preparationKey)
        autoMixPreparationAttemptsRef.current.delete(preparationKey)
        return
      }

      // 智能渲染（smart-rendered*）路径已移除：计划层恒产出 Fixed Crossfade，
      // 这里只做计划生成，不再触发 TransitionRenderer / Python 渲染。
      const plan = planTransition(sourceAnalysis, targetAnalysis, {
        beatMatching: autoMixRef.current.enableBeatMatching,
        skipSilence: autoMixRef.current.skipSilence,
        minDuration: autoMixRef.current.minDuration,
        maxDuration: autoMixRef.current.maxDuration,
      })

      debugLog('📋 [AutoMix] 过渡计划生成:')
      debugLog('   计划ID:', plan.id)
      debugLog('   策略:', plan.strategy)
      debugLog('   置信度:', plan.confidence)
      debugLog('   过渡开始时间:', plan.sourceStartTime, 's')
      debugLog('   过渡结束时间:', plan.sourceEndTime, 's')
      debugLog('   节拍数:', plan.beatCount)

      debugLog('🎯 [AutoMix] 最终过渡策略:', plan.strategy)
      if (plan.fallbackReason) {
        debugLog('   回退原因:', plan.fallbackReason)
      }
      if (plan.strategy === 'fixed-crossfade' && plan.fallbackReason) {
        console.warn(`[AutoMix] 本次过渡为 ${plan.strategy}：${plan.fallbackReason}`)
      }
      logAutomixBackend('prepareAutoMix:plan', [
        `strategy=${plan.strategy}`,
        `fallback=${plan.fallbackReason ?? 'none'}`,
        `confidence=${plan.confidence.toFixed(3)}`,
        `bpm=${plan.sourceBpm}->${plan.targetBpm}`,
        `beatCount=${plan.beatCount}`,
        `analysis=${sourceAnalysis.provider}->${targetAnalysis.provider}`,
      ].join(' '))

      transitionPlanRef.current = plan
      // 过渡动画时机独立于音频过渡，最多提前 ANIMATION_LEAD_SECONDS 进入；
      // 音频触发仍由 handleTimeUpdate 按 sourceStartTime 决定。
      const animationStartTime = Math.max(plan.sourceStartTime, plan.sourceEndTime - ANIMATION_LEAD_SECONDS)
      setTransitionState('armed', {
        transitionStrategy: plan.strategy,
        fallbackReason: plan.fallbackReason,
        transitioning: false,
        transitionStartTime: animationStartTime,
        // armed 即下发过渡轨道 key：MV 背景预载提前到准备阶段，
        // 否则短过渡（DSP 8~12s）预载时间不足 → commit 时未就绪 → 封面重载数秒
        transitionFromTrackKey: current.trackKey,
        transitionToTrackKey: next.trackKey,
        transitionDebug: buildTransitionDebug(plan, 'v1', sourceAnalysis, targetAnalysis),
      })
      // 确定性计划（Fixed Crossfade）：本组合不再重试
      autoMixPreparedOkRef.current.add(preparationKey)
      autoMixPreparationAttemptsRef.current.delete(preparationKey)
      debugLog('✅ [AutoMix] 过渡已准备就绪（armed），等待播放到过渡点...')
    } catch (error) {
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      console.error('❌ [AutoMix] 准备过渡失败:', error)
      // REPREPARE：分析/准备失败入账并定时重试一次；fallback plan 照常武装（安全网）
      const failureReason = error instanceof Error ? error.message : 'analysis failed'
      recordFailureAndScheduleRetry(failureReason)
      transitionPlanRef.current = buildFallbackCrossfadePlan(failureReason)
      debugLog('🔄 [AutoMix] 使用回退方案: fixed-crossfade')
      logAutomixBackend('prepareAutoMix:fallback', transitionPlanRef.current.fallbackReason ?? 'analysis failed')
      const fallbackPlan = transitionPlanRef.current
      const fallbackAnimationStart = Math.max(fallbackPlan.sourceStartTime, fallbackPlan.sourceEndTime - ANIMATION_LEAD_SECONDS)
      setTransitionState('armed', {
        transitionStrategy: 'fixed-crossfade',
        fallbackReason: fallbackPlan.fallbackReason,
        transitionStartTime: fallbackAnimationStart,
        transitionDebug: buildTransitionDebug(fallbackPlan, 'fallback'),
      })
    }
  }, [getActiveAudio, setTransitionState])
  // REPREPARE 定时器通过 ref 调用最新渲染的 prepareAutoMix（避免 useCallback 自引用）
  prepareAutoMixRef.current = prepareAutoMix

  const prepareGaplessTransition = useCallback(async () => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    if (current?.appleHls || next?.appleHls) {
      transitionPlanRef.current = null
      debugLog('🍎 [Gapless] Apple CENC 相邻边使用 managed 双 deck 无缝衔接')
      setTransitionState('armed', {
        transitionStrategy: 'gapless',
        fallbackReason: undefined,
        transitioning: false,
        transitionStartTime: current?.duration || null,
      })
      return
    }
    
    debugLog('[Gapless] prepareGaplessTransition 被调用')
    debugLog('[Gapless] 当前歌曲:', current)
    debugLog('[Gapless] 下一首歌曲:', next)
    
    if (!gaplessRef.current.enabled || !gaplessIntegrationRef.current) {
      debugLog('[Gapless] 无缝衔接未启用或未初始化')
      return
    }
    
    if (!current?.url || !current.trackKey) {
      debugLog('[Gapless] 当前歌曲信息不完整')
      return
    }
    
    if (!next?.url || !next.trackKey) {
      debugLog('[Gapless] 下一首歌曲信息不完整')
      return
    }
    
    setTransitionState('preparing-next', { transitioning: false, fallbackReason: undefined, transitionStartTime: null })
    
    try {
      const result = await gaplessIntegrationRef.current.prepareTransition({
        token: Date.now(),
        currentIndex: current.index || 0,
        nextIndex: next.index || 1,
        currentSong: {
          key: current.trackKey,
          url: current.url,
          duration: current.duration || 0,
          albumId: current.albumId,
          album: current.albumCover,
        },
        nextSong: {
          key: next.trackKey,
          url: next.url,
          duration: next.duration || 0,
          albumId: next.albumId,
          album: next.albumCover,
        },
      })
      
      if (result.success) {
        debugLog(`[Gapless] 过渡准备成功，模式: ${result.mode}`)
        setTransitionState('armed', {
          transitionStrategy: 'gapless',
          fallbackReason: undefined,
          transitioning: false,
          transitionStartTime: Math.max(0, (current.duration || 0) - (result.mode === 'album-gapless' ? 1.8 : 0)),
        })
      } else {
        debugLog('[Gapless] 当前歌曲不使用专辑融合，使用普通 gapless')
        setTransitionState('armed', {
          transitionStrategy: 'gapless',
          fallbackReason: undefined,
          transitioning: false,
          transitionStartTime: current.duration || null,
        })
      }
    } catch (error) {
      console.error('[Gapless] 准备过渡失败:', error)
      setTransitionState('armed', {
        transitionStrategy: 'gapless',
        fallbackReason: error instanceof Error ? error.message : 'preparation failed',
        transitioning: false,
        transitionStartTime: current.duration || null,
      })
    }
  }, [setTransitionState])

  useEffect(() => {
    const primary = new Audio()
    const secondary = new Audio()
    for (const audio of [primary, secondary]) {
      audio.crossOrigin = 'anonymous'
      audio.preload = 'auto'
      audio.volume = 0
    }
    primary.volume = volumeRef.current
    primaryRef.current = primary
    secondaryRef.current = secondary
    setAudioElement(primary)
    
    // 初始化 Gapless Integration
    gaplessIntegrationRef.current = new GaplessIntegration({
      enabled: gaplessSettings.enabled,
      albumGaplessEnabled: gaplessSettings.albumGapless,
      getCurrentAudio: getActiveAudio,
      getCurrentTime: () => getActiveAudio()?.currentTime || 0,
      getCurrentIndex: () => currentMetadataRef.current?.index || 0,
      getCurrentTrackKey: () => currentMetadataRef.current?.trackKey || '',
      getTargetVolume: () => volumeRef.current,
      setOutputGain: (gain) => {
        if (masterGainRef.current) {
          masterGainRef.current.gain.value = gain
        }
      },
      getOutputGain: () => masterGainRef.current?.gain.value || volumeRef.current,
      getPlayQueue: () => {
        const current = currentMetadataRef.current
        const next = nextMetadataRef.current
        const queue: DeckMetadata[] = []
        if (current && Number.isInteger(current.index) && current.index! >= 0) queue[current.index!] = current
        if (next && Number.isInteger(next.index) && next.index! >= 0) queue[next.index!] = next
        return queue
      },
      canAdvance: (index) => {
        const current = currentMetadataRef.current
        const next = nextMetadataRef.current
        return Boolean(current && next && current.index === index && next.url && next.trackKey)
      },
      playAt: async (index: number, options: any) => {
        // 调用外部传入的 playAt 回调
        if (playAtCallbackRef.current) {
          return await playAtCallbackRef.current(index, options)
        }
        return false
      },
      prepareAudioUrl: async (song) => {
        try {
          const prepared = await window.electron?.audioDownload?.prepare?.(song.url, song.key)
          if (!prepared) return song.url
          return await window.electron?.audioDownload?.getMediaUrl?.(prepared) || song.url
        } catch {
          return song.url
        }
      },
      onStateChange: state => {
        const { transitionState, ...extra } = state
        if (transitionState) setTransitionState(transitionState, extra)
        else emit(extra)
      },
      // 专辑融合确定性裁剪：复用 AutoMix 分析缓存的首尾静音边界（无缓存时 albumGapless 维持探测路径）
      getTrackAnalysis: key => autoMixAnalysisService.peekSilenceBounds(key),
    })

    // 首选预热/边界调度/ended 拼接逻辑已抽离到 src/services/gapless/seamlessJoinController.ts
    // （createSeamlessJoinController），本 effect 只负责创建控制器并接线。
    seamlessJoinControllerRef.current = createSeamlessJoinController({
      getActiveAudio,
      getStandbyAudio,
      getStandbyGain,
      setDeckGain,
      isGaplessEnabled: () => resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      }) === 'gapless',
      isTransitionRunning: () => transitionStateRef.current === 'running-transition',
      hasActiveTransition: () => Boolean(gaplessIntegrationRef.current?.hasActiveTransition()),
      getRevision: () => transitionExecutionRevisionRef.current,
      commitTransition,
      startGaplessTransition: () => void startTransition('gapless'),
      resetGaplessIntegration: () => gaplessIntegrationRef.current?.reset(),
      setTransitionState: (state, extra) => setTransitionState(state, (extra ?? {}) as never),
      setBoundaryTimer: (timer) => { transitionTimerRef.current = timer },
      getBoundaryTimer: () => transitionTimerRef.current,
    })

    const handleTimeUpdate = (event: Event) => {
      const active = getActiveAudio()
      if (event.currentTarget !== active || !active) return
      const remaining = (active.duration || 0) - active.currentTime
      const standby = getStandbyAudio()
      const plan = transitionPlanRef.current
      // 专辑播放检测（三方案分流依据）——同专辑时即使 AutoMix 启用也优先走首尾拼接，
      // AutoMix 过渡（timeupdate 触发与预分析）只接管非专辑场景。
      const albumPlayback = isAlbumPlayback()
      const pairStrategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      })
      const applePair = Boolean(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)
      if (standby?.src && transitionStateRef.current !== 'running-transition') {
        if (pairStrategy === 'automix' && !albumPlayback && plan && (transitionStateRef.current === 'armed' || transitionStateRef.current === 'playing')) {
          if (active.currentTime >= plan.sourceStartTime) {
            debugLog('🎬 [AutoMix] 到达过渡点！')
            debugLog('   当前时间:', active.currentTime.toFixed(2), 's')
            debugLog('   过渡开始时间:', plan.sourceStartTime.toFixed(2), 's')
            debugLog('   过渡策略:', plan.strategy)
            debugLog('   过渡状态:', transitionStateRef.current)
            void startTransition(plan.strategy, plan)
          }
        } else if (pairStrategy === 'fixed-crossfade' && remaining <= Math.max(0.25, crossfadeRef.current.duration)) {
          debugLog('🎬 [Crossfade] 到达交叉淡化点，剩余时间:', remaining.toFixed(2), 's')
          void startTransition('fixed-crossfade')
        } else if (pairStrategy === 'gapless' && Number.isFinite(remaining)) {
          // Gapless 三方案分流已抽离到 src/services/gapless/seamlessJoinController.ts：
          //   remaining ∈ (1, 20] 且专辑 → 预热缓存前 10s（保证首选拼接就绪）
          //   remaining ∈ (0, 1]     → scheduleBoundary（首选直接拼接 / 备选 60ms 淡入淡出）
          // 控制器内部自带 hasActiveTransition / boundaryScheduled 互斥检查。
          const controller = seamlessJoinControllerRef.current
          if (controller) {
            if (remaining > 1 && remaining <= GAPLESS_SEAMLESS_WARMUP_SECONDS && albumPlayback && !applePair) {
              controller.warmup()
            } else if (remaining > 0 && remaining <= 1) {
              controller.scheduleBoundary({ active, remaining, albumPlayback: albumPlayback && !applePair })
            }
          }
        }
      }
      let buffered = 0
      if (active.buffered.length) buffered = active.buffered.end(active.buffered.length - 1)
      // 过渡期间（running-transition）：源曲 deck 静音但继续播放，其 timeupdate 位置
      // 与 rAF 合成时间（过渡缓冲驱动）是两个来源，交替 emit 会让进度/倒计时数字
      // 来回抽动（如 2:35→2:36 时 565 闪）。过渡时间线统一由 rAF 合成时间驱动。
      if (transitionStateRef.current === 'running-transition') {
        return
      }
      // 量化播放时间到 ~250ms，避免高频 timeupdate 触发多个大组件重渲染；
      // 进度条/歌词内部已有各自的平滑插值，视觉无变化。
      const quantizedTime = Math.round(active.currentTime * 4) / 4
      emit({ currentTime: quantizedTime, duration: finiteDuration(active.duration), buffered, live: isLiveRef.current })
    }

    const handlePlay = (event: Event) => {
      if (event.currentTarget !== getActiveAudio()) return
      emit({ isPlaying: true, ended: false })
    }
    const handlePause = (event: Event) => {
      if (
        event.currentTarget === getActiveAudio()
        && transitionStateRef.current !== 'committed'
        && transitionStateRef.current !== 'running-transition'
      ) {
        const active = getActiveAudio()
        emit({
          isPlaying: false,
          currentTime: active?.currentTime || 0,
          duration: finiteDuration(active?.duration),
        })
      }
    }
    const handleMetadata = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) emit({ duration: finiteDuration(getActiveAudio()?.duration), live: isLiveRef.current })
    }
    const handleEnded = (event: Event) => {
      debugLog('🏁 [Event] handleEnded 被触发')
      debugLog('   当前加载状态:', isLoadingRef.current)
      debugLog('   事件目标是活动音频?', event.currentTarget === getActiveAudio())
      
      if (isLoadingRef.current || event.currentTarget !== getActiveAudio()) return

      // 首选：已武装的 managed 双 deck（含 Apple CENC standby）在边界接管；
      // 若 Apple standby 未就绪/失败，则落到末尾的 ended=true，由 App 走完整加载回退链。

      // A timer normally performs the boundary handoff. If `ended` wins the race, cancel the
      // timer and execute immediately so a delayed callback cannot start the same deck twice.
      // （边界 timer 与竞态互斥由 seamlessJoinController 管理）
      seamlessJoinControllerRef.current?.cancelBoundaryTimer()

      const standby = getStandbyAudio()
      debugLog('🔍 [Event] 检查过渡状态:', transitionStateRef.current)
      debugLog('   待机音频:', standby ? '存在' : '不存在')
      debugLog('   待机音频暂停?', standby?.paused)
      debugLog('   待机音频 src:', standby?.src || '无')

      // ── 首选：无缝拼接（头尾都不掐）──
      // source 已完整播到 ended。standby 可能处于三种就绪形态：PREROLL 静音预启动中、
      // 预热完成后暂停回拨 0、或已缓冲暂停。控制器统一"确保 standby 从头播放"：
      // 未在播则启动（0 位置已缓冲 → 快），回拨 0 后瞬时切换增益——
      // 不做任何淡入淡出、不掐 source 尾部、不跳过 standby 开头。
      if (seamlessJoinControllerRef.current?.onEnded(standby)) return

      if (transitionStateRef.current === 'running-transition' && standby && !standby.paused) {
        debugLog('✅ [Event] 过渡正在进行中，提交过渡')
        const strategy = transitionPlanRef.current?.strategy || (crossfadeRef.current.enabled ? 'fixed-crossfade' : 'gapless')
        commitTransition(strategy, standby.currentTime, transitionExecutionRevisionRef.current)
      } else if (standby?.src && resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      }) === 'gapless') {
        debugLog('⏭️ [Event] 待机音频就绪且当前相邻边使用 Gapless')
        const applePair = Boolean(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)
        if (gaplessIntegrationRef.current && !applePair) {
          // 使用 Album Gapless 执行过渡
          const result = gaplessIntegrationRef.current.executeTransition()
          if (result.success) {
            debugLog(`[Gapless] 使用 ${result.mode} 模式执行过渡`)
            // 如果成功执行了无缝，这里不要再调用 startTransition，避免双音轨同时播放
          } else {
            debugLog('[Gapless] 使用简单模式执行过渡')
            void startTransition('gapless')
          }
        } else {
          void startTransition('gapless')
        }
      } else {
        debugLog('⏸️ [Event] 无过渡计划，歌曲结束')
        setTransitionState('idle', { isPlaying: false, ended: true, seamlessTransition: false, transitioning: false })
      }
    }
    const handleError = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) {
        setTransitionState('failed', { isPlaying: false, fallbackReason: getActiveAudio()?.error?.message || 'media decode failed' })
      }
    }

    for (const audio of [primary, secondary]) {
      audio.addEventListener('timeupdate', handleTimeUpdate)
      audio.addEventListener('play', handlePlay)
      audio.addEventListener('playing', handlePlay)
      audio.addEventListener('pause', handlePause)
      audio.addEventListener('loadedmetadata', handleMetadata)
      audio.addEventListener('ended', handleEnded)
      audio.addEventListener('error', handleError)
    }

    return () => {
      preparationAbortRef.current?.abort()
      cancelScheduledTransition('audio player unmounted', false, false)
      // 卸载时销毁可能挂载的 Apple HLS 实例，释放 MSE 与 EME 会话
      detachAppleHls(primary)
      detachAppleHls(secondary)
      if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
      if (visualSwitchTimerRef.current !== null) window.clearTimeout(visualSwitchTimerRef.current)
      preloadReadyCleanupRef.current?.()
      preloadReadyCleanupRef.current = null
      currentLoadRevisionRef.current += 1
      currentLoadWaitCancelRef.current?.()
      currentLoadWaitCancelRef.current = null
      seamlessJoinControllerRef.current?.reset()
      if (fallbackAnimationRef.current !== null) cancelAnimationFrame(fallbackAnimationRef.current)
      if (transitionProgressAnimationRef.current !== null) cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
      if (externalHandoffFadeFrameRef.current !== null) {
        cancelAnimationFrame(externalHandoffFadeFrameRef.current)
        externalHandoffFadeFrameRef.current = null
      }
      transitionStartTimeRef.current = null
      if (retiredDeckCleanupTimerRef.current !== null) window.clearTimeout(retiredDeckCleanupTimerRef.current)
      retiredDeckCleanupTimerRef.current = null
      gaplessIntegrationRef.current?.dispose()
      gaplessIntegrationRef.current = null
      for (const audio of [primary, secondary]) {
        audio.removeEventListener('timeupdate', handleTimeUpdate)
        audio.removeEventListener('play', handlePlay)
        audio.removeEventListener('playing', handlePlay)
        audio.removeEventListener('pause', handlePause)
        audio.removeEventListener('loadedmetadata', handleMetadata)
        audio.removeEventListener('ended', handleEnded)
        audio.removeEventListener('error', handleError)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      void audioContextRef.current?.close()
      audioContextRef.current = null
      analyserNodeRef.current = null
      gainNodesRef.current = [null, null]
      masterGainRef.current = null
    }
  }, [commitTransition, emit, getActiveAudio, getActiveGain, getStandbyAudio, setDeckGain, setTransitionState, startTransition, finiteDuration])

  useEffect(() => {
    if (gaplessIntegrationRef.current) {
      gaplessIntegrationRef.current.updateSettings({
        enabled: gaplessSettings.enabled,
        albumGapless: gaplessSettings.albumGapless,
      })
    }
  }, [gaplessSettings.enabled, gaplessSettings.albumGapless])

  useEffect(() => {
    if (!nextMetadataRef.current?.url) return
    cancelScheduledTransition('transition settings changed')
    const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
      autoMix: autoMixSettings.enabled,
      crossfade: crossfadeSettings.enabled,
      gapless: gaplessSettings.enabled,
    })
    if (strategy === 'automix') {
      void prepareAutoMix()
      return
    }
    if (strategy === 'gapless' && !(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) {
      void prepareGaplessTransition()
      return
    }
    setTransitionState('armed', {
      transitioning: false,
      fallbackReason: strategy === 'gapless' && autoMixSettings.enabled ? 'Apple CENC pair uses gapless' : undefined,
      transitionStrategy: strategy,
    })
  }, [
    autoMixSettings.enabled,
    autoMixSettings.enableBeatMatching,
    autoMixSettings.skipSilence,
    autoMixSettings.minDuration,
    autoMixSettings.maxDuration,
    autoMixSettings.enhanced,
    autoMixSettings.intensity,
    autoMixSettings.aiMix,
    crossfadeSettings.enabled,
    crossfadeSettings.duration,
    gaplessSettings.enabled,
    gaplessSettings.albumGapless,
    cancelScheduledTransition,
    prepareAutoMix,
    setTransitionState,
  ])

  const preloadNext = useCallback((input: string | PreloadTrack) => {
    const track = asPreloadTrack(input)
    debugLog('📥 [Preload] preloadNext 被调用')
    debugLog('   下一首歌曲:', track)
    const standby = getStandbyAudio()
    if (!standby || !track.url) {
      debugLog('❌ [Preload] 缺少待机音频元素或 URL')
      releaseAppleNativeStream(track.appleHls)
      return
    }
    const appleHls = track.appleHls
    const hlsPreload = Boolean(appleHls) && isHlsUrl(track.url) && !appleHls?.live
    if (isHlsUrl(track.url) && !hlsPreload) {
      debugLog('🛑 [Preload] 非预载型 HLS 音源跳过待机预载')
      releaseAppleNativeStream(appleHls)
      return
    }
    const existingNext = nextMetadataRef.current
    const sameTrackAlreadyAttached = Boolean(
      existingNext
      && existingNext.url === track.url
      && existingNext.trackKey === track.trackKey
      && existingNext.index === track.index
      && (hlsPreload
        ? getActiveAppleStream(standby) === appleHls
        : Boolean((standby.currentSrc || standby.getAttribute('src'))
          && standby.networkState !== HTMLMediaElement.NETWORK_EMPTY
          && !standby.error))
    )
    if (sameTrackAlreadyAttached) {
      // Queue-related effects can run more than once for the same next track. Keep the
      // existing media pipeline and any in-flight canplay/AutoMix preparation intact.
      nextMetadataRef.current = { ...existingNext, ...track }
      debugLog('♻️ [Preload] 下一首未变化，复用现有待机媒体管线')
      return
    }

    cancelScheduledTransition('next track changed', true)
    const previousStream = nextMetadataRef.current?.appleHls
    const attachedPreviousStream = getActiveAppleStream(standby)
    detachAppleHls(standby)
    if (previousStream && previousStream !== attachedPreviousStream) releaseAppleNativeStream(previousStream)
    nextMetadataRef.current = { ...track }
    standby.pause()
    standby.currentTime = 0
    standby.playbackRate = 1 // post-settle 残留防护：新歌一律原速
    setDeckGain(getStandbyGain(), standby, 0)
    debugLog('⏳ [Preload] 开始加载下一首歌曲...')
    setTransitionState('preparing-next', { transitioning: false, transitionStartTime: null })
    const preloadMetadataMatches = () => Boolean(
      nextMetadataRef.current?.url === track.url
      && nextMetadataRef.current?.trackKey === track.trackKey
      && nextMetadataRef.current?.index === track.index
    )
    const isCurrentPreload = () => Boolean(
      preloadMetadataMatches()
      && (!hlsPreload || getActiveAppleStream(standby) === appleHls)
    )
    let timeoutId = 0
    const cleanupReady = () => {
      standby.removeEventListener('canplay', ready)
      standby.removeEventListener('error', failed)
      if (timeoutId) window.clearTimeout(timeoutId)
    }
    const ready = () => {
      cleanupReady()
      if (preloadReadyCleanupRef.current === cleanupReady) preloadReadyCleanupRef.current = null
      if (!isCurrentPreload()) return
      track.onPreloadSettled?.(true)
      debugLog('🎵 [Preload] 预加载歌曲就绪')
      const pairStrategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      })
      if (pairStrategy === 'automix') {
        if (!isAlbumPlayback()) {
          debugLog('🎵 [Preload] AutoMix 已启用，调用 prepareAutoMix()')
          void prepareAutoMix()
        } else {
          debugLog('🎵 [Preload] 同专辑 + AutoMix：走首尾拼接无缝方案')
          setTransitionState('armed', { transitionStrategy: 'gapless' })
        }
      } else if (pairStrategy === 'gapless') {
        if (currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls) {
          debugLog('🍎 [Preload] Apple 相邻边已武装 managed Gapless')
          setTransitionState('armed', {
            transitionStrategy: 'gapless',
            fallbackReason: autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
          })
        } else if (gaplessIntegrationRef.current) {
          debugLog('🎵 [Preload] 准备无缝衔接，调用 GaplessIntegration')
          void prepareGaplessTransition()
        }
      } else {
        setTransitionState('armed', { transitionStrategy: pairStrategy })
      }
    }
    const failed = () => {
      cleanupReady()
      if (preloadReadyCleanupRef.current === cleanupReady) preloadReadyCleanupRef.current = null
      if (!preloadMetadataMatches()) return
      track.onPreloadSettled?.(false)
      console.warn('[Preload] Next track media failed to load or timed out; normal end-of-track loading will be used')
      const failedStream = nextMetadataRef.current?.appleHls
      cancelScheduledTransition('next Apple HLS failed', false, false)
      releaseAppleNativeStream(failedStream)
      const active = getActiveAudio()
      setDeckGain(getActiveGain(), active, 1)
      setTransitionState(active?.src ? 'playing' : 'idle', {
        transitioning: false,
        transitionStartTime: null,
        fallbackReason: 'next track preload failed',
      })
    }
    preloadReadyCleanupRef.current?.()
    preloadReadyCleanupRef.current = cleanupReady
    if (hlsPreload) {
      void attachAppleHls(standby, appleHls!, () => {
        if (!preloadMetadataMatches()) return
        failed()
      }).then(ready, failed)
    } else {
      standby.src = track.appleHls ? track.url : getProxiedAudioUrl(track.url)
      standby.preload = 'auto'
      standby.addEventListener('canplay', ready, { once: true })
      standby.addEventListener('error', failed, { once: true })
      timeoutId = window.setTimeout(failed, PRELOAD_MEDIA_LOAD_TIMEOUT_MS)
      standby.load()
    }
  }, [cancelScheduledTransition, getActiveAudio, getStandbyAudio, getStandbyGain, prepareAutoMix, prepareGaplessTransition, setDeckGain, setTransitionState])

  const loadAndPlay = useCallback(async (
    url: string,
    startVolume = DEFAULT_VOLUME,
    track?: Omit<PreloadTrack, 'url'>
  ) => {
    debugLog('🎵 [LoadAndPlay] loadAndPlay 被调用')
    debugLog('   URL:', url)
    debugLog('   音量:', startVolume)
    debugLog('   歌曲信息:', track)
    const loadRevision = ++currentLoadRevisionRef.current
    currentLoadWaitCancelRef.current?.()
    currentLoadWaitCancelRef.current = null
    
    const active = getActiveAudio()
    const standby = getStandbyAudio()
    if (!active) throw new Error('Audio deck is not initialized')
    isLoadingRef.current = true
    cancelScheduledTransition('new current track loaded', false)
    setTransitionState('loading-current', { currentTime: 0, duration: 0, ended: false, transitioning: false, transitionStartTime: null })
    volumeRef.current = Math.max(0, Math.min(1, startVolume))
    try {
      // 停止所有音频
      if (standby && !standby.paused) {
        debugLog('⏸️ [LoadAndPlay] 停止 standby 音频')
        standby.pause()
        standby.currentTime = 0
      }
      standby?.pause()
      active.pause()
      active.currentTime = 0
      // 先显式卸载旧资源。仅覆盖 src 会让 Chromium 的旧媒体管线等待 GC，
      // 快速切歌时会形成明显的阶梯式内存增长。
      detachAppleHls(active) // 若上一首是 Apple HLS，先销毁其 MSE 管线
      active.removeAttribute('src')
      active.load()
      // 重置 GaplessIntegration，停止所有预加载的音频
      if (gaplessIntegrationRef.current) {
        debugLog('🧹 [LoadAndPlay] 重置 GaplessIntegration')
        gaplessIntegrationRef.current.reset()
      }
      const appleHls = (track as { appleHls?: import('../services/applePlayback').AppleNativeStream } | undefined)?.appleHls
      const hlsMode = Boolean(appleHls) && isHlsUrl(url)
      // 直播流（Apple 电台）：HLS 时长为 Infinity（liveDurationInfinity），
      // 记录到 ref 供 timeupdate/metadata 输出 live 状态与 0 时长（UI 显示直播态）
      isLiveRef.current = Boolean(appleHls?.live)
      active.playbackRate = 1 // post-settle 残留防护：新歌一律原速
      currentMetadataRef.current = { url, ...track }
      setAudioElement(active)
      await ensureAudioGraph()
      if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.setValueAtTime(volumeRef.current, audioContextRef.current.currentTime)
      }
      setDeckGain(getActiveGain(), active, 1)
      setDeckGain(getStandbyGain(), standby, 0)
      if (hlsMode) {
        // Apple Music 原生 HLS（Widevine EME）：hls.js 接管 src 与缓冲，
        // attachAppleHls 自行等待首个分片就绪（含 license 协商），随后照常 play()
        debugLog('📡 [LoadAndPlay] Apple HLS 原生音源，由 hls.js 接管')
        await attachAppleHls(active, appleHls!, error => {
          if (getActiveAudio() !== active || currentMetadataRef.current?.appleHls !== appleHls) return
          console.warn('[AppleHLS] Current stream failed after startup:', error)
          cancelScheduledTransition('current Apple HLS failed', false, false)
          setTransitionState('failed', {
            isPlaying: false,
            ended: true,
            transitioning: false,
            fallbackReason: error.message,
          })
        })
      } else {
        debugLog('⏳ [LoadAndPlay] 加载音频文件...')
        active.src = url
        active.preload = 'auto'
        await new Promise<void>((resolve, reject) => {
          let settled = false
          let timeoutId = 0
          const cleanup = () => {
            active.removeEventListener('canplay', canPlay)
            active.removeEventListener('error', failed)
            if (timeoutId) window.clearTimeout(timeoutId)
            if (currentLoadWaitCancelRef.current === cancelled) currentLoadWaitCancelRef.current = null
          }
          const settle = (callback: () => void) => {
            if (settled) return
            settled = true
            cleanup()
            callback()
          }
          const canPlay = () => settle(resolve)
          const failed = () => settle(() => reject(active.error || new Error('media load failed')))
          const cancelled = () => settle(resolve)
          currentLoadWaitCancelRef.current = cancelled
          active.addEventListener('canplay', canPlay, { once: true })
          active.addEventListener('error', failed, { once: true })
          timeoutId = window.setTimeout(
            () => settle(() => reject(new Error('media load timed out'))),
            CURRENT_MEDIA_LOAD_TIMEOUT_MS,
          )
          active.load()
        })
      }
      if (loadRevision !== currentLoadRevisionRef.current) {
        if (appleHls && getActiveAppleStream(active) === appleHls) detachAppleHls(active)
        return false
      }
      debugLog('▶️ [LoadAndPlay] 开始播放...')
      await active.play()
      if (loadRevision !== currentLoadRevisionRef.current) {
        if (appleHls && getActiveAppleStream(active) === appleHls) detachAppleHls(active)
        return false
      }
      isLoadingRef.current = false
      debugLog('✅ [LoadAndPlay] 播放成功')
      setTransitionState('playing', { isPlaying: true, duration: finiteDuration(active.duration) || track?.duration || 0, ended: false, live: isLiveRef.current })
      // 基础交叉"入"半边（Apple 淡出尾的自然衔接）：上一首 Apple 歌曲带淡出尾结束、
      // 下一首走本地 deck 时，deck 增益从 0 线性渐起到目标音量（EME 下无重叠交叉，顺序淡入淡出）
      if (externalEndedWithFadeRef.current) {
        externalEndedWithFadeRef.current = false
        const fadeDur = externalFadeDuration()
        const context = audioContextRef.current
        const gain = getActiveGain()
        if (fadeDur > 0 && context && gain) {
          const t0 = context.currentTime
          try {
            gain.gain.cancelScheduledValues(t0)
            gain.gain.setValueAtTime(0.0001, t0)
            gain.gain.linearRampToValueAtTime(Math.max(0.0001, volumeRef.current), t0 + fadeDur)
            debugLog(`🎚️ [LoadAndPlay] 淡入头 ${fadeDur}s（衔接上一首 Apple 淡出尾）`)
          } catch { /* 增益自动化失败则按原音量起播 */ }
        }
      }
      
      // Prepare the next edge without changing the user's global mode. Apple CENC pairs
      // downgrade AutoMix to managed gapless; non-Apple pairs keep the full analysis path.
      if (nextMetadataRef.current?.url) {
        const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
          autoMix: autoMixRef.current.enabled,
          crossfade: crossfadeRef.current.enabled,
          gapless: gaplessRef.current.enabled,
        })
        if (strategy === 'automix' && !isAlbumPlayback()) {
          debugLog('🎵 [LoadAndPlay] 检测到下一首歌曲且 AutoMix 已启用，调用 prepareAutoMix()')
          void prepareAutoMix()
        } else if (strategy === 'gapless' && (currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) {
          setTransitionState('armed', {
            transitionStrategy: 'gapless',
            fallbackReason: autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
          })
        }
      } else {
        debugLog('⏭️ [LoadAndPlay] 下一首: 不存在')
      }
      return true
    } catch (error) {
      if (loadRevision !== currentLoadRevisionRef.current) return false
      const err = error instanceof Error ? error : null
      detachAppleHls(active)
      // 用户在加载/播放中暂停会中止在途的 play()（媒体元素以 AbortError 拒绝）——
      // 这是正常打断，只清 loading 标志，静默返回 false（暂停状态已由 togglePlay 发布）。
      // NotAllowedError 表示浏览器/用户手势策略阻止了播放，歌曲实际不会出声，是真实失败：
      // 不能静默，必须走失败路径（App 会提示 + 重试一次），否则播放器卡在 loading 态无反馈。
      if (err && err.name === 'AbortError') {
        isLoadingRef.current = false
        return false
      }
      console.error('❌ [LoadAndPlay] 播放失败:', error)
      isLoadingRef.current = false
      setTransitionState('failed', { isPlaying: false, fallbackReason: err ? err.message : 'playback failed' })
      throw error
    }
  }, [cancelScheduledTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState, prepareAutoMix, finiteDuration])

  // ── 外部播放源开关（由 App.loadAndPlaySong 在 WebView2 播放成功/切歌时调用）──
  /** 基础交叉淡化时长（外部源专用）：固定淡入淡出/无缝衔接/AutoMix 任一启用即生效，
   *  统一走 MusicKit 音量斜坡（EME 限制下无法采样级拼接，音量交叉是唯一可行路径）；
   *  三模式全关 → 0（按设置硬切）。固定淡入淡出档用其时长，其余用 6s 缺省。 */
  const externalFadeDuration = useCallback(() => {
    if (!crossfadeRef.current.enabled && !gaplessRef.current.enabled && !autoMixRef.current.enabled) return 0
    const d = crossfadeRef.current.enabled ? Number(crossfadeRef.current.duration) || 0 : 6
    return Math.min(12, Math.max(2, d))
  }, [])

  const enableExternalPlayback = useCallback(({ duration }: { duration?: number } = {}) => {
    externalDurationRef.current = duration && duration > 0 ? duration : 0
    externalEndedFiredRef.current = false
    externalFadeActiveRef.current = false
    if (externalActiveRef.current) return
    externalActiveRef.current = true
    // 本地 deck 若有声先停掉（外部源模式下 deck 无 src，这里只是保险）
    try {
      cancelScheduledTransition('switch to external playback source')
      const active = getActiveAudio()
      if (active && !active.paused) active.pause()
    } catch { /* 忽略 */ }
    // 淡入头：上一首 Apple 歌曲带淡出尾自然结束 → 本首从 0 渐起
    const fadeIn = externalEndedWithFadeRef.current ? externalFadeDuration() : 0
    externalEndedWithFadeRef.current = false
    if (fadeIn > 0) {
      void bridgeVolume(0)
      void bridgeFade(volumeRef.current, fadeIn * 1000)
    } else {
      // 音量推给播放面（MusicKit 音量独立于本地增益链）
      void bridgeVolume(volumeRef.current)
    }
    // 乐观首发，随后由 bridge 轮询回填（200ms 轮询 + 播放面 0.3s 采样）
    emit({ currentTime: 0, duration: finiteDuration(externalDurationRef.current), isPlaying: true, live: false })
    externalUnsubscribeRef.current = onBridgeStateChange((s) => {
      if (!externalActiveRef.current || !s.ready) return
      const duration = s.duration > 0 ? s.duration : externalDurationRef.current
      emit({
        currentTime: s.position,
        duration: finiteDuration(duration),
        // 缓冲/seek 等瞬态（loading=1 seeking=6 waiting=8）按「播放中」呈现，
        // 避免 UI 播放按钮在起播/拖动后 1 秒闪回暂停态
        isPlaying: s.playing || [1, 6, 8].includes(Number(s.status)),
        live: false,
      })
      if (s.playing) externalEndedFiredRef.current = false
      // 基础交叉"出"半边：进入结尾淡出窗口 → MusicKit 音量线性降到 0
      const fadeDur = externalFadeDuration()
      const inTail = fadeDur > 0 && s.duration > fadeDur + 1 && s.position >= s.duration - fadeDur
      if (inTail && !externalFadeActiveRef.current) {
        externalFadeActiveRef.current = true
        const remaining = Math.max(0.5, s.duration - s.position)
        void bridgeFade(0, remaining * 1000)
      } else if (!inTail && externalFadeActiveRef.current) {
        // seek 回退离开淡出窗口：恢复音量（重新进窗口会再次触发）
        externalFadeActiveRef.current = false
        void bridgeVolume(volumeRef.current)
      }
      // 歌曲结束：与 Apple HLS ended 语义一致（置 idle 交上层切歌/单曲循环）
      if (!externalEndedFiredRef.current && s.duration > 0 && (s.ended || s.position >= s.duration - 0.5)) {
        externalEndedFiredRef.current = true
        // 带淡出尾自然结束 → 记录标记，下一首（Apple 播放面或本地 deck）做淡入头
        externalEndedWithFadeRef.current = externalFadeActiveRef.current
        setTransitionState('idle', { isPlaying: false, ended: true, transitioning: false, seamlessTransition: false })
      }
    })
  }, [cancelScheduledTransition, emit, externalFadeDuration, finiteDuration, getActiveAudio, setTransitionState])

  const disableExternalPlayback = useCallback(() => {
    if (!externalActiveRef.current) return
    externalActiveRef.current = false
    try { externalUnsubscribeRef.current?.() } catch { /* 忽略 */ }
    externalUnsubscribeRef.current = null
    externalEndedFiredRef.current = false
    externalFadeActiveRef.current = false
    emit({ live: false })
    // 注意：externalEndedWithFadeRef 不清——供 loadAndPlay/enable 做淡入头
    // 停掉播放面声音（best-effort；切到非 Apple 歌时避免 WebView2 继续出声）
    void bridgeStopPlayback()
  }, [])

  const togglePlay = useCallback(async () => {
    // 外部播放源（WebView2 播放面）：控制转发 bridge，本地无媒体
    if (externalActiveRef.current) {
      if (getBridgeState().playing) {
        emit({ isPlaying: false })
        // 暂停时若在淡出尾：取消斜坡并恢复音量，恢复播放后按剩余时间重新淡出
        if (externalFadeActiveRef.current) {
          externalFadeActiveRef.current = false
          void bridgeVolume(volumeRef.current)
        }
        await bridgePause()
      } else {
        emit({ isPlaying: true })
        externalEndedFiredRef.current = false
        externalFadeActiveRef.current = false // 恢复播放后由轮询按剩余时间重新触发淡出
        await bridgeResume()
      }
      return
    }
    const active = getActiveAudio()
    if (!active?.src) return
    try {
      await ensureAudioGraph()
      if (gaplessIntegrationRef.current?.hasActiveTransition()) {
        cancelScheduledTransition('paused during gapless transition')
        active.pause()
        gaplessIntegrationRef.current.reset()
        emit({ isPlaying: false })
        return
      }
      if (active.paused) {
        await active.play()
        setTransitionState('playing', { isPlaying: true })
        if (nextMetadataRef.current?.url) {
          const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
            autoMix: autoMixRef.current.enabled,
            crossfade: crossfadeRef.current.enabled,
            gapless: gaplessRef.current.enabled,
          })
          if (strategy === 'automix') void prepareAutoMix()
          else if (strategy === 'gapless' && !(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) void prepareGaplessTransition()
          else setTransitionState('armed', {
            isPlaying: true,
            transitionStrategy: strategy,
            fallbackReason: strategy === 'gapless' && autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
          })
        }
      } else {
        cancelScheduledTransition('paused during transition')
        active.pause()
        // 同时暂停 standby 音频
        const standby = getStandbyAudio()
        if (standby && !standby.paused) {
          standby.pause()
        }
        // 重置 GaplessIntegration，停止所有预加载的音频
        if (gaplessIntegrationRef.current) {
          gaplessIntegrationRef.current.reset()
        }
        emit({ isPlaying: false })
        // 暂停完成且已确认无进行中的过渡/无缝混音任务后 suspend 音频上下文（省电）：
        // hasActiveTransition() 已在上方分支早退（有进行中任务不走到这里）；
        // cancelScheduledTransition 已停止 TransitionRenderer 缓冲源、清除边界/预热 timer，
        // 双 deck（active/standby）均已 pause，gaplessIntegration.reset() 已取消 albumGapless 混音
        // 与 preload 媒体——无任何源会继续发声，suspend 不会造成断声/杂音。
        // 吞掉可能抛出的错误（上下文可能已被关闭）。
        if (
          audioContextRef.current
          && audioContextRef.current.state !== 'suspended'
          && audioContextRef.current.state !== 'closed'
        ) {
          void audioContextRef.current.suspend().catch(() => undefined)
        }
      }
    } catch (error) {
      console.error('[PlaybackEngine] play/pause failed', error)
    }
  }, [cancelScheduledTransition, emit, ensureAudioGraph, getActiveAudio, getActiveGain, prepareAutoMix, prepareGaplessTransition, setDeckGain, setTransitionState])

  const seek = useCallback((time: number) => {
    // 外部播放源：转发 bridge，本地无媒体可定位
    if (externalActiveRef.current) {
      const bridgeDuration = getBridgeState().duration || externalDurationRef.current
      const pos = bridgeDuration > 0 ? Math.max(0, Math.min(time, bridgeDuration)) : Math.max(0, time)
      externalEndedFiredRef.current = false
      // seek 撞销在途淡出斜坡并恢复音量（seek 进尾部由轮询按剩余时间重新淡出）
      if (externalFadeActiveRef.current) {
        externalFadeActiveRef.current = false
        void bridgeVolume(volumeRef.current)
      }
      emit({ currentTime: pos, duration: finiteDuration(bridgeDuration) })
      void bridgeSeek(pos)
      return
    }
    const active = getActiveAudio()
    if (!active) return
    const wasPlaying = !active.paused
    cancelScheduledTransition('seek changed transition timing')
    // 元数据未加载（duration 未知）时直接定位，不做 0 上限裁剪，避免拖动归零
    const duration = Number.isFinite(active.duration) && active.duration > 0 ? active.duration : Infinity
    active.currentTime = Math.max(0, Math.min(time, duration))
    // seek 越过已计划的过渡点后，旧计划已不可用（播放过期过渡会卡住/错位）：
    // 清空计划，让 prepareAutoMix 从当前位置重新规划（v1 行为：立刻可从当前进度 automix）。
    const plan = transitionPlanRef.current
    if (plan && active.currentTime >= plan.sourceStartTime) {
      transitionPlanRef.current = null
    }
    emit({ currentTime: active.currentTime, duration: finiteDuration(active.duration), live: isLiveRef.current })
    if (nextMetadataRef.current?.url) {
      const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      })
      if (strategy === 'automix') void prepareAutoMix()
      else if (strategy === 'gapless' && !(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) void prepareGaplessTransition()
      else setTransitionState('armed', {
        transitionStrategy: strategy,
        fallbackReason: strategy === 'gapless' && autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
      })
    } else if (wasPlaying && active.paused) {
      void active.play().catch(() => undefined)
    }
  }, [cancelScheduledTransition, emit, getActiveAudio, getActiveGain, prepareAutoMix, prepareGaplessTransition, setDeckGain, setTransitionState, finiteDuration])

  const setVolume = useCallback((volume: number) => {
    const clamped = Math.max(0, Math.min(1, volume))
    volumeRef.current = clamped
    // 外部播放源：音量作用于 WebView2 播放面
    if (externalActiveRef.current) {
      void bridgeVolume(clamped)
      emit({ volume: clamped })
      // 淡出尾中拖音量会撞销在途斜坡：按剩余时间以新音量为起点重新淡出
      if (externalFadeActiveRef.current) {
        const s = getBridgeState()
        const fadeDur = externalFadeDuration()
        if (fadeDur > 0 && s.duration > fadeDur + 1 && s.position >= s.duration - fadeDur) {
          void bridgeFade(0, Math.max(0.5, s.duration - s.position) * 1000)
        } else {
          externalFadeActiveRef.current = false
        }
      }
      return
    }
    const context = audioContextRef.current
    const master = masterGainRef.current
    if (context && master) {
      master.gain.setValueAtTime(clamped, context.currentTime)
      const active = getActiveAudio()
      if (active) active.volume = 1
    } else {
      const active = getActiveAudio()
      if (active) active.volume = clamped
    }
    emit({ volume: clamped })
  }, [emit, getActiveAudio])

  const setPlayAtCallback = useCallback((callback: (index: number, options: any) => Promise<boolean>) => {
    playAtCallbackRef.current = callback
  }, [])

  const resetGaplessIntegration = useCallback(() => {
    if (gaplessIntegrationRef.current) {
      debugLog('[Gapless] 重置 GaplessIntegration')
      gaplessIntegrationRef.current.reset()
    }
  }, [])

  const adoptExternalAudio = useCallback(async (externalAudio: HTMLAudioElement, metadata: DeckMetadata) => {
    debugLog('[AdoptAudio] 接管外部音频元素')
    debugLog('   URL:', metadata.url)
    debugLog('   当前时间:', externalAudio.currentTime.toFixed(2))
    debugLog('   是否暂停:', externalAudio.paused)

    const active = getActiveAudio()
    const target = getStandbyAudio()
    if (!active || !target) throw new Error('Audio deck is not initialized')
    const initialResumeTime = Math.max(0, externalAudio.currentTime || 0)

    isLoadingRef.current = false
    cancelScheduledTransition('external audio adopted', true, false)
    // Keep the already-audible transition deck alive until the managed deck
    // has started at the same position, otherwise handoff creates a gap.
    gaplessIntegrationRef.current?.reset(externalAudio)

    try {
      // Move playback back onto a managed deck so pause, seek and ended events
      // keep controlling the same audio after the seamless handoff.
      active.pause()
      // BUG-A3：AlbumGapless 混音完成时会把 masterGain 归零（albumGapless.ts
      // runBalancedCrossfade 的 finish 分支）。若下面因 standby src 不匹配进入
      // canplay 等待，等待期间整条托管链路就会静音，严重时达数秒。进入等待前
      // 先把 masterGain 恢复到目标音量，确保等 canplay 期间始终有声。
      if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.setValueAtTime(volumeRef.current, audioContextRef.current.currentTime)
      }
      if (target.src !== metadata.url) {
        target.src = metadata.url
        target.preload = 'auto'
        target.load()
        await new Promise<void>((resolve, reject) => {
          const ready = () => { cleanup(); resolve() }
          const failed = () => { cleanup(); reject(target.error || new Error('media load failed')) }
          const cleanup = () => {
            target.removeEventListener('canplay', ready)
            target.removeEventListener('error', failed)
            if (timeoutId !== null) window.clearTimeout(timeoutId)
          }
          // 无缝接管时 CDN 卡住/加载被新播放打断可能永远不触发 canplay → 超时放弃并回退普通加载
          let timeoutId: number | null = window.setTimeout(() => {
            timeoutId = null
            cleanup()
            reject(new Error('adopt external audio timed out'))
          }, 12000)
          target.addEventListener('canplay', ready, { once: true })
          target.addEventListener('error', failed, { once: true })
        })
      }

      const getLiveHandoffTime = () => {
        const liveExternalTime = Math.max(initialResumeTime, externalAudio.currentTime || 0)
        const latestAllowedTime = Math.max(0, (target.duration || metadata.duration || liveExternalTime + 0.1) - 0.1)
        return Math.min(liveExternalTime, latestAllowedTime)
      }

      setDeckGain(getActiveGain(), active, 0)
      setDeckGain(getStandbyGain(), target, 0)
      target.currentTime = getLiveHandoffTime()
      await target.play()

      // The external deck keeps advancing while the managed deck starts. Align
      // again after play() resolves so the handoff does not replay or skip the
      // last decoder frames at the exact moment the visual transition ends.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const liveHandoffTime = getLiveHandoffTime()
        if (Math.abs(target.currentTime - liveHandoffTime) <= EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS) break
        target.currentTime = liveHandoffTime
        await waitForSeek(target)
      }

      const standbyGain = getStandbyGain()
      const context = audioContextRef.current
      const externalStartVolume = externalAudio.muted ? 0 : externalAudio.volume
      if (standbyGain && context) {
        standbyGain.gain.cancelScheduledValues(context.currentTime)
      }

      // BUG-A4：external deck（AlbumGapless/Cuefield 的 preload.media）与 managed
      // standby deck 会短暂同声——这个重叠能消除元素级硬切爆音，予以保留，但两侧
      // 淡入淡出必须由同一帧驱动同步，否则音量曲线帧级错位会产生可闻的增益抖动/
      // 混叠。播放位置已由上面的 waitForSeek 对齐循环保证（EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS）。
      await new Promise<void>(resolve => {
        const startedAt = performance.now()
        const tick = () => {
          const progress = Math.min(1, (performance.now() - startedAt) / EXTERNAL_HANDOFF_FADE_MS)
          externalAudio.volume = externalStartVolume * Math.cos(progress * Math.PI / 2)
          if (standbyGain && context) {
            standbyGain.gain.setValueAtTime(Math.sin(progress * Math.PI / 2), context.currentTime)
          } else {
            target.volume = Math.sin(progress * Math.PI / 2) * volumeRef.current
          }

          if (progress < 1) {
            // 帧 id 存入 ref：卸载/取消路径据此 cancelAnimationFrame，避免自循环 rAF 泄漏
            externalHandoffFadeFrameRef.current = requestAnimationFrame(tick)
          } else {
            externalHandoffFadeFrameRef.current = null
            resolve()
          }
        }
        tick()
      })

      setDeckGain(standbyGain, target, 1)

      externalAudio.pause()
      externalAudio.removeAttribute('src')
      externalAudio.load()
      active.currentTime = 0
      active.removeAttribute('src')
      active.load()
      activePrimaryRef.current = !activePrimaryRef.current
      currentMetadataRef.current = { ...metadata }
      nextMetadataRef.current = null
      setAudioElement(target)

      setTransitionState('committed', {
        isPlaying: true,
        currentTime: target.currentTime,
        duration: target.duration || metadata.duration || 0,
        ended: false,
        transitioning: false,
        seamlessTransition: true,
        transitionStrategy: 'gapless',
      })
      setTransitionState('playing', {
        isPlaying: true,
        transitioning: false,
        transitionStrategy: 'gapless',
      })

      debugLog('[AdoptAudio] 接管完成，当前播放位置:', target.currentTime.toFixed(2))
      return true
    } catch (error) {
      console.error('[AdoptAudio] 接管失败:', error)
      target.pause()
      setDeckGain(getStandbyGain(), target, 0)
      externalAudio.pause()
      externalAudio.removeAttribute('src')
      externalAudio.load()
      return false
    }
  }, [cancelScheduledTransition, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  return {
    loadAndPlay,
    togglePlay,
    seek,
    setVolume,
    /** WebView2 播放面外部播放源：enable/disable 由 App.loadAndPlaySong 调用 */
    enableExternalPlayback,
    disableExternalPlayback,
    isExternalPlaybackActive: () => externalActiveRef.current,
    preloadNext,
    cancelTransition: cancelScheduledTransition,
    /** 看歌挂起开关：true=引擎进入"看歌时间线"——取消在途过渡且期间禁止 prepare/启动
     *  自动过渡（看歌中歌曲不被 automix 推进）；false=恢复正常（引擎可重新为当前歌准备） */
    setWatchHold: (hold: boolean) => {
      if (hold === watchHoldRef.current) return
      watchHoldRef.current = hold
      if (hold) cancelScheduledTransition('enter watch mode (hold)')
    },
    getAudioElement: getActiveAudio,
    audioElement,
    playbackTimeStore,
    analyserNode,
    nextAudioElement: getStandbyAudio(),
    setPlayAtCallback,
    resetGaplessIntegration,
    adoptExternalAudio,
    getAcceptanceState: () => {
      const active = getActiveAudio()
      const standby = getStandbyAudio()
      return {
        transitionState: transitionStateRef.current,
        activeAppleHls: Boolean(getActiveAppleStream(active)),
        standbyAppleHls: Boolean(getActiveAppleStream(standby)),
        activePaused: active?.paused ?? true,
        standbyPaused: standby?.paused ?? true,
        activeReadyState: active?.readyState ?? 0,
        standbyReadyState: standby?.readyState ?? 0,
        hasCurrentMetadata: Boolean(currentMetadataRef.current),
        hasNextMetadata: Boolean(nextMetadataRef.current),
        autoMixEnabled: autoMixRef.current.enabled,
        resolvedPairStrategy: resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
          autoMix: autoMixRef.current.enabled,
          crossfade: crossfadeRef.current.enabled,
          gapless: gaplessRef.current.enabled,
        }),
        autoMixAnalysisStarts: acceptanceAutoMixAnalysisStartsRef.current,
      }
    },
    resetAcceptanceState: () => {
      acceptanceAutoMixAnalysisStartsRef.current = 0
    },
    runAcceptanceTransition: async () => {
      const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      })
      if (strategy === 'none' || strategy === 'automix') {
        throw new Error(`Acceptance transition is not armed: ${strategy}`)
      }
      await startTransition(strategy)
      return strategy
    },
    releaseAcceptanceDecks: () => {
      cancelScheduledTransition('acceptance cleanup', false)
      const decks = [getActiveAudio(), getStandbyAudio()]
      for (const audio of decks) {
        if (!audio) continue
        audio.pause()
        detachAppleHls(audio)
        audio.removeAttribute('src')
        audio.load()
      }
      currentMetadataRef.current = null
      nextMetadataRef.current = null
    },
  }
}
