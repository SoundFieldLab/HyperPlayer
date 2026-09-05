/**
 * netease 域切片（骨架，P4 由 NeteaseService/SessionService 写入）。
 * 字段对齐页面需求：账号页 QR 登录态、登录后资料/VIP/等级、pendingAction
 * （UI-D31/32：登录成功后恢复原页面与待执行动作）。
 */
import { create } from 'zustand';

export type SessionState = 'anonymous' | 'qrWaiting' | 'qrScanned' | 'loggedIn';

export interface NeteaseProfile {
  userId: number;
  nickname: string;
  avatarUrl?: string;
  level?: number;
  vipLevel?: number;
}

export interface NeteaseSlice {
  sessionState: SessionState;
  profile: NeteaseProfile | null;
  /** 受限动作触发的登录：登录成功后待恢复的动作（UI-D31）。 */
  pendingAction: { kind: string; payload?: unknown } | null;

  setSessionState(state: SessionState): void;
  setProfile(profile: NeteaseProfile | null): void;
  setPendingAction(action: { kind: string; payload?: unknown } | null): void;
}

export const createNeteaseSlice = (
  set: (partial: Partial<NeteaseSlice> | ((state: NeteaseSlice) => Partial<NeteaseSlice>)) => void,
): NeteaseSlice => ({
  sessionState: 'anonymous',
  profile: null,
  pendingAction: null,

  setSessionState: (sessionState) => set(() => ({ sessionState })),
  setProfile: (profile) => set(() => ({ profile })),
  setPendingAction: (pendingAction) => set(() => ({ pendingAction })),
});

export const useNeteaseStore = create<NeteaseSlice>()((set) => createNeteaseSlice(set));
