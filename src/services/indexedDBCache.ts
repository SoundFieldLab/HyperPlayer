import type { MusicPlatform } from './platforms'
const DB_NAME = 'HyperPlayerCache'
const DB_VERSION = 2
const COVER_STORE = 'covers'
const PLAYLIST_STORE = 'playlists'
const LYRICS_STORE = 'lyrics'
const METADATA_STORE = 'metadata'

const DAY = 24 * 60 * 60 * 1000
const COVER_TTL = 30 * DAY
const PLAYLIST_TTL = 60 * 60 * 1000
const LYRICS_TTL = 30 * DAY
// 缓存上限按 TV 性能模式动态取值（TV 存储小严格限制；PC 维持原值）
import { getCacheLimits } from '../tv/perfMode'
const limits = getCacheLimits
const MAX_COVERS = () => limits().coverCount
const MAX_COVER_BYTES = () => limits().idbCoverBytes
const MAX_PLAYLISTS = () => limits().playlistCount
const MAX_PLAYLIST_BYTES = () => limits().playlistBytes
const MAX_LYRICS = () => limits().lyricCount
const MAX_LYRICS_BYTES = () => limits().lyricBytes

interface CoverCacheItem {
  url: string
  data: Blob
  timestamp: number
  size: number
  accessCount: number
  lastAccess: number
}

interface DataCacheItem {
  id: string
  platform: MusicPlatform
  data: unknown
  timestamp: number
  lastAccess: number
  size: number
}

/**
 * 访问统计的内存累计项（自上次 flush 以来的增量）
 */
interface PendingAccess {
  storeName: string
  key: IDBValidKey
  increments: number // 累计命中次数，flush 时叠加到记录上
  lastAccess: number // 最近一次命中时间
}

export interface IndexedDBCacheStats {
  coverCount: number
  coverSize: number
  playlistCount: number
  playlistSize: number
  lyricsCount: number
  lyricsSize: number
}

function serializedSize(value: unknown): number {
  return new Blob([JSON.stringify(value)]).size
}

class IndexedDBCache {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null
  // 修剪节流：全量扫描（游标遍历 + 排序）只在节流间隔内首次触发或数量超限时执行，
  // 避免每次写入都 O(n log n) 遍历整个 store。cleanupExpired/超限时强制立即修剪。
  private readonly ENFORCE_LIMIT_INTERVAL = 60 * 1000
  private lastEnforceLimitAt: Record<string, number> = {}

  // 命中缓存的访问统计只在此累计（键为 `${storeName}\u0000${主键}`，store 名与主键内均不含该字符故无歧义），
  // 不再每次命中都开 readwrite 事务把整条记录（封面 Blob 可能十几 MB）重写一遍。
  // 定时/页面隐藏时合并写回；pending 上限：统计只影响 LRU 排序、不影响数据本体，
  // 超限时丢弃最冷的一条即可（丢弃代价远小于一次性写出数百条大记录）。
  private readonly ACCESS_FLUSH_INTERVAL = 30 * 1000
  private readonly MAX_PENDING_ACCESS = 256
  private pendingAccess = new Map<string, PendingAccess>()
  private accessFlushTimer: number | null = null
  private accessFlushBound = false
  private accessFlushRunning = false

  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => { this.initPromise = null; reject(request.error) }
      request.onblocked = () => { this.initPromise = null; reject(new Error('IndexedDB 升级被其他窗口阻塞')) }
      request.onsuccess = () => {
        this.db = request.result
        this.db.onversionchange = () => this.close()
        resolve()
      }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(COVER_STORE)) {
          const store = db.createObjectStore(COVER_STORE, { keyPath: 'url' })
          store.createIndex('lastAccess', 'lastAccess')
        }
        if (!db.objectStoreNames.contains(PLAYLIST_STORE)) db.createObjectStore(PLAYLIST_STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(LYRICS_STORE)) db.createObjectStore(LYRICS_STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(METADATA_STORE)) db.createObjectStore(METADATA_STORE, { keyPath: 'key' })
      }
    })
    return this.initPromise
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await this.init()
    if (!this.db) throw new Error('IndexedDB 尚未初始化')
    return this.db.transaction(name, mode).objectStore(name)
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'))
    })
  }

  async cacheCover(url: string, blob: Blob): Promise<void> {
    url = url.trim()
    if (!url) throw new Error('封面 URL 不能为空')
    if (blob.size > 10 * 1024 * 1024) return
    const now = Date.now()
    // 去重：同一 URL 已有未过期缓存时跳过写入。切歌/并发加载对同一封面重复
    // 命中这里时直接返回，避免每次切歌都对同一封面重复执行写事务与空间修剪。
    const readStore = await this.store(COVER_STORE, 'readonly')
    const existing = await this.request(readStore.get(url)) as CoverCacheItem | undefined
    if (existing && now - Math.max(existing.timestamp, existing.lastAccess || 0) <= COVER_TTL) return
    await this.enforceLimit(COVER_STORE, MAX_COVERS() - 1, MAX_COVER_BYTES() - blob.size, COVER_TTL)
    const writeStore = await this.store(COVER_STORE, 'readwrite')
    await this.request(writeStore.put({ url, data: blob, timestamp: now, size: blob.size, accessCount: 1, lastAccess: now } as CoverCacheItem))
    // 新记录自带最新统计，丢弃该 url 的 pending 以免旧增量叠加到新记录上
    this.dropPendingAccess(COVER_STORE, url)
  }

  /**
   * 以 Blob 形式读取封面缓存。调用方应使用 URL.createObjectURL 展示，
   * 避免反复生成并长期持有 base64 DataURL 大字符串导致内存膨胀。
   */
  async getCoverBlob(url: string): Promise<Blob | null> {
    url = url.trim()
    if (!url) return null
    // 纯读取用 readonly 事务，避免与写入（缓存新封面）争用同一 store
    const readStore = await this.store(COVER_STORE, 'readonly')
    const item = await this.request(readStore.get(url)) as CoverCacheItem | undefined
    if (!item) return null
    if (Date.now() - Math.max(item.timestamp, item.lastAccess || 0) > COVER_TTL) {
      const deleteStore = await this.store(COVER_STORE, 'readwrite')
      await this.request(deleteStore.delete(url))
      return null
    }
    // 更新访问统计（LRU）：只累计到内存 pending，不再每次命中都重写整条记录
    this.trackAccess(COVER_STORE, url)
    return item.data
  }

  async getCachedCover(url: string): Promise<string | null> {
    url = url.trim()
    if (!url) return null
    const blob = await this.getCoverBlob(url)
    if (!blob) return null
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  }

  async cachePlaylist(id: string, platform: MusicPlatform, data: unknown): Promise<void> {
    await this.cacheData(PLAYLIST_STORE, id, platform, data, MAX_PLAYLISTS(), MAX_PLAYLIST_BYTES(), PLAYLIST_TTL)
  }

  async getCachedPlaylist<T = unknown>(id: string, platform: MusicPlatform): Promise<T | null> {
    return this.getData<T>(PLAYLIST_STORE, id, platform, PLAYLIST_TTL)
  }

  async invalidatePlaylist(id: string, platform: MusicPlatform): Promise<void> {
    const store = await this.store(PLAYLIST_STORE, 'readwrite')
    await this.request(store.delete(`${platform}_${id.trim()}`))
  }

  async cacheLyrics(id: string, platform: MusicPlatform, data: unknown): Promise<void> {
    await this.cacheData(LYRICS_STORE, id, platform, data, MAX_LYRICS(), MAX_LYRICS_BYTES(), LYRICS_TTL)
  }

  async getCachedLyrics<T = unknown>(id: string, platform: MusicPlatform): Promise<T | null> {
    return this.getData<T>(LYRICS_STORE, id, platform, LYRICS_TTL)
  }

  private async cacheData(storeName: string, id: string, platform: MusicPlatform, data: unknown, maxCount: number, maxBytes: number, ttl: number): Promise<void> {
    id = id.trim()
    if (!id) throw new Error('缓存 ID 不能为空')
    const size = serializedSize(data)
    if (size > Math.min(maxBytes, 10 * 1024 * 1024)) return
    await this.enforceLimit(storeName, maxCount - 1, maxBytes - size, ttl)
    const now = Date.now()
    const item: DataCacheItem = { id: `${platform}_${id}`, platform, data, timestamp: now, lastAccess: now, size }
    const store = await this.store(storeName, 'readwrite')
    await this.request(store.put(item))
    // 新记录已带最新 lastAccess，丢弃该 key 的 pending，避免 flush 再做一次等值写入
    this.dropPendingAccess(storeName, item.id)
  }

  private async getData<T>(storeName: string, id: string, platform: MusicPlatform, ttl: number): Promise<T | null> {
    id = id.trim()
    if (!id) return null
    // 纯读取用 readonly 事务，避免与写入争用同一 store
    const store = await this.store(storeName, 'readonly')
    const key = `${platform}_${id}`
    const item = await this.request(store.get(key)) as DataCacheItem | undefined
    if (!item) return null
    if (Date.now() - Math.max(item.timestamp, item.lastAccess || 0) > ttl) {
      const deleteStore = await this.store(storeName, 'readwrite')
      await this.request(deleteStore.delete(key))
      return null
    }
    // 更新访问统计（LRU）：只累计到内存 pending，不再每次命中都重写整条记录
    this.trackAccess(storeName, key)
    return item.data as T
  }

  /**
   * 累计一次命中的访问统计（仅内存，不落盘）
   */
  private trackAccess(storeName: string, key: IDBValidKey): void {
    const pendingKey = this.pendingAccessKey(storeName, key)
    const pending = this.pendingAccess.get(pendingKey)
    // 重新插入以维持 Map 的「最久未命中在前」顺序，超限时优先丢弃最冷的一条
    if (pending) this.pendingAccess.delete(pendingKey)
    this.pendingAccess.set(pendingKey, {
      storeName,
      key,
      increments: (pending?.increments || 0) + 1,
      lastAccess: Date.now(),
    })
    if (this.pendingAccess.size > this.MAX_PENDING_ACCESS) {
      const coldest = this.pendingAccess.keys().next().value
      if (typeof coldest === 'string') this.pendingAccess.delete(coldest)
    }
    this.scheduleAccessFlush()
  }

  private pendingAccessKey(storeName: string, key: IDBValidKey): string {
    return `${storeName}\u0000${String(key)}`
  }

  /**
   * 启动统计落盘：pending 非空时才持有定时器，排空后立即清除，避免单例常驻定时器；
   * 隐藏/卸载监听只绑一次（定时器会反复建立，若跟着重绑会不断累积监听器）。
   * 页面隐藏/卸载时也会立即 flush——Electron 窗口不会正常卸载，故 pagehide 只是额外保险，
   * 定时 flush 必须能独立工作（页面隐藏被节流时最差约一个周期一次）。
   */
  private scheduleAccessFlush(): void {
    if (!this.accessFlushBound && typeof window !== 'undefined' && typeof document !== 'undefined') {
      this.accessFlushBound = true
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flushAccessStats()
      })
      window.addEventListener('pagehide', () => { void this.flushAccessStats() })
    }
    if (this.accessFlushTimer !== null) return
    if (typeof window === 'undefined') return
    this.accessFlushTimer = window.setInterval(() => { void this.flushAccessStats() }, this.ACCESS_FLUSH_INTERVAL)
  }

  private clearAccessFlushTimer(): void {
    if (this.accessFlushTimer === null) return
    window.clearInterval(this.accessFlushTimer)
    this.accessFlushTimer = null
  }

  /**
   * 把 pending 的访问统计合并写回 IndexedDB。
   * 记录已被清理（LRU/过期/清空）时跳过，不回补已删除的数据；
   * 单条写回失败（事务被关闭、配额不足等）同样忽略——统计只影响 LRU 排序。
   * 上一轮尚未结束时直接返回，本轮新增的增量留待下个周期。
   */
  private async flushAccessStats(): Promise<void> {
    if (this.accessFlushRunning) return
    if (this.pendingAccess.size === 0) {
      this.clearAccessFlushTimer()
      return
    }
    this.accessFlushRunning = true
    const entries = [...this.pendingAccess.values()]
    this.pendingAccess.clear()
    try {
      for (const entry of entries) {
        try {
          const store = await this.store(entry.storeName, 'readwrite')
          const item = await this.request(store.get(entry.key)) as CoverCacheItem | DataCacheItem | undefined
          if (!item) continue
          item.lastAccess = Math.max(Number(item.lastAccess) || 0, entry.lastAccess)
          // 封面记录带 accessCount；歌单/歌词记录没有该字段，沿用原语义只更新 lastAccess
          if ('accessCount' in item) item.accessCount = (Number(item.accessCount) || 0) + entry.increments
          await this.request(store.put(item))
        } catch {
          // 忽略单条失败
        }
      }
    } finally {
      this.accessFlushRunning = false
    }
    // 本轮 flush 期间产生的新增量留待下个周期；pending 已空则立即释放定时器
    if (this.pendingAccess.size === 0) this.clearAccessFlushTimer()
  }

  /**
   * 丢弃 pending 统计：记录被清空或被新写入覆盖时，旧增量不再有意义
   */
  private dropPendingAccess(storeName?: string, key?: IDBValidKey): void {
    if (storeName === undefined) {
      this.pendingAccess.clear()
    } else if (key === undefined) {
      const prefix = `${storeName}\u0000`
      for (const pendingKey of [...this.pendingAccess.keys()]) {
        if (pendingKey.startsWith(prefix)) this.pendingAccess.delete(pendingKey)
      }
    } else {
      this.pendingAccess.delete(this.pendingAccessKey(storeName, key))
    }
    if (this.pendingAccess.size === 0) this.clearAccessFlushTimer()
  }

  private async readItems(storeName: string): Promise<Array<{ key: IDBValidKey; timestamp: number; lastAccess: number; size: number }>> {
    const store = await this.store(storeName, 'readonly')
    return new Promise((resolve, reject) => {
      const items: Array<{ key: IDBValidKey; timestamp: number; lastAccess: number; size: number }> = []
      const cursor = store.openCursor()
      cursor.onerror = () => reject(cursor.error)
      cursor.onsuccess = () => {
        const current = cursor.result
        if (!current) { resolve(items); return }
        const value = current.value
        items.push({ key: current.primaryKey, timestamp: Number(value.timestamp) || 0, lastAccess: Number(value.lastAccess) || Number(value.timestamp) || 0, size: Number(value.size) || serializedSize(value.data) })
        current.continue()
      }
    })
  }

  /**
   * 修剪过期与超限记录。取舍：访问统计按 flush 周期（30 秒）批量写回，
   * 故此处读到的 lastAccess 最多滞后一个周期——只影响淘汰顺序的精度；
   * 仍在 pending 中的记录（刚被读取）一律不淘汰，避免统计滞后把热点误判为冷门。
   */
  private async enforceLimit(storeName: string, maxCount: number, maxBytes: number, ttl: number, force = false): Promise<void> {
    const now = Date.now()
    const lastRun = this.lastEnforceLimitAt[storeName] || 0
    // 节流窗口内：先用 O(1) 的 count() 快速判断。数量未超限则不执行全量扫描，
    // 避免每次 set 都遍历整个 store（游标 + JSON 反序列化 + 排序）。
    if (!force && now - lastRun < this.ENFORCE_LIMIT_INTERVAL) {
      const countStore = await this.store(storeName, 'readonly')
      const count = await this.request(countStore.count())
      if (count <= maxCount) return
    }
    this.lastEnforceLimitAt[storeName] = now
    const items = await this.readItems(storeName)
    // 刚被读取（统计仍在 pending）的记录不参与淘汰：其 lastAccess 尚未写回，
    // 按持久值判定会把「刚读过」误判成「已过期/最冷」而删掉
    const isPending = (key: IDBValidKey) => this.pendingAccess.has(this.pendingAccessKey(storeName, key))
    const remove = new Set<IDBValidKey>(items.filter(item => !isPending(item.key) && now - Math.max(item.timestamp, item.lastAccess) > ttl).map(item => item.key))
    let remaining = items.filter(item => !remove.has(item.key)).sort((a, b) => a.lastAccess - b.lastAccess)
    let bytes = remaining.reduce((sum, item) => sum + item.size, 0)
    while (remaining.length > maxCount || bytes > maxBytes) {
      const item = remaining.shift()
      if (!item) break
      if (isPending(item.key)) continue
      remove.add(item.key)
      bytes -= item.size
    }
    if (remove.size) {
      const store = await this.store(storeName, 'readwrite')
      await Promise.all([...remove].map(key => this.request(store.delete(key))))
    }
  }

  async cleanupExpired(): Promise<void> {
    await this.enforceLimit(COVER_STORE, MAX_COVERS(), MAX_COVER_BYTES(), COVER_TTL, true)
    await this.enforceLimit(PLAYLIST_STORE, MAX_PLAYLISTS(), MAX_PLAYLIST_BYTES(), PLAYLIST_TTL, true)
    await this.enforceLimit(LYRICS_STORE, MAX_LYRICS(), MAX_LYRICS_BYTES(), LYRICS_TTL, true)
  }

  async getCacheStats(): Promise<IndexedDBCacheStats> {
    await this.cleanupExpired()
    const [covers, playlists, lyrics] = await Promise.all([this.readItems(COVER_STORE), this.readItems(PLAYLIST_STORE), this.readItems(LYRICS_STORE)])
    const sum = (items: Array<{ size: number }>) => items.reduce((total, item) => total + item.size, 0)
    return { coverCount: covers.length, coverSize: sum(covers), playlistCount: playlists.length, playlistSize: sum(playlists), lyricsCount: lyrics.length, lyricsSize: sum(lyrics) }
  }

  private async clearStore(name: string): Promise<void> {
    const store = await this.store(name, 'readwrite')
    await this.request(store.clear())
    // 记录已清空，对应 pending 统计不再有意义
    this.dropPendingAccess(name)
  }

  clearCovers(): Promise<void> { return this.clearStore(COVER_STORE) }
  clearPlaylists(): Promise<void> { return this.clearStore(PLAYLIST_STORE) }
  clearLyrics(): Promise<void> { return this.clearStore(LYRICS_STORE) }
  async clearAll(): Promise<void> { await Promise.all([this.clearCovers(), this.clearPlaylists(), this.clearLyrics()]) }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.initPromise = null
  }
}

export const indexedDBCache = new IndexedDBCache()
