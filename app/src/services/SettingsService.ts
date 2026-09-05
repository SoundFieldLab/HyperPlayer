/**
 * SettingsService —— 设置/偏好持久化（tauri-plugin-store + schema 版本迁移）。
 *
 * 覆盖决策：D75（启动页三选）、D76（队列恢复默认开/启动继续播放默认关）、
 * D77（关闭行为）、D45/D85（音量/最近非零/输出设备）、D28（错误自动跳下一首开关）、
 * D43（playNow 保临时区设置可改）。
 * 队列持久化：2s 防抖 + 退出强写（flushQueuePersist）；崩溃恢复 = 恢复队列但保持暂停（UI-D76）。
 */
import type { PlayMode, QueueItem } from '../domains/player/types';
import type { QueueState } from '../domains/player/QueueController';
import type { KeyValueStore } from '../infra/tauriStore';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export const SETTINGS_SCHEMA_VERSION = 3;
export const QUEUE_PERSIST_DEBOUNCE_MS = 2000;

/** UI-D51：初始化向导进度（中途关闭保存已完成步骤，下次继续）。 */
export interface OnboardingState {
  started: boolean;
  completedSteps: string[];
  completedAt: number | null;
}

export interface AppSettings {
  schemaVersion: number;
  theme: 'light' | 'dark' | 'system';
  /** UI-D75：网易云首页（默认）/ 本地首页 / 上次稳定页面。 */
  startupPage: 'netease-home' | 'local-home' | 'last-page';
  /** UI-D76：队列恢复开关，默认开。 */
  restoreQueue: boolean;
  /** UI-D76：启动继续播放，默认关；仅在正常退出且设备可用时生效。 */
  continueOnStartup: boolean;
  /** UI-D28：错误自动跳下一首，设置可关。 */
  autoSkipOnError: boolean;
  /** UI-D77：关闭行为。 */
  closeBehavior: 'ask' | 'quit' | 'minimize';
  volume: number;
  muted: boolean;
  lastNonZeroVolume: number;
  outputDevice: string | null;
  /** UI-D43：playNow 换上下文默认保留临时区（设置可改）。 */
  keepUpNextOnContextSwitch: boolean;
  /** 缓存容量预算（字节），默认 5 GB。 */
  cacheCapacityBytes: number;
  libraryFolders: string[];
  onboarding: OnboardingState;
  /** 歌词时间偏移（毫秒，正 = 歌词提前；后端补充规划 #12）。 */
  lyricOffsetMs: number;
  /** 单曲歌词偏移覆盖（track_id → ms；容量守卫由写入方负责）。 */
  perTrackLyricOffset: Record<string, number>;
}

export interface PersistedQueue {
  savedAt: number;
  currentId: string | null;
  upNext: QueueItem[];
  context: QueueItem[];
  mode: PlayMode;
}

export function createDefaultSettings(): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    theme: 'system',
    startupPage: 'netease-home',
    restoreQueue: true,
    continueOnStartup: false,
    autoSkipOnError: true,
    closeBehavior: 'ask',
    volume: 1,
    muted: false,
    lastNonZeroVolume: 1,
    outputDevice: null,
    keepUpNextOnContextSwitch: true,
    cacheCapacityBytes: 5 * 1024 * 1024 * 1024,
    libraryFolders: [],
    onboarding: { started: false, completedSteps: [], completedAt: null },
    lyricOffsetMs: 0,
    perTrackLyricOffset: {},
  };
}

const SETTINGS_KEY = 'app.settings';
const QUEUE_KEY = 'app.queue';

export interface SettingsServiceDeps {
  store: KeyValueStore;
  logger?: Logger;
}

export class SettingsService {
  private settings: AppSettings = createDefaultSettings();
  private readonly store: KeyValueStore;
  private readonly logger: Logger;
  private readonly listeners = new Set<(settings: AppSettings) => void>();
  private queueDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingQueue: PersistedQueue | null = null;
  private loaded = false;

  constructor(deps: SettingsServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger ?? createNullLogger();
  }

