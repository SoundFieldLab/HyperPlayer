/**
 * 播放域共享类型（无 React 依赖）。
 * 命名与状态严格对齐 docs/播放器架构.md §3.1 与 docs/CONTEXT.md。
 */

export type PlaybackStatus = 'idle' | 'resolving' | 'buffering' | 'ready' | 'playing' | 'error';

/** 错误 taxonomy，对齐 UI-D28 的区分要求（播放器架构.md §3.1）。 */
export type ErrorTaxonomy =
  | 'SOURCE_RESOLVE_FAIL'
  | 'NETWORK'
  | 'DECODE'
  | 'FILE_MISSING'
  | 'ENTITLEMENT_LOCKED'
  | 'TRIAL_RESTRICTED'
  | 'DEVICE_FAIL'
  | 'STALLED_TIMEOUT';

export interface PlaybackError {
  taxonomy: ErrorTaxonomy;
  message: string;
  /** 该错误是否可自动跳下一首（设置可关）。 */
  autoSkip: boolean;
  /** 发生时刻（ms 时间戳）。 */
  at: number;
}

export type TrackSource = 'netease' | 'local';

export type CacheStatus = 'none' | 'public' | 'entitlement' | 'locked';

export type Entitlement = 'free' | 'vip' | 'trial' | 'unknown';

/** 队列条目（跨域混排，UI-D33/UI-D43：每项常驻来源/权益/音质/缓存状态）。 */
export interface QueueItem {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  source: TrackSource;
  entitlement: Entitlement;
  /** 期望音质（netease：jymaster/hires/lossless/exhigh/standard）。 */
  quality?: string;
  cacheStatus: CacheStatus;
  /** 来源上下文 id（专辑/歌单/本地列表），用于 playNow 换上下文判定。 */
  contextId?: string;
  /** 已解析的音频 URL（resolving 后填充；local 源为 asset 协议 URL）。 */
  url?: string;
  localPath?: string;
}

/** 用户/命令输入（命令在非法状态为 no-op 并记录日志）。 */
export type PlayerCommand =
  | { type: 'LOAD'; track: QueueItem }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'SEEK'; position: number }
  | { type: 'NEXT' }
  | { type: 'PREV' }
  | { type: 'RETRY' };

/** 元素原生事件 / 异步结果（由 DualElementSource 与源解析器送入）。 */
export type PlayerEvent =
  | { type: 'RESOLVED' }
  | { type: 'FAIL'; error: PlaybackError }
  | { type: 'CAN_PLAY' }
  | { type: 'PLAYING' }
  | { type: 'WAITING' }
  | { type: 'PAUSED' }
  | { type: 'ENDED' }
  | { type: 'ELEMENT_ERROR'; error: PlaybackError };

/** 状态机输入 = 命令 ∪ 事件 ∪ 时钟 tick。 */
export type PlaybackInput = PlayerCommand | PlayerEvent | { type: 'TICK' };

/** 播放模式四态（UI-D44：顺序 → 列表循环 → 单曲循环 → 随机）。 */
export type PlayMode = 'sequence' | 'loop' | 'single' | 'shuffle';

export const PLAY_MODES: readonly PlayMode[] = ['sequence', 'loop', 'single', 'shuffle'];

/** 音源解析结果。 */
export interface ResolvedSource {
  url: string;
  kind: 'local' | 'stream';
}
