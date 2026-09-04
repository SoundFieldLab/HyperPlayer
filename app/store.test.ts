import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsDto, BackendCacheStatusDto, BridgeContract, BridgeEventHandlers, DspApplyResultDto, DspConfigurationDto, NeteaseLoginStateDto, PlaybackSnapshotDto, Unlisten } from "./bridge/contracts";
import type { TelemetryTransport } from "./visualization/telemetry";

const memoryStorage = (() => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage;
})();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });

const settings: AppSettingsDto = {
  theme: "light",
  material: "clean",
  dynamicColor: true,
  reduceMotion: false,
  reduceTransparency: false,
  restoreQueue: true,
  autoPlayOnLaunch: false,
  neteaseEnabled: true,
  cacheCapacityBytes: 10 * 1024 * 1024 * 1024,
  cacheTrimPercent: 90,
  cacheRecentTrackLimit: 100,
  albumFillEnabled: true,
  albumFillQuality: "standard",
  dsp: null,
};

const playback: PlaybackSnapshotDto = {
  revision: "1",
  current: null,
  currentQueueItemId: null,
  status: "paused",
  positionMs: 0,
  durationMs: null,
  volume: 0.5,
  repeat: "sequence",
  shuffled: false,
  queue: [],
  nextUp: [],
  dspExecution: { revision: 0n, safeBypassActive: false, fault: null },
};

