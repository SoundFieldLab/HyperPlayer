import { create } from "zustand";
import type {
  AppSettingsDto,
  BackendCloseRequestedDto,
  BackgroundTaskDto,
  BridgeContract,
  ContentDomain,
  DspProcessingFaultDto,
  DspConfigurationDto,
  DspPresetDto,
  DspApplyResultDto,
  PlaybackSnapshotDto,
  PlaybackContextDto,
  QueueInsertPosition,
  TrackDto,
  Unlisten,
} from "./bridge/contracts";
import { trackRefOf } from "./bridge/contracts";
import { bridge } from "./bridge";

export type ViewId = "home" | "search" | "library" | "discover" | "recent" | "songs" | "albums" | "artists" | "folders" | "playlists" | "album" | "artist" | "playlist" | "account" | "messages" | "settings" | "cache" | "status" | "dsp";
export type LocalEntityKind = "album" | "artist" | "folder" | "playlist";
export interface NavigationEntry { view: ViewId; detailId: number | string | null; detailKind: LocalEntityKind | null; }
export interface DomainNavigation { current: NavigationEntry; back: NavigationEntry[]; forward: NavigationEntry[]; }
export type NavigationState = Record<ContentDomain, DomainNavigation>;
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
  detailId: number | string | null;
  detailKind: LocalEntityKind | null;
  navigation: NavigationState;
  playback: PlaybackSnapshotDto | null;
  settings: AppSettingsDto | null;
  tasks: BackgroundTaskDto[];
  closeRequest: BackendCloseRequestedDto | null;
  dspDiagnostic: DspProcessingFaultDto | null;
  dspConfiguration: DspConfigurationDto | null;
  dspPendingConfiguration: DspConfigurationDto | null;
  dspPresets: DspPresetDto[];
  dspUnsupportedStages: string[];
  dspPartial: boolean;
  dspBusy: boolean;
  dspRejection: string | null;
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
  navigate(view: ViewId, detailId?: number | string, detailKind?: LocalEntityKind): void;
  replaceNavigation(view: ViewId): void;
  back(): void;
  forward(): void;
  togglePlayback(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  playTrack(track: TrackDto, context?: PlaybackContextDto): Promise<void>;
  seek(value: number): Promise<void>;
  setVolume(value: number): Promise<void>;
  setRepeat(value: PlaybackSnapshotDto["repeat"]): Promise<void>;
  setSettings(patch: Partial<AppSettingsDto>): Promise<void>;
  loadDspWorkspace(): Promise<void>;
  configureDsp(configuration: DspConfigurationDto): Promise<void>;
  applyDspPreset(presetId: string): Promise<void>;
  importDspHse2(code: string): Promise<void>;
  exportDspHse2(): Promise<string>;
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

/** 网易云听歌打卡（oracle scrobble）的模块级跟踪状态。 */
interface ScrobbleTracker {
  /** 当前正在计时的网易云曲目（trackRef.id 数值）；null 表示无网易云曲目在播。 */
  songId: number | null;
  /** 打卡归属来源（播放上下文 id：歌单/专辑）；无上下文时与 songId 相同。 */
  sourceId: number;
  /** 开始播放的时间戳（Date.now），用于换曲/停止时计算已播秒数。 */
  startedAtMs: number;
  /** 换曲去重：上次已上报的曲目 id，防止同一曲目 40s 内重复打卡。 */
  lastReportedSongId: number | null;
  lastReportedAtMs: number;
}
const scrobbleTracker: ScrobbleTracker = {
  songId: null,
  sourceId: 0,
  startedAtMs: 0,
  lastReportedSongId: null,
  lastReportedAtMs: 0,
};
const SCROBBLE_MIN_SECONDS = 30;

/**
 * 播放状态变化时的打卡钩子：网易云曲目从播放切换/结束（current 变化或离开 playing）
 * 且累计已播 ≥ 30s 时上报 scrobble。打卡失败静默（打点不阻塞播放，与 crate 降级语义一致）。
 */
function trackScrobbleOnPlaybackChanged(playback: PlaybackSnapshotDto): void {
  const current = playback.current;
  const neteaseSongId = current && current.source === "netease" ? Number(current.id) : null;
  if (neteaseSongId !== null && neteaseSongId > 0 && playback.status === "playing") {
    if (scrobbleTracker.songId !== neteaseSongId) {
      reportScrobbleIfNeeded();
      scrobbleTracker.songId = neteaseSongId;
      scrobbleTracker.startedAtMs = Date.now();
    }
    return;
  }
  // 曲目结束/暂停/切换到本地域：若在计时且时长足够则上报，然后停止计时。
  reportScrobbleIfNeeded();
  scrobbleTracker.songId = null;
}

function reportScrobbleIfNeeded(): void {
  const songId = scrobbleTracker.songId;
  if (songId === null) return;
  const playedSeconds = Math.floor((Date.now() - scrobbleTracker.startedAtMs) / 1000);
  if (playedSeconds < SCROBBLE_MIN_SECONDS) return;
  const now = Date.now();
  if (scrobbleTracker.lastReportedSongId === songId && now - scrobbleTracker.lastReportedAtMs < 40_000) {
    return;
  }
  scrobbleTracker.lastReportedSongId = songId;
  scrobbleTracker.lastReportedAtMs = now;
  void activeBridge.neteaseScrobble({ songId, sourceId: scrobbleTracker.sourceId || songId, playedSeconds })
    .catch(() => undefined);
}

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

function newestPlayback(
  bootstrap: PlaybackSnapshotDto,
  event: PlaybackSnapshotDto | null,
): PlaybackSnapshotDto {
  return event && event.revision >= bootstrap.revision ? event : bootstrap;
}

function diagnosticForSnapshot(
  snapshot: PlaybackSnapshotDto,
  current: DspProcessingFaultDto | null,
): DspProcessingFaultDto | null {
  const { dspExecution } = snapshot;
  if (dspExecution.safeBypassActive) return dspExecution.fault ?? current;
  return current && dspExecution.revision <= current.revision ? current : null;
}

function acceptedPlaybackState(snapshot: PlaybackSnapshotDto, current: DspProcessingFaultDto | null) {
  return {
    playback: snapshot,
    dspDiagnostic: diagnosticForSnapshot(snapshot, current),
  };
}

function nextDspRevision(configuration: DspConfigurationDto | null, pending: DspConfigurationDto | null = null): string {
  const appliedRevision = BigInt(configuration?.revision ?? "0");
  const pendingRevision = BigInt(pending?.revision ?? "0");
  return (appliedRevision > pendingRevision ? appliedRevision : pendingRevision) + 1n + "";
}

function acceptedDspResult(result: DspApplyResultDto, currentPlaybackRevision: bigint | null) {
  const applied = result.status === "applied"
    || BigInt(result.engine.dspExecution.revision) === BigInt(result.revision)
    || currentPlaybackRevision === BigInt(result.revision);
  return {
    dspConfiguration: result.configuration,
    dspPendingConfiguration: applied ? null : result.configuration,
    dspPartial: result.partial,
    dspUnsupportedStages: result.unsupportedStages,
    dspRejection: null,
    dspBusy: false,
  };
}

let toastId = 0;
let initGeneration = 0;
let transportGeneration = 0;
let volumeGeneration = 0;
let settingsGeneration = 0;

const homeEntry: NavigationEntry = { view: "home", detailId: null, detailKind: null };
function initialNavigation(): NavigationState {
  return {
    netease: { current: homeEntry, back: [], forward: [] },
    local: { current: homeEntry, back: [], forward: [] },
  };
}
function capHistory(entries: NavigationEntry[]): NavigationEntry[] { return entries.slice(-20); }

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  initStatus: "idle",
  initError: null,
  onboarding: localStorage.getItem("hyperplayer.onboarded") !== "1",
  domain: "netease",
  view: "home",
  detailId: null,
  detailKind: null,
  navigation: initialNavigation(),
  playback: null,
  settings: null,
  tasks: [],
  closeRequest: null,
  dspDiagnostic: null,
  dspConfiguration: null,
  dspPendingConfiguration: null,
  dspPresets: [],
  dspUnsupportedStages: [],
  dspPartial: false,
  dspBusy: false,
  dspRejection: null,
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
        playbackChanged: (playback) => {
          eventPlayback = playback;
          trackScrobbleOnPlaybackChanged(playback);
          set((state) => {
            const pending = state.dspPendingConfiguration;
            const appliedPending = pending && BigInt(pending.revision) === playback.dspExecution.revision;
            return {
              ...acceptedPlaybackState(playback, state.dspDiagnostic),
              ...(appliedPending ? { dspConfiguration: pending, dspPendingConfiguration: null, dspBusy: false } : {}),
            };
          });
        },
        queueChanged: (playback) => {
          eventPlayback = playback;
          set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
        },
        playbackProgress: ({ revision, positionMs, durationMs }) => set((state) => {
          if (!state.playback || state.playback.revision !== revision) return {};
          const playback = {
            ...state.playback,
            positionMs,
            current: state.playback.current && durationMs !== null
              ? { ...state.playback.current, durationMs }
              : state.playback.current,
          };
          if (eventPlayback?.revision === revision) eventPlayback = playback;
          return { playback };
        }),
        settingsChanged: (settings) => { eventSettings = settings; set({ settings }); },
        scanProgress: (progress) => { scanEvents.push(progress); set((state) => ({ tasks: upsertScanTask(state.tasks, progress) })); },
        neteaseStatusChanged: (status) => {
          neteaseAuthenticated = status.authenticated;
          set((state) => ({ tasks: status.authenticated ? state.tasks.filter((task) => task.id !== "netease-login") : state.tasks }));
        },
        dspConfigurationRejected: ({ revision, code, reason, stage }) => {
          const pending = get().dspPendingConfiguration;
          if (!pending || BigInt(pending.revision) !== BigInt(revision)) return;
          const phase = stage ? `（${stage} 阶段）` : "";
          const message = `DSP 配置 revision ${revision} 被拒绝${phase}：${reason} [${code}]`;
          set({ dspPendingConfiguration: null, dspRejection: message, dspBusy: false });
          get().notifyError(
            new Error(message),
            "DSP 配置未能应用",
          );
        },
        dspProcessingFault: (dspDiagnostic) => {
          const acceptedRevision = get().playback?.dspExecution.revision ?? 0n;
          if (dspDiagnostic.revision < acceptedRevision) return;
          set({ dspDiagnostic });
          get().notifyError(
            new Error(`DSP revision ${dspDiagnostic.revision} 的 ${dspDiagnostic.processorName} 处理失败，播放正通过 Rust 安全旁路继续`),
            "DSP 处理失败，播放正通过 Rust 安全旁路继续",
          );
        },
        closeRequested: (closeRequest) => set({ closeRequest }),
      });
      if (generation !== initGeneration) { pendingUnlisten(); return; }
      const initial = await activeBridge.bootstrap();
      if (generation !== initGeneration) { pendingUnlisten(); return; }
      const tasks = scanEvents.reduce(upsertScanTask, initial.tasks);
      const playback = newestPlayback(initial.playback, eventPlayback);
      set((state) => ({
        ...initial,
        ...acceptedPlaybackState(playback, state.dspDiagnostic),
        settings: eventSettings ?? initial.settings,
        tasks: neteaseAuthenticated ? tasks.filter((task) => task.id !== "netease-login") : tasks,
        unlisten: pendingUnlisten,
        ready: true,
        initStatus: "ready",
        initError: null,
      }));
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
    set({ onboarding: false, domain: "netease", view: "home", detailId: null, detailKind: null, navigation: initialNavigation() });
  },
  rerunOnboarding() {
    localStorage.removeItem("hyperplayer.onboarded");
    const navigation = initialNavigation();
    set({ onboarding: true, domain: "netease", view: "home", detailId: null, detailKind: null, navigation, overlay: "none", expandedPlayer: false });
  },
  setDomain(domain) {
    set((state) => {
      if (domain === state.domain) return {};
      const current = state.navigation[domain].current;
      return { domain, view: current.view, detailId: current.detailId, detailKind: current.detailKind, selectedTrackIds: [] };
    });
  },
  navigate(view, detailId, detailKind) {
    set((state) => {
      const next: NavigationEntry = {
        view,
        detailId: detailId ?? null,
        detailKind: typeof detailId === "string" ? detailKind ?? null : null,
      };
      const active = state.navigation[state.domain];
      if (active.current.view === next.view && active.current.detailId === next.detailId && active.current.detailKind === next.detailKind) return {};
      return {
        view: next.view,
        detailId: next.detailId,
        detailKind: next.detailKind,
        navigation: {
          ...state.navigation,
          [state.domain]: { current: next, back: capHistory([...active.back, active.current]), forward: [] },
        },
        selectedTrackIds: [],
      };
    });
  },
  replaceNavigation(view) {
    set((state) => {
      const active = state.navigation[state.domain];
      const next: NavigationEntry = { view, detailId: null, detailKind: null };
      return {
        view,
        detailId: null,
        detailKind: null,
        navigation: {
          ...state.navigation,
          [state.domain]: { current: next, back: active.back, forward: [] },
        },
        selectedTrackIds: [],
      };
    });
  },
  back() {
    set((state) => {
      const active = state.navigation[state.domain];
      const previous = active.back.at(-1);
      if (!previous) return {};
      return {
        view: previous.view,
        detailId: previous.detailId,
        detailKind: previous.detailKind,
        navigation: {
          ...state.navigation,
          [state.domain]: {
            current: previous,
            back: active.back.slice(0, -1),
            forward: capHistory([...active.forward, active.current]),
          },
        },
        selectedTrackIds: [],
      };
    });
  },
  forward() {
    set((state) => {
      const active = state.navigation[state.domain];
      const next = active.forward.at(-1);
      if (!next) return {};
      return {
        view: next.view,
        detailId: next.detailId,
        detailKind: next.detailKind,
        navigation: {
          ...state.navigation,
          [state.domain]: {
            current: next,
            back: capHistory([...active.back, active.current]),
            forward: active.forward.slice(0, -1),
          },
        },
        selectedTrackIds: [],
      };
    });
  },
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
      if (generation === transportGeneration) set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    } catch (error) {
      if (generation !== transportGeneration) return;
      set({ playback: previous });
      get().notifyError(error, "播放状态更新失败");
      void activeBridge.getPlayback().then((playback) => {
        if (generation === transportGeneration) {
          set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
        }
      }).catch(() => undefined);
    }
  },
  async stop() {
    const generation = ++transportGeneration;
    try {
      const playback = await activeBridge.stop();
      if (generation === transportGeneration) set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
    catch (error) { if (generation === transportGeneration) get().notifyError(error, "停止播放失败"); }
  },
  async next() {
    const generation = ++transportGeneration;
    try {
      const playback = await activeBridge.next();
      if (generation === transportGeneration) set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
    catch (error) { if (generation === transportGeneration) get().notifyError(error, "无法播放下一首"); }
  },
  async previous() {
    const generation = ++transportGeneration;
    try {
      const playback = await activeBridge.previous();
      if (generation === transportGeneration) set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
    catch (error) { if (generation === transportGeneration) get().notifyError(error, "无法播放上一首"); }
  },
  async playTrack(track, context) {
    const generation = ++transportGeneration;
    const previous = get().playback;
    // 记录打卡归属来源（歌单/专辑上下文 id；单曲与搜索上下文回落为曲目自身）。
    if (track.source === "netease") {
      const contextId = context && (context.kind === "playlist" || context.kind === "album") && context.id ? Number(context.id) : NaN;
      const songId = Number(track.id);
      scrobbleTracker.sourceId = Number.isFinite(contextId) && contextId > 0 ? contextId : Number.isFinite(songId) && songId > 0 ? songId : 0;
    }
    try {
      const playback = await activeBridge.play(trackRefOf(track), context);
      if (generation === transportGeneration) {
        set((state) => ({
          ...acceptedPlaybackState(playback, state.dspDiagnostic),
          selectedTrackIds: [track.id],
        }));
      }
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
      if (generation === transportGeneration) set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    } catch (error) {
      if (generation !== transportGeneration) return;
      if (previous) set({ playback: previous });
      get().notifyError(error, "跳转播放进度失败");
      void activeBridge.getPlayback().then((playback) => {
        if (generation === transportGeneration) {
          set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
        }
      }).catch(() => undefined);
    }
  },
  async setVolume(volume) {
    const generation = ++volumeGeneration;
    const previous = get().playback;
    if (previous) set({ playback: { ...previous, volume } });
    try {
      const playback = await activeBridge.setVolume(volume);
      if (generation === volumeGeneration) set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    } catch (error) {
      if (generation !== volumeGeneration) return;
      if (previous) set({ playback: previous });
      void activeBridge.getPlayback().then((playback) => {
        if (generation === volumeGeneration) {
          set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
        }
      }).catch(() => undefined);
      get().notifyError(error, "调整音量失败");
    }
  },
  async setRepeat(repeat) {
    const generation = ++transportGeneration;
    const previous = get().playback;
    if (previous) set({ playback: { ...previous, repeat } });
    try {
      const playback = await activeBridge.setRepeatMode(repeat);
      if (generation === transportGeneration) set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
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
  async loadDspWorkspace() {
    set({ dspBusy: true });
    try {
      const [dspConfiguration, dspPresets] = await Promise.all([
        activeBridge.dspGetConfiguration(),
        activeBridge.dspListPresets(),
      ]);
      set({ dspConfiguration, dspPendingConfiguration: null, dspPresets, dspBusy: false, dspRejection: null });
    } catch (error) {
      set({ dspBusy: false });
      get().notifyError(error, "加载 DSP 工作台失败");
    }
  },
  async configureDsp(configuration) {
    const request = { ...configuration, revision: nextDspRevision(get().dspConfiguration, get().dspPendingConfiguration) };
    set({ dspBusy: true, dspRejection: null });
    try {
      const result = await activeBridge.dspConfigure(request);
      set((state) => acceptedDspResult(result, state.playback?.dspExecution.revision ?? null));
    } catch (error) {
      set({ dspBusy: false, dspRejection: errorMessage(error) });
      get().notifyError(error, "应用 DSP 配置失败");
    }
  },
  async applyDspPreset(presetId) {
    set({ dspBusy: true, dspRejection: null });
    try {
      const result = await activeBridge.dspApplyPreset(presetId, nextDspRevision(get().dspConfiguration, get().dspPendingConfiguration));
      set((state) => acceptedDspResult(result, state.playback?.dspExecution.revision ?? null));
    } catch (error) {
      set({ dspBusy: false, dspRejection: errorMessage(error) });
      get().notifyError(error, "应用 DSP 预设失败");
    }
  },
  async importDspHse2(code) {
    set({ dspBusy: true, dspRejection: null });
    try {
      const result = await activeBridge.dspImportHse2(code, nextDspRevision(get().dspConfiguration, get().dspPendingConfiguration));
      set((state) => acceptedDspResult(result, state.playback?.dspExecution.revision ?? null));
    } catch (error) {
      set({ dspBusy: false, dspRejection: errorMessage(error) });
      get().notifyError(error, "导入 HSE2 失败");
    }
  },
  async exportDspHse2() {
    try {
      const result = await activeBridge.dspExportHse2();
      set({ dspUnsupportedStages: result.unsupportedStages });
      return result.code;
    } catch (error) {
      get().notifyError(error, "导出 HSE2 失败");
      throw error;
    }
  },
  async enqueueTrack(track, position = "contextEnd") {
    try {
      const playback = await activeBridge.enqueue(trackRefOf(track), position);
      set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
    catch (error) { get().notifyError(error, "无法将歌曲加入队列"); }
  },
  async removeQueueItem(queueItemId) {
    try {
      const playback = await activeBridge.removeQueueItem(queueItemId);
      set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
    catch (error) { get().notifyError(error, "无法移除队列歌曲"); }
  },
  async reorderQueueItem(queueItemId, targetIndex) {
    try {
      const playback = await activeBridge.reorderQueueItem(queueItemId, targetIndex);
      set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
    catch (error) { get().notifyError(error, "无法调整队列顺序"); }
  },
  async clearQueue(scope) {
    try {
      const playback = await activeBridge.clearQueue(scope);
      set((state) => acceptedPlaybackState(playback, state.dspDiagnostic));
    }
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
