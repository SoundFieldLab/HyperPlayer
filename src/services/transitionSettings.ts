/**
 * 播放过渡设置（Crossfade / Gapless / 专辑融合）的**唯一写入规则**。
 *
 * 为什么需要这个模块（2026-10-29 实测发现的真实分歧）：
 * 这条链原本有两套独立写入逻辑——`SettingsPanel.tsx`（简约模式，即"总设置"）
 * 手写一套，`globalSettingsRegistry.ts`（镜像给传统/探索/桌面三模式）另写一套。
 * 两套并不等价：
 *   1. 镜像侧写完会派发 `hyperplayer:global-setting-changed`，简约侧不派发；
 *      而 SettingsPanel 只在挂载时读一次 localStorage、不监听领域事件——
 *      于是「在传统模式里开启 gapless」之后回到简约设置页，开关仍显示旧值。
 *   2. 时长钳制：简约侧 parseInt + clamp 到 [1,12]；镜像侧滑杆 step 是 0.5，
 *      write 只 clamp 不取整，同一档位能存出 4.5 秒。
 *   3. 存储格式靠人工保持一致：布尔用 JSON.stringify（"true"/"false"），
 *      时长用 toString（"4"）。
 *
 * 做法：把「互斥 / 钳制 / 存储格式 / 事件 / 快照 / 订阅」收进这里，
 * 两种界面只决定**怎么呈现**。一次逻辑写入只通知一次最终快照，
 * 旧领域事件仍保留给播放侧监听。
 * 键名与事件名保持历史值不变（改键会丢用户已保存的设置）。
 */

export type TransitionMode = 'crossfade' | 'gapless'

/** 时长边界：与设置面板滑杆的 min/max 一致。 */
export const CROSSFADE_DURATION_MIN = 1
export const CROSSFADE_DURATION_MAX = 12
export const DEFAULT_CROSSFADE_DURATION = 4

/** localStorage 键（**历史裸键，勿改**——改名会让已保存的设置失效）。 */
export const TRANSITION_KEYS = {
  crossfadeEnabled: 'crossfadeEnabled',
  crossfadeDuration: 'crossfadeDuration',
  gaplessEnabled: 'gaplessEnabled',
  albumGaplessEnabled: 'albumGaplessEnabled',
} as const

/** 领域事件（播放侧 App.tsx / useAudioPlayer.ts 监听这些名字）。 */
export const TRANSITION_EVENTS = {
  crossfade: 'crossfadeSettingsChanged',
  gapless: 'gaplessSettingsChanged',
  albumGapless: 'albumGaplessSettingsChanged',
} as const

/**
 * 注册表的通用变更事件。这里只能写字符串字面量：globalSettingsRegistry.ts 会
 * import 本模块，若反过来 import 它会形成循环依赖。两边取值必须一致——
 * test/transitionSettings.test.ts 有断言钉住。
 */
const GLOBAL_SETTING_CHANGED_EVENT = 'hyperplayer:global-setting-changed'

const TRANSITION_WATCHED_EVENTS = [
  TRANSITION_EVENTS.crossfade,
  TRANSITION_EVENTS.gapless,
  TRANSITION_EVENTS.albumGapless,
  GLOBAL_SETTING_CHANGED_EVENT,
] as const

/** 本模块需要的宿主能力（便于在 node 环境测试，不必真起浏览器）。 */
export interface TransitionSettingsHost {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  dispatchEvent(name: string): void
  /** 可选订阅入口；默认 host 用 window，测试 host 用内存事件表。 */
  subscribe?(listener: () => void): () => void
}

const defaultHost: TransitionSettingsHost = {
  getItem: (key) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
  setItem: (key, value) => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  },
  dispatchEvent: (name) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new Event(name))
  },
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => {}
    for (const eventName of TRANSITION_WATCHED_EVENTS) {
      window.addEventListener(eventName, listener)
    }
    return () => {
      for (const eventName of TRANSITION_WATCHED_EVENTS) {
        window.removeEventListener(eventName, listener)
      }
    }
  },
}

const readBool = (host: TransitionSettingsHost, key: string, fallback: boolean): boolean => {
  const raw = host.getItem(key)
  if (raw === null) return fallback
  // 历史数据里既有 JSON 的 "true" 也有裸 "1"，两种都要认。
  return raw === 'true' || raw === '1'
}

/** 时长钳制 + 取整。镜像侧滑杆 step=0.5 也走这里，避免两套界面存出不同粒度。 */
export function normalizeCrossfadeDuration(seconds: number): number {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return DEFAULT_CROSSFADE_DURATION
  return Math.max(CROSSFADE_DURATION_MIN, Math.min(CROSSFADE_DURATION_MAX, Math.round(value)))
}

export interface TransitionSettings {
  crossfadeEnabled: boolean
  crossfadeDuration: number
  gaplessEnabled: boolean
  albumGaplessEnabled: boolean
}

interface TransitionSettingsStoreState {
  snapshot: TransitionSettings | null
  subscribers: Set<() => void>
  detach: (() => void) | null
  isCommitting: boolean
}

const stores = new WeakMap<TransitionSettingsHost, TransitionSettingsStoreState>()

const storeFor = (host: TransitionSettingsHost): TransitionSettingsStoreState => {
  let store = stores.get(host)
  if (!store) {
    store = { snapshot: null, subscribers: new Set(), detach: null, isCommitting: false }
    stores.set(host, store)
  }
  return store
}

