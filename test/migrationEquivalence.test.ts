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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAudioQualityRequest } from '../src/services/audioQualitySettings'
import { getApiBase } from '../src/services/apiConfig'
import type { MusicPlatform } from '../src/services/platforms'
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



// 候选 13：保留旧服务实现的可执行证据，路由与时钟隔离在各自测试作用域。
describe('bilibili 后端缓存迁移', () => {

  const TTL = 10 * 60 * 1000
  type Key = string | number

  /** 旧 pruneCache 原片段，仅将 Date.now 换为注入时钟。 */
  function legacyPruneCache<K, E extends { createdAt: number }>(map: Map<K, E>, ttl: number, clock: () => number) {
    const now = clock()
    for (const [key, entry] of map) {
      if (now - entry.createdAt > ttl) map.delete(key)
    }
  }

  // 三种旧条目分别保留；peek/fresh 只投影供现有断言观察，不统一存储模型。
  function legacyStreamCache(clock: () => number) {
    const streamCache = new Map<Key, { urls: string[]; sizes: number[]; videoId: number; audioId: number; createdAt: number }>()
    return {
      set(cacheKey: Key, url: string) {
        const video = { baseUrl: url, base_url: '', size: 0, id: 80 }
        const audio = { baseUrl: `${url}/audio`, base_url: '', size: 0, id: 30280 }
        streamCache.set(cacheKey, {
          urls: [video.baseUrl || video.base_url || '', audio.baseUrl || audio.base_url || ''],
          sizes: [video.size || 0, audio.size || 0],
          videoId: video.id,
          audioId: audio.id,
          createdAt: clock(),
        })
      },
      peek(key: Key) {
        const entry = key ? streamCache.get(key) : undefined
        return entry ? entry.urls[0] : null
      },
      prune() { legacyPruneCache(streamCache, TTL, clock) },
      size() { return streamCache.size },
    }
  }

  function legacySubtitleCache(clock: () => number) {
    const subtitleJsonCache = new Map<Key, { url: string; createdAt: number }>()
    return {
      set(subCacheKey: Key, subUrl: string) {
        subtitleJsonCache.set(subCacheKey, { url: subUrl.startsWith('//') ? `https:${subUrl}` : subUrl, createdAt: clock() })
      },
      peek(key: Key) {
        const entry = key ? subtitleJsonCache.get(key) : undefined
        return entry ? entry.url : null
      },
      prune() { legacyPruneCache(subtitleJsonCache, TTL, clock) },
      size() { return subtitleJsonCache.size },
    }
  }

  function legacyDanmakuCache(clock: () => number) {
    const danmakuCache = new Map<Key, { items: { text: string }[]; createdAt: number }>()
    return {
      set(cid: Key, text: string) {
        const items = [{ text }]
        danmakuCache.set(cid, { items, createdAt: clock() })
      },
      peek(cid: Key) { return danmakuCache.get(cid)?.items[0]?.text ?? null },
      fresh(cid: Key) {
        const cached = danmakuCache.get(cid)
        if (cached && clock() - cached.createdAt < TTL) {
          return cached.items[0]?.text ?? null
        }
        return null
      },
      prune() { legacyPruneCache(danmakuCache, TTL, clock) },
      size() { return danmakuCache.size },
    }
  }

  function migratedBilibiliCache(clock: () => number) {
    const cache = new TtlCache({
      ttlMs: TTL, maxEntries: Infinity, touchOnGet: false, pruneOnSet: false, now: clock,
    })
    return {
      set(key: Key, value: string) { cache.set(key, value) },
      peek(key: Key) { return cache.peek(key) },
      fresh(key: Key) { return cache.isFresh(key) ? cache.peek(key) : null },
      prune() { cache.prune({ inclusive: false }) },
      size() { return cache.size },
    }
  }

  describe('B站缓存迁移 legacy 等价性', () => {
    it('流/字幕只在显式 prune 清理，严格大于 TTL 才淘汰，保留键类型与重写刷新', () => {
      let now = 1000
      const legacy = legacyStreamCache(() => now)
      const current = migratedBilibiliCache(() => now)
      for (const cache of [legacy, current]) {
        cache.set(42, '数字键')
        cache.set('42', '字符串键')
      }
      now += TTL
      for (const cache of [legacy, current]) cache.prune()
      expect(current.size()).toBe(legacy.size())
      expect(current.peek(42)).toBe('数字键')
      now += 1
      expect(current.peek('42')).toBe(legacy.peek('42'))
      for (const cache of [legacy, current]) cache.set(42, '刷新')
      for (const cache of [legacy, current]) cache.prune()
      expect(current.size()).toBe(legacy.size())
      expect(current.peek(42)).toBe(legacy.peek(42))
      expect(current.peek('42')).toBe(legacy.peek('42'))
      expect(current.peek('42')).toBeNull()
    })

    it('无容量上限；读过期流/字幕和普通写入都不会暗中清理', () => {
      let now = 1000
      const legacy = legacySubtitleCache(() => now)
      const current = migratedBilibiliCache(() => now)
      for (const cache of [legacy, current]) {
        for (let index = 1; index <= 5001; index += 1) cache.set(index, `流${index}`)
      }
      now += TTL + 1
      for (const cache of [legacy, current]) cache.set('重建字幕', '新值')
      expect(current.size()).toBe(legacy.size())
      expect(current.size()).toBe(5002)
      expect(current.peek(1)).toBe(legacy.peek(1))
      for (const cache of [legacy, current]) cache.prune()
      expect(current.size()).toBe(legacy.size())
      expect(current.size()).toBe(1)
    })

    it('弹幕到点拒绝旧值但不删除，写入刷新或显式清理前保持原条目', () => {
      let now = 1000
      const legacy = legacyDanmakuCache(() => now)
      const current = migratedBilibiliCache(() => now)
      for (const cache of [legacy, current]) cache.set(42, '旧弹幕')
      now += TTL - 1
      expect(current.fresh(42)).toBe(legacy.fresh(42))
      now += 1
      expect(current.fresh(42)).toBe(legacy.fresh(42))
      expect(current.fresh(42)).toBeNull()
      expect(current.size()).toBe(legacy.size())
      expect(current.peek(42)).toBe(legacy.peek(42))
      for (const cache of [legacy, current]) cache.set(43, '确认空弹幕')
      now += 1
      expect(current.size()).toBe(legacy.size())
      for (const cache of [legacy, current]) cache.prune()
      expect(current.peek(42)).toBeNull()
      expect(current.size()).toBe(legacy.size())
    })
  })

  // 测试真实注册的路由；只替换外部 B站网络和时钟，不访问路由模块内部缓存。
  type RouteResult = { status: number; body: any }
  type Handler = (req: any, res: any) => Promise<unknown>
  let now = 1000
  let routes: Map<string, Handler>
  let subtitleVersion = '旧'
  let danmakuState: '有弹幕' | '空' | '失败' = '有弹幕'
  let danmakuVersion = '旧弹幕'

  async function request(path: string, query: Record<string, unknown> = {}): Promise<RouteResult> {
    const result: RouteResult = { status: 200, body: undefined }
    const res = {
      status(code: number) { result.status = code; return res },
      json(body: unknown) { result.body = body; return res },
    }
    await routes.get(`/api/bilibili/${path}`)!({ query, headers: {} }, res)
    return result
  }

  describe('B站缓存迁移公开路由', () => {
    beforeEach(async () => {
      vi.resetModules()
      now = 1000
      subtitleVersion = '旧'
      danmakuState = '有弹幕'
      danmakuVersion = '旧弹幕'
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/finger/spi')) return Response.json({ data: { b_3: '匿名指纹' } })
        if (url.pathname.endsWith('/nav')) return Response.json({ data: { wbi_img: {
          img_url: `https://i.test/${'a'.repeat(32)}.png`, sub_url: `https://i.test/${'b'.repeat(32)}.png`,
        } } })
        if (url.pathname.endsWith('/playurl')) return Response.json({ code: 0, data: {
          accept_quality: [80], dash: {
            video: [{ id: 80, baseUrl: 'https://cdn.test/video' }],
            audio: [{ id: 30280, baseUrl: 'https://cdn.test/audio' }],
          },
        } })
        if (url.pathname.endsWith('/wbi/v2')) return Response.json({ code: 0, data: { subtitle: { subtitles: [{
          lan: 'zh-CN', subtitle_url: `//cdn.test/subtitle/${subtitleVersion}`,
        }] } } })
        if (url.pathname.startsWith('/subtitle/')) return Response.json({ body: [{ content: decodeURI(url.pathname.split('/').pop()!) }] })
        if (url.hostname === 'cdn.test') return new Response('', { status: url.pathname === '/audio' ? 416 : 403 })
        if (url.pathname.endsWith('/seg.so') || url.pathname.endsWith('/list.so') || url.hostname === 'comment.bilibili.com') {
          if (danmakuState === '失败') throw new Error('网络失败')
          if (url.pathname.endsWith('/seg.so')) return new Response(new Uint8Array())
          return new Response(danmakuState === '空' ? '<i></i>' : `<i><d p="1,1,25,16777215">${danmakuVersion}</d></i>`)
        }
        throw new Error(`未预期的外部请求：${url}`)
      }))
      const { registerBilibiliRoutes } = await import('../server/bilibili-api.mjs')
      routes = new Map()
      registerBilibiliRoutes({
        get(path: string, handler: Handler) { routes.set(path, handler) },
        post() {},
        delete() {},
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('播放 key 在 TTL 到点仍可读，超时无写入仍可读，下一次 playurl 写入才淘汰', async () => {
      const { body: { cacheKey } } = await request('playurl', { bvid: 'BV1', cid: 1 })
      now += TTL
      await request('playurl', { bvid: 'BV2', cid: 2 })
      expect((await request('stream', { key: cacheKey })).status).toBe(403)
      now += 1
      expect((await request('stream', { key: cacheKey, type: 'audio' })).status).toBe(416)
      await request('playurl', { bvid: 'BV3', cid: 3 })
      expect((await request('stream', { key: cacheKey })).status).toBe(410)
    })

    it('字幕读取超时不失效，元数据写入严格越过 TTL 后才清理并触发旧 key 重建', async () => {
      const { body: { subtitles: [{ cacheKey }] } } = await request('subtitles', { bvid: 'BV1', cid: 1 })
      subtitleVersion = '新'
      now += TTL
      await request('subtitles', { bvid: 'BV2', cid: 2 })
      expect((await request('subtitle', { key: cacheKey })).body).toEqual([{ content: '旧' }])
      now += 1
      expect((await request('subtitle', { key: cacheKey })).body).toEqual([{ content: '旧' }])
      await request('subtitles', { bvid: 'BV3', cid: 3 })
      expect((await request('subtitle', { key: cacheKey })).body).toEqual([{ content: '新' }])
    })

    it('字幕 miss 重建不顺便清理其他已过期 key，重写同 key 刷新 TTL', async () => {
      const { body: { subtitles: [{ cacheKey }] } } = await request('subtitles', { bvid: 'BV1', cid: 1 })
      now += TTL + 1
      subtitleVersion = '重建'
      expect((await request('subtitle', { key: 'bili_sub_BV2_2_zh-CN' })).body).toEqual([{ content: '重建' }])
      expect((await request('subtitle', { key: cacheKey })).body).toEqual([{ content: '旧' }])
      await request('subtitles', { bvid: 'BV1', cid: 1 })
      now += TTL
      await request('subtitles', { bvid: 'BV3', cid: 3 })
      subtitleVersion = '再次变化'
      expect((await request('subtitle', { key: cacheKey })).body).toEqual([{ content: '重建' }])
    })

    it('弹幕 cid 按数字归一，TTL 内复用，精确到点刷新（不延长读取寿命）', async () => {
      const first = await request('danmaku', { cid: '001' })
      expect(first.body.danmaku[0].text).toBe('旧弹幕')
      danmakuVersion = '新弹幕'
      now += TTL - 1
      expect((await request('danmaku', { cid: 1 })).body).toEqual(first.body)
      now += 1
      expect((await request('danmaku', { cid: '1' })).body.danmaku[0].text).toBe('新弹幕')
    })

    it('确认无弹幕时缓存空列表，TTL 到点后重新获取', async () => {
      danmakuState = '空'
      expect((await request('danmaku', { cid: 1 })).body).toEqual({ code: 0, danmaku: [] })
      danmakuState = '有弹幕'
      now += TTL - 1
      expect((await request('danmaku', { cid: 1 })).body.danmaku).toEqual([])
      now += 1
      expect((await request('danmaku', { cid: 1 })).body.danmaku[0].text).toBe('旧弹幕')
    })

    it('全部来源失败不缓存，失效条目也不回退；恢复后同 cid 可立即重试', async () => {
      await request('danmaku', { cid: 1 })
      now += TTL
      danmakuState = '失败'
      expect((await request('danmaku', { cid: 1 })).status).toBe(502)
      expect((await request('danmaku', { cid: 2 })).status).toBe(502)
      danmakuState = '有弹幕'
      danmakuVersion = '恢复弹幕'
      expect((await request('danmaku', { cid: 1 })).body.danmaku[0].text).toBe('恢复弹幕')
      expect((await request('danmaku', { cid: 2 })).body.danmaku[0].text).toBe('恢复弹幕')
    })
  })

})

// 候选 13：保留旧服务实现的可执行证据，路由与时钟隔离在各自测试作用域。
describe('netease 后端缓存迁移', () => {

  /** 网易探索迁移前 createTimedCache 的字面复刻，保留写入时不扫过期的行为。 */
  function legacyCreateTimedCache(ttlMs: number, maxEntries = 24) {
    const entries = new Map()
    return {
      get(key: string) {
        const item = entries.get(key)
        if (!item || item.expiresAt <= Date.now()) {
          entries.delete(key)
          return null
        }
        return item.value
      },
      set(key: string, value: unknown) {
        entries.set(key, { value, expiresAt: Date.now() + ttlMs })
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
      },
    }
  }

  const configurations = [
    { name: '首页', ttlMs: 90_000, maxEntries: 24, path: '/api/netease/native/home' },
    { name: '播客', ttlMs: 3 * 60_000, maxEntries: 24, path: '/api/netease/native/podcast-home' },
    { name: '红心数量', ttlMs: 5 * 60_000, maxEntries: 1_000, path: '/api/netease/native/red-counts' },
  ]

  afterEach(() => vi.restoreAllMocks())

  describe.each(configurations)('网易探索缓存等价性 · $name', ({ ttlMs, maxEntries }) => {
    function pair() {
      let now = 1_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const legacy = legacyCreateTimedCache(ttlMs, maxEntries)
      const current = new TtlCache({ ttlMs, maxEntries, touchOnGet: false, pruneOnSet: false, now: () => Date.now() })
      return { legacy, current, advance: (ms: number) => { now += ms } }
    }

    it('TTL 边界恰好过期，零值仍能命中', () => {
      const { legacy, current, advance } = pair()
      for (const cache of [legacy, current]) cache.set('1', 0)
      advance(ttlMs - 1)
      expect(current.get('1')).toBe(legacy.get('1'))
      expect(current.get('1')).toBe(0)
      advance(1)
      expect(current.get('1')).toBe(legacy.get('1'))
      expect(current.get('1')).toBeNull()
    })

    it('命中不移到队尾，超限只淘汰最早写入的键', () => {
      const { legacy, current } = pair()
      for (const cache of [legacy, current]) {
        for (let index = 0; index < maxEntries; index += 1) cache.set(String(index), index)
        cache.get('0')
        cache.set('new', '新增')
      }
      for (const key of ['0', '1', 'new']) expect(current.get(key)).toBe(legacy.get(key))
      expect(current.get('0')).toBeNull()
      expect(current.get('1')).toBe(1)
    })

    it('重写刷新 TTL，但保留原键位置', () => {
      const { legacy, current, advance } = pair()
      for (const cache of [legacy, current]) {
        for (let index = 0; index < maxEntries; index += 1) cache.set(String(index), index)
      }
      advance(ttlMs - 1)
      for (const cache of [legacy, current]) cache.set('0', '刷新')
      advance(1)
      expect(current.get('0')).toBe(legacy.get('0'))
      expect(current.get('0')).toBe('刷新')
      for (const cache of [legacy, current]) cache.set('new', '新增')
      expect(current.get('0')).toBe(legacy.get('0'))
      expect(current.get('0')).toBeNull()
    })

    it('写入不扫描中间过期键，即使队首有效也按 FIFO 淘汰', () => {
      const { legacy, current, advance } = pair()
      for (const cache of [legacy, current]) {
        for (let index = 0; index < maxEntries; index += 1) cache.set(String(index), index)
      }
      advance(ttlMs - 1)
      for (const cache of [legacy, current]) cache.set('0', '刷新')
      advance(1)
      for (const cache of [legacy, current]) cache.set('new', '新增')
      expect(current.get('0')).toBe(legacy.get('0'))
      expect(current.get('0')).toBeNull()
      expect(current.get('new')).toBe(legacy.get('new'))
    })
  })

  type Query = Record<string, string>
  type RouteResponse = { code: number; data?: { count?: number; version?: number }; counts?: Record<string, number> }
  type Handler = (req: { query: Query }, res: object) => Promise<unknown>

  async function routeHarness() {
    // 模块拥有进程级缓存，每例独立载入，避免路由例之间共享账号与歌曲记录。
    vi.resetModules()
    const { registerNeteaseNativeExploreRoutes } = await import('../server/netease-native-explore.mjs')
    const routes = new Map<string, Handler>()
    let code = 200
    let version = 0
    const upstream = vi.fn(async () => ({ body: { code, data: { count: 0, version: ++version } } }))
    registerNeteaseNativeExploreRoutes(
      { get: (path: string, handler: Handler) => routes.set(path, handler) },
      { getNeteaseApi: () => ({ api: upstream }) },
    )
    return {
      upstream,
      fail: () => { code = 500 },
      succeed: () => { code = 200 },
      async request(path: string, query: Query = {}) {
        let body: RouteResponse | undefined
        const res = {
          setHeader() {},
          status() { return this },
          json(value: RouteResponse) { body = value; return value },
        }
        await routes.get(path)!({ query }, res)
        return body!
      },
    }
  }

  describe.each(configurations)('网易探索公开路由 · $name', ({ name, path, ttlMs, maxEntries }) => {
    const queryFor = (id: number): Query => name === '红心数量' ? { ids: String(id) } : { cookie: `MUSIC_U=account-${id}` }

    it('保留真实 TTL，命中不续期，恰好到期重新请求', async () => {
      let now = 1_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const { request, upstream } = await routeHarness()
      const query = queryFor(1)
      const first = await request(path, query)
      now += ttlMs - 1
      expect(await request(path, query)).toEqual(first)
      expect(upstream).toHaveBeenCalledTimes(1)
      now += 1
      await request(path, query)
      expect(upstream).toHaveBeenCalledTimes(2)
    })

    it('保留真实容量，命中不改变 FIFO 淘汰顺序', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const { request, upstream } = await routeHarness()
      for (let index = 1; index <= maxEntries; index += 1) await request(path, queryFor(index))
      await request(path, queryFor(1))
      expect(upstream).toHaveBeenCalledTimes(maxEntries)
      await request(path, queryFor(maxEntries + 1))
      await request(path, queryFor(2))
      expect(upstream).toHaveBeenCalledTimes(maxEntries + 1)
      await request(path, queryFor(1))
      expect(upstream).toHaveBeenCalledTimes(maxEntries + 2)
    })

    it('失败响应不缓存，恢复后可以立即重试', async () => {
      const { request, upstream, fail, succeed } = await routeHarness()
      fail()
      await request(path, queryFor(1))
      succeed()
      await request(path, queryFor(1))
      await request(path, queryFor(1))
      expect(upstream).toHaveBeenCalledTimes(2)
    })
  })

  describe('网易探索缓存路由作用域与刷新', () => {
    it('首页写满后不优先清理中间过期项，刷新过的队首仍被 FIFO 淘汰', async () => {
      let now = 1_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const { request, upstream } = await routeHarness()
      const path = '/api/netease/native/home'
      const first = { cookie: 'MUSIC_U=first' }
      await request(path, first)
      for (let index = 1; index < 24; index += 1) await request(path, { cookie: `MUSIC_U=fill-${index}` })
      now += 89_999
      await request(path, { ...first, refresh: '1' })
      now += 1
      await request(path, { cookie: 'MUSIC_U=overflow' })
      await request(path, first)
      expect(upstream).toHaveBeenCalledTimes(27)
    })

    it('首页按 cookie 和 cursor 隔离，强制刷新仍保留 FIFO 原位', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const { request, upstream } = await routeHarness()
      const path = '/api/netease/native/home'
      const first = { cookie: 'MUSIC_U=first', cursor: 'next' }
      await request(path, first)
      await request(path, { ...first, cursor: 'other' })
      await request(path, { ...first, cookie: 'MUSIC_U=second' })
      for (let index = 3; index < 24; index += 1) await request(path, { cookie: `MUSIC_U=fill-${index}` })
      const refreshed = await request(path, { ...first, refresh: '1' })
      expect(await request(path, first)).toEqual(refreshed)
      expect(upstream).toHaveBeenCalledTimes(25)
      await request(path, { cookie: 'MUSIC_U=overflow' })
      await request(path, first)
      expect(upstream).toHaveBeenCalledTimes(27)
    })

    it('播客按账号隔离，subParams 保持原有不参与缓存键的行为', async () => {
      const { request, upstream } = await routeHarness()
      const path = '/api/netease/native/podcast-home'
      const first = await request(path, { cookie: 'MUSIC_U=first' })
      await request(path, { cookie: 'MUSIC_U=second' })
      expect(await request(path, { cookie: 'MUSIC_U=first', subParams: '{"page":2}' })).toEqual(first)
      expect(upstream).toHaveBeenCalledTimes(2)
    })

    it('红心计数按歌曲跨账号复用，零值不会作为未命中', async () => {
      const { request, upstream } = await routeHarness()
      const path = '/api/netease/native/red-counts'
      expect(await request(path, { ids: '1', cookie: 'MUSIC_U=first' })).toMatchObject({ counts: { 1: 0 } })
      expect(await request(path, { ids: '1', cookie: 'MUSIC_U=second' })).toMatchObject({ counts: { 1: 0 } })
      expect(upstream).toHaveBeenCalledTimes(1)
    })
  })

})

