/**
 * 插件详情门控与 UI 入口兼容层。
 *
 * 启用 / consent / 运行时门控 / 生命周期已经收进 `pluginActivation.ts`；
 * 本文件只保留「打开详情」的首次须知门控，并 re-export 旧入口，避免调用方迁移。
 */

import { getPluginManifest } from './registry'
import {
  hasViewedDetail,
  markDetailViewed,
  openPluginDetail,
  requestNotice,
  resolveNotice,
} from '../services/pluginStore'
import { requestTogglePlugin, showToast } from './pluginActivation'

export { requestTogglePlugin, showToast, resolveNotice, requestNotice }

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