const sameTransitionSettings = (a: TransitionSettings, b: TransitionSettings): boolean =>
  a.crossfadeEnabled === b.crossfadeEnabled
  && a.crossfadeDuration === b.crossfadeDuration
  && a.gaplessEnabled === b.gaplessEnabled
  && a.albumGaplessEnabled === b.albumGaplessEnabled

/** 读取全部四项（默认：两个开关关、专辑融合开、时长 4 秒）。 */
export function readTransitionSettings(host: TransitionSettingsHost = defaultHost): TransitionSettings {
  return {
    crossfadeEnabled: readBool(host, TRANSITION_KEYS.crossfadeEnabled, false),
    crossfadeDuration: normalizeCrossfadeDuration(
      Number(host.getItem(TRANSITION_KEYS.crossfadeDuration) ?? DEFAULT_CROSSFADE_DURATION),
    ),
    gaplessEnabled: readBool(host, TRANSITION_KEYS.gaplessEnabled, false),
    albumGaplessEnabled: readBool(host, TRANSITION_KEYS.albumGaplessEnabled, true),
  }
}

/**
 * 当前快照：状态未变时返回同一对象，供 `useSyncExternalStore` 使用。
 * 首次读取后由写入或旧事件刷新，避免在 render 期间反复访问存储。
 */
export function getTransitionSnapshot(host: TransitionSettingsHost = defaultHost): TransitionSettings {
  const store = storeFor(host)
  if (!store.snapshot) store.snapshot = readTransitionSettings(host)
  return store.snapshot
}

const notifySubscribers = (host: TransitionSettingsHost) => {
  for (const subscriber of [...storeFor(host).subscribers]) subscriber()
}

const handleExternalTransitionEvent = (host: TransitionSettingsHost) => {
  const store = storeFor(host)
  if (store.isCommitting) return
  const previous = store.snapshot
  const next = readTransitionSettings(host)
  if (!previous || !sameTransitionSettings(previous, next)) {
    store.snapshot = next
    notifySubscribers(host)
  }
}

const attachTransitionListeners = (host: TransitionSettingsHost) => {
  const store = storeFor(host)
  if (store.detach || !host.subscribe) return
  store.detach = host.subscribe(() => handleExternalTransitionEvent(host))
}

const detachTransitionListeners = (host: TransitionSettingsHost) => {
  const store = storeFor(host)
  if (!store.detach) return
  store.detach()
  store.detach = null
}

/** 订阅过渡设置变化；一次逻辑写入只通知一次最终快照。 */
export function subscribeTransitionSettings(
  listener: () => void,
  host: TransitionSettingsHost = defaultHost,
): () => void {
  getTransitionSnapshot(host)
  const store = storeFor(host)
  store.subscribers.add(listener)
  attachTransitionListeners(host)
  return () => {
    store.subscribers.delete(listener)
    if (store.subscribers.size === 0) detachTransitionListeners(host)
  }
}

const writeBool = (host: TransitionSettingsHost, key: string, value: boolean) => {
  host.setItem(key, JSON.stringify(value))
}

/**
 * 一次逻辑写入的提交边界：写完存储后派发旧领域事件，最后只通知一次订阅者。
 * 每个 host 拥有独立 snapshot 与订阅者，测试可用注入 host 验证完整语义。
 */
const commit = <T,>(host: TransitionSettingsHost, action: () => T): T => {
  const store = storeFor(host)
  let succeeded = false
  store.isCommitting = true
  try {
    const result = action()
    store.snapshot = readTransitionSettings(host)
    host.dispatchEvent(GLOBAL_SETTING_CHANGED_EVENT)
    succeeded = true
    return result
  } finally {
    store.isCommitting = false
    if (succeeded) notifySubscribers(host)
  }
}

/**
 * 开启某一过渡模式。两者互斥：开启其一会把另一个关掉（并派发它的变更事件，
 * 否则播放侧仍按旧值工作）。关闭时只动自己。
 */
export function setTransitionMode(
  mode: TransitionMode,
  enabled: boolean,
  host: TransitionSettingsHost = defaultHost,
): void {
  commit(host, () => {
    if (enabled) {
      const other: TransitionMode = mode === 'crossfade' ? 'gapless' : 'crossfade'
      writeBool(host, TRANSITION_KEYS[`${other}Enabled`], false)
      host.dispatchEvent(TRANSITION_EVENTS[other])
    }
    writeBool(host, TRANSITION_KEYS[`${mode}Enabled`], enabled)
    host.dispatchEvent(TRANSITION_EVENTS[mode])
  })
}

/** 写入交叉淡化时长，返回**实际落库**的值（已钳制取整），供调用方回填 UI。 */
export function setCrossfadeDuration(
  seconds: number,
  host: TransitionSettingsHost = defaultHost,
): number {
  return commit(host, () => {
    const duration = normalizeCrossfadeDuration(seconds)
    host.setItem(TRANSITION_KEYS.crossfadeDuration, duration.toString())
    host.dispatchEvent(TRANSITION_EVENTS.crossfade)
    return duration
  })
}

export function setAlbumGaplessEnabled(
  enabled: boolean,
  host: TransitionSettingsHost = defaultHost,
): void {
  commit(host, () => {
    writeBool(host, TRANSITION_KEYS.albumGaplessEnabled, enabled)
    host.dispatchEvent(TRANSITION_EVENTS.albumGapless)
  })
}
