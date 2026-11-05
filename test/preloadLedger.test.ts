import { describe, expect, it } from 'vitest'
import { PreloadLedger } from '../src/services/preloadLedger'
import type { LyricLine } from '../src/services/musicApi'

const line = (time: number, text: string): LyricLine => ({ time, text })

function makeLedger(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000
  const ledger = new PreloadLedger({
    ttlMs: options.ttlMs ?? 5_000,
    maxEntries: options.maxEntries ?? 30,
    now: () => now,
  })
  return {
    ledger,
    advance: (ms: number) => { now += ms },
    at: (value: number) => { now = value },
    get now() { return now },
  }
}

describe('PreloadLedger URL 条目', () => {
  it('TTL 内命中，过期后返回 null', () => {
    const { ledger, advance } = makeLedger({ ttlMs: 5_000 })
    ledger.setUrlIfCurrent('song', 'https://audio/1', ledger.audioUrlGeneration)

    expect(ledger.getFreshUrl('song')).toBe('https://audio/1')
    advance(4_999)
    expect(ledger.getFreshUrl('song')).toBe('https://audio/1')
    advance(2)
    expect(ledger.getFreshUrl('song')).toBeNull()
  })

  it('写 URL 保留已有歌词', () => {
    const { ledger } = makeLedger()
    ledger.completeLyrics('song', [line(1, '词')], ledger.lyricsGeneration, 'policy')

    ledger.setUrlIfCurrent('song', 'https://audio/1', ledger.audioUrlGeneration)

    expect(ledger.getLyrics('song')).toEqual([line(1, '词')])
    expect(ledger.getLyricsSnapshot('song', 'policy').loaded).toBe(true)
  })

  it('过期代际的 URL 写入被丢弃', () => {
    const { ledger } = makeLedger()
    const generation = ledger.audioUrlGeneration
    ledger.invalidateAudioUrls()

    expect(ledger.setUrlIfCurrent('song', 'https://audio/old', generation)).toBe(false)
    expect(ledger.getFreshUrl('song')).toBeNull()

    expect(ledger.setUrlIfCurrent('song', 'https://audio/new', ledger.audioUrlGeneration)).toBe(true)
    expect(ledger.getFreshUrl('song')).toBe('https://audio/new')
  })

  it('失效音频 URL 会清空全部 URL 并递增代际', () => {
    const { ledger } = makeLedger()
    ledger.setUrlIfCurrent('a', 'https://a', ledger.audioUrlGeneration)
    ledger.setUrlIfCurrent('b', 'https://b', ledger.audioUrlGeneration)
    const before = ledger.audioUrlGeneration

    ledger.invalidateAudioUrls()

    expect(ledger.audioUrlGeneration).toBe(before + 1)
    expect(ledger.getFreshUrl('a')).toBeNull()
    expect(ledger.getFreshUrl('b')).toBeNull()
  })
})

