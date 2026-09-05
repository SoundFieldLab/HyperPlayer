import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SessionService, QR_RETRY_COUNT, QR_RETRY_DELAY_MS } from '../../../src/domains/netease/SessionService';
import { NeteaseService } from '../../../src/domains/netease/NeteaseService';
import type { NeteaseApiAnswer } from '../../../src/domains/netease/api/vendor-api';
import type { NeteaseApi } from '../../../src/domains/netease/api/neteaseApi';
import { createFakeVault } from '../../../src/infra/fakes';
import { createNullLogger } from '../../../src/shared/logger';

function makeFakeApi(overrides: Record<string, (data: Record<string, unknown>) => Promise<NeteaseApiAnswer>> = {}): {
  api: NeteaseApi;
  calls: Array<{ endpoint: string; data: Record<string, unknown> }>;
} {
  const calls: Array<{ endpoint: string; data: Record<string, unknown> }> = [];
  const api = new Proxy({} as NeteaseApi, {
    get: (target, property: string) => {
      if (property in target) return target[property];
      return (data: Record<string, unknown>) => {
        calls.push({ endpoint: property, data });
        const handler = overrides[property];
        if (handler) return handler(data);
        return Promise.resolve({ status: 200, body: { code: 200 }, cookie: [] });
      };
    },
  });
  return { api, calls };
}

function answer(code: number, extra: Record<string, unknown> = {}, cookie: string[] = []): NeteaseApiAnswer {
  return { status: 200, body: { code, ...extra }, cookie };
}

function makeSession(api: NeteaseApi, onStateChange?: (s: string) => void) {
  const vault = createFakeVault();
  const session = new SessionService({ api, vault, onStateChange: onStateChange as never, logger: createNullLogger() });
  return { session, vault };
}

