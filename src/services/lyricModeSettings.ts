/**
 * 歌词模式偏好（当前模式 + 可见模式集合）的**唯一读写规则**。
 *
 * 这条链原先散在 `App.tsx` 与 `QuickSettings.tsx`：
 *   - 当前模式在两处各写一遍合法性校验与默认值；
 *   - `App.tsx` 的切换逻辑把同一段「setState + localStorage + 派发事件」
 *     抄了三遍（看歌进入 / 看歌退出 / 普通模式）；
 *   - 可见模式的一次性迁移（补回看歌、PV）只在读取函数里，
 *     且只在「已有历史值」时执行——新用户隐藏看歌后重载会被迁移逻辑重新加回来；
 *   - 可见性规则（不能隐藏当前模式、现代模式、最后一个可见模式）只存在于 App 内部。
 *
 * 做法：把「校验 / 默认值 / 历史迁移 / 可见性约束 / 事件 / 快照 / 订阅」收进这里。
 * `App.tsx` 与 `QuickSettings.tsx` 只负责呈现与各自模式切换的播放副作用。
 * 键名与事件名是历史值，**勿改**（改名会丢用户设置并中断外部监听）。
 */

export type LyricDisplayMode = 'modern' | 'immersive' | 'video' | 'pv'

export const ALL_LYRIC_MODES = ['modern', 'immersive', 'video', 'pv'] as const

export const LYRIC_MODE_NAMES: Record<LyricDisplayMode, string> = {
  modern: '现代',
  immersive: '沉浸式',
  video: '看歌',
  pv: 'PV',
}

/** localStorage 键（**历史裸键，勿改**）。 */
export const LYRIC_MODE_KEYS = {
  displayMode: 'lyricDisplayMode',
  visibleModes: 'hyperplayer_visible_lyric_modes',
  videoMigrated: 'hyperplayer_video_mode_migrated',
  pvMigrated: 'hyperplayer_pv_mode_migrated',
} as const

/** 事件名（`lyricDisplayModeChanged` 的 detail 携带目标模式）。 */
export const LYRIC_MODE_EVENTS = {
  displayMode: 'lyricDisplayModeChanged',
  visibleModes: 'hyperplayer-lyric-modes-visibility-changed',
} as const

export function isLyricDisplayMode(value: unknown): value is LyricDisplayMode {
  return typeof value === 'string' && (ALL_LYRIC_MODES as readonly string[]).includes(value)
}

/** 本模块需要的宿主能力，便于在 node 环境测试。 */
export interface LyricModeEvent {
  name: string
  detail?: LyricDisplayMode
}

export interface LyricModeHost {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  dispatchEvent(name: string, detail?: LyricDisplayMode): void
  subscribe?(listener: (event?: LyricModeEvent) => void): () => void
}

const defaultHost: LyricModeHost = {
  getItem: (key) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
  setItem: (key, value) => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  },
  dispatchEvent: (name, detail) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }))
  },
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => {}
    const forward = (event: Event) => listener({
      name: event.type,
      detail: (event as CustomEvent<LyricDisplayMode>).detail,
    })
    window.addEventListener(LYRIC_MODE_EVENTS.displayMode, forward)
    window.addEventListener(LYRIC_MODE_EVENTS.visibleModes, forward)
    return () => {
      window.removeEventListener(LYRIC_MODE_EVENTS.displayMode, forward)
      window.removeEventListener(LYRIC_MODE_EVENTS.visibleModes, forward)
    }
  },
}

const writeBestEffort = (host: LyricModeHost, key: string, value: string) => {
  try {
    host.setItem(key, value)
  } catch (error) {
    console.warn('保存歌词模式设置失败:', error)
  }
}

/** 过滤非法值、去重，并保证现代模式存在且排在首位。 */
export function normalizeVisibleLyricModes(value: unknown): LyricDisplayMode[] {
  const input = Array.isArray(value) ? value : []
  const modes: LyricDisplayMode[] = []
  for (const item of input) {
    if (!isLyricDisplayMode(item) || modes.includes(item)) continue
    modes.push(item)
  }
  return ['modern', ...modes.filter((mode) => mode !== 'modern')]
}

