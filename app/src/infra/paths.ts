/**
 * infra paths —— Tauri 路径 API 薄封装（app 配置目录下路径）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { appDataDir, join } from '@tauri-apps/api/path';

/** app 配置目录下拼接路径（如 hyperplayer.stronghold / stream-cache）。 */
export async function appDataPath(...segments: string[]): Promise<string> {
  return join(await appDataDir(), ...segments);
}
