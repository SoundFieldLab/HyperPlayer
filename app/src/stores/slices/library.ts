/**
 * library 域切片：扫描状态（ScanMachine 镜像，UI-D29 状态中心）+ 曲库文件夹。
 */
import { create } from 'zustand';
import type { ScanState } from '../../domains/library/ScanMachine';

export interface LibrarySlice {
  scanState: ScanState;
  folders: string[];
  trackCount: number;

  setScanState(state: ScanState): void;
  setFolders(folders: string[]): void;
  setTrackCount(count: number): void;
}

const idleScanState: ScanState = {
  phase: 'idle',
  folders: [],
  currentFolder: null,
  processedFolders: 0,
  totalFolders: 0,
  filesScanned: 0,
  added: 0,
  updated: 0,
  failed: 0,
};

export const createLibrarySlice = (
  set: (partial: Partial<LibrarySlice> | ((state: LibrarySlice) => Partial<LibrarySlice>)) => void,
): LibrarySlice => ({
  scanState: idleScanState,
  folders: [],
  trackCount: 0,

  setScanState: (scanState) => set(() => ({ scanState })),
  setFolders: (folders) => set(() => ({ folders })),
  setTrackCount: (trackCount) => set(() => ({ trackCount })),
});

export const useLibraryStore = create<LibrarySlice>()((set) => createLibrarySlice(set));
