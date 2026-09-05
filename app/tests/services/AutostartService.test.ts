import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AutostartService } from '../../src/services/AutostartService';
import { SettingsService } from '../../src/services/SettingsService';
import { createFakeStore, createFakeAutostart } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

function makeContext() {
  const store = createFakeStore();
  const settings = new SettingsService({ store, logger: createNullLogger() });
  const autostart = createFakeAutostart();
  const service = new AutostartService({ autostart, settings, logger: createNullLogger() });
  return { settings, autostart, service };
}

describe('AutostartService（后端补充规划 #39）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('init：设置与系统状态一致时不动', async () => {
    const { settings, autostart, service } = makeContext();
    await settings.load();
    await settings.update({ autostart: false });
    await service.init();
    expect(await autostart.isEnabled()).toBe(false);
  });

  it('init：设置开但系统未启用 → 启用并拉齐', async () => {
    const { settings, autostart, service } = makeContext();
    await settings.load();
    await settings.update({ autostart: true });
    await service.init();
    expect(await autostart.isEnabled()).toBe(true);
  });

  it('init：设置关但系统已启用（外部篡改）→ 停用', async () => {
    const { settings, autostart, service } = makeContext();
    await settings.load();
    await autostart.enable();
    await service.init();
    expect(await autostart.isEnabled()).toBe(false);
  });

  it('期望值未变化时 init 跳过 IPC 探测（设置高频更新不空转）', async () => {
    const raw = createFakeAutostart();
    let isEnabledCalls = 0;
    const autostart = {
      ...raw,
      isEnabled: async () => {
        isEnabledCalls += 1;
        return raw.isEnabled();
      },
    };
    const store = createFakeStore();
    const settings = new SettingsService({ store, logger: createNullLogger() });
    const service = new AutostartService({ autostart, settings, logger: createNullLogger() });
    await settings.load();
    await service.init();
    expect(isEnabledCalls).toBe(1);
    await service.init(); // 期望未变
    expect(isEnabledCalls).toBe(1);
    await settings.update({ volume: 0.5 });
    await service.init(); // 无关设置变更
    expect(isEnabledCalls).toBe(1);
    await settings.update({ autostart: true });
    await service.init();
    expect(isEnabledCalls).toBe(2);
  });

  it('setAutostart：成功时写设置并应用系统', async () => {
    const { settings, autostart, service } = makeContext();
    await settings.load();
    const ok = await service.setAutostart(true);
    expect(ok).toBe(true);
    expect(settings.snapshot.autostart).toBe(true);
    expect(await autostart.isEnabled()).toBe(true);
  });

  it('setAutostart：系统失败时不落盘设置', async () => {
    const { settings, autostart, service } = makeContext();
    await settings.load();
    autostart.setFailNext(true);
    const ok = await service.setAutostart(true);
    expect(ok).toBe(false);
    expect(settings.snapshot.autostart).toBe(false);
    expect(await autostart.isEnabled()).toBe(false);
  });
});
