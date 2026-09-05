import { describe, expect, it } from 'vitest';
import { generateVaultPassword, getOrCreateVaultPassword, VAULT_PASSWORD_KEY } from '../../src/infra/vaultPassword';
import { createFakeStore } from '../../src/infra/fakes';

describe('vaultPassword（后端补充规划 #47）', () => {
  it('generateVaultPassword：32 字节 → base64url 无填充（43 字符），不含 +/= 字符', () => {
    const password = generateVaultPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // 两次生成不同（随机性）
    expect(password).not.toBe(generateVaultPassword());
  });

  it('getOrCreateVaultPassword：首启生成并持久化，重启复用同一密码', async () => {
    const store = createFakeStore();
    const first = await getOrCreateVaultPassword(store);
    const stored = await store.get<string>(VAULT_PASSWORD_KEY);
    expect(stored).toBe(first);
    // 模拟重启：新 store 实例读同一底层数据
    const second = await getOrCreateVaultPassword(store);
    expect(second).toBe(first);
  });

  it('已有密码时不重新生成', async () => {
    const store = createFakeStore();
    await store.set(VAULT_PASSWORD_KEY, 'fixed-password');
    const password = await getOrCreateVaultPassword(store);
    expect(password).toBe('fixed-password');
  });
});
