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
