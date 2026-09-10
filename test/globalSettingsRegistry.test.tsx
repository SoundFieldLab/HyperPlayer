/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const flushPromises = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

async function loadRegistry() {
  vi.resetModules()
  return import('../src/services/globalSettingsRegistry')
}

afterEach(() => {
  cleanup()
  delete (window as any).electron
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('global settings registry performance boundaries', () => {
  it('loads the desktop bridge once after the cache is complete and uses lightweight GPU settings', async () => {
    const getGpuSettings = vi.fn(async () => ({ enabled: true, gpuPreference: 'integrated' }))
    const getHardwareAcceleration = vi.fn(async () => ({ enabled: false, gpuPreference: 'discrete' }))
    ;(window as any).electron = { system: { getGpuSettings, getHardwareAcceleration } }
    const { ensureDesktopBridgeSettings } = await loadRegistry()

    ensureDesktopBridgeSettings()
    await flushPromises()
    ensureDesktopBridgeSettings()
    await flushPromises()

    expect(getGpuSettings).toHaveBeenCalledTimes(1)
    expect(getHardwareAcceleration).not.toHaveBeenCalled()
    expect(localStorage.getItem('gpuAcceleration')).toBe('true')
  })

  it('releases the loading guard when a bridge getter throws synchronously', async () => {
    const getSettings = vi.fn()
      .mockImplementationOnce(() => { throw new Error('bridge unavailable') })
      .mockResolvedValueOnce({ enabled: false, fontSize: 58 })
    ;(window as any).electron = { desktopLyrics: { getSettings } }
    const { ensureDesktopBridgeSettings } = await loadRegistry()

    ensureDesktopBridgeSettings()
    await flushPromises()
    ensureDesktopBridgeSettings()
    await flushPromises()

    expect(getSettings).toHaveBeenCalledTimes(2)
  })

  it('shares one window listener set across nested hook consumers', async () => {
    ;(window as any).electron = {}
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const { GLOBAL_SETTING_CHANGED_EVENT, useGlobalSettings } = await loadRegistry()
    const Consumer = () => { useGlobalSettings(); return null }

    const first = render(<><Consumer /><Consumer /></>)
    const watchedAdds = () => addListener.mock.calls.filter(([name]) => name === GLOBAL_SETTING_CHANGED_EVENT)
    expect(watchedAdds()).toHaveLength(1)

    first.unmount()
    expect(removeListener.mock.calls.filter(([name]) => name === GLOBAL_SETTING_CHANGED_EVENT)).toHaveLength(1)
  })
})
