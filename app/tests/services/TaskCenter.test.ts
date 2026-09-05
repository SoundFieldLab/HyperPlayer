import { describe, expect, it, vi } from 'vitest';
import { TaskCenter } from '../../src/services/TaskCenter';
import { AlbumCompletionService } from '../../src/services/AlbumCompletionService';
import { StreamCacheService } from '../../src/services/StreamCacheService';
import type { NeteaseService } from '../../src/domains/netease/NeteaseService';
import type { SessionService } from '../../src/domains/netease/SessionService';
import { createFakeFs, createFakeHttp, createFakeSql } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

describe('TaskCenter（UI-D29 统一任务模型）', () => {
  it('register → update → complete：状态/进度/动作更新并通知订阅者', () => {
    const tc = new TaskCenter();
    const notified: string[][] = [];
    tc.subscribe(() => notified.push(tc.list().map((t) => `${t.id}:${t.state}:${t.progress}`)));

    tc.register({ id: 'scan:library', kind: 'scan', title: '本地曲库扫描', actions: ['pause', 'cancel', 'view'] });
    expect(notified.at(-1)).toEqual(['scan:library:running:0']);

    tc.update('scan:library', { progress: 0.5, detail: '1/2 文件夹' });
    expect(notified.at(-1)).toEqual(['scan:library:running:0.5']);

    tc.complete('scan:library', 'done', '2/2 文件夹');
    expect(tc.getTask('scan:library')?.state).toBe('done');
    expect(tc.getTask('scan:library')?.progress).toBe(1);
  });

  it('多任务并存（扫描/缓存/补全/锁定同模型）', () => {
    const tc = new TaskCenter();
    tc.register({ id: 'scan:library', kind: 'scan', title: '扫描' });
    tc.register({ id: 'cache:t1', kind: 'stream-cache', title: '缓存 #t1' });
    tc.register({ id: 'album:123', kind: 'album-completion', title: '专辑补全' });
    tc.register({ id: 'vip-lock:t1', kind: 'vip-lock', title: 'VIP 缓存锁定' });
    expect(tc.list()).toHaveLength(4);
    expect(tc.list().map((t) => t.kind)).toEqual(['scan', 'stream-cache', 'album-completion', 'vip-lock']);
  });

  it('update 未知任务为 no-op；remove 移除', () => {
    const tc = new TaskCenter();
    tc.update('missing', { progress: 1 });
    expect(tc.list()).toHaveLength(0);
    tc.register({ id: 'a', kind: 'scan', title: 'A' });
    tc.remove('a');
    expect(tc.list()).toHaveLength(0);
  });
});

describe('AlbumCompletionService（规格书 §3.5 低优先级补全）', () => {
  function makeHarness() {
    const fs = createFakeFs();
    const http = createFakeHttp();
    const sql = createFakeSql();
    for (const id of ['s1', 's2', 's3']) {
      http.respond(`https://cdn/${id}.mp3`, [new TextEncoder().encode(`${id}-data`)], 200);
    }
    const cache = new StreamCacheService({ http, fs, sql, cacheDir: '/cache', logger: createNullLogger() });
    const netease = {
      route: vi.fn(async (uri: string, params: Record<string, unknown>) => ({
        data: [{ id: Number(params.id), url: `https://cdn/${params.id}.mp3` }],
      })),
    } as unknown as NeteaseService;
    const session = { isLoggedIn: false, getCookie: () => null } as unknown as SessionService;
    const tc = new TaskCenter();
    const service = new AlbumCompletionService({ cache, netease, session, taskCenter: tc, logger: createNullLogger() });
    return { service, cache, netease, tc, fs };
  }

  it('补全专辑内未缓存曲目：逐曲拉直链 + 写缓存 + 任务进度', async () => {
    const { service, tc, fs } = makeHarness();
    await service.schedule('album-1', ['s1', 's2', 's3']);
    // 串行补全完成
    await new Promise((r) => setTimeout(r, 10));
    expect(await fs.exists('/cache/s1.cache')).toBe(true);
    expect(await fs.exists('/cache/s2.cache')).toBe(true);
    expect(await fs.exists('/cache/s3.cache')).toBe(true);
    expect(tc.getTask('album:album-1')?.state).toBe('done');
    expect(tc.getTask('album:album-1')?.progress).toBe(1);
  });

  it('已缓存曲目跳过（幂等补全）', async () => {
    const { service, cache, tc, fs } = makeHarness();
    // 先手动缓存 s1
    await cache.ensureCached({ id: 's1', title: 's1', source: 'netease', entitlement: 'free', cacheStatus: 'none' }, 'https://cdn/s1.mp3');
    await service.schedule('album-1', ['s1', 's2']);
    await new Promise((r) => setTimeout(r, 10));
    expect(await fs.exists('/cache/s1.cache')).toBe(true);
    expect(await fs.exists('/cache/s2.cache')).toBe(true);
    expect(tc.getTask('album:album-1')?.state).toBe('done');
  });

  it('新调度替换旧调度（取消过时补全）', async () => {
    const { service, tc, netease } = makeHarness();
    // 慢路由：第一张专辑拉取慢，第二张调度应取代
    netease.route = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { data: [{ url: 'https://cdn/x.mp3' }] };
    }) as never;
    void service.schedule('album-old', ['a1', 'a2', 'a3']);
    void service.schedule('album-new', ['n1']);
    await new Promise((r) => setTimeout(r, 120));
    expect(tc.getTask('album:album-old')?.state).toBe('cancelled'); // 被新调度取代
    expect(tc.getTask('album:album-new')?.state).toBe('done');
  });
});
