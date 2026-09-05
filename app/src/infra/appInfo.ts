/**
 * infra appInfo —— @tauri-apps/api/app 薄封装（应用版本等）。
 * 所有原生能力经本层；失败降级 'unknown'，不阻塞业务。
 */
import { getVersion } from '@tauri-apps/api/app';

export async function getAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return 'unknown';
  }
}
