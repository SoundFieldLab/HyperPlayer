/**
 * StreamCacheService —— 音频流落盘缓存（播放器架构.md §3.5 / 架构基线.md §8）。
 *
 * 单曲任务机：queued → fetching(进度) → verifying(权益) → ready | locked | failed(重试3)。
 * 缓存语义：
 *  - 公共播放缓存：不绑定账号，容量上限 + 最近播放淘汰；
 *  - 账号权益缓存：绑定 ownerUserId，每次播放前重验证；失败 → locked（文件保留、
 *    不可播放、优先淘汰——CONTEXT 锁定缓存语义）；
 *  - plugin-http 流式拉 + plugin-fs 分块写 + SQLite cache 表（WAL，schema 见 init）。
 */
import type { QueueItem } from '../domains/player/types';
import type { TauriHttp } from '../infra/tauriHttp';
import type { TauriFs } from '../infra/tauriFs';
import type { SqlDatabase } from '../infra/tauriSql';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export type CacheTaskState = 'queued' | 'fetching' | 'verifying' | 'ready' | 'locked' | 'failed';

export const CACHE_RETRY_LIMIT = 3;
export const DEFAULT_CACHE_CAPACITY_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB（架构基线.md §8，设置可调）

export interface CacheTask {
  trackId: string;
  state: CacheTaskState;
  progress: number;
  bytesWritten: number;
  retries: number;
  kind: 'public' | 'entitlement';
  ownerUserId: string | null;
  error?: string;
}

export interface CachedFile {
  filePath: string;
  kind: 'public' | 'entitlement';
  ownerUserId: string | null;
}

interface CacheRow {
  track_id: string;
  file_path: string;
  bytes: number;
  kind: 'public' | 'entitlement';
  owner_user_id: string | null;
  status: 'ready' | 'locked' | 'fetching' | 'failed';
  last_played_at: number;
  created_at: number;
}

const CHUNK_SIZE = 256 * 1024;
void CHUNK_SIZE; // 分块由 http reader 驱动；保留常量供后续流控

export interface StreamCacheServiceDeps {
  http: TauriHttp;
  fs: TauriFs;
  sql: SqlDatabase;
  cacheDir: string;
  /** 容量预算（字节）；缺省 5 GB。 */
  capacityBytes?: number;
  /** 权益重验证（P4 接 SessionService：账号/权益/权限）。 */
  verifyEntitlement?: (trackId: string, ownerUserId: string) => Promise<boolean>;
  onTaskChange?: (task: CacheTask) => void;
  now?: () => number;
  logger?: Logger;
}

export class StreamCacheService {
  private readonly deps: StreamCacheServiceDeps;
  private readonly logger: Logger;
  private readonly tasks = new Map<string, CacheTask>();
  private initialized = false;

