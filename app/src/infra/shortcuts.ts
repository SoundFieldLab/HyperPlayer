/**
 * infra shortcuts —— @tauri-apps/plugin-global-shortcut 薄封装（后端补充规划 #7/#8）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { register, unregister, unregisterAll, isRegistered } from '@tauri-apps/plugin-global-shortcut';

export interface ShortcutEvent {
  shortcut: string;
  state: 'Released' | 'Pressed';
}

export interface Shortcuts {
  /** 注册全局快捷键；已被占用/非法组合返回 false（不抛）。 */
  register(shortcut: string, handler: (event: ShortcutEvent) => void): Promise<boolean>;
  unregister(shortcut: string): Promise<void>;
  unregisterAll(): Promise<void>;
  isRegistered(shortcut: string): Promise<boolean>;
}

export function createTauriShortcuts(): Shortcuts {
  return {
    register: async (shortcut, handler) => {
      try {
        await register(shortcut, (event) => handler(event));
        return true;
      } catch {
        return false;
      }
    },
    unregister: async (shortcut) => {
      try {
        await unregister(shortcut);
      } catch {
        // 卸载失败不致命（可能已被系统释放）
      }
    },
    unregisterAll: async () => {
      try {
        await unregisterAll();
      } catch {
        // 同上
      }
    },
    isRegistered: async (shortcut) => {
      try {
        return await isRegistered(shortcut);
      } catch {
        return false;
      }
    },
  };
}
