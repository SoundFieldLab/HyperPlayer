import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DspPage, OnboardingPage, SettingsPage, StatusCenterPage } from './pages';
import type { DspSnapshot } from '../../domains/dsp/DspService';
import type { AppSettings } from '../../services/SettingsService';
import { createFakeServices, renderWithServices } from '../../../tests/ui/test-utils';
import { createDefaultSettings } from '../../services/SettingsService';
import { useTasksStore } from '../../stores/slices/tasks';
import { useAppStore } from '../../stores/store';

function dspServices() {
  const snapshot = { sceneId: null, sceneName: null, customized: false, bypassed: false, params: {} as DspSnapshot['params'], ab: { a: null, b: null }, activeSlot: null } as DspSnapshot;
  return createFakeServices({ dsp: { snapshot, listScenes: vi.fn(() => [{ id: 'flat', name: 'Flat', description: 'Neutral', builtin: true }]), setScene: vi.fn().mockResolvedValue(undefined), bypass: vi.fn().mockResolvedValue(undefined), restore: vi.fn().mockResolvedValue(undefined), saveToA: vi.fn().mockResolvedValue(undefined), saveToB: vi.fn().mockResolvedValue(undefined), loadFromA: vi.fn().mockResolvedValue(undefined), loadFromB: vi.fn().mockResolvedValue(undefined), encodeShare: vi.fn(() => 'share-code'), applyShare: vi.fn().mockResolvedValue(true) } as never });
}

describe('system pages', () => {
  it('controls DSP through the real service contract', async () => {
    const services = dspServices();
    renderWithServices(<DspPage />, services);
    fireEvent.click(screen.getByRole('button', { name: 'FlatNeutral' }));
    await waitFor(() => expect(services.dsp.setScene).toHaveBeenCalledWith('flat'));
    fireEvent.click(screen.getByRole('button', { name: '旁路 DSP' }));
    await waitFor(() => expect(services.dsp.bypass).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '保存 A' }));
    await waitFor(() => expect(services.dsp.saveToA).toHaveBeenCalled());
  });

  it('persists settings and delegates autostart to its service', async () => {
    const baseSettings = { ...createDefaultSettings(), theme: 'system' as const };
    const updatedSettings = { ...baseSettings, theme: 'dark' as const };
    const services = createFakeServices({ settings: { snapshot: baseSettings, load: vi.fn().mockResolvedValue(baseSettings), update: vi.fn().mockResolvedValue(updatedSettings), subscribe: vi.fn(() => () => {}) } as never, autostart: { setAutostart: vi.fn().mockResolvedValue(true) } as never, shortcut: { getSnapshot: vi.fn(() => ({ bindings: {}, conflicts: [] })) } as never });
    renderWithServices(<SettingsPage />, services);
    fireEvent.change(screen.getByRole('combobox', { name: '主题' }), { target: { value: 'dark' } });
    await waitFor(() => expect(services.settings.update).toHaveBeenCalledWith({ theme: 'dark' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '开机自启' }));
    await waitFor(() => expect(services.autostart.setAutostart).toHaveBeenCalledWith(true));
    expect(screen.getByRole('checkbox', { name: '启动后继续播放' })).toBeDisabled();
    expect(screen.getByText(/没有正常退出标记/)).toBeInTheDocument();
  });

  it('shows service tasks and dispatches declared actions to real services', async () => {
    const task = { id: 'scan:library', kind: 'scan' as const, title: '扫描曲库', state: 'running' as const, progress: 0.5, detail: '读取中', actions: ['pause' as const, 'cancel' as const, 'view' as const], updatedAt: 1 };
    const services = createFakeServices({ taskCenter: { list: vi.fn(() => [task]), subscribe: vi.fn(() => () => {}) } as never, scanMachine: { pause: vi.fn(), cancel: vi.fn() } as never, diagnostics: { exportDiagnostics: vi.fn().mockResolvedValue('C:/diagnostics.json') } as never, updater: { checkUpdate: vi.fn().mockResolvedValue(null) } as never });
    useTasksStore.setState({ tasks: [task] });
    renderWithServices(<StatusCenterPage />, services);
    expect(screen.getByText('扫描曲库')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暂停扫描曲库' }));
    expect(services.scanMachine.pause).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '取消扫描曲库' }));
    expect(services.scanMachine.cancel).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '导出诊断包' }));
    await waitFor(() => expect(services.diagnostics.exportDiagnostics).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    await waitFor(() => expect(services.updater.checkUpdate).toHaveBeenCalled());
  });

  it('retries paused scans and navigates view actions', async () => {
    const navigate = vi.fn();
    useAppStore.setState({ navigate });
    const task = { id: 'scan:library', kind: 'scan' as const, title: '扫描曲库', state: 'paused' as const, progress: 0.5, actions: ['retry' as const, 'view' as const], updatedAt: 1 };
    const services = createFakeServices({ scanMachine: { resume: vi.fn().mockResolvedValue(undefined) } as never, diagnostics: { exportDiagnostics: vi.fn() } as never, updater: { checkUpdate: vi.fn() } as never });
    useTasksStore.setState({ tasks: [task] });
    renderWithServices(<StatusCenterPage />, services);
    fireEvent.click(screen.getByRole('button', { name: '重试扫描曲库' }));
    await waitFor(() => expect(services.scanMachine.resume).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '查看扫描曲库' }));
    expect(navigate).toHaveBeenCalledWith('local', { routeId: 'local-folders' });
  });

  it('uses cloud sync and a real folder picker in onboarding', async () => {
    const baseSettings = { ...createDefaultSettings(), onboarding: { started: false, completedSteps: [], completedAt: null } } as AppSettings;
    const services = createFakeServices({ settings: { snapshot: baseSettings, load: vi.fn().mockResolvedValue(baseSettings), update: vi.fn().mockImplementation(async (patch) => ({ ...baseSettings, ...patch })), subscribe: vi.fn(() => () => {}) } as never, dialog: { pickDirectory: vi.fn().mockResolvedValue('D:/Music') } as never, scanMachine: { scan: vi.fn().mockResolvedValue(undefined) } as never, cloudPlaylistSync: { syncAll: vi.fn().mockResolvedValue({ playlists: 2, tracks: 10 }) } as never });
    renderWithServices(<OnboardingPage />, services);
    fireEvent.click(screen.getByRole('button', { name: '选择并扫描' }));
    await waitFor(() => expect(services.scanMachine.scan).toHaveBeenCalledWith(['D:/Music']));
    fireEvent.click(screen.getByRole('button', { name: '同步云歌单' }));
    await waitFor(() => expect(services.cloudPlaylistSync.syncAll).toHaveBeenCalled());
  });
});
