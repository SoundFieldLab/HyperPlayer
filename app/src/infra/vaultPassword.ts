/**
 * vaultPassword —— Stronghold 正式密码接入（后端补充规划 #47）。
 *
 * 首启生成随机强密码（32 字节 → base64url）存入 store（hyperplayer.json，
 * 与 settings 同文件），createVault 读取复用；移除 dev 默认密码
 * （hyperplayer-vault-default-password 两处登记：wiring.ts / lib.rs 均已清理）。
 * Rust 侧 lib.rs 用官方 Builder::with_argon2(salt) 派生密钥，零自定义逻辑。
 */
import type { KeyValueStore } from './tauriStore';

export const VAULT_PASSWORD_KEY = 'app.vaultPassword';

/** 生成 32 字节随机密码（base64url 无填充，43 字符）。 */
export function generateVaultPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

/** 取已存密码；首启生成并持久化（幂等，重启复用同一密码）。 */
export async function getOrCreateVaultPassword(store: KeyValueStore): Promise<string> {
  const existing = await store.get<string>(VAULT_PASSWORD_KEY);
  if (existing) return existing;
  const password = generateVaultPassword();
  await store.set(VAULT_PASSWORD_KEY, password);
  return password;
}
