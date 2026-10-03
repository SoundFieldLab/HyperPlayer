import { useSyncExternalStore } from 'react'

/**
 * 过渡进度外部 store。
 *
 * 切歌过渡（交叉淡化 8–12s）期间生产者（useAudioPlayer）以 ~30fps 推送 transitionProgress；
 * 若它落在 App 顶层 state 上，6,589 行的 App.tsx 会在整个过渡期间每帧重渲染。
 * 因此原始进度与其派生值都放在这里，消费方用**标量选择器**订阅
 * （useSyncExternalStore + Object.is 比较）：布尔值只在真的翻转时让订阅组件重渲染，
 * 逐帧数值只重渲染真正读它的视觉组件，App 自身不再参与逐帧更新。
 *
 * 派生公式（overlayProgress / isVisualTransitioning）全仓只在本文件定义一次，
 * App 与各消费点共用，避免多处实现漂移出不一致的视觉结果。
 */

export interface TransitionProgressSnapshot {
  /** 原始过渡进度 0-1（生产者直发，覆盖整个音频过渡，不限于动画窗口） */
  progress: number
  /** 过渡缓冲时长（秒）：叠加动画窗口按此映射；<= 0 时按 20s 兜底 */
  duration: number
  /** 动画起点（秒，currentTime 口径）；null = 无提前起点（普通交叉淡化/gapless），视为始终在窗口内 */
  startTime: number | null
  /** App 已提交的播放时间（秒）：仅用于动画窗口门控，与 App 的行内派生同源 */
  currentTime: number
  /** 音频是否处于过渡中 */
  isTransitioning: boolean
  /** 是否存在过渡目标曲（App 的 transitionToTrack 是否为真） */
  hasToTrack: boolean
  /** 叠加动画进度：只在过渡最后 ~4 秒推进（封面/歌名/MV/流光共用） */
  overlayProgress: number
  /** 视觉过渡中：各视觉组件据此切换过渡呈现 */
  isVisualTransitioning: boolean
}

/** publish 的输入：派生值由 publish 内部算，不接受外部传入 */
export type TransitionProgressUpdate = Partial<Pick<
  TransitionProgressSnapshot,
  'progress' | 'duration' | 'startTime' | 'currentTime' | 'isTransitioning' | 'hasToTrack'
>>

export interface TransitionProgressStore {
  getSnapshot: () => TransitionProgressSnapshot
  subscribe: (listener: () => void) => () => void
  publish: (state: TransitionProgressUpdate) => void
}

type TransitionVisualInput = Pick<
  TransitionProgressSnapshot,
  'progress' | 'duration' | 'startTime' | 'currentTime' | 'isTransitioning' | 'hasToTrack'
>

/**
 * 由过渡状态算视觉派生值（全仓唯一定义）。
 *
 * 动画窗口：过渡动画（卡片/流光/交叉淡化）只在 currentTime 到达 startTime
 * （=动画起点，最多提前 10s）后才开始——AI 长混音的音频过渡远早于动画点开始，
 * 不加门控视觉会跟着 60s 混音全程走；startTime 为 null（普通交叉淡化/gapless）
 * 视为始终在窗口内，保持 v1 行为不变。
 *
 * 叠加动画只在过渡最后 ~4 秒完成（用户要求：叠加 4 秒足够，太长拖沓），
 * 倒计时/流光仍按动画窗口全程提前出现（isVisualTransitioning 的第一个条件）。
 */
export function deriveTransitionVisuals(state: TransitionVisualInput): {
  overlayProgress: number
  isVisualTransitioning: boolean
} {
  const inAnimationWindow = state.startTime === null || state.currentTime >= state.startTime
  const overlayProgress = (() => {
    if (!inAnimationWindow) return 0
    const dur = state.duration > 0 ? state.duration : 20
    const span = Math.min(4, dur)
    const start = 1 - span / dur
    return Math.max(0, Math.min(1, (state.progress - start) / (span / dur)))
  })()
  const isVisualTransitioning = (state.isTransitioning && inAnimationWindow)
    || Boolean(state.hasToTrack && overlayProgress > 0 && inAnimationWindow)
  return { overlayProgress, isVisualTransitioning }
}

export function createTransitionProgressStore(initial: TransitionProgressUpdate = {}): TransitionProgressStore {
  const base: TransitionVisualInput = {
    progress: initial.progress ?? 0,
    duration: initial.duration ?? 0,
    startTime: initial.startTime !== undefined ? initial.startTime : null,
    currentTime: initial.currentTime ?? 0,
    isTransitioning: initial.isTransitioning ?? false,
    hasToTrack: initial.hasToTrack ?? false,
  }
  let snapshot: TransitionProgressSnapshot = { ...base, ...deriveTransitionVisuals(base) }
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (state) => {
      const next: TransitionVisualInput = {
        progress: state.progress ?? snapshot.progress,
        duration: state.duration ?? snapshot.duration,
        // startTime 的 null 是有效值（无提前起点），不能用 ?? 兜底
        startTime: state.startTime !== undefined ? state.startTime : snapshot.startTime,
        currentTime: state.currentTime ?? snapshot.currentTime,
        isTransitioning: state.isTransitioning ?? snapshot.isTransitioning,
        hasToTrack: state.hasToTrack ?? snapshot.hasToTrack,
      }
      const visuals = deriveTransitionVisuals(next)

      // 任一字段（含派生值）未变就不通知：标量选择器的消费者依赖这条保证不空转重渲染
      if (
        next.progress === snapshot.progress
        && next.duration === snapshot.duration
        && next.startTime === snapshot.startTime
        && next.currentTime === snapshot.currentTime
        && next.isTransitioning === snapshot.isTransitioning
        && next.hasToTrack === snapshot.hasToTrack
        && visuals.overlayProgress === snapshot.overlayProgress
        && visuals.isVisualTransitioning === snapshot.isVisualTransitioning
      ) return

      snapshot = { ...next, ...visuals }
      listeners.forEach(listener => listener())
    },
  }
}

/** 全应用单例：生产者（App 的过渡状态回调）publish，视觉组件订阅 */
export const transitionProgressStore = createTransitionProgressStore()

// 模块级选择器：身份稳定（useSyncExternalStore 每次渲染都会调用它，不应新建闭包），
// 返回标量 → React 用 Object.is 比较，值没变就不重渲染订阅组件。
const selectTransitionProgress = () => transitionProgressStore.getSnapshot().progress
const selectOverlayProgress = () => transitionProgressStore.getSnapshot().overlayProgress
const selectIsVisualTransitioning = () => transitionProgressStore.getSnapshot().isVisualTransitioning

/** 原始过渡进度 0-1（含动画窗口之外的音频过渡全程）：交叉淡化背景等按原始进度叠加 */
export function useTransitionProgress(): number {
  return useSyncExternalStore(transitionProgressStore.subscribe, selectTransitionProgress, selectTransitionProgress)
}

/** 叠加动画进度（过渡最后 ~4 秒推进）：封面/歌名/MV/流光的叠加透明度 */
export function useTransitionOverlayProgress(): number {
  return useSyncExternalStore(transitionProgressStore.subscribe, selectOverlayProgress, selectOverlayProgress)
}

/** 是否处于视觉过渡（布尔选择器：只在真的翻转时才让订阅组件重渲染） */
export function useIsVisualTransitioning(): boolean {
  return useSyncExternalStore(transitionProgressStore.subscribe, selectIsVisualTransitioning, selectIsVisualTransitioning)
}
