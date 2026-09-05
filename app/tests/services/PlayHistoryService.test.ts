import { describe, expect, it, beforeEach } from 'vitest';
import { PlayHistoryService } from '../../src/services/PlayHistoryService';
import { PlaybackStateMachine } from '../../src/domains/player/PlaybackStateMachine';
import type { PlaybackError } from '../../src/domains/player/types';
import type { QueueItem } from '../../src/domains/player/types';
import { createFakeSql } from '../../src/infra/fakes';
import { createNullLogger } from '../../src/shared/logger';

function makeTrack(id: string, source: QueueItem['source'] = 'netease'): QueueItem {
  return { id, title: id, source, entitlement: 'free', cacheStatus: 'none' };
}

function makeService(cap?: number) {
  const sql = createFakeSql();
  const service = new PlayHistoryService({ sql, cap, logger: createNullLogger() });
  return { sql, service };
}

function makeStateMachine() {
  return new PlaybackStateMachine({ logger: createNullLogger() });
}

/** LOAD → RESOLVED → CAN_PLAY → PLAY，推进状态机到 playing。 */
function playTrack(sm: PlaybackStateMachine, track: QueueItem): void {
  sm.dispatch({ type: 'LOAD', track });
  sm.dispatch({ type: 'RESOLVED' });
  sm.dispatch({ type: 'CAN_PLAY' });
  sm.dispatch({ type: 'PLAY' });
}

/** 冲刷微任务链：attach 的记录为 fire-and-forget，断言前需等其落库。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('PlayHistoryService（后端补充规划 #48）', () => {
  beforeEach(async () => {
    // 无共享状态；每用例独立 fake sql
  });

  it('init 建表 + record 新曲插入（count=1、source 保留）', async () => {
    const { service } = makeService();
    await service.init();
    await service.record('netease-1', 'netease', 1000);
    await service.record('local-1', 'local', 2000);
    const rows = await service.listRecent();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ track_id: 'local-1', played_at: 2000, play_count: 1, source: 'local' });
    expect(rows[1]).toMatchObject({ track_id: 'netease-1', played_at: 1000, play_count: 1, source: 'netease' });
  });

  it('同曲重复 record：次数累计、时间戳刷新并置顶', async () => {
    const { service } = makeService();
    await service.init();
    await service.record('a', 'netease', 1000);
    await service.record('b', 'netease', 2000);
    await service.record('a', 'netease', 3000);
    const rows = await service.listRecent();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ track_id: 'a', played_at: 3000, play_count: 2 });
    expect(rows[1]).toMatchObject({ track_id: 'b', played_at: 2000, play_count: 1 });
  });

  it('listRecent 上限截取', async () => {
    const { service } = makeService();
    await service.init();
    for (let i = 0; i < 5; i += 1) await service.record(`t${i}`, 'netease', i * 1000);
    const rows = await service.listRecent(3);
    expect(rows.map((r) => r.track_id)).toEqual(['t4', 't3', 't2']);
  });

  it('上限截断：超出 cap 删除最旧行', async () => {
    const { service } = makeService(3);
    await service.init();
    for (let i = 0; i < 5; i += 1) await service.record(`t${i}`, 'netease', i * 1000);
    const rows = await service.listRecent(10);
    expect(rows.map((r) => r.track_id)).toEqual(['t4', 't3', 't2']);
  });

  it('attach：每曲首次 playing 记录，同曲 pause/resume 不重复', async () => {
    const { service } = makeService();
    await service.init();
    const sm = makeStateMachine();
    service.attach(sm);

    playTrack(sm, makeTrack('a'));
    // pause → resume：同曲不重复记录
    sm.dispatch({ type: 'PAUSED' });
    sm.dispatch({ type: 'PLAY' });
    await flush();
    let rows = await service.listRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ track_id: 'a', play_count: 1 });

    // 切曲：新记录
    playTrack(sm, makeTrack('b', 'local'));
    await flush();
    rows = await service.listRecent();
    expect(rows.map((r) => r.track_id)).toEqual(['b', 'a']);
    expect(rows[0]?.source).toBe('local');
  });

  it('attach：error → idle 重置游标后，重播同曲重新记录', async () => {
    const { service } = makeService();
    await service.init();
    const sm = makeStateMachine();
    service.attach(sm);

    playTrack(sm, makeTrack('a'));
    const error: PlaybackError = { taxonomy: 'NETWORK', message: 'x', autoSkip: true, at: Date.now() };
    sm.dispatch({ type: 'ELEMENT_ERROR', error });
    sm.dispatch({ type: 'NEXT' }); // error → idle
    await flush(); // 等首次记录落库，避免与新播放的记录查询交错
    playTrack(sm, makeTrack('a'));
    await flush();

    const rows = await service.listRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ track_id: 'a', play_count: 2 });
  });

  it('attach：非 playing 状态（ready/resolving）不记录', async () => {
    const { service } = makeService();
    await service.init();
    const sm = makeStateMachine();
    service.attach(sm);
    sm.dispatch({ type: 'LOAD', track: makeTrack('a') });
    sm.dispatch({ type: 'RESOLVED' });
    sm.dispatch({ type: 'CAN_PLAY' }); // ready，尚未 PLAY
    const rows = await service.listRecent();
    expect(rows).toHaveLength(0);
  });
});
