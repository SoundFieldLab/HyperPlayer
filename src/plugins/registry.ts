/**
 * 插件注册表：内置插件（Chroma / SignalRGB）+ 导入插件的 manifest 合并视图。
 *
 * 内置插件随应用发布，不可卸载；导入插件 manifest 持久化在 pluginStore 的
 * `wf_plugins` 中，这里只负责合并与查询视图。导入插件代码当前运行在 renderer，
 * 属于用户明确安装的受信代码；不要将 `new Function` 包装误认为安全沙箱。
 */

import type { PluginContext, PluginManifest, PluginRuntime } from './types'
import { getImportedPluginManifests } from '../services/pluginStore'
import { compilePluginFactory } from './runtimeCapability'

/** 内置插件注册表（id -> manifest + runtime）。 */
const builtinPlugins = new Map<string, { manifest: PluginManifest; runtime?: PluginRuntime }>()
const importedRuntimeCache = new Map<string, { code: string; runtime: PluginRuntime }>()

/** 内置插件名 → 图标/配色（内置插件由代码注册时自带）。 */
export function registerBuiltinPlugin(manifest: PluginManifest, runtime?: PluginRuntime) {
  builtinPlugins.set(manifest.id, { manifest: { ...manifest, source: 'builtin' }, runtime })
}

/** 全部插件（含导入），列表顺序：内置在前、导入按安装时间。 */
export function getAllPluginManifests(): PluginManifest[] {
  const builtin = Array.from(builtinPlugins.values()).map(e => e.manifest)
  const imported = getImportedPluginManifests()
  return [...builtin, ...imported]
}

export function getPluginManifest(id: string): PluginManifest | undefined {
  return getAllPluginManifests().find(p => p.id === id)
}

export function getPluginRuntime(id: string): PluginRuntime | undefined {
  const builtin = builtinPlugins.get(id)?.runtime
  if (builtin) return builtin
  // 导入插件：运行时代码即时解析执行
  const manifest = getImportedPluginManifests().find(p => p.id === id)
  if (!manifest?.code) {
    importedRuntimeCache.delete(id)
    return undefined
  }
  const cached = importedRuntimeCache.get(id)
  if (cached?.code === manifest.code) return cached.runtime
  const runtime = createImportedPluginRuntime(manifest.code)
  importedRuntimeCache.set(id, { code: manifest.code, runtime })
  return runtime
}

export function hasEnabledAudioPlugin(isEnabled: (id: string) => boolean): boolean {
  return getAllPluginManifests().some(plugin => plugin.needsAudio === true && isEnabled(plugin.id))
}

export function isBuiltinPlugin(id: string): boolean {
  return builtinPlugins.has(id)
}

/* ---------------------------------- 导入插件运行时 ---------------------------------- */

/**
 * 执行用户明确导入的插件代码：
 * - 代码与应用 renderer 同权限运行，不是安全沙箱；
 * - 不提供 CommonJS `require`，但仍能访问 renderer 全局对象；
 * - 插件约定的导出形态：函数返回生命周期对象。
 */
export function createImportedPluginRuntime(code: string): PluginRuntime {
  const compiled = compilePluginFactory(code)
  if (!compiled.ok) {
    // 解析失败不再静默退化成空 runtime：把原因挂到 runtime 上，让启用流程能如实报错
    // 并回滚开关状态（旧实现返回 {} 会让 UI 提示「已启用」而插件一次都没执行）。
    console.error('[插件] 运行时代码解析失败:', compiled.failure)
    return { unavailableReason: compiled.failure }
  }
  let lifecycle: PluginRuntime | undefined
  return {
    onEnable: async (ctx) => {
      const factory = compiled.factory() as (ctx: PluginContext) => PluginRuntime | undefined
      lifecycle = factory(ctx) ?? {}
      await lifecycle.onEnable?.(ctx)
    },
    onDisable: async () => {
      const current = lifecycle
      lifecycle = undefined
      await current?.onDisable?.()
    },
  }
}

/** 插件启用时可被调用：拿到渲染端生命周期函数。 */
export function buildPluginContext(
  overrides: Partial<PluginContext> = {},
): PluginContext {
  return {
    audio: {
      subscribe: () => () => undefined,
    },
    storage: {
      get: () => null,
      set: () => undefined,
    },
    toast: () => undefined,
    log: () => undefined,
    ...overrides,
  }
}