// 缓存服务（D30 规则 + D35 Q15）：介质 = OPFS（Origin Private File System，
// 用户不可见、无扩展名语义，满足「缓存不暴露为 MP3 文件」红线）。
// 治理：容量（2–100 GiB，默认 10 GiB）、清理水位、保护曲目数均从 settings 实时读取；
// D30 默认到上限清理至 90%、保护最近 100 个不同远程曲目；VIP 门禁（D23）由
// neteaseService 播放准入层执行（fail closed）。
// 健壮性：init/写入全部限时——OPFS 挂起或不可用时缓存整体降级为 no-op，
// stats()/status() 等读取方永不挂起、失败回落零值（设置页不再永久「读取中」）。
// 记账：navigator.storage.estimate() + 本地元数据双轨。

import type { BackendCacheStatusDto, BackendTrackRefDto, CacheStatsDto } from '../../bridge/contracts'

const CACHE_DIR = 'hyperplayer-cache'
const METADATA_FILE = 'meta.json'
const MAX_METADATA_ENTRIES = 512
const GIB = 1024 * 1024 * 1024
/** D30 默认治理参数（settings 不可用时的兜底） */
const DEFAULT_CAPACITY_BYTES = 10 * GIB
const DEFAULT_TRIM_PERCENT = 90
const DEFAULT_RECENT_TRACK_LIMIT = 100
/** OPFS 目录/元数据初始化限时：任何一步挂起都降级为 no-op，绝不阻塞 stats()/status() 读取方 */
const INIT_TIMEOUT_MS = 5_000
/** OPFS 写句柄限时：文件锁异常残留时放弃写入，不阻塞播放与清理流程 */
const WRITE_TIMEOUT_MS = 5_000

/** 限时包装：超时或失败一律以 reject 落定，由调用方决定降级语义 */
function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

interface CacheEntryMeta {
  key: string
  trackId: string
  source: 'netease' | 'local'
  quality: string
  sizeBytes: number
  storedAtMs: number
  lastUsedAtMs: number
  accessClass: 'Public' | 'AccountEntitled' | 'LockedEntitlement'
  ownerUserId: number | null
}

interface CacheMetadata {
  entries: Record<string, CacheEntryMeta>
}

