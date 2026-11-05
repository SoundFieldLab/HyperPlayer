import { parseStoredBoolean } from '../utils/storage'

/**
 * 播放页显示偏好 module。
 *
 * 这组历史裸键原先在 `App.tsx` / `SettingsPanel.tsx` / `QuickSettings.tsx` /
 * `globalSettingsRegistry.ts` 各自初始化、钳制、派事件；同一开关存在两种写入语义
 *（例如翻译开关在 App 里不派事件）。这里拥有默认值、布尔格式、枚举校验、秒数钳制、
 * 历史事件、快照与订阅。键名与事件名是历史值，**勿改**。
 */

/** localStorage 键（历史裸键，勿改）。 */
export const PLAYBACK_DISPLAY_KEYS = {
  upNextEnabled: 'upNextEnabled',
  showUpNextOutsidePlayer: 'showUpNextOutsidePlayer',
  upNextSeconds: 'upNextSeconds',
  translationEnabled: 'translationEnabled',
  translationPosition: 'translationPosition',
  romanEnabled: 'romanEnabled',
  mvBackgroundEnabled: 'mvBackgroundEnabled',
  modernAudioVisualizerEnabled: 'modernAudioVisualizerEnabled',
  hideImmersiveSongInfo: 'hideImmersiveSongInfo',
  playerTheme: 'playerTheme',
} as const

/** 领域事件（播放侧与旧 UI 监听这些名字）。 */
export const PLAYBACK_DISPLAY_EVENTS = {
  upNextEnabled: 'upNextEnabledChanged',
  showUpNextOutsidePlayer: 'showUpNextOutsidePlayerChanged',
  upNextSeconds: 'upNextSecondsChanged',
  translationEnabled: 'translationSettingsChanged',
  translationPosition: 'translationPositionChanged',
  romanEnabled: 'romanSettingsChanged',
  mvBackground: 'mvBackgroundSettingsChanged',
  modernAudioVisualizer: 'modernAudioVisualizerChanged',
  hideImmersiveSongInfo: 'hideImmersiveSongInfoChanged',
  playerTheme: 'playerThemeChanged',
} as const

/**
 * 注册表的通用变更事件。这里只能写字符串字面量：globalSettingsRegistry.ts 会
 * import 本模块，反向 import 会形成循环依赖。两边取值必须一致。
 */
const GLOBAL_SETTING_CHANGED_EVENT = 'hyperplayer:global-setting-changed'

const WATCHED_EVENTS = [
  ...Object.values(PLAYBACK_DISPLAY_EVENTS),
  GLOBAL_SETTING_CHANGED_EVENT,
] as const

export type TranslationPosition = 'traditional' | 'bottom-right'
export type PlayerTheme = 'dark' | 'light'

export interface PlaybackDisplaySettings {
  upNextEnabled: boolean
  showUpNextOutsidePlayer: boolean
  upNextSeconds: number
  translationEnabled: boolean
  translationPosition: TranslationPosition
  romanEnabled: boolean
  mvBackgroundEnabled: boolean
  modernAudioVisualizerEnabled: boolean
  hideImmersiveSongInfo: boolean
  playerTheme: PlayerTheme
}

export interface PlaybackDisplayHost {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  dispatchEvent(name: string, detail?: boolean | string | number): void
  subscribe?(listener: () => void): () => void
}

const defaultHost: PlaybackDisplayHost = {
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
    for (const eventName of WATCHED_EVENTS) window.addEventListener(eventName, listener)
    return () => {
      for (const eventName of WATCHED_EVENTS) window.removeEventListener(eventName, listener)
    }
  },
}

const readBool = (host: PlaybackDisplayHost, key: string, fallback: boolean): boolean =>
  parseStoredBoolean(host.getItem(key), fallback)

const readTranslationPosition = (host: PlaybackDisplayHost): TranslationPosition =>
  host.getItem(PLAYBACK_DISPLAY_KEYS.translationPosition) === 'bottom-right'
    ? 'bottom-right'
    : 'traditional'

export const UP_NEXT_SECONDS_MIN = 5
export const UP_NEXT_SECONDS_MAX = 30
export const DEFAULT_UP_NEXT_SECONDS = 10

/** 与设置面板滑杆一致：钳制到 [5,30] 并取整。 */
export function normalizeUpNextSeconds(seconds: number): number {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return DEFAULT_UP_NEXT_SECONDS
  return Math.max(
    UP_NEXT_SECONDS_MIN,
    Math.min(UP_NEXT_SECONDS_MAX, Math.round(value)),
  )
}

