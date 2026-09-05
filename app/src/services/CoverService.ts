/**
 * CoverService —— 封面提取与缓存链路（后端补充规划 #23）。
 *
 * - 落盘：covers/<sha256(albumKey)>.<ext>（$APPDATA 内，assetProtocol scope 已含 $APPDATA/**，
 *   UI 经 toAssetUrl 直接取用）；
 * - 去重：covers 表按 album_key 主键（规范化 专辑|专辑艺术家），同专辑共享一份文件；
 * - 供给：getCoverPath(albumKey) 供 UI 组装封面 URL。
 */
import type { TauriFs } from '../infra/tauriFs';
import type { SqlDatabase } from '../infra/tauriSql';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export interface CoverRecord {
  album_key: string;
  file_path: string;
  updated_at: number;
}

export interface CoverServiceDeps {
  fs: TauriFs;
  sql: SqlDatabase;
  /** 封面目录（appData/covers）。 */
  coversDir: string;
  logger?: Logger;
}

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 专辑键：规范化 专辑艺术家|专辑（trim + 小写）；无专辑信息返回 null。 */
export function albumKeyFor(album: string | null | undefined, albumArtist: string | null | undefined): string | null {
  const key = [albumArtist ?? '', album ?? '']
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join('|');
  return key ? key : null;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class CoverService {
  private readonly deps: CoverServiceDeps;
  private readonly logger: Logger;

  constructor(deps: CoverServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  async init(): Promise<void> {
    await this.deps.fs.mkdir(this.deps.coversDir);
    await this.deps.sql.execute(
      `CREATE TABLE IF NOT EXISTS covers (
        album_key TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  }

  /** 落盘封面并登记；专辑键已存在时直接返回既有路径（去重）。 */
  async ensureCover(albumKey: string, picture: Uint8Array, mime: string): Promise<string | null> {
    const existing = await this.deps.sql.select<CoverRecord>('SELECT file_path FROM covers WHERE album_key = ?', [albumKey]);
    if (existing[0]?.file_path) return existing[0].file_path;

    const ext = IMAGE_EXT[mime] ?? 'bin';
    const path = `${this.deps.coversDir}/${await sha256Hex(albumKey)}.${ext}`;
    if (!(await this.deps.fs.exists(path))) {
      await this.deps.fs.writeFile(path, picture);
    }
    await this.deps.sql.execute('DELETE FROM covers WHERE album_key = ?', [albumKey]);
    await this.deps.sql.execute('INSERT INTO covers (album_key, file_path, updated_at) VALUES (?, ?, ?)', [albumKey, path, Date.now()]);
    this.logger.debug(`cover: 落盘 ${albumKey} → ${path}`);
    return path;
  }

  /** 专辑封面文件路径（无则 null；UI 经 toAssetUrl 取 URL）。 */
  async getCoverPath(albumKey: string | null): Promise<string | null> {
    if (!albumKey) return null;
    const rows = await this.deps.sql.select<CoverRecord>('SELECT file_path FROM covers WHERE album_key = ?', [albumKey]);
    return rows[0]?.file_path ?? null;
  }
}
