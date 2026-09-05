/**
 * 轻量日志：console 直出 + 环形缓冲（最近 500 条可导出，UI-D28/播放器架构.md §7）。
 * 无 React 依赖；被服务层/状态机使用。
 */

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export const RING_BUFFER_CAPACITY = 500;

/** 控制台直出 logger（默认）。 */
export const consoleLogger: Logger = {
  debug: (message, ...args) => console.debug(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

export function createNullLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** 环形缓冲 logger：保留最近 N 条，可导出（供设置/状态中心）。 */
export class RingBufferLogger implements Logger {
  private readonly buffer: LogEntry[] = [];

  constructor(
    private readonly capacity: number = RING_BUFFER_CAPACITY,
    private readonly inner: Logger = consoleLogger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  debug(message: string, ...args: unknown[]): void {
    this.push('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.push('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.push('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.push('error', message, args);
  }

  exportEntries(): readonly LogEntry[] {
    return [...this.buffer];
  }

  private push(level: LogEntry['level'], message: string, args: unknown[]): void {
    this.buffer.push({ level, message, at: this.now() });
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.inner[level](message, ...args);
  }
}
