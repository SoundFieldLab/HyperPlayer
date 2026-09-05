/**
 * infra autostart —— @tauri-apps/plugin-autostart 薄封装（后端补充规划 #39）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { isEnabled, enable, disable } from '@tauri-apps/plugin-autostart';

export interface Autostart {
  isEnabled(): Promise<boolean>;
  /** 启用开机自启；失败返回 false（不抛）。 */
  enable(): Promise<boolean>;
  /** 停用开机自启；失败返回 false（不抛）。 */
  disable(): Promise<boolean>;
}

export function createTauriAutostart(): Autostart {
  return {
    isEnabled: async () => {
      try {
        return await isEnabled();
      } catch {
        return false;
      }
    },
    enable: async () => {
      try {
        await enable();
        return true;
      } catch {
        return false;
      }
    },
    disable: async () => {
      try {
        await disable();
        return true;
      } catch {
        return false;
      }
    },
  };
}
