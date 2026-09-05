/**
 * ScanMachine —— 本地曲库扫描状态机（播放器架构.md §3.4）。
 *
 * 状态链：idle → scanning(文件夹队列+进度) → summarizing → done | paused | cancelled。
 *  - 增量：mtime 未变跳过；Worker 内执行遍历 + music-metadata 解析；
 *  - 每文件夹原子提交（SQLite 事务）：中断时已提交保留，可恢复续扫；
 *  - 状态上报侧栏状态中心（UI-D29 语义：任务 ID/进度/暂停/取消）。
 */
import type { TauriFs } from '../../infra/tauriFs';
import type { SqlDatabase } from '../../infra/tauriSql';
import type { TaskCenter, CenterTaskState } from '../../services/TaskCenter';
import { albumKeyFor } from '../../services/CoverService';
import type { Logger } from '../../shared/logger';
import { createNullLogger } from '../../shared/logger';

export type ScanPhase = 'idle' | 'scanning' | 'summarizing' | 'done' | 'paused' | 'cancelled';

export interface ScanState {
  phase: ScanPhase;
  /** 待扫文件夹队列（续扫时保留剩余）。 */
  folders: string[];
  currentFolder: string | null;
  processedFolders: number;
  totalFolders: number;
  filesScanned: number;
  added: number;
  updated: number;
  failed: number;
}

export interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  duration?: number;
  format?: string;
  bitrate?: number;
  /** 内嵌封面原始字节（后端补充规划 #23，worker 提取）。 */
  cover?: Uint8Array;
  coverFormat?: string;
}

export type MetadataParser = (path: string, bytes: Uint8Array) => Promise<TrackMetadata | null>;

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma']);

export interface ScanMachineDeps {
  fs: TauriFs;
  sql: SqlDatabase;
  /** 元数据解析（真实路径：Web Worker 内 music-metadata；测试注入 fake）。 */
  parseMetadata: MetadataParser;
  onStateChange?: (state: ScanState) => void;
  /** UI-D29 状态中心统一任务模型。 */
  taskCenter?: TaskCenter;
  /** 封面落盘钩子（后端补充规划 #23：专辑键去重，CoverService 实现）。 */
  saveCover?: (picture: Uint8Array, albumKey: string, mime: string) => Promise<void>;
  logger?: Logger;
}

export class ScanMachine {
  private state: ScanState = { phase: 'idle', folders: [], currentFolder: null, processedFolders: 0, totalFolders: 0, filesScanned: 0, added: 0, updated: 0, failed: 0 };
  private readonly deps: ScanMachineDeps;
  private readonly logger: Logger;
  private cancelled = false;

