/**
 * CloudPlaylistSyncService —— 云歌单同步（后端补充规划 #33）。
 *
 * - 定期/手动拉取用户云歌单列表 + 每歌单曲目 id，落本地缓存表
 *   （cloud_playlists / cloud_playlist_tracks）；
 * - 合并策略：远程为权威——新增/更新本地缺失项，远端已删除的歌单本地清除；
 * - 任务模型：netease-sync 种类（补上空壳种类），状态中心可见进度；
 * - 未登录时 syncAll 直接跳过（不注册任务）。
 */
import type { NeteaseService } from '../domains/netease/NeteaseService';
import type { SessionService } from '../domains/netease/SessionService';
import type { SqlDatabase } from '../infra/tauriSql';
import type { TaskCenter } from './TaskCenter';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export const CLOUD_SYNC_TASK_ID = 'netease-sync:cloud-playlists';
export const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export interface CloudPlaylist {
  id: string;
  name: string;
  trackCount: number;
  coverUrl: string | null;
  creator: string | null;
  syncedAt: number;
}

export interface CloudPlaylistSyncDeps {
  netease: NeteaseService;
  session: SessionService;
  sql: SqlDatabase;
  taskCenter: TaskCenter;
  logger?: Logger;
}

interface RemotePlaylist {
  id?: number | string;
  name?: string;
  trackCount?: number;
  coverImgUrl?: string;
  creator?: { nickname?: string };
}

export class CloudPlaylistSyncService {
  private readonly deps: CloudPlaylistSyncDeps;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CloudPlaylistSyncDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  async init(): Promise<void> {
    await this.deps.sql.execute(
      `CREATE TABLE IF NOT EXISTS cloud_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        track_count INTEGER NOT NULL DEFAULT 0,
        cover_url TEXT,
        creator TEXT,
        synced_at INTEGER NOT NULL
      )`,
    );
    await this.deps.sql.execute(
      `CREATE TABLE IF NOT EXISTS cloud_playlist_tracks (
        playlist_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id)
      )`,
    );
  }

  /** 全量同步（远程为权威）；未登录直接跳过。返回统计。 */
  async syncAll(): Promise<{ playlists: number; tracks: number }> {
    if (!this.deps.session.isLoggedIn) {
      this.logger.debug('cloud-sync: 未登录，跳过');
      return { playlists: 0, tracks: 0 };
    }
    const taskCenter = this.deps.taskCenter;
    taskCenter.register({ id: CLOUD_SYNC_TASK_ID, kind: 'netease-sync', title: '云歌单同步', actions: ['view'] });
    taskCenter.update(CLOUD_SYNC_TASK_ID, { detail: '正在拉取歌单列表…' });
    try {
      const uid = this.deps.session.getCookie()?.userId;
      const answer = (await this.deps.netease.route('/netease/user/playlist', {
        uid: Number(uid),
        limit: 100,
        offset: 0,
      })) as { body?: { playlist?: RemotePlaylist[] } };
      const remote = answer.body?.playlist ?? [];
      const remoteIds = new Set(remote.map((playlist) => String(playlist.id)).filter(Boolean));
      await this.removeAbsent(remoteIds);

      let playlists = 0;
      let tracks = 0;
      for (const playlist of remote) {
        const id = String(playlist.id);
        if (!id) continue;
        taskCenter.update(CLOUD_SYNC_TASK_ID, { detail: `同步歌单 ${playlist.name ?? id}…` });
        const trackIds = await this.fetchTrackIds(id);
        await this.upsertPlaylist(id, playlist, trackIds);
        playlists += 1;
        tracks += trackIds.length;
      }
      taskCenter.complete(CLOUD_SYNC_TASK_ID, 'done', `同步 ${playlists} 个歌单，${tracks} 首`);
      this.logger.info(`cloud-sync: 完成 ${playlists} 个歌单 ${tracks} 首`);
      return { playlists, tracks };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      taskCenter.complete(CLOUD_SYNC_TASK_ID, 'failed', `云歌单同步失败：${message}`);
      this.logger.warn(`cloud-sync: 失败 ${message}`, error);
      throw error;
    }
  }

  /** 本地缓存的云歌单列表（UI 消费）。 */
  async listCached(): Promise<CloudPlaylist[]> {
    interface Row {
      id: string;
      name: string;
      track_count: number;
      cover_url: string | null;
      creator: string | null;
      synced_at: number;
    }
    const rows = await this.deps.sql.select<Row>(
      'SELECT id, name, track_count, cover_url, creator, synced_at FROM cloud_playlists ORDER BY synced_at DESC',
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      trackCount: row.track_count,
      coverUrl: row.cover_url,
      creator: row.creator,
      syncedAt: row.synced_at,
    }));
  }

  /** 歌单内缓存的曲目 id（按位置排序；UI 拉详情后组装）。 */
  async getCachedTrackIds(playlistId: string): Promise<string[]> {
    const rows = await this.deps.sql.select<{ track_id: string }>(
      'SELECT track_id FROM cloud_playlist_tracks WHERE playlist_id = ? ORDER BY position ASC',
      [playlistId],
    );
    return rows.map((row) => row.track_id);
  }

  /** 定期自动同步（登录态由 syncAll 自检）；返回停止函数。 */
  startAutoSync(intervalMs: number = AUTO_SYNC_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.syncAll().catch(() => {});
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async fetchTrackIds(playlistId: string): Promise<string[]> {
    const answer = (await this.deps.netease.route('/netease/playlist/detail', {
      id: Number(playlistId),
    })) as { body?: { playlist?: { trackIds?: Array<{ id?: number | string }> } } };
    const trackIds = answer.body?.playlist?.trackIds ?? [];
    return trackIds.map((track) => String(track.id)).filter(Boolean);
  }

  private async upsertPlaylist(id: string, playlist: RemotePlaylist, trackIds: string[]): Promise<void> {
    const syncedAt = Date.now();
    await this.deps.sql.execute('DELETE FROM cloud_playlists WHERE id = ?', [id]);
    await this.deps.sql.execute('DELETE FROM cloud_playlist_tracks WHERE playlist_id = ?', [id]);
    await this.deps.sql.execute(
      'INSERT INTO cloud_playlists (id, name, track_count, cover_url, creator, synced_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, playlist.name ?? id, trackIds.length, playlist.coverImgUrl ?? null, playlist.creator?.nickname ?? null, syncedAt],
    );
    for (let position = 0; position < trackIds.length; position += 1) {
      await this.deps.sql.execute(
        'INSERT INTO cloud_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)',
        [id, trackIds[position], position],
      );
    }
  }

  private async removeAbsent(remoteIds: Set<string>): Promise<void> {
    const local = await this.deps.sql.select<{ id: string }>('SELECT id FROM cloud_playlists');
    for (const row of local) {
      if (remoteIds.has(row.id)) continue;
      await this.deps.sql.execute('DELETE FROM cloud_playlists WHERE id = ?', [row.id]);
      await this.deps.sql.execute('DELETE FROM cloud_playlist_tracks WHERE playlist_id = ?', [row.id]);
      this.logger.info(`cloud-sync: 远端已删除，本地清除 ${row.id}`);
    }
  }
}
