/**
 * wiring —— 服务装配（完整：音频链 + 播放 + 队列 + 缓存 + 设置 + 曲库 + 网易云 + 系统集成）。
 * 原生能力全部经 infra 薄封装；vendored 网易云 API 注入浏览器传输与存储。
 * 本文件被入口引用，确保 vendored CJS 进入打包图并经受 vite 转译验证。
 */
import { createTauriDirectoryDialog } from '../infra/dialog';
import type { DirectoryDialog } from '../infra/dialog';
import { appDataPath } from '../infra/paths';
import { toAssetUrl } from '../infra/assetUrl';
import { createTauriHttp } from '../infra/tauriHttp';
import type { TauriHttp } from '../infra/tauriHttp';
import { createTauriFs } from '../infra/tauriFs';
import type { TauriFs } from '../infra/tauriFs';
import { createTauriStore } from '../infra/tauriStore';
import type { KeyValueStore } from '../infra/tauriStore';
import { loadSqlDatabase } from '../infra/tauriSql';
import type { SqlDatabase } from '../infra/tauriSql';
import { createIdbCache } from '../infra/idbCache';
import type { CacheStore } from '../infra/idbCache';
import { createVault } from '../infra/vault';
import type { Vault } from '../infra/vault';
import { getOrCreateVaultPassword } from '../infra/vaultPassword';
import { wireNeteaseApi, createNeteaseApi, fetchXeapiPublicKey } from '../domains/netease/api/neteaseApi';
import type { NeteaseApi } from '../domains/netease/api/neteaseApi';
import { SessionService } from '../domains/netease/SessionService';
import { NeteaseService } from '../domains/netease/NeteaseService';
import type { SongUrlResult } from '../domains/netease/NeteaseService';
import { HseController } from '../domains/player/HseController';
import { TelemetryTap } from '../domains/player/TelemetryTap';
import { AudioEngineController } from '../domains/player/AudioEngineController';
import { LyricsTimeline } from '../domains/player/LyricsTimeline';
import { createLyricsFetchers } from '../domains/player/lyrics/LyricsFetchers';
import { DualElementSource } from '../domains/player/DualElementSource';
import { PlaybackStateMachine } from '../domains/player/PlaybackStateMachine';
import { QueueController } from '../domains/player/QueueController';
import { PlayerController } from '../services/PlayerController';
import { StreamCacheService } from '../services/StreamCacheService';
import { SettingsService } from '../services/SettingsService';
import { ScanMachine } from '../domains/library/ScanMachine';
import { LibraryService } from '../domains/library/LibraryService';
import { createMetadataWorkerParser } from '../domains/library/metadataWorkerFactory';
import { DspService } from '../domains/dsp/DspService';
import { TaskCenter } from '../services/TaskCenter';
import { AlbumCompletionService } from '../services/AlbumCompletionService';
import { PlayHistoryService } from '../services/PlayHistoryService';
import { ShortcutService } from '../services/ShortcutService';
import { TrayService } from '../services/TrayService';
import { NotificationService } from '../services/NotificationService';
import { createTauriShortcuts } from '../infra/shortcuts';
import { createTauriTray, createTauriWindowControl } from '../infra/tray';
import type { WindowControl } from '../infra/tray';
import { createTauriNotifications } from '../infra/notifications';
import { createTauriSingleInstance } from '../infra/singleInstance';
import { AutostartService } from '../services/AutostartService';
import { UpdateService } from '../services/UpdateService';
import { createTauriAutostart } from '../infra/autostart';
import { createTauriUpdater } from '../infra/updater';
import { useAppStore } from '../stores/store';
import { useLibraryStore } from '../stores/slices/library';
import { useDspStore } from '../stores/slices/dsp';
import { useNeteaseStore } from '../stores/slices/netease';
import { useTasksStore } from '../stores/slices/tasks';
import { useSessionStore } from '../stores/slices/session';
import { RingBufferLogger } from '../shared/logger';
import { FileLogger } from '../shared/fileLogger';
import { DiagnosticsService } from '../services/DiagnosticsService';
import { CoverService } from '../services/CoverService';
import { CloudPlaylistSyncService } from '../services/CloudPlaylistSyncService';
import { getAppVersion } from '../infra/appInfo';
import type { QueueItem } from '../domains/player/types';

