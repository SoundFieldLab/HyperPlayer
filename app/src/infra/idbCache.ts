/**
 * infra idbCache —— IndexedDB 数据缓存薄封装（网易云封面/歌词/列表快照）。
 * WebView 内建 IndexedDB；初始化失败降级内存（播放器架构.md §5 性能护栏）。
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 内存降级实现（IndexedDB 不可用时的兜底，同会话有效）。 */
function createMemoryCacheStore(): CacheStore {
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

function openIndexedDb(dbName: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readonly');
    const request = tx.objectStore('cache').get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

function idbSet<T>(db: IDBDatabase, key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    tx.objectStore('cache').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    tx.objectStore('cache').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbKeys(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readonly');
    const request = tx.objectStore('cache').getAllKeys();
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}

/** 创建 IndexedDB 缓存；打开失败自动降级内存。 */
export async function createIdbCache(dbName: string): Promise<CacheStore> {
  try {
    const db = await openIndexedDb(dbName);
    if (!db) return createMemoryCacheStore();
    return {
      get: <T,>(key: string) => idbGet<T>(db, key),
      set: <T,>(key: string, value: T) => idbSet<T>(db, key, value),
      delete: (key: string) => idbDelete(db, key),
      keys: () => idbKeys(db),
    };
  } catch {
    return createMemoryCacheStore();
  }
}
