/**
 * PlayerController —— 播放编排枢纽（播放器架构.md §1/§2/§4）。
 *
 * 唯一允许广泛调用他家的服务（SessionService/StreamCacheService/HseController/QueueController）。
 * 职责：
 *  - LOAD 编排：源解析（权益/缓存/降级链，由 resolveSource 注入）→ 双元素挂载
 *    → 状态机推进 → 自动播放；
 *  - 元素事件桥接：active 元素事件 → PlaybackStateMachine；
 *  - ENDED 决策：交 QueueController.next()（单曲循环/队列推进/停止）；
 *  - 下一曲预取：队列变动立即取消过时预取（UI-D43）；
 *  - 错误处理：错误不整队清空，按设置自动跳下一首（UI-D28）。
 */
import type { DualElementSource, AudioElementLike } from '../domains/player/DualElementSource';
import { AUDIO_ELEMENT_EVENTS } from '../domains/player/DualElementSource';
import type { AudioEngineController } from '../domains/player/AudioEngineController';
import type { PlaybackStateMachine, PlaybackState } from '../domains/player/PlaybackStateMachine';
import type { QueueController, QueueState } from '../domains/player/QueueController';
import type { QueueItem, ResolvedSource } from '../domains/player/types';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export interface PlayerControllerDeps {
  stateMachine: PlaybackStateMachine;
  elements: DualElementSource;
  queue: QueueController;
  audio: AudioEngineController;
  /** 音源解析：权益/会话校验 → 缓存命中 LocalFileSource / 直链（P2/P4 接线）。 */
  resolveSource: (track: QueueItem) => Promise<ResolvedSource>;
  /** 下一曲预取（P1：预解析；P2 接 StreamCacheService 写盘）。 */
  prefetch?: (track: QueueItem) => Promise<void>;
  /** 错误自动跳下一首开关（设置可关）。 */
  autoSkipOnError?: () => boolean;
  onPlaybackChange?: (state: PlaybackState) => void;
  onQueueChange?: (state: QueueState) => void;
  onDurationChange?: (duration: number) => void;
  logger?: Logger;
}

export class PlayerController {
  private readonly deps: PlayerControllerDeps;
  private readonly logger: Logger;
  private pendingElement: AudioElementLike | null = null;
  private pendingTrack: QueueItem | null = null;
  private pendingAutoplay = false;
  private prefetchToken = 0;
  private readonly unbind: Array<() => void> = [];

  constructor(deps: PlayerControllerDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
    this.unbind.push(
      deps.stateMachine.subscribe((state) => deps.onPlaybackChange?.(state)),
      deps.queue.subscribe((state) => {
        deps.onQueueChange?.(state);
        this.schedulePrefetch();
      }),
    );
    for (const event of AUDIO_ELEMENT_EVENTS) {
      this.unbind.push(deps.elements.on(event, (element) => this.handleElementEvent(event, element)));
    }
  }

  /** 立即播放（playNow 语义 + LOAD）。 */
  async playNow(track: QueueItem, opts: { context?: QueueItem[]; autoplay?: boolean } = {}): Promise<void> {
    this.deps.queue.playNow(track, { context: opts.context });
    await this.load(track, { autoplay: opts.autoplay ?? true });
  }

  /** 下一首播放（插入临时区并立即播放）。 */
  async playNext(track: QueueItem): Promise<void> {
    this.deps.queue.playNext(track);
    await this.load(track, { autoplay: true });
  }

  /** 追加到当前上下文（不打断播放）。 */
  append(track: QueueItem): void {
    this.deps.queue.append(track);
  }

  async load(track: QueueItem, opts: { autoplay?: boolean } = {}): Promise<void> {
    this.pendingTrack = track;
    this.pendingAutoplay = opts.autoplay ?? false;
    this.deps.stateMachine.dispatch({ type: 'LOAD', track });
    try {
      const source = await this.deps.resolveSource(track);
      if (this.pendingTrack !== track) return; // 已被更新的 LOAD 取代
      const element = this.deps.elements.loadIntoInactive(source.url);
      this.pendingElement = element;
      this.deps.stateMachine.dispatch({ type: 'RESOLVED' });
      this.schedulePrefetch();
    } catch (error) {
      if (this.pendingTrack !== track) return;
      this.logger.error(`playback: source resolve failed for ${track.id}`, error);
      this.deps.stateMachine.dispatch({
        type: 'FAIL',
        error: {
          taxonomy: 'SOURCE_RESOLVE_FAIL',
          message: error instanceof Error ? error.message : String(error),
          autoSkip: true,
          at: Date.now(),
        },
      });
      this.handleError();
    }
  }

