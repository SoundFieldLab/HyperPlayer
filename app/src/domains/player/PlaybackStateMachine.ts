/**
 * PlaybackStateMachine —— 播放核心状态机（播放器架构.md §3.1）。
 *
 * 状态：idle / resolving / buffering / ready / playing / error
 * 事件表驱动：纯函数 playbackReducer + 看门狗调度（resolving 12s、stalled 20s）。
 * 不变量：错误不整队清空（标记当前项不可用，可自动跳下一首，设置可关）；
 *        命令在非法状态为 no-op 并记录日志。
 */
import type { Logger } from '../../shared/logger';
import { createNullLogger } from '../../shared/logger';
import type { PlaybackInput, PlaybackError, PlaybackStatus, QueueItem } from './types';

export const RESOLVE_WATCHDOG_MS = 12_000;
export const STALLED_WATCHDOG_MS = 20_000;

export type WatchdogKind = 'resolve' | 'stalled';

export interface Watchdog {
  kind: WatchdogKind;
  deadline: number;
}

export interface PlaybackState {
  status: PlaybackStatus;
  track: QueueItem | null;
  error: PlaybackError | null;
  /** playing 中收到 WAITING 的标记（stalledFrom，播放器架构.md §3.1）。 */
  stalledFrom: boolean;
  /** 挂源等待/卡顿看门狗；null=无。 */
  watchdog: Watchdog | null;
}

export function createInitialPlaybackState(): PlaybackState {
  return { status: 'idle', track: null, error: null, stalledFrom: false, watchdog: null };
}

function resolveWatchdog(now: number): Watchdog {
  return { kind: 'resolve', deadline: now + RESOLVE_WATCHDOG_MS };
}

function stalledWatchdog(now: number): Watchdog {
  return { kind: 'stalled', deadline: now + STALLED_WATCHDOG_MS };
}

function errorState(
  state: PlaybackState,
  taxonomy: PlaybackError['taxonomy'],
  message: string,
  now: number,
): PlaybackState {
  return {
    ...state,
    status: 'error',
    error: { taxonomy, message, autoSkip: true, at: now },
    watchdog: null,
  };
}

/**
 * 纯 reducer：给定当前状态、输入与时钟，返回下一状态。
 * 所有迁移严格对齐播放器架构.md §3.1 事件表。
 */
