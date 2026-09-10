import { create } from 'zustand';
import type { SessionState } from '../../domains/netease/SessionService';

export interface SessionSlice {
  sessionState: SessionState;
  notice: string | null;
  setSessionState(state: SessionState): void;
  setSessionNotice(notice: string | null): void;
}

export const createSessionSlice = (
  set: (partial: Partial<SessionSlice> | ((state: SessionSlice) => Partial<SessionSlice>)) => void,
): SessionSlice => ({
  sessionState: 'anonymous',
  notice: null,
  setSessionState: (sessionState) => set(() => ({ sessionState })),
  setSessionNotice: (notice) => set(() => ({ notice })),
});

export const useSessionStore = create<SessionSlice>()((set) => createSessionSlice(set));
