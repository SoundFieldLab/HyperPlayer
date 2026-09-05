/**
 * TaskCenter —— 统一任务模型（UI-D29 状态中心）。
 * 覆盖：曲库扫描、播放缓存、最近播放淘汰、专辑补齐、VIP 缓存锁定、网易云同步、应用更新。
 * 每项任务显示名称/来源/进度/状态/动作；来源页与状态中心使用同一任务 ID 与状态模型。
 */
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export type TaskKind =
  | 'scan'
  | 'stream-cache'
  | 'cache-evict'
  | 'album-completion'
  | 'vip-lock'
  | 'netease-sync'
  | 'app-update';

export type CenterTaskState = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export type CenterTaskAction = 'pause' | 'cancel' | 'retry' | 'view';

export interface CenterTask {
  /** 稳定 ID（来源页与状态中心同 ID）：kind:id。 */
  id: string;
  kind: TaskKind;
  title: string;
  state: CenterTaskState;
  /** 0..1。 */
  progress: number;
  detail?: string;
  /** 当前状态下可执行的动作（UI 按钮集合）。 */
  actions: CenterTaskAction[];
  updatedAt: number;
}

export interface RegisterTaskOptions {
  id: string;
  kind: TaskKind;
  title: string;
  actions?: CenterTaskAction[];
}

export interface TaskCenterDeps {
  logger?: Logger;
  now?: () => number;
}

export class TaskCenter {
  private readonly tasks = new Map<string, CenterTask>();
  private readonly listeners = new Set<() => void>();
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: TaskCenterDeps = {}) {
    this.logger = deps.logger ?? createNullLogger();
    this.now = deps.now ?? (() => Date.now());
  }

  register(options: RegisterTaskOptions): void {
    this.tasks.set(options.id, {
      id: options.id,
      kind: options.kind,
      title: options.title,
      state: 'running',
      progress: 0,
      actions: options.actions ?? [],
      updatedAt: this.now(),
    });
    this.emit();
  }

  update(id: string, patch: Partial<Omit<CenterTask, 'id' | 'kind' | 'title'>>): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.set(id, { ...task, ...patch, updatedAt: this.now() });
    this.emit();
  }

  /** 终态（done/failed/cancelled）后保留在列表（供状态中心查看/重试）。 */
  complete(id: string, state: Extract<CenterTaskState, 'done' | 'failed' | 'cancelled'>, detail?: string): void {
    this.update(id, { state, progress: state === 'done' ? 1 : undefined, detail });
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.emit();
  }

  getTask(id: string): CenterTask | undefined {
    return this.tasks.get(id);
  }

  list(): CenterTask[] {
    return [...this.tasks.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