export interface Services {
  http: TauriHttp;
  fs: TauriFs;
  dialog: DirectoryDialog;
  store: KeyValueStore;
  sql: SqlDatabase;
  idb: CacheStore;
  vault: Vault;
  api: NeteaseApi;
  session: SessionService;
  netease: NeteaseService;
  hse: HseController;
  telemetry: TelemetryTap;
  lyrics: LyricsTimeline;
  audio: AudioEngineController;
  elements: DualElementSource;
  stateMachine: PlaybackStateMachine;
  queue: QueueController;
  settings: SettingsService;
  cache: StreamCacheService;
  library: LibraryService;
  scanMachine: ScanMachine;
  taskCenter: TaskCenter;
  dsp: DspService;
  albumCompletion: AlbumCompletionService;
  playHistory: PlayHistoryService;
  shortcut: ShortcutService;
  tray: TrayService;
  trayWindow: WindowControl;
  notification: NotificationService;
  autostart: AutostartService;
  updater: UpdateService;
  diagnostics: DiagnosticsService;
  covers: CoverService;
  cloudPlaylistSync: CloudPlaylistSyncService;
  player: PlayerController;
  disposeSubscriptions: () => void;
}

/**
 * stronghold 解锁密码（后端补充规划 #47）：首启生成随机强密码存 store，
 * 重启复用；Rust 侧 Builder::with_argon2 派生密钥。
 */
const ANONYMOUS_TOKEN_KEY = 'netease.anonymousToken';
const DEVICE_ID_KEY = 'netease.deviceId';
const XEAPI_PUBLIC_KEY_KEY = 'netease.xeapiPublicKey';

