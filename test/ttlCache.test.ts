import { describe, expect, it } from 'vitest'
import { TtlCache, cookieScopedKey } from '../server/ttl-cache.mjs'

const clock = (start = 1_000) => {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => { now += ms },
  }
}

describe('命中与过期', () => {
  it('TTL 内命中，过期后返回 null 并删除条目', () => {
    const time = clock()
    const cache = new TtlCache({ ttlMs: 1_000, maxEntries: 10, now: time.now })
    cache.set('a', 'A')

    expect(cache.get('a')).toBe('A')
    time.advance(999)
    expect(cache.get('a')).toBe('A')
    time.advance(2)
    expect(cache.get('a')).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('未设置过的键返回 null', () => {
    const cache = new TtlCache({ ttlMs: 1_000, maxEntries: 10 })
    expect(cache.get('missing')).toBeNull()
  })

  it('undefined / null 值不会被写入', () => {
    const cache = new TtlCache({ ttlMs: 1_000, maxEntries: 10 })
    cache.set('a', undefined)
    cache.set('b', null)

    expect(cache.size).toBe(0)
  })

  it('空字符串键不会被写入', () => {
    const cache = new TtlCache({ ttlMs: 1_000, maxEntries: 10 })
    cache.set('', 'A')
    expect(cache.size).toBe(0)
  })
})

describe('LRU 语义', () => {
  it('touchOnGet 时命中会移到末尾，淘汰最久未用', () => {
    const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 2, touchOnGet: true })
    cache.set('a', 'A')
    cache.set('b', 'B')
    expect(cache.get('a')).toBe('A')

    cache.set('c', 'C')

    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).toBe('A')
    expect(cache.get('c')).toBe('C')
  })

  it('关闭 touchOnGet 时按写入顺序淘汰', () => {
    const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 2, touchOnGet: false })
    cache.set('a', 'A')
    cache.set('b', 'B')
    expect(cache.get('a')).toBe('A')

    cache.set('c', 'C')

    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBe('B')
  })

  it('FIFO 模式下重写同一键保持原队位', () => {
    const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 2, touchOnGet: false })
    cache.set('a', 'A1')
    cache.set('b', 'B')
    cache.set('a', 'A2')

    cache.set('c', 'C')

    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBe('B')
    expect(cache.get('c')).toBe('C')
  })

  it('覆盖已有键不会增长条数，并刷新它的位置与过期时间', () => {
    const time = clock()
    const cache = new TtlCache({ ttlMs: 1_000, maxEntries: 2, now: time.now })
    cache.set('a', 'old')
    cache.set('b', 'B')
    time.advance(900)
    cache.set('a', 'new')
    time.advance(500)

    expect(cache.get('a')).toBe('new')
    expect(cache.get('b')).toBeNull()
  })
})

describe('容量与批量收缩', () => {
  it('超过上限时整批收缩到 evictTo', () => {
    const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 5, evictTo: 3 })
    for (const key of ['a', 'b', 'c', 'd', 'e']) cache.set(key, key)

    cache.set('f', 'f')

    expect(cache.size).toBe(3)
    expect(cache.get('d')).toBe('d')
    expect(cache.get('e')).toBe('e')
    expect(cache.get('f')).toBe('f')
  })

  it('写入前先清掉已过期条目，避免它们挤占名额', () => {
    const time = clock()
    const cache = new TtlCache({ ttlMs: 100, maxEntries: 2, now: time.now })
    cache.set('dead', 1)
    time.advance(200)

    cache.set('a', 'A')
    cache.set('b', 'B')

    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBe('A')
    expect(cache.get('b')).toBe('B')
  })

  it('逐条写入大量条目时不会每写一次就全表扫过期（热路径）', () => {
    const time = clock()
    const cache = new TtlCache({ ttlMs: 100_000, maxEntries: 5_000, now: time.now })
    let scans = 0
    const spy = cache as unknown as { pruneExpired: (now: number) => void }
    const original = spy.pruneExpired.bind(cache)
    spy.pruneExpired = (now: number) => { scans += 1; original(now) }

    for (let index = 0; index < 1_000; index += 1) cache.set(`k${index}`, index)

    // 只在接近上限（或超限）时才需要扫过期
    expect(scans).toBe(0)
    expect(cache.size).toBe(1_000)
  })
})

describe('手动操作', () => {
  it('delete 与 clear 生效', () => {
    const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 4 })
    cache.set('a', 'A')
    cache.set('b', 'B')

    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('a')).toBe(false)
    expect(cache.size).toBe(1)

    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('prune 清掉所有过期条目', () => {
    const time = clock()
    const cache = new TtlCache({ ttlMs: 100, maxEntries: 10, now: time.now })
    cache.set('a', 'A')
    time.advance(50)
    cache.set('b', 'B')
    time.advance(60)

    cache.prune()

    expect(cache.size).toBe(1)
    expect(cache.get('b')).toBe('B')
  })
})

describe('无过期模式（ttlMs = Infinity）', () => {
  it('只按容量淘汰，永不因时间过期', () => {
    const time = clock()
    const cache = new TtlCache({ ttlMs: Infinity, maxEntries: 2, now: time.now })
    cache.set('a', 'A')
    time.advance(10 * 365 * 24 * 60 * 60 * 1000)

    expect(cache.get('a')).toBe('A')
    cache.prune()
    expect(cache.size).toBe(1)
  })
})

describe('cookieScopedKey', () => {
  it('相同 cookie 生成相同键，不同 cookie 生成不同键', () => {
    expect(cookieScopedKey('ne:simi', 1, 'a=1')).toBe(cookieScopedKey('ne:simi', 1, 'a=1'))
    expect(cookieScopedKey('ne:simi', 1, 'a=1')).not.toBe(cookieScopedKey('ne:simi', 1, 'a=2'))
  })

  it('空 cookie 也稳定，且与 guest 之外的键不同', () => {
    expect(cookieScopedKey('ne:banner', 1, '')).toBe(cookieScopedKey('ne:banner', 1, ''))
    expect(cookieScopedKey('ne:banner', 1, '')).not.toBe(cookieScopedKey('ne:banner', 2, ''))
  })

  it('与旧实现（hash=7 起始、*31 累加）逐值一致', () => {
    // 旧实现的字面复刻，用于钉住键格式不漂移（漂移会让既有进程内缓存全部失效）。
    const legacy = (prefix: string, id: unknown, cookie: unknown) => {
      let hash = 7
      const cookieStr = String(cookie || '')
      for (let i = 0; i < cookieStr.length; i += 1) {
        hash = (hash * 31 + cookieStr.charCodeAt(i)) | 0
      }
      return `${prefix}:${String(id)}:${hash}`
    }

    expect(cookieScopedKey('ne:simi', 42, 'MUSIC_U=abc')).toBe(legacy('ne:simi', 42, 'MUSIC_U=abc'))
    expect(cookieScopedKey('qq:user-profile', 'u1', '')).toBe(legacy('qq:user-profile', 'u1', ''))
  })
})