export function playbackReducer(
  state: PlaybackState,
  input: PlaybackInput,
  now: number,
  logger: Logger = createNullLogger(),
): PlaybackState {
  const logNoop = (inputType: string, reason: string): PlaybackState => {
    logger.warn(`playback: no-op ${inputType} in ${state.status} (${reason})`);
    return state;
  };

  switch (input.type) {
    case 'LOAD':
      return {
        status: 'resolving',
        track: input.track,
        error: null,
        stalledFrom: false,
        watchdog: resolveWatchdog(now),
      };

    case 'RESOLVED':
      return state.status === 'resolving'
        ? { ...state, status: 'buffering', watchdog: resolveWatchdog(now) }
        : logNoop('RESOLVED', 'not resolving');

    case 'FAIL':
      return state.status === 'resolving' || state.status === 'buffering'
        ? { ...state, status: 'error', error: input.error, watchdog: null }
        : logNoop('FAIL', 'not resolving/buffering');

    case 'CAN_PLAY':
      return state.status === 'buffering'
        ? { ...state, status: 'ready', watchdog: null }
        : logNoop('CAN_PLAY', 'not buffering');

    case 'PLAY':
      // 规格书迁移表：ready --PLAY--> playing；其余状态命令为 no-op。
      return state.status === 'ready'
        ? { ...state, status: 'playing', watchdog: null }
        : logNoop('PLAY', 'not ready');

    case 'WAITING':
      // playing --WAITING--> buffering（标记 stalledFrom，起 20s 看门狗）
      return state.status === 'playing'
        ? { ...state, status: 'buffering', stalledFrom: true, watchdog: stalledWatchdog(now) }
        : logNoop('WAITING', 'not playing');

    case 'PLAYING':
      // 元素原生事件（play/pause/waiting/playing/... 驱动迁移）：
      // playing 中卡顿恢复后元素发 playing 事件，回 playing 并清除 stalledFrom。
      return state.status === 'buffering' && state.stalledFrom
        ? { ...state, status: 'playing', stalledFrom: false, watchdog: null }
        : logNoop('PLAYING', 'not stalled-buffering');

    case 'PAUSED':
      return state.status === 'playing'
        ? { ...state, status: 'ready', watchdog: null }
        : logNoop('PAUSED', 'not playing');

    case 'ENDED':
      // playing --ENDED-->（不进 error）→ 外部 QueueController 决策（单曲循环/next/ready）。
      // 先落 ready，随后 LOAD 会覆盖；无下一曲时保持 ready。
      return state.status === 'playing'
        ? { ...state, status: 'ready', watchdog: null }
        : logNoop('ENDED', 'not playing');

    case 'ELEMENT_ERROR':
      return state.status === 'playing' || state.status === 'buffering' || state.status === 'ready'
        ? { ...state, status: 'error', error: input.error, watchdog: null }
        : logNoop('ELEMENT_ERROR', 'not active');

    case 'SEEK':
      // 位置由元素控制，状态机不改状态；仅 active 状态记录（其余 no-op）。
      return state.status === 'ready' || state.status === 'playing'
        ? state
        : logNoop('SEEK', 'not ready/playing');

    case 'NEXT':
    case 'PREV':
      // 队列推进由 QueueController 完成；状态机仅接受 error 态的退出（等待随后 LOAD）。
      return state.status === 'error'
        ? { ...state, status: 'idle', error: null, watchdog: null }
        : logNoop(input.type, 'not error');

    case 'RETRY':
      // error --RETRY--> resolving（保留当前曲目，重新解析）。
      return state.status === 'error' && state.track
        ? {
            status: 'resolving',
            track: state.track,
            error: null,
            stalledFrom: false,
            watchdog: resolveWatchdog(now),
          }
        : logNoop('RETRY', 'not error or no track');

    case 'TICK': {
      if (!state.watchdog) return state;
      const expired = now >= state.watchdog.deadline;
      if (!expired) return state;
      // 看门狗触发：resolving 12s（覆盖 resolving 与 buffering 两阶段）、stalled 20s。
      if (state.watchdog.kind === 'stalled') {
        return errorState(state, 'STALLED_TIMEOUT', '播放缓冲超时（20s 未恢复）', now);
      }
      if (state.status === 'resolving') {
        return errorState(state, 'SOURCE_RESOLVE_FAIL', '音源解析超时（12s）', now);
      }
      return errorState(state, 'NETWORK', '元素挂源超时（12s）', now);
    }
  }
  // switch 已穷尽；兜底以满足 TS 返回完整性（不应到达）。
  return state;
}

export interface PlaybackStateMachineDeps {
  now?: () => number;
  logger?: Logger;
  initialState?: PlaybackState;
}

/**
 * 状态机封装：reducer + 看门狗定时调度 + 变更订阅。
 * 元素事件（DualElementSource）与命令（PlayerController）经 dispatch 送入。
 */
export class PlaybackStateMachine {
  private state: PlaybackState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly listeners = new Set<(state: PlaybackState) => void>();

  constructor(deps: PlaybackStateMachineDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? createNullLogger();
    this.state = deps.initialState ?? createInitialPlaybackState();
  }

  get snapshot(): PlaybackState {
    return this.state;
  }

  dispatch(input: PlaybackInput): void {
    const next = playbackReducer(this.state, input, this.now(), this.logger);
    if (next === this.state) return;
    this.state = next;
    this.rescheduleWatchdog();
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private rescheduleWatchdog(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const watchdog = this.state.watchdog;
    if (!watchdog) return;
    const delay = Math.max(0, watchdog.deadline - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dispatch({ type: 'TICK' });
    }, delay);
  }
}