  get snapshot(): AppSettings {
    return this.settings;
  }

  /** 单曲歌词偏移（毫秒，正 = 提前）：有单曲覆盖用覆盖值，否则回落全局值（后端补充规划 #12）。 */
  lyricOffsetFor(trackId: string | null | undefined): number {
    if (trackId && typeof this.settings.perTrackLyricOffset[trackId] === 'number') {
      return this.settings.perTrackLyricOffset[trackId] as number;
    }
    return this.settings.lyricOffsetMs;
  }

  async load(): Promise<AppSettings> {
    if (this.loaded) return this.settings;
    const stored = await this.store.get<AppSettings>(SETTINGS_KEY);
    if (!stored) {
      this.settings = createDefaultSettings();
    } else {
      this.settings = migrateSettings(stored);
      if ((stored.schemaVersion ?? 0) !== SETTINGS_SCHEMA_VERSION) {
        await this.store.set(SETTINGS_KEY, this.settings);
      }
    }
    this.loaded = true;
    return this.settings;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    await this.load();
    this.settings = { ...this.settings, ...patch };
    await this.store.set(SETTINGS_KEY, this.settings);
    for (const listener of this.listeners) listener(this.settings);
    return this.settings;
  }

  subscribe(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 队列持久化（2s 防抖）：队列每次变化调用。 */
  scheduleQueuePersist(queue: QueueState): void {
    this.pendingQueue = serializeQueue(queue, this.depsNow());
    if (this.queueDebounceTimer !== null) clearTimeout(this.queueDebounceTimer);
    this.queueDebounceTimer = setTimeout(() => {
      this.queueDebounceTimer = null;
      void this.flushQueuePersist();
    }, QUEUE_PERSIST_DEBOUNCE_MS);
  }

  /** 退出强写：立即落盘（应用退出前调用）。 */
  async flushQueuePersist(): Promise<void> {
    if (this.queueDebounceTimer !== null) {
      clearTimeout(this.queueDebounceTimer);
      this.queueDebounceTimer = null;
    }
    if (!this.pendingQueue) return;
    await this.store.set(QUEUE_KEY, this.pendingQueue);
    this.pendingQueue = null;
  }

  /** 崩溃恢复：返回上次持久化队列（UI-D76：恢复队列但保持暂停由调用方处理）。 */
  async restoreQueue(): Promise<PersistedQueue | null> {
    return this.store.get<PersistedQueue>(QUEUE_KEY);
  }

  async clearPersistedQueue(): Promise<void> {
    await this.store.delete(QUEUE_KEY);
  }

  private depsNow(): number {
    return Date.now();
  }
}

/** 版本化迁移：按版本逐级升级；未来新增字段在 createDefaultSettings 与迁移链扩展。 */
export function migrateSettings(stored: AppSettings): AppSettings {
  let settings = { ...createDefaultSettings(), ...stored };
  const storedVersion = stored.schemaVersion ?? 0;
  if (storedVersion < 1) {
    // v0 → v1：初始基线（所有字段已含默认，无结构性变更）。
    settings = { ...settings, schemaVersion: 1 };
  }
  if (storedVersion < 2) {
    // v1 → v2：初始化向导进度（UI-D51 中途续填）。
    settings = { ...settings, onboarding: settings.onboarding ?? { started: false, completedSteps: [], completedAt: null } };
    settings.schemaVersion = 2;
  }
  if (storedVersion < 3) {
    // v2 → v3：歌词时间偏移（全局 + 单曲覆盖，后端补充规划 #12）。
    settings = { ...settings, lyricOffsetMs: settings.lyricOffsetMs ?? 0, perTrackLyricOffset: settings.perTrackLyricOffset ?? {} };
    settings.schemaVersion = 3;
  }
  return settings;
}

export function serializeQueue(queue: QueueState, now: number): PersistedQueue {
  return {
    savedAt: now,
    currentId: queue.current?.id ?? null,
    upNext: queue.upNext,
    context: queue.context,
    mode: queue.mode,
  };
}
