/**
 * 预载账本 module。
 *
 * App 原先在 `preloadCacheRef` 上手写条目形状、5 分钟 TTL、30 条上限、
 * URL / 歌词代际与 pending promise；同一段记录形状在预载、播放、重试、
 * 排序分析里各写一遍。本模块拥有这些语义，musicApi 的取 URL / 取歌词
 * 仍是 adapter，账本只负责“哪条已就绪、哪条过期、哪次异步写入还有效”。
 * 取歌请求使用独立实例（256 条 LRU），复用 URL 条目与音频代际，并拥有负缓存、
 * 单键失效、请求合并和失败 URL 冷却；App 预载实例仍按原 30 条规则清理。
 */

import type { LyricLine } from './musicApi'

export const PRELOAD_TTL_MS = 5 * 60 * 1000
export const PRELOAD_MAX_ENTRIES = 30
const URL_NEGATIVE_CACHE_TTL_MS = 25_000
const URL_REFRESH_COOLDOWN_MS = 15_000

export interface PreloadEntry {
  url: string | null
  lyrics: LyricLine[]
  timestamp: number
  urlTimestamp?: number
  lyricsTimestamp?: number
  lyricsLoaded?: boolean
  lyricsPromise?: Promise<LyricLine[]>
  lyricsPolicyKey?: string
}

export interface PreloadLyricsSnapshot {
  lyrics: LyricLine[]
  promise?: Promise<LyricLine[]>
  loaded: boolean
  fresh: boolean
}

export interface PreloadLedgerOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

interface LedgerEntry extends PreloadEntry {
  resolvedUrlExpiresAt?: number
}

interface UrlRequest {
  load: () => Promise<string | null>
  retry: () => Promise<string | null>
  onError?: (error: unknown) => void
}

export class PreloadLedger {
  private readonly entries = new Map<string, LedgerEntry>()
  private readonly urlPending = new Map<string, Promise<string | null>>()
  private readonly urlInvalidationVersions = new Map<string, number>()
  private readonly urlRefreshPending = new Map<string, Promise<string | null>>()
  private readonly urlRefreshUntil = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private audioGeneration = 0
  private lyricsGenerationCounter = 0

