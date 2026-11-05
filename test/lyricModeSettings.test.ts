import { describe, expect, it } from 'vitest'
import {
  canHideLyricMode,
  commitLyricDisplayMode,
  getLyricModeSnapshot,
  isLyricDisplayMode,
  LYRIC_MODE_EVENTS,
  LYRIC_MODE_KEYS,
  normalizeVisibleLyricModes,
  readLyricDisplayMode,
  readVisibleLyricModes,
  subscribeLyricModeSettings,
  toggleLyricModeVisibility,
  withCurrentLyricModeVisible,
  type LyricDisplayMode,
  type LyricModeEvent,
  type LyricModeHost,
} from '../src/services/lyricModeSettings'

function makeHost(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const events: Array<{ name: string; detail?: LyricDisplayMode }> = []
  const listeners = new Map<string, Set<(event?: LyricModeEvent) => void>>()
  const fire = (name: string, detail?: LyricDisplayMode) => {
    events.push({ name, detail })
    for (const listener of [...(listeners.get(name) ?? [])]) listener({ name, detail })
  }
  const host: LyricModeHost = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, value) },
    dispatchEvent: fire,
    subscribe: (listener) => {
      const names = [LYRIC_MODE_EVENTS.displayMode, LYRIC_MODE_EVENTS.visibleModes]
      for (const name of names) {
        const set = listeners.get(name) ?? new Set()
        set.add(listener)
        listeners.set(name, set)
      }
      return () => {
        for (const name of names) listeners.get(name)?.delete(listener)
      }
    },
  }
  return {
    host,
    events,
    raw: (key: string) => store.get(key) ?? null,
    fire,
  }
}

describe('isLyricDisplayMode', () => {
  it('只接受四个现有模式', () => {
    expect(isLyricDisplayMode('modern')).toBe(true)
    expect(isLyricDisplayMode('pv')).toBe(true)
    expect(isLyricDisplayMode('apple')).toBe(false)
    expect(isLyricDisplayMode(null)).toBe(false)
  })
})

describe('readVisibleLyricModes', () => {
  it('首次读取落库全部模式并置位迁移标记', () => {
    const { host, raw } = makeHost()

    expect(readVisibleLyricModes(host)).toEqual(['modern', 'immersive', 'video', 'pv'])
    expect(JSON.parse(raw(LYRIC_MODE_KEYS.visibleModes)!)).toEqual(['modern', 'immersive', 'video', 'pv'])
    expect(raw(LYRIC_MODE_KEYS.videoMigrated)).toBe('1')
    expect(raw(LYRIC_MODE_KEYS.pvMigrated)).toBe('1')
  })

  it('损坏的历史值回退到默认集合并修复存储', () => {
    const { host, raw } = makeHost({ [LYRIC_MODE_KEYS.visibleModes]: '{not json' })

    expect(readVisibleLyricModes(host)).toEqual(['modern', 'immersive', 'video', 'pv'])
    expect(JSON.parse(raw(LYRIC_MODE_KEYS.visibleModes)!)).toEqual(['modern', 'immersive', 'video', 'pv'])
  })

  it('过滤非法值、去重并把现代模式补到首位', () => {
    const { host } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['pv', 'nope', 'pv', 'immersive']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })

    expect(readVisibleLyricModes(host)).toEqual(['modern', 'pv', 'immersive'])
  })

  it('现代模式已在集合里但不在首位时也移到首位', () => {
    expect(normalizeVisibleLyricModes(['pv', 'modern', 'immersive'])).toEqual([
      'modern', 'pv', 'immersive',
    ])
  })

  it('补齐历史缺失的看歌与 PV，只补一次', () => {
    const { host } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern', 'immersive']),
    })

    expect(readVisibleLyricModes(host)).toEqual(['modern', 'immersive', 'video', 'pv'])
    // 迁移后用户隐藏看歌，再读不应复活
    toggleLyricModeVisibility('video', 'modern', host)
    expect(readVisibleLyricModes(host)).toEqual(['modern', 'immersive', 'pv'])
  })

  it('迁移标记已存在时不再补回用户隐藏的模式', () => {
    const { host } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern', 'immersive']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })

    expect(readVisibleLyricModes(host)).toEqual(['modern', 'immersive'])
  })

  it('新用户隐藏看歌后重载不会复活', () => {
    const { host } = makeHost()
    expect(readVisibleLyricModes(host)).toEqual(['modern', 'immersive', 'video', 'pv'])

    toggleLyricModeVisibility('video', 'modern', host)

    expect(readVisibleLyricModes(host)).toEqual(['modern', 'immersive', 'pv'])
  })
})

