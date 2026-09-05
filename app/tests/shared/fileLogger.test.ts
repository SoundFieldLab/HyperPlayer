import { describe, expect, it } from 'vitest';
import { FileLogger, redactJson } from '../../src/shared/fileLogger';
import type { LogLevel } from '../../src/shared/fileLogger';
import { createFakeFs } from '../../src/infra/fakes';

function makeLogger(overrides: Partial<{ maxFileBytes: number; maxFiles: number; level: LogLevel }> = {}) {
  const fs = createFakeFs();
  const dir = '/app-data/logs';
  let tick = 1000;
  const logger = new FileLogger({ fs, dir, now: () => (tick += 1000), ...overrides });
  return { fs, logger };
}

describe('FileLogger（后端补充规划 #46）', () => {
  it('等级过滤：默认 info 起落盘，debug 不入文件', async () => {
    const { logger } = makeLogger();
    await logger.init();
    logger.debug('debug 行');
    logger.info('info 行');
    logger.error('error 行');
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等写链
    const entries = await logger.readAll();
    expect(entries.map((e) => e.level)).toEqual(['info', 'error']);
  });

  it('写入可读回：JSON Lines 结构与排序', async () => {
    const { logger } = makeLogger();
    await logger.init();
    logger.info('第一', { a: 1 });
    logger.warn('第二');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = await logger.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'info', message: '第一', args: [{ a: 1 }] });
    expect(entries[1]?.message).toBe('第二');
    expect(entries[0]!.at).toBeLessThan(entries[1]!.at);
  });

  it('敏感键脱敏：cookie/token/password 值替换为 ***', async () => {
    const { logger } = makeLogger();
    await logger.init();
    logger.info('登录', { cookie: 'MUSIC_U=abc', token: 'secret-token', userId: 42 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = await logger.readAll();
    const args = entries[0]?.args?.[0] as Record<string, unknown>;
    expect(args.cookie).toBe('***');
    expect(args.token).toBe('***');
    expect(args.userId).toBe(42); // 非敏感键保留
  });

  it('redactJson 深层次脱敏（嵌套对象/数组）', () => {
    const redacted = redactJson({ a: { password: 'x', list: [{ secret: 'y' }, { name: 'ok' }] } });
    expect(redacted).toEqual({ a: { password: '***', list: [{ secret: '***' }, { name: 'ok' }] } });
  });

  it('滚动：超出单文件上限后轮转保留 maxFiles 份，readAll 合并排序', async () => {
    const { fs, logger } = makeLogger({ maxFileBytes: 200, maxFiles: 3 });
    await logger.init();
    for (let i = 0; i < 30; i += 1) logger.info(`行 ${i}：${'x'.repeat(20)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = await logger.readAll();
    expect(entries.length).toBeGreaterThanOrEqual(6); // 3 份文件合并（每份约 3 行）
    expect(entries.length).toBeLessThan(30); // 最旧已丢弃
    // 时间有序
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.at).toBeGreaterThanOrEqual(entries[i - 1]!.at);
    }
    const names = (await fs.readDir('/app-data/logs')).map((e) => e.name);
    expect(names).toContain('app.log');
    expect(names.length).toBeLessThanOrEqual(3);
  });

  it('半截行（崩溃中断）在 readAll 中被跳过', async () => {
    const { fs, logger } = makeLogger();
    await logger.init();
    logger.info('完整行');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 模拟崩溃残留半截行
    await fs.appendFile('/app-data/logs/app.log', new TextEncoder().encode('{"at":1,"level":"info","message":"半截'));
    const entries = await logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('完整行');
  });
});
