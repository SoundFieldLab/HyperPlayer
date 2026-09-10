import { describe, expect, it, vi } from 'vitest';
import { BootTimeoutError, bootApplication, disposeServices, withTimeout } from '../../src/app/boot';
import { createDefaultSettings } from '../../src/services/SettingsService';
import type { PersistedPage, PersistedQueue } from '../../src/services/SettingsService';
import type { Services } from '../../src/app/wiring';
import { useAppStore } from '../../src/stores/store';

function fakeServices(overrides: Record<string, unknown> = {}) {
  const order: string[] = [];
  const settings = createDefaultSettings();
  return {
    order,
    services: {
      settings: {
        snapshot: settings,
        load: vi.fn(async () => { order.push('settings'); return settings; }),
        restoreQueue: vi.fn(async (): Promise<PersistedQueue | null> => null),
        restoreLastPage: vi.fn(async (): Promise<PersistedPage | null> => null),
      },
      session: { restoreSession: vi.fn(async () => { order.push('session'); return 'anonymous'; }) },
      library: { init: vi.fn(async () => { order.push('library'); }) },
      queue: { restore: vi.fn() },
      audio: { startClock: vi.fn() },
      ...overrides,
    },
  };
}

describe('bootApplication', () => {
  it('首次未完成 onboarding 时进入向导', async () => {
    const fake = fakeServices();
    await bootApplication({ initialize: async () => fake.services as unknown as Services });
    expect(useAppStore.getState().currentEntry).toEqual({ routeId: 'onboarding' });
  });

  it('完成 onboarding 后按 startupPage 进入本地首页', async () => {
    const fake = fakeServices();
    fake.services.settings.snapshot.onboarding.completedAt = 1;
    fake.services.settings.snapshot.startupPage = 'local-home';
    await bootApplication({ initialize: async () => fake.services as unknown as Services });
    expect(useAppStore.getState().activeDomain).toBe('local');
    expect(useAppStore.getState().currentEntry).toEqual({ routeId: 'local-home' });
  });

  it('last-page 恢复上次稳定页面', async () => {
    const fake = fakeServices();
    fake.services.settings.snapshot.onboarding.completedAt = 1;
    fake.services.settings.snapshot.startupPage = 'last-page';
    fake.services.settings.restoreLastPage.mockResolvedValue({ domain: 'local', entry: { routeId: 'local-folders' } });
    await bootApplication({ initialize: async () => fake.services as unknown as Services });
    expect(useAppStore.getState().currentEntry).toEqual({ routeId: 'local-folders' });
  });

  it('按设置、会话、曲库顺序完成初始化并启动时钟', async () => {
    const fake = fakeServices();
    await bootApplication({ initialize: async () => fake.services as unknown as Services });
    expect(fake.order).toEqual(['settings', 'session', 'library']);
    expect(fake.services.audio.startClock).toHaveBeenCalledOnce();
  });

  it('原子恢复队列并保持临时区顺序', async () => {
    const item = (id: string) => ({ id, title: id, source: 'local' as const, entitlement: 'free' as const, cacheStatus: 'none' as const });
    const persisted: PersistedQueue = {
      savedAt: 1,
      currentId: 'b',
      upNext: [item('x'), item('y')],
      context: [item('a'), item('b')],
      mode: 'loop',
    };
    const fake = fakeServices();
    fake.services.settings.restoreQueue.mockResolvedValue(persisted);
    await bootApplication({ initialize: async () => fake.services as unknown as Services });
    expect(fake.services.queue.restore).toHaveBeenCalledWith({
      current: persisted.context[1],
      upNext: persisted.upNext,
      context: persisted.context,
      mode: 'loop',
    });
  });

  it('完整恢复流程超时后释放已取得的服务图', async () => {
    const fake = fakeServices({ library: { init: () => new Promise(() => {}) } });
    const onLateServices = vi.fn();
    await expect(bootApplication({
      initialize: async () => fake.services as unknown as Services,
      timeoutMs: 1,
      onLateServices,
    })).rejects.toBeInstanceOf(BootTimeoutError);
    expect(onLateServices).toHaveBeenCalledWith(fake.services);
  });

  it('初始化本身超时后在服务图晚到时释放', async () => {
    const fake = fakeServices();
    let resolveInitialize!: (services: Services) => void;
    const initialize = new Promise<Services>((resolve) => { resolveInitialize = resolve; });
    let reportLate!: (services: Services) => void;
    const lateServices = new Promise<Services>((resolve) => { reportLate = resolve; });
    const onLateServices = vi.fn((services: Services) => reportLate(services));
    await expect(bootApplication({ initialize: () => initialize, timeoutMs: 1, onLateServices }))
      .rejects.toBeInstanceOf(BootTimeoutError);
    resolveInitialize(fake.services as unknown as Services);
    await expect(lateServices).resolves.toBe(fake.services);
    expect(onLateServices).toHaveBeenCalledOnce();
  });

  it('统一释放全部长期资源', async () => {
    const services = {
      cloudPlaylistSync: { stopAutoSync: vi.fn() },
      session: { stopQrPolling: vi.fn() },
      settings: { flushQueuePersist: vi.fn(async () => {}) },
      player: { dispose: vi.fn() },
      stateMachine: { dispose: vi.fn() },
      audio: { dispose: vi.fn() },
      telemetry: { dispose: vi.fn() },
      shortcut: { dispose: vi.fn(async () => {}) },
      tray: { dispose: vi.fn(async () => {}) },
      disposeSubscriptions: vi.fn(),
    } as unknown as Services;

    await disposeServices(services);

    expect(services.cloudPlaylistSync.stopAutoSync).toHaveBeenCalledOnce();
    expect(services.session.stopQrPolling).toHaveBeenCalledOnce();
    expect(services.disposeSubscriptions).toHaveBeenCalledOnce();
    expect(services.player.dispose).toHaveBeenCalledOnce();
    expect(services.stateMachine.dispose).toHaveBeenCalledOnce();
    expect(services.audio.dispose).toHaveBeenCalledOnce();
    expect(services.telemetry.dispose).toHaveBeenCalledOnce();
    expect(services.shortcut.dispose).toHaveBeenCalledOnce();
    expect(services.tray.dispose).toHaveBeenCalledOnce();
  });

  it('withTimeout 超时以 BootTimeoutError 拒绝', async () => {
    await expect(withTimeout(new Promise(() => {}), 1)).rejects.toBeInstanceOf(BootTimeoutError);
  });
});
