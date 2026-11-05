/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import {
  getPlaybackDisplaySnapshot,
  readPlaybackDisplaySettings,
  subscribePlaybackDisplaySettings,
  setModernAudioVisualizerEnabled,
  setMvBackgroundEnabled,
  setPlayerTheme,
  setRomanEnabled,
  setHideImmersiveSongInfo,
  setShowUpNextOutsidePlayer,
  setTranslationEnabled,
  setTranslationPosition,
  setUpNextEnabled,
  setUpNextSeconds,
  PLAYBACK_DISPLAY_EVENTS,
  PLAYBACK_DISPLAY_KEYS,
  normalizeUpNextSeconds,
  type PlaybackDisplayHost,
} from '../src/services/playbackDisplaySettings'

function makeHost(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const events: string[] = []
  const details: Array<{ name: string; detail?: unknown }> = []
  const listeners = new Set<() => void>()
  const host: PlaybackDisplayHost = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, value) },
    dispatchEvent: (name, detail) => {
      events.push(name)
      details.push({ name, detail })
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    host,
    events,
    details,
    raw: (key: string) => store.get(key) ?? null,
    fire: (name: string) => {
      events.push(name)
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('读取默认值与非法值', () => {
  it('默认值与旧行为一致', () => {
    expect(readPlaybackDisplaySettings(makeHost().host)).toEqual({
      upNextEnabled: true,
      showUpNextOutsidePlayer: false,
      upNextSeconds: 10,
      translationEnabled: false,
      translationPosition: 'traditional',
      romanEnabled: false,
      mvBackgroundEnabled: false,
      modernAudioVisualizerEnabled: true,
      hideImmersiveSongInfo: false,
      playerTheme: 'dark',
    })
  })

  it('布尔兼容 JSON 与历史裸 "1"，非法枚举回落默认值', () => {
    const state = readPlaybackDisplaySettings(makeHost({
      [PLAYBACK_DISPLAY_KEYS.upNextEnabled]: '1',
      [PLAYBACK_DISPLAY_KEYS.translationPosition]: 'invalid',
      [PLAYBACK_DISPLAY_KEYS.mvBackgroundEnabled]: 'true',
    }).host)

    expect(state.upNextEnabled).toBe(true)
    expect(state.translationPosition).toBe('traditional')
    expect(state.mvBackgroundEnabled).toBe(true)
  })
})

describe('upNext 秒数', () => {
  it('钳制并取整到 [5,30]', () => {
    expect(normalizeUpNextSeconds(4.4)).toBe(5)
    expect(normalizeUpNextSeconds(17.6)).toBe(18)
    expect(normalizeUpNextSeconds(Number.NaN)).toBe(10)
    expect(normalizeUpNextSeconds(99)).toBe(30)
  })

  it('写入返回实际落库值并派发历史事件', () => {
    const { host, events, raw } = makeHost()
    expect(setUpNextSeconds(4.4, host)).toBe(5)

    expect(raw(PLAYBACK_DISPLAY_KEYS.upNextSeconds)).toBe('5')
    expect(events.filter((name) => name !== 'hyperplayer:global-setting-changed'))
      .toEqual([PLAYBACK_DISPLAY_EVENTS.upNextSeconds])
    expect(getPlaybackDisplaySnapshot(host).upNextSeconds).toBe(5)
  })
})

describe('开关写入与事件', () => {
  it('统一布尔存储格式，历史事件名不变', () => {
    const { host, events, raw } = makeHost()

    setUpNextEnabled(false, host)
    setShowUpNextOutsidePlayer(true, host)
    setTranslationEnabled(true, host)
    setRomanEnabled(true, host)
    setMvBackgroundEnabled(true, host)
    setModernAudioVisualizerEnabled(false, host)
    setHideImmersiveSongInfo(true, host)

    expect(raw(PLAYBACK_DISPLAY_KEYS.upNextEnabled)).toBe('false')
    expect(raw(PLAYBACK_DISPLAY_KEYS.showUpNextOutsidePlayer)).toBe('true')
    expect(raw(PLAYBACK_DISPLAY_KEYS.translationEnabled)).toBe('true')
    expect(raw(PLAYBACK_DISPLAY_KEYS.romanEnabled)).toBe('true')
    expect(raw(PLAYBACK_DISPLAY_KEYS.mvBackgroundEnabled)).toBe('true')
    expect(raw(PLAYBACK_DISPLAY_KEYS.modernAudioVisualizerEnabled)).toBe('false')
    expect(raw(PLAYBACK_DISPLAY_KEYS.hideImmersiveSongInfo)).toBe('true')

    expect(events.filter((name) => name !== 'hyperplayer:global-setting-changed')).toEqual([
      PLAYBACK_DISPLAY_EVENTS.upNextEnabled,
      PLAYBACK_DISPLAY_EVENTS.showUpNextOutsidePlayer,
      PLAYBACK_DISPLAY_EVENTS.translationEnabled,
      PLAYBACK_DISPLAY_EVENTS.romanEnabled,
      PLAYBACK_DISPLAY_EVENTS.mvBackground,
      PLAYBACK_DISPLAY_EVENTS.modernAudioVisualizer,
      PLAYBACK_DISPLAY_EVENTS.hideImmersiveSongInfo,
    ])
  })

  it('翻译位置与主题派发带 detail 的历史事件', () => {
    const { host, events, raw, details } = makeHost()
    setTranslationPosition('bottom-right', host)
    setPlayerTheme('light', host)

    expect(raw(PLAYBACK_DISPLAY_KEYS.translationPosition)).toBe('bottom-right')
    expect(raw(PLAYBACK_DISPLAY_KEYS.playerTheme)).toBe('light')
    expect(events.filter((name) => name !== 'hyperplayer:global-setting-changed')).toEqual([
      PLAYBACK_DISPLAY_EVENTS.translationPosition,
      PLAYBACK_DISPLAY_EVENTS.translationEnabled,
      PLAYBACK_DISPLAY_EVENTS.playerTheme,
    ])
    expect(details).toContainEqual({
      name: PLAYBACK_DISPLAY_EVENTS.translationPosition,
      detail: 'bottom-right',
    })
    expect(details).toContainEqual({
      name: PLAYBACK_DISPLAY_EVENTS.playerTheme,
      detail: 'light',
    })
  })

  it('写入 value 未变化时不通知订阅者', () => {
    const { host } = makeHost()
    setUpNextEnabled(true, host)
    let notifications = 0
    subscribePlaybackDisplaySettings(() => { notifications += 1 }, host)

    setUpNextEnabled(true, host)

    expect(notifications).toBe(0)
  })
})

describe('快照与订阅', () => {
  it('快照未变化返回同一对象，一次写入只通知一次', () => {
    const { host } = makeHost()
    const first = getPlaybackDisplaySnapshot(host)
    expect(getPlaybackDisplaySnapshot(host)).toBe(first)

    let notifications = 0
    subscribePlaybackDisplaySettings(() => { notifications += 1 }, host)
    setShowUpNextOutsidePlayer(true, host)

    const second = getPlaybackDisplaySnapshot(host)
    expect(second).not.toBe(first)
    expect(notifications).toBe(1)
  })

  it('外部写入配合旧事件刷新快照', () => {
    const { host, fire } = makeHost()
    subscribePlaybackDisplaySettings(() => {}, host)

    host.setItem(PLAYBACK_DISPLAY_KEYS.translationEnabled, 'true')
    fire(PLAYBACK_DISPLAY_EVENTS.translationEnabled)

    expect(getPlaybackDisplaySnapshot(host).translationEnabled).toBe(true)
  })
})

describe('注册表条目等价性', () => {
  const ids = [
    PLAYBACK_DISPLAY_KEYS.upNextEnabled,
    PLAYBACK_DISPLAY_KEYS.showUpNextOutsidePlayer,
    PLAYBACK_DISPLAY_KEYS.upNextSeconds,
    PLAYBACK_DISPLAY_KEYS.translationEnabled,
    PLAYBACK_DISPLAY_KEYS.translationPosition,
  ] as const

  it('注册表条目与共享规则写入同一份存储结果', async () => {
    const registry = await import('../src/services/globalSettingsRegistry')
    const run = async (useRegistry: boolean) => {
      for (const key of ids) localStorage.removeItem(key)
      if (useRegistry) {
        for (const key of ids) {
          const entry = [
            ...registry.getGroup('shortcuts')!.entries,
            ...registry.getGroup('lyrics')!.entries,
          ].find(item => item.id === key)!
          entry.write!(key === PLAYBACK_DISPLAY_KEYS.upNextSeconds
            ? 6.4
            : key === PLAYBACK_DISPLAY_KEYS.translationPosition
              ? 'bottom-right'
              : true)
        }
      } else {
        setUpNextEnabled(true)
        setShowUpNextOutsidePlayer(true)
        setUpNextSeconds(6.4)
        setTranslationEnabled(true)
        setTranslationPosition('bottom-right')
      }
      return ids.map(key => localStorage.getItem(key))
    }

    const mirror = await run(true)
    const shared = await run(false)

    expect(mirror).toEqual(shared)
    expect(shared[2]).toBe('6')
    expect(shared[4]).toBe('bottom-right')
  })

  it('注册表读取与共享快照一致（含 visibleIf 依赖）', async () => {
    const registry = await import('../src/services/globalSettingsRegistry')
    localStorage.clear()
    setTranslationEnabled(true)
    setUpNextSeconds(22)

    const lyrics = registry.getGroup('lyrics')!.entries
    const shortcuts = registry.getGroup('shortcuts')!.entries
    const snapshot = getPlaybackDisplaySnapshot()

    expect(lyrics.find(entry => entry.id === 'translationEnabled')!.read()).toBe(true)
    expect(lyrics.find(entry => entry.id === 'translationPosition')!.visibleIf?.()).toBe(true)
    expect(shortcuts.find(entry => entry.id === 'upNextSeconds')!.read()).toBe(snapshot.upNextSeconds)
    expect(snapshot.upNextSeconds).toBe(22)
  })
})