  constructor(deps: ScanMachineDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  get snapshot(): ScanState {
    return this.state;
  }

  /** 启动/续扫：传入待扫文件夹（paused/cancelled 后传入剩余队列即可续扫）。 */
  async scan(folders: string[]): Promise<void> {
    await this.ensureSchema();
    this.cancelled = false;
    this.state = {
      ...this.state,
      phase: 'scanning',
      folders: folders.length > 0 ? folders : this.state.folders,
      totalFolders: folders.length > 0 ? folders.length : this.state.totalFolders,
      processedFolders: folders.length > 0 ? 0 : this.state.processedFolders,
      currentFolder: null,
    };
    this.emit();

    const queue = [...this.state.folders];
    while (queue.length > 0) {
      if (this.cancelled) {
        this.state = { ...this.state, phase: 'cancelled', folders: queue, currentFolder: null };
        this.emit();
        return;
      }
      if (this.state.phase === 'paused') {
        this.state = { ...this.state, folders: queue };
        this.emit();
        return;
      }
      const folder = queue.shift();
      if (!folder) break;
      this.state = { ...this.state, currentFolder: folder, processedFolders: this.state.processedFolders + 1 };
      this.emit();
      let interrupted = false;
      try {
        interrupted = await this.scanFolder(folder);
      } catch (error) {
        this.logger.error(`library: scan folder failed ${folder}`, error);
        this.state = { ...this.state, failed: this.state.failed + 1 };
      }
      // 被中断（取消/暂停）的文件夹回队首：已提交保留、未提交可续扫
      if (interrupted) queue.unshift(folder);
    }

    this.state = { ...this.state, phase: 'summarizing', currentFolder: null };
    this.emit();
    this.state = { ...this.state, phase: 'done', folders: [] };
    this.emit();
  }

  pause(): void {
    if (this.state.phase === 'scanning') {
      this.state = { ...this.state, phase: 'paused' };
      this.emit();
    }
  }

  resume(): void {
    if (this.state.phase === 'paused') {
      this.state = { ...this.state, phase: 'scanning' };
      this.emit();
    }
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** 扫描单个文件夹；返回 true = 被取消/暂停中断（未完成提交，回队首续扫）。 */
  private async scanFolder(folder: string): Promise<boolean> {
    const files = await this.collectAudioFiles(folder);
    const changes: Array<{ track: TrackRecord; mode: 'insert' | 'update' }> = [];
    for (const file of files) {
      if (this.cancelled || this.state.phase === 'paused') return true;
      const existing = await this.deps.sql.select<TrackRecord>('SELECT * FROM tracks WHERE path = ?', [file.path]);
      const stat = await this.deps.fs.stat(file.path);
      const mtimeMs = stat?.modifiedMs ?? 0;
      // 增量：mtime 未变跳过
      if (existing[0] && existing[0].mtime_ms === mtimeMs) {
        continue;
      }
      this.state = { ...this.state, filesScanned: this.state.filesScanned + 1 };
      try {
        const bytes = await this.deps.fs.readFile(file.path);
        const metadata = await this.deps.parseMetadata(file.path, bytes);
        if (this.cancelled || this.state.phase === 'paused') return true; // 解析期间被中断
        const record: TrackRecord = {
          id: hashPath(file.path),
          path: file.path,
          folder,
          title: metadata?.title ?? file.name.replace(/\.[^.]+$/u, ''),
          artist: metadata?.artist ?? '未知艺术家',
          album: metadata?.album ?? '未知专辑',
          album_artist: metadata?.albumArtist ?? null,
          duration: metadata?.duration ?? null,
          format: file.format,
          bitrate: metadata?.bitrate ?? null,
          size: bytes.length,
          mtime_ms: mtimeMs,
          added_at: Date.now(),
        };
        changes.push({ track: record, mode: existing[0] ? 'update' : 'insert' });
        // 内嵌封面落盘（专辑键去重；失败不阻塞扫描）
        if (metadata?.cover && this.deps.saveCover) {
          const albumKey = albumKeyFor(record.album, record.album_artist);
          if (albumKey) {
            try {
              await this.deps.saveCover(metadata.cover, albumKey, metadata.coverFormat ?? 'image/jpeg');
            } catch (error) {
              this.logger.warn(`library: 封面落盘失败 ${file.path}`, error);
            }
          }
        }
      } catch (error) {
        this.logger.warn(`library: parse failed ${file.path}`, error);
        this.state = { ...this.state, failed: this.state.failed + 1 };
      }
    }
    if (this.cancelled || this.state.phase === 'paused') return true;
    // 每文件夹原子提交（SQLite 事务；fake-sql 内存操作天然原子）
    if (changes.length > 0) {
      await this.deps.sql.execute('BEGIN TRANSACTION');
      try {
        for (const change of changes) {
          await this.upsertTrack(change.track);
        }
        await this.deps.sql.execute('COMMIT');
      } catch (error) {
        await this.deps.sql.execute('ROLLBACK');
        throw error;
      }
    }
    const added = changes.filter((c) => c.mode === 'insert').length;
    const updated = changes.filter((c) => c.mode === 'update').length;
    this.state = { ...this.state, added: this.state.added + added, updated: this.state.updated + updated };
    this.emit();
    return false;
  }

  private async upsertTrack(track: TrackRecord): Promise<void> {
    await this.deps.sql.execute('DELETE FROM tracks WHERE id = ?', [track.id]);
    await this.deps.sql.execute(
      `INSERT INTO tracks (id, path, folder, title, artist, album, album_artist, duration, format, bitrate, size, mtime_ms, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        track.id,
        track.path,
        track.folder,
        track.title,
        track.artist,
        track.album,
        track.album_artist,
        track.duration,
        track.format,
        track.bitrate,
        track.size,
        track.mtime_ms,
        track.added_at,
      ],
    );
  }

  private async collectAudioFiles(folder: string): Promise<Array<{ path: string; name: string; format: string }>> {
    const result: Array<{ path: string; name: string; format: string }> = [];
    const entries = await this.deps.fs.readDir(folder);
    for (const entry of entries) {
      if (this.cancelled || this.state.phase === 'paused') return result;
      const fullPath = `${folder}/${entry.name}`;
      if (entry.isDirectory) {
        const nested = await this.collectAudioFiles(fullPath);
        result.push(...nested);
      } else {
        const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        if (AUDIO_EXTENSIONS.has(extension)) {
          result.push({ path: fullPath, name: entry.name, format: extension.slice(1) });
        }
      }
    }
    return result;
  }

  private async ensureSchema(): Promise<void> {
    await this.deps.sql.execute(`
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        folder TEXT NOT NULL,
        title TEXT,
        artist TEXT,
        album TEXT,
        album_artist TEXT,
        duration REAL,
        format TEXT,
        bitrate INTEGER,
        size INTEGER,
        mtime_ms INTEGER,
        added_at INTEGER
      )
    `);
    try {
      await this.deps.sql.execute('PRAGMA journal_mode = WAL');
    } catch {
      // fake-sql 不支持 PRAGMA：忽略
    }
  }

  private emit(): void {
    this.deps.onStateChange?.({ ...this.state });
    this.reportTask();
  }

  /** UI-D29：扫描任务上报状态中心（与来源页同 ID 'scan:library'）。 */
  private reportTask(): void {
    const tc = this.deps.taskCenter;
    if (!tc) return;
    const state = this.state;
    const id = 'scan:library';
    const progress = state.totalFolders > 0 ? state.processedFolders / state.totalFolders : 0;
    const detail = `${state.processedFolders}/${state.totalFolders} 文件夹 · ${state.filesScanned} 文件`;
    if (state.phase === 'done' || state.phase === 'cancelled') {
      tc.complete(id, state.phase, detail);
      return;
    }
    if (state.phase === 'idle') return;
    const phaseState: Record<ScanPhase, CenterTaskState> = {
      idle: 'running',
      scanning: 'running',
      summarizing: 'running',
      done: 'done',
      paused: 'paused',
      cancelled: 'cancelled',
    };
    const existing = tc.getTask(id);
    if (existing) {
      tc.update(id, { state: phaseState[state.phase], progress, detail });
    } else {
      tc.register({
        id,
        kind: 'scan',
        title: '本地曲库扫描',
        actions: state.phase === 'paused' ? ['view'] : ['pause', 'cancel', 'view'],
      });
    }
  }
}

export interface TrackRecord {
  id: string;
  path: string;
  folder: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string | null;
  duration: number | null;
  format: string | null;
  bitrate: number | null;
  size: number;
  mtime_ms: number;
  added_at: number;
}

/** 路径 → 稳定 id（十六进制 hash）。 */
export function hashPath(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i += 1) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `p${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