  constructor(options: PreloadLedgerOptions = {}) {
    this.ttlMs = options.ttlMs ?? PRELOAD_TTL_MS
    this.maxEntries = options.maxEntries ?? PRELOAD_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  /** URL 异步写入的失效代际；await 前捕获，写回时交给 setUrlIfCurrent。 */
  get audioUrlGeneration(): number {
    return this.audioGeneration
  }

  /** 歌词异步写入的失效代际；progress / complete / fail 都会校验。 */
  get lyricsGeneration(): number {
    return this.lyricsGenerationCounter
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** 原始 URL（不做时效判断）；用于当前播放源的响度归一化，不用于预载命中。 */
  getUrl(key: string): string | null {
    return this.entries.get(key)?.url ?? null
  }

  getLyrics(key: string): LyricLine[] {
    return this.entries.get(key)?.lyrics ?? []
  }

  /** 只返回仍在新窗口内的 URL；过期条目不在这里删除，交给 prune。 */
  getFreshUrl(key: string): string | null {
    const entry = this.entries.get(key)
    if (!entry?.url) return null
    const age = this.now() - (entry.urlTimestamp ?? entry.timestamp)
    return age < this.ttlMs ? entry.url : null
  }

  /** 取歌请求使用独立实例：正结果沿用 TTL，null 结果缓存 25 秒，命中按 LRU 触达。 */
  async resolveUrl(key: string, request: UrlRequest): Promise<string | null> {
    const cached = this.entries.get(key)
    if (cached?.resolvedUrlExpiresAt !== undefined && cached.resolvedUrlExpiresAt > this.now()) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.url
    }
    if (cached) this.entries.delete(key)

    const pending = this.urlPending.get(key)
    if (pending) return pending
    const generation = this.audioGeneration
    const version = this.urlInvalidationVersions.get(key) || 0
    const resolveCurrentRequest = async (): Promise<string | null> => {
      try {
        const url = await request.load()
        if (generation !== this.audioGeneration) return request.retry()
        if ((this.urlInvalidationVersions.get(key) || 0) !== version) return null
        this.cacheResolvedUrl(key, url)
        return url
      } catch (error) {
        if (generation !== this.audioGeneration) return request.retry()
        if ((this.urlInvalidationVersions.get(key) || 0) !== version) return null
        request.onError?.(error)
        return null
      }
    }
    const promise = resolveCurrentRequest()
    this.urlPending.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.urlPending.get(key) === promise) this.urlPending.delete(key)
    }
  }

  /** 取歌缓存单键失效：旧请求丢弃结果，下一次请求重新解析。 */
  invalidateUrl(key: string): void {
    this.entries.delete(key)
    this.urlPending.delete(key)
    const nextVersion = (this.urlInvalidationVersions.get(key) || 0) + 1
    this.urlInvalidationVersions.delete(key)
    this.urlInvalidationVersions.set(key, nextVersion)
    while (this.urlInvalidationVersions.size > this.maxEntries) {
      const oldestKey = this.urlInvalidationVersions.keys().next().value
      if (oldestKey === undefined) break
      this.urlInvalidationVersions.delete(oldestKey)
    }
  }

  /** 失败 URL 的一次刷新：合并并发，完成后冷却 15 秒。key 由 adapter 带上失败 URL 指纹。 */
  async refreshUrlOnce(key: string, refresh: () => Promise<string | null>): Promise<string | null> {
    const until = this.urlRefreshUntil.get(key) || 0
    if (until > this.now()) return null
    const pending = this.urlRefreshPending.get(key)
    if (pending) return pending
    const promise = (async () => refresh())().finally(() => {
      this.urlRefreshPending.delete(key)
      this.urlRefreshUntil.set(key, this.now() + URL_REFRESH_COOLDOWN_MS)
      while (this.urlRefreshUntil.size > this.maxEntries) {
        const oldest = this.urlRefreshUntil.keys().next().value
        if (oldest === undefined) break
        this.urlRefreshUntil.delete(oldest)
      }
    })
    this.urlRefreshPending.set(key, promise)
    return promise
  }

  /** 清空取歌实例的全部缓存与冷却；在途 URL 请求沿用全局代际检查。 */
  clear(): void {
    this.invalidateAudioUrls()
    this.entries.clear()
    this.urlRefreshPending.clear()
    this.urlRefreshUntil.clear()
  }

  private cacheResolvedUrl(key: string, url: string | null): void {
    const now = this.now()
    for (const [cachedKey, entry] of this.entries) {
      if (entry.resolvedUrlExpiresAt !== undefined && entry.resolvedUrlExpiresAt <= now) {
        this.entries.delete(cachedKey)
      }
    }
    this.entries.delete(key)
    this.entries.set(key, {
      url, lyrics: [], timestamp: now, urlTimestamp: now,
      resolvedUrlExpiresAt: now + (url ? this.ttlMs : URL_NEGATIVE_CACHE_TTL_MS),
    })
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }

  getLyricsSnapshot(key: string, policyKey: string): PreloadLyricsSnapshot {
    const entry = this.entries.get(key)
    if (!entry) return { lyrics: [], loaded: false, fresh: false }
    const fresh = entry.lyricsPolicyKey === policyKey
      && this.now() - (entry.lyricsTimestamp ?? entry.timestamp) < this.ttlMs
    return {
      lyrics: entry.lyrics,
      promise: entry.lyricsPromise,
      loaded: Boolean(entry.lyricsLoaded),
      fresh,
    }
  }

  private storeUrl(key: string, url: string | null): void {
    const entry = this.entryFor(key)
    entry.url = url
    entry.urlTimestamp = this.now()
    entry.timestamp = this.now()
  }

  /** 异步取 URL 回来时使用：代际已变则丢弃这次写入。 */
  setUrlIfCurrent(key: string, url: string | null, generation: number): boolean {
    if (generation !== this.audioGeneration) return false
    this.storeUrl(key, url)
    return true
  }

  clearUrl(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.storeUrl(key, null)
  }

  /** 音质 / 登录态变化：所有 URL 失效，异步写入代际递增。 */
  invalidateAudioUrls(): void {
    this.audioGeneration += 1
    this.urlPending.clear()
    this.urlInvalidationVersions.clear()
    for (const [key, entry] of this.entries) {
      entry.resolvedUrlExpiresAt = undefined
      if (!entry.url) continue
      this.storeUrl(key, null)
    }
  }

  beginLyrics(key: string, policyKey: string, promise: Promise<LyricLine[]>): void {
    const entry = this.entryFor(key)
    entry.timestamp = this.now()
    entry.lyricsTimestamp = this.now()
    entry.lyricsLoaded = false
    entry.lyricsPromise = promise
    entry.lyricsPolicyKey = policyKey
  }

  updateLyricsProgress(
    key: string,
    lyrics: LyricLine[],
    generation: number,
    policyKey: string,
  ): boolean {
    if (generation !== this.lyricsGenerationCounter) return false
    const entry = this.entryFor(key)
    entry.lyrics = lyrics
    entry.timestamp = this.now()
    entry.lyricsTimestamp = this.now()
    entry.lyricsLoaded = false
    entry.lyricsPolicyKey = policyKey
    return true
  }

  completeLyrics(
    key: string,
    lyrics: LyricLine[],
    generation: number,
    policyKey: string,
  ): boolean {
    if (generation !== this.lyricsGenerationCounter) return false
    const entry = this.entryFor(key)
    entry.lyrics = lyrics
    entry.timestamp = this.now()
    entry.lyricsTimestamp = this.now()
    entry.lyricsLoaded = true
    entry.lyricsPromise = undefined
    entry.lyricsPolicyKey = policyKey
    return true
  }

  failLyrics(key: string, generation: number, policyKey: string): boolean {
    if (generation !== this.lyricsGenerationCounter) return false
    const entry = this.entryFor(key)
    entry.lyricsLoaded = false
    entry.lyricsPromise = undefined
    entry.lyricsPolicyKey = policyKey
    return true
  }

  /** 歌词策略 / 解析版本变化：清掉所有歌词，但保留 URL 与条目。 */
  invalidateLyrics(): void {
    this.lyricsGenerationCounter += 1
    for (const entry of this.entries.values()) {
      entry.lyrics = []
      entry.lyricsLoaded = false
      entry.lyricsPromise = undefined
      entry.lyricsTimestamp = undefined
      entry.lyricsPolicyKey = undefined
    }
  }

  /** 删除 URL 与歌词都已过期的条目，再按最旧 URL 时间压到上限。 */
  prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      const urlTime = entry.urlTimestamp ?? entry.timestamp
      const lyricsTime = entry.lyricsTimestamp ?? entry.timestamp
      if (now - urlTime > this.ttlMs && now - lyricsTime > this.ttlMs) {
        this.entries.delete(key)
      }
    }

    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | null = null
      let oldestTime = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        const time = entry.urlTimestamp ?? entry.timestamp
        if (time < oldestTime) {
          oldestTime = time
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      this.entries.delete(oldestKey)
    }
  }

  private entryFor(key: string): LedgerEntry {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { url: null, lyrics: [], timestamp: this.now() }
      this.entries.set(key, entry)
    }
    return entry
  }
}
