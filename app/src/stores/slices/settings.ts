/**
 * settings 域切片：镜像 SettingsService 快照，供设置页/初始化向导/状态中心订阅。
 */
import { create } from 'zustand';
import type { AppSettings } from '../../services/SettingsService';
import { createDefaultSettings } from '../../services/SettingsService';

export interface SettingsSlice {
  settings: AppSettings;
  /** 由 wiring 在 SettingsService 变更时调用（镜像快照）。 */
  setSettings(settings: AppSettings): void;
}

export const createSettingsSlice = (
  set: (partial: Partial<SettingsSlice> | ((state: SettingsSlice) => Partial<SettingsSlice>)) => void,
): SettingsSlice => ({
  settings: createDefaultSettings(),
  setSettings: (settings) => set(() => ({ settings })),
});

export const useSettingsStore = create<SettingsSlice>()((set) => createSettingsSlice(set));
