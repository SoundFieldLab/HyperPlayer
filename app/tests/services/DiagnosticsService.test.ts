import { describe, expect, it } from 'vitest';
import { DiagnosticsService } from '../../src/services/DiagnosticsService';
import { FileLogger } from '../../src/shared/fileLogger';
import { SettingsService } from '../../src/services/SettingsService';
import { createFakeStore, createFakeFs } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

describe('DiagnosticsService（后端补充规划 #46）', () => {
  it('导出诊断包：app 版本 + 设置快照 + 日志写入输出目录，返回路径', async () => {
    const fs = createFakeFs();
    const dir = '/app-data/diagnostics';
    const fileLogger = new FileLogger({ fs, dir: '/app-data/logs' });
    await fileLogger.init();
    fileLogger.info('测试日志', { userId: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = createFakeStore();
    const settings = new SettingsService({ store, logger: createNullLogger() });
    await settings.load();

    const service = new DiagnosticsService({ fs, logger: fileLogger, settings, dir, appVersion: '0.1.0', now: () => 42 });
    const path = await service.exportDiagnostics();

    expect(path).toBe(`${dir}/hyperplayer-diagnostics-42.json`);
    const bundle = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as {
      exportedAt: number;
      app: { version: string };
      settings: { schemaVersion: number };
      logs: Array<{ level: string; message: string }>;
    };
    expect(bundle.app.version).toBe('0.1.0');
    expect(bundle.settings.schemaVersion).toBe(4);
    expect(bundle.logs).toContainEqual(expect.objectContaining({ level: 'info', message: '测试日志' }));
  });

  it('日志中的敏感键在诊断包内保持脱敏', async () => {
    const fs = createFakeFs();
    const fileLogger = new FileLogger({ fs, dir: '/app-data/logs' });
    await fileLogger.init();
    fileLogger.warn('凭据', { cookie: 'MUSIC_U=secret' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = createFakeStore();
    const settings = new SettingsService({ store, logger: createNullLogger() });
    await settings.load();
    const service = new DiagnosticsService({ fs, logger: fileLogger, settings, dir: '/app-data/diagnostics', appVersion: '0.1.0' });
    const path = await service.exportDiagnostics();
    const bundle = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as { logs: Array<{ args?: unknown[] }> };
    expect((bundle.logs[0]?.args?.[0] as Record<string, unknown>).cookie).toBe('***');
  });
});
