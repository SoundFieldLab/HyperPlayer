/**
 * QueueController —— 双区队列 + 播放模式（播放器架构.md §3.2 / UI-D43 / UI-D44）。
 *
 * 不变量：
 *  - 双区：接下来播放（upNext，用户"下一首播放"临时区，播完自动移除，永不参与洗牌）
 *          当前上下文（context，来源顺序保留、允许拖拽）；
 *  - 播放模式四态循环（UI-D44）：顺序 → 列表循环 → 单曲循环 → 随机；
 *  - 随机模式持有稳定洗牌序列（返回上一首按实际播放历史，不重抽）；
 *  - playNow 换上下文默认保留临时区（UI-D43，设置可改）；
 *  - clearNext 不动上下文；clearAll 是独立显式动作；
 *  - 队列跨域混排，每项带来源/权益/缓存状态（QueueItem）。
 */
import type { PlayMode, QueueItem } from './types';
import { PLAY_MODES } from './types';

export interface QueueState {
  current: QueueItem | null;
  upNext: QueueItem[];
  context: QueueItem[];
  contextId: string | null;
  mode: PlayMode;
  /** context 中当前曲索引（current 不在 context 时为 -1）。 */
  pointer: number;
  /** 实际播放历史（track id 序列，用于返回上一首，不重抽）。 */
  history: string[];
  /** 稳定洗牌序列（context 的 id 排列）。 */
  shuffle: string[];
  /** 洗牌序列当前位置（-1 = 未开始）。 */
  shuffleIndex: number;
}

export function createInitialQueueState(): QueueState {
  return {
    current: null,
    upNext: [],
    context: [],
    contextId: null,
    mode: 'sequence',
    pointer: -1,
    history: [],
    shuffle: [],
    shuffleIndex: -1,
  };
}

export interface QueueControllerDeps {
  /** playNow 换上下文时默认保留临时区（UI-D43，设置可改）。 */
  keepUpNextOnContextSwitch?: boolean;
  /** 随机源（测试注入固定序列）。 */
  random?: () => number;
}

export interface PlayNowOptions {
  /** 要替换的当前上下文列表；提供时按 UI-D43 替换 context 但保留 upNext。 */
  context?: QueueItem[];
  /** 显式关闭上下文替换（设置可改的默认行为）。 */
  replaceContext?: boolean;
}

function shuffleIds(ids: string[], random: () => number): string[] {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i] as string;
    result[i] = result[j] as string;
    result[j] = tmp;
  }
  return result;
}

export class QueueController {
  private state: QueueState;
  private readonly keepUpNextOnContextSwitch: boolean;
  private readonly random: () => number;
  private readonly listeners = new Set<(state: QueueState) => void>();

  constructor(deps: QueueControllerDeps = {}) {
    this.keepUpNextOnContextSwitch = deps.keepUpNextOnContextSwitch ?? true;
    this.random = deps.random ?? Math.random;
    this.state = createInitialQueueState();
  }

  get snapshot(): QueueState {
    return this.state;
  }

