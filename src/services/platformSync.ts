import { MUSIC_PLATFORMS, type MusicPlatform } from './platforms'

/** 全局平台键；四个视图键保留用于兼容旧版本。 */
export const GLOBAL_PLATFORM_KEY = 'hyperplayer:platform'
export const LEGACY_PLATFORM_KEYS = ['selectedPlatform', 'explorePlatform', 'traditionalPlatform', 'desktopModePlatform'] as const
const PLATFORM_KEYS = [GLOBAL_PLATFORM_KEY, ...LEGACY_PLATFORM_KEYS] as const
export const PLATFORM_CHANGED_EVENT = 'hyperplayer-platform-changed'

export function isMusicPlatform(value: unknown): value is MusicPlatform {
  return typeof value === 'string' && (MUSIC_PLATFORMS as readonly string[]).includes(value)
}

/**
 * 从全局键或四个历史键恢复平台，并立即按当前可见平台归一化。
 * preferredKey 仅影响历史键之间的优先级，全局键始终优先。
 */
export function readSyncedPlatform(
  visiblePlatforms: readonly MusicPlatform[],
  preferredKey: typeof LEGACY_PLATFORM_KEYS[number],
): MusicPlatform {
  const order = [GLOBAL_PLATFORM_KEY, preferredKey, ...LEGACY_PLATFORM_KEYS.filter(key => key !== preferredKey)]
  for (const key of order) {
    let value: string | null = null
    try { value = localStorage.getItem(key) } catch { continue }
    if (isMusicPlatform(value) && visiblePlatforms.includes(value)) return value
  }
  return visiblePlatforms[0] || 'netease'
}

/** 任一视图切换平台时同步全局键、旧视图键并广播。 */
export function syncPlatformAcrossViews(platform: MusicPlatform): void {
  if (!isMusicPlatform(platform)) return
  let changed = false
  for (const key of PLATFORM_KEYS) {
    try {
      if (localStorage.getItem(key) !== platform) {
        localStorage.setItem(key, platform)
        changed = true
      }
    } catch { /* 存储不可用时忽略 */ }
  }
  if (changed) {
    try { window.dispatchEvent(new CustomEvent<MusicPlatform>(PLATFORM_CHANGED_EVENT, { detail: platform })) } catch { /* 忽略 */ }
  }
}