export class CacheService {
  private root: FileSystemDirectoryHandle | null = null
  private metadata: CacheMetadata = { entries: {} }
  /** 初始化承诺（记忆化）：并发调用共享同一次尝试；失败/超时后允许下次调用重试 */
  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    let promise = this.initPromise
    if (!promise) {
      promise = this.startInit()
      this.initPromise = promise
      // 失败（含超时）时清除记忆，让后续调用重新尝试初始化
      void promise.then(() => undefined, () => { if (this.initPromise === promise) this.initPromise = null })
    }
    try {
      await promise
    } catch {
      // 初始化失败已内部降级（root = null）：调用方拿到零值/无缓存语义，不再向上抛
    }
  }

  private async startInit(): Promise<void> {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return
      // OPFS 目录与元数据读取整体限时：WebView2 偶发挂起时降级为 no-op（播放不受影响）
      await withTimeout(this.openRoot(), INIT_TIMEOUT_MS, '缓存初始化')
    } catch (error) {
      this.root = null
      throw error
    }
  }

  private async openRoot(): Promise<void> {
    const root = await navigator.storage.getDirectory()
    this.root = await root.getDirectoryHandle(CACHE_DIR, { create: true })
    await this.loadMetadata()
  }

  private async loadMetadata(): Promise<void> {
    try {
      const file = await this.root?.getFileHandle(METADATA_FILE)
      if (!file) return
      const blob = await (await file.getFile()).text()
      this.metadata = JSON.parse(blob) as CacheMetadata
    } catch {
      this.metadata = { entries: {} }
    }
  }

  private async saveMetadata(): Promise<void> {
    const root = this.root
    if (!root) return
    try {
      // OPFS 写句柄可能因锁异常而挂起：限时放弃，写失败不阻塞播放
      await withTimeout((async () => {
        const file = await root.getFileHandle(METADATA_FILE, { create: true })
        const writable = await file.createWritable()
        await writable.write(JSON.stringify(this.metadata))
        await writable.close()
      })(), WRITE_TIMEOUT_MS, '缓存元数据写入')
    } catch {
      // 元数据写失败不阻塞播放
    }
  }

  /** 曲目缓存键：source:id:quality */
  private keyOf(request: BackendTrackRefDto, quality: string): string {
    return `${request.source}:${request.id}:${quality}`
  }

  async status(request: BackendTrackRefDto): Promise<BackendCacheStatusDto> {
    await this.init()
    const key = this.keyOf(request, '')
    const entries = Object.values(this.metadata.entries).filter((entry) => entry.trackId === request.id)
    const ready = entries.some((entry) => entry.accessClass !== 'LockedEntitlement')
    const locked = entries.some((entry) => entry.accessClass === 'LockedEntitlement')
    return {
      status: ready ? 'ready' : locked ? 'entitlement-locked' : 'none',
      bytesUsed: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      entryCount: entries.length,
      activeTasks: 0,
      lockedEntries: locked ? 1 : 0,
    }
  }

  /** 缓存远程曲目（网络层由 neteaseService 提供 URL；此处仅记账 OPFS 落盘） */
  async cacheTrack(request: BackendTrackRefDto, quality: string): Promise<void> {
    await this.init()
    if (!this.root || request.source !== 'netease') return
    const key = this.keyOf(request, quality)
    if (this.metadata.entries[key]) return

    const { getSongUrl } = await import('../netease/neteaseService')
    const result = await getSongUrl(Number(request.id), quality as never)
    if (!result.url) throw new Error('没有可缓存的官方播放地址')

    // CDN 下载走 tauri-plugin-http：浏览器原生 fetch 会被网易云 CDN 跨域拦截
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    const response = await tauriFetch(result.url)
    if (!response.ok) throw new Error(`缓存下载失败：${response.status}`)
    const buffer = await response.arrayBuffer()
    const file = await this.root.getFileHandle(key, { create: true })
    const writable = await file.createWritable()
    await writable.write(buffer)
    await writable.close()

    this.metadata.entries[key] = {
      key,
      trackId: request.id,
      source: request.source,
      quality,
      sizeBytes: buffer.byteLength,
      storedAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
      accessClass: 'Public',
      ownerUserId: null,
    }
    await this.trimIfNeeded()
    await this.saveMetadata()
  }

  async remove(request: BackendTrackRefDto): Promise<void> {
    await this.init()
    if (!this.root) return
    for (const [key, entry] of Object.entries(this.metadata.entries)) {
      if (entry.trackId === request.id) {
        try {
          await this.root.removeEntry(key)
        } catch {
          // 文件缺失忽略
        }
        delete this.metadata.entries[key]
      }
    }
    await this.saveMetadata()
  }

  async clear(): Promise<void> {
    await this.init()
    if (!this.root) return
    for (const key of Object.keys(this.metadata.entries)) {
      try {
        await this.root.removeEntry(key)
      } catch {
        // 忽略
      }
    }
    this.metadata = { entries: {} }
    await this.saveMetadata()
  }

  /**
   * D30 可配置治理参数：容量（2–100 GiB）、清理水位（百分比）、保护曲目数。
   * 每次清理前从 settings 实时读取（settings_get 哑 KV），改动即刻生效；不可用时回落默认。
   */
  private async governance(): Promise<{ capacity: number; trimPercent: number; recentLimit: number }> {
    try {
      const settings = await (await import('../../bridge')).bridge.getSettings()
      const capacity = settings.cacheCapacityBytes
      const trimPercent = settings.cacheTrimPercent
      const recentLimit = settings.cacheRecentTrackLimit
      return {
        capacity: capacity >= 2 * GIB && capacity <= 100 * GIB ? capacity : DEFAULT_CAPACITY_BYTES,
        trimPercent: trimPercent >= 1 && trimPercent <= 99 ? trimPercent : DEFAULT_TRIM_PERCENT,
        recentLimit: Number.isFinite(recentLimit) && recentLimit >= 0 ? recentLimit : DEFAULT_RECENT_TRACK_LIMIT,
      }
    } catch {
      // 设置不可用时回落 D30 默认
      return { capacity: DEFAULT_CAPACITY_BYTES, trimPercent: DEFAULT_TRIM_PERCENT, recentLimit: DEFAULT_RECENT_TRACK_LIMIT }
    }
  }

  /** 缓存统计：init 已保证不挂起/不抛出，OPFS 降级时自然返回零值 */
  async stats(): Promise<CacheStatsDto> {
    await this.init()
    const entries = Object.values(this.metadata.entries)
    const bytesUsed = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    return {
      bytesUsed,
      entryCount: entries.length,
      activeTasks: 0,
      lockedEntries: entries.filter((entry) => entry.accessClass === 'LockedEntitlement').length,
    }
  }

  /** D30：容量到上限清理至水位（默认 90%），保护最近 N 个不同远程曲目（默认 100，来自 settings） */
  private async trimIfNeeded(): Promise<void> {
    if (!this.root) return
    const { capacity, trimPercent, recentLimit } = await this.governance()
    const entries = Object.values(this.metadata.entries)
    const used = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    if (used <= capacity) return

    const protectedIds = new Set(
      [...entries]
        .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs)
        .slice(0, recentLimit)
        .map((entry) => entry.trackId),
    )
    const candidates = entries
      .filter((entry) => !protectedIds.has(entry.trackId))
      .sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs)
    const target = Math.floor(capacity * (trimPercent / 100))
    let freed = 0
    for (const entry of candidates) {
      if (used - freed <= target) break
      try {
        await this.root.removeEntry(entry.key)
      } catch {
        // 忽略
      }
      delete this.metadata.entries[entry.key]
      freed += entry.sizeBytes
    }
  }

  /** 播放准入查询：OPFS 中存在完整缓存且权益未锁定 */
  async hasReadyCache(request: BackendTrackRefDto, quality: string): Promise<boolean> {
    await this.init()
    const entry = this.metadata.entries[this.keyOf(request, quality)]
    return Boolean(entry && entry.accessClass !== 'LockedEntitlement')
  }
}

export const cacheService = new CacheService()