  subscribe(listener: (state: QueueState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 立即播放：默认替换当前上下文（保留 upNext）；context 缺省时仅置当前曲。 */
  playNow(item: QueueItem, opts: PlayNowOptions = {}): void {
    const replaceContext = opts.replaceContext ?? true;
    const contextChanged =
      replaceContext && opts.context !== undefined && opts.context.length > 0 && opts.context[0]?.contextId !== this.state.contextId;

    let context = this.state.context;
    let contextId = this.state.contextId;
    let pointer = this.state.pointer;
    let shuffle: string[] = [];
    let shuffleIndex = -1;

    if (contextChanged && opts.context) {
      context = opts.context;
      contextId = opts.context[0]?.contextId ?? null;
      pointer = opts.context.findIndex((t) => t.id === item.id);
      if (this.state.mode === 'shuffle') {
        const others = context.filter((t) => t.id !== item.id).map((t) => t.id);
        shuffle = [item.id, ...shuffleIds(others, this.random)];
        shuffleIndex = 0;
      }
    } else if (item.id === this.state.current?.id) {
      // 同一曲目重复播放：仅重置状态
      pointer = context.findIndex((t) => t.id === item.id);
    }

    this.state = {
      ...this.state,
      current: item,
      context,
      contextId,
      pointer,
      shuffle,
      shuffleIndex,
      history: [...this.state.history, item.id],
      upNext: this.keepUpNextOnContextSwitch ? this.state.upNext : [],
    };
    this.emit();
  }

  /** 下一首播放：插入临时区头部（优先于上下文）。 */
  playNext(item: QueueItem): void {
    this.state = { ...this.state, upNext: [item, ...this.state.upNext] };
    this.emit();
  }

  /** 追加到当前上下文尾部。 */
  append(item: QueueItem): void {
    this.state = { ...this.state, context: [...this.state.context, item] };
    this.emit();
  }

  /** 从 upNext 与 context 中移除（当前曲不在此处理，由 PlayerController 决策）。 */
  remove(id: string): void {
    this.state = {
      ...this.state,
      upNext: this.state.upNext.filter((t) => t.id !== id),
      context: this.state.context.filter((t) => t.id !== id),
    };
    this.emit();
  }

  /** 上下文内拖拽移动（UI-D43：上下文保留来源顺序允许拖拽）。 */
  move(id: string, toIndex: number): void {
    const fromIndex = this.state.context.findIndex((t) => t.id === id);
    if (fromIndex < 0) return;
    const context = [...this.state.context];
    const [moved] = context.splice(fromIndex, 1);
    if (!moved) return;
    const clamped = Math.max(0, Math.min(toIndex, context.length));
    context.splice(clamped, 0, moved);
    this.state = {
      ...this.state,
      context,
      pointer: fromIndex < this.state.pointer ? this.state.pointer - 1 : this.state.pointer,
      shuffle: this.state.mode === 'shuffle' ? this.regenerateShuffle(context) : this.state.shuffle,
    };
    this.emit();
  }

  /** 清空"接下来播放"（不动当前上下文）。 */
  clearNext(): void {
    this.state = { ...this.state, upNext: [] };
    this.emit();
  }

  /** 独立显式动作：清空整个队列（含当前曲），保留播放模式偏好。 */
  clearAll(): void {
    this.state = { ...createInitialQueueState(), mode: this.state.mode };
    this.emit();
  }

  setMode(mode: PlayMode): void {
    let shuffle = this.state.shuffle;
    let shuffleIndex = this.state.shuffleIndex;
    if (mode === 'shuffle' && this.state.context.length > 0) {
      const current = this.state.current;
      const others = this.state.context.filter((t) => t.id !== current?.id).map((t) => t.id);
      shuffle = current ? [current.id, ...shuffleIds(others, this.random)] : shuffleIds([...this.state.context.map((t) => t.id)], this.random);
      shuffleIndex = current ? 0 : -1;
    }
    this.state = { ...this.state, mode, shuffle, shuffleIndex };
    this.emit();
  }

  /** 四态循环：顺序 → 列表循环 → 单曲循环 → 随机（UI-D44）。 */
  cycleMode(): void {
    const index = PLAY_MODES.indexOf(this.state.mode);
    const next = PLAY_MODES[(index + 1) % PLAY_MODES.length] as PlayMode;
    this.setMode(next);
  }

  /**
   * 播放决策（ENDED 后）：返回应加载的下一首，null = 停止。
   * 优先级：upNext 头部（临时区始终优先，UI-D43；播完自动移除）
   *        → 单曲循环（重播当前，手动动作可打破）
   *        → 模式推进（顺序/列表循环/随机）。
   */
  next(): QueueItem | null {
    if (this.state.upNext.length > 0) {
      const [nextItem, ...rest] = this.state.upNext;
      if (nextItem) {
        this.state = { ...this.state, current: nextItem, upNext: rest };
        this.pushHistory(nextItem.id);
        return nextItem;
      }
    }
    if (this.state.mode === 'single' && this.state.current) {
      this.pushHistory(this.state.current.id);
      return this.state.current;
    }
    if (this.state.context.length === 0) return null;

    let nextItem: QueueItem | null = null;
    if (this.state.mode === 'shuffle') {
      const sequence = this.state.shuffle.length > 0 ? this.state.shuffle : this.state.context.map((t) => t.id);
      const nextIndex = this.state.shuffleIndex + 1 >= sequence.length ? 0 : this.state.shuffleIndex + 1;
      const nextId = sequence[nextIndex];
      nextItem = nextId ? (this.state.context.find((t) => t.id === nextId) ?? null) : null;
      if (nextItem) this.state = { ...this.state, shuffleIndex: nextIndex };
    } else {
      const nextPointer = this.state.pointer + 1;
      nextItem =
        nextPointer < this.state.context.length
          ? (this.state.context[nextPointer] ?? null)
          : this.state.mode === 'loop'
            ? (this.state.context[0] ?? null)
            : null;
      if (nextItem) this.state = { ...this.state, pointer: nextPointer >= this.state.context.length ? 0 : nextPointer };
    }
    if (nextItem) {
      this.state = { ...this.state, current: nextItem };
      this.pushHistory(nextItem.id);
    }
    return nextItem;
  }

  /** 返回上一首：按实际播放历史（不重抽），无历史时按上下文回退。 */
  prev(): QueueItem | null {
    const history = this.state.history;
    if (history.length >= 2) {
      const previousId = history[history.length - 2];
      if (previousId) {
        const item = this.findInQueue(previousId);
        if (item) {
          this.state = { ...this.state, history: history.slice(0, -1), current: item };
          return item;
        }
      }
    }
    if (this.state.pointer - 1 >= 0) {
      const item = this.state.context[this.state.pointer - 1] ?? null;
      if (item) this.state = { ...this.state, pointer: this.state.pointer - 1, current: item };
      return item;
    }
    return null;
  }

  /** 单曲循环的重播目标（= current）。 */
  replayCurrent(): QueueItem | null {
    return this.state.current;
  }

  /** 预取目标：临时区首项 > 当前上下文下一曲（UI-D43 预取优先级，不推进状态）。 */
  peekNext(): QueueItem | null {
    if (this.state.upNext.length > 0) return this.state.upNext[0] ?? null;
    if (this.state.mode === 'single' && this.state.current) return this.state.current;
    if (this.state.context.length === 0) return null;
    if (this.state.mode === 'shuffle') {
      const sequence = this.state.shuffle.length > 0 ? this.state.shuffle : this.state.context.map((t) => t.id);
      const nextIndex = this.state.shuffleIndex + 1 >= sequence.length ? 0 : this.state.shuffleIndex + 1;
      const nextId = sequence[nextIndex];
      return nextId ? (this.state.context.find((t) => t.id === nextId) ?? null) : null;
    }
    const nextPointer = this.state.pointer + 1;
    if (nextPointer < this.state.context.length) return this.state.context[nextPointer] ?? null;
    return this.state.mode === 'loop' ? (this.state.context[0] ?? null) : null;
  }

  private pushHistory(id: string): void {
    this.state = { ...this.state, history: [...this.state.history, id] };
  }

  private findInQueue(id: string): QueueItem | null {
    return this.state.context.find((t) => t.id === id) ?? this.state.upNext.find((t) => t.id === id) ?? null;
  }

  private regenerateShuffle(context: QueueItem[]): string[] {
    const current = this.state.current;
    const others = context.filter((t) => t.id !== current?.id).map((t) => t.id);
    return current ? [current.id, ...shuffleIds(others, this.random)] : shuffleIds(context.map((t) => t.id), this.random);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
