/**
 * infra tauriSql —— tauri-plugin-sql 薄封装（SQLite：曲库索引 + 缓存索引，WAL）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import Database from '@tauri-apps/plugin-sql';

export interface SqlDatabase {
  execute(sql: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(sql: string, bindValues?: unknown[]): Promise<T[]>;
  /**
   * 单连接 SQLite 的独占事务：回调期间不允许其它读/写插进 BEGIN 与 COMMIT 之间。
   * 否则扫描批量写入会和播放历史、缓存等服务争用，触发 `database is locked`。
   */
  transaction<T>(operation: (tx: Pick<SqlDatabase, 'execute' | 'select'>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** 加载真实 SQLite 数据库（path 形如 'sqlite:app.db'）。 */
export async function loadSqlDatabase(path: string): Promise<SqlDatabase> {
  const db = await Database.load(path);
  // plugin-sql 持有一个 SQLite 连接。把所有请求线性化，尤其避免其它服务插入
  // ScanMachine 的 BEGIN/COMMIT 区间导致 "database is locked"。
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const direct = {
    execute: (sql: string, bindValues?: unknown[]) => db.execute(sql, bindValues),
    select: <T,>(sql: string, bindValues?: unknown[]): Promise<T[]> => db.select<T[]>(sql, bindValues),
  };

  return {
    execute: (sql, bindValues) => enqueue(async () => {
      if (closed) throw new Error('sql: database is closed');
      return direct.execute(sql, bindValues);
    }),
    select: <T,>(sql: string, bindValues?: unknown[]) => enqueue(async () => {
      if (closed) throw new Error('sql: database is closed');
      return direct.select<T>(sql, bindValues);
    }),
    transaction: <T,>(operation: (tx: Pick<SqlDatabase, 'execute' | 'select'>) => Promise<T>) => enqueue(async () => {
      if (closed) throw new Error('sql: database is closed');
      await direct.execute('BEGIN IMMEDIATE TRANSACTION');
      try {
        const result = await operation(direct);
        await direct.execute('COMMIT');
        return result;
      } catch (error) {
        await direct.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    }),
    close: () => enqueue(async () => {
      if (closed) return;
      closed = true;
      await db.close();
    }),
  };
}
