/**
 * FileLogger —— 结构化滚动文件日志（后端补充规划 #46）。
 *
 * - JSON Lines 落盘（app.log / app.log.1 / app.log.2，默认 1MB 滚动，保留 3 份）；
 * - 等级过滤（默认 info 起落盘，debug 只进控制台）；
 * - 敏感键脱敏：cookie/token/password/secret/authorization/csrf 等键值落盘前替换为 ***；
 * - 同步 Logger 接口 + 内部串行写链（append 队列化，写失败 console 告警不抛）。
 */
import type { Logger, LogEntry } from './logger';
import type { TauriFs } from '../infra/tauriFs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 敏感字段名（脱敏）：值替换为 ***。 */
const SENSITIVE_KEY = /(cookie|token|password|secret|authorization|csrf)/iu;

export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '***' : redactJson(child);
    }
    return out;
  }
  return value;
}

export interface FileLogEntry extends LogEntry {
  args?: unknown[];
}

export interface FileLoggerDeps {
  fs: TauriFs;
  dir: string;
  /** 落盘最低等级（默认 info）。 */
  level?: LogLevel;
  /** 单文件上限（默认 1 MB），超出滚动。 */
  maxFileBytes?: number;
  /** 保留文件数（含当前，默认 3）。 */
  maxFiles?: number;
  now?: () => number;
}

const BASE_NAME = 'app.log';

export class FileLogger implements Logger {
  private readonly fs: TauriFs;
  private readonly dir: string;
  private readonly level: LogLevel;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private currentBytes = 0;

  constructor(deps: FileLoggerDeps) {
    this.fs = deps.fs;
    this.dir = deps.dir;
    this.level = deps.level ?? 'info';
    this.maxFileBytes = deps.maxFileBytes ?? 1024 * 1024;
    this.maxFiles = deps.maxFiles ?? 3;
    this.now = deps.now ?? (() => Date.now());
  }

  async init(): Promise<void> {
    await this.fs.mkdir(this.dir);
    const stat = await this.fs.stat(this.path(0));
    this.currentBytes = stat?.size ?? 0;
  }

  debug(message: string, ...args: unknown[]): void {
    this.enqueue('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.enqueue('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.enqueue('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.enqueue('error', message, args);
  }

  /** 读取全部日志（诊断导出用）：跨滚动文件合并，按时间排序。 */
  async readAll(): Promise<FileLogEntry[]> {
    const entries: FileLogEntry[] = [];
    for (let index = 0; index < this.maxFiles; index += 1) {
      const path = this.path(index);
      if (!(await this.fs.exists(path))) continue;
      const bytes = await this.fs.readFile(path);
      const text = new TextDecoder().decode(bytes);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as FileLogEntry);
        } catch {
          // 半截行（崩溃中断）：跳过
        }
      }
    }
    return entries.sort((a, b) => a.at - b.at);
  }

  private enqueue(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = JSON.stringify({ at: this.now(), level, message, args: redactJson(args) });
    this.chain = this.chain
      .then(() => this.append(line))
      .catch((error) => {
        console.warn('file-logger: 写入失败', error);
      });
  }

  private async append(line: string): Promise<void> {
    if (this.currentBytes + line.length + 1 > this.maxFileBytes) await this.rotate();
    await this.fs.appendFile(this.path(0), new TextEncoder().encode(`${line}\n`));
    this.currentBytes += line.length + 1;
  }

  private async rotate(): Promise<void> {
    for (let index = this.maxFiles - 1; index > 0; index -= 1) {
      const from = this.path(index - 1);
      if (!(await this.fs.exists(from))) continue;
      const to = this.path(index);
      if (await this.fs.exists(to)) await this.fs.removeFile(to); // 最旧槽位已满 → 丢弃
      await this.fs.renameFile(from, to);
    }
    this.currentBytes = 0;
  }

  private path(index: number): string {
    return index === 0 ? `${this.dir}/${BASE_NAME}` : `${this.dir}/${BASE_NAME}.${index}`;
  }
}
