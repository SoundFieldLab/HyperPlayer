/**
 * fakes —— 单测用的 infra 替换（全内存，不碰 Tauri）。
 * 架构基线.md §2：单测全程用 fake，不依赖真实插件。
 */
import type { CacheStore } from '../idbCache';
import type { KeyValueStore } from '../tauriStore';
import type { SqlDatabase } from '../tauriSql';
import type { HttpResponse, TauriHttp } from '../tauriHttp';
import type { FsEntry, FsStat, TauriFs } from '../tauriFs';
import type { Vault } from '../vault';

export function createFakeStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T,>(key: string): Promise<T | null> => (map.get(key) as T | undefined) ?? null,
    set: async <T,>(key: string, value: T): Promise<void> => {
      map.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      map.delete(key);
    },
    keys: async (): Promise<string[]> => [...map.keys()],
  };
}

export function createFakeCacheStore(): CacheStore {
  return createFakeStore();
}

export function createFakeVault(): Vault {
  const map = new Map<string, string>();
  return {
    getSecret: async (namespace, key) => map.get(`${namespace}:${key}`) ?? null,
    setSecret: async (namespace, key, value) => {
      map.set(`${namespace}:${key}`, value);
    },
    deleteSecret: async (namespace, key) => {
      map.delete(`${namespace}:${key}`);
    },
  };
}

/**
 * 迷你内存 SQL 引擎：支持 StreamCacheService / LibraryService 所需子集
 * （CREATE TABLE IF NOT EXISTS / INSERT / UPDATE...SET...WHERE / DELETE...WHERE
 *  / SELECT 列 FROM 表 [WHERE col = ?] / SELECT SUM(col) AS alias）。
 */
interface FakeTable {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/gu, '').trim();
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'true') return 1;
    if (value === 'false') return 0;
  }
  return value;
}

export function createFakeSql(): SqlDatabase {
  const tables = new Map<string, FakeTable>();

  const ensureTable = (name: string, columns: string[]): FakeTable => {
    let table = tables.get(name);
    if (!table) {
      table = { columns, rows: [] };
      tables.set(name, table);
    }
    return table;
  };

  const parseWhere = (whereClause: string, bindValues: unknown[]): ((row: Record<string, unknown>) => boolean) => {
    // 支持 "col = ?" / "col = value"，多个条件用 AND 连接。
    const clauses = whereClause.split(/\s+AND\s+/iu);
    const predicates = clauses.map((clause) => {
      const match = /^(\w+)\s*=\s*(.+)$/u.exec(clause.trim());
      if (!match) return () => true;
      const [, column, raw] = match;
      const value = raw === '?' ? bindValues.shift() : normalizeValue((raw ?? '').replace(/^'|'$/gu, ''));
      return (row: Record<string, unknown>) => normalizeValue(row[column as string]) === normalizeValue(value);
    });
    return (row) => predicates.every((predicate) => predicate(row));
  };

  const parseColumns = (columnList: string, table: FakeTable, rows: Array<Record<string, unknown>>): unknown[] => {
    if (columnList.trim() === '*') return rows;
    if (/^SUM\((\w+)\)\s+AS\s+(\w+)$/iu.test(columnList.trim())) {
      const sumMatch = /^SUM\((\w+)\)\s+AS\s+(\w+)$/iu.exec(columnList.trim());
      const column = sumMatch?.[1] ?? '';
      const alias = sumMatch?.[2] ?? '';
      const total = rows.reduce((acc, row) => acc + (typeof row[column] === 'number' ? (row[column] as number) : 0), 0);
      return [{ [alias]: total }];
    }
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of columnList.split(',').map((c) => c.trim())) {
        out[column] = row[column];
      }
      return out;
    });
  };

  return {
    execute: async (sql, bindValues = []): Promise<unknown> => {
      const statement = stripComments(sql);
      // 事务语句：内存表操作天然原子，BEGIN/COMMIT/ROLLBACK 作为 no-op 接受。
      if (/^(BEGIN|COMMIT|ROLLBACK)(\s+TRANSACTION)?\s*;?$/iu.test(statement)) {
        return undefined;
      }
      const createMatch = /^CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]+?)\)$/u.exec(statement);
      if (createMatch) {
        const name = createMatch[1] as string;
        const columns = (createMatch[2] as string)
          .split(',')
          .map((c) => c.trim().split(/\s+/u)[0] ?? '')
          .filter(Boolean);
        if (!tables.has(name)) tables.set(name, { columns, rows: [] });
        return undefined;
      }

      const insertMatch = /^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/u.exec(statement);
      if (insertMatch) {
        const name = insertMatch[1] as string;
        const columns = (insertMatch[2] as string).split(',').map((c) => c.trim());
        const placeholders = (insertMatch[3] as string).split(',').map((p) => p.trim());
        const table = ensureTable(name, columns);
        const row: Record<string, unknown> = {};
        columns.forEach((column, index) => {
          const placeholder = placeholders[index];
          row[column] = placeholder === '?' ? bindValues.shift() : normalizeValue((placeholder ?? '').replace(/^'|'$/gu, ''));
        });
        // 模拟 INTEGER PRIMARY KEY AUTOINCREMENT（表定义含 id 列且 INSERT 未提供）
        const tableDef = tables.get(name);
        if (tableDef && tableDef.columns.includes('id') && !('id' in row)) {
          let max = 0;
          for (const existing of tableDef.rows) {
            if (typeof existing.id === 'number' && existing.id > max) max = existing.id;
          }
          row.id = max + 1;
        }
        table.rows.push(row);
        return undefined;
      }

      const updateMatch = /^UPDATE (\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/u.exec(statement);
      if (updateMatch) {
        const name = updateMatch[1] as string;
        const setClause = updateMatch[2] as string;
        const whereClause = updateMatch[3] ?? '';
        const table = tables.get(name);
        if (!table) return undefined;
        const setPairs = setClause.split(',').map((pair) => pair.trim());
        const sets: Array<[string, unknown]> = setPairs.map((pair) => {
          const [column, raw] = pair.split('=').map((p) => p.trim()) as [string, string];
          return [column, raw === '?' ? bindValues.shift() : normalizeValue(raw.replace(/^'|'$/gu, ''))];
        });
        const predicate = whereClause ? parseWhere(whereClause, bindValues) : () => true;
        for (const row of table.rows) {
          if (predicate(row)) {
            for (const [column, value] of sets) row[column] = value;
          }
        }
        return undefined;
      }

      const deleteMatch = /^DELETE FROM (\w+)(?:\s+WHERE\s+([\s\S]+))?$/u.exec(statement);
      if (deleteMatch) {
        const name = deleteMatch[1] as string;
        const whereClause = deleteMatch[2] ?? '';
        const table = tables.get(name);
        if (!table) return undefined;
        const predicate = whereClause ? parseWhere(whereClause, bindValues) : () => true;
        table.rows = table.rows.filter((row) => !predicate(row));
        return undefined;
      }

      throw new Error(`fake-sql: unsupported statement: ${statement.slice(0, 80)}`);
    },

    select: async <T,>(sql: string, bindValues: unknown[] = []): Promise<T[]> => {
      const statement = stripComments(sql);
      const match = /^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?$/u.exec(statement);
      if (!match) throw new Error(`fake-sql: unsupported select: ${statement.slice(0, 80)}`);
      const columnList = match[1] as string;
      const name = match[2] as string;
      const whereClause = match[3] ?? '';
      const table = tables.get(name);
      if (!table) return [];
      const predicate = whereClause ? parseWhere(whereClause, bindValues) : () => true;
      const rows = table.rows.filter(predicate);
      return parseColumns(columnList, table, rows) as T[];
    },

    close: async () => {
      tables.clear();
    },
  };
}

