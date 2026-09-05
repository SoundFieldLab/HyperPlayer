/**
 * wiring —— 服务装配（M0 起 UI 层使用的单例工厂）。
 * 原生能力全部经 infra 薄封装；vendored 网易云 API 注入浏览器传输与存储。
 * 本文件被入口引用，确保 vendored CJS 进入打包图并经受 vite 转译验证。
 */
import { createTauriHttp } from '../infra/tauriHttp';
import type { TauriHttp } from '../infra/tauriHttp';
import { createTauriFs } from '../infra/tauriFs';
import type { TauriFs } from '../infra/tauriFs';
import { createTauriStore } from '../infra/tauriStore';
import type { KeyValueStore } from '../infra/tauriStore';
import { loadSqlDatabase } from '../infra/tauriSql';
import type { SqlDatabase } from '../infra/tauriSql';
import { createIdbCache } from '../infra/idbCache';
import type { CacheStore } from '../infra/idbCache';
import { createVault } from '../infra/vault';
import type { Vault } from '../infra/vault';
import { wireNeteaseApi, createNeteaseApi } from '../domains/netease/api/neteaseApi';
import type { NeteaseApi } from '../domains/netease/api/neteaseApi';
import { SessionService } from '../domains/netease/SessionService';
import { NeteaseService } from '../domains/netease/NeteaseService';
import { createNullLogger } from '../shared/logger';

export interface Services {
  http: TauriHttp;
  fs: TauriFs;
  store: KeyValueStore;
  sql: SqlDatabase;
  idb: CacheStore;
  vault: Vault;
  api: NeteaseApi;
  session: SessionService;
  netease: NeteaseService;
}

/** 内存 vault 降级（M5 初始化向导接入 stronghold 密码后替换）。 */
function createMemoryVault(): Vault {
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

const ANONYMOUS_TOKEN_KEY = 'netease.anonymousToken';

/** 匿名 token：首次生成随机值并持久化（网易云 MUSIC_A 语义）。 */
async function getAnonymousToken(store: KeyValueStore): Promise<string> {
  const existing = await store.get<string>(ANONYMOUS_TOKEN_KEY);
  if (existing) return existing;
  const token = `hyperplayer-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  await store.set(ANONYMOUS_TOKEN_KEY, token);
  return token;
}

export async function initServices(): Promise<Services> {
  const http = createTauriHttp();
  const fs = createTauriFs();
  const store = await createTauriStore('hyperplayer.json');
  const sql = await loadSqlDatabase('sqlite:hyperplayer.db');
  const idb = await createIdbCache('hyperplayer-cache');
  let vault: Vault;
  try {
    vault = await createVault();
  } catch {
    vault = createMemoryVault(); // M5：stronghold 密码接线后移除降级
  }

  const request = wireNeteaseApi(http, {
    getAnonymousToken: () => getAnonymousToken(store),
    getXeapiPublicKey: async () => null,
  });
  const api = createNeteaseApi(request);
  const session = new SessionService({ api, vault, logger: createNullLogger() });
  const netease = new NeteaseService({ api, session, logger: createNullLogger() });
  return { http, fs, store, sql, idb, vault, api, session, netease };
}
