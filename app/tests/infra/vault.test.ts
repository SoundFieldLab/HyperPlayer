import { describe, expect, it, vi } from 'vitest';
import { createVault } from '../../src/infra/vault';
import type { VaultRuntime } from '../../src/infra/vault';

function makeRuntime(loadClient: ReturnType<typeof vi.fn>) {
  const records = new Map<string, number[]>();
  const store = {
    get: vi.fn(async (key: string) => records.has(key) ? Uint8Array.from(records.get(key) ?? []) : null),
    insert: vi.fn(async (key: string, value: number[]) => { records.set(key, value); }),
    remove: vi.fn(async (key: string) => records.delete(key) ? new Uint8Array() : null),
  };
  const client = { getStore: () => store };
  const stronghold = {
    loadClient,
    createClient: vi.fn(async () => client),
    save: vi.fn(async () => {}),
  };
  const runtime = { load: vi.fn(async () => stronghold) } as unknown as VaultRuntime;
  return { runtime, stronghold, store, client };
}

describe('createVault', () => {
  it('首次启动在 client 不存在时创建并保存', async () => {
    const harness = makeRuntime(vi.fn(async () => { throw new Error('client missing'); }));
    await createVault({ path: 'vault.hold', password: 'secret' }, harness.runtime);
    expect(harness.stronghold.createClient).toHaveBeenCalledWith('hyperplayer');
    expect(harness.stronghold.save).toHaveBeenCalledOnce();
  });

  it('已有 client 时直接加载，并在写删后持久化 snapshot', async () => {
    const harness = makeRuntime(vi.fn(async () => harness.client));
    const vault = await createVault({ path: 'vault.hold', password: 'secret' }, harness.runtime);
    await vault.setSecret('netease', 'cookie', 'value');
    expect(await vault.getSecret('netease', 'cookie')).toBe('value');
    await vault.deleteSecret('netease', 'cookie');
    expect(harness.stronghold.createClient).not.toHaveBeenCalled();
    expect(harness.stronghold.save).toHaveBeenCalledTimes(2);
  });
});
