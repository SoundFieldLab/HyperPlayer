/**
 * playback 域切片（UI-D83：高频态帧级写入 + 消费端窄选择器）。
 * 组件只订阅所需单字段；position/currentWordIndex 由 rAF/LyricsTimeline 帧级更新。
 */
import { create } from 'zustand';
import type { PlaybackError, PlaybackStatus, QueueItem } from '../../domains/player/types';

export interface PlaybackSlice {
  status: PlaybackStatus;
  track: QueueItem | null;
  error: PlaybackError | null;
  /** 帧级播放位置（秒）。 */
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  /** UI-D45：单击图标在静音与最近非零音量间切换。 */
  lastNonZeroVolume: number;
  outputDevice: string | null;
  /** 逐字歌词当前索引（帧级，P2 由 LyricsTimeline 写入）。 */
  currentWordIndex: number;
  lyricMode: 'word' | 'line';

  setStatus(status: PlaybackStatus): void;
  setTrack(track: QueueItem | null): void;
  setError(error: PlaybackError | null): void;
  /** 窄 set：只更新 position（避免全树渲染）。 */
  setPosition(position: number): void;
  setDuration(duration: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setOutputDevice(deviceId: string | null): void;
  setCurrentWordIndex(index: number): void;
  setLyricMode(mode: 'word' | 'line'): void;
}

type Set = (partial: Partial<PlaybackSlice> | ((state: PlaybackSlice) => Partial<PlaybackSlice>)) => void;

export function createPlaybackSlice(set: Set): PlaybackSlice {
  return {
    status: 'idle',
    track: null,
    error: null,
    position: 0,
    duration: 0,
    volume: 1,
    muted: false,
    lastNonZeroVolume: 1,
    outputDevice: null,
    currentWordIndex: -1,
    lyricMode: 'line',

    setStatus: (status) => set(() => ({ status })),
    setTrack: (track) => set(() => ({ track })),
    setError: (error) => set(() => ({ error })),
    setPosition: (position) => set(() => ({ position })),
    setDuration: (duration) => set(() => ({ duration })),
    setVolume: (volume) =>
      set((s) => ({
        volume,
        muted: volume === 0,
        lastNonZeroVolume: volume > 0 ? volume : s.lastNonZeroVolume,
      })),
    setMuted: (muted) =>
      set((s) => ({
        muted,
        volume: muted ? 0 : s.lastNonZeroVolume || s.volume,
      })),
    setOutputDevice: (outputDevice) => set(() => ({ outputDevice })),
    setCurrentWordIndex: (currentWordIndex) => set(() => ({ currentWordIndex })),
    setLyricMode: (lyricMode) => set(() => ({ lyricMode })),
  };
}

export const usePlaybackStore = create<PlaybackSlice>()((set) => createPlaybackSlice(set));
