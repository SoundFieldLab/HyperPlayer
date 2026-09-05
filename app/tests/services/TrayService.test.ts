import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TrayService } from '../../src/services/TrayService';
import { SettingsService } from '../../src/services/SettingsService';
import { createFakeStore, createFakeTray, createFakeWindowControl } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

function makeContext() {
  const store = createFakeStore();
  const settings = new SettingsService({ store, logger: createNullLogger() });
  const tray = createFakeTray();
  const window = createFakeWindowControl();
  const commands = { playPause: vi.fn(), next: vi.fn(), prev: vi.fn() };
  const service = new TrayService({ tray, window, settings, commands, logger: createNullLogger() });
  return { settings, tray, window, commands, service };
}

describe('TrayService（后端补充规划 #42，UI-D77）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('init 构建 UI-D77 菜单清单（显示主窗口/播放暂停/上一首/下一首/完全退出 + 分隔线）', async () => {
    const { service, tray } = makeContext();
    await service.init();
    const labels = tray.items
      .filter((item): item is { id: string; label: string } => item !== 'separator')
      .map((item) => item.label);
    expect(labels).toEqual(['显示主窗口', '播放/暂停', '上一首', '下一首', '完全退出']);
    expect(tray.items.filter((item) => item === 'separator')).toHaveLength(2);
  });

  it('菜单标签与命令配对：上一首→prev、下一首→next（回归：标签与命令曾对调）', async () => {
    const { service, tray, commands } = makeContext();
    await service.init();
    tray.click('prev');
    await Promise.resolve();
    expect(commands.prev).toHaveBeenCalledTimes(1);
    expect(commands.next).not.toHaveBeenCalled();
    tray.click('next');
    await Promise.resolve();
    expect(commands.next).toHaveBeenCalledTimes(1);
    expect(commands.prev).toHaveBeenCalledTimes(1);
  });

  it('菜单动作映射：show → 显示并聚焦窗口；quit → 直接关闭', async () => {
    const { service, tray, window } = makeContext();
    await service.init();
    tray.click('show');
    await Promise.resolve();
    expect(window.calls).toContain('show');
    expect(window.calls).toContain('setFocus');
    tray.click('quit');
    await Promise.resolve();
    expect(window.calls).toContain('destroy');
  });

  it('菜单动作映射：播放控制 → 命令（不改变窗口）', async () => {
    const { service, tray, commands } = makeContext();
    await service.init();
    tray.click('playPause');
    tray.click('next');
    tray.click('prev');
    await Promise.resolve();
    expect(commands.playPause).toHaveBeenCalledTimes(1);
    expect(commands.next).toHaveBeenCalledTimes(1);
    expect(commands.prev).toHaveBeenCalledTimes(1);
  });

  it('closeBehavior=minimize：拦截关闭并隐藏窗口', async () => {
    const { service, window, settings } = makeContext();
    await settings.load();
    await settings.update({ closeBehavior: 'minimize' });
    await service.init();
    window.triggerCloseRequest();
    await Promise.resolve();
    expect(window.lastCloseEvent.prevented).toBe(true);
    expect(window.calls).toContain('hide');
  });

  it('closeBehavior=quit：放行关闭（不 preventDefault）', async () => {
    const { service, window, settings } = makeContext();
    await settings.load();
    await settings.update({ closeBehavior: 'quit' });
    await service.init();
    window.triggerCloseRequest();
    await Promise.resolve();
    expect(window.lastCloseEvent.prevented).toBe(false);
    expect(window.calls).not.toContain('hide');
  });

  it('dispose 解绑并销毁托盘', async () => {
    const { service, tray, window } = makeContext();
    await service.init();
    await service.dispose();
    expect(tray.items).toHaveLength(0);
    // 解绑后关闭不再拦截
    window.triggerCloseRequest();
    await Promise.resolve();
    expect(window.lastCloseEvent.prevented).toBe(false);
  });
});