  async play(): Promise<void> {
    const current = this.deps.queue.snapshot.current;
    if (!current) return;
    this.deps.audio.ensureContext();
    await this.deps.audio.resume();
    const active = this.deps.elements.active;
    if (active.paused) await active.play();
    this.deps.stateMachine.dispatch({ type: 'PLAY' });
  }

  async pause(): Promise<void> {
    this.deps.elements.active.pause();
  }

  async seek(position: number): Promise<void> {
    const active = this.deps.elements.active;
    active.currentTime = position;
    this.deps.stateMachine.dispatch({ type: 'SEEK', position });
  }

  async next(): Promise<void> {
    const target = this.deps.queue.next();
    if (target) await this.load(target, { autoplay: true });
  }

  async prev(): Promise<void> {
    const target = this.deps.queue.prev();
    if (target) await this.load(target, { autoplay: true });
  }

  async retry(): Promise<void> {
    const track = this.deps.stateMachine.snapshot.track;
    if (!track) return;
    this.deps.stateMachine.dispatch({ type: 'RETRY' });
    await this.load(track, { autoplay: true });
  }

  dispose(): void {
    for (const unbind of this.unbind) unbind();
    this.unbind.length = 0;
    this.pendingElement = null;
    this.pendingTrack = null;
    this.prefetchToken += 1;
  }

  private handleElementEvent(event: (typeof AUDIO_ELEMENT_EVENTS)[number], element: AudioElementLike): void {
    // 正在加载的新元素：canplay 后切换 active（旧元素保持出声直到此刻，规格书 §4.2）。
    if (element === this.pendingElement) {
      if (event === 'canplay') {
        this.deps.elements.swap();
        this.pendingElement = null;
        this.deps.stateMachine.dispatch({ type: 'CAN_PLAY' });
        if (this.pendingAutoplay) void this.play();
      } else if (event === 'error') {
        this.pendingElement = null;
        this.deps.stateMachine.dispatch({
          type: 'FAIL',
          error: {
            taxonomy: 'DECODE',
            message: '音源解码失败',
            autoSkip: true,
            at: Date.now(),
          },
        });
        this.handleError();
      } else if (event === 'durationchange') {
        this.deps.onDurationChange?.(element.duration);
      }
      return;
    }

    if (element !== this.deps.elements.active) return; // 只处理 active 元素事件

    switch (event) {
      case 'playing':
        this.deps.stateMachine.dispatch({ type: 'PLAYING' });
        break;
      case 'waiting':
        this.deps.stateMachine.dispatch({ type: 'WAITING' });
        break;
      case 'pause':
        this.deps.stateMachine.dispatch({ type: 'PAUSED' });
        break;
      case 'ended':
        this.deps.stateMachine.dispatch({ type: 'ENDED' });
        this.handleEnded();
        break;
      case 'error':
        this.deps.stateMachine.dispatch({
          type: 'ELEMENT_ERROR',
          error: { taxonomy: 'NETWORK', message: '播放元素错误', autoSkip: true, at: Date.now() },
        });
        this.handleError();
        break;
      case 'durationchange':
        this.deps.onDurationChange?.(this.deps.elements.active.duration);
        break;
      default:
        break;
    }
  }

  private handleEnded(): void {
    const target = this.deps.queue.next();
    if (target) void this.load(target, { autoplay: true });
  }

  private handleError(): void {
    const state = this.deps.stateMachine.snapshot;
    if (state.status !== 'error' || !state.error?.autoSkip) return;
    if (this.deps.autoSkipOnError && !this.deps.autoSkipOnError()) return;
    this.logger.info(`playback: auto-skip after error ${state.error.taxonomy}`);
    const target = this.deps.queue.next();
    if (target) void this.load(target, { autoplay: true });
  }

  /** 下一曲预取：临时区首项 > 上下文下一曲；队列变动（subscribe）立即重排并作废旧预取。 */
  private schedulePrefetch(): void {
    if (!this.deps.prefetch) return;
    const token = ++this.prefetchToken;
    const target = this.deps.queue.peekNext();
    if (!target) return;
    void this.deps.prefetch(target).catch(() => {
      if (token === this.prefetchToken) this.logger.debug(`prefetch ignored/cancelled for ${target.id}`);
    });
  }
}
