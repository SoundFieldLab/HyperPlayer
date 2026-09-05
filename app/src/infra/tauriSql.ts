/**
 * infra tauriSql —— tauri-plugin-sql 薄封装（SQLite：曲库索引 + 缓存索引，WAL）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import Database from '@tauri-apps/plugin-sql';

export interface SqlDatabase {
  execute(sql: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(sql: string, bindValues?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** 加载真实 SQLite 数据库（path 形如 'sqlite:app.db'）。 */
export async function loadSqlDatabase(path: string): Promise<SqlDatabase> {
  const db = await Database.load(path);
  return {
    execute: (sql, bindValues) => db.execute(sql, bindValues),
    select: <T,>(sql: string, bindValues?: unknown[]): Promise<T[]> => db.select<T[]>(sql, bindValues),
    close: async () => {
      await db.close();
    },
  };
}
