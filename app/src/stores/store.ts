/**
 * 应用 store 组合：按域拆分的 zustand 切片（架构基线.md §2：一域一文件）。
 * 本文件只做切片装配；各域字段与 actions 见 slices/*。
 */
import { create } from 'zustand';
import { createPlaybackSlice } from './slices/playback';
import type { PlaybackSlice } from './slices/playback';
import { createQueueSlice } from './slices/queue';
import type { QueueSlice } from './slices/queue';
import { createSettingsSlice } from './slices/settings';
import type { SettingsSlice } from './slices/settings';
import { createNeteaseSlice } from './slices/netease';
import type { NeteaseSlice } from './slices/netease';

export interface AppStore extends PlaybackSlice, QueueSlice, SettingsSlice, NeteaseSlice {}

export const useAppStore = create<AppStore>()((set) => ({
  ...createPlaybackSlice(set),
  ...createQueueSlice(set),
  ...createSettingsSlice(set),
  ...createNeteaseSlice(set),
}));
