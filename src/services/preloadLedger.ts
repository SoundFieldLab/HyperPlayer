/**
 * 预载账本 module。
 *
 * App 原先在 `preloadCacheRef` 上手写条目形状、5 分钟 TTL、30 条上限、
 * URL / 歌词代际与 pending promise；同一段记录形状在预载、播放、重试、
 * 排序分析里各写一遍。本模块拥有这些语义，musicApi 的取 URL / 取歌词
 * 仍是 adapter，账本只负责“哪条已就绪、哪条过期、哪次异步写入还有效”。
 */

import type { LyricLine } from './musicApi'

export const PRELOAD_TTL_MS = 5 * 60 * 1000
export const PRELOAD_MAX_ENTRIES = 30

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

export class PreloadLedger {
  private readonly entries = new Map<string, PreloadEntry>()
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
    for (const [key, entry] of this.entries) {
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

  private entryFor(key: string): PreloadEntry {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { url: null, lyrics: [], timestamp: this.now() }
      this.entries.set(key, entry)
    }
    return entry
  }
}
