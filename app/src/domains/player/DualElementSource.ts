/**
 * DualElementSource —— 双 <audio> 元素交替（播放器架构.md §3.1 / §4.2）。
 *
 * 不变量：同一时刻只有一个 audio 元素 active；切歌时旧元素保持出声，
 * 直到新曲 canplay 才由外部调用 swap() 切换 active（旧元素转为 B 槽复用）。
 * 元素事件（play/pause/waiting/playing/canplay/ended/error...）转发给订阅者，
 * 由 PlayerController 过滤 active 元素后送入 PlaybackStateMachine。
 */
export type AudioElementEventName =
  | 'play'
  | 'pause'
  | 'waiting'
  | 'playing'
  | 'canplay'
  | 'ended'
  | 'error'
  | 'stalled'
  | 'durationchange'
  | 'loadedmetadata'
  | 'emptied'
  | 'seeked'
  | 'timeupdate';

export const AUDIO_ELEMENT_EVENTS: readonly AudioElementEventName[] = [
  'play',
  'pause',
  'waiting',
  'playing',
  'canplay',
  'ended',
  'error',
  'stalled',
  'durationchange',
  'loadedmetadata',
  'emptied',
  'seeked',
  'timeupdate',
];

/** HTMLAudioElement 鸭子类型（Node 测试环境用 fake 实现）。 */
export interface AudioElementLike {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export type AudioElementEventHandler = (element: AudioElementLike) => void;

export class DualElementSource {
  private readonly elements: [AudioElementLike, AudioElementLike];
  private activeIndex = 0;
  private readonly listeners = new Map<AudioElementEventName, Set<AudioElementEventHandler>>();

  constructor(createElement: () => AudioElementLike) {
    this.elements = [createElement(), createElement()];
    for (const element of this.elements) {
      for (const name of AUDIO_ELEMENT_EVENTS) {
        element.addEventListener(name, () => this.emit(name, element));
      }
    }
  }

  get active(): AudioElementLike {
    return this.elements[this.activeIndex] as AudioElementLike;
  }

  get inactive(): AudioElementLike {
    return this.elements[1 - this.activeIndex] as AudioElementLike;
  }

  /**
   * 把新曲 src 挂到非活跃元素（旧元素保持出声），返回该元素供外部监听
   * canplay 后调用 swap()。MediaElement 阶段为即时硬切（播放器架构.md §7）。
   */
  loadIntoInactive(src: string): AudioElementLike {
    const element = this.inactive;
    element.src = src;
    element.load();
    return element;
  }

  /** 新曲 canplay 后切换 active（不变量：任一时刻仅一个 active）。 */
  swap(): void {
    this.activeIndex = 1 - this.activeIndex;
  }

  on(event: AudioElementEventName, handler: AudioElementEventHandler): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  private emit(event: AudioElementEventName, element: AudioElementLike): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(element);
  }
}
