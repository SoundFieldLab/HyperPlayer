// 缓存服务（D30 规则 + D35 Q15）：介质 = OPFS（Origin Private File System，
// 用户不可见、无扩展名语义，满足「缓存不暴露为 MP3 文件」红线）。
// 治理：默认容量 10 GiB（可配置 2–100 GiB），到上限清理至 90%，保护最近 100 个
// 不同远程曲目；VIP 门禁（D23）由 neteaseService 播放准入层执行（fail closed）。
// 记账：navigator.storage.estimate() + 本地元数据双轨。

import type { BackendCacheStatusDto, BackendTrackRefDto, CacheStatsDto } from '../../bridge/contracts'

const CACHE_DIR = 'hyperplayer-cache'
const METADATA_FILE = 'meta.json'
const MAX_METADATA_ENTRIES = 512

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
  private initialized = false

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return
      const root = await navigator.storage.getDirectory()
      this.root = await root.getDirectoryHandle(CACHE_DIR, { create: true })
      await this.loadMetadata()
    } catch {
      // OPFS 不可用：缓存降级为 no-op（播放不受影响）
      this.root = null
    }
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
    if (!this.root) return
    try {
      const file = await this.root.getFileHandle(METADATA_FILE, { create: true })
      const writable = await file.createWritable()
      await writable.write(JSON.stringify(this.metadata))
      await writable.close()
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

    const response = await fetch(result.url)
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

  /** D30 可配置容量：读取 settings（2–100 GiB），默认 10 GiB */
  private async capacityBytes(): Promise<number> {
    try {
      const settings = await (await import('../../bridge')).bridge.getSettings()
      const bytes = settings.cacheCapacityBytes
      if (bytes >= 2 * 1024 * 1024 * 1024 && bytes <= 100 * 1024 * 1024 * 1024) return bytes
    } catch {
      // 设置不可用时回落默认
    }
    return 10 * 1024 * 1024 * 1024
  }

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

  /** D30：容量到上限清理至 90%，保护最近 100 个不同远程曲目 */
  private async trimIfNeeded(): Promise<void> {
    if (!this.root) return
    const capacityBytes = await this.capacityBytes()
    const entries = Object.values(this.metadata.entries)
    const used = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    if (used <= capacityBytes) return

    const protectedIds = new Set(
      [...entries]
        .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs)
        .slice(0, 100)
        .map((entry) => entry.trackId),
    )
    const candidates = entries
      .filter((entry) => !protectedIds.has(entry.trackId))
      .sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs)
    const target = Math.floor(capacityBytes * 0.9)
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
