/**
 * 迁移等价性回归：把旧分散实现字面复刻成 legacy，逐个与新 module 对比。
 *
 * 这条测试存在的理由：两轮架构深化里，双审抓到的 6 个真实回归全都是「新 module
 * 与旧实现语义不同」——QQ 歌曲用 id 而非 mid 去重、导航 replace 丢多级历史、
 * FIFO 重写被搬队尾、TtlCache.set 每次全表扫过期、注册表双重派发、第三方翻译
 * 全超阈值仍误记来源。它们都能被这类对比钉住，而当时没有任何确定性检查。
 *
 * 新增迁移时：把旧代码复制进本文件的 legacy* 函数（保持原样，不要美化），
 * 再为它补一组 case。不要删掉已有的 legacy 复刻——它们是旧行为的可执行证据。
 */

import { describe, expect, it } from 'vitest'
import { runEquivalence } from './helpers/equivalence'
import { TtlCache } from '../server/ttl-cache.mjs'
import { DetailNavigationLedger } from '../src/services/detailNavigation'
import { normalizeUpNextSeconds } from '../src/services/playbackDisplaySettings'
import {
  detectLyricsCapabilities,
  isMetadataOnlyLyrics,
  mergeLyricsWithTranslationAndRoman,
} from '../src/services/lyricsSelection'
import type { LyricLine, Song } from '../src/services/musicApi'

// ─────────────────────────────────────────────────────────────
// 1. 歌曲身份：App 旧 getSongKey
// ─────────────────────────────────────────────────────────────

/** 旧实现（App.tsx，重构前）：platform-mid||id */
const legacySongKey = (song: Song): string => `${song.platform || 'netease'}-${song.mid || song.id}`

/** 新实现：通过详情导航账本的去重行为观察身份判据。 */
const ledgerDedupes = (songs: [Song, Song]): boolean => {
  const ledger = new DetailNavigationLedger()
  ledger.push({ type: 'song', song: songs[0] })
  ledger.push({ type: 'song', song: songs[1] })
  return ledger.size === 1
}

describe('歌曲身份（detailNavigation vs App.getSongKey）', () => {
  const song = (patch: Partial<Song>): Song => ({
    id: 1,
    name: 's',
    artists: [],
    album: { id: 1, name: 'a' },
    duration: 1000,
    ...patch,
  } as Song)

  const cases: Array<{ name: string; input: [Song, Song] }> = [
    {
      name: '网易云同 id',
      input: [song({ platform: 'netease', id: 1 }), song({ platform: 'netease', id: 1 })],
    },
    {
      name: '网易云不同 id',
      input: [song({ platform: 'netease', id: 1 }), song({ platform: 'netease', id: 2 })],
    },
    {
      name: 'QQ 同 mid 不同 id',
      input: [song({ platform: 'qq', id: 1, mid: 'abc' }), song({ platform: 'qq', id: 2, mid: 'abc' })],
    },
    {
      name: 'QQ 同 id 不同 mid',
      input: [song({ platform: 'qq', id: 1, mid: 'a' }), song({ platform: 'qq', id: 1, mid: 'b' })],
    },
    {
      name: 'QQ 搜索结果 id=0（musicApi 缺省映射）',
      input: [song({ platform: 'qq', id: 0, mid: 'x' }), song({ platform: 'qq', id: 0, mid: 'y' })],
    },
    {
      name: '跨平台同 id',
      input: [song({ platform: 'netease', id: 1 }), song({ platform: 'qq', id: 1, mid: 'z' })],
    },
  ]

  const results = runEquivalence(
    cases,
    ([a, b]) => legacySongKey(a) === legacySongKey(b),
    pair => ledgerDedupes(pair),
  )

  for (const result of results) {
    it(result.name, () => {
      expect(result.current).toBe(result.legacy)
    })
  }
})

// ─────────────────────────────────────────────────────────────
// 2. 进程内缓存：旧 Map + expiresAt + while(size>max)
// ─────────────────────────────────────────────────────────────

interface LegacyCacheOptions {
  ttlMs: number
  maxEntries: number
  /** 旧实现在超限时一次收缩到的条数；缺省表示一次只淘汰一条。 */
  evictTo?: number
}

/**
 * 旧实现复刻：Map 直接存 { value, expiresAt }，命中不调序（FIFO），
 * 重写同一个键走 Map.set —— 保持原队位。
 */
function legacyCache(options: LegacyCacheOptions) {
  const entries = new Map<string, { value: unknown; expiresAt: number }>()
  const { ttlMs, maxEntries, evictTo } = options
  return {
    get(key: string, now: number) {
      const entry = entries.get(key)
      if (!entry) return null
      if (entry.expiresAt <= now) {
        entries.delete(key)
        return null
      }
      return entry.value
    },
    set(key: string, value: unknown, now: number) {
      if (!key || value === undefined || value === null) return
      // 原实现直接 Map.set：重写已存在的键**保持原队位**（不是 delete+set）。
      entries.set(key, { value, expiresAt: now + ttlMs })
      if (evictTo !== undefined) {
        while (entries.size > evictTo) {
          entries.delete(entries.keys().next().value as string)
        }
      } else {
        while (entries.size > maxEntries) {
          entries.delete(entries.keys().next().value as string)
        }
      }
    },
    keys() {
      return [...entries.keys()]
    },
  }
}

