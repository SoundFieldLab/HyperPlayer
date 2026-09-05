import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  PlaybackStateMachine,
  RESOLVE_WATCHDOG_MS,
  STALLED_WATCHDOG_MS,
  createInitialPlaybackState,
  playbackReducer,
} from '../../../src/domains/player/PlaybackStateMachine';
import type { PlaybackState } from '../../../src/domains/player/PlaybackStateMachine';
import type { QueueItem } from '../../../src/domains/player/types';
import { createNullLogger } from '../../../src/shared/logger';

const T0 = 1_000_000;

function makeTrack(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 't1',
    title: 'Track 1',
    source: 'local',
    entitlement: 'free',
    cacheStatus: 'none',
    ...overrides,
  };
}

function step(state: PlaybackState, event: Parameters<typeof playbackReducer>[1], now = T0): PlaybackState {
  return playbackReducer(state, event, now, createNullLogger());
}

describe('PlaybackStateMachine reducer（事件序列表驱动）', () => {
  it('完整生命周期：LOAD→resolving→RESOLVED→buffering→CAN_PLAY→ready→PLAY→playing→ENDED→ready', () => {
    let s = createInitialPlaybackState();
    expect(s.status).toBe('idle');

    s = step(s, { type: 'LOAD', track: makeTrack() });
    expect(s.status).toBe('resolving');
    expect(s.track?.id).toBe('t1');
    expect(s.watchdog?.kind).toBe('resolve');

    s = step(s, { type: 'RESOLVED' });
    expect(s.status).toBe('buffering');

    s = step(s, { type: 'CAN_PLAY' });
    expect(s.status).toBe('ready');
    expect(s.watchdog).toBeNull();

    s = step(s, { type: 'PLAY' });
    expect(s.status).toBe('playing');

    s = step(s, { type: 'ENDED' });
    expect(s.status).toBe('ready');
  });

  it('看门狗：resolving 12s 超时 → error(SOURCE_RESOLVE_FAIL)', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'TICK' }, T0 + RESOLVE_WATCHDOG_MS - 1);
    expect(s.status).toBe('resolving');

    s = step(s, { type: 'TICK' }, T0 + RESOLVE_WATCHDOG_MS);
    expect(s.status).toBe('error');
    expect(s.error?.taxonomy).toBe('SOURCE_RESOLVE_FAIL');
  });

  it('看门狗：buffering 12s 无 CAN_PLAY → error(NETWORK)', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'RESOLVED' }, T0);
    s = step(s, { type: 'TICK' }, T0 + RESOLVE_WATCHDOG_MS);
    expect(s.status).toBe('error');
    expect(s.error?.taxonomy).toBe('NETWORK');
  });

  it('stalled 20s：playing→WAITING→buffering(stalledFrom)→超时→STALLED_TIMEOUT', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'RESOLVED' }, T0);
    s = step(s, { type: 'CAN_PLAY' }, T0);
    s = step(s, { type: 'PLAY' }, T0);

    s = step(s, { type: 'WAITING' }, T0);
    expect(s.status).toBe('buffering');
    expect(s.stalledFrom).toBe(true);
    expect(s.watchdog?.kind).toBe('stalled');

    s = step(s, { type: 'TICK' }, T0 + STALLED_WATCHDOG_MS - 1);
    expect(s.status).toBe('buffering');

    s = step(s, { type: 'TICK' }, T0 + STALLED_WATCHDOG_MS);
    expect(s.status).toBe('error');
    expect(s.error?.taxonomy).toBe('STALLED_TIMEOUT');
  });

  it('stalled 恢复：buffering(stalledFrom) 收 PLAYING → 回 playing 并清除标记', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'RESOLVED' }, T0);
    s = step(s, { type: 'CAN_PLAY' }, T0);
    s = step(s, { type: 'PLAY' }, T0);
    s = step(s, { type: 'WAITING' }, T0);
    expect(s.stalledFrom).toBe(true);

    s = step(s, { type: 'PLAYING' }, T0 + 1000);
    expect(s.status).toBe('playing');
    expect(s.stalledFrom).toBe(false);
    expect(s.watchdog).toBeNull();
  });

  it('resolving FAIL → error（带 taxonomy，track 保留——错误不整队清空）', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'FAIL', error: { taxonomy: 'SOURCE_RESOLVE_FAIL', message: '直链获取失败', autoSkip: true, at: T0 + 1 } }, T0 + 1);
    expect(s.status).toBe('error');
    expect(s.error?.taxonomy).toBe('SOURCE_RESOLVE_FAIL');
    expect(s.track?.id).toBe('t1');
  });

  it('buffering ELEMENT_ERROR → error(DECODE)', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'RESOLVED' }, T0);
    s = step(s, { type: 'ELEMENT_ERROR', error: { taxonomy: 'DECODE', message: '解码失败', autoSkip: true, at: T0 } }, T0);
    expect(s.status).toBe('error');
    expect(s.error?.taxonomy).toBe('DECODE');
  });

  it('RETRY：error → resolving（保留当前曲目）', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'FAIL', error: { taxonomy: 'NETWORK', message: 'x', autoSkip: true, at: T0 } }, T0);
    s = step(s, { type: 'RETRY' }, T0 + 100);
    expect(s.status).toBe('resolving');
    expect(s.track?.id).toBe('t1');
  });

  it('NEXT/PREV：仅 error 态退出为 idle；非 error 为 no-op', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    s = step(s, { type: 'NEXT' }, T0);
    expect(s.status).toBe('resolving'); // no-op：队列推进由 QueueController 负责

    s = step(s, { type: 'FAIL', error: { taxonomy: 'NETWORK', message: 'x', autoSkip: true, at: T0 } }, T0);
    s = step(s, { type: 'NEXT' }, T0 + 1);
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
  });

  it('非法状态命令为 no-op（不改变状态）', () => {
    let s = step(createInitialPlaybackState(), { type: 'LOAD', track: makeTrack() }, T0);
    // buffering 中 PLAY 为 no-op（规格书：命令在非法状态为 no-op）
    s = step(s, { type: 'RESOLVED' }, T0);
    const before = s;
    s = step(s, { type: 'PLAY' }, T0);
    expect(s.status).toBe('buffering');
    expect(s).toEqual(before);

    // idle 中 PAUSED / CAN_PLAY / WAITING 为 no-op
    s = step(createInitialPlaybackState(), { type: 'PAUSED' }, T0);
    expect(s.status).toBe('idle');
  });
});

