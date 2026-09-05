/**
 * dsp 域切片：音效工作台状态（DspService 快照镜像，跨模式全局 UI-D1）。
 */
import { create } from 'zustand';
import type { DspSnapshot } from '../../domains/dsp/DspService';

export interface DspSlice {
  sceneId: string | null;
  sceneName: string | null;
  customized: boolean;
  bypassed: boolean;
  activeSlot: 'a' | 'b' | null;

  setFromService(snapshot: DspSnapshot): void;
}

export const createDspSlice = (
  set: (partial: Partial<DspSlice> | ((state: DspSlice) => Partial<DspSlice>)) => void,
): DspSlice => ({
  sceneId: null,
  sceneName: null,
  customized: false,
  bypassed: false,
  activeSlot: null,

  setFromService: (snapshot) =>
    set(() => ({
      sceneId: snapshot.sceneId,
      sceneName: snapshot.sceneName,
      customized: snapshot.customized,
      bypassed: snapshot.bypassed,
      activeSlot: snapshot.activeSlot,
    })),
});

export const useDspStore = create<DspSlice>()((set) => createDspSlice(set));
