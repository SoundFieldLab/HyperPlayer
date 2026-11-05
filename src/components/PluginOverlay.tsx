/**
 * 插件系统全局挂载层：在 App 中只渲染一次。
 * - 导入内置插件（模块副作用注册）；
 * - 按宿主状态渲染：使用须知 / 插件中心 / 详情 / 导入 / Chroma / SignalRGB 控制台；
 * - 启动「启用状态 → 生命周期回调」桥接（导入插件的 onEnable/onDisable）。
 */

import { useEffect } from 'react'
import '../plugins/ChromaPlugin'
import '../plugins/SignalRgbPlugin'
import { startPluginLifecycle } from '../plugins/pluginActivation'
import {
  resolveNotice,
  usePluginHostState,
  closePluginConsole,
} from '../services/pluginStore'
import PluginNoticeModal from './PluginNoticeModal'
import PluginCenterModal from './PluginCenterModal'
import PluginDetailModal from './PluginDetailModal'
import PluginImportModal from './PluginImportModal'
import ChromaConsoleModal from './ChromaConsoleModal'
import SignalRgbConsoleModal from './SignalRgbConsoleModal'

export default function PluginOverlay() {
  const host = usePluginHostState()
  useEffect(() => startPluginLifecycle(), [])

  return (
    <>
      <PluginNoticeModal
        open={Boolean(host.notice)}
        pluginId={host.notice?.pluginId ?? ''}
        kind={host.notice?.kind ?? 'view'}
        onResolve={resolveNotice}
      />
      <PluginCenterModal />
      <PluginDetailModal />
      <PluginImportModal />
      <ChromaConsoleModal />
      <SignalRgbConsoleModal
        open={host.activeConsolePluginId === 'signalrgb'}
        onClose={() => closePluginConsole('signalrgb')}
      />
    </>
  )
}