interface CacheLike {
  get: (key: string, now: number) => unknown
  set: (key: string, value: unknown, now: number) => void
  keys: () => string[]
}

describe('进程内缓存（TtlCache vs 旧 Map 实现）', () => {
  type Action = { op: 'set'; key: string; value: unknown; at: number } | { op: 'get'; key: string; at: number }

  const runScript = (cache: CacheLike, actions: Action[], atEnd: number) => {
    for (const action of actions) {
      if (action.op === 'set') cache.set(action.key, action.value, action.at)
      else cache.get(action.key, action.at)
    }
    const keys = cache.keys()
    return { keys, values: keys.map(key => cache.get(key, atEnd)) }
  }

  const compare = (
    name: string,
    options: LegacyCacheOptions,
    actions: Action[],
    atEnd = 0,
  ) => {
    it(name, () => {
      let now = 0
      const current = new TtlCache({
        ttlMs: options.ttlMs,
        maxEntries: options.maxEntries,
        evictTo: options.evictTo,
        // 旧实现全部是 FIFO（命中不调序）
        touchOnGet: false,
        now: () => now,
      })
      const currentLike: CacheLike = {
        get: (key, at) => { now = at; return current.get(key) },
        set: (key, value, at) => { now = at; current.set(key, value) },
        keys: () => {
          const view = current as unknown as { entries: Map<string, unknown> }
          return [...view.entries.keys()]
        },
      }

      const legacyResult = runScript(legacyCache(options), actions, atEnd)
      const currentResult = runScript(currentLike, actions, atEnd)

      expect(currentResult.keys).toEqual(legacyResult.keys)
      expect(currentResult.values).toEqual(legacyResult.values)
    })
  }

  compare(
    '顺序写入后超限：淘汰最旧',
    { ttlMs: 60_000, maxEntries: 2 },
    [
      { op: 'set', key: 'a', value: 'A', at: 0 },
      { op: 'set', key: 'b', value: 'B', at: 0 },
      { op: 'set', key: 'c', value: 'C', at: 0 },
    ],
  )

  compare(
    'FIFO 下重写同一键保持原队位',
    { ttlMs: 60_000, maxEntries: 2 },
    [
      { op: 'set', key: 'a', value: 'A1', at: 0 },
      { op: 'set', key: 'b', value: 'B', at: 0 },
      { op: 'set', key: 'a', value: 'A2', at: 0 },
      { op: 'set', key: 'c', value: 'C', at: 0 },
    ],
  )

  compare(
    '过期条目在 get 时清掉',
    { ttlMs: 100, maxEntries: 5 },
    [
      { op: 'set', key: 'a', value: 'A', at: 0 },
      { op: 'get', key: 'a', at: 150 },
      { op: 'set', key: 'b', value: 'B', at: 150 },
    ],
    150,
  )

  compare(
    '批量收缩（evictTo）：5000 -> 3500 的真实规模',
    { ttlMs: 60_000, maxEntries: 5_000, evictTo: 3_500 },
    Array.from({ length: 5_001 }, (_, index) => ({
      op: 'set' as const,
      key: `k${index}`,
      value: index,
      at: 0,
    })),
  )

  compare(
    '空键 / undefined / null 不写入',
    { ttlMs: 60_000, maxEntries: 5 },
    [
      { op: 'set', key: '', value: 'x', at: 0 },
      { op: 'set', key: 'a', value: undefined, at: 0 },
      { op: 'set', key: 'b', value: null, at: 0 },
      { op: 'set', key: 'c', value: 'C', at: 0 },
    ],
  )
})

// ─────────────────────────────────────────────────────────────
// 3. upNext 秒数钳制：App 与注册表两处旧写法
// ─────────────────────────────────────────────────────────────

/** 旧实现（App.tsx 读取侧）：parseInt + clamp，空串回落 10。 */
const legacyUpNextSeconds = (raw: string | null): number => {
  const saved = Number.parseInt(raw || '', 10)
  return Number.isFinite(saved) ? Math.max(5, Math.min(30, saved)) : 10
}

/** 旧实现（注册表写侧）：Math.round + clamp。 */
const legacyRegistryUpNextSeconds = (value: number): number => {
  const seconds = Math.max(5, Math.min(30, Math.round(Number(value))))
  return Number.isFinite(seconds) ? seconds : 10
}

