import { describe, expect, it } from 'vitest'
import type { PluginContext, PluginManifest, PluginRuntime } from '../src/plugins/types'
import type { PluginNoticeState } from '../src/services/pluginStore'
import {
  requestTogglePlugin,
  startPluginLifecycle,
  type PluginActivationHost,
} from '../src/plugins/pluginActivation'

const context: PluginContext = {
  audio: { subscribe: () => () => undefined },
  storage: { get: () => null, set: () => undefined },
  toast: () => undefined,
  log: () => undefined,
}

function makeManifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    developer: 'test',
    description: 'test plugin',
    updated: '2026-11-05',
    source: 'builtin',
    ...overrides,
  }
}

function makeHost(options: {
  manifests?: PluginManifest[]
  runtimes?: Record<string, PluginRuntime>
  enabled?: Record<string, boolean>
} = {}) {
  const manifests = options.manifests ?? []
  const runtimes = options.runtimes ?? {}
  const enabled = new Map(Object.entries(options.enabled ?? {}))
  const consent = new Map<string, boolean>()
  const notices: PluginNoticeState[] = []
  const toasts: Array<{ message: string; type?: string; duration?: number }> = []
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of [...listeners]) listener() }
  const host: PluginActivationHost = {
    getAllManifests: () => manifests,
    getManifest: (id) => manifests.find(manifest => manifest.id === id),
    getRuntime: (id) => runtimes[id],
    isEnabled: (id) => enabled.get(id) ?? false,
    setEnabled: (id, value) => { enabled.set(id, value); emit() },
    hasConsent: (id) => consent.get(id) ?? false,
    setConsent: (id, value) => { consent.set(id, value) },
    requestNotice: (notice) => { notices.push(notice) },
    buildContext: () => context,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    showToast: (message, type, duration) => { toasts.push({ message, type, duration }) },
  }
  return { host, enabled, notices, toasts }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('requestTogglePlugin', () => {
  it('首次开启先弹 consent，确认后才落盘并 toast', () => {
    const manifest = makeManifest('consented', { requireNotice: true })
    const { host, notices, toasts } = makeHost({ manifests: [manifest] })

    expect(requestTogglePlugin('consented', true, host)).toBe(false)
    expect(host.isEnabled('consented')).toBe(false)
    expect(notices).toHaveLength(1)

    notices[0].onResolve(true)

    expect(host.hasConsent('consented')).toBe(true)
    expect(host.isEnabled('consented')).toBe(true)
    expect(toasts.at(-1)?.type).toBe('success')
  })

  it('运行时不可用时保持关闭并报可读原因', () => {
    const manifest = makeManifest('blocked')
    const { host, toasts } = makeHost({
      manifests: [manifest],
      runtimes: {
        blocked: {
          unavailableReason: { kind: 'csp-blocked', message: 'CSP 禁止动态代码' },
        },
      },
    })

    expect(requestTogglePlugin('blocked', true, host)).toBe(false)
    expect(host.isEnabled('blocked')).toBe(false)
    expect(toasts[0]?.type).toBe('error')
    expect(toasts[0]?.message).toContain('CSP 禁止动态代码')
  })

  it('直接关闭不经过 consent 与运行时门控', () => {
    const { host, notices } = makeHost({ manifests: [makeManifest('close-directly')] })

    expect(requestTogglePlugin('close-directly', false, host)).toBe(true)
    expect(host.isEnabled('close-directly')).toBe(false)
    expect(notices).toEqual([])
  })
})

describe('startPluginLifecycle', () => {
  it('按启用状态调用 onEnable / onDisable，并在停止时清理', async () => {
    const calls: string[] = []
    const runtime: PluginRuntime = {
      onEnable: async () => { calls.push('enable') },
      onDisable: async () => { calls.push('disable') },
    }
    const { host } = makeHost({
      manifests: [makeManifest('lifecycle')],
      runtimes: { lifecycle: runtime },
      enabled: { lifecycle: true },
    })

    const stop = startPluginLifecycle(host)
    await flush()
    expect(calls).toEqual(['enable'])

    host.setEnabled('lifecycle', false)
    await flush()
    expect(calls).toEqual(['enable', 'disable'])

    host.setEnabled('lifecycle', true)
    await flush()
    expect(calls).toEqual(['enable', 'disable', 'enable'])

    stop()
    await flush()
    expect(calls).toEqual(['enable', 'disable', 'enable', 'disable'])
  })

  it('运行时不可用时回滚 enabled 并提示', async () => {
    const { host, toasts } = makeHost({
      manifests: [makeManifest('blocked-lifecycle')],
      runtimes: {
        'blocked-lifecycle': {
          unavailableReason: { kind: 'csp-blocked', message: '不能运行' },
        },
      },
      enabled: { 'blocked-lifecycle': true },
    })

    const stop = startPluginLifecycle(host)
    await flush()

    expect(host.isEnabled('blocked-lifecycle')).toBe(false)
    expect(toasts[0]?.type).toBe('error')
    expect(toasts[0]?.message).toContain('不能运行')
    stop()
  })

  it('快速开启后立即关闭时跳过过期 enable', async () => {
    const calls: string[] = []
    const runtime: PluginRuntime = {
      onEnable: async () => { calls.push('enable') },
      onDisable: async () => { calls.push('disable') },
    }
    const { host } = makeHost({
      manifests: [makeManifest('rapid')],
      runtimes: { rapid: runtime },
      enabled: { rapid: true },
    })

    const stop = startPluginLifecycle(host)
    host.setEnabled('rapid', false)
    await flush()

    expect(calls).toEqual(['disable'])
    stop()
    await flush()
    expect(calls).toEqual(['disable'])
  })

  it('停止时取消尚未执行的 enable', async () => {
    const calls: string[] = []
    const runtime: PluginRuntime = {
      onEnable: async () => { calls.push('enable') },
    }
    const { host } = makeHost({
      manifests: [makeManifest('stopped-before-enable')],
      runtimes: { 'stopped-before-enable': runtime },
      enabled: { 'stopped-before-enable': true },
    })

    const stop = startPluginLifecycle(host)
    stop()
    await flush()

    expect(calls).toEqual([])
  })
})
