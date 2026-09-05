/**
 * infra updater —— @tauri-apps/plugin-updater 薄封装（后端补充规划 #54）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { check } from '@tauri-apps/plugin-updater';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface AppUpdate {
  version: string;
  body?: string;
  downloadAndInstall(onProgress?: (progress: UpdateProgress) => void): Promise<void>;
}

export interface Updater {
  /** 检查更新；无可用更新返回 null；更新源未配置/网络失败抛错。 */
  check(): Promise<AppUpdate | null>;
}

export function createTauriUpdater(): Updater {
  return {
    check: async () => {
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        body: update.body,
        downloadAndInstall: async (onProgress) => {
          let downloaded = 0;
          let total: number | null = null;
          const handleEvent = (event: DownloadEvent): void => {
            if (event.event === 'Started') total = event.data.contentLength ?? null;
            else if (event.event === 'Progress') downloaded += event.data.chunkLength;
            else if (event.event === 'Finished') downloaded = total ?? downloaded;
            onProgress?.({ downloaded, total });
          };
          await update.downloadAndInstall(handleEvent);
        },
      };
    },
  };
}
