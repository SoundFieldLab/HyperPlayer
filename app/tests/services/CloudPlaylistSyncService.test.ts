import { describe, expect, it, vi, afterEach } from 'vitest';
import { CloudPlaylistSyncService, CLOUD_SYNC_TASK_ID } from '../../src/services/CloudPlaylistSyncService';
import { NeteaseService } from '../../src/domains/netease/NeteaseService';
import type { SessionService } from '../../src/domains/netease/SessionService';
import type { NeteaseApi } from '../../src/domains/netease/api/neteaseApi';
import { TaskCenter } from '../../src/services/TaskCenter';
import { createFakeSql } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

function makeFakeApi(overrides: Record<string, (data: Record<string, unknown>) => Promise<unknown>> = {}): NeteaseApi {
  return new Proxy({} as NeteaseApi, {
    get: (target, property: string) => {
      if (property in target) return target[property];
      return async (data: Record<string, unknown>) => {
        const handler = overrides[property];
        if (handler) return handler(data);
        return { status: 200, body: { code: 200 }, cookie: [] };
      };
    },
  });
}

function answer(body: unknown): { status: number; body: unknown; cookie: string[] } {
  return { status: 200, body, cookie: [] };
}

function makeLoggedInSession(): SessionService {
  return { isLoggedIn: true, getCookie: () => ({ userId: '100' }) } as unknown as SessionService;
}

function makeAnonymousSession(): SessionService {
  return { isLoggedIn: false, getCookie: () => null } as unknown as SessionService;
}

function makeContext(session: SessionService, api: NeteaseApi) {
  const sql = createFakeSql();
  const taskCenter = new TaskCenter({ logger: createNullLogger() });
  const netease = new NeteaseService({ api, session, logger: createNullLogger() });
  const service = new CloudPlaylistSyncService({ netease, session, sql, taskCenter, logger: createNullLogger() });
  return { sql, taskCenter, service };
}

describe('CloudPlaylistSyncService（后端补充规划 #33）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('未登录：syncAll 跳过，不注册任务', async () => {
    const { service, taskCenter } = makeContext(makeAnonymousSession(), makeFakeApi());
    await service.init();
    const result = await service.syncAll();
    expect(result).toEqual({ playlists: 0, tracks: 0 });
    expect(taskCenter.getTask(CLOUD_SYNC_TASK_ID)).toBeUndefined();
  });

  it('全量同步：列表 + 详情曲目落库，任务 done 带统计', async () => {
    const api = makeFakeApi({
      user_playlist: async () =>
        answer({
          playlist: [
            { id: 1, name: '华语经典', trackCount: 2, coverImgUrl: 'https://p/c1.jpg', creator: { nickname: '我' } },
            { id: 2, name: '纯音乐', trackCount: 0 },
          ],
        }),
      playlist_detail: async (data) => {
        const id = Number(data.id);
        if (id === 1) return answer({ playlist: { trackIds: [{ id: 101 }, { id: 102 }] } });
        return answer({ playlist: { trackIds: [] } });
      },
    });
    const { taskCenter, service } = makeContext(makeLoggedInSession(), api);
    await service.init();
    const result = await service.syncAll();
    expect(result).toEqual({ playlists: 2, tracks: 2 });

    const playlists = await service.listCached();
    expect(playlists).toHaveLength(2);
    expect(playlists.find((p) => p.id === '1')).toMatchObject({ id: '1', name: '华语经典', trackCount: 2, coverUrl: 'https://p/c1.jpg', creator: '我' });
    expect(await service.getCachedTrackIds('1')).toEqual(['101', '102']);
    expect(await service.getCachedTrackIds('2')).toEqual([]);

    const task = taskCenter.getTask(CLOUD_SYNC_TASK_ID);
    expect(task?.state).toBe('done');
    expect(task?.kind).toBe('netease-sync');
    expect(task?.detail).toContain('2 个歌单');
  });

  it('合并策略：远端删除的歌单本地清除（含曲目）', async () => {
    let remote = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const api = makeFakeApi({
      user_playlist: async () => answer({ playlist: remote }),
      playlist_detail: async () => answer({ playlist: { trackIds: [{ id: 999 }] } }),
    });
    const { service } = makeContext(makeLoggedInSession(), api);
    await service.init();
    await service.syncAll();
    expect(await service.listCached()).toHaveLength(2);

    remote = [{ id: 1, name: 'A' }]; // 远端删除歌单 2
    await service.syncAll();
    const playlists = await service.listCached();
    expect(playlists.map((p) => p.id)).toEqual(['1']);
    expect(await service.getCachedTrackIds('2')).toEqual([]);
  });

  it('同步失败：任务 failed 带原因并抛出', async () => {
    const api = makeFakeApi({
      user_playlist: async () => {
        throw new Error('network');
      },
    });
    const { taskCenter, service } = makeContext(makeLoggedInSession(), api);
    await service.init();
    await expect(service.syncAll()).rejects.toThrow('network');
    const task = taskCenter.getTask(CLOUD_SYNC_TASK_ID);
    expect(task?.state).toBe('failed');
    expect(task?.detail).toContain('network');
  });

  it('自动同步：按间隔触发 syncAll，stopAutoSync 停止', async () => {
    vi.useFakeTimers();
    let playlistCalls = 0;
    const api = makeFakeApi({
      user_playlist: async () => {
        playlistCalls += 1;
        return answer({ playlist: [] });
      },
    });
    const { service } = makeContext(makeLoggedInSession(), api);
    await service.init();
    service.startAutoSync(1000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(playlistCalls).toBe(2); // 初始 0 + 2 次间隔触发
    service.stopAutoSync();
    await vi.advanceTimersByTimeAsync(3000);
    expect(playlistCalls).toBe(2);
  });
});
