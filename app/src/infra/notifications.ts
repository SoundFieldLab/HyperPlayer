/**
 * infra notifications —— @tauri-apps/plugin-notification 薄封装（后端补充规划 #43）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

export interface Notifications {
  /** 系统是否支持通知（不支持时静默跳过）。 */
  isSupported(): Promise<boolean>;
  /** 权限守卫：未授权时请求；返回是否可用。 */
  ensurePermission(): Promise<boolean>;
  send(title: string, body?: string): Promise<void>;
}

export function createTauriNotifications(): Notifications {
  return {
    isSupported: async () => {
      try {
        // plugin-notification 无显式支持查询；调用失败即视为不支持
        await isPermissionGranted();
        return true;
      } catch {
        return false;
      }
    },
    ensurePermission: async () => {
      try {
        const granted = await isPermissionGranted();
        if (granted) return true;
        return (await requestPermission()) === 'granted';
      } catch {
        return false;
      }
    },
    send: async (title, body) => {
      sendNotification({ title, body });
    },
  };
}