describe('PlaybackStateMachine 封装（看门狗定时调度，fake timers）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('LOAD 后 12s 无 RESOLVED，定时器自动触发 SOURCE_RESOLVE_FAIL', () => {
    const machine = new PlaybackStateMachine({ logger: createNullLogger() });
    const statuses: string[] = [];
    machine.subscribe((s) => statuses.push(s.status));

    machine.dispatch({ type: 'LOAD', track: makeTrack() });
    vi.advanceTimersByTime(RESOLVE_WATCHDOG_MS - 1);
    expect(machine.snapshot.status).toBe('resolving');

    vi.advanceTimersByTime(1);
    expect(machine.snapshot.status).toBe('error');
    expect(machine.snapshot.error?.taxonomy).toBe('SOURCE_RESOLVE_FAIL');
    expect(statuses).toEqual(['resolving', 'error']);
  });

  it('stalled 20s 自动超时，且 WAITING 恢复后看门狗被清除', () => {
    const machine = new PlaybackStateMachine({ logger: createNullLogger() });
    machine.dispatch({ type: 'LOAD', track: makeTrack() });
    machine.dispatch({ type: 'RESOLVED' });
    machine.dispatch({ type: 'CAN_PLAY' });
    machine.dispatch({ type: 'PLAY' });
    machine.dispatch({ type: 'WAITING' });
    expect(machine.snapshot.status).toBe('buffering');

    // 卡顿恢复：元素发 PLAYING → 回 playing，旧 stalled 定时器必须失效
    machine.dispatch({ type: 'PLAYING' });
    vi.advanceTimersByTime(STALLED_WATCHDOG_MS + 1000);
    expect(machine.snapshot.status).toBe('playing');
  });

  it('切换曲目（LOAD 覆盖）重置看门狗', () => {
    const machine = new PlaybackStateMachine({ logger: createNullLogger() });
    machine.dispatch({ type: 'LOAD', track: makeTrack({ id: 'a' }) });
    vi.advanceTimersByTime(RESOLVE_WATCHDOG_MS - 1000);
    machine.dispatch({ type: 'LOAD', track: makeTrack({ id: 'b' }) });
    expect(machine.snapshot.track?.id).toBe('b');

    vi.advanceTimersByTime(1000);
    expect(machine.snapshot.status).toBe('resolving'); // 新 12s 窗口未到
    vi.advanceTimersByTime(RESOLVE_WATCHDOG_MS - 1000);
    expect(machine.snapshot.status).toBe('error');
    expect(machine.snapshot.track?.id).toBe('b');
  });

  it('dispose 清除定时器，不再触发迁移', () => {
    const machine = new PlaybackStateMachine({ logger: createNullLogger() });
    machine.dispatch({ type: 'LOAD', track: makeTrack() });
    machine.dispose();
    vi.advanceTimersByTime(RESOLVE_WATCHDOG_MS * 2);
    expect(machine.snapshot.status).toBe('resolving');
  });
});
