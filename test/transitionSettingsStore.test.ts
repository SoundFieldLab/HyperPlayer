import { describe, expect, it, vi } from 'vitest'
import {
  getTransitionSnapshot,
  setCrossfadeDuration,
  setTransitionMode,
  subscribeTransitionSettings,
  TRANSITION_EVENTS,
  TRANSITION_KEYS,
  type TransitionSettingsHost,
} from '../src/services/transitionSettings'

function makeHost(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const events: string[] = []
  const listeners = new Set<() => void>()
  const host: TransitionSettingsHost = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, value) },
    dispatchEvent: (name) => {
      events.push(name)
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
    raw: (key: string) => store.get(key) ?? null,
  }
}

describe('getTransitionSnapshot(host)', () => {
  it('状态未变时返回同一对象，写入后返回新快照', () => {
    const { host } = makeHost()
    const first = getTransitionSnapshot(host)
    expect(getTransitionSnapshot(host)).toBe(first)

    setTransitionMode('crossfade', true, host)
    const next = getTransitionSnapshot(host)

    expect(next).not.toBe(first)
    expect(next.crossfadeEnabled).toBe(true)
  })

  it('把写入后的实际时长回填到快照', () => {
    const { host } = makeHost()
    setCrossfadeDuration(4.5, host)
    expect(getTransitionSnapshot(host).crossfadeDuration).toBe(5)
  })

  it('外部写入配合旧事件后刷新快照', () => {
    const { host } = makeHost()
    getTransitionSnapshot(host)
    const unsubscribe = subscribeTransitionSettings(() => {}, host)

    host.setItem(TRANSITION_KEYS.gaplessEnabled, 'true')
    host.dispatchEvent(TRANSITION_EVENTS.gapless)

    expect(getTransitionSnapshot(host).gaplessEnabled).toBe(true)
    unsubscribe()
  })

  it('不同 host 的快照互不影响', () => {
    const first = makeHost()
    const second = makeHost()
    setTransitionMode('crossfade', true, first.host)

    expect(getTransitionSnapshot(first.host).crossfadeEnabled).toBe(true)
    expect(getTransitionSnapshot(second.host).crossfadeEnabled).toBe(false)
  })
})

describe('subscribeTransitionSettings(host)', () => {
  it('一次逻辑写入只通知一次，即使互斥同时改了两个键', () => {
    const { host } = makeHost()
    setTransitionMode('gapless', true, host)
    const listener = vi.fn()
    const unsubscribe = subscribeTransitionSettings(listener, host)

    setTransitionMode('crossfade', true, host)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getTransitionSnapshot(host).crossfadeEnabled).toBe(true)
    expect(getTransitionSnapshot(host).gaplessEnabled).toBe(false)
    unsubscribe()
  })

  it('外部旧事件只在快照真的变化时通知', () => {
    const { host } = makeHost()
    const listener = vi.fn()
    const unsubscribe = subscribeTransitionSettings(listener, host)

    host.dispatchEvent(TRANSITION_EVENTS.gapless)
    expect(listener).not.toHaveBeenCalled()

    host.setItem(TRANSITION_KEYS.gaplessEnabled, 'true')
    host.dispatchEvent(TRANSITION_EVENTS.gapless)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('取消订阅后不再收到通知', () => {
    const { host } = makeHost()
    const listener = vi.fn()
    const unsubscribe = subscribeTransitionSettings(listener, host)
    unsubscribe()

    setTransitionMode('gapless', true, host)
    expect(listener).not.toHaveBeenCalled()
  })
})
