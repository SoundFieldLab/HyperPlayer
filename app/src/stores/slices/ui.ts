import { create } from 'zustand';

export type OverlayState =
  | { kind: 'none' }
  | { kind: 'modal'; id: string; payload?: unknown }
  | { kind: 'drawer'; id: string; payload?: unknown }
  | { kind: 'popover'; id: string; payload?: unknown };

export interface UiSlice {
  overlay: OverlayState;
  setOverlay(overlay: OverlayState): void;
  clearOverlay(): void;
}

type Set = (
  partial: Partial<UiSlice> | ((state: UiSlice) => Partial<UiSlice>),
) => void;

export const createUiSlice = (set: Set): UiSlice => ({
  overlay: { kind: 'none' },
  setOverlay: (overlay) => set(() => ({ overlay })),
  clearOverlay: () => set(() => ({ overlay: { kind: 'none' } })),
});

export const useUiStore = create<UiSlice>()((set) => createUiSlice(set));