describe('NeteaseService（waveforge oracle 对拍）', () => {
  it('call 统一包装：前两次失败 → 指数退避 → 第三次成功', async () => {
    const { api } = makeFakeApi();
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(answer(200, { data: [1] }));
    (api as unknown as { search: typeof fn }).search = fn;

    const result = await service.call('search', { keywords: 'test' }, { retries: 3, timeoutMs: 500 });
    expect(result.body.code).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls[0]?.[0]?.timeout).toBe(500); // timeout 透传 params
  });

  it('song/url 音质降级候选链：jymaster 失败 → hires 成功', async () => {
    const { api } = makeFakeApi({
      song_url_v1: async (data) => {
        if (data.level === 'jymaster') throw new Error('jymaster unavailable');
        return answer(200, { data: [{ id: 1, url: 'https://cdn/hires.mp3', level: 'hires' }] });
      },
    });
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });

    const result = await service.route('/netease/song/url', { id: 1, quality: 'auto', vip: true });
    const song = result as { data: Array<{ url: string }>; actualQuality: string | null };
    expect(song.data[0]?.url).toBe('https://cdn/hires.mp3');
    expect(song.actualQuality).toBe('hires');
  });

  it('song/url 付费拦截：候选链尽 + fee===1 → URL null + paid-content 标记', async () => {
    const { api } = makeFakeApi({
      song_url_v1: async () => answer(200, { data: [{ id: 1, url: null }] }),
      song_detail: async () => answer(200, { songs: [{ fee: 1 }], privileges: [] }),
    });
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });

    const result = (await service.route('/netease/song/url', { id: 1, quality: 'auto' })) as {
      data: Array<{ url: null; fee: number }>;
      fallbackBlocked: string;
    };
    expect(result.data[0]?.url).toBeNull();
    expect(result.data[0]?.fee).toBe(1);
    expect(result.fallbackBlocked).toBe('paid-content');
  });

  it('失真路由修复：event/following、event/user、cloud/delete、user/subscribe 映射真实端点', async () => {
    const { api, calls } = makeFakeApi();
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });
    await service.route('/netease/event/following', { pagesize: 10 }).catch(() => {});
    await service.route('/netease/event/user', { uid: 1 }).catch(() => {});
    await service.route('/netease/cloud/delete', { id: 1 }).catch(() => {});
    await service.route('/netease/user/subscribe', { id: 1 }).catch(() => {});
    const endpoints = calls.map((c) => c.endpoint);
    expect(endpoints).toContain('event');
    expect(endpoints).toContain('user_event');
    expect(endpoints).toContain('user_cloud_del');
    expect(endpoints).toContain('follow');
    expect(endpoints).not.toContain('event_forward'); // 不再被这 4 条路由使用
    expect(endpoints).not.toContain('artist_sub');
  });

  it(':type 参数路由：record/recent/:type 按类型分发 + record/rank/:type → user_record', async () => {
    const { api, calls } = makeFakeApi();
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });
    await service.route('/netease/record/recent/song', { limit: 10 }).catch(() => {});
    await service.route('/netease/record/recent/album', { limit: 10 }).catch(() => {});
    await service.route('/netease/record/rank/play', { limit: 10 }).catch(() => {});
    const endpoints = calls.map((c) => c.endpoint);
    expect(endpoints).toContain('record_recent_song');
    expect(endpoints).toContain('record_recent_album');
    expect(endpoints).toContain('user_record');
  });

  it('song/wiki 映射真实端点 song_wiki_summary', async () => {
    const { api, calls } = makeFakeApi();
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });
    await service.route('/netease/song/wiki', { id: 1 }).catch(() => {});
    expect(calls.some((c) => c.endpoint === 'song_wiki_summary')).toBe(true);
  });

  it('红线：song_url_match 永不调用（LGPL 解灰路径废除）', async () => {
    const { api, calls } = makeFakeApi();
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });
    await service.route('/netease/song/url', { id: 1, quality: 'auto' }).catch(() => {});
    expect(calls.some((c) => c.endpoint === 'song_url_match')).toBe(false);
  });

  it('tokenInvalid 全局拦截：code 301 → 降级匿名', async () => {
    const { api } = makeFakeApi({
      song_detail: async () => answer(301, { msg: 'login expired' }),
    });
    const { session, vault } = makeSession(api);
    await vault.setSecret('netease', 'cookie', JSON.stringify({ MUSIC_U: 'x' }));
    await session.restoreSession();
    expect(session.isLoggedIn).toBe(true);

    const service = new NeteaseService({ api, session, logger: createNullLogger() });
    await service.call('song_detail', { ids: '1' });
    expect(session.snapshot).toBe('anonymous');
    expect(await vault.getSecret('netease', 'cookie')).toBeNull();
  });

  it("route 透传：'/netease/search' → api.search + 统一重试包装", async () => {
    const { api, calls } = makeFakeApi({
      search: async () => answer(200, { result: { songs: [{ id: 1 }] } }),
    });
    const { session } = makeSession(api);
    const service = new NeteaseService({ api, session, logger: createNullLogger() });
    const result = (await service.route('/netease/search', { keywords: '你好' })) as { body: { result: { songs: unknown[] } } };
    expect(calls[0]?.endpoint).toBe('search');
    expect(result.body.result.songs).toHaveLength(1);
  });
});