/** 52 位大写十六进制设备 id（官方客户端同构），首启生成、持久复用。 */
async function getOrCreateDeviceId(store: KeyValueStore): Promise<string> {
  const existing = await store.get<string>(DEVICE_ID_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  const deviceId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  await store.set(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

/**
 * 真实匿名 token（MUSIC_A）：此处只读 store，注册由 initServices 尾部的后台任务
 * 完成——若在请求内联注册会经 request.js 的 getAnonymousToken 递归自等待。
 * 上一版实现伪造过 'hyperplayer-*' 假 token（无效凭据是风控拦截诱因），视为不存在。
 */
async function readAnonymousToken(store: KeyValueStore): Promise<string> {
  const existing = await store.get<string>(ANONYMOUS_TOKEN_KEY);
  if (existing && !existing.startsWith('hyperplayer-')) return existing;
  return '';
}

/** 匿名 token：首次启动后台调 register_anonimous（xeapi）获取服务端签发的真实 token。 */
async function registerAnonymousToken(store: KeyValueStore, netease: NeteaseService, logger: RingBufferLogger): Promise<void> {
  if (await readAnonymousToken(store)) return;
  try {
    const answer = await netease.call('register_anonimous', {}, { retries: 1, timeoutMs: 12_000 });
    const cookieSources: string[] = [...(answer.cookie ?? [])];
    const bodyCookie = (answer.body as { cookie?: unknown } | undefined)?.cookie;
    if (typeof bodyCookie === 'string') cookieSources.push(bodyCookie);
    const raw = /MUSIC_A=([^;]+)/.exec(cookieSources.join(';'))?.[1] ?? '';
    if (!raw) {
      // FileLogger 会脱敏含 cookie/token 字样的键，这里用位置参数输出形态信息
      logger.warn(
        'netease: 匿名注册响应未含 MUSIC_A，匿名态将以无 token 请求',
        'setCookieCount=' + (answer.cookie?.length ?? 0),
        'bodyCode=' + String((answer.body as { code?: unknown } | undefined)?.code),
        'bodyKeys=' + (answer.body && typeof answer.body === 'object' ? Object.keys(answer.body).join('|').slice(0, 80) : typeof answer.body),
      );
      return;
    }
    let token = raw;
    try {
      token = decodeURIComponent(raw);
    } catch {
      token = raw; // 非法 % 序列：原样保留
    }
    await store.set(ANONYMOUS_TOKEN_KEY, token);
    logger.info('netease: 匿名注册成功，MUSIC_A 已持久化');
  } catch (error) {
    logger.warn('netease: 匿名注册失败（将以无 MUSIC_A 请求，下次启动重试）', error);
  }
}

export async function initServices(): Promise<Services> {
  const http = createTauriHttp();
  const fs = createTauriFs();
  const dialog = createTauriDirectoryDialog();
  const store = await createTauriStore('hyperplayer.json');
  const sql = await loadSqlDatabase('sqlite:hyperplayer.db');
  const idb = await createIdbCache('hyperplayer-cache');
  const vaultPath = await appDataPath('hyperplayer.stronghold');
  const deviceId = await getOrCreateDeviceId(store);
  let vault: Vault;
  try {
    vault = await createVault({
      path: vaultPath,
      password: await getOrCreateVaultPassword(store),
    });
  } catch {
    // vault 文件与 store 密码失配（store 被清空/损坏时密码重新生成）：
    // 删除旧 vault 文件重建，凭据（网易云 cookie）需重新登录，应用可正常启动。
    console.warn('vault: 密码与 vault 文件失配，删除重建（登录凭据将失效）');
    await fs.removeFile(vaultPath).catch(() => {});
    vault = await createVault({
      path: vaultPath,
      password: await getOrCreateVaultPassword(store),
    });
  }

  // —— 日志（后端补充规划 #46：环形缓冲 500 条 + 文件滚动落盘，全部服务共享）——
  const fileLogger = new FileLogger({ fs, dir: await appDataPath('logs') });
  await fileLogger.init();
  const logger = new RingBufferLogger(500, fileLogger);

  // —— 网易云协议层 ——
  const request = wireNeteaseApi(http, {
    getAnonymousToken: () => readAnonymousToken(store),
    getXeapiPublicKey: async () => {
      const cached = await store.get<{ version?: string; publicKey: string; sk: string }>(XEAPI_PUBLIC_KEY_KEY);
      if (cached?.publicKey && cached.sk) return cached;
      const key = await fetchXeapiPublicKey(deviceId);
      await store.set(XEAPI_PUBLIC_KEY_KEY, key).catch(() => {});
      return key;
    },
  });
  const api = createNeteaseApi(request);
  const session = new SessionService({
    api,
    vault,
    onStateChange: (state) => {
      useNeteaseStore.getState().setSessionState(state);
      useSessionStore.getState().setSessionState(state);
    },
    onNotice: (message) => useSessionStore.getState().setSessionNotice(message),
    logger,
  });
  const netease = new NeteaseService({ api, session, logger, defaultCookie: { deviceId, sDeviceId: deviceId } });
  const lyrics = new LyricsTimeline({
    cache: idb,
    onWordIndex: (index) => useAppStore.getState().setCurrentWordIndex(index),
  });
  const lyricsFetchers = createLyricsFetchers({ fs, netease });
  const settings = new SettingsService({ store, logger });

  // —— 音频链（规格书：source→HSE→analyser→tap→outputGain→destination）——
  const hse = new HseController();
  const telemetry = new TelemetryTap();
  const audio = new AudioEngineController({
    hse,
    telemetry,
    readPosition: () => elements.active.currentTime,
    writePosition: (position) => useAppStore.getState().setPosition(position),
    onPosition: (position) => lyrics.indexAt(position),
    onSinkError: (message) => useSessionStore.getState().setSessionNotice(message),
    initialOutputVolume: () => settings.snapshot.muted ? 0 : settings.snapshot.volume,
    preferredSinkId: () => settings.snapshot.outputDevice,
  });
  const elements = new DualElementSource(() => {
    const element = document.createElement('audio');
    // 跨域音源（网易云 CDN / asset 协议）接入 Web Audio 必须以 CORS 模式加载，
    // 否则 MediaElementSource 视为污染资源、输出静默（有画面无声的经典成因）。
    element.crossOrigin = 'anonymous';
    return element;
  });
  const stateMachine = new PlaybackStateMachine({ logger });
  const queue = new QueueController({
    keepUpNextOnContextSwitch: () => settings.snapshot.keepUpNextOnContextSwitch,
  });
  const unsubscribeSettings = settings.subscribe((next) => {
    useAppStore.getState().setSettings(next);
    lyrics.setOffsetMs(settings.lyricOffsetFor(useAppStore.getState().track?.id));
  });

  // —— 状态中心统一任务模型（UI-D29） ——
  const taskCenter = new TaskCenter({ logger });
  const unsubscribeTasks = taskCenter.subscribe(() => {
    useTasksStore.getState().setTasks(taskCenter.list());
  });
  const subscriptionDisposers: Array<() => void> = [unsubscribeSettings, unsubscribeTasks];
  subscriptionDisposers.push(useAppStore.subscribe((state, previous) => {
    if (state.currentEntry === previous.currentEntry || !state.currentEntry || state.currentEntry.routeId === 'onboarding') return;
    void settings.persistLastPage({ domain: state.activeDomain, entry: state.currentEntry });
  }));

  // —— 缓存 + 曲库 ——
  const cache = new StreamCacheService({
    http,
    fs,
    sql,
    cacheDir: await appDataPath('stream-cache'),
    capacityBytes: () => settings.snapshot.cacheCapacityBytes,
    verifyEntitlement: async (trackId, ownerUserId) => {
      // 权益缓存播放前重验证（P4 简化：登录态有效即视为权益有效；M3 细化 VIP 校验）
      return session.isLoggedIn && session.getCookie()?.userId === ownerUserId;
    },
    taskCenter,
    logger,
  });
  // —— 封面链路（后端补充规划 #23：worker 提取 → 专辑键去重落盘 → asset 供给）——
  const covers = new CoverService({
    fs,
    sql,
    coversDir: await appDataPath('covers'),
    logger,
  });
  await covers.init();

  const library = new LibraryService(sql);
  const scanMachine = new ScanMachine({
    fs,
    sql,
    parseMetadata: createMetadataWorkerParser(),
    taskCenter,
    onStateChange: (state) => useLibraryStore.getState().setScanState(state),
    saveCover: (picture, albumKey, mime) => covers.ensureCover(albumKey, picture, mime).then(() => undefined),
    logger,
  });

  // —— M4 音效工作台后端（DSP 跨模式全局，UI-D1） ——
  const dsp = new DspService({
    hse,
    sampleRate: 44100,
    onStateChange: (state) => useDspStore.getState().setFromService(state),
    logger,
  });
  const albumCompletion = new AlbumCompletionService({
    cache,
    netease,
    session,
    taskCenter,
    logger,
  });

  // —— 本地播放历史（后端补充规划 #48：每曲首次 playing 记录，同曲不重复）——
  const playHistory = new PlayHistoryService({ sql, logger });
  await playHistory.init();
  subscriptionDisposers.push(playHistory.attach(stateMachine));

  // —— 播放器（完整 resolveSource 链：本地 → 缓存 → 网易云直链 + 边播边缓存）——
  const resolveSource = async (track: QueueItem) => {
    if (track.source === 'local' && track.localPath) {
      return { url: toAssetUrl(track.localPath), kind: 'local' as const };
    }
    const cached = await cache.getPlayable(track);
    if (cached) return { url: toAssetUrl(cached.filePath), kind: 'local' as const };
    const result = (await netease.route('/netease/song/url', {
      id: track.id,
      quality: track.quality ?? 'auto',
      vip: session.isLoggedIn,
    })) as SongUrlResult;
    const url = result.data?.[0]?.url;
    if (!url) {
      throw new Error(result.fallbackBlocked === 'paid-content' ? '付费内容，需要 VIP 权益' : '获取播放链接失败');
    }
    // 边播边缓存（异步写盘，不阻塞播放）
    void cache.ensureCached(track, url, {
      ownerUserId: session.isLoggedIn ? String(session.getCookie()?.userId ?? '') : null,
    });
    return { url, kind: 'stream' as const };
  };

  let lyricTrackId: string | null = null;
  const player = new PlayerController({
    stateMachine,
    elements,
    queue,
    audio,
    resolveSource,
    prefetch: async (track) => {
      // 下一曲预取：直链预解析 + 缓存流提前写（UI-D43 优先级由 QueueController.peekNext 保证）
      const cached = await cache.getPlayable(track);
      if (cached) return;
      try {
        const result = (await netease.route('/netease/song/url', {
          id: track.id,
          quality: track.quality ?? 'auto',
          vip: session.isLoggedIn,
        })) as SongUrlResult;
        const url = result.data?.[0]?.url;
        if (url) {
          await cache.ensureCached(track, url, {
            ownerUserId: session.isLoggedIn ? String(session.getCookie()?.userId ?? '') : null,
          });
        }
      } catch {
        // 预取失败不阻塞播放
      }
    },
    autoSkipOnError: () => settings.snapshot.autoSkipOnError,
    onPlaybackChange: (state) => {
      const storeState = useAppStore.getState();
      storeState.setStatus(state.status);
      storeState.setTrack(state.track);
      storeState.setError(state.error);
      if (state.track) {
        if (lyricTrackId === state.track.id) return;
        lyricTrackId = state.track.id;
        const fetchLyrics = state.track.source === 'local' && state.track.localPath
          ? () => lyricsFetchers.local(state.track?.localPath ?? '')
          : lyricsFetchers.netease;
        const trackId = state.track.id;
        lyrics.setOffsetMs(settings.lyricOffsetFor(trackId));
        void lyrics.load(trackId, fetchLyrics).catch(() => {
          if (lyricTrackId !== trackId) return;
          useAppStore.getState().setCurrentWordIndex(-1);
        });
      } else {
        lyricTrackId = null;
        lyrics.clear();
        storeState.setCurrentWordIndex(-1);
      }
    },
    onQueueChange: (state) => {
      useAppStore.getState().setFromController(state);
      settings.scheduleQueuePersist(state); // 队列持久化 2s 防抖（UI-D76）
    },
    onDurationChange: (duration) => useAppStore.getState().setDuration(duration),
    logger,
  });

  // —— 全局快捷键（后端补充规划 #7/#8：媒体键回退接线，SMTC v1 缺席）——
  const transportCommands = {
    playPause: async () => {
      if (stateMachine.snapshot.status === 'playing') await player.pause();
      else await player.play();
    },
    next: () => player.next(),
    prev: () => player.prev(),
  };
  const shortcut = new ShortcutService({
    shortcuts: createTauriShortcuts(),
    settings,
    commands: transportCommands,
    logger,
  });
  await shortcut.init();
  subscriptionDisposers.push(settings.subscribe(() => {
    void shortcut.rebind(); // 快捷键设置变更即时生效
  }));

  // —— 系统托盘（UI-D77：菜单 + 关闭拦截）+ 桌面通知（后端补充规划 #42/#43）——
  const trayWindow = createTauriWindowControl();
  const tray = new TrayService({
    tray: createTauriTray(),
    window: trayWindow,
    settings,
    commands: transportCommands,
    logger,
  });
  try {
    await tray.init();
  } catch (error) {
    // 托盘失败（如图标环境异常）不阻塞启动，仅降级为无托盘。
    logger.warn('tray: 初始化失败，已降级为无托盘运行', error);
  }

  const notification = new NotificationService({
    notifications: createTauriNotifications(),
    settings,
    logger,
  });
  // 切歌通知：仅在有歌词变化语义的换曲时触发（track 变更，非暂停恢复）
  let notifiedTrackId: string | null = null;
  subscriptionDisposers.push(stateMachine.subscribe((state) => {
    if (state.status === 'playing' && state.track && state.track.id !== notifiedTrackId) {
      notifiedTrackId = state.track.id;
      void notification.notifyTrackChange(state.track);
    }
  }));

  // —— 单实例（后端补充规划 #40：聚焦已有窗口 + 载荷透传；文件打开 #41 留待后续）——
  const singleInstance = createTauriSingleInstance(trayWindow);
  subscriptionDisposers.push(await singleInstance.onSecondInstance((payload) => {
    console.info(`single-instance: 二次启动聚焦（args=${payload.args.length}，cwd=${payload.cwd}）`);
  }));

  // —— 开机自启 + 应用更新（后端补充规划 #39/#54）——
  const autostart = new AutostartService({
    autostart: createTauriAutostart(),
    settings,
    logger,
  });
  await autostart.init();
  subscriptionDisposers.push(settings.subscribe(() => {
    // 设置页自启开关直接走 setAutostart；此处兜底外部对 settings 的直接改写
    void autostart.init();
  }));

  const updater = new UpdateService({
    updater: createTauriUpdater(),
    taskCenter,
    logger,
  });

  // —— 诊断导出（后端补充规划 #46：app 版本 + 脱敏设置 + 全量日志 → $APPDATA/diagnostics）——
  const diagnostics = new DiagnosticsService({
    fs,
    logger: fileLogger,
    settings,
    dir: await appDataPath('diagnostics'),
    appVersion: await getAppVersion(),
  });

  // —— 云歌单同步（后端补充规划 #33：远程为权威的本地缓存 + 30 分钟自动刷新）——
  const cloudPlaylistSync = new CloudPlaylistSyncService({
    netease,
    session,
    sql,
    taskCenter,
    logger,
  });
  await cloudPlaylistSync.init();
  cloudPlaylistSync.startAutoSync();

  // —— 真实匿名注册（后台一次，为后续请求提供服务端签发的 MUSIC_A）——
  void registerAnonymousToken(store, netease, logger);

  return { http, fs, dialog, store, sql, idb, vault, api, session, netease, hse, telemetry, lyrics, audio, elements, stateMachine, queue, settings, cache, library, scanMachine, taskCenter, dsp, albumCompletion, playHistory, shortcut, tray, trayWindow, notification, autostart, updater, diagnostics, covers, cloudPlaylistSync, player, disposeSubscriptions: () => { for (const dispose of subscriptionDisposers) dispose(); } };
}
