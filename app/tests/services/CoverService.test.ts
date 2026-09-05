import { describe, expect, it } from 'vitest';
import { CoverService, albumKeyFor, sha256Hex } from '../../src/services/CoverService';
import { createFakeFs, createFakeSql } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

function makeService() {
  const fs = createFakeFs();
  const sql = createFakeSql();
  const service = new CoverService({ fs, sql, coversDir: '/app-data/covers', logger: createNullLogger() });
  return { fs, sql, service };
}

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

describe('CoverService（后端补充规划 #23）', () => {
  it('ensureCover：落盘 + 登记；同专辑键去重返回既有路径', async () => {
    const { fs, service } = makeService();
    await service.init();
    const first = await service.ensureCover('album|artist', PNG, 'image/png');
    expect(first).toMatch(/^\/app-data\/covers\/[a-f0-9]{64}\.png$/u);
    expect(await fs.exists(first!)).toBe(true);
    const second = await service.ensureCover('album|artist', PNG, 'image/png');
    expect(second).toBe(first); // 去重
    expect((await fs.readDir('/app-data/covers')).length).toBe(1);
  });

  it('不同专辑键 → 不同文件', async () => {
    const { fs, service } = makeService();
    await service.init();
    const a = await service.ensureCover('albumA|artistA', PNG, 'image/png');
    const b = await service.ensureCover('albumB|artistB', PNG, 'image/jpeg');
    expect(a).not.toBe(b);
    expect(a).toMatch(/\.png$/u);
    expect(b).toMatch(/\.jpg$/u);
    expect((await fs.readDir('/app-data/covers')).length).toBe(2);
  });

  it('getCoverPath：登记后可查回，未知键返回 null', async () => {
    const { service } = makeService();
    await service.init();
    expect(await service.getCoverPath('nope')).toBeNull();
    expect(await service.getCoverPath(null)).toBeNull();
    const path = await service.ensureCover('k|v', PNG, 'image/png');
    expect(await service.getCoverPath('k|v')).toBe(path);
  });

  it('albumKeyFor：规范化（trim + 小写），无专辑信息返回 null', () => {
    expect(albumKeyFor('  Album ', ' Artist ')).toBe('artist|album');
    expect(albumKeyFor('专辑名', null)).toBe('专辑名');
    expect(albumKeyFor(null, null)).toBeNull();
    expect(albumKeyFor('', '')).toBeNull();
  });

  it('sha256Hex：稳定且为 64 位十六进制', async () => {
    const hash = await sha256Hex('artist|album');
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await sha256Hex('artist|album')).toBe(hash);
  });
});
