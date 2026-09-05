import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ShortcutService, DEFAULT_SHORTCUTS } from '../../src/services/ShortcutService';
import { SettingsService } from '../../src/services/SettingsService';
import { createFakeStore, createFakeShortcuts } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

function makeContext() {
  const store = createFakeStore();
  const settings = new SettingsService({ store, logger: createNullLogger() });
  const shortcuts = createFakeShortcuts();
  const commands = {
    playPause: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
  };
  const service = new ShortcutService({ shortcuts, settings, commands, logger: createNullLogger() });
  return { store, settings, shortcuts, commands, service };
}

describe('ShortcutService（后端补充规划 #7/#8）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('init 注册默认媒体键绑定（SMTC 缺席回退）', async () => {
    const { service, shortcuts } = makeContext();
    await service.init();
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.playPause)).toBe(true);
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.next)).toBe(true);
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.prev)).toBe(true);
    expect(service.getSnapshot().conflicts).toEqual([]);
  });

  it('触发 Pressed 执行对应命令；Released 不触发', async () => {
    const { service, shortcuts, commands } = makeContext();
    await service.init();
    shortcuts.trigger(DEFAULT_SHORTCUTS.playPause, 'Pressed');
    shortcuts.trigger(DEFAULT_SHORTCUTS.playPause, 'Released');
    shortcuts.trigger(DEFAULT_SHORTCUTS.next, 'Pressed');
    shortcuts.trigger(DEFAULT_SHORTCUTS.prev, 'Pressed');
    expect(commands.playPause).toHaveBeenCalledTimes(1);
    expect(commands.next).toHaveBeenCalledTimes(1);
    expect(commands.prev).toHaveBeenCalledTimes(1);
  });

  it('settings 覆盖后 rebind：新键生效、旧键卸载', async () => {
    const { service, settings, shortcuts, commands } = makeContext();
    await service.init();
    await settings.update({ shortcuts: { playPause: 'MediaStop' } });
    await service.rebind();
    expect(await shortcuts.isRegistered('MediaStop')).toBe(true);
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.playPause)).toBe(false);
    shortcuts.trigger('MediaStop', 'Pressed');
    expect(commands.playPause).toHaveBeenCalledTimes(1);
  });

  it('空串覆盖 = 禁用该动作', async () => {
    const { service, settings, shortcuts } = makeContext();
    await service.init();
    await settings.update({ shortcuts: { next: '' } });
    await service.rebind();
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.next)).toBe(false);
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.playPause)).toBe(true);
  });

  it('应用内同键多动作 → conflicts 记录，仅首个注册', async () => {
    const { service, settings, shortcuts } = makeContext();
    await service.init();
    await settings.update({ shortcuts: { playPause: 'MediaStop', next: 'MediaStop' } });
    await service.rebind();
    const snapshot = service.getSnapshot();
    expect(snapshot.conflicts).toContain('MediaStop');
    // MediaStop 注册成功一次；MediaPlayPause 被覆盖卸载
    expect(await shortcuts.isRegistered('MediaStop')).toBe(true);
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.playPause)).toBe(false);
  });

  it('系统占用（注册失败）→ conflicts 记录并跳过', async () => {
    const { service, shortcuts } = makeContext();
    // 预占用 MediaTrackNext（模拟其他应用已注册）
    await shortcuts.register(DEFAULT_SHORTCUTS.next, () => {});
    await service.init();
    const snapshot = service.getSnapshot();
    expect(snapshot.conflicts).toContain(DEFAULT_SHORTCUTS.next);
    expect(snapshot.bindings.next).toBeUndefined();
    expect(snapshot.bindings.playPause).toBe(DEFAULT_SHORTCUTS.playPause);
  });

  it('绑定未变更时 rebind 跳过重注册（设置高频更新不空转 IPC）', async () => {
    const raw = createFakeShortcuts();
    let registerCalls = 0;
    const shortcuts = {
      ...raw,
      register: async (shortcut: string, handler: (e: { shortcut: string; state: 'Released' | 'Pressed' }) => void) => {
        registerCalls += 1;
        return raw.register(shortcut, handler);
      },
    };
    const store = createFakeStore();
    const settings = new SettingsService({ store, logger: createNullLogger() });
    const service = new ShortcutService({ shortcuts, settings, commands: { playPause: vi.fn(), next: vi.fn(), prev: vi.fn() }, logger: createNullLogger() });
    await service.init();
    const initial = registerCalls;
    expect(initial).toBe(3);
    await service.rebind(); // 设置未变
    expect(registerCalls).toBe(initial);
    await settings.update({ volume: 0.5 }); // 无关设置变更
    await service.rebind();
    expect(registerCalls).toBe(initial);
  });

  it('dispose 卸载全部绑定', async () => {
    const { service, shortcuts } = makeContext();
    await service.init();
    await service.dispose();
    expect(await shortcuts.isRegistered(DEFAULT_SHORTCUTS.playPause)).toBe(false);
    expect(service.getSnapshot().bindings).toEqual({});
  });
});
