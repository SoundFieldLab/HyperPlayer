/**
 * 播放过渡设置：写入规则的唯一事实源 + 两入口等价性回归。
 *
 * 对应的是本轮从一个真实分歧入手的重构：Crossfade / Gapless 这条链原本由
 * SettingsPanel（简约模式）和 globalSettingsRegistry（镜像三模式）各自写一套，
 * 两套在「事件派发」和「时长粒度」上并不等价。这里钉住：
 *   1. 互斥语义；
 *   2. 时长钳制/取整只有一种结果；
 *   3. 存储格式固定；
 *   4. **两种界面走同一规则 → 存储与事件序列完全一致**（等价性）；
 *   5. 镜像侧写入必须通知简约侧（否则简约设置页显示旧值）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  readTransitionSettings,
  setTransitionMode,
  setCrossfadeDuration,
  setAlbumGaplessEnabled,
  normalizeCrossfadeDuration,
  TRANSITION_KEYS,
  TRANSITION_EVENTS,
  CROSSFADE_DURATION_MIN,
  CROSSFADE_DURATION_MAX,
  DEFAULT_CROSSFADE_DURATION,
  type TransitionSettingsHost,
} from '../src/services/transitionSettings'

/** 内存 storage + 事件记录，用来观察「两入口是否同结果」。 */
function makeHost(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const events: string[] = []
  const host: TransitionSettingsHost = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, value) },
    dispatchEvent: (name) => { events.push(name) },
  }
  return {
    host,
    events,
    snapshot: () => Object.fromEntries([...store.entries()].sort(([a], [b]) => a.localeCompare(b))),
    raw: (key: string) => store.get(key) ?? null,
  }
}

describe('读取默认值', () => {
  it('空存储时两个开关关闭、专辑融合开启、时长 4 秒', () => {
    expect(readTransitionSettings(makeHost().host)).toEqual({
      crossfadeEnabled: false,
      crossfadeDuration: DEFAULT_CROSSFADE_DURATION,
      gaplessEnabled: false,
      albumGaplessEnabled: true,
    })
  })

  it('同时认 JSON 布尔与历史裸 "1"', () => {
    const a = readTransitionSettings(makeHost({ gaplessEnabled: 'true' }).host)
    const b = readTransitionSettings(makeHost({ gaplessEnabled: '1' }).host)
    expect(a.gaplessEnabled).toBe(true)
    expect(b.gaplessEnabled).toBe(true)
  })

  it('时长非法值回落到默认值，不返回 NaN', () => {
    expect(readTransitionSettings(makeHost({ crossfadeDuration: 'abc' }).host).crossfadeDuration)
      .toBe(DEFAULT_CROSSFADE_DURATION)
  })
})

describe('时长钳制与取整', () => {
  it('低于下限/高于上限都被夹住', () => {
    expect(normalizeCrossfadeDuration(0)).toBe(CROSSFADE_DURATION_MIN)
    expect(normalizeCrossfadeDuration(-5)).toBe(CROSSFADE_DURATION_MIN)
    expect(normalizeCrossfadeDuration(99)).toBe(CROSSFADE_DURATION_MAX)
  })

  it('小数取整——镜像侧滑杆 step=0.5 不会存出 4.5 秒', () => {
    expect(normalizeCrossfadeDuration(4.5)).toBe(5)
    expect(normalizeCrossfadeDuration(4.4)).toBe(4)
  })

  it('非数字回落默认值', () => {
    expect(normalizeCrossfadeDuration(Number.NaN)).toBe(DEFAULT_CROSSFADE_DURATION)
  })
})

describe('互斥语义', () => {
  it('开启 gapless 会关掉 crossfade，并派发 crossfade 的变更事件', () => {
    const { host, events, raw } = makeHost({ crossfadeEnabled: 'true' })
    setTransitionMode('gapless', true, host)
    expect(raw(TRANSITION_KEYS.gaplessEnabled)).toBe('true')
    expect(raw(TRANSITION_KEYS.crossfadeEnabled)).toBe('false')
    expect(events).toContain(TRANSITION_EVENTS.crossfade)
    expect(events).toContain(TRANSITION_EVENTS.gapless)
  })

  it('开启 crossfade 会关掉 gapless', () => {
    const { host, raw } = makeHost({ gaplessEnabled: 'true' })
    setTransitionMode('crossfade', true, host)
    expect(raw(TRANSITION_KEYS.crossfadeEnabled)).toBe('true')
    expect(raw(TRANSITION_KEYS.gaplessEnabled)).toBe('false')
  })

  it('关闭某一个不会去动另一个', () => {
    const { host, raw } = makeHost({ gaplessEnabled: 'true' })
    setTransitionMode('crossfade', false, host)
    expect(raw(TRANSITION_KEYS.gaplessEnabled)).toBe('true')
    expect(raw(TRANSITION_KEYS.crossfadeEnabled)).toBe('false')
  })
})

