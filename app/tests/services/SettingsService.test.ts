import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  QUEUE_PERSIST_DEBOUNCE_MS,
  SettingsService,
  migrateSettings,
} from '../../src/services/SettingsService';
import { createFakeStore } from '../../src/infra/fakes';
import type { QueueState } from '../../src/domains/player/QueueController';
import { createNullLogger } from '../../src/shared/logger';

function makeQueueState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    current: { id: 't1', title: 'T1', source: 'local', entitlement: 'free', cacheStatus: 'none' },
    upNext: [],
    context: [],
    contextId: null,
    mode: 'sequence',
    pointer: -1,
    history: [],
    shuffle: [],
    shuffleIndex: -1,
    ...overrides,
  };
}

describe('SettingsService', () => {
  it('首次加载返回默认设置（D75 网易云首页 / D76 队列恢复开、继续播放关）', async () => {
    const service = new SettingsService({ store: createFakeStore(), logger: createNullLogger() });
    const settings = await service.load();
    expect(settings.startupPage).toBe('netease-home');
    expect(settings.restoreQueue).toBe(true);
    expect(settings.continueOnStartup).toBe(false);
    expect(settings.autoSkipOnError).toBe(true);
    expect(settings.keepUpNextOnContextSwitch).toBe(true);
    expect(settings.cacheCapacityBytes).toBe(5 * 1024 * 1024 * 1024);
  });

  it('update 持久化并通知订阅者', async () => {
    const store = createFakeStore();
    const service = new SettingsService({ store, logger: createNullLogger() });
    await service.load();
    const listener = vi.fn();
    service.subscribe(listener);
    await service.update({ startupPage: 'local-home', volume: 0.5 });
    expect(service.snapshot.startupPage).toBe('local-home');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ startupPage: 'local-home' }));
    // 重新加载（新实例）→ 从 store 恢复
    const reloaded = new SettingsService({ store, logger: createNullLogger() });
    expect((await reloaded.load()).volume).toBe(0.5);
  });

  it('schema 版本迁移：旧版本数据升级并回写', async () => {
    const store = createFakeStore();
    await store.set('app.settings', { schemaVersion: 0, startupPage: 'last-page' });
    const service = new SettingsService({ store, logger: createNullLogger() });
    const settings = await service.load();
    expect(settings.schemaVersion).toBe(1);
    expect(settings.startupPage).toBe('last-page'); // 旧值保留
    expect(settings.keepUpNextOnContextSwitch).toBe(true); // 新字段取默认
    const stored = await store.get<{ schemaVersion: number }>('app.settings');
    expect(stored?.schemaVersion).toBe(1);
  });

  it('migrateSettings 直接迁移（纯函数）', () => {
    const migrated = migrateSettings({ schemaVersion: 0 } as never);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.restoreQueue).toBe(true);
  });
});

describe('SettingsService 队列持久化（2s 防抖 + 退出强写）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scheduleQueuePersist 防抖 2s 后落盘；多次调用只写一次', async () => {
    const store = createFakeStore();
    const service = new SettingsService({ store, logger: createNullLogger() });
    service.scheduleQueuePersist(makeQueueState({ mode: 'sequence' }));
    service.scheduleQueuePersist(makeQueueState({ mode: 'shuffle' }));
    expect(await store.get('app.queue')).toBeNull();
    await vi.advanceTimersByTimeAsync(QUEUE_PERSIST_DEBOUNCE_MS + 10);
    const persisted = await store.get<{ mode: string }>('app.queue');
    expect(persisted?.mode).toBe('shuffle'); // 最后一次快照
  });

  it('flushQueuePersist 立即强写（退出强写）', async () => {
    const store = createFakeStore();
    const service = new SettingsService({ store, logger: createNullLogger() });
    service.scheduleQueuePersist(makeQueueState());
    await service.flushQueuePersist();
    const persisted = await store.get<{ currentId: string }>('app.queue');
    expect(persisted?.currentId).toBe('t1');
  });

  it('崩溃恢复：restoreQueue 返回上次持久化队列（保持暂停由调用方处理，UI-D76）', async () => {
    const store = createFakeStore();
    const service = new SettingsService({ store, logger: createNullLogger() });
    service.scheduleQueuePersist(makeQueueState({ mode: 'loop' }));
    await service.flushQueuePersist();

    const restored = await service.restoreQueue();
    expect(restored?.currentId).toBe('t1');
    expect(restored?.mode).toBe('loop');
    expect(restored?.savedAt).toBeGreaterThan(0);
  });

  it('无待写快照时 flush 为 no-op', async () => {
    const store = createFakeStore();
    const service = new SettingsService({ store, logger: createNullLogger() });
    await service.flushQueuePersist();
    expect(await store.get('app.queue')).toBeNull();
  });
});
