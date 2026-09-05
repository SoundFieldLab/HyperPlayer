/**
 * infra tauriStore —— tauri-plugin-store 薄封装（设置/偏好/队列持久化，JSON）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { Store } from '@tauri-apps/plugin-store';

export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 创建真实 store 实例（tauri 运行时）。 */
export async function createTauriStore(path: string): Promise<KeyValueStore> {
  const store = await Store.load(path);
  return {
    get: async <T>(key: string): Promise<T | null> => (await store.get<T>(key)) ?? null,
    set: async <T>(key: string, value: T): Promise<void> => {
      await store.set(key, value);
      await store.save();
    },
    delete: async (key: string): Promise<void> => {
      await store.delete(key);
      await store.save();
    },
    keys: async (): Promise<string[]> => Array.from(await store.keys()),
  };
}