describe('readLyricDisplayMode', () => {
  it('非法值回退到现代模式', () => {
    const { host } = makeHost({ [LYRIC_MODE_KEYS.displayMode]: 'apple-music' })
    expect(readLyricDisplayMode(host)).toBe('modern')
  })

  it('读取已保存的合法模式', () => {
    const { host } = makeHost({ [LYRIC_MODE_KEYS.displayMode]: 'video' })
    expect(readLyricDisplayMode(host)).toBe('video')
  })
})

describe('normalizeVisibleLyricModes / withCurrentLyricModeVisible', () => {
  it('空值也保证现代模式存在', () => {
    expect(normalizeVisibleLyricModes(undefined)).toEqual(['modern'])
  })

  it('当前模式不在可见列表时临时补入，不改存储', () => {
    expect(withCurrentLyricModeVisible(['modern', 'immersive'], 'pv')).toEqual([
      'modern', 'immersive', 'pv',
    ])
    expect(withCurrentLyricModeVisible(['modern', 'pv'], 'pv')).toEqual(['modern', 'pv'])
  })
})

describe('commitLyricDisplayMode', () => {
  it('落库、派发带 detail 的事件并只通知一次', () => {
    const { host, events, raw } = makeHost()
    let notifications = 0
    subscribeLyricModeSettings(() => { notifications += 1 }, host)

    expect(commitLyricDisplayMode('immersive', host)).toBe(true)

    expect(raw(LYRIC_MODE_KEYS.displayMode)).toBe('immersive')
    expect(events).toEqual([{ name: LYRIC_MODE_EVENTS.displayMode, detail: 'immersive' }])
    expect(notifications).toBe(1)
    expect(getLyricModeSnapshot(host).displayMode).toBe('immersive')
  })

  it('相同模式重复提交不触发订阅', () => {
    const { host } = makeHost({ [LYRIC_MODE_KEYS.displayMode]: 'pv' })
    let notifications = 0
    subscribeLyricModeSettings(() => { notifications += 1 }, host)

    commitLyricDisplayMode('pv', host)

    expect(notifications).toBe(0)
  })
})