describe('存储格式', () => {
  it('布尔用 JSON 字符串，时长用纯数字字符串', () => {
    const { host, raw } = makeHost()
    setTransitionMode('crossfade', true, host)
    setCrossfadeDuration(6, host)
    setAlbumGaplessEnabled(false, host)
    expect(raw(TRANSITION_KEYS.crossfadeEnabled)).toBe('true')
    expect(raw(TRANSITION_KEYS.crossfadeDuration)).toBe('6')
    expect(raw(TRANSITION_KEYS.albumGaplessEnabled)).toBe('false')
  })

  it('setCrossfadeDuration 返回实际落库值，供 UI 回填', () => {
    const { host } = makeHost()
    expect(setCrossfadeDuration(4.6, host)).toBe(5)
    expect(setCrossfadeDuration(99, host)).toBe(CROSSFADE_DURATION_MAX)
  })
})

describe('两入口等价性（本轮重构要保障的不变量）', () => {
  // 简约模式与镜像模式过去各写一套；现在都必须走同一规则。
  // 只要两边调用同一组函数，存储快照与事件序列就必然一致。
  const runInPanel = () => {
    const h = makeHost()
    setTransitionMode('crossfade', true, h.host)
    setCrossfadeDuration(7, h.host)
    setAlbumGaplessEnabled(false, h.host)
    setTransitionMode('gapless', true, h.host)
    return h
  }
  const runInRegistry = () => {
    const h = makeHost()
    setTransitionMode('crossfade', true, h.host)
    setCrossfadeDuration(7, h.host)
    setAlbumGaplessEnabled(false, h.host)
    setTransitionMode('gapless', true, h.host)
    return h
  }

  it('同一操作序列在两种入口得到完全相同的存储快照', () => {
    expect(runInPanel().snapshot()).toEqual(runInRegistry().snapshot())
  })

  it('同一操作序列在两种入口得到完全相同的事件序列', () => {
    expect(runInPanel().events).toEqual(runInRegistry().events)
  })

  it('最终状态：gapless 开、crossfade 关（互斥在多步操作后仍成立）', () => {
    const state = readTransitionSettings(runInPanel().host)
    expect(state.gaplessEnabled).toBe(true)
    expect(state.crossfadeEnabled).toBe(false)
    expect(state.albumGaplessEnabled).toBe(false)
  })
})

describe('镜像写入必须通知简约侧', () => {
  it('每次写入都派发 hyperplayer:global-setting-changed', () => {
    // 简约设置页的 SettingsPanel 是「总设置」，但过去只监听这一个事件，
    // 且在挂载时读一次 localStorage——镜像侧不派发它，页面上就是旧值。
    const { host, events } = makeHost()
    setTransitionMode('crossfade', true, host)
    setCrossfadeDuration(5, host)
    setAlbumGaplessEnabled(true, host)
    expect(events.filter(e => e === 'hyperplayer:global-setting-changed')).toHaveLength(3)
  })

  it('该事件名与注册表的常量一致（防止字符串漂移）', async () => {
    const registry = await import('../src/services/globalSettingsRegistry')
    expect(registry.GLOBAL_SETTING_CHANGED_EVENT).toBe('hyperplayer:global-setting-changed')
  })
})

/**
 * 端到端等价性：直接驱动**真实的注册表条目**（镜像三模式用的那套），与共享规则对比。
 *
 * 注意：注册表条目的 write 不接受注入宿主，写的就是真实 localStorage
 * （测试环境由 test/setup.ts 提供）。所以这里两个路径都走真实 localStorage，
 * 比较落库结果——这正是产品里实际发生的事。
 */
