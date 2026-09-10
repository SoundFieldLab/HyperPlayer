// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOBAL_PLATFORM_KEY, LEGACY_PLATFORM_KEYS, PLATFORM_CHANGED_EVENT, readSyncedPlatform, syncPlatformAcrossViews } from '../src/services/platformSync'

const keys = [...LEGACY_PLATFORM_KEYS]

describe('platformSync', () => {
  beforeEach(() => localStorage.clear())

  it('syncs the global key and all four legacy view keys, then broadcasts once', () => {
    const listener = vi.fn()
    window.addEventListener(PLATFORM_CHANGED_EVENT, listener)
    syncPlatformAcrossViews('apple')
    expect(localStorage.getItem(GLOBAL_PLATFORM_KEY)).toBe('apple')
    expect(keys.map(key => localStorage.getItem(key))).toEqual(['apple', 'apple', 'apple', 'apple'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('apple')
    // Rewriting the same value is a no-op and cannot create an event loop.
    syncPlatformAcrossViews('apple')
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(PLATFORM_CHANGED_EVENT, listener)
  })

  it('prefers the global key over a view-specific legacy key', () => {
    localStorage.setItem(GLOBAL_PLATFORM_KEY, 'spotify')
    localStorage.setItem('desktopModePlatform', 'apple')
    expect(readSyncedPlatform(['apple', 'spotify'], 'desktopModePlatform')).toBe('spotify')
  })

  it('restores every supported platform across views and respects visibility', () => {
    const all = ['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda'] as const
    for (const platform of all) {
      localStorage.clear()
      syncPlatformAcrossViews(platform)
      expect(readSyncedPlatform(all, 'selectedPlatform')).toBe(platform)
      expect(readSyncedPlatform(all, 'explorePlatform')).toBe(platform)
      expect(readSyncedPlatform(all, 'traditionalPlatform')).toBe(platform)
      expect(readSyncedPlatform(all, 'desktopModePlatform')).toBe(platform)
    }
    localStorage.setItem('selectedPlatform', 'spotify')
    expect(readSyncedPlatform(['netease', 'qq'], 'desktopModePlatform')).toBe('netease')
  })

  it('rejects invalid legacy values and uses first visible platform', () => {
    localStorage.setItem('desktopModePlatform', 'legacy-platform')
    expect(readSyncedPlatform(['apple', 'qq'], 'desktopModePlatform')).toBe('apple')
  })

  it('protects reads when localStorage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readSyncedPlatform(['qq', 'apple'], 'desktopModePlatform')).toBe('qq')
    getItem.mockRestore()
  })
})