/** fake HTTP：注册响应后按 URL 返回（body 按块流式吐出，模拟下载）。 */
export function createFakeHttp(): TauriHttp & { respond(url: string, body: Uint8Array[], status?: number): void } {
  const responses = new Map<string, { status: number; body: Uint8Array[] }>();

  function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index] as Uint8Array);
        index += 1;
      },
    });
  }

  return {
    respond: (url, body, status = 200) => {
      responses.set(url, { status, body });
    },
    fetch: async (url): Promise<HttpResponse> => {
      const response = responses.get(url);
      if (!response) {
        return { status: 404, headers: {}, body: streamFrom([new TextEncoder().encode('not found')]) };
      }
      return {
        status: response.status,
        headers: { 'content-length': String(response.body.reduce((acc, c) => acc + c.length, 0)) },
        body: streamFrom(response.body),
      };
    },
  };
}

/** fake FS：内存文件系统（字节 + mtime）。 */
export function createFakeFs(): TauriFs & {
  setMtime(path: string, ms: number): void;
} {
  const files = new Map<string, { bytes: Uint8Array; modifiedMs: number }>();
  const dirs = new Set<string>();

  return {
    readFile: async (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`fake-fs: no such file ${path}`);
      return file.bytes;
    },
    writeFile: async (path, data) => {
      files.set(path, { bytes: data, modifiedMs: Date.now() });
      dirs.add(path.slice(0, path.lastIndexOf('/')));
    },
    appendFile: async (path, data) => {
      const existing = files.get(path);
      const merged = existing ? new Uint8Array([...existing.bytes, ...data]) : new Uint8Array([...data]);
      files.set(path, { bytes: merged, modifiedMs: Date.now() });
    },
    mkdir: async (path) => {
      dirs.add(path);
    },
    readDir: async (path) => {
      const entries: FsEntry[] = [];
      for (const dir of dirs) {
        if (dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes('/')) {
          entries.push({ name: dir.slice(path.length + 1), isDirectory: true });
        }
      }
      for (const file of files.keys()) {
        if (file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')) {
          entries.push({ name: file.slice(path.length + 1), isDirectory: false });
        }
      }
      return entries;
    },
    removeFile: async (path) => {
      files.delete(path);
    },
    exists: async (path) => files.has(path) || dirs.has(path),
    stat: async (path): Promise<FsStat | null> => {
      const file = files.get(path);
      if (!file) return null;
      return { size: file.bytes.length, modifiedMs: file.modifiedMs };
    },
    setMtime: (path, ms) => {
      const file = files.get(path);
      if (file) file.modifiedMs = ms;
    },
  };
}