/** 当前正在显示的模式必须始终可渲染（即使它被用户从可见列表里隐藏）。 */
export function withCurrentLyricModeVisible(
  modes: LyricDisplayMode[],
  current: LyricDisplayMode,
): LyricDisplayMode[] {
  const normalized = normalizeVisibleLyricModes(modes)
  const safeCurrent = isLyricDisplayMode(current) ? current : 'modern'
  return normalized.includes(safeCurrent) ? normalized : [...normalized, safeCurrent]
}

/**
 * 一次性迁移：历史设置里没有新加的模式时补回一次。
 * 迁移标记写入后不再补，否则用户主动隐藏的模式每次重载都会复活。
 */
const migrateLegacyMode = (
  host: LyricModeHost,
  modes: LyricDisplayMode[],
  flagKey: string,
  mode: LyricDisplayMode,
): LyricDisplayMode[] => {
  if (host.getItem(flagKey)) return modes
  writeBestEffort(host, flagKey, '1')
  return modes.includes(mode) ? modes : [...modes, mode]
}

/**
 * 读取可见模式集合。
 * 首次读取（无历史值或值损坏）会落库默认集合，并把两个迁移标记一并置位——
 * 这样随后隐藏看歌 / PV 才会真正保持隐藏。
 */
export function readVisibleLyricModes(host: LyricModeHost = defaultHost): LyricDisplayMode[] {
  const raw = host.getItem(LYRIC_MODE_KEYS.visibleModes)
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        let modes = normalizeVisibleLyricModes(parsed)
        modes = migrateLegacyMode(host, modes, LYRIC_MODE_KEYS.videoMigrated, 'video')
        modes = migrateLegacyMode(host, modes, LYRIC_MODE_KEYS.pvMigrated, 'pv')
        if (JSON.stringify(modes) !== JSON.stringify(parsed)) {
          writeBestEffort(host, LYRIC_MODE_KEYS.visibleModes, JSON.stringify(modes))
        }
        return modes
      }
    } catch (error) {
      console.warn('读取歌词模式可见设置失败:', error)
    }
  }

  const defaults = [...ALL_LYRIC_MODES] as LyricDisplayMode[]
  writeBestEffort(host, LYRIC_MODE_KEYS.visibleModes, JSON.stringify(defaults))
  writeBestEffort(host, LYRIC_MODE_KEYS.videoMigrated, '1')
  writeBestEffort(host, LYRIC_MODE_KEYS.pvMigrated, '1')
  return defaults
}

export function readLyricDisplayMode(host: LyricModeHost = defaultHost): LyricDisplayMode {
  const saved = host.getItem(LYRIC_MODE_KEYS.displayMode)
  return isLyricDisplayMode(saved) ? saved : 'modern'
}

export interface LyricModeSettings {
  displayMode: LyricDisplayMode
  visibleModes: LyricDisplayMode[]
}

interface LyricModeStoreState {
  snapshot: LyricModeSettings | null
  subscribers: Set<() => void>
  detach: (() => void) | null
  isCommitting: boolean
}

const stores = new WeakMap<LyricModeHost, LyricModeStoreState>()

const storeFor = (host: LyricModeHost): LyricModeStoreState => {
  let store = stores.get(host)
  if (!store) {
    store = { snapshot: null, subscribers: new Set(), detach: null, isCommitting: false }
    stores.set(host, store)
  }
  return store
}

const sameLyricModeSettings = (a: LyricModeSettings, b: LyricModeSettings): boolean =>
  a.displayMode === b.displayMode
  && a.visibleModes.length === b.visibleModes.length
  && a.visibleModes.every((mode, index) => mode === b.visibleModes[index])

const readLyricModeSettings = (host: LyricModeHost): LyricModeSettings => ({
  displayMode: readLyricDisplayMode(host),
  visibleModes: readVisibleLyricModes(host),
})

/** 当前快照：状态未变时返回同一对象，供 `useSyncExternalStore` 使用。 */
export function getLyricModeSnapshot(host: LyricModeHost = defaultHost): LyricModeSettings {
  const store = storeFor(host)
  if (!store.snapshot) store.snapshot = readLyricModeSettings(host)
  return store.snapshot
}

const notifySubscribers = (host: LyricModeHost) => {
  for (const subscriber of [...storeFor(host).subscribers]) subscriber()
}

const refreshSnapshot = (host: LyricModeHost): boolean => {
  const store = storeFor(host)
  const next = readLyricModeSettings(host)
  if (store.snapshot && sameLyricModeSettings(store.snapshot, next)) return false
  store.snapshot = next
  return true
}