describe('SessionService（QR 登录状态机）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('startQrLogin：qrKey + qrCreate → qrWaiting', async () => {
    const { api } = makeFakeApi({
      login_qr_key: async () => answer(200, { data: { unikey: 'key-123' } }),
      login_qr_create: async () => answer(200, { data: { qrimg: 'data:image/png;base64,xx' } }),
    });
    const { session } = makeSession(api);
    const login = await session.startQrLogin();
    expect(login.key).toBe('key-123');
    expect(login.qrimg).toContain('data:image/png');
    expect(session.snapshot).toBe('qrWaiting');
  });

  it('qrKey 失败重试 3 次后抛出', async () => {
    const { api } = makeFakeApi({
      login_qr_key: async () => {
        throw new Error('network');
      },
    });
    const { session } = makeSession(api);
    const promise = session.startQrLogin();
    const assertion = expect(promise).rejects.toThrow('network'); // 先挂 rejection 处理器，避免假定时器推进期间出现 unhandled rejection
    await vi.advanceTimersByTimeAsync(QR_RETRY_DELAY_MS * 3);
    await assertion;
    expect(QR_RETRY_COUNT).toBe(3);
  });

  it('pollQrOnce 803 → loggedIn，凭据只进 vault', async () => {
    const { api } = makeFakeApi({
      login_qr_key: async () => answer(200, { data: { unikey: 'key-1' } }),
      login_qr_create: async () => answer(200, { data: { qrimg: 'img' } }),
      login_qr_check: async () => answer(803, {}, ['MUSIC_U=abc123; Path=/']),
    });
    const { session, vault } = makeSession(api);
    await session.startQrLogin();
    const state = await session.pollQrOnce();
    expect(state).toBe('loggedIn');
    const raw = await vault.getSecret('netease', 'cookie');
    expect(raw).toContain('MUSIC_U');
    expect(session.getCookie()?.MUSIC_U).toBe('abc123');
  });

  it('800 过期自动重取码（永不主动断）', async () => {
    const { api, calls } = makeFakeApi({
      login_qr_key: async () => answer(200, { data: { unikey: `key-${calls.filter((c) => c.endpoint === 'login_qr_key').length}` } }),
      login_qr_create: async () => answer(200, { data: { qrimg: 'img' } }),
      login_qr_check: async () => answer(800),
    });
    const { session } = makeSession(api);
    await session.startQrLogin();
    await session.pollQrOnce();
    // 过期 → refreshQr → 重新 qrKey + qrCreate
    expect(calls.filter((c) => c.endpoint === 'login_qr_key')).toHaveLength(2);
    expect(calls.filter((c) => c.endpoint === 'login_qr_create')).toHaveLength(2);
  });

  it('startQrPolling：801→802→803 全流程，登录成功停止轮询', async () => {
    const sequence = [801, 802, 803];
    const { api } = makeFakeApi({
      login_qr_key: async () => answer(200, { data: { unikey: 'key-1' } }),
      login_qr_create: async () => answer(200, { data: { qrimg: 'img' } }),
      login_qr_check: async () => answer(sequence.shift() ?? 801, {}, ['MUSIC_U=xyz; Path=/']),
    });
    const states: string[] = [];
    const { session } = makeSession(api, (s) => states.push(s));
    await session.startQrLogin();
    const promise = session.startQrPolling(100);
    await vi.advanceTimersByTimeAsync(250);
    const final = await promise;
    expect(final).toBe('loggedIn');
    expect(states).toContain('qrScanned');
  });

  it('stopQrPolling 取消轮询（仅用户取消或成功停止）', async () => {
    const { api } = makeFakeApi({
      login_qr_key: async () => answer(200, { data: { unikey: 'key-1' } }),
      login_qr_create: async () => answer(200, { data: { qrimg: 'img' } }),
      login_qr_check: async () => answer(801),
    });
    const { session } = makeSession(api);
    await session.startQrLogin();
    const promise = session.startQrPolling(100);
    await vi.advanceTimersByTimeAsync(150);
    session.stopQrPolling();
    await vi.advanceTimersByTimeAsync(200); // 推进当前 delay 让循环退出
    const final = await promise;
    expect(final).toBe('qrWaiting');
  });

  it('logout 清除 vault 凭据并回 anonymous', async () => {
    const { api } = makeFakeApi({
      login_qr_key: async () => answer(200, { data: { unikey: 'k' } }),
      login_qr_create: async () => answer(200, { data: { qrimg: 'i' } }),
      login_qr_check: async () => answer(803, {}, ['MUSIC_U=abc; Path=/']),
    });
    const { session, vault } = makeSession(api);
    await session.startQrLogin();
    await session.pollQrOnce();
    expect(session.isLoggedIn).toBe(true);
    await session.logout();
    expect(session.snapshot).toBe('anonymous');
    expect(await vault.getSecret('netease', 'cookie')).toBeNull();
  });

  it('restoreSession：从 vault 恢复 loggedIn（自动出声由 UI-D76 控制）', async () => {
    const { api } = makeFakeApi();
    const { session, vault } = makeSession(api);
    await vault.setSecret('netease', 'cookie', JSON.stringify({ MUSIC_U: 'saved' }));
    const state = await session.restoreSession();
    expect(state).toBe('loggedIn');
    expect(session.getCookie()?.MUSIC_U).toBe('saved');
  });
});