describe('PreloadLedger 歌词生命周期', () => {
  it('begin 后快照是 fresh 但未 loaded，并共享进行中的 promise', async () => {
    const { ledger } = makeLedger()
    const request = Promise.resolve([line(1, 'a')])

    ledger.beginLyrics('song', 'policy', request)
    const snapshot = ledger.getLyricsSnapshot('song', 'policy')

    expect(snapshot.fresh).toBe(true)
    expect(snapshot.loaded).toBe(false)
    expect(snapshot.promise).toBe(request)
    await expect(snapshot.promise).resolves.toEqual([line(1, 'a')])
  })

  it('progress 保留 URL 与 promise，complete 清掉 promise', () => {
    const { ledger } = makeLedger()
    ledger.setUrlIfCurrent('song', 'https://audio/1', ledger.audioUrlGeneration)
    const request = Promise.resolve([])
    ledger.beginLyrics('song', 'policy', request)

    ledger.updateLyricsProgress('song', [line(1, '基础')], ledger.lyricsGeneration, 'policy')
    expect(ledger.getFreshUrl('song')).toBe('https://audio/1')
    expect(ledger.getLyricsSnapshot('song', 'policy').promise).toBe(request)
    expect(ledger.getLyricsSnapshot('song', 'policy').loaded).toBe(false)

    ledger.completeLyrics('song', [line(1, '最终')], ledger.lyricsGeneration, 'policy')
    expect(ledger.getLyrics('song')).toEqual([line(1, '最终')])
    expect(ledger.getLyricsSnapshot('song', 'policy').promise).toBeUndefined()
    expect(ledger.getLyricsSnapshot('song', 'policy').loaded).toBe(true)
  })

  it('fail 清 promise、保留已有歌词且不标记 loaded', () => {
    const { ledger } = makeLedger()
    ledger.completeLyrics('song', [line(1, '旧')], ledger.lyricsGeneration, 'policy')
    ledger.beginLyrics('song', 'policy', Promise.resolve([]))

    ledger.failLyrics('song', ledger.lyricsGeneration, 'policy')

    expect(ledger.getLyrics('song')).toEqual([line(1, '旧')])
    expect(ledger.getLyricsSnapshot('song', 'policy').loaded).toBe(false)
    expect(ledger.getLyricsSnapshot('song', 'policy').promise).toBeUndefined()
  })

  it('过期代际的 progress / complete / fail 都被丢弃', () => {
    const { ledger } = makeLedger()
    const stale = ledger.lyricsGeneration
    ledger.invalidateLyrics()

    expect(ledger.updateLyricsProgress('song', [line(1, '旧')], stale, 'policy')).toBe(false)
    expect(ledger.completeLyrics('song', [line(1, '旧')], stale, 'policy')).toBe(false)
    expect(ledger.failLyrics('song', stale, 'policy')).toBe(false)
    expect(ledger.getLyrics('song')).toEqual([])
  })

  it('策略键变化后歌词不再 fresh', () => {
    const { ledger } = makeLedger()
    ledger.completeLyrics('song', [line(1, 'a')], ledger.lyricsGeneration, 'AMLL')

    expect(ledger.getLyricsSnapshot('song', 'AMLL').fresh).toBe(true)
    expect(ledger.getLyricsSnapshot('song', 'Platform').fresh).toBe(false)
  })

  it('清空歌词保留 URL、递增代际并清掉策略', () => {
    const { ledger } = makeLedger()
    ledger.setUrlIfCurrent('song', 'https://audio/1', ledger.audioUrlGeneration)
    ledger.completeLyrics('song', [line(1, 'a')], ledger.lyricsGeneration, 'policy')
    const before = ledger.lyricsGeneration

    ledger.invalidateLyrics()

    expect(ledger.lyricsGeneration).toBe(before + 1)
    expect(ledger.getLyrics('song')).toEqual([])
    expect(ledger.getFreshUrl('song')).toBe('https://audio/1')
    expect(ledger.getLyricsSnapshot('song', 'policy').fresh).toBe(false)
  })
})

describe('PreloadLedger 清理', () => {
  it('只删除 URL 与歌词都过期的条目', () => {
    const { ledger, advance } = makeLedger({ ttlMs: 1_000 })
    ledger.setUrlIfCurrent('both', 'https://both', ledger.audioUrlGeneration)
    ledger.completeLyrics('both', [line(1, 'a')], ledger.lyricsGeneration, 'policy')

    advance(1_001)
    ledger.setUrlIfCurrent('url-fresh', 'https://old-url', ledger.audioUrlGeneration)
    ledger.setUrlIfCurrent('lyrics-fresh', 'https://old-url', ledger.audioUrlGeneration)
    advance(1_500)
    ledger.setUrlIfCurrent('url-fresh', 'https://new-url', ledger.audioUrlGeneration)
    ledger.completeLyrics('lyrics-fresh', [line(1, 'a')], ledger.lyricsGeneration, 'policy')

    ledger.prune()

    expect(ledger.has('both')).toBe(false)
    expect(ledger.has('url-fresh')).toBe(true)
    expect(ledger.has('lyrics-fresh')).toBe(true)
  })

  it('超过上限时按 URL 时间淘汰最旧条目', () => {
    const { ledger, advance } = makeLedger({ maxEntries: 2 })
    ledger.setUrlIfCurrent('a', 'https://a', ledger.audioUrlGeneration)
    advance(100)
    ledger.setUrlIfCurrent('b', 'https://b', ledger.audioUrlGeneration)
    advance(100)
    ledger.setUrlIfCurrent('c', 'https://c', ledger.audioUrlGeneration)

    ledger.prune()

    expect(ledger.size).toBe(2)
    expect(ledger.has('a')).toBe(false)
    expect(ledger.has('b')).toBe(true)
    expect(ledger.has('c')).toBe(true)
  })
})