/** 读取用：空串 / 缺失 / 非法都回落到默认 10 秒（旧实现 parseInt('') → NaN → 10）。 */
const readUpNextSeconds = (host: PlaybackDisplayHost): number => {
  const raw = host.getItem(PLAYBACK_DISPLAY_KEYS.upNextSeconds)
  if (raw === null || raw.trim() === '') return DEFAULT_UP_NEXT_SECONDS
  return normalizeUpNextSeconds(Number(raw))
}

export function readPlayerTheme(host: PlaybackDisplayHost = defaultHost): PlayerTheme {
  return host.getItem(PLAYBACK_DISPLAY_KEYS.playerTheme) === 'light' ? 'light' : 'dark'
}

export function readPlaybackDisplaySettings(
  host: PlaybackDisplayHost = defaultHost,
): PlaybackDisplaySettings {
  return {
    upNextEnabled: readBool(host, PLAYBACK_DISPLAY_KEYS.upNextEnabled, true),
    showUpNextOutsidePlayer: readBool(host, PLAYBACK_DISPLAY_KEYS.showUpNextOutsidePlayer, false),
    upNextSeconds: readUpNextSeconds(host),
    translationEnabled: readBool(host, PLAYBACK_DISPLAY_KEYS.translationEnabled, false),
    translationPosition: readTranslationPosition(host),
    romanEnabled: readBool(host, PLAYBACK_DISPLAY_KEYS.romanEnabled, false),
    mvBackgroundEnabled: readBool(host, PLAYBACK_DISPLAY_KEYS.mvBackgroundEnabled, false),
    modernAudioVisualizerEnabled: readBool(
      host,
      PLAYBACK_DISPLAY_KEYS.modernAudioVisualizerEnabled,
      true,
    ),
    hideImmersiveSongInfo: readBool(host, PLAYBACK_DISPLAY_KEYS.hideImmersiveSongInfo, false),
    playerTheme: readPlayerTheme(host),
  }
}

interface PlaybackDisplayStoreState {
  snapshot: PlaybackDisplaySettings | null
  subscribers: Set<() => void>
  detach: (() => void) | null
  isCommitting: boolean
}

const stores = new WeakMap<PlaybackDisplayHost, PlaybackDisplayStoreState>()

const storeFor = (host: PlaybackDisplayHost): PlaybackDisplayStoreState => {
  let store = stores.get(host)
  if (!store) {
    store = { snapshot: null, subscribers: new Set(), detach: null, isCommitting: false }
    stores.set(host, store)
  }
  return store
}

const sameSettings = (a: PlaybackDisplaySettings, b: PlaybackDisplaySettings): boolean =>
  a.upNextEnabled === b.upNextEnabled
  && a.showUpNextOutsidePlayer === b.showUpNextOutsidePlayer
  && a.upNextSeconds === b.upNextSeconds
  && a.translationEnabled === b.translationEnabled
  && a.translationPosition === b.translationPosition
  && a.romanEnabled === b.romanEnabled
  && a.mvBackgroundEnabled === b.mvBackgroundEnabled
  && a.modernAudioVisualizerEnabled === b.modernAudioVisualizerEnabled
  && a.hideImmersiveSongInfo === b.hideImmersiveSongInfo
  && a.playerTheme === b.playerTheme

const refreshSnapshot = (host: PlaybackDisplayHost): boolean => {
  const store = storeFor(host)
  const settings = readPlaybackDisplaySettings(host)
  if (store.snapshot && sameSettings(store.snapshot, settings)) return false
  store.snapshot = settings
  return true
}

/** 当前快照；主题单独读取，避免把它塞进这组“播放页显示”语义。 */
export function getPlaybackDisplaySnapshot(
  host: PlaybackDisplayHost = defaultHost,
): PlaybackDisplaySettings {
  const store = storeFor(host)
  if (!store.snapshot) store.snapshot = readPlaybackDisplaySettings(host)
  return store.snapshot
}

const notifySubscribers = (host: PlaybackDisplayHost) => {
  for (const subscriber of [...storeFor(host).subscribers]) subscriber()
}

const handleExternalEvent = (host: PlaybackDisplayHost) => {
  const store = storeFor(host)
  if (store.isCommitting) return
  if (refreshSnapshot(host)) notifySubscribers(host)
}

const attachListeners = (host: PlaybackDisplayHost) => {
  const store = storeFor(host)
  if (store.detach || !host.subscribe) return
  store.detach = host.subscribe(() => handleExternalEvent(host))
}