describe('upNext 秒数（新 normalize vs 旧两套）', () => {
  it('App 侧读取：整数与非法输入结果一致', () => {
    const inputs = [null, '', '0', '4', '10', '30', '31', 'abc', ' 12 ']
    for (const raw of inputs) {
      const legacy = legacyUpNextSeconds(raw)
      const current = raw === null || raw.trim() === '' ? 10 : normalizeUpNextSeconds(Number(raw))
      expect(current, `raw=${JSON.stringify(raw)}`).toBe(legacy)
    }
  })

  it('小数输入：读取侧由「截断」改为「四舍五入」（有意收敛，与写侧一致）', () => {
    // 旧 App 读取用 Number.parseInt 截断（17.6 -> 17），但旧注册表写侧用 Math.round。
    // 现在读写同走 normalizeUpNextSeconds（四舍五入），只在手工写入小数时与旧读取不同；
    // 滑块 step=1 不会产生小数，故这是收敛而非回归。此处显式钉住该差异，避免被误判成 bug。
    expect(legacyUpNextSeconds('17.6')).toBe(17)
    expect(normalizeUpNextSeconds(Number('17.6'))).toBe(18)
  })

  it('注册表写侧：数值输入结果一致', () => {
    const inputs = [0, 4, 4.4, 4.6, 10, 17.6, 30, 99, Number.NaN]
    for (const value of inputs) {
      expect(normalizeUpNextSeconds(value), `value=${value}`).toBe(legacyRegistryUpNextSeconds(value))
    }
  })
})

// ─────────────────────────────────────────────────────────────
// 4. 歌词：能力检测 / 空壳过滤 / 合并阈值
// ─────────────────────────────────────────────────────────────

type Capabilities = ReturnType<typeof detectLyricsCapabilities>

/** 旧实现复刻：musicApi 里被删除的能力检测。 */
const legacyCapabilities = (lyrics: LyricLine[]): Capabilities => ({
  hasWordByWord: lyrics.some(line => line.words && line.words.length > 0),
  hasTranslation: lyrics.some(line => line.translation),
  hasRoman: lyrics.some(line => line.roman || (line.romanWords && line.romanWords.length > 0)),
})

/** 旧实现复刻：musicApi 里被删除的空壳过滤。 */
const legacyMetadataOnly = (lyrics: LyricLine[]): boolean => {
  const pattern = /^(词|曲|编曲|作词|作曲|演唱|歌手|制作人|录音|混音|母带)[：:\s]/u
  if (!Array.isArray(lyrics) || lyrics.length === 0) return false
  return !lyrics.some(line => {
    const text = (line.text || '').trim()
    if (!text) return false
    return !pattern.test(text)
  })
}

describe('歌词能力检测与空壳过滤（新 module vs 旧 musicApi）', () => {
  const fixtures: Array<{ name: string; input: LyricLine[] }> = [
    { name: '空数组', input: [] },
    { name: '只有元数据', input: [{ time: 1, text: '作词: A' }, { time: 2, text: '作曲: B' }] },
    { name: '元数据 + 正文', input: [{ time: 1, text: '作词: A' }, { time: 2, text: '正文' }] },
    { name: '空文本行', input: [{ time: 1, text: '   ' }, { time: 2, text: '正文' }] },
    {
      name: '逐字 + 翻译 + 罗马音',
      input: [{
        time: 1,
        text: 'a',
        words: [{ word: 'a', startTime: 0, duration: 100 }],
        translation: '译',
        roman: 'ro',
      }],
    },
    {
      name: '只有 romanWords',
      input: [{ time: 1, text: 'a', romanWords: [{ word: 'a', startTime: 0, duration: 100 }] }],
    },
  ]

  const capabilityResults = runEquivalence(fixtures, legacyCapabilities, detectLyricsCapabilities)
  for (const result of capabilityResults) {
    it(`能力检测 · ${result.name}`, () => {
      expect(result.current).toEqual(result.legacy)
    })
  }

  const metadataResults = runEquivalence(fixtures, legacyMetadataOnly, isMetadataOnlyLyrics)
  for (const result of metadataResults) {
    it(`空壳过滤 · ${result.name}`, () => {
      expect(result.current).toBe(result.legacy)
    })
  }
})

describe('歌词合并阈值（新 module 行为钉住）', () => {
  const lyrics: LyricLine[] = [
    { time: 1, text: 'a' },
    { time: 9, text: 'b' },
    { time: 20, text: 'c' },
  ]
  const translations: LyricLine[] = [
    { time: 2.9, text: '译a' },
    { time: 9.8, text: '译b' },
    { time: 30, text: '太远' },
  ]
  const romans: LyricLine[] = [
    { time: 3.8, text: 'ro-a' },
    { time: 11.5, text: 'ro-太远' },
  ]

  const merged = mergeLyricsWithTranslationAndRoman(lyrics, translations, romans)

  it('开头放宽到翻译 2s / 罗马音 3s', () => {
    expect(merged[0].translation).toBe('译a')
    expect(merged[0].roman).toBe('ro-a')
  })

  it('10s 后罗马音阈值收回 1s', () => {
    expect(merged[1].translation).toBe('译b')
    expect(merged[1].roman).toBe('')
  })

  it('超阈值不匹配', () => {
    expect(merged[2].translation).toBe('')
    expect(merged[2].roman).toBe('')
  })

  it('不修改入参', () => {
    expect(lyrics.every(line => line.translation === undefined)).toBe(true)
    expect(lyrics.every(line => line.roman === undefined)).toBe(true)
  })
})


