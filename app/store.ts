import { create } from "zustand";
import type {
  AppSettingsDto,
  BackendCloseRequestedDto,
  BackgroundTaskDto,
  BridgeContract,
  ContentDomain,
  PlaybackSnapshotDto,
  QueueInsertPosition,
  TrackDto,
  Unlisten,
} from "./bridge/contracts";
import { trackRefOf } from "./bridge/contracts";
import { bridge } from "./bridge";

export type ViewId = "home" | "search" | "library" | "discover" | "recent" | "songs" | "albums" | "artists" | "folders" | "playlists" | "album" | "artist" | "playlist" | "account" | "messages" | "settings" | "cache" | "status" | "dsp";
export type OverlayId = "none" | "queue" | "status";
export type InitStatus = "idle" | "loading" | "ready" | "error";
export interface ToastMessage { id: number; message: string; }

interface AppState {
  ready: boolean;
  initStatus: InitStatus;
  initError: string | null;
  onboarding: boolean;
  domain: ContentDomain;
  view: ViewId;
  detailId: number | null;
  history: ViewId[];
  playback: PlaybackSnapshotDto | null;
  settings: AppSettingsDto | null;
  tasks: BackgroundTaskDto[];
  closeRequest: BackendCloseRequestedDto | null;
  expandedPlayer: boolean;
  overlay: OverlayId;
  searchOpen: boolean;
  miniOpen: boolean;
  desktopLyricsOpen: boolean;
  queueFloating: boolean;
  selectedTrackIds: string[];
  toasts: ToastMessage[];
  unlisten: Unlisten | null;
  init(): Promise<void>;
  dispose(): void;
  finishOnboarding(): void;
  rerunOnboarding(): void;
  setDomain(domain: ContentDomain): void;
  navigate(view: ViewId, detailId?: number): void;
  back(): void;
  togglePlayback(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  playTrack(track: TrackDto): Promise<void>;
  seek(value: number): Promise<void>;
  setVolume(value: number): Promise<void>;
  setRepeat(value: PlaybackSnapshotDto["repeat"]): Promise<void>;
  setSettings(patch: Partial<AppSettingsDto>): Promise<void>;
  notifyError(error: unknown, fallback: string): void;
  dismissToast(id: number): void;
  enqueueTrack(track: TrackDto, position?: QueueInsertPosition): Promise<void>;
  removeQueueItem(queueItemId: string): Promise<void>;
  reorderQueueItem(queueItemId: string, targetIndex: number): Promise<void>;
  clearQueue(scope: "playNext" | "all"): Promise<void>;
  resolveClose(action: "cancel" | "minimizeToTray" | "exit", remember: boolean): Promise<void>;
  setExpanded(value: boolean): void;
  setOverlay(value: OverlayId): void;
  setSearchOpen(value: boolean): void;
  setMiniOpen(value: boolean): void;
  setDesktopLyricsOpen(value: boolean): void;
  setQueueFloating(value: boolean): void;
  selectTrack(id: string, multi?: boolean): void;
}

let activeBridge: BridgeContract = bridge;
export function setBridgeForTests(next: BridgeContract | null) { activeBridge = next ?? bridge; }

function upsertScanTask(tasks: BackgroundTaskDto[], progress: { taskId: string; completed: number; total: number | null; phase: string }) {
  const next: BackgroundTaskDto = {
    id: progress.taskId,
    kind: "scan",
    title: "正在扫描本地曲库",
    detail: progress.phase,
    progress: progress.total && progress.total > 0 ? progress.completed / progress.total : null,
    state: progress.total !== null && progress.completed >= progress.total ? "complete" : "running",
  };
  return [...tasks.filter((task) => task.id !== next.id), next];
}

function errorMessage(error: unknown, fallback = "无法连接到 HyperPlayer 后端") {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return error instanceof Error ? error.message : fallback;
}

let toastId = 0;
let initGeneration = 0;
let transportGeneration = 0;
let volumeGeneration = 0;
let settingsGeneration = 0;

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  initStatus: "idle",
  initError: null,
  onboarding: localStorage.getItem("hyperplayer.onboarded") !== "1",
  domain: "netease",
  view: "home",
  detailId: null,
  history: [],
  playback: null,
  settings: null,
  tasks: [],
  closeRequest: null,
  expandedPlayer: false,
  overlay: "none",
  searchOpen: false,
  miniOpen: false,
  desktopLyricsOpen: false,
  queueFloating: false,
  selectedTrackIds: [],
  toasts: [],
  unlisten: null,
  async init() {
    const generation = ++initGeneration;
    get().unlisten?.();
    set({ unlisten: null, ready: false, initStatus: "loading", initError: null });
    let pendingUnlisten: Unlisten | null = null;
    let eventPlayback: PlaybackSnapshotDto | null = null;
    let eventSettings: AppSettingsDto | null = null;
    const scanEvents: Array<{ taskId: string; completed: number; total: number | null; phase: string }> = [];
    let neteaseAuthenticated = false;
    try {
      pendingUnlisten = await activeBridge.subscribe({
        playbackChanged: (playback) => { eventPlayback = playback; set({ playback }); },
        queueChanged: (playback) => { eventPlayback = playback; set({ playback }); },
        playbackProgress: ({ positionMs, durationMs }) => set((state) => state.playback ? {
          playback: {
            ...state.playback,
            positionMs,
            current: state.playback.current && durationMs !== null
              ? { ...state.playback.current, durationMs }
              : state.playback.current,
          },
        } : {}),
        settingsChanged: (settings) => { eventSettings = settings; set({ settings }); },
        scanProgress: (progress) => { scanEvents.push(progress); set((state) => ({ tasks: upsertScanTask(state.tasks, progress) })); },
        neteaseStatusChanged: (status) => {
          neteaseAuthenticated = status.authenticated;
          set((state) => ({ tasks: status.authenticated ? state.tasks.filter((task) => task.id !== "netease-login") : state.tasks }));
        },
        closeRequested: (closeRequest) => set({ closeRequest }),
      });
      if (generation !== initGeneration) { pendingUnlisten(); return; }
      const initial = await activeBridge.bootstrap();
      if (generation !== initGeneration) { pendingUnlisten(); return; }
      const tasks = scanEvents.reduce(upsertScanTask, initial.tasks);
      set({
        ...initial,
        playback: eventPlayback ?? initial.playback,
        settings: eventSettings ?? initial.settings,
        tasks: neteaseAuthenticated ? tasks.filter((task) => task.id !== "netease-login") : tasks,
        unlisten: pendingUnlisten,
        ready: true,
        initStatus: "ready",
        initError: null,
      });
    } catch (error) {
      pendingUnlisten?.();
      if (generation === initGeneration) set({ unlisten: null, ready: false, initStatus: "error", initError: errorMessage(error) });
    }
  },
  dispose() {
    initGeneration += 1;
    transportGeneration += 1;
    volumeGeneration += 1;
    settingsGeneration += 1;
    get().unlisten?.();
    set({ unlisten: null });
  },
  finishOnboarding() {
    localStorage.setItem("hyperplayer.onboarded", "1");
    set({ onboarding: false, domain: "netease", view: "home" });
  },
  rerunOnboarding() {
    localStorage.removeItem("hyperplayer.onboarded");
    set({ onboarding: true, view: "home", history: [], overlay: "none", expandedPlayer: false });
  },
  setDomain(domain) { set({ domain, view: "home", detailId: null, history: [] }); },
  navigate(view, detailId) { set((state) => ({ history: [...state.history.slice(-19), state.view], view, detailId: detailId ?? null, selectedTrackIds: [] })); },
  back() { const history = [...get().history]; const view = history.pop(); if (view) set({ view, history }); },
  notifyError(error, fallback) {
    const toast = { id: ++toastId, message: errorMessage(error, fallback) };
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }));
  },
  dismissToast(id) { set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })); },
  async togglePlayback() {
    const previous = get().playback;
    if (!previous?.current) return;
    const generation = ++transportGeneration;
    const playing = previous.status !== "playing";
    set({ playback: { ...previous, status: playing ? "playing" : "paused" } });
    try {
      const playback = playing ? await activeBridge.play() : await activeBridge.pause();
      if (generation === transportGeneration) set({ playback });
    } catch (error) {
      if (generation !== transportGeneration) return;
      set({ playback: previous });
      get().notifyError(error, "播放状态更新失败");
      void activeBridge.getPlayback().then((playback) => { if (generation === transportGeneration) set({ playback }); }).catch(() => undefined);
    }
  },
  async stop() {
    const generation = ++transportGeneration;
    try { const playback = await activeBridge.stop(); if (generation === transportGeneration) set({ playback }); }
    catch (error) { if (generation === transportGeneration) get().notifyError(error, "停止播放失败"); }
  },
  async next() {
    const generation = ++transportGeneration;
    try { const playback = await activeBridge.next(); if (generation === transportGeneration) set({ playback }); }
    catch (error) { if (generation === transportGeneration) get().notifyError(error, "无法播放下一首"); }
  },
  async previous() {
    const generation = ++transportGeneration;
    try { const playback = await activeBridge.previous(); if (generation === transportGeneration) set({ playback }); }
    catch (error) { if (generation === transportGeneration) get().notifyError(error, "无法播放上一首"); }
  },
  async playTrack(track) {
    const generation = ++transportGeneration;
    const previous = get().playback;
    try {
      const playback = await activeBridge.play(trackRefOf(track));
      if (generation === transportGeneration) set({ playback, selectedTrackIds: [track.id] });
    } catch (error) {
      if (generation !== transportGeneration) return;
      if (previous) set({ playback: previous });
      get().notifyError(error, "无法播放所选歌曲");
    }
  },
  async seek(positionMs) {
    const generation = ++transportGeneration;
    const previous = get().playback;
    if (previous) set({ playback: { ...previous, positionMs } });
    try {
      const playback = await activeBridge.seek(positionMs);
      if (generation === transportGeneration) set({ playback });
    } catch (error) {
      if (generation !== transportGeneration) return;
      if (previous) set({ playback: previous });
      get().notifyError(error, "跳转播放进度失败");
      void activeBridge.getPlayback().then((playback) => { if (generation === transportGeneration) set({ playback }); }).catch(() => undefined);
    }
  },
  async setVolume(volume) {
    const generation = ++volumeGeneration;
    const previous = get().playback;
    if (previous) set({ playback: { ...previous, volume } });
    try {
      const playback = await activeBridge.setVolume(volume);
      if (generation === volumeGeneration) set({ playback });
    } catch (error) {
      if (generation !== volumeGeneration) return;
      if (previous) set({ playback: previous });
      void activeBridge.getPlayback().then((playback) => { if (generation === volumeGeneration) set({ playback }); }).catch(() => undefined);
      get().notifyError(error, "调整音量失败");
    }
  },
  async setRepeat(repeat) {
    const generation = ++transportGeneration;
    const previous = get().playback;
    if (previous) set({ playback: { ...previous, repeat } });
    try { const playback = await activeBridge.setRepeatMode(repeat); if (generation === transportGeneration) set({ playback }); }
    catch (error) { if (generation === transportGeneration) { if (previous) set({ playback: previous }); get().notifyError(error, "切换播放模式失败"); } }
  },
  async setSettings(patch) {
    const generation = ++settingsGeneration;
    const previous = get().settings;
    if (previous) set({ settings: { ...previous, ...patch } });
    try {
      const settings = await activeBridge.updateSettings(patch);
      if (generation === settingsGeneration) set({ settings });
    } catch (error) {
      if (generation !== settingsGeneration) return;
      if (previous) set({ settings: previous });
      void activeBridge.getSettings().then((settings) => { if (generation === settingsGeneration) set({ settings }); }).catch(() => undefined);
      get().notifyError(error, "保存设置失败");
    }
  },
  async enqueueTrack(track, position = "contextEnd") {
    try { set({ playback: await activeBridge.enqueue(trackRefOf(track), position) }); }
    catch (error) { get().notifyError(error, "无法将歌曲加入队列"); }
  },
  async removeQueueItem(queueItemId) {
    try { set({ playback: await activeBridge.removeQueueItem(queueItemId) }); }
    catch (error) { get().notifyError(error, "无法移除队列歌曲"); }
  },
  async reorderQueueItem(queueItemId, targetIndex) {
    try { set({ playback: await activeBridge.reorderQueueItem(queueItemId, targetIndex) }); }
    catch (error) { get().notifyError(error, "无法调整队列顺序"); }
  },
  async clearQueue(scope) {
    try { set({ playback: await activeBridge.clearQueue(scope) }); }
    catch (error) { get().notifyError(error, "无法清空播放队列"); }
  },
  async resolveClose(action, remember) {
    try {
      await activeBridge.resolveClose(action, remember);
      set({ closeRequest: null });
    } catch (error) {
      get().notifyError(error, "无法应用关闭操作");
    }
  },
  setExpanded(expandedPlayer) { set({ expandedPlayer, overlay: "none" }); },
  setOverlay(overlay) { set({ overlay }); },
  setSearchOpen(searchOpen) { set({ searchOpen }); },
  setMiniOpen(miniOpen) { set({ miniOpen }); },
  setDesktopLyricsOpen(desktopLyricsOpen) { set({ desktopLyricsOpen }); },
  setQueueFloating(queueFloating) { set({ queueFloating, overlay: queueFloating ? "none" : get().overlay }); },
  selectTrack(id, multi = false) { set((state) => ({ selectedTrackIds: multi ? (state.selectedTrackIds.includes(id) ? state.selectedTrackIds.filter((value) => value !== id) : [...state.selectedTrackIds, id]) : [id] })); },
}));