// 候选 13：保留旧服务实现的可执行证据，路由与时钟隔离在各自测试作用域。
describe('location 后端缓存迁移', () => {

  const TTL = 6 * 60 * 60 * 1000
  type Location = Record<string, unknown>
  type Query = { latitude?: number; longitude?: number; lat?: number; lon?: number }
  type Response = { statusCode: number; headers: Record<string, string>; body?: Record<string, unknown> }
  type Handler = (req: { query: Query }, res: ReturnType<typeof responder>) => Promise<unknown>

  function responder(response: Response) {
    return {
      status(code: number) { response.statusCode = code; return this },
      setHeader(name: string, value: string) { response.headers[name] = value },
      json(body: Record<string, unknown>) { response.body = body; return body },
    }
  }

  // 原 registerLocationRoutes 缓存与 pending 接线的字面复刻；只注入上游请求供确定性回放。
  function legacyLocationRoute(requestReverseLocation: (latitude: number, longitude: number) => Promise<Location>) {
    const REVERSE_CACHE_TTL = 6 * 60 * 60 * 1000
    const REVERSE_CACHE_LIMIT = 200
    const reverseCache = new Map()
    const reversePending = new Map()
    return async (req: { query: Query }, res: ReturnType<typeof responder>) => {
      const latitude = Number(req.query.latitude ?? req.query.lat)
      const longitude = Number(req.query.longitude ?? req.query.lon)
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return res.status(400).json({ success: false, error: '经纬度参数无效' })
      }

      const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`
      const cached = reverseCache.get(cacheKey)
      if (cached && Date.now() - cached.updatedAt < REVERSE_CACHE_TTL) {
        res.setHeader('Cache-Control', 'private, max-age=3600')
        return res.json({ success: true, ...cached.location, latitude, longitude, cached: true })
      }

      let pending = reversePending.get(cacheKey)
      if (!pending) {
        pending = requestReverseLocation(latitude, longitude)
        reversePending.set(cacheKey, pending)
        pending.finally(() => reversePending.delete(cacheKey)).catch(() => {})
      }

      try {
        const location = await pending
        if (reverseCache.size >= REVERSE_CACHE_LIMIT) reverseCache.delete(reverseCache.keys().next().value)
        reverseCache.set(cacheKey, { location, updatedAt: Date.now() })
        res.setHeader('Cache-Control', 'private, max-age=3600')
        return res.json({ success: true, ...location, latitude, longitude })
      } catch (error) {
        console.warn('[天气定位] 反向定位失败:', error?.message || error)
        if (cached) return res.json({ success: true, ...cached.location, latitude, longitude, cached: true, stale: true })
        return res.status(503).json({ success: false, error: '暂时无法解析当前位置的详细地址' })
      }
    }
  }

  const location = (city: string): Location => ({
    province: '', city, district: '', township: '', street: '', neighbourhood: '', country: '中国',
    formattedAddress: city, displayName: city, address: {}, provider: 'bigdatacloud+photon',
  })

  async function harness(legacy: boolean) {
    let now = 0
    let city = '苏州市'
    let fails = false
    let batches = 0
    let fetchCalls = 0
    let gate: Promise<void> | undefined
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      fetchCalls += 1
      const url = new URL(input)
      if (url.hostname === 'api.bigdatacloud.net') batches += 1
      const resultCity = city
      const shouldFail = fails
      await gate
      if (shouldFail) throw new Error('上游不可用')
      return {
        ok: true,
        json: async () => url.hostname === 'photon.komoot.io'
          ? { features: [{ properties: { city: resultCity, country: '中国' } }] }
          : { city: resultCity, countryName: '中国' },
      }
    }))
    let handler: Handler
    if (legacy) {
      handler = legacyLocationRoute(async () => {
        batches += 1
        const resultCity = city
        const shouldFail = fails
        await gate
        if (shouldFail) throw new Error('上游不可用')
        return location(resultCity)
      })
    } else {
      vi.resetModules()
      const { registerLocationRoutes } = await import('../server/location-api.mjs')
      registerLocationRoutes({ get(path: string, callback: Handler) {
        expect(path).toBe('/api/location/reverse')
        handler = callback
      } })
    }
    return {
      async request(query: Query = { latitude: 31, longitude: 120 }) {
        const response: Response = { statusCode: 200, headers: {} }
        await handler({ query }, responder(response))
        return response
      },
      at(value: number) { now = value },
      upstream(nextCity: string, shouldFail = false) { city = nextCity; fails = shouldFail },
      hold() {
        let release!: () => void
        gate = new Promise<void>(resolve => { release = resolve })
        return () => { gate = undefined; release() }
      },
      get batches() { return batches },
      get fetchCalls() { return fetchCalls },
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  type Harness = Awaited<ReturnType<typeof harness>>
  async function equivalent(script: (api: Harness) => Promise<unknown>) {
    const legacyResult = await script(await harness(true))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    const currentResult = await script(await harness(false))
    expect(currentResult).toEqual(legacyResult)
    return currentResult
  }

  describe('位置反向解析缓存迁移（legacy 与实际路由公开边界）', () => {
    it('四位坐标共用缓存但响应保留请求坐标；6 小时边界刷新，失败反复回退旧值', async () => {
      await equivalent(async api => {
        const first = await api.request({ lat: 31.12341, lon: 120.12341 })
        expect(first.body).toMatchObject({ city: '苏州市' })
        expect(first.body).not.toHaveProperty('cached')
        api.at(TTL - 1)
        const hit = await api.request({ latitude: 31.12342, longitude: 120.12342 })
        expect(hit.body).toMatchObject({ cached: true, latitude: 31.12342, longitude: 120.12342 })
        expect(api.batches).toBe(1)
        api.at(TTL)
        api.upstream('杭州市')
        const refreshed = await api.request({ lat: 31.12341, lon: 120.12341 })
        expect(refreshed.body).toMatchObject({ city: '杭州市' })
        expect(refreshed.body).not.toHaveProperty('cached')
        api.at(2 * TTL)
        api.upstream('', true)
        const stale = await api.request({ lat: 31.12341, lon: 120.12341 })
        const staleAgain = await api.request({ lat: 31.12341, lon: 120.12341 })
        expect(stale.body).toMatchObject({ city: '杭州市', cached: true, stale: true })
        expect(stale.headers).toEqual({})
        expect(staleAgain).toEqual(stale)
        expect(api.batches).toBe(4)
        return { first, hit, refreshed, stale, staleAgain, batches: api.batches }
      })
    })

    it('无效坐标不访问上游；失败未命中返回 503 且后续可重试成功', async () => {
      await equivalent(async api => {
        const invalid = await api.request({ latitude: 91, longitude: 120 })
        expect(invalid.statusCode).toBe(400)
        expect(api.batches).toBe(0)
        api.upstream('', true)
        const failed = await api.request()
        expect(failed).toMatchObject({ statusCode: 503, body: { success: false } })
        api.upstream('苏州市')
        const success = await api.request()
        const hit = await api.request()
        expect(hit.body).toMatchObject({ city: '苏州市', cached: true })
        expect(api.batches).toBe(2)
        return { invalid, failed, success, hit, batches: api.batches }
      })
    })

    it('并发坐标归一后合并 pending，成功缓存且失败后清理 pending', async () => {
      await equivalent(async api => {
        const release = api.hold()
        const first = api.request({ lat: 31.00001, lon: 120.00001 })
        const second = api.request({ lat: 31.00002, lon: 120.00002 })
        expect(api.batches).toBe(1)
        release()
        const initial = await Promise.all([first, second])
        expect(initial[0].body).not.toHaveProperty('cached')
        expect(initial[1].body).not.toHaveProperty('cached')
        api.at(TTL)
        api.upstream('', true)
        const releaseFailure = api.hold()
        const failedFirst = api.request()
        const failedSecond = api.request()
        expect(api.batches).toBe(2)
        releaseFailure()
        const stale = await Promise.all([failedFirst, failedSecond])
        expect(stale[0].body).toMatchObject({ stale: true, city: '苏州市' })
        api.upstream('杭州市')
        const recovered = await api.request()
        expect(recovered.body).toMatchObject({ city: '杭州市' })
        expect(api.batches).toBe(3)
        return { initial, stale, recovered, batches: api.batches }
      })
    })

    it('TTL 从请求成功完成时起算，未满额刷新不会改变原 FIFO 队位', async () => {
      await equivalent(async api => {
        const release = api.hold()
        const delayed = api.request({ lat: 10, lon: 0 })
        api.at(TTL)
        release()
        await delayed
        api.at(2 * TTL - 1)
        const hit = await api.request({ lat: 10, lon: 0 })
        expect(hit.body).toMatchObject({ cached: true })
        expect(api.batches).toBe(1)
        // 第二个键仍新鲜时刷新首项，随后填满并超额，首项仍应首先淘汰。
        await api.request({ lat: 10, lon: 0.001 })
        api.at(2 * TTL)
        await api.request({ lat: 10, lon: 0 })
        for (let index = 2; index <= 200; index += 1) await api.request({ lat: 10, lon: index / 1000 })
        api.upstream('', true)
        const evicted = await api.request({ lat: 10, lon: 0 })
        const retained = await api.request({ lat: 10, lon: 0.001 })
        expect(evicted.statusCode).toBe(503)
        expect(retained.body).toMatchObject({ cached: true })
        expect(api.batches).toBe(203)
        return { hit, evicted, retained, batches: api.batches }
      })
    })

    it('满 200 条时刷新非首项仍写前淘汰首项；不触达 FIFO，不清除其他 stale', async () => {
      await equivalent(async api => {
        for (let index = 0; index < 200; index += 1) await api.request({ lat: 10, lon: index / 1000 })
        await api.request({ lat: 10, lon: 0 }) // 命中首项不能改变队位。
        api.at(TTL)
        api.upstream('杭州市')
        const refreshed = await api.request({ lat: 10, lon: 0.1 })
        api.upstream('', true)
        const evicted = await api.request({ lat: 10, lon: 0 })
        const stale = await api.request({ lat: 10, lon: 0.001 })
        expect(evicted.statusCode).toBe(503)
        expect(stale.body).toMatchObject({ stale: true, city: '苏州市' })
        expect(api.batches).toBe(203)
        return { refreshed, evicted, stale, batches: api.batches }
      })
    })

    it('满额时并发刷新首项：每个成功等待者照旧写缓存并触发写前淘汰', async () => {
      await equivalent(async api => {
        for (let index = 0; index < 200; index += 1) await api.request({ lat: 10, lon: index / 1000 })
        api.at(TTL)
        const release = api.hold()
        const first = api.request({ lat: 10, lon: 0 })
        const second = api.request({ lat: 10, lon: 0 })
        expect(api.batches).toBe(201)
        release()
        const refreshed = await Promise.all([first, second])
        api.upstream('', true)
        const evicted = await api.request({ lat: 10, lon: 0.001 })
        const retained = await api.request({ lat: 10, lon: 0.002 })
        const hit = await api.request({ lat: 10, lon: 0 })
        expect(evicted.statusCode).toBe(503)
        expect(retained.body).toMatchObject({ stale: true })
        expect(hit.body).toMatchObject({ cached: true })
        expect(api.batches).toBe(203)
        return { refreshed, evicted, retained, hit, batches: api.batches }
      })
    })

    it('实际路由成功走两个并行提供商，失败走完第三提供商且不缓存失败', async () => {
      const api = await harness(false)
      await api.request()
      expect(api.fetchCalls).toBe(2)
      api.at(TTL)
      api.upstream('', true)
      await api.request()
      expect(api.fetchCalls).toBe(5)
      await api.request()
      expect(api.fetchCalls).toBe(8)
    })
  })

})

// 候选 12：6ca1d6d 的 musicApi URL 缓存原文；仅去掉局部函数的 export。
describe('取歌 URL 缓存迁移', () => {
  function legacySongUrlApi() {
    const API_BASE = getApiBase()
    const AUDIO_QUALITY_SETTINGS_EVENT = 'hyperplayer-audio-quality-changed'
    const SONG_URL_CACHE_TTL = 5 * 60 * 1000
    const SONG_URL_NEGATIVE_CACHE_TTL = 25 * 1000
    const SONG_URL_FETCH_TIMEOUT = 26 * 1000
    const SONG_URL_CACHE_MAX_ENTRIES = 256
    const songUrlCache = new Map<string, { url: string | null; expiresAt: number }>()
    const songUrlPending = new Map<string, Promise<string | null>>()
    const songUrlRefreshPending = new Map<string, Promise<string | null>>()
    const songUrlRefreshUntil = new Map<string, number>()
    const songUrlInvalidationVersions = new Map<string, number>()
    let songUrlCacheGeneration = 0

    const clearSongUrlCache = () => {
      songUrlCacheGeneration += 1
      songUrlCache.clear()
      songUrlPending.clear()
      songUrlRefreshPending.clear()
      songUrlRefreshUntil.clear()
      songUrlInvalidationVersions.clear()
    }

    // 模块加载时不再注册监听器（HMR/多实例会重复注册并累积）；
    // 改为惰性注册：首次调用 getSongUrl 时注册一次，事件触发时清缓存。
    let songUrlListenersRegistered = false
    const ensureSongUrlListenersRegistered = () => {
      if (songUrlListenersRegistered) return
      songUrlListenersRegistered = true
      if (typeof window !== 'undefined') {
        window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, clearSongUrlCache)
        window.addEventListener('hyperplayer-auth-changed', clearSongUrlCache)
      }
    }

    const fingerprint = (value: string) => {
      let hash = 2166136261
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0).toString(36)
    }

    const cacheSongUrl = (key: string, url: string | null) => {
      const now = Date.now()
      for (const [cachedKey, entry] of songUrlCache) {
        if (entry.expiresAt <= now) songUrlCache.delete(cachedKey)
      }
      songUrlCache.delete(key)
      songUrlCache.set(key, {
        url,
        expiresAt: now + (url ? SONG_URL_CACHE_TTL : SONG_URL_NEGATIVE_CACHE_TTL),
      })
      while (songUrlCache.size > SONG_URL_CACHE_MAX_ENTRIES) {
        const oldestKey = songUrlCache.keys().next().value
        if (oldestKey === undefined) break
        songUrlCache.delete(oldestKey)
      }
    }

    const fetchSongUrlResponse = async (url: string): Promise<Response> => {
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), SONG_URL_FETCH_TIMEOUT)
      try {
        return await fetch(url, { signal: controller.signal })
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    const buildSongUrlCacheKey = (id: number | string, platform: MusicPlatform) => {
      const cookie = platform === 'qq'
        ? (localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || '')
        : (localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')
      const crossPlatformFallback = platform === 'netease'
        ? (localStorage.getItem('crossPlatformFallbackEnabled') ?? 'false')
        : 'not-applicable'
      const { preference, isVip } = getAudioQualityRequest(platform)
      return `${platform}:${id}:${preference}:${isVip ? 'vip' : 'free'}:${fingerprint(cookie)}:${crossPlatformFallback}`
    }

    const invalidateSongUrl = (id: number | string, platform: MusicPlatform = 'netease') => {
      const cacheKey = buildSongUrlCacheKey(id, platform)
      songUrlCache.delete(cacheKey)
      songUrlPending.delete(cacheKey)
      const nextVersion = (songUrlInvalidationVersions.get(cacheKey) || 0) + 1
      songUrlInvalidationVersions.delete(cacheKey)
      songUrlInvalidationVersions.set(cacheKey, nextVersion)
      while (songUrlInvalidationVersions.size > SONG_URL_CACHE_MAX_ENTRIES) {
        const oldestKey = songUrlInvalidationVersions.keys().next().value
        if (oldestKey === undefined) break
        songUrlInvalidationVersions.delete(oldestKey)
      }
    }

    async function refreshSongUrlOnce(id: number | string, platform: MusicPlatform, failedUrl: string): Promise<string | null> {
      const key = `${platform}:${id}:${fingerprint(failedUrl)}`
      const now = Date.now()
      const until = songUrlRefreshUntil.get(key) || 0
      if (until > now) return null
      const pending = songUrlRefreshPending.get(key)
      if (pending) return pending
      const promise = (async () => {
        invalidateSongUrl(id, platform)
        return getSongUrl(id, platform)
      })().finally(() => {
        songUrlRefreshPending.delete(key)
        songUrlRefreshUntil.set(key, Date.now() + 15_000)
        while (songUrlRefreshUntil.size > SONG_URL_CACHE_MAX_ENTRIES) {
          const oldest = songUrlRefreshUntil.keys().next().value
          if (oldest === undefined) break
          songUrlRefreshUntil.delete(oldest)
        }
      })
      songUrlRefreshPending.set(key, promise)
      return promise
    }

    async function getSongUrl(id: number | string, platform: MusicPlatform = 'netease'): Promise<string | null> {
      ensureSongUrlListenersRegistered()
      if (!String(id).trim()) return null
      const cacheKey = buildSongUrlCacheKey(id, platform)
      const now = Date.now()
      const cached = songUrlCache.get(cacheKey)
      if (cached && cached.expiresAt > now) {
        songUrlCache.delete(cacheKey)
        songUrlCache.set(cacheKey, cached)
        return cached.url
      }
      if (cached) songUrlCache.delete(cacheKey)

      const pending = songUrlPending.get(cacheKey)
      if (pending) return pending

      const requestGeneration = songUrlCacheGeneration
      const requestVersion = songUrlInvalidationVersions.get(cacheKey) || 0
      const resolveCurrentRequest = async (): Promise<string | null> => {
        try {
          let apiUrl: string
          let readUrl: (data: any) => string | null
          if (platform === 'qq') {
            const cookie = localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
            const { preference, isVip } = getAudioQualityRequest('qq')
            apiUrl = `${API_BASE}/qq/song/url?mid=${encodeURIComponent(String(id))}&quality=${encodeURIComponent(preference)}&vip=${isVip ? 'true' : 'false'}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`
            readUrl = data => data.url || null
          } else {
            const cookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
            const fallbackSetting = localStorage.getItem('crossPlatformFallbackEnabled')
            const crossPlatformFallback = fallbackSetting !== null ? JSON.parse(fallbackSetting) : false
            const { preference, isVip } = getAudioQualityRequest('netease')
            apiUrl = `${API_BASE}/netease/song/url?id=${encodeURIComponent(String(id))}&quality=${encodeURIComponent(preference)}&vip=${isVip ? 'true' : 'false'}&fallback=${crossPlatformFallback ? 'true' : 'false'}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`
            readUrl = data => data.data?.[0]?.url || null
          }

          const response = await fetchSongUrlResponse(apiUrl)
          const data = await response.json().catch(() => ({}))
          if (!response.ok) {
            throw new Error(data?.error || `Playback URL request failed (${response.status})`)
          }

          if (requestGeneration !== songUrlCacheGeneration) {
            return getSongUrl(id, platform)
          }
          if ((songUrlInvalidationVersions.get(cacheKey) || 0) !== requestVersion) {
            return null
          }

          const url = readUrl(data)
          if (url && platform === 'netease' && data.fallback) {
            console.info(`[API] Netease song ${id} is using fallback audio from ${data.source || 'automatic match'}`)
          }
          cacheSongUrl(cacheKey, url)
          return url
        } catch (error) {
          if (requestGeneration !== songUrlCacheGeneration) {
            return getSongUrl(id, platform)
          }
          if ((songUrlInvalidationVersions.get(cacheKey) || 0) !== requestVersion) {
            return null
          }
          console.error(`[API] Failed to resolve ${platform} song ${id} playback URL:`, error)
          return null
        }
      }

      const request = resolveCurrentRequest()
      songUrlPending.set(cacheKey, request)
      try {
        return await request
      } finally {
        if (songUrlPending.get(cacheKey) === request) {
          songUrlPending.delete(cacheKey)
        }
      }
    }


    return { getSongUrl, clearSongUrlCache, invalidateSongUrl, refreshSongUrlOnce }
  }

  type UrlApi = ReturnType<typeof legacySongUrlApi>
  async function urlHarness(legacy: boolean) {
    let now = 1_000
    let value: string | null = 'https://audio/first'
    let failure = false
    let hold: Promise<void> | undefined
    localStorage.clear()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const host = new EventTarget()
    vi.stubGlobal('window', Object.assign(host, { setTimeout, clearTimeout }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetcher = vi.fn(async () => {
      const url = value
      const failed = failure
      await hold
      if (failed) throw new Error('网络失败')
      return Response.json({ url, data: [{ url }] })
    })
    vi.stubGlobal('fetch', fetcher)
    vi.resetModules()
    const api: UrlApi = legacy ? legacySongUrlApi() : await import('../src/services/musicApi')
    return {
      ...api,
      at(time: number) { now = time },
      upstream(url: string | null, failed = false) { value = url; failure = failed },
      hold() {
        let release!: () => void
        hold = new Promise<void>(resolve => { release = resolve })
        return () => { hold = undefined; release() }
      },
      get calls() { return fetcher.mock.calls.length },
      event(name: string) { host.dispatchEvent(new Event(name)) },
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  type UrlHarness = Awaited<ReturnType<typeof urlHarness>>
  async function compareUrlApi(script: (api: UrlHarness) => Promise<unknown>) {
    const legacy = await script(await urlHarness(true))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    const current = await script(await urlHarness(false))
    expect(current).toEqual(legacy)
  }

  it('保留五分钟正缓存、25 秒负缓存及精确到期边界', async () => {
    await compareUrlApi(async api => {
      const first = await api.getSongUrl(1)
      api.upstream('https://audio/next')
      api.at(300_999)
      expect(await api.getSongUrl(1)).toBe(first)
      api.at(301_000)
      const next = await api.getSongUrl(1)
      expect(next).toBe('https://audio/next')
      api.upstream(null)
      expect(await api.getSongUrl(2)).toBeNull()
      api.upstream('https://audio/recovered')
      api.at(325_999)
      expect(await api.getSongUrl(2)).toBeNull()
      api.at(326_000)
      const recovered = await api.getSongUrl(2)
      expect(recovered).toBe('https://audio/recovered')
      expect(api.calls).toBe(4)
      return { first, next, recovered, calls: api.calls }
    })
  })

  it('256 条按命中触达淘汰，写入前清理过期项', async () => {
    await compareUrlApi(async api => {
      for (let id = 1; id <= 256; id += 1) await api.getSongUrl(id)
      await api.getSongUrl(1)
      await api.getSongUrl(257)
      await api.getSongUrl(1)
      await api.getSongUrl(2)
      expect(api.calls).toBe(258)
      api.at(301_000)
      api.upstream('https://audio/refreshed')
      const refreshed = await api.getSongUrl(258)
      await api.getSongUrl(257)
      expect(api.calls).toBe(260)
      return { refreshed, calls: api.calls }
    })
  })

  it.each([false, true])('全局失效后旧请求%s也重新取当前设置，旧 finally 不删新 pending', async failed => {
    await compareUrlApi(async api => {
      api.upstream('https://audio/old', failed)
      const releaseOld = api.hold()
      const old = api.getSongUrl(1)
      api.clearSongUrlCache()
      api.upstream('https://audio/new')
      const releaseNew = api.hold()
      const current = api.getSongUrl(1)
      releaseOld()
      // 让旧请求完成失效检查；此时当前请求仍由另一道 gate 挡住。
      await new Promise(resolve => setTimeout(resolve, 0))
      const joined = api.getSongUrl(1)
      expect(api.calls).toBe(2)
      releaseNew()
      const values = await Promise.all([old, current, joined])
      expect(values).toEqual(Array(3).fill('https://audio/new'))
      return { values, calls: api.calls }
    })
  })

  it('单键失效阻断旧请求回写，但不删除同键的较新 pending', async () => {
    await compareUrlApi(async api => {
      const releaseOld = api.hold()
      const old = api.getSongUrl(1)
      api.invalidateSongUrl(1)
      api.upstream('https://audio/new')
      const releaseNew = api.hold()
      const current = api.getSongUrl(1)
      releaseOld()
      expect(await old).toBeNull()
      const joined = api.getSongUrl(1)
      expect(api.calls).toBe(2)
      releaseNew()
      const values = await Promise.all([current, joined])
      expect(values).toEqual(Array(2).fill('https://audio/new'))
      return { values, cached: await api.getSongUrl(1), calls: api.calls }
    })
  })

  it('每个设置维度隔离并沿用惰性事件清理', async () => {
    await compareUrlApi(async api => {
      await api.getSongUrl(1)
      localStorage.setItem('netease_cookie', 'MUSIC_U=one')
      await api.getSongUrl(1)
      localStorage.setItem('netease_vip', 'true')
      await api.getSongUrl(1)
      localStorage.setItem('audioQualitySettings', JSON.stringify({ netease: 'lossless' }))
      await api.getSongUrl(1)
      localStorage.setItem('crossPlatformFallbackEnabled', 'true')
      await api.getSongUrl(1)
      await api.getSongUrl(1, 'qq')
      api.event('hyperplayer-audio-quality-changed')
      await api.getSongUrl(1)
      api.event('hyperplayer-auth-changed')
      await api.getSongUrl(1)
      expect(api.calls).toBe(8)
      return api.calls
    })
  })

  it('单次刷新并发合并、按失败 URL 隔离，15 秒到点恢复', async () => {
    await compareUrlApi(async api => {
      const release = api.hold()
      const first = api.refreshSongUrlOnce(1, 'netease', 'https://failed/one')
      const joined = api.refreshSongUrlOnce(1, 'netease', 'https://failed/one')
      expect(api.calls).toBe(1)
      release()
      const values = await Promise.all([first, joined])
      expect(await api.refreshSongUrlOnce(1, 'netease', 'https://failed/one')).toBeNull()
      await api.refreshSongUrlOnce(1, 'netease', 'https://failed/two')
      api.at(16_000)
      await api.refreshSongUrlOnce(1, 'netease', 'https://failed/one')
      expect(api.calls).toBe(3)
      return { values, calls: api.calls }
    })
  })
})
