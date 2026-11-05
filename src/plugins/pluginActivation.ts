/**
 * 插件启用与生命周期 module。
 *
 * 旧实现把同一件事拆在两处：
 *   - `toggle.ts` 在写 enabled=true 前检查 runtime.unavailableReason；
 *   - `PluginOverlay.tsx` 在 React effect 里另建队列 / 代际，再检查一次原因并回滚。
 *
 * 本模块把 consent、运行时能力门控、enabled 写入、生命周期队列 / 代际与清理
 * 收进同一处。两个 UI 入口只调用这里；宿主可注入，测试不必起 React 或真实注册表。
 */

import {
  buildPluginContext,
  getAllPluginManifests,
  getPluginManifest,
  getPluginRuntime,
} from './registry'
import type { PluginContext, PluginManifest, PluginRuntime } from './types'
import {
  hasPluginConsent,
  isPluginEnabled,
  PLUGIN_STATE_EVENT,
  requestNotice,
  setPluginConsent,
  setPluginEnabled,
  type PluginNoticeState,
} from '../services/pluginStore'

type PluginToast = (
  message: string,
  type?: 'success' | 'error' | 'info',
  duration?: number,
) => void

/** 全局 toast（与 App 的 showToast 事件对接）。 */
export function showToast(
  message: string,
  type: 'success' | 'error' | 'info' = 'info',
  duration = 3200,
) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type, duration } }))
}

/** 插件启用 / 生命周期需要的宿主能力。 */
export interface PluginActivationHost {
  getAllManifests(): PluginManifest[]
  getManifest(id: string): PluginManifest | undefined
  getRuntime(id: string): PluginRuntime | undefined
  isEnabled(id: string): boolean
  setEnabled(id: string, enabled: boolean): void
  hasConsent(id: string): boolean
  setConsent(id: string, consent: boolean): void
  requestNotice(notice: PluginNoticeState): void
  buildContext(): PluginContext
  subscribe(listener: () => void): () => void
  showToast: PluginToast
}

const defaultHost: PluginActivationHost = {
  getAllManifests: getAllPluginManifests,
  getManifest: getPluginManifest,
  getRuntime: getPluginRuntime,
  isEnabled: isPluginEnabled,
  setEnabled: setPluginEnabled,
  hasConsent: hasPluginConsent,
  setConsent: setPluginConsent,
  requestNotice,
  buildContext: () => buildPluginContext({
    storage: {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
    },
    toast: (message, type) => showToast(message, type ?? 'info'),
    log: (...args) => console.log('[插件]', ...args),
  }),
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => {}
    window.addEventListener(PLUGIN_STATE_EVENT, listener)
    return () => window.removeEventListener(PLUGIN_STATE_EVENT, listener)
  },
  showToast,
}

function enableIfRuntimeUsable(pluginId: string, host: PluginActivationHost): boolean {
  const runtime = host.getRuntime(pluginId)
  const reason = runtime?.unavailableReason
  if (!reason) {
    host.setEnabled(pluginId, true)
    return true
  }
  host.setEnabled(pluginId, false)
  const name = host.getManifest(pluginId)?.name ?? pluginId
  host.showToast(`插件[${name}]无法启用：${reason.message}`, 'error', 6000)
  return false
}

function finishEnable(pluginId: string, host: PluginActivationHost): boolean {
  if (!enableIfRuntimeUsable(pluginId, host)) return false
  const name = host.getManifest(pluginId)?.name ?? pluginId
  host.showToast(`插件[${name}]已启用 请在主页使用此功能`, 'success', 3600)
  return true
}

const disableRuntime = async (runtime: PluginRuntime) => {
  await runtime.onDisable?.()
}

/**
 * 请求切换插件开关。返回 true = 已直接切换；false = 被 consent 须知拦截，
 * 或运行时不可用（用户确认后由回调完成启用 + toast）。
 */
export function requestTogglePlugin(
  pluginId: string,
  wantEnabled: boolean,
  host: PluginActivationHost = defaultHost,
): boolean {
  if (!wantEnabled) {
    host.setEnabled(pluginId, false)
    return true
  }
  const manifest = host.getManifest(pluginId)
  if (manifest?.requireNotice && !host.hasConsent(pluginId)) {
    host.requestNotice({
      pluginId,
      kind: 'consent',
      onResolve: (ok) => {
        if (!ok) return
        host.setConsent(pluginId, true)
        if (!finishEnable(pluginId, host)) return
      },
    })
    return false
  }
  return finishEnable(pluginId, host)
}

/**
 * 订阅插件开关状态并驱动生命周期。返回停止函数：停止订阅，并为仍启用的插件
 * 排队调用 onDisable。一次逻辑切换只让最新代际执行。
 */
export function startPluginLifecycle(host: PluginActivationHost = defaultHost): () => void {
  const previous = new Map<string, boolean>()
  const generations = new Map<string, number>()
  const queues = new Map<string, Promise<void>>()

  const enqueue = (pluginId: string, task: () => void | Promise<void>) => {
    const previousTask = queues.get(pluginId) ?? Promise.resolve()
    const nextTask = previousTask.catch(() => undefined).then(task).catch(error => {
      console.error(`[插件:${pluginId}] 生命周期执行失败:`, error)
    })
    queues.set(pluginId, nextTask)
  }

  const sync = () => {
    for (const manifest of host.getAllManifests()) {
      const enabled = host.isEnabled(manifest.id)
      const wasEnabled = previous.get(manifest.id) ?? false
      if (enabled === wasEnabled) continue
      previous.set(manifest.id, enabled)
      const runtime = host.getRuntime(manifest.id)
      if (!runtime) continue
      const generation = (generations.get(manifest.id) ?? 0) + 1
      generations.set(manifest.id, generation)
      enqueue(manifest.id, async () => {
        if (generations.get(manifest.id) !== generation) return
        if (!enabled) {
          await disableRuntime(runtime)
          return
        }
        const reason = runtime.unavailableReason
        if (reason) {
          console.error(`[插件:${manifest.id}] 无法启用:`, reason)
          host.setEnabled(manifest.id, false)
          host.showToast(`插件[${manifest.name}]无法启用：${reason.message}`, 'error', 6000)
          return
        }
        await runtime.onEnable?.(host.buildContext())
      })
    }
  }

  sync()
  const unsubscribe = host.subscribe(sync)
  return () => {
    unsubscribe()
    for (const pluginId of previous.keys()) {
      const generation = (generations.get(pluginId) ?? 0) + 1
      generations.set(pluginId, generation)
      if (!previous.get(pluginId)) continue
      const runtime = host.getRuntime(pluginId)
      if (!runtime?.onDisable) continue
      enqueue(pluginId, async () => {
        try { await disableRuntime(runtime) } catch { /* 插件卸载失败不阻塞其余清理 */ }
      })
    }
    previous.clear()
  }
}
