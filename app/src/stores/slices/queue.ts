/**
 * queue 域切片：双区队列（接下来播放/当前上下文）+ 播放模式 + 随机稳定序列
 * （UI-D43/D44），镜像 QueueController 快照。
 */
import { create } from 'zustand';
import type { PlayMode, QueueItem } from '../../domains/player/types';

export interface QueueSlice {
  upNext: QueueItem[];
  context: QueueItem[];
  contextId: string | null;
  mode: PlayMode;
  history: string[];
  shuffle: string[];
  shuffleIndex: number;

  setFromController(snapshot: {
    upNext: QueueItem[];
    context: QueueItem[];
    contextId: string | null;
    mode: PlayMode;
    history: string[];
    shuffle: string[];
    shuffleIndex: number;
  }): void;
}

export const createQueueSlice = (
  set: (partial: Partial<QueueSlice> | ((state: QueueSlice) => Partial<QueueSlice>)) => void,
): QueueSlice => ({
  upNext: [],
  context: [],
  contextId: null,
  mode: 'sequence',
  history: [],
  shuffle: [],
  shuffleIndex: -1,

  setFromController: (snapshot) =>
    set(() => ({
      upNext: snapshot.upNext,
      context: snapshot.context,
      contextId: snapshot.contextId,
      mode: snapshot.mode,
      history: snapshot.history,
      shuffle: snapshot.shuffle,
      shuffleIndex: snapshot.shuffleIndex,
    })),
});

export const useQueueStore = create<QueueSlice>()((set) => createQueueSlice(set));
