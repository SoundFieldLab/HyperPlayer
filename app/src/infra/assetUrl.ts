/**
 * infra assetUrl —— Tauri asset 协议 URL 转换（LocalFileSource 用）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { convertFileSrc } from '@tauri-apps/api/core';

/** 本地/缓存文件 → asset 协议 URL（需在 tauri.conf assetProtocol scope 声明）。 */
export function toAssetUrl(path: string): string {
  return convertFileSrc(path);
}