const handleExternalLyricModeEvent = (host: LyricModeHost, event?: LyricModeEvent) => {
  const store = storeFor(host)
  if (store.isCommitting) return
  let changed = refreshSnapshot(host)
  // 事件 detail 是模式契约的一部分：只派发 detail、未先写存储的旧调用方
  // 也应被采纳，并顺手把存储补齐，避免快照与存储分叉。
  if (event?.name === LYRIC_MODE_EVENTS.displayMode && isLyricDisplayMode(event.detail)) {
    const snapshot = store.snapshot
    if (snapshot && snapshot.displayMode !== event.detail) {
      store.snapshot = { ...snapshot, displayMode: event.detail }
      writeBestEffort(host, LYRIC_MODE_KEYS.displayMode, event.detail)
      changed = true
    }
  }
  if (changed) notifySubscribers(host)
}

const attachLyricModeListeners = (host: LyricModeHost) => {
  const store = storeFor(host)
  if (store.detach || !host.subscribe) return
  store.detach = host.subscribe((event) => handleExternalLyricModeEvent(host, event))
}

const detachLyricModeListeners = (host: LyricModeHost) => {
  const store = storeFor(host)
  if (!store.detach) return
  store.detach()
  store.detach = null
}

export function subscribeLyricModeSettings(
  listener: () => void,
  host: LyricModeHost = defaultHost,
): () => void {
  getLyricModeSnapshot(host)
  const store = storeFor(host)
  store.subscribers.add(listener)
  attachLyricModeListeners(host)
  return () => {
    store.subscribers.delete(listener)
    if (store.subscribers.size === 0) detachLyricModeListeners(host)
  }
}

/** 一次逻辑写入：落库、派发旧领域事件，最后只通知一次最终快照。 */
const commit = <T,>(host: LyricModeHost, action: () => T): T => {
  const store = storeFor(host)
  let succeeded = false
  store.isCommitting = true
  try {
    const result = action()
    succeeded = true
    return result
  } finally {
    store.isCommitting = false
    if (succeeded && refreshSnapshot(host)) notifySubscribers(host)
  }
}

/** 切换当前歌词模式；非法值直接忽略（返回 false）。 */
export function commitLyricDisplayMode(
  mode: LyricDisplayMode,
  host: LyricModeHost = defaultHost,
): boolean {
  if (!isLyricDisplayMode(mode)) return false
  commit(host, () => {
    writeBestEffort(host, LYRIC_MODE_KEYS.displayMode, mode)
    host.dispatchEvent(LYRIC_MODE_EVENTS.displayMode, mode)
  })
  return true
}

/**
 * 当前可见性规则下能否隐藏某个模式。
 * 当前模式、现代模式、以及最后一个可见模式不能被隐藏；UI 的禁用态也用这一条规则。
 */
export function canHideLyricMode(
  mode: LyricDisplayMode,
  current: LyricDisplayMode,
  modes: LyricDisplayMode[],
): boolean {
  if (!isLyricDisplayMode(mode) || mode === 'modern') return false
  const safeCurrent = isLyricDisplayMode(current) ? current : 'modern'
  if (mode === safeCurrent) return false
  const effective = withCurrentLyricModeVisible(modes, safeCurrent)
  return effective.includes(mode) ? effective.length > 1 : true
}

/**
 * 切换某个模式的可见性。
 * 返回落库后的集合；被规则拒绝时返回 `null`。
 * 写入基于**存储中的集合**，不会把仅为临时显示而补入的当前模式永久转正。
 */
export function toggleLyricModeVisibility(
  mode: LyricDisplayMode,
  current: LyricDisplayMode,
  host: LyricModeHost = defaultHost,
): LyricDisplayMode[] | null {
  if (!isLyricDisplayMode(mode)) return null
  const stored = getLyricModeSnapshot(host).visibleModes
  const effective = withCurrentLyricModeVisible(stored, current)
  const isVisible = effective.includes(mode)
  if (isVisible && !canHideLyricMode(mode, current, stored)) return null

  const next = isVisible ? stored.filter((item) => item !== mode) : [...stored, mode]
  commit(host, () => {
    writeBestEffort(host, LYRIC_MODE_KEYS.visibleModes, JSON.stringify(next))
    host.dispatchEvent(LYRIC_MODE_EVENTS.visibleModes)
  })
  return next
}