const detachListeners = (host: PlaybackDisplayHost) => {
  const store = storeFor(host)
  if (!store.detach) return
  store.detach()
  store.detach = null
}

export function subscribePlaybackDisplaySettings(
  listener: () => void,
  host: PlaybackDisplayHost = defaultHost,
): () => void {
  getPlaybackDisplaySnapshot(host)
  const store = storeFor(host)
  store.subscribers.add(listener)
  attachListeners(host)
  return () => {
    store.subscribers.delete(listener)
    if (store.subscribers.size === 0) detachListeners(host)
  }
}

/** 一次逻辑写入：写完存储、派发旧领域事件、只通知一次最终快照。 */
const commit = (host: PlaybackDisplayHost, action: () => void): void => {
  const store = storeFor(host)
  store.isCommitting = true
  let changed = false
  try {
    action()
    host.dispatchEvent(GLOBAL_SETTING_CHANGED_EVENT)
    changed = refreshSnapshot(host)
  } finally {
    store.isCommitting = false
    // 快照未变（重复写入同一值）就不通知，避免无意义重渲染。
    if (changed) notifySubscribers(host)
  }
}

const writeBool = (host: PlaybackDisplayHost, key: string, value: boolean): void => {
  host.setItem(key, JSON.stringify(value))
}

export function setUpNextEnabled(enabled: boolean, host: PlaybackDisplayHost = defaultHost): void {
  commit(host, () => {
    writeBool(host, PLAYBACK_DISPLAY_KEYS.upNextEnabled, enabled)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.upNextEnabled)
  })
}

export function setShowUpNextOutsidePlayer(
  enabled: boolean,
  host: PlaybackDisplayHost = defaultHost,
): void {
  commit(host, () => {
    writeBool(host, PLAYBACK_DISPLAY_KEYS.showUpNextOutsidePlayer, enabled)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.showUpNextOutsidePlayer)
  })
}

export function setUpNextSeconds(
  seconds: number,
  host: PlaybackDisplayHost = defaultHost,
): number {
  let result = DEFAULT_UP_NEXT_SECONDS
  commit(host, () => {
    result = normalizeUpNextSeconds(seconds)
    host.setItem(PLAYBACK_DISPLAY_KEYS.upNextSeconds, result.toString())
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.upNextSeconds, result)
  })
  return result
}

export function setTranslationEnabled(
  enabled: boolean,
  host: PlaybackDisplayHost = defaultHost,
): void {
  commit(host, () => {
    writeBool(host, PLAYBACK_DISPLAY_KEYS.translationEnabled, enabled)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.translationEnabled)
  })
}

export function setTranslationPosition(
  position: TranslationPosition,
  host: PlaybackDisplayHost = defaultHost,
): void {
  commit(host, () => {
    host.setItem(PLAYBACK_DISPLAY_KEYS.translationPosition, position)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.translationPosition, position)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.translationEnabled)
  })
}

export function setRomanEnabled(enabled: boolean, host: PlaybackDisplayHost = defaultHost): void {
  commit(host, () => {
    writeBool(host, PLAYBACK_DISPLAY_KEYS.romanEnabled, enabled)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.romanEnabled)
  })
}

export function setMvBackgroundEnabled(
  enabled: boolean,
  host: PlaybackDisplayHost = defaultHost,
): void {
  commit(host, () => {
    writeBool(host, PLAYBACK_DISPLAY_KEYS.mvBackgroundEnabled, enabled)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.mvBackground)
  })
}

export function setModernAudioVisualizerEnabled(
  enabled: boolean,
  host: PlaybackDisplayHost = defaultHost,
): void {
  commit(host, () => {
    writeBool(host, PLAYBACK_DISPLAY_KEYS.modernAudioVisualizerEnabled, enabled)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.modernAudioVisualizer, enabled)
  })
}

/** 写入 `hideImmersiveSongInfo`：`true` = 隐藏沉浸式模式的歌曲信息。 */
export function setHideImmersiveSongInfo(
  hidden: boolean,
  host: PlaybackDisplayHost = defaultHost,
): void {
  commit(host, () => {
    writeBool(host, PLAYBACK_DISPLAY_KEYS.hideImmersiveSongInfo, hidden)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.hideImmersiveSongInfo, hidden)
  })
}

export function setPlayerTheme(theme: PlayerTheme, host: PlaybackDisplayHost = defaultHost): void {
  commit(host, () => {
    host.setItem(PLAYBACK_DISPLAY_KEYS.playerTheme, theme)
    host.dispatchEvent(PLAYBACK_DISPLAY_EVENTS.playerTheme, theme)
  })
}
