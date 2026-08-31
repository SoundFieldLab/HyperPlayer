import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsDto, BridgeContract, BridgeEventHandlers, PlaybackSnapshotDto, Unlisten } from "./bridge/contracts";

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
};

const playback: PlaybackSnapshotDto = {
  current: null,
  currentQueueItemId: null,
  status: "paused",
  positionMs: 0,
  volume: 0.5,
  queue: [],
  nextUp: [],
  repeat: "sequence",
  dsp: { available: false, bypassed: true, label: "规格待接入" },
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
    neteaseHome: vi.fn(async () => ({ recommendedTracks: [], recommendedPlaylists: [] })),
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
    cacheStatus: vi.fn(async (track) => ({ track, status: "missing" as const, accessClass: "public" as const, ownerUserId: null, lastValidatedAt: null })),
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
    handlers.playbackChanged?.({ ...playback, volume: 0.9 });
    initial.resolve({ playback, settings, tasks: [] });
    await init;

    expect(useAppStore.getState().settings?.theme).toBe("dark");
    expect(useAppStore.getState().playback?.volume).toBe(0.9);
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