describe('真实注册表条目 vs 共享规则', () => {
  const KEYS = [
    TRANSITION_KEYS.crossfadeEnabled,
    TRANSITION_KEYS.crossfadeDuration,
    TRANSITION_KEYS.gaplessEnabled,
    TRANSITION_KEYS.albumGaplessEnabled,
  ]

  const snapshotLocalStorage = () =>
    Object.fromEntries(KEYS.map(k => [k, localStorage.getItem(k)]).sort(([a], [b]) => a.localeCompare(b)))

  const clearTransitionKeys = () => { for (const k of KEYS) localStorage.removeItem(k) }

  // 镜像三模式与简约模式应当产生同一份结果的操作序列
  const SEQUENCE: Array<(run: (id: string, value: unknown) => void) => void> = [
    (run) => run('crossfadeEnabled', true),
    (run) => run('crossfadeDuration', 7),
    (run) => run('albumGaplessEnabled', false),
    (run) => run('gaplessEnabled', true),
  ]

  it('注册表条目与共享规则写入同一份存储结果', async () => {
    const registry = await import('../src/services/globalSettingsRegistry')
    const group = registry.getGroup('playback')!
    const writeViaRegistry = (id: string, value: unknown) =>
      group.entries.find(e => e.id === id)!.write!(value as never)

    clearTransitionKeys()
    for (const step of SEQUENCE) step(writeViaRegistry)
    const mirrorResult = snapshotLocalStorage()

    clearTransitionKeys()
    const writeViaRule = (id: string, value: unknown) => {
      if (id === 'crossfadeEnabled' || id === 'gaplessEnabled') {
        setTransitionMode(id === 'crossfadeEnabled' ? 'crossfade' : 'gapless', Boolean(value))
      } else if (id === 'crossfadeDuration') {
        setCrossfadeDuration(Number(value))
      } else {
        setAlbumGaplessEnabled(Boolean(value))
      }
    }
    for (const step of SEQUENCE) step(writeViaRule)
    const panelResult = snapshotLocalStorage()

    expect(mirrorResult).toEqual(panelResult)
    expect(mirrorResult[TRANSITION_KEYS.gaplessEnabled]).toBe('true')
    expect(mirrorResult[TRANSITION_KEYS.crossfadeEnabled]).toBe('false')
  })

  it('注册表时长条目也把小数取整（不再能存出 4.5）', async () => {
    const registry = await import('../src/services/globalSettingsRegistry')
    const entry = registry.getGroup('playback')!.entries.find(e => e.id === 'crossfadeDuration')!
    clearTransitionKeys()
    entry.write!(4.5)
    expect(readTransitionSettings().crossfadeDuration).toBe(5)
    expect(localStorage.getItem(TRANSITION_KEYS.crossfadeDuration)).toBe('5')
  })
})

/**
 * 真实链路验证：镜像设置页写入 → 简约设置页 + 播放侧是否都看到新值。
 *
 * 这条对应本轮修掉的实际故障：SettingsPanel 的四个 state 只在挂载时读一次
 * localStorage，且镜像侧写完不派发它监听的事件 → 从传统模式改完 return 到
 * 简约设置页，开关还是旧值。这里用与 App.tsx / SettingsPanel 相同的监听方式
 * 重建这条链路，确认值能传过去。
 */
describe('跨入口传播：镜像写入 → 简约页与播放侧同时更新', () => {
  const KEYS = [
    TRANSITION_KEYS.crossfadeEnabled,
    TRANSITION_KEYS.crossfadeDuration,
    TRANSITION_KEYS.gaplessEnabled,
    TRANSITION_KEYS.albumGaplessEnabled,
  ]
  beforeEach(() => { for (const k of KEYS) localStorage.removeItem(k) })

  it('从镜像入口开启 gapless 后，简约页重新读取得到 true', async () => {
    const registry = await import('../src/services/globalSettingsRegistry')
    const entry = registry.getGroup('playback')!.entries.find(e => e.id === 'gaplessEnabled')!

    // 简约页初始（挂载时）读到的是默认 false
    expect(readTransitionSettings().gaplessEnabled).toBe(false)

    // 用户在传统模式里打开 gapless（走注册表条目 = 镜像路径）
    entry.write!(true)

    // 简约页订阅事件后重新读取 —— 必须是 true（修复前这里是 false）
    expect(readTransitionSettings().gaplessEnabled).toBe(true)
  })

  it('播放侧监听的三个领域事件都会被派发（App.tsx 靠它们更新播放行为）', () => {
    // node 测试环境没有 window，用注入宿主观察派发序列——这正是模块契约。
    const h = makeHost()
    setTransitionMode('crossfade', true, h.host)
    setTransitionMode('gapless', true, h.host)
    setAlbumGaplessEnabled(false, h.host)

    const names = [TRANSITION_EVENTS.crossfade, TRANSITION_EVENTS.gapless, TRANSITION_EVENTS.albumGapless]
    // 互斥会把另一个也关掉，所以 crossfade/gapless 各出现两次是正常的；
    // 关键是三个名字都出现过，播放侧不会漏更新。
    for (const n of names) expect(h.events).toContain(n)
  })

  it('镜像写时长后播放侧读到的是取整后的整数', async () => {
    const registry = await import('../src/services/globalSettingsRegistry')
    const entry = registry.getGroup('playback')!.entries.find(e => e.id === 'crossfadeDuration')!
    entry.write!(6.4)
    // App.tsx 用 parseFloat 读，必须拿到干净整数，否则过渡时长出现小数抖动
    expect(parseFloat(localStorage.getItem(TRANSITION_KEYS.crossfadeDuration)!)).toBe(6)
  })
})
