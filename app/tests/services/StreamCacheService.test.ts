import { describe, expect, it, vi } from 'vitest';
import { StreamCacheService, CACHE_RETRY_LIMIT } from '../../src/services/StreamCacheService';
import { createFakeFs, createFakeHttp, createFakeSql } from '../../src/infra/fakes';
import type { QueueItem } from '../../src/domains/player/types';
import { createNullLogger } from '../../src/shared/logger';

function track(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    title: `Track ${id}`,
    source: 'netease',
    entitlement: 'free',
    cacheStatus: 'none',
    contextId: 'ctx-a',
    ...overrides,
  };
}

const encoder = new TextEncoder();

function makeService(overrides: { capacityBytes?: number; verify?: (id: string, owner: string) => Promise<boolean> } = {}) {
  const fs = createFakeFs();
  const http = createFakeHttp();
  const sql = createFakeSql();
  const tasks: Array<{ trackId: string; state: string }> = [];
  const service = new StreamCacheService({
    http,
    fs,
    sql,
    cacheDir: '/cache',
    capacityBytes: overrides.capacityBytes,
    verifyEntitlement: overrides.verify,
    onTaskChange: (task) => tasks.push({ trackId: task.trackId, state: task.state }),
    logger: createNullLogger(),
  });
  return { service, fs, http, sql, tasks };
}

describe('StreamCacheService', () => {
  it('公共缓存：流式拉取 + 分块写盘 + ready + 索引行', async () => {
    const { service, fs, http, sql } = makeService();
    const body = [encoder.encode('part1'), encoder.encode('part2'), encoder.encode('part3')];
    http.respond('https://cdn/t1.mp3', body, 200);

    const result = await service.ensureCached(track('t1'), 'https://cdn/t1.mp3');
    expect(result?.kind).toBe('public');
    expect(result?.filePath).toBe('/cache/t1.cache');
    const file = await fs.readFile('/cache/t1.cache');
    expect(new TextDecoder().decode(file)).toBe('part1part2part3');

    const rows = await sql.select<{ track_id: string; status: string; bytes: number }>(
      'SELECT * FROM cache WHERE track_id = ?',
      ['t1'],
    );
    expect(rows[0]?.status).toBe('ready');
    expect(rows[0]?.bytes).toBe(body.reduce((a, c) => a + c.length, 0));

    const task = service.getTask('t1');
    expect(task?.state).toBe('ready');
    expect(task?.progress).toBe(1);
  });

  it('幂等：ready 后重复 ensureCached 不重复下载', async () => {
    const { service, http } = makeService();
    http.respond('https://cdn/t1.mp3', [encoder.encode('data')], 200);
    await service.ensureCached(track('t1'), 'https://cdn/t1.mp3');
    let calls = 0;
    const originalFetch = http.fetch.bind(http);
    http.fetch = async () => {
      calls += 1;
      return originalFetch('https://cdn/t1.mp3');
    };
    const result = await service.ensureCached(track('t1'), 'https://cdn/t1.mp3');
    expect(result).not.toBeNull();
    expect(calls).toBe(0);
  });

  it('HTTP 失败重试 3 次后标 failed（不阻塞播放）', async () => {
    const { service, http, sql } = makeService();
    http.respond('https://cdn/bad.mp3', [encoder.encode('x')], 500);
    const result = await service.ensureCached(track('bad'), 'https://cdn/bad.mp3');
    expect(result).toBeNull();
    expect(service.getTask('bad')?.state).toBe('failed');
    expect(service.getTask('bad')?.retries).toBe(CACHE_RETRY_LIMIT - 1);
    const rows = await sql.select<{ track_id: string; status: string }>('SELECT * FROM cache WHERE track_id = ?', ['bad']);
    expect(rows[0]?.status).toBe('failed');
  });

  it('权益缓存：验证成功 → ready；播放前重验证失败 → locked 且不可播放', async () => {
    const verify = vi.fn(async () => true);
    const { service, http, sql } = makeService({ verify });
    http.respond('https://cdn/vip.mp3', [encoder.encode('vip')], 200);

    const result = await service.ensureCached(track('vip'), 'https://cdn/vip.mp3', { ownerUserId: 'u1' });
    expect(result?.kind).toBe('entitlement');
    expect(result?.ownerUserId).toBe('u1');
    expect(verify).toHaveBeenCalledWith('vip', 'u1');

    // 播放前：账号失效 → locked
    verify.mockResolvedValueOnce(false);
    const playable = await service.getPlayable(track('vip'));
    expect(playable).toBeNull();
    const rows = await sql.select<{ track_id: string; status: string }>('SELECT * FROM cache WHERE track_id = ?', ['vip']);
    expect(rows[0]?.status).toBe('locked');

    // 锁定缓存不可播放（文件保留但拒绝）
    verify.mockResolvedValueOnce(true);
    const again = await service.getPlayable(track('vip'));
    expect(again).toBeNull(); // status=locked 直接拒绝
  });

  it('公共缓存播放前：更新 last_played_at 并可播放', async () => {
    const { service, http, sql } = makeService();
    http.respond('https://cdn/t1.mp3', [encoder.encode('data')], 200);
    await service.ensureCached(track('t1'), 'https://cdn/t1.mp3');
    const playable = await service.getPlayable(track('t1'));
    expect(playable?.filePath).toBe('/cache/t1.cache');
    const rows = await sql.select<{ last_played_at: number }>('SELECT last_played_at FROM cache WHERE track_id = ?', ['t1']);
    expect(rows[0]?.last_played_at).toBeGreaterThan(0);
  });

  it('容量 LRU 淘汰：locked 优先，其余按最近播放升序', async () => {
    const { service, http, sql } = makeService({ capacityBytes: 10 });
    http.respond('https://cdn/a.mp3', [encoder.encode('aaaa')], 200); // 4 bytes
    http.respond('https://cdn/b.mp3', [encoder.encode('bbbb')], 200);
    http.respond('https://cdn/c.mp3', [encoder.encode('cccc')], 200);

    await service.ensureCached(track('a'), 'https://cdn/a.mp3');
    await service.ensureCached(track('b'), 'https://cdn/b.mp3');
    await service.ensureCached(track('c'), 'https://cdn/c.mp3');
    // 总 12 bytes > 10：淘汰 1 条（按 last_played_at 升序 = a）
    const remaining = await sql.select<{ track_id: string }>('SELECT track_id FROM cache');
    expect(remaining.map((r) => r.track_id)).not.toContain('a');
    expect(remaining).toHaveLength(2);
  });

  it('remove 显式清理文件与索引', async () => {
    const { service, http, fs, sql } = makeService();
    http.respond('https://cdn/t1.mp3', [encoder.encode('data')], 200);
    await service.ensureCached(track('t1'), 'https://cdn/t1.mp3');
    await service.remove('t1');
    expect(await fs.exists('/cache/t1.cache')).toBe(false);
    const rows = await sql.select<{ track_id: string }>('SELECT * FROM cache WHERE track_id = ?', ['t1']);
    expect(rows).toHaveLength(0);
  });
});
