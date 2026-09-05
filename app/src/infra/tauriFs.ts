/**
 * infra tauriFs —— tauri-plugin-fs 薄封装（字节读写/遍历/stat）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { exists, mkdir, readDir, readFile, remove, rename, stat, writeFile } from '@tauri-apps/plugin-fs';

export interface FsEntry {
  name: string;
  isDirectory: boolean;
}

export interface FsStat {
  size: number;
  /** 修改时间（ms）。 */
  modifiedMs: number;
}

export interface TauriFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** 分块追加（边播边缓存）。 */
  appendFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  readDir(path: string): Promise<FsEntry[]>;
  removeFile(path: string): Promise<void>;
  /** 重命名/移动（日志滚动用）。 */
  renameFile(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat | null>;
}

export function createTauriFs(): TauriFs {
  return {
    readFile: (path) => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
    appendFile: (path, data) => writeFile(path, data, { append: true }),
    mkdir: (path, recursive) => mkdir(path, { recursive: recursive ?? true }),
    readDir: async (path) => {
      const entries = await readDir(path);
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory ?? false }));
    },
    removeFile: (path) => remove(path),
    renameFile: (from, to) => rename(from, to),
    exists: (path) => exists(path),
    stat: async (path) => {
      const info = await stat(path);
      if (!info) return null;
      return { size: info.size, modifiedMs: info.mtime?.getTime() ?? Date.now() };
    },
  };
}