const dspConfiguration: DspConfigurationDto = {
  revision: "1",
  loudnessNormalization: { enabled: false, targetLufs: -14, maxGainDb: 9, minGainDb: -9, useRealtimeMeter: true, externalGainDb: 0 },
  surround3d: { enabled: false, distance: 0.5, speed: 1, angle: 0, direction: 1 },
  midSide: { enabled: false, stereoWidth: 1, voiceBalance: 0 },
  preEq: { enabled: true, bandCount: 1, qCompensation: true, stereoMode: "independent", bands: [{ frequency: 1000, gain: 0, q: 1.1 }] },
  deesser: { enabled: false, centerHz: 6000, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1 },
  compressor: { enabled: false, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1 },
  nightMode: { enabled: false, amount: 0 },
  delay: { enabled: false, delayMs: 250, feedback: 0.3, mix: 0.3 },
  chorus: { enabled: false, rateHz: 1, depthMs: 3, mix: 0.4 },
  flanger: { enabled: false, rateHz: 0.5, depthMs: 2, feedback: 0.4, mix: 0.5 },
  phaser: { enabled: false, rateHz: 0.5, depth: 0.5, feedback: 0.4, mix: 0.5, stages: 4 },
  tremolo: { enabled: false, rateHz: 5, depth: 0.5, mix: 1 },
  reverb: { enabled: false, mode: "algorithmic", reverbType: "hall", roomSize: 0.5, damping: 0.5, wet: 0.3, dry: 0.7, preDelayMs: 0, width: 1, fdnLines: 8, mix: 0.3, partitionSize: 512, shortRegionMs: 100 },
  bassEnhancer: { enabled: false, cutoffHz: 90, q: 0.7, harmonicType: "odd", harmonicGain: 0.6, mix: 0.5, levelDb: 0, lowBoostDb: 0 },
  loudnessComp: { enabled: false, mode: "auto", preset: "flat", volumePercent: 100, maxBoostDb: 12, smoothingSeconds: 0.2, bands: [] },
  dynamicEq: { enabled: false, strength: 1, thresholdDb: -20, ratio: 2, kneeDb: 6, attackMs: 20, releaseMs: 200, blockSize: 128, bands: [] },
  limiter: { enabled: false, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true },
  ieq: { enabled: false, strength: 0.5, targetCurve: "flat", timeConstantSec: 3 },
  modulation: { enabled: false, lfoShape: "sine", lfoRateHz: 1, lfoDepth: 0.5, envelopeAttackMs: 10, envelopeReleaseMs: 200, envelopeAmount: 0.5, routes: [] },
  spatial: { mode: "off", masterGain: 0.9 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockBridge(overrides: Partial<BridgeContract> = {}): BridgeContract {
  return {
    bootstrap: vi.fn(async () => ({ app: { appName: "HyperPlayer", appVersion: "0.1.0", platform: "windows", initialized: true }, settings, tasks: [], playback })),
    getPlayback: vi.fn(async () => playback),
    play: vi.fn(async () => playback),
    pause: vi.fn(async () => playback),
    stop: vi.fn(async () => playback),
    next: vi.fn(async () => playback),
    previous: vi.fn(async () => playback),
    setRepeatMode: vi.fn(async () => playback),
    seek: vi.fn(async () => playback),
    setVolume: vi.fn(async () => playback),
    enqueue: vi.fn(async () => playback),
    removeQueueItem: vi.fn(async () => playback),
    reorderQueueItem: vi.fn(async () => playback),
    clearQueue: vi.fn(async () => playback),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch) => ({ ...settings, ...patch })),
    dspGetConfiguration: vi.fn(async () => dspConfiguration),
    dspListPresets: vi.fn(async () => []),
    dspConfigure: vi.fn(async () => { throw new Error("not configured"); }),
    dspApplyPreset: vi.fn(async () => { throw new Error("not configured"); }),
    dspImportHse2: vi.fn(async () => { throw new Error("not configured"); }),
    dspExportHse2: vi.fn(async () => ({ code: "", unsupportedStages: [] })),
    lyricsGet: vi.fn(async () => ({ document: { lines: [] } })),
    cacheStatus: vi.fn(async (): Promise<BackendCacheStatusDto> => ({ status: "none", bytesUsed: 0, entryCount: 0, activeTasks: 0, lockedEntries: 0 })),
    cacheTrack: vi.fn(async () => undefined),
    cacheRemove: vi.fn(async () => undefined),
    cacheClear: vi.fn(async () => undefined),
    cacheStats: vi.fn(async () => ({ bytesUsed: 0, entryCount: 0, activeTasks: 0, lockedEntries: 0 })),
    shenzhenWeather: vi.fn(async () => ({ temperatureC: 31, humidityPercent: 72, weatherCode: 1, description: "多云", updatedAtMs: 1_700_000_000_000, isDay: true, condition: "多云", apparentTemperatureC: 35, relativeHumidityPercent: 72, windSpeedKmh: 8 })),
    createTelemetryTransport: vi.fn((): TelemetryTransport => ({
      open: vi.fn(),
      setRate: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    })),
    libraryOverview: vi.fn(async () => ({ trackCount: 0, albumCount: 0, artistCount: 0, scanActive: false })),
    libraryQuery: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    libraryQueryAlbums: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    libraryQueryArtists: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    libraryQueryFolders: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    libraryQueryRecent: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    libraryQueryPlaylists: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    libraryCreatePlaylist: vi.fn(async (name) => ({ id: "playlist", name, trackCount: 0, updatedUnixMs: 0 })),
    libraryRenamePlaylist: vi.fn(async (id, name) => ({ id, name, trackCount: 0, updatedUnixMs: 0 })),
    libraryDeletePlaylist: vi.fn(async () => undefined),
    libraryAddPlaylistTrack: vi.fn(async () => undefined),
    libraryRemovePlaylistTrack: vi.fn(async () => undefined),
    libraryReorderPlaylistTrack: vi.fn(async () => undefined),
    libraryEntityTracks: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    libraryArtwork: vi.fn(async (contentHash) => ({ contentHash, mimeType: "image/png", bytes: [] })),
    libraryRereadTags: vi.fn(async () => { throw new Error("not configured"); }),
    libraryRemoveFromLibrary: vi.fn(async () => ({ removedFromLibrary: false, movedToRecycleBin: false })),
    libraryMoveToRecycleBin: vi.fn(async () => ({ removedFromLibrary: false, movedToRecycleBin: false })),
    libraryPickLocation: vi.fn(async () => ({ selectionTicket: null, selected: false })),
    libraryRegisterLocation: vi.fn(async (selectionTicket) => ({ id: "location", path: selectionTicket })),
    libraryStartScan: vi.fn(async () => ({ taskId: "scan", accepted: true })),
    libraryCancelScan: vi.fn(async () => undefined),
    windowShow: vi.fn(async () => undefined),
    windowHide: vi.fn(async () => undefined),
    windowClose: vi.fn(async () => undefined),
    windowSetAlwaysOnTop: vi.fn(async () => undefined),
    desktopLyricsSetClickThrough: vi.fn(async () => undefined),
    windowsIntegrationStatus: vi.fn(async () => ({ platform: "windows", smtc: { available: false, reason: "test" }, mediaKeys: { available: false, reason: "test" }, fileAssociations: { available: false, reason: "test" } })),
    windowsEnableMediaControls: vi.fn(async () => undefined),
    windowsRegisterFileAssociations: vi.fn(async () => undefined),
    updaterStatus: vi.fn(async () => ({ enabled: false, reason: "disabled" })),
    updaterCheck: vi.fn(async () => ({ available: false, version: null, currentVersion: "0.1.0", notes: null })),
    updaterUpdate: vi.fn(async (_expectedVersion) => false),
    credentialGet: vi.fn(async () => null),
    credentialSet: vi.fn(async () => undefined),
    smtcUpdateMetadata: vi.fn(async () => undefined),
    smtcUpdatePlaybackState: vi.fn(async () => undefined),
    smtcUpdatePosition: vi.fn(async () => undefined),
    logWeb: vi.fn(async () => undefined),
    neteaseStatus: vi.fn(async () => ({ enabled: true, authenticated: false, userId: null, displayName: null })),
    neteaseAccount: vi.fn(async () => ({ user: { userId: 1, nickname: "", avatarUrl: null, signature: null }, vip: { active: false, level: null, verifiedAtMs: 0 } })),
    neteaseStartQrLogin: vi.fn(async () => ({ loginId: "login", qrImageDataUrl: "data:image/png;base64," })),
    neteasePollQrLogin: vi.fn(async (): Promise<NeteaseLoginStateDto> => ({ phase: "waiting" })),
    neteaseLogout: vi.fn(async () => undefined),
    neteaseHome: vi.fn(async () => ({ recommendedTracks: [], recommendedPlaylists: [], anonymous: true, unavailableSections: [] })),
    neteaseBanner: vi.fn(async () => []),
    neteaseCharts: vi.fn(async () => []),
    neteaseNewSongs: vi.fn(async () => ({ tracks: [] })),
    neteaseExploreNext: vi.fn(async () => ({ songs: [], batch: 1 })),
    neteaseSearch: vi.fn(async () => ({ tracks: [], albums: [], artists: [], playlists: [], nextCursor: null })),
    neteaseSearchHot: vi.fn(async () => []),
    neteaseSearchSuggest: vi.fn(async () => ({ songs: [] })),
    neteasePlaylistDetail: vi.fn(async (id) => ({ playlist: { id, name: "", coverUrl: null, trackCount: 0, playCount: 0, ownerName: null, description: null, updateFrequency: null }, tracks: [] })),
    neteaseAlbumDetail: vi.fn(async (id) => ({ album: { id, name: "", artistName: null, coverUrl: null, trackCount: 0, publishTimeMs: null }, artist: null, description: null, tracks: [] })),
    neteaseArtistDetail: vi.fn(async (id) => ({ artist: { id, name: "", aliases: [], imageUrl: null, fansCount: null }, fansCount: null, introduction: null, hotTracks: [] })),
    neteaseRelatedPlaylists: vi.fn(async () => ({ playlists: [], nextCursor: null })),
    neteaseSimilarArtists: vi.fn(async () => ({ artists: [], nextCursor: null })),
    neteasePlaymodeIntelligenceList: vi.fn(async () => ({ tracks: [] })),
    neteaseComments: vi.fn(async () => ({ comments: [], total: 0, nextCursor: null })),
    neteasePrepareMutation: vi.fn(async () => ({ confirmationToken: "token", summary: "测试" })),
    neteaseCommitMutation: vi.fn(async () => ({ succeeded: true })),
    neteaseFavorites: vi.fn(async () => ({ likedTrackIds: [], playlists: [] })),
    neteaseCloud: vi.fn(async () => ({ songs: [] })),
    neteaseAlbumSublist: vi.fn(async () => ({ albums: [] })),
    neteaseArtistSublist: vi.fn(async () => ({ artists: [] })),
    neteaseMvSublist: vi.fn(async () => ({ mvs: [] })),
    neteaseDjSublist: vi.fn(async () => ({ radios: [] })),
    neteaseMvs: vi.fn(async () => ({ items: [], nextCursor: null })),
    neteaseMvDetail: vi.fn(async (id) => ({ mv: { id, name: "", coverUrl: null, durationMs: null, playCount: 0, artists: [] }, description: null, favoriteCount: 0, commentCount: 0, publishTime: null })),
    neteaseMvPlayback: vi.fn(async () => ({ url: null })),
    neteaseDjRadios: vi.fn(async () => ({ radios: [], nextCursor: null })),
    neteaseDjPrograms: vi.fn(async () => ({ programs: [], nextCursor: null })),
    neteaseDjCategories: vi.fn(async () => ({ categories: [] })),
    neteaseDjRecommend: vi.fn(async () => ({ radios: [] })),
    neteaseDjProgramToplist: vi.fn(async () => ({ programs: [] })),
    neteaseNotices: vi.fn(async () => ({ items: [] })),
    neteaseFollowedEvents: vi.fn(async () => ({ items: [] })),
    neteaseFollows: vi.fn(async () => ({ users: [], nextCursor: null })),
    neteaseListenTotal: vi.fn(async () => ({ totalMinutes: 0, totalPlays: 0, songs: [] })),
    neteaseListenReport: vi.fn(async (period) => ({ period, endTime: null, stats: { totalMinutes: 0, totalPlays: 0, songs: [] } })),
    neteaseListenSongRank: vi.fn(async () => ({ tracks: [] })),
    neteaseScrobble: vi.fn(async () => undefined),
    neteaseImage: vi.fn(async () => ({ mimeType: "image/png", bytes: [] })),
    neteaseUpdatePlaylistCover: vi.fn(async () => undefined),
    resolveClose: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => (() => undefined) as Unlisten),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(async () => {
  const { setBridgeForTests, useAppStore } = await import("./store");
  useAppStore.getState().dispose();
  setBridgeForTests(null);
});

describe("app store", () => {
  it("subscribes before bootstrap and cleans the subscription when bootstrap fails", async () => {
    const calls: string[] = [];
    const unlisten = vi.fn();
    const testBridge = mockBridge({
      subscribe: vi.fn(async () => { calls.push("subscribe"); return unlisten; }),
      bootstrap: vi.fn(async () => { calls.push("bootstrap"); throw new Error("offline"); }),
    });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);

    await useAppStore.getState().init();

    expect(calls).toEqual(["subscribe", "bootstrap"]);
    expect(unlisten).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({ ready: false, initStatus: "error", initError: "offline" });
  });

  it("keeps events received while bootstrap is pending", async () => {
    const initial = deferred<{ app: { appName: string; appVersion: string; platform: string; initialized: boolean }; settings: AppSettingsDto; tasks: []; playback: PlaybackSnapshotDto }>();
    let handlers: BridgeEventHandlers = {};
    const testBridge = mockBridge({
      subscribe: vi.fn(async (nextHandlers) => { handlers = nextHandlers; return () => undefined; }),
      bootstrap: vi.fn(() => initial.promise),
    });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);

    const init = useAppStore.getState().init();
    await Promise.resolve();
    handlers.settingsChanged?.({ ...settings, theme: "dark" });
    handlers.playbackChanged?.({ ...playback, revision: "2", volume: 0.9 });
    handlers.playbackProgress?.({ revision: "2", positionMs: 450, durationMs: null });
    initial.resolve({ app: { appName: "HyperPlayer", appVersion: "0.1.0", platform: "windows", initialized: true }, settings, tasks: [], playback });
    await init;

    expect(useAppStore.getState().settings?.theme).toBe("dark");
    expect(useAppStore.getState().playback).toMatchObject({ revision: "2", volume: 0.9, positionMs: 450 });
  });

  it("commits only the latest seek response", async () => {
    const first = deferred<PlaybackSnapshotDto>();
    const second = deferred<PlaybackSnapshotDto>();
    const testBridge = mockBridge({ seek: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    useAppStore.setState({ playback });

    const firstRequest = useAppStore.getState().seek(100);
    const secondRequest = useAppStore.getState().seek(200);
    second.resolve({ ...playback, positionMs: 200 });
    await secondRequest;
    first.resolve({ ...playback, positionMs: 100 });
    await firstRequest;

    expect(useAppStore.getState().playback?.positionMs).toBe(200);
  });

  it("commits only the latest transport response across commands", async () => {
    const oldNext = deferred<PlaybackSnapshotDto>();
    const newRepeat = deferred<PlaybackSnapshotDto>();
    const testBridge = mockBridge({
      next: vi.fn(() => oldNext.promise),
      setRepeatMode: vi.fn(() => newRepeat.promise),
    });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    useAppStore.setState({ playback });

    const nextRequest = useAppStore.getState().next();
    const repeatRequest = useAppStore.getState().setRepeat("one");
    newRepeat.resolve({ ...playback, repeat: "one", positionMs: 30 });
    await repeatRequest;
    oldNext.resolve({ ...playback, repeat: "sequence", positionMs: 10 });
    await nextRequest;

    expect(useAppStore.getState().playback).toMatchObject({ repeat: "one", positionMs: 30 });
  });

  it("surfaces command failures as visible toast state", async () => {
    const testBridge = mockBridge({ next: vi.fn(async () => { throw { code: "offline", message: "服务离线" }; }) });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    useAppStore.setState({ playback });

    await useAppStore.getState().next();

    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("服务离线");
  });

  it("commits a DSP configuration when the applied response returns", async () => {
    const resultConfiguration = { ...dspConfiguration, revision: "2" };
    const result: DspApplyResultDto = {
      revision: "2",
      status: "applied",
      partial: false,
      unsupportedStages: [],
      engine: { dspExecution: { revision: 2n } },
      configuration: resultConfiguration,
    };
    const testBridge = mockBridge({ dspConfigure: vi.fn(async () => result) });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    useAppStore.setState({ dspConfiguration, playback });

    await useAppStore.getState().configureDsp(dspConfiguration);

    expect(useAppStore.getState()).toMatchObject({
      dspConfiguration: resultConfiguration,
      dspPendingConfiguration: null,
      dspBusy: false,
    });
  });

  it("carries reverb, loudnessComp, dynamicEq and limiter fields through dspConfigure", async () => {
    const updated: DspConfigurationDto = {
      ...dspConfiguration,
      revision: "2",
      reverb: { ...dspConfiguration.reverb, enabled: true, mode: "fdn", fdnLines: 16 },
      loudnessComp: {
        ...dspConfiguration.loudnessComp,
        enabled: true,
        mode: "custom",
        bands: [{ frequency: 1_000, gain: 6 }],
      },
      dynamicEq: { ...dspConfiguration.dynamicEq, enabled: true, ratio: 8 },
      limiter: { ...dspConfiguration.limiter, enabled: true, truePeak: false },
    };
    const dspConfigure = vi.fn(async (configuration: DspConfigurationDto): Promise<DspApplyResultDto> => ({
      revision: "2",
      status: "applied",
      partial: false,
      unsupportedStages: [],
      engine: { dspExecution: { revision: 2n } },
      configuration,
    }));
    const testBridge = mockBridge({ dspConfigure });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    useAppStore.setState({ dspConfiguration, playback });

    await useAppStore.getState().configureDsp(updated);

    const applied = dspConfigure.mock.calls[0][0];
    expect(applied.reverb).toMatchObject({ enabled: true, mode: "fdn", fdnLines: 16 });
    expect(applied.loudnessComp).toMatchObject({ mode: "custom", bands: [{ frequency: 1_000, gain: 6 }] });
    expect(applied.dynamicEq).toMatchObject({ enabled: true, ratio: 8 });
    expect(applied.limiter).toMatchObject({ enabled: true, truePeak: false });
    expect(useAppStore.getState().dspConfiguration).toMatchObject({ revision: "2" });
  });

  it("surfaces asynchronous DSP preparation rejection with its revision", async () => {
    let handlers: BridgeEventHandlers = {};
    const testBridge = mockBridge({
      subscribe: vi.fn(async (nextHandlers) => { handlers = nextHandlers; return () => undefined; }),
    });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);

    await useAppStore.getState().init();
    const pendingConfiguration = { ...dspConfiguration, revision: "7" };
    useAppStore.setState({ dspPendingConfiguration: pendingConfiguration });
    handlers.dspConfigurationRejected?.({
      revision: "7",
      code: "compilationFailed",
      reason: "DSP configuration could not be compiled for the active audio format",
      stage: "compile",
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("DSP 配置 revision 7 被拒绝");
  });

  it("commits only the latest volume response", async () => {
    const firstVolume = deferred<PlaybackSnapshotDto>();
    const secondVolume = deferred<PlaybackSnapshotDto>();
    const testBridge = mockBridge({
      setVolume: vi.fn().mockReturnValueOnce(firstVolume.promise).mockReturnValueOnce(secondVolume.promise),
    });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    useAppStore.setState({ playback });

    const firstRequest = useAppStore.getState().setVolume(0.4);
    const secondRequest = useAppStore.getState().setVolume(0.8);
    secondVolume.resolve({ ...playback, volume: 0.8 });
    await secondRequest;
    firstVolume.resolve({ ...playback, volume: 0.4 });
    await firstRequest;

    expect(useAppStore.getState().playback?.volume).toBe(0.8);
  });

  it("scrobbles a netease track after 30s of playback when the track ends", async () => {
    const neteaseScrobble = vi.fn(async () => undefined);
    const testBridge = mockBridge({ neteaseScrobble });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    vi.useFakeTimers();
    try {
      let handlers: BridgeEventHandlers = {};
      const testBridgeWithHandlers = mockBridge({
        neteaseScrobble,
        subscribe: vi.fn(async (nextHandlers) => { handlers = nextHandlers; return () => undefined; }),
      });
      setBridgeForTests(testBridgeWithHandlers);
      await useAppStore.getState().init();

      const neteaseTrack = {
        id: "42",
        title: "歌",
        artists: ["人"],
        album: "专辑",
        durationMs: 120_000,
        source: "netease" as const,
        entitlement: "free" as const,
        quality: "标准" as const,
        cache: "none" as const,
        coverSeed: "",
      };
      handlers.playbackChanged?.({ ...playback, revision: "2", status: "playing", current: neteaseTrack });
      vi.advanceTimersByTime(35_000);
      handlers.playbackChanged?.({ ...playback, revision: "3", status: "stopped", current: null });
      await Promise.resolve();
      expect(neteaseScrobble).toHaveBeenCalledWith({ songId: 42, sourceId: 42, playedSeconds: 35 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not scrobble non-netease tracks", async () => {
    const neteaseScrobble = vi.fn(async () => undefined);
    const { setBridgeForTests, useAppStore } = await import("./store");
    vi.useFakeTimers();
    try {
      let handlers: BridgeEventHandlers = {};
      const testBridgeWithHandlers = mockBridge({
        neteaseScrobble,
        subscribe: vi.fn(async (nextHandlers) => { handlers = nextHandlers; return () => undefined; }),
      });
      setBridgeForTests(testBridgeWithHandlers);
      await useAppStore.getState().init();

      const localTrack = {
        id: "1",
        title: "歌",
        artists: ["人"],
        album: "专辑",
        durationMs: 120_000,
        source: "local" as const,
        entitlement: "free" as const,
        quality: "标准" as const,
        cache: "none" as const,
        coverSeed: "",
      };
      handlers.playbackChanged?.({ ...playback, revision: "2", status: "playing", current: localTrack });
      vi.advanceTimersByTime(35_000);
      handlers.playbackChanged?.({ ...playback, revision: "3", status: "stopped", current: null });
      await Promise.resolve();
      expect(neteaseScrobble).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
