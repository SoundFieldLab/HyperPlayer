import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsDto, BridgeContract, BridgeEventHandlers, DspApplyResultDto, DspConfigurationDto, PlaybackSnapshotDto, Unlisten } from "./bridge/contracts";
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
};

const playback: PlaybackSnapshotDto = {
  revision: 1,
  current: null,
  currentQueueItemId: null,
  status: "paused",
  positionMs: 0,
  volume: 0.5,
  queue: [],
  nextUp: [],
  repeat: "sequence",
  dsp: { available: true, bypassed: true, label: "Rust DSP runtime 已内建；完整 22 阶段与 DspPort 尚未接通" },
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
  dynamicEq: { enabled: false, strength: 1, thresholdDb: -20, ratio: 2, kneeDb: 6, attackMs: 20, releaseMs: 200, blockSize: 128, bands: [
    { enabled: true, frequency: 200, targetGainDb: 0 },
    { enabled: true, frequency: 800, targetGainDb: 0 },
    { enabled: true, frequency: 2500, targetGainDb: 0 },
    { enabled: true, frequency: 8000, targetGainDb: 0 },
    { enabled: true, frequency: 0, targetGainDb: 0 },
  ] },
  limiter: { enabled: false, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true },
  ieq: { enabled: false, strength: 0.5, targetCurve: "flat", timeConstantSec: 3 },
  modulation: { enabled: false, lfoShape: "sine", lfoRateHz: 1, lfoDepth: 0.5, envelopeAttackMs: 10, envelopeReleaseMs: 200, envelopeAmount: 0.5, routes: [] },
  lufsMetering: { mode: "hseV151" },
  spatial: { mode: "off", masterGain: 0.9, instantAmount: 0.7, instantSpreadDeg: 60, instantRoom: "studio", instantRoomAmount: 0.15, distanceModel: "inverse", refDistance: 1, maxDistance: 50, convolution: "partitioned", hrtfInterp: "nearest", stagePreset: "stage", seat: "middle", stageRoomSize: 1, stageReverbAmount: 0.35, worldOcclusion: 0, ambienceEnabled: false, ambienceAmount: 0.3 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockBridge(overrides: Partial<BridgeContract> = {}): BridgeContract {
  return {
    bootstrap: vi.fn(async () => ({ playback, settings, tasks: [] })),
    getPlayback: vi.fn(async () => playback),
    play: vi.fn(async () => playback),
    pause: vi.fn(async () => playback),
    stop: vi.fn(async () => playback),
    next: vi.fn(async () => playback),
    previous: vi.fn(async () => playback),
    setRepeatMode: vi.fn(async () => playback),
    seek: vi.fn(async () => playback),
    setVolume: vi.fn(async () => playback),
    getSettings: vi.fn(async () => settings),
    dspGetConfiguration: vi.fn(async () => { throw new Error("not configured"); }),
    dspConfigure: vi.fn(async () => { throw new Error("not configured"); }),
    dspListPresets: vi.fn(async () => []),
    dspApplyPreset: vi.fn(async () => { throw new Error("not configured"); }),
    dspImportHse2: vi.fn(async () => { throw new Error("not configured"); }),
    dspExportHse2: vi.fn(async () => ({ code: "", scope: "current22StageProjection" as const, unsupportedStages: [] })),
    updateSettings: vi.fn(async (patch) => ({ ...settings, ...patch })),
    enqueue: vi.fn(async () => playback),
    removeQueueItem: vi.fn(async () => playback),
    reorderQueueItem: vi.fn(async () => playback),
    clearQueue: vi.fn(async () => playback),
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
    neteaseStatus: vi.fn(async () => ({ enabled: true, authenticated: false, userId: null, displayName: null })),
    neteaseSearch: vi.fn(async () => ({ tracks: [], nextCursor: null })),
    neteaseMvs: vi.fn(async () => ({ items: [], nextCursor: null })),
    neteaseMvDetail: vi.fn(async (id) => ({ mv: { id, name: "", coverUrl: null, durationMs: null, artists: [], playCount: null }, description: null, publishTime: null, favoriteCount: null, commentCount: null })),
    neteaseDjRadios: vi.fn(async () => ({ radios: [], programs: [], nextCursor: null })),
    neteaseDjPrograms: vi.fn(async () => ({ radios: [], programs: [], nextCursor: null })),
    neteaseCharts: vi.fn(async () => []),
    neteaseNewSongs: vi.fn(async () => ({ tracks: [] })),
    neteaseHome: vi.fn(async () => ({ recommendedTracks: [], recommendedPlaylists: [], anonymous: true, unavailableSections: [] })),
    neteaseAlbumDetail: vi.fn(async (id) => ({ album: { id, name: "", coverUrl: null }, description: null, publishTimeMs: null, artist: null, tracks: [] })),
    neteasePlaylistDetail: vi.fn(async (id) => ({ playlist: { id, name: "", coverUrl: null, trackCount: 0, playCount: null, ownerId: 0, ownerName: null, description: null }, tracks: [] })),
    neteaseArtistDetail: vi.fn(async (id) => ({ artist: { id, name: "", imageUrl: null, aliases: [], briefDescription: null }, hotTracks: [], introduction: null, fansCount: null })),
    neteasePersonalFm: vi.fn(async () => ({ tracks: [] })),
    neteaseAccount: vi.fn(async () => ({ user: { userId: 1, nickname: "", avatarUrl: null }, vip: { active: false, expiresAtMs: null, level: null, verifiedAtMs: 0 } })),
    neteaseFavorites: vi.fn(async () => ({ likedTrackIds: [], playlists: [] })),
    neteaseComments: vi.fn(async () => ({ comments: [], totalCount: 0, hasMore: false, nextCursor: null })),
    neteaseFollows: vi.fn(async () => ({ users: [], nextCursor: null })),
    neteaseCloud: vi.fn(async () => ({ songs: [], totalCount: 0, hasMore: false, nextCursor: null })),
    neteaseImage: vi.fn(async () => ({ mimeType: "image/png", bytes: [] })),
    neteaseStartQrLogin: vi.fn(async () => ({ loginId: "login", qrImageDataUrl: "data:image/png;base64,", expiresAt: "" })),
    neteasePollQrLogin: vi.fn(async () => ({ phase: "waiting" as const, status: { enabled: true, authenticated: false, userId: null, displayName: null } })),
    neteaseLogout: vi.fn(async () => ({ enabled: true, authenticated: false, userId: null, displayName: null })),
    cacheStats: vi.fn(async () => ({ entryCount: 0, bytesUsed: 0, activeTasks: 0, lockedEntries: 0 })),
    cacheStatus: vi.fn(async (track) => ({ track, quality: null, cachedVersions: 0, status: "missing" as const, accessClass: "public" as const, ownerUserId: null, lastValidatedAt: null })),
    cacheTrack: vi.fn(async () => ({ taskId: "cache", accepted: true })),
    cacheRemove: vi.fn(async () => undefined),
    cacheClear: vi.fn(async () => ({ taskId: "clear", accepted: true })),
    lyricsGet: vi.fn(async () => ({ document: { source: "lrc", title: null, artists: [], album: null, language: null, offsetMs: 0, lines: [] }, rawOriginal: "", rawTranslation: "", rawRomanization: "", rawWordSynced: "", rawWordSyncedTranslation: "", rawTtml: "" })),
    windowShow: vi.fn(async () => undefined),
    windowHide: vi.fn(async () => undefined),
    windowClose: vi.fn(async () => undefined),
    windowSetAlwaysOnTop: vi.fn(async () => undefined),
    desktopLyricsSetClickThrough: vi.fn(async () => undefined),
    updaterStatus: vi.fn(async () => ({ enabled: false, reason: "disabled" })),
    updaterCheck: vi.fn(async () => ({ available: false, version: null, currentVersion: "0.1.0", notes: null })),
    updaterUpdate: vi.fn(async (_expectedVersion) => false),
    shenzhenWeather: vi.fn(async () => ({ location: "深圳", observedAt: "2026-09-01T12:30", temperatureC: 31, apparentTemperatureC: 35, relativeHumidityPercent: 72, weatherCode: 1, condition: "多云", windSpeedKmh: 8, isDay: true })),
    resolveClose: vi.fn(async () => undefined),
    createTelemetryTransport: vi.fn((): TelemetryTransport => ({
      open: vi.fn(),
      setRate: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    })),
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
    const initial = deferred<{ playback: PlaybackSnapshotDto; settings: AppSettingsDto; tasks: [] }>();
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
    handlers.playbackChanged?.({ ...playback, revision: 2, volume: 0.9 });
    handlers.playbackProgress?.({ revision: 2, positionMs: 450, durationMs: null });
    initial.resolve({ playback, settings, tasks: [] });
    await init;

    expect(useAppStore.getState().settings?.theme).toBe("dark");
    expect(useAppStore.getState().playback).toMatchObject({ revision: 2, volume: 0.9, positionMs: 450 });
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

  it.each(["configure", "preset", "import"] as const)(
    "commits %s when the execution event arrives before the pending response",
    async (kind) => {
      const response = deferred<DspApplyResultDto>();
      const resultConfiguration = { ...dspConfiguration, revision: "2" };
      const result: DspApplyResultDto = {
        revision: "2",
        status: "pending",
        partial: kind !== "configure",
        unsupportedStages: kind === "configure" ? [] : ["22:spatialAndHrtf"],
        engine: {
          revision: 1,
          playback: {
            status: "paused",
            currentTrack: null,
            positionMs: 0,
            durationMs: null,
            volume: 0.5,
            muted: false,
            repeatMode: "sequential",
          },
          queue: { currentItemId: null, playNext: [], context: [], revision: 1 },
          dspExecution: { revision: "0", safeBypassActive: false, fault: null },
        },
        configuration: resultConfiguration,
      };
      const testBridge = mockBridge({
        dspConfigure: vi.fn(() => response.promise),
        dspApplyPreset: vi.fn(() => response.promise),
        dspImportHse2: vi.fn(() => response.promise),
      });
      const { setBridgeForTests, useAppStore } = await import("./store");
      setBridgeForTests(testBridge);
      useAppStore.setState({ dspConfiguration, playback });

      const request = kind === "configure"
        ? useAppStore.getState().configureDsp(dspConfiguration)
        : kind === "preset"
          ? useAppStore.getState().applyDspPreset("studio")
          : useAppStore.getState().importDspHse2("HSE2:test");
      useAppStore.setState({ playback: { ...playback, dspExecution: { revision: 2n, safeBypassActive: false, fault: null } } });
      response.resolve(result);
      await request;

      expect(useAppStore.getState()).toMatchObject({
        dspConfiguration: resultConfiguration,
        dspPendingConfiguration: null,
        dspBusy: false,
      });
    },
  );

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
    const backendEngine = {
      revision: 2,
      playback: {
        status: "paused" as const,
        currentTrack: null,
        positionMs: 0,
        durationMs: null,
        volume: 0.5,
        muted: false,
        repeatMode: "sequential" as const,
      },
      queue: { currentItemId: null, playNext: [], context: [], revision: 2 },
      dspExecution: { revision: "2", safeBypassActive: false, fault: null },
    };
    const dspConfigure = vi.fn(async (configuration: DspConfigurationDto): Promise<DspApplyResultDto> => ({
      revision: "2",
      status: "applied",
      partial: false,
      unsupportedStages: [],
      engine: backendEngine,
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
      revision: 7n,
      code: "compilationFailed",
      reason: "DSP configuration could not be compiled for the active audio format",
      stage: "compile",
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "DSP 配置 revision 7 被拒绝（compile 阶段）：DSP configuration could not be compiled for the active audio format [compilationFailed]",
    );

    const fault = {
      revision: 8n,
      processorIndex: 2,
      processorName: "compressor",
      kind: "nonFiniteOutput" as const,
      streamFrame: 4096n,
      safeBypassActive: true,
      fallbackStatus: "rustSafeBypass" as const,
    };
    handlers.dspProcessingFault?.(fault);
    expect(useAppStore.getState().dspDiagnostic).toEqual(fault);
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("DSP revision 8 的 compressor 处理失败，播放正通过 Rust 安全旁路继续");

    handlers.playbackChanged?.({
      ...playback,
      revision: 9,
      dspExecution: { revision: 8n, safeBypassActive: true, fault: { ...fault } },
    });
    expect(useAppStore.getState().dspDiagnostic).toEqual(fault);

    handlers.playbackChanged?.({
      ...playback,
      revision: 9,
      dspExecution: { revision: 9n, safeBypassActive: false, fault: null },
    });
    expect(useAppStore.getState().dspDiagnostic).toBeNull();

    handlers.dspProcessingFault?.(fault);
    expect(useAppStore.getState().dspDiagnostic).toBeNull();
  });

  it("restores a safe-bypass diagnostic from bootstrap", async () => {
    const fault = {
      revision: 8n,
      processorIndex: 2,
      processorName: "compressor",
      kind: "nonFiniteOutput" as const,
      streamFrame: 4096n,
      safeBypassActive: true,
      fallbackStatus: "rustSafeBypass" as const,
    };
    const bypassed = {
      ...playback,
      dspExecution: { revision: 8n, safeBypassActive: true, fault },
    };
    const testBridge = mockBridge({ bootstrap: vi.fn(async () => ({ playback: bypassed, settings, tasks: [] })) });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);

    await useAppStore.getState().init();

    expect(useAppStore.getState().dspDiagnostic).toEqual(fault);
    expect(useAppStore.getState().toasts).toEqual([]);
  });

  it("commits only the latest volume and settings responses", async () => {
    const oldVolume = deferred<PlaybackSnapshotDto>();
    const newVolume = deferred<PlaybackSnapshotDto>();
    const oldSettings = deferred<AppSettingsDto>();
    const newSettings = deferred<AppSettingsDto>();
    const testBridge = mockBridge({
      setVolume: vi.fn().mockReturnValueOnce(oldVolume.promise).mockReturnValueOnce(newVolume.promise),
      updateSettings: vi.fn().mockReturnValueOnce(oldSettings.promise).mockReturnValueOnce(newSettings.promise),
    });
    const { setBridgeForTests, useAppStore } = await import("./store");
    setBridgeForTests(testBridge);
    useAppStore.setState({ playback, settings });

    const volumeOne = useAppStore.getState().setVolume(0.2);
    const volumeTwo = useAppStore.getState().setVolume(0.8);
    newVolume.resolve({ ...playback, volume: 0.8 });
    await volumeTwo;
    oldVolume.resolve({ ...playback, volume: 0.2 });
    await volumeOne;

    const settingsOne = useAppStore.getState().setSettings({ theme: "dark" });
    const settingsTwo = useAppStore.getState().setSettings({ theme: "system" });
    newSettings.resolve({ ...settings, theme: "system" });
    await settingsTwo;
    oldSettings.resolve({ ...settings, theme: "dark" });
    await settingsOne;

    expect(useAppStore.getState().playback?.volume).toBe(0.8);
    expect(useAppStore.getState().settings?.theme).toBe("system");
  });
});
