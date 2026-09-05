/**
 * infra vault —— tauri-plugin-stronghold 薄封装（网易云凭据/Cookie 加密存储）。
 * 凭据只在 stronghold；UI 永不显示/编辑原始 Cookie（UI-D32/播放器架构.md §3.3）。
 *
 * 真实接线：Stronghold.load(path, password) → client store（get/insert/remove）。
 * 密码来源（M5 初始化向导前）：由调用方传入（wiring 使用 dev 默认密码并在
 * docs/架构基线.md 登记降级；M5 向导接入用户密码后移除）。
 */
import { Stronghold } from '@tauri-apps/plugin-stronghold';

export interface Vault {
  getSecret(namespace: string, key: string): Promise<string | null>;
  setSecret(namespace: string, key: string, value: string): Promise<void>;
  deleteSecret(namespace: string, key: string): Promise<void>;
}

export interface VaultOptions {
  /** stronghold 文件路径（app 配置目录下）。 */
  path: string;
  /** 解锁密码（M5 向导前使用登记过的 dev 默认值）。 */
  password: string;
}

/** 创建 stronghold vault 实例（真实加密存储）。 */
export async function createVault(options: VaultOptions): Promise<Vault> {
  const stronghold = await Stronghold.load(options.path, options.password);
  const client = await stronghold.loadClient('hyperplayer');
  const store = client.getStore();
  const encode = (value: string): number[] => Array.from(new TextEncoder().encode(value));
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  return {
    getSecret: async (namespace, key) => {
      const bytes = await store.get(`${namespace}:${key}`);
      return bytes ? decode(bytes) : null;
    },
    setSecret: async (namespace, key, value) => {
      await store.insert(`${namespace}:${key}`, encode(value));
    },
    deleteSecret: async (namespace, key) => {
      await store.remove(`${namespace}:${key}`);
    },
  };
}