  constructor(deps: StreamCacheServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  /** 建表（幂等）：cache 索引 + 默认 WAL。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.deps.sql.execute(`
      CREATE TABLE IF NOT EXISTS cache (
        track_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'public',
        owner_user_id TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        last_played_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    try {
      await this.deps.sql.execute('PRAGMA journal_mode = WAL');
    } catch {
      // fake-sql 不支持 PRAGMA：忽略
    }
    this.initialized = true;
  }

  getTask(trackId: string): CacheTask | undefined {
    return this.tasks.get(trackId);
  }

  /**
   * 播放前读取：权益缓存先重验证（账号/权益/权限）；
   * 失败 → locked（文件保留、不可播放）；返回 null 表示不可播放。
   */
  async getPlayable(track: QueueItem): Promise<CachedFile | null> {
    await this.init();
    const rows = await this.deps.sql.select<CacheRow>('SELECT * FROM cache WHERE track_id = ?', [track.id]);
    const row = rows[0];
    if (!row || row.status === 'failed' || row.status === 'fetching') return null;
    if (row.status === 'locked') return null; // 锁定缓存不可播放

    if (row.kind === 'entitlement' && row.owner_user_id) {
      const verify = this.deps.verifyEntitlement;
      const valid = verify ? await verify(track.id, row.owner_user_id) : false;
      if (!valid) {
        await this.deps.sql.execute("UPDATE cache SET status = 'locked' WHERE track_id = ?", [track.id]);
        this.logger.info(`cache: ${track.id} entitlement re-verify failed -> locked`);
        return null;
      }
    }
    const now = this.deps.now?.() ?? Date.now();
    await this.deps.sql.execute('UPDATE cache SET last_played_at = ? WHERE track_id = ?', [now, track.id]);
    return { filePath: row.file_path, kind: row.kind, ownerUserId: row.owner_user_id };
  }

  /** 缓存任务机入口：幂等（ready 直接返回；进行中返回 null）。 */
  async ensureCached(
    track: QueueItem,
    url: string,
    opts: { ownerUserId?: string | null } = {},
  ): Promise<CachedFile | null> {
    await this.init();
    const existing = await this.getPlayable(track);
    if (existing) return existing;

    const task = this.tasks.get(track.id);
    if (task && (task.state === 'queued' || task.state === 'fetching' || task.state === 'verifying')) {
      return null; // 进行中
    }

    const kind = opts.ownerUserId ? 'entitlement' : 'public';
    const filePath = `${this.deps.cacheDir}/${encodeURIComponent(track.id)}.cache`;
    const newTask: CacheTask = {
      trackId: track.id,
      state: 'queued',
      progress: 0,
      bytesWritten: 0,
      retries: 0,
      kind,
      ownerUserId: opts.ownerUserId ?? null,
    };
    this.tasks.set(track.id, newTask);

    try {
      await this.fetchToFile(track, url, filePath, newTask);
      return { filePath, kind, ownerUserId: newTask.ownerUserId };
    } catch (error) {
      this.logger.error(`cache: fetch failed for ${track.id}`, error);
      return null;
    } finally {
      await this.evictToCapacity();
    }
  }

  private async fetchToFile(track: QueueItem, url: string, filePath: string, task: CacheTask): Promise<void> {
    for (let attempt = 1; attempt <= CACHE_RETRY_LIMIT; attempt += 1) {
      task.retries = attempt - 1;
      task.error = undefined;
      task.state = 'fetching';
      task.progress = 0;
      task.bytesWritten = 0;
      this.emit(task);
      try {
        await this.deps.fs.mkdir(this.deps.cacheDir, true);
        const response = await this.deps.http.fetch(url);
        if (response.status !== 200) {
          throw new Error(`cache: HTTP ${response.status} for ${track.id}`);
        }
        const reader = response.body.getReader();
        const contentLength = Number(response.headers['content-length'] ?? 0);
        let total = 0;
        let firstChunk = true;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            if (firstChunk) {
              await this.deps.fs.writeFile(filePath, value);
              firstChunk = false;
            } else {
              await this.deps.fs.appendFile(filePath, value);
            }
            total += value.length;
            task.bytesWritten = total;
            task.progress = contentLength > 0 ? Math.min(1, total / contentLength) : task.progress;
            this.emit(task);
          }
        }
        if (firstChunk) await this.deps.fs.writeFile(filePath, new Uint8Array(0));
        task.progress = 1;
        task.bytesWritten = total;
        this.emit(task);

        // 权益验证
        if (task.kind === 'entitlement' && task.ownerUserId) {
          task.state = 'verifying';
          this.emit(task);
          const verify = this.deps.verifyEntitlement;
          const valid = verify ? await verify(track.id, task.ownerUserId) : false;
          if (!valid) {
            task.state = 'locked';
            this.emit(task);
            await this.upsertRow(track, filePath, total, 'locked');
            return;
          }
        }
        task.state = 'ready';
        this.emit(task);
        await this.upsertRow(track, filePath, total, 'ready');
        return;
      } catch (error) {
        task.error = error instanceof Error ? error.message : String(error);
        if (attempt < CACHE_RETRY_LIMIT) {
          this.logger.warn(`cache: attempt ${attempt}/${CACHE_RETRY_LIMIT} failed for ${track.id}, retrying`);
          continue;
        }
        task.state = 'failed';
        this.emit(task);
        await this.upsertRow(track, filePath, task.bytesWritten, 'failed');
        throw error;
      }
    }
  }

  private async upsertRow(
    track: QueueItem,
    filePath: string,
    bytes: number,
    status: CacheRow['status'],
  ): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    await this.deps.sql.execute(
      'DELETE FROM cache WHERE track_id = ?',
      [track.id],
    );
    const row = this.tasks.get(track.id);
    await this.deps.sql.execute(
      `INSERT INTO cache (track_id, file_path, bytes, kind, owner_user_id, status, last_played_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        track.id,
        filePath,
        bytes,
        row?.kind ?? 'public',
        row?.ownerUserId ?? null,
        status,
        now,
        now,
      ],
    );
  }

  /** 容量 LRU 淘汰：locked 优先淘汰，然后最近播放最旧；逐条删除直到满足预算。 */
  async evictToCapacity(): Promise<void> {
    await this.init();
    const capacity = this.deps.capacityBytes ?? DEFAULT_CACHE_CAPACITY_BYTES;
    const rows = await this.deps.sql.select<CacheRow>(
      "SELECT * FROM cache WHERE status != 'fetching' AND status != 'failed'",
    );
    const total = rows.reduce((acc, row) => acc + row.bytes, 0);
    if (total <= capacity) return;
    // 排序：locked 优先，其次 last_played_at 升序
    const ordered = [...rows].sort((a, b) => {
      if (a.status === 'locked' && b.status !== 'locked') return -1;
      if (a.status !== 'locked' && b.status === 'locked') return 1;
      return a.last_played_at - b.last_played_at;
    });
    let remaining = total;
    for (const row of ordered) {
      if (remaining <= capacity) break;
      try {
        await this.deps.fs.removeFile(row.file_path);
      } catch {
        // 文件可能已被外部清理：忽略
      }
      await this.deps.sql.execute('DELETE FROM cache WHERE track_id = ?', [row.track_id]);
      remaining -= row.bytes;
      this.logger.debug(`cache: evicted ${row.track_id} (${row.bytes} bytes)`);
    }
  }

  /** 显式清理指定缓存（清空缓存动作，UI-D54 需确认）。 */
  async remove(trackId: string): Promise<void> {
    await this.init();
    const rows = await this.deps.sql.select<CacheRow>('SELECT * FROM cache WHERE track_id = ?', [trackId]);
    const row = rows[0];
    if (row) {
      try {
        await this.deps.fs.removeFile(row.file_path);
      } catch {
        // 忽略
      }
      await this.deps.sql.execute('DELETE FROM cache WHERE track_id = ?', [trackId]);
    }
    this.tasks.delete(trackId);
  }

  private emit(task: CacheTask): void {
    this.deps.onTaskChange?.({ ...task });
  }
}