describe('toggleLyricModeVisibility', () => {
  it('隐藏非当前模式并落库', () => {
    const { host, raw, events } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern', 'immersive', 'video', 'pv']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })

    expect(toggleLyricModeVisibility('pv', 'modern', host)).toEqual(['modern', 'immersive', 'video'])
    expect(JSON.parse(raw(LYRIC_MODE_KEYS.visibleModes)!)).toEqual(['modern', 'immersive', 'video'])
    expect(events).toEqual([{ name: LYRIC_MODE_EVENTS.visibleModes, detail: undefined }])
  })

  it('不能隐藏当前模式或现代模式', () => {
    const { host } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern', 'immersive']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })

    expect(toggleLyricModeVisibility('immersive', 'immersive', host)).toBeNull()
    expect(toggleLyricModeVisibility('modern', 'immersive', host)).toBeNull()
  })

  it('被规则拒绝时不落库、不派发、不通知', () => {
    const { host, events } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern', 'immersive']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })
    let notifications = 0
    subscribeLyricModeSettings(() => { notifications += 1 }, host)

    expect(toggleLyricModeVisibility('immersive', 'immersive', host)).toBeNull()

    expect(events).toEqual([])
    expect(notifications).toBe(0)
  })

  it('切换可见性只通知一次', () => {
    const { host } = makeHost()
    let notifications = 0
    subscribeLyricModeSettings(() => { notifications += 1 }, host)

    toggleLyricModeVisibility('pv', 'modern', host)

    expect(notifications).toBe(1)
  })

  it('切换其他模式不会把临时显示的当前模式永久写回', () => {
    const { host, raw } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })

    // 当前处于已隐藏的 immersive：界面上临时可见，但存储里仍应保持隐藏
    toggleLyricModeVisibility('pv', 'immersive', host)

    expect(JSON.parse(raw(LYRIC_MODE_KEYS.visibleModes)!)).toEqual(['modern', 'pv'])
  })

  it('非法模式不会写进可见列表', () => {
    const { host, raw } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern', 'immersive']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })
    const before = raw(LYRIC_MODE_KEYS.visibleModes)

    expect(toggleLyricModeVisibility('bogus' as LyricDisplayMode, 'modern', host)).toBeNull()
    expect(raw(LYRIC_MODE_KEYS.visibleModes)).toBe(before)
  })

  it('重新显示时追加到末尾', () => {
    const { host } = makeHost({
      [LYRIC_MODE_KEYS.visibleModes]: JSON.stringify(['modern', 'immersive']),
      [LYRIC_MODE_KEYS.videoMigrated]: '1',
      [LYRIC_MODE_KEYS.pvMigrated]: '1',
    })

    expect(toggleLyricModeVisibility('video', 'modern', host)).toEqual([
      'modern', 'immersive', 'video',
    ])
  })
})

describe('canHideLyricMode', () => {
  it('当前模式、现代模式、最后一个可见模式不可隐藏', () => {
    expect(canHideLyricMode('immersive', 'immersive', ['modern', 'immersive'])).toBe(false)
    expect(canHideLyricMode('modern', 'immersive', ['modern', 'immersive'])).toBe(false)
    expect(canHideLyricMode('immersive', 'modern', ['modern', 'immersive'])).toBe(true)
    expect(canHideLyricMode('pv', 'immersive', ['modern', 'immersive', 'pv'])).toBe(true)
  })
})

describe('subscribeLyricModeSettings', () => {
  it('外部写入配合旧事件刷新快照', () => {
    const { host, fire } = makeHost()
    const snapshots: Array<{ displayMode: string; visibleModes: string[] }> = []
    subscribeLyricModeSettings(() => {
      const snapshot = getLyricModeSnapshot(host)
      snapshots.push({ displayMode: snapshot.displayMode, visibleModes: [...snapshot.visibleModes] })
    }, host)

    host.setItem(LYRIC_MODE_KEYS.displayMode, 'video')
    fire(LYRIC_MODE_EVENTS.displayMode)

    expect(snapshots).toEqual([{ displayMode: 'video', visibleModes: ['modern', 'immersive', 'video', 'pv'] }])
  })

  it('只带 detail、未写存储的旧事件也会被采纳并补齐存储', () => {
    const { host, raw } = makeHost()
    let notifications = 0
    subscribeLyricModeSettings(() => { notifications += 1 }, host)

    host.dispatchEvent(LYRIC_MODE_EVENTS.displayMode, 'pv')

    expect(getLyricModeSnapshot(host).displayMode).toBe('pv')
    expect(raw(LYRIC_MODE_KEYS.displayMode)).toBe('pv')
    expect(notifications).toBe(1)
  })

  it('快照未变化时返回同一对象', () => {
    const { host } = makeHost()
    const first = getLyricModeSnapshot(host)
    expect(getLyricModeSnapshot(host)).toBe(first)
  })
})
