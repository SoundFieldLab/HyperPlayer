/**
 * AlbumCompletionService —— 专辑补全调度（播放器架构.md §3.5）。
 * 低优先级空闲任务：把专辑内未缓存的曲目逐曲拉直链 + 写缓存，
 * 置于缓存核心之后；新调度替换旧调度（取消过时补全）。
 */
import type { StreamCacheService } from './StreamCacheService';
import type { NeteaseService } from '../domains/netease/NeteaseService';
import type { SessionService } from '../domains/netease/SessionService';
import type { TaskCenter } from './TaskCenter';
import type { QueueItem } from '../domains/player/types';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

interface CompletionJob {
  albumId: string;
  trackIds: string[];
  token: number;
}

export interface AlbumCompletionServiceDeps {
  cache: StreamCacheService;
  netease: NeteaseService;
  session: SessionService;
  taskCenter?: TaskCenter;
  logger?: Logger;
}

export class AlbumCompletionService {
  private readonly deps: AlbumCompletionServiceDeps;
  private readonly logger: Logger;
  private queue: CompletionJob[] = [];
  private running = false;
  private currentToken = 0;

  constructor(deps: AlbumCompletionServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  /** 调度专辑补全（新调度替换旧调度：只补最近需求的专辑）。 */
  schedule(albumId: string, trackIds: string[]): void {
    this.currentToken += 1;
    this.queue = [{ albumId, trackIds: [...trackIds], token: this.currentToken }];
    this.deps.taskCenter?.register({
      id: `album:${albumId}`,
      kind: 'album-completion',
      title: `专辑补全 #${albumId}`,
      actions: ['view'],
    });
    void this.drain();
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        if (job.token !== this.currentToken) continue; // 已被新调度取代
        await this.completeAlbum(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async completeAlbum(job: CompletionJob): Promise<void> {
    const total = job.trackIds.length;
    let completed = 0;
    for (const trackId of job.trackIds) {
      if (job.token !== this.currentToken) {
        this.deps.taskCenter?.complete(`album:${job.albumId}`, 'cancelled', '被新调度取代');
        return;
      }
      const track: QueueItem = {
        id: trackId,
        title: '',
        source: 'netease',
        entitlement: 'unknown',
        cacheStatus: 'none',
      };
      try {
        const cached = await this.deps.cache.getPlayable(track);
        if (!cached) {
          const result = (await this.deps.netease.route('/netease/song/url', {
            id: trackId,
            quality: 'standard',
            vip: this.deps.session.isLoggedIn,
          })) as { data?: Array<{ url: string | null }> };
          const url = result.data?.[0]?.url;
          if (url) {
            await this.deps.cache.ensureCached(track, url, {
              ownerUserId: this.deps.session.isLoggedIn ? String(this.deps.session.getCookie()?.userId ?? '') : null,
            });
          }
        }
      } catch (error) {
        this.logger.warn(`album-completion: track ${trackId} failed`, error);
      }
      completed += 1;
      this.deps.taskCenter?.update(`album:${job.albumId}`, {
        progress: total > 0 ? completed / total : 1,
        detail: `${completed}/${total}`,
      });
    }
    this.deps.taskCenter?.complete(`album:${job.albumId}`, 'done', `${completed}/${total}`);
  }
}
