/**
 * 进程内过期缓存 module。
 *
 * `local-server.mjs` 原先至少有 6 套手写 `Map + TTL + 上限` 实现（QQ 歌单详情、
 * 播放元数据、网易云专辑封面、歌曲详情、歌单 trackIds、推荐类接口、最近播放计数），
 * 其中过期判定、LRU 触达、批量收缩与「写入前先清过期」的语义已经分叉。
 * 本模块只拥有这些通用语义；站点特有语义（cookie 作用域、并发合并）留在调用方。
 *
 * 有意保持 Node 侧零依赖、可注入时钟，便于用假时钟测试。
 */

export class TtlCache {
  /**
   * @param {object} options
   * @param {number} options.ttlMs 条目存活时间；传 `Infinity` 表示只按容量淘汰（无过期）
   * @param {number} options.maxEntries 条目上限
   * @param {number} [options.evictTo] 超限时收缩到的条数；缺省为一次只淘汰一条
   * @param {boolean} [options.touchOnGet] 命中时是否移到末尾（LRU）；默认 true
   * @param {() => number} [options.now] 可注入时钟，默认 Date.now
   */
  constructor({ ttlMs, maxEntries, evictTo, touchOnGet = true, now = Date.now }) {
    if (!(ttlMs > 0)) throw new Error('TtlCache: ttlMs 必须为正数')
    if (!(maxEntries > 0)) throw new Error('TtlCache: maxEntries 必须为正数')
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.evictTo = evictTo && evictTo > 0 && evictTo < maxEntries ? evictTo : null
    this.touchOnGet = touchOnGet
    this.now = now
    this.entries = new Map()
  }

  get size() {
    return this.entries.size
  }

  /** 命中返回 value；过期、缺失或值本身不存在时返回 null。 */
  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return null
    }
    if (this.touchOnGet) {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return entry.value
  }

  /** 写入并刷新过期时间；`undefined` / `null` / 空键一律忽略。返回是否写入。 */
  set(key, value) {
    if (!key || value === undefined || value === null) return false
    const now = this.now()
    // 只在接近上限时才扫过期，避免逐条写入的热路径退化成 O(n²)
    //（neteaseSongDetailCache 会按歌单逐曲写入，最多一次几千条）。
    if (this.entries.size + 1 > this.maxEntries) this.pruneExpired(now)
    const existing = this.entries.get(key)
    if (existing && !this.touchOnGet) {
      // 非 LRU（FIFO）缓存：重写同一个键保持原位置，与原 `Map.set` 语义一致。
      existing.value = value
      existing.expiresAt = now + this.ttlMs
    } else {
      this.entries.delete(key)
      this.entries.set(key, { value, expiresAt: now + this.ttlMs })
    }
    this.enforceLimit()
    return true
  }

  delete(key) {
    return this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }

  /** 清掉所有已过期条目。 */
  prune() {
    this.pruneExpired(this.now())
  }

  /** @private */
  pruneExpired(now) {
    if (this.ttlMs === Infinity) return
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  /** @private */
  enforceLimit() {
    if (this.evictTo !== null) {
      if (this.entries.size <= this.maxEntries) return
      while (this.entries.size > this.evictTo) {
        const oldest = this.entries.keys().next().value
        if (oldest === undefined) return
        this.entries.delete(oldest)
      }
      return
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      this.entries.delete(oldest)
    }
  }
}

/**
 * 把 cookie 折叠进缓存键，避免不同账号的私有数据互串。
 * 与服务端既有的 `recommendCacheKeyWithCookie` 语义一致（短整数哈希）。
 */
export function cookieScopedKey(prefix, id, cookie) {
  let hash = 7
  const value = String(cookie || '')
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return `${prefix}:${String(id)}:${hash}`
}
