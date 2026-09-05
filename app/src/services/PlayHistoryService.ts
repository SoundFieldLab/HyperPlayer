/**
 * PlayHistoryService —— 本地最近播放（后端补充规划 #48）。
 *
 * 单曲去重（track_id 主键）：重播同曲刷新时间戳并累计次数；上限截断（默认 500）。
 * 记录点经 attach(stateMachine) 挂接：每曲首次进入 playing 记录一次；
 * 同曲 pause/resume 不重复记录；idle/error 后重置游标，再次播放重新记录。
 */
import type { SqlDatabase } from '../infra/tauriSql';
import type { TrackSource } from '../domains/player/types';
import type { PlaybackStateMachine } from '../domains/player/PlaybackStateMachine';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export interface PlayHistoryEntry {
  track_id: string;
  played_at: number;
  play_count: number;
  source: TrackSource;
}

export interface PlayHistoryServiceDeps {
  sql: SqlDatabase;
  /** 历史表保留上限（超出截断；默认 500）。 */
  cap?: number;
  logger?: Logger;
}

export class PlayHistoryService {
  private readonly sql: SqlDatabase;
  private readonly cap: number;
  private readonly logger: Logger;
  private lastRecordedTrackId: string | null = null;

  constructor(deps: PlayHistoryServiceDeps) {
    this.sql = deps.sql;
    this.cap = deps.cap ?? 500;
    this.logger = deps.logger ?? createNullLogger();
  }

  async init(): Promise<void> {
    await this.sql.execute(
      `CREATE TABLE IF NOT EXISTS play_history (
        track_id TEXT PRIMARY KEY,
        played_at INTEGER NOT NULL,
        play_count INTEGER NOT NULL,
        source TEXT NOT NULL
      )`,
    );
  }

  /** 记录一次播放（同曲刷新时间戳 + 次数累计；新曲插入后按上限截断）。 */
  async record(trackId: string, source: TrackSource, now: number = Date.now()): Promise<void> {
    const existing = await this.sql.select<{ play_count: number }>(
      'SELECT play_count FROM play_history WHERE track_id = ?',
      [trackId],
    );
    if (existing.length > 0) {
      await this.sql.execute(
        'UPDATE play_history SET played_at = ?, play_count = ? WHERE track_id = ?',
        [now, (existing[0]?.play_count ?? 0) + 1, trackId],
      );
      return;
    }
    await this.sql.execute(
      'INSERT INTO play_history (track_id, played_at, play_count, source) VALUES (?, ?, ?, ?)',
      [trackId, now, 1, source],
    );
    await this.trim();
  }

  /** 最近播放列表（按播放时间倒序，limit 上限截取）。 */
  async listRecent(limit = 100): Promise<PlayHistoryEntry[]> {
    const safe = Math.max(1, Math.floor(limit));
    return this.sql.select<PlayHistoryEntry>(
      `SELECT track_id, played_at, play_count, source FROM play_history ORDER BY played_at DESC LIMIT ${safe}`,
    );
  }

  /** 挂接播放状态机（wiring 调用；返回解绑函数）。 */
  attach(stateMachine: PlaybackStateMachine): () => void {
    return stateMachine.subscribe((state) => {
      if (state.status === 'idle' || state.status === 'error') {
        this.lastRecordedTrackId = null;
        return;
      }
      if (state.status === 'playing' && state.track && state.track.id !== this.lastRecordedTrackId) {
        this.lastRecordedTrackId = state.track.id;
        void this.record(state.track.id, state.track.source).catch((error) => {
          this.logger.warn(`play-history: record failed for ${state.track?.id}`, error);
        });
      }
    });
  }

  /** 截断：超出 cap 的旧行（played_at 最老）删除。 */
  private async trim(): Promise<void> {
    const rows = await this.sql.select<{ track_id: string }>(
      'SELECT track_id FROM play_history ORDER BY played_at DESC',
    );
    if (rows.length <= this.cap) return;
    for (const row of rows.slice(this.cap)) {
      await this.sql.execute('DELETE FROM play_history WHERE track_id = ?', [row.track_id]);
      this.logger.debug(`play-history: trimmed ${row.track_id}`);
    }
  }
}
