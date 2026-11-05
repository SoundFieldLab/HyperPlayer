/**
 * 插件开关/详情的「使用须知」门控逻辑：
 * - 未查看详情前，卡片开关禁用（组件层禁用 + 这里兜底）；
 * - 首次查看详情（requireNotice 插件）先弹 entry 须知，确认后永久放行；
 * - 首次开启功能先弹 consent 须知，确认后启用并 toast，此后开关自由。
 */

import { getPluginManifest, getPluginRuntime } from './registry'
import {
  hasViewedDetail,
  markDetailViewed,
  hasPluginConsent,
  setPluginConsent,
  setPluginEnabled,
  requestNotice,
  openPluginDetail,
  resolveNotice,
} from '../services/pluginStore'

/** 全局 toast（与 App 的 showToast 事件对接）。 */
export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info', duration = 3200) {
  window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type, duration } }))
}

/** 打开插件详情（带首次 entry 须知门控）。 */
export function openDetailGated(pluginId: string) {
  const manifest = getPluginManifest(pluginId)
  if (!manifest) {
    openPluginDetail(pluginId)
    return
  }
  if (manifest.requireNotice && !hasViewedDetail(pluginId)) {
    requestNotice({
      pluginId,
      kind: 'view',
      onResolve: (ok) => {
        if (ok) {
          markDetailViewed(pluginId)
          openPluginDetail(pluginId)
        }
      },
    })
    return
  }
  openPluginDetail(pluginId)
}

export { resolveNotice, requestNotice }

/**
 * 请求切换插件开关。返回 true = 已直接切换；false = 被 consent 须知拦截
 * （用户确认后由回调完成启用 + toast）。
 */
/**
 * 真正落盘启用状态前的最后一道闸：运行时不可用就如实失败并保持关闭。
 *
 * 这里修的是「显示成功但没生效」——导入插件的代码在 CSP 下无法动态执行时，
 * 旧实现仍写 enabled=true 并弹成功 toast。返回 true 表示确实启用成功。
 */
function enableIfRuntimeUsable(pluginId: string): boolean {
  const runtime = getPluginRuntime(pluginId)
  const reason = runtime?.unavailableReason
  if (!reason) {
    setPluginEnabled(pluginId, true)
    return true
  }
  // 保持关闭，避免重启后又显示成「已启用」的假状态。
  setPluginEnabled(pluginId, false)
  const name = getPluginManifest(pluginId)?.name ?? pluginId
  showToast(`插件[${name}]无法启用：${reason.message}`, 'error', 6000)
  return false
}

export function requestTogglePlugin(pluginId: string, wantEnabled: boolean): boolean {
  if (!wantEnabled) {
    setPluginEnabled(pluginId, false)
    return true
  }
  const manifest = getPluginManifest(pluginId)
  if (manifest?.requireNotice && !hasPluginConsent(pluginId)) {
    requestNotice({
      pluginId,
      kind: 'consent',
      onResolve: (ok) => {
        if (ok) {
          setPluginConsent(pluginId, true)
          if (!enableIfRuntimeUsable(pluginId)) return
          const name = getPluginManifest(pluginId)?.name ?? pluginId
          showToast(`插件[${name}]已启用 请在主页使用此功能`, 'success', 3600)
        }
      },
    })
    return false
  }
  if (!enableIfRuntimeUsable(pluginId)) return false
  const name = getPluginManifest(pluginId)?.name ?? pluginId
  showToast(`插件[${name}]已启用 请在主页使用此功能`, 'success', 3600)
  return true
}