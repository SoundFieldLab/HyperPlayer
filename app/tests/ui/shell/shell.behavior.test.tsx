import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../../src/shell/AppShell';
import { useAppStore } from '../../../src/stores/store';
import { useSessionStore } from '../../../src/stores/slices/session';
import { createFakeServices, renderWithServices } from '../test-utils';

const track = {
  id: 'track-1', title: '测试歌曲', artist: '测试歌手', source: 'local' as const,
  entitlement: 'free' as const, cacheStatus: 'none' as const,
};

const shellServices = () => createFakeServices({
  netease: { route: vi.fn().mockResolvedValue({ body: { result: [], songs: [], list: [] } }) } as never,
  library: { queryTracks: vi.fn().mockResolvedValue([]) } as never,
});

describe('AppShell behavior', () => {
  it('switches content domains with left and right arrows without changing while editing', async () => {
    useAppStore.setState({ activeDomain: 'netease', currentEntry: null, overlay: { kind: 'none' } });
    const services = shellServices();
    renderWithServices(<AppShell />, services);

    await waitFor(() => expect(document.querySelector('[data-tauri-drag-region]')).toBeTruthy());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await waitFor(() => expect(useAppStore.getState().activeDomain).toBe('local'));
    const input = screen.getByRole('button', { name: '打开命令面板' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(useAppStore.getState().activeDomain).toBe('netease');
  });

  it('marks the titlebar as a drag region and toggles between fixed themes once', async () => {
    const update = vi.fn().mockResolvedValue({});
    const services = createFakeServices({ settings: { update } as never });
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, theme: 'system' } });
    renderWithServices(<AppShell />, services);

    expect(document.querySelector('[data-tauri-drag-region]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '切换深色主题' }));
    expect(update).toHaveBeenCalledWith({ theme: 'dark' });
  });
});

describe('CapsuleDock queue entry', () => {
  it('shows the real queue count and opens the player layer', () => {
    useAppStore.setState({
      track, upNext: [track, { ...track, id: 'track-2', title: '下一首' }], context: [track],
      overlay: { kind: 'none' },
    });
    const services = shellServices();
    renderWithServices(<AppShell />, services);

    const queueButton = screen.getByRole('button', { name: '打开播放队列，接下来 2 首' });
    expect(queueButton).toHaveTextContent('3');
    fireEvent.click(queueButton);
    expect(useAppStore.getState().overlay).toEqual({ kind: 'modal', id: 'player-layer' });
  });
});

describe('CommandPanel behavior', () => {
  it('closes the active overlay on Escape and executes a filtered command', async () => {
    useAppStore.setState({ overlay: { kind: 'modal', id: 'command-panel' }, activeDomain: 'netease' });
    const services = shellServices();
    renderWithServices(<AppShell />, services);

    const input = screen.getByRole('textbox', { name: '搜索或输入命令' });
    fireEvent.change(input, { target: { value: '本地' } });
    await waitFor(() => expect(screen.getByText('切换到本地曲库')).toBeInTheDocument());
    fireEvent.click(screen.getByText('切换到本地曲库'));
    expect(useAppStore.getState().activeDomain).toBe('local');
    expect(useAppStore.getState().overlay).toEqual({ kind: 'none' });

    useAppStore.setState({ overlay: { kind: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: '打开命令面板' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => expect(useAppStore.getState().overlay).toEqual({ kind: 'none' }));
  });

  it('supports arrows, Enter, command prefix, and restores focus when closed', async () => {
    useAppStore.setState({ overlay: { kind: 'none' }, activeDomain: 'netease' });
    const services = shellServices();
    renderWithServices(<AppShell />, services);
    const opener = screen.getByRole('button', { name: '打开命令面板' });
    opener.focus();
    fireEvent.click(opener);

    const input = screen.getByRole('textbox', { name: '搜索或输入命令' });
    fireEvent.change(input, { target: { value: '>' } });
    expect(screen.getByRole('option', { name: /搜索音乐/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useAppStore.getState().activeDomain).toBe('local');
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('waits for output switching, updates only on success, and exposes failures as notices', async () => {
    let resolveSink!: (changed: boolean) => void;
    const setSinkId = vi.fn(() => new Promise<boolean>((resolve) => { resolveSink = resolve; }));
    const services = createFakeServices({ audio: { listOutputDevices: vi.fn().mockResolvedValue([{ deviceId: 'speaker-1', label: '扬声器' }]), setOutputVolume: vi.fn(), setSinkId } as never });
    useAppStore.setState({ outputDevice: null });
    useSessionStore.setState({ notice: null });
    renderWithServices(<AppShell />, services);

    fireEvent.click(screen.getByRole('button', { name: '音量' }));
    const select = await screen.findByRole('combobox', { name: '输出设备' });
    fireEvent.change(select, { target: { value: 'speaker-1' } });
    expect(useAppStore.getState().outputDevice).toBeNull();
    resolveSink(true);
    await waitFor(() => expect(useAppStore.getState().outputDevice).toBe('speaker-1'));

    setSinkId.mockImplementationOnce(async () => {
      useSessionStore.getState().setSessionNotice('切换输出设备失败，已回退原设备：device unavailable');
      return false;
    });
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('切换输出设备失败'));
    expect(useAppStore.getState().outputDevice).toBe('speaker-1');
    fireEvent.click(screen.getByRole('button', { name: '清除通知' }));
    expect(useSessionStore.getState().notice).toBeNull();
  });

  it('shows close confirmation with minimize, quit, and remembered choice actions', async () => {
    const update = vi.fn().mockResolvedValue({});
    const trayWindow = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
    const services = createFakeServices({ settings: { update } as never, trayWindow: trayWindow as never });
    useAppStore.setState({ overlay: { kind: 'modal', id: 'close-confirmation' } });
    renderWithServices(<AppShell />, services);

    expect(screen.getByRole('dialog', { name: '关闭 HyperPlayer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '记住我的选择' }));
    fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ closeBehavior: 'minimize' }));
    expect(trayWindow.hide).toHaveBeenCalledTimes(1);

    useAppStore.setState({ overlay: { kind: 'modal', id: 'close-confirmation' } });
    fireEvent.click(await screen.findByRole('button', { name: '完全退出' }));
    await waitFor(() => expect(trayWindow.destroy).toHaveBeenCalledTimes(1));
  });
});
