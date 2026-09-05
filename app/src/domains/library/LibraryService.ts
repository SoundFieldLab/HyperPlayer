/**
 * LibraryService —— 本地曲库索引查询/播放列表（架构基线.md §7）。
 *
 * - 查询基于 tauri-plugin-sql（SQLite）；筛选/聚合/排序在服务层完成
 *   （万首级曲库不卡界面；后续如需 SQL LIKE 可下沉，fake-sql 保持服务层过滤）；
 * - 用户自建播放列表 SQLite 持久化（UI-D8：本地播放列表）；
 * - 从曲库移除 ≠ 删除磁盘文件（UI-D23 语义）。
 */
import type { SqlDatabase } from '../../infra/tauriSql';
import type { TrackRecord } from './ScanMachine';

export interface TrackQuery {
  /** 模糊搜索：title/artist/album 子串匹配（服务层过滤）。 */
  search?: string;
  artist?: string;
  album?: string;
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface PlaylistRow {
  id: number;
  name: string;
  created_at: number;
}

export class LibraryService {
  constructor(private readonly sql: SqlDatabase) {}

  /** 建表（幂等）：用户自建播放列表（tracks 表由 ScanMachine 建）。 */
  async init(): Promise<void> {
    await this.sql.execute(`
      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    await this.sql.execute(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id INTEGER NOT NULL,
        track_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id)
      )
    `);
  }

  async queryTracks(query: TrackQuery = {}): Promise<TrackRecord[]> {
    await this.init();
    const rows = await this.sql.select<TrackRecord>('SELECT * FROM tracks');
    let filtered = rows;
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.title.toLowerCase().includes(needle) ||
          (t.artist ?? '').toLowerCase().includes(needle) ||
          (t.album ?? '').toLowerCase().includes(needle),
      );
    }
    if (query.artist) filtered = filtered.filter((t) => t.artist === query.artist);
    if (query.album) filtered = filtered.filter((t) => t.album === query.album);
    if (query.folder) filtered = filtered.filter((t) => t.folder.startsWith(query.folder ?? ''));
    if (query.limit !== undefined) {
      filtered = filtered.slice(query.offset ?? 0, (query.offset ?? 0) + query.limit);
    }
    return filtered;
  }

  async getTrack(id: string): Promise<TrackRecord | null> {
    await this.init();
    const rows = await this.sql.select<TrackRecord>('SELECT * FROM tracks WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async listFolders(): Promise<string[]> {
    await this.init();
    const rows = await this.sql.select<{ folder: string }>('SELECT folder FROM tracks');
    return [...new Set(rows.map((r) => r.folder))].sort();
  }

  async listArtists(): Promise<Array<{ artist: string; count: number }>> {
    await this.init();
    const rows = await this.sql.select<TrackRecord>('SELECT * FROM tracks');
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.artist, (counts.get(row.artist) ?? 0) + 1);
    return [...counts.entries()].map(([artist, count]) => ({ artist, count })).sort((a, b) => a.artist.localeCompare(b.artist));
  }

  async listAlbums(): Promise<Array<{ album: string; artist: string; count: number }>> {
    await this.init();
    const rows = await this.sql.select<TrackRecord>('SELECT * FROM tracks');
    const counts = new Map<string, { album: string; artist: string; count: number }>();
    for (const row of rows) {
      const key = `${row.album}|${row.artist}`;
      const entry = counts.get(key) ?? { album: row.album, artist: row.artist, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => a.album.localeCompare(b.album));
  }

  /** 从曲库索引移除（不删除磁盘文件，UI-D23）。 */
  async removeTrack(trackId: string): Promise<void> {
    await this.init();
    await this.sql.execute('DELETE FROM tracks WHERE id = ?', [trackId]);
    await this.sql.execute('DELETE FROM playlist_tracks WHERE track_id = ?', [trackId]);
  }

  // —— 用户自建播放列表（SQLite 持久化）——

  async createPlaylist(name: string): Promise<number> {
    await this.init();
    const now = Date.now();
    await this.sql.execute('INSERT INTO playlists (name, created_at) VALUES (?, ?)', [name, now]);
    const rows = await this.sql.select<PlaylistRow>('SELECT id FROM playlists ORDER BY id DESC LIMIT 1');
    return rows[0]?.id ?? -1;
  }

  async listPlaylists(): Promise<PlaylistRow[]> {
    await this.init();
    return this.sql.select<PlaylistRow>('SELECT * FROM playlists');
  }

  async addToPlaylist(playlistId: number, trackId: string): Promise<void> {
    await this.init();
    const rows = await this.sql.select<{ position: number }>(
      'SELECT * FROM playlist_tracks WHERE playlist_id = ?',
      [playlistId],
    );
    await this.sql.execute(
      'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)',
      [playlistId, trackId, rows.length],
    );
  }

  async removeFromPlaylist(playlistId: number, trackId: string): Promise<void> {
    await this.init();
    await this.sql.execute('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, trackId]);
  }

  async getPlaylistTracks(playlistId: number): Promise<TrackRecord[]> {
    await this.init();
    const rows = await this.sql.select<{ track_id: string }>(
      'SELECT * FROM playlist_tracks WHERE playlist_id = ?',
      [playlistId],
    );
    const tracks: TrackRecord[] = [];
    for (const row of rows) {
      const found = await this.getTrack(row.track_id);
      if (found) tracks.push(found);
    }
    return tracks;
  }

  async deletePlaylist(id: number): Promise<void> {
    await this.init();
    await this.sql.execute('DELETE FROM playlists WHERE id = ?', [id]);
    await this.sql.execute('DELETE FROM playlist_tracks WHERE playlist_id = ?', [id]);
  }
}
