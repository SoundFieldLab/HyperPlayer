import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendTrackDto, PlaybackSnapshotDto } from "../bridge/contracts";

vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

const bridgeMocks = vi.hoisted(() => ({
  createTelemetryTransport: vi.fn(),
  libraryQueryPlaylists: vi.fn(),
  libraryCreatePlaylist: vi.fn(),
  libraryRenamePlaylist: vi.fn(),
  libraryDeletePlaylist: vi.fn(),
  libraryAddPlaylistTrack: vi.fn(),
  libraryRemovePlaylistTrack: vi.fn(),
  libraryReorderPlaylistTrack: vi.fn(),
  libraryEntityTracks: vi.fn(),
  libraryQuery: vi.fn(),
  neteaseCharts: vi.fn(),
  neteaseNewSongs: vi.fn(),
  neteaseMvs: vi.fn(),
  neteaseMvDetail: vi.fn(),
  neteaseMvPlayback: vi.fn(),
  neteaseDjRadios: vi.fn(),
  neteaseDjPrograms: vi.fn(),
  neteaseStatus: vi.fn(),
  neteaseHome: vi.fn(),
  neteaseBanner: vi.fn(),
  neteaseExploreNext: vi.fn(),
  neteaseSearch: vi.fn(),
  neteaseNotices: vi.fn(),
  neteaseFollowedEvents: vi.fn(),
  neteaseAccount: vi.fn(),
  neteaseFavorites: vi.fn(),
  neteaseFollows: vi.fn(),
  neteaseCloud: vi.fn(),
  neteaseAlbumDetail: vi.fn(),
  neteasePlaylistDetail: vi.fn(),
  neteaseComments: vi.fn(),
  neteaseListenTotal: vi.fn(),
  neteaseListenReport: vi.fn(),
  neteaseListenSongRank: vi.fn(),
  neteasePrepareMutation: vi.fn(),
  neteaseCommitMutation: vi.fn(),
  updaterStatus: vi.fn(),
  updaterCheck: vi.fn(),
  updaterUpdate: vi.fn(),
  dspGetConfiguration: vi.fn(),
  dspListPresets: vi.fn(),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMocks } };
});

import { CurrentView } from "./ContentViews";
import { useAppStore } from "../store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backendTrack = (id: string, title: string, source: "local" | "netease" = "local"): BackendTrackDto => ({
  trackRef: { id, source },
  title,
  artists: ["测试歌手"],
  album: "测试专辑",
  durationMs: 120_000,
  qualityLabel: "无损",
  playable: true,
});

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!match) throw new Error(`找不到按钮：${label}`);
  return match;
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function canvasContext(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D;
}

describe("CurrentView 页面能力边界", () => {
  let container: HTMLDivElement;
  let root: Root;
  let telemetryFrame: ((frame: ArrayBuffer | ArrayBufferView) => void) | undefined;
  let telemetryTransport: {
    open: ReturnType<typeof vi.fn>;
    setRate: ReturnType<typeof vi.fn>;
    acknowledge: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().dispose();
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext());
    telemetryFrame = undefined;
    telemetryTransport = {
      open: vi.fn((_rate, onFrame) => { telemetryFrame = onFrame; }),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    bridgeMocks.createTelemetryTransport.mockReturnValue(telemetryTransport);
    bridgeMocks.libraryQueryPlaylists.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    bridgeMocks.libraryCreatePlaylist.mockResolvedValue({ id: "new", name: "通勤", trackCount: 0, updatedUnixMs: 1 });
    bridgeMocks.libraryRenamePlaylist.mockImplementation(async (id, name) => ({ id, name, trackCount: 2, updatedUnixMs: 2 }));
    bridgeMocks.libraryDeletePlaylist.mockResolvedValue(undefined);
    bridgeMocks.libraryAddPlaylistTrack.mockResolvedValue(undefined);
    bridgeMocks.libraryRemovePlaylistTrack.mockResolvedValue(undefined);
    bridgeMocks.libraryReorderPlaylistTrack.mockResolvedValue(undefined);
    bridgeMocks.libraryEntityTracks.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    bridgeMocks.libraryQuery.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    bridgeMocks.neteaseCharts.mockResolvedValue([]);
    bridgeMocks.neteaseNewSongs.mockResolvedValue({ tracks: [] });
    bridgeMocks.neteaseMvs.mockResolvedValue({ items: [], nextCursor: null });
    bridgeMocks.neteaseMvDetail.mockResolvedValue({ mv: { id: 1, name: "MV", coverUrl: null, durationMs: null, artists: [], playCount: null }, description: null, publishTime: null, favoriteCount: null, commentCount: null });
    bridgeMocks.neteaseDjRadios.mockResolvedValue({ radios: [], programs: [], nextCursor: null });
    bridgeMocks.neteaseDjPrograms.mockResolvedValue({ radios: [], programs: [], nextCursor: null });
    bridgeMocks.neteaseStatus.mockResolvedValue({ enabled: true, authenticated: false, userId: null, displayName: null });
    bridgeMocks.neteaseHome.mockResolvedValue({ recommendedTracks: [], recommendedPlaylists: [], anonymous: true, unavailableSections: [] });
    bridgeMocks.neteaseBanner.mockResolvedValue([]);
    bridgeMocks.neteaseExploreNext.mockResolvedValue({ songs: [], batch: 1 });
    bridgeMocks.neteaseSearch.mockResolvedValue({ tracks: [], albums: [], artists: [], playlists: [], nextCursor: null });
    bridgeMocks.neteaseNotices.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
    bridgeMocks.neteaseFollowedEvents.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
    bridgeMocks.neteaseAccount.mockResolvedValue({ user: { userId: 1, nickname: "测试用户", avatarUrl: null }, vip: { active: false, expiresAtMs: null, level: null, verifiedAtMs: 0 } });
    bridgeMocks.neteaseFavorites.mockResolvedValue({ likedTrackIds: [], playlists: [] });
    bridgeMocks.neteaseFollows.mockResolvedValue({ users: [], nextCursor: null });
    bridgeMocks.neteaseCloud.mockResolvedValue({ songs: [], totalCount: 0, hasMore: false, nextCursor: null });
    bridgeMocks.neteaseAlbumDetail.mockResolvedValue({ album: { id: 1, name: "测试专辑", coverUrl: null }, description: null, publishTimeMs: null, artist: null, tracks: [] });
    bridgeMocks.neteasePlaylistDetail.mockResolvedValue({ playlist: { id: 1, name: "测试歌单", coverUrl: null, trackCount: 0, playCount: null, ownerId: 0, ownerName: null, description: null }, tracks: [] });
    bridgeMocks.neteaseComments.mockResolvedValue({ comments: [], totalCount: 0, hasMore: false, nextCursor: null });
    bridgeMocks.neteaseListenTotal.mockResolvedValue({ totalMinutes: 0, totalPlays: 0, songs: [] });
    bridgeMocks.neteaseListenReport.mockResolvedValue({ period: "week", endTime: null, stats: { totalMinutes: 0, totalPlays: 0, songs: [] } });
    bridgeMocks.neteaseListenSongRank.mockResolvedValue({ tracks: [] });
    bridgeMocks.updaterStatus.mockResolvedValue({ enabled: true, reason: null });
    bridgeMocks.updaterCheck.mockResolvedValue({ available: false, version: null, currentVersion: "0.1.0", notes: null });
    bridgeMocks.updaterUpdate.mockResolvedValue(false);
    bridgeMocks.dspGetConfiguration.mockRejectedValue(new Error("DSP fixture not enabled"));
    bridgeMocks.dspListPresets.mockResolvedValue([]);
    useAppStore.setState({
      domain: "local",
      view: "playlists",
      detailId: null,
      detailKind: null,
      navigation: {
        netease: { current: { view: "home", detailId: null, detailKind: null }, back: [], forward: [] },
        local: { current: { view: "playlists", detailId: null, detailKind: null }, back: [], forward: [] },
      },
      selectedTrackIds: [],
      tasks: [],
      toasts: [],
      playback: null,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the playlist empty state and creates a trimmed playlist", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("  通勤  ");
    await act(async () => root.render(<CurrentView />));
    await settle();

    expect(container.textContent).toContain("暂无播放列表");
    await act(async () => button(container, "新建播放列表").click());

    expect(bridgeMocks.libraryCreatePlaylist).toHaveBeenCalledWith("通勤");
    expect(bridgeMocks.libraryQueryPlaylists).toHaveBeenCalledTimes(2);
  });

  it("stores a real local playlist ID and traverses detail/list history", async () => {
    const playlistId = "playlist-550e8400-e29b-41d4-a716-446655440000";
    bridgeMocks.libraryQueryPlaylists.mockResolvedValue({
      items: [{ id: playlistId, name: "历史收藏", trackCount: 1, updatedUnixMs: 1 }], nextCursor: null, total: 1,
    });
    bridgeMocks.libraryEntityTracks.mockResolvedValue({
      items: [backendTrack("track-local-history", "历史曲目")], nextCursor: null, total: 1,
    });
    await act(async () => root.render(<CurrentView />));
    await settle();

    await act(async () => button(container, "历史收藏").click());
    await settle();
    expect(useAppStore.getState()).toMatchObject({ view: "playlists", detailId: playlistId, detailKind: "playlist" });
    expect(bridgeMocks.libraryEntityTracks).toHaveBeenCalledWith("playlist", playlistId, null);
    expect(container.textContent).toContain("历史曲目");

    await act(async () => button(container, "返回播放列表").click());
    await settle();
    expect(useAppStore.getState()).toMatchObject({ view: "playlists", detailId: null, detailKind: null });

    await act(async () => useAppStore.getState().back());
    await settle();
    expect(useAppStore.getState()).toMatchObject({ detailId: playlistId, detailKind: "playlist" });
    expect(container.textContent).toContain("历史曲目");

    await act(async () => useAppStore.getState().forward());
    await settle();
    expect(useAppStore.getState()).toMatchObject({ detailId: null, detailKind: null });
    expect(container.textContent).toContain("历史收藏");
  });

  it("falls back to the local list when a restored detail no longer exists", async () => {
    const missingId = "playlist-deleted-550e8400-e29b-41d4-a716-446655440001";
    useAppStore.setState({
      detailId: missingId,
      detailKind: "playlist",
      navigation: {
        netease: { current: { view: "home", detailId: null, detailKind: null }, back: [], forward: [] },
        local: {
          current: { view: "playlists", detailId: missingId, detailKind: "playlist" },
          back: [{ view: "playlists", detailId: null, detailKind: null }],
          forward: [],
        },
      },
    });
    bridgeMocks.libraryQueryPlaylists.mockResolvedValue({
      items: [{ id: "playlist-existing", name: "仍然存在", trackCount: 0, updatedUnixMs: 1 }], nextCursor: null, total: 1,
    });

    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    expect(useAppStore.getState()).toMatchObject({ view: "playlists", detailId: null, detailKind: null });
    expect(useAppStore.getState().navigation.local.forward).toEqual([]);
    expect(bridgeMocks.libraryEntityTracks).not.toHaveBeenCalled();
    expect(container.textContent).toContain("仍然存在");
  });

  it("exposes playlist rename/delete and track reorder/remove mutations", async () => {
    bridgeMocks.libraryQueryPlaylists.mockResolvedValue({
      items: [{ id: "p1", name: "收藏", trackCount: 2, updatedUnixMs: 1 }], nextCursor: null, total: 1,
    });
    bridgeMocks.libraryEntityTracks.mockResolvedValue({
      items: [backendTrack("t1", "第一首"), backendTrack("t2", "第二首")], nextCursor: null, total: 2,
    });
    vi.spyOn(window, "prompt").mockReturnValue("新名称");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<CurrentView />));
    await settle();
    await act(async () => button(container, "收藏").click());
    await settle();

    expect(button(container, "添加歌曲").disabled).toBe(false);
    await act(async () => button(container, "重命名").click());
    expect(bridgeMocks.libraryRenamePlaylist).toHaveBeenCalledWith("p1", "新名称");

    await act(async () => container.querySelector<HTMLElement>('[data-track-id="t1"]')!.click());
    expect(container.textContent).toContain("已选择 1 首");
    expect(button(container, "上移").disabled).toBe(true);
    expect(button(container, "下移").disabled).toBe(false);
    await act(async () => button(container, "下移").click());
    expect(bridgeMocks.libraryReorderPlaylistTrack).toHaveBeenCalledWith("p1", "t1", 1);

    await act(async () => button(container, "从列表移除").click());
    expect(bridgeMocks.libraryRemovePlaylistTrack).toHaveBeenCalledWith("p1", "t1");

    await act(async () => button(container, "删除").click());
    expect(bridgeMocks.libraryDeletePlaylist).toHaveBeenCalledWith("p1");
  });

  it("loads every library page before adding a track", async () => {
    bridgeMocks.libraryQueryPlaylists.mockResolvedValue({
      items: [{ id: "p1", name: "收藏", trackCount: 0, updatedUnixMs: 1 }], nextCursor: null, total: 1,
    });
    bridgeMocks.libraryQuery
      .mockResolvedValueOnce({ items: [backendTrack("t1", "第一页")], nextCursor: "next", total: 2 })
      .mockResolvedValueOnce({ items: [backendTrack("t2", "第二页")], nextCursor: null, total: 2 });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await act(async () => button(container, "收藏").click());
    await settle();
    await act(async () => button(container, "添加歌曲").click());
    await settle();

    expect(bridgeMocks.libraryQuery).toHaveBeenNthCalledWith(1, undefined, null);
    expect(bridgeMocks.libraryQuery).toHaveBeenNthCalledWith(2, undefined, "next");
    expect(container.textContent).toContain("第二页");
    await act(async () => button(container, "第二页").click());
    expect(bridgeMocks.libraryAddPlaylistTrack).toHaveBeenCalledWith("p1", "t2");
  });

  it("treats an updater false result as no longer available", async () => {
    bridgeMocks.updaterCheck.mockResolvedValue({ available: true, version: "0.2.0", currentVersion: "0.1.0", notes: "修复" });
    useAppStore.setState({ view: "status" });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await act(async () => button(container, "检查更新").click());
    await settle();
    await act(async () => button(container, "下载并安装").click());
    await settle();

    expect(bridgeMocks.updaterUpdate).toHaveBeenCalledWith("0.2.0");
    expect(container.textContent).toContain("当前已是最新版本 0.1.0");
    expect(container.textContent).not.toContain("发现版本 0.2.0");
  });

  it("renders independent Discover sections when one public endpoint fails", async () => {
    bridgeMocks.neteaseCharts.mockRejectedValue({ code: "offline", message: "榜单暂时离线" });
    bridgeMocks.neteaseNewSongs.mockResolvedValue({ tracks: [backendTrack("song-1", "公开新歌", "netease")] });
    bridgeMocks.neteaseMvs.mockResolvedValue({ items: [{ id: 10, name: "现场 MV", coverUrl: null, durationMs: 90_000, artists: [{ id: 2, name: "歌手" }], playCount: 321 }], nextCursor: null });
    bridgeMocks.neteaseDjRadios.mockResolvedValue({ radios: [{ id: 20, name: "公开电台", coverUrl: null, description: null, programCount: 3, subscriberCount: 10, category: "音乐" }], programs: [], nextCursor: null });
    bridgeMocks.neteaseDjPrograms.mockResolvedValue({ radios: [], programs: [], nextCursor: null });
    useAppStore.setState({ domain: "netease", view: "discover" });

    await act(async () => root.render(<CurrentView />));
    await settle();

    expect(container.textContent).toContain("榜单暂时离线");
    // 错误态必须有可操作的重试入口（而不是被当空结果吞掉），点击后重新请求同一公开端点
    await act(async () => button(container, "重试").click());
    await settle();
    expect(bridgeMocks.neteaseCharts).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("公开新歌");
    expect(container.textContent).toContain("现场 MV");
    expect(container.textContent).toContain("公开电台");
  });

  it("opens charts through playlist detail and keeps MV detail metadata-only", async () => {
    bridgeMocks.neteaseCharts.mockResolvedValue([{ id: 99, name: "热歌榜", coverUrl: null, updateFrequency: "每天更新", description: null, previewTracks: [] }]);
    bridgeMocks.neteaseMvs.mockResolvedValue({ items: [{ id: 10, name: "现场 MV", coverUrl: null, durationMs: 90_000, artists: [{ id: 2, name: "歌手" }], playCount: 321 }], nextCursor: null });
    bridgeMocks.neteaseMvDetail.mockResolvedValue({ mv: { id: 10, name: "现场 MV", coverUrl: null, durationMs: 90_000, artists: [{ id: 2, name: "歌手" }], playCount: 321 }, description: "现场录制", publishTime: "2026-08-31", favoriteCount: 12, commentCount: 34 });
    useAppStore.setState({ domain: "netease", view: "discover" });
    await act(async () => root.render(<CurrentView />));
    await settle();

    await act(async () => {
      button(container, "热歌榜").click();
      await Promise.resolve();
    });
    expect(useAppStore.getState()).toMatchObject({ view: "playlist", detailId: 99 });

    await act(async () => {
      useAppStore.setState({ view: "discover", detailId: null });
      await Promise.resolve();
    });
    await settle();
    await act(async () => button(container, "现场 MV").click());
    await settle();
    expect(container.textContent).toContain("现场录制");
    const mvPlay = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("播放 MV"));
    expect(mvPlay).not.toBeUndefined();
    expect(mvPlay!.disabled).toBe(false);
    bridgeMocks.neteaseMvPlayback.mockResolvedValue({ id: 10, url: "https://example.com/mv.mp4", resolution: 1080, sizeBytes: null, durationMs: 90_000 });
    await act(async () => { mvPlay!.click(); await Promise.resolve(); });
    await settle();
    expect(bridgeMocks.neteaseMvPlayback).toHaveBeenCalledWith(10);
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("paginates MV, radio, and selected radio programs independently", async () => {
    bridgeMocks.neteaseMvs
      .mockResolvedValueOnce({ items: [{ id: 1, name: "MV 一", coverUrl: null, durationMs: null, artists: [], playCount: null }], nextCursor: "mv-next" })
      .mockResolvedValueOnce({ items: [{ id: 2, name: "MV 二", coverUrl: null, durationMs: null, artists: [], playCount: null }], nextCursor: null });
    bridgeMocks.neteaseDjRadios
      .mockResolvedValueOnce({ radios: [{ id: 20, name: "电台一", coverUrl: null, description: null, programCount: 2, subscriberCount: null, category: null }], programs: [], nextCursor: "radio-next" })
      .mockResolvedValueOnce({ radios: [{ id: 21, name: "电台二", coverUrl: null, description: null, programCount: 0, subscriberCount: null, category: null }], programs: [], nextCursor: null });
    bridgeMocks.neteaseDjPrograms
      .mockResolvedValueOnce({ radios: [], programs: [{ id: 30, name: "节目一", radio: { id: 20, name: "电台一", coverUrl: null, description: null, programCount: 2, subscriberCount: null, category: null }, mainTrack: null, durationMs: null, listenerCount: null, likedCount: null, createdAtMs: null }], nextCursor: "program-next" })
      .mockResolvedValueOnce({ radios: [], programs: [{ id: 31, name: "节目二", radio: { id: 20, name: "电台一", coverUrl: null, description: null, programCount: 2, subscriberCount: null, category: null }, mainTrack: null, durationMs: null, listenerCount: null, likedCount: null, createdAtMs: null }], nextCursor: null });
    useAppStore.setState({ domain: "netease", view: "discover" });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    const sections = [...container.querySelectorAll<HTMLElement>(".discover-section")];
    await act(async () => button(sections[2], "加载更多").click());
    await settle();
    expect(bridgeMocks.neteaseMvs).toHaveBeenLastCalledWith("mv-next");
    expect(container.textContent).toContain("MV 二");

    await act(async () => button(sections[3], "加载更多").click());
    await settle();
    expect(bridgeMocks.neteaseDjRadios).toHaveBeenLastCalledWith("radio-next");
    expect(container.textContent).toContain("电台二");

    await act(async () => button(sections[3].querySelector<HTMLElement>(".discover-programs")!, "加载更多").click());
    await settle();
    expect(bridgeMocks.neteaseDjPrograms).toHaveBeenLastCalledWith(20, "program-next");
    expect(container.textContent).toContain("节目二");
  });

  it("plays and queues a DJ main track through existing store actions", async () => {
    const result: PlaybackSnapshotDto = { revision: "1", current: null, currentQueueItemId: null, status: "paused", positionMs: 0, durationMs: null, volume: 0.5, queue: [], nextUp: [], repeat: "sequence", shuffled: false, dspExecution: { revision: "0", safeBypassActive: false, fault: null } };
    const playTrack = vi.spyOn(useAppStore.getState(), "playTrack");
    const enqueueTrack = vi.spyOn(useAppStore.getState(), "enqueueTrack");
    bridgeMocks.neteaseDjRadios.mockResolvedValue({ radios: [{ id: 20, name: "公开电台", coverUrl: null, description: null, programCount: 1, subscriberCount: null, category: null }], programs: [], nextCursor: null });
    bridgeMocks.neteaseDjPrograms.mockResolvedValue({ radios: [], programs: [{ id: 30, name: "可播节目", radio: { id: 20, name: "公开电台", coverUrl: null, description: null, programCount: 1, subscriberCount: null, category: null }, mainTrack: backendTrack("dj-track", "节目主曲目", "netease"), durationMs: 120_000, listenerCount: 9, likedCount: 1, createdAtMs: null }], nextCursor: null });
    useAppStore.setState({ domain: "netease", view: "discover", playback: result });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    const playButton = container.querySelector<HTMLButtonElement>('[aria-label="播放 可播节目"]');
    const queueButton = container.querySelector<HTMLButtonElement>('[aria-label="将 可播节目 加入队列"]');
    expect(playButton).not.toBeNull();
    expect(queueButton).not.toBeNull();
    await act(async () => playButton!.click());
    await act(async () => queueButton!.click());
    expect(playTrack).toHaveBeenCalledWith(expect.objectContaining({ id: "dj-track", source: "netease" }), { kind: "manual", id: null });
    expect(enqueueTrack).toHaveBeenCalledWith(expect.objectContaining({ id: "dj-track", source: "netease" }), "playNext");
  });

  it("renders notices and followed events as read-only message lists", async () => {
    bridgeMocks.neteaseStatus.mockResolvedValue({ enabled: true, authenticated: true, userId: "1", displayName: "测试用户" });
    bridgeMocks.neteaseNotices.mockResolvedValue({ items: [{ id: 11, occurredAtMs: 1780000000000, title: "系统通知", text: "你的歌单被收藏了", user: { userId: 1, nickname: "网易云", avatarUrl: null } }], hasMore: false, nextCursor: null });
    bridgeMocks.neteaseFollowedEvents.mockResolvedValue({ items: [{ id: 12, eventType: "share", occurredAtMs: 1780000000000, user: { userId: 2, nickname: "关注的歌手", avatarUrl: null }, text: "分享了新歌", track: backendTrack("ev-track", "新歌事件", "netease") }], hasMore: false, nextCursor: null });
    await act(async () => { useAppStore.setState({ view: "messages" }); });
    await act(async () => root.render(<CurrentView />));
    await settle();
    expect(container.textContent).toContain("你的歌单被收藏了");
    expect(container.textContent).toContain("关注的歌手");
    expect(container.textContent).toContain("新歌事件");
    expect(bridgeMocks.neteaseNotices).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.neteaseFollowedEvents).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("此功能当前不可用");
  });

  it("keeps messages read-only and explains the login requirement", async () => {
    await act(async () => { useAppStore.setState({ view: "messages" }); });
    await act(async () => root.render(<CurrentView />));
    await settle();
    expect(container.textContent).toContain("登录后查看消息");
    expect(container.textContent).toContain("保持只读");
    // 未登录时通知/关注动态区块隐藏，不得露出「后端返回了空结果」，并提供跳转账号页的入口
    expect(container.textContent).not.toContain("暂无通知");
    expect(container.textContent).not.toContain("暂无关注动态");
    expect(container.textContent).not.toContain("后端返回了空结果");
    await act(async () => button(container, "前往网易云账号").click());
    expect(useAppStore.getState()).toMatchObject({ view: "account" });
  });

  it("switches search sub-tabs and opens album/artist/playlist result cards", async () => {
    vi.useFakeTimers();
    bridgeMocks.neteaseSearch.mockImplementation(async (query, kind) => ({
      tracks: kind === "track" ? [{ ...backendTrack("song-1", "搜索结果歌曲", "netease"), album: "专辑A" }] : [],
      albums: kind === "album" ? [{ id: 201, name: "结果专辑", coverUrl: null }] : [],
      artists: kind === "artist" ? [{ id: 301, name: "结果艺人", imageUrl: null, aliases: [], briefDescription: null }] : [],
      playlists: kind === "playlist" ? [{ id: 401, name: "结果歌单", coverUrl: null, trackCount: 8, playCount: 100, ownerId: 1, ownerName: "歌单作者", description: null }] : [],
      nextCursor: null,
    }));
    useAppStore.setState({ domain: "netease", view: "search" });
    await act(async () => root.render(<CurrentView />));
    typeInto(container.querySelector<HTMLInputElement>(".search-page-input input")!, "测试");
    await act(async () => { vi.advanceTimersByTime(400); });
    await settle();
    expect(bridgeMocks.neteaseSearch).toHaveBeenCalledWith("测试", "track");
    expect(container.textContent).toContain("搜索结果歌曲");

    await act(async () => button(container, "专辑").click());
    await act(async () => { vi.advanceTimersByTime(400); });
    await settle();
    expect(bridgeMocks.neteaseSearch).toHaveBeenCalledWith("测试", "album");
    expect(container.textContent).toContain("结果专辑");

    await act(async () => button(container, "结果专辑").click());
    expect(useAppStore.getState()).toMatchObject({ view: "album", detailId: 201 });

    await act(async () => { useAppStore.setState({ view: "search", detailId: null }); });
    await act(async () => { root.render(<CurrentView />); });
    typeInto(container.querySelector<HTMLInputElement>(".search-page-input input")!, "测试");
    await act(async () => { vi.advanceTimersByTime(400); });
    await settle();
    await act(async () => button(container, "艺术家").click());
    await act(async () => { vi.advanceTimersByTime(400); });
    await settle();
    expect(bridgeMocks.neteaseSearch).toHaveBeenCalledWith("测试", "artist");
    expect(container.textContent).toContain("结果艺人");
    expect(container.textContent).toContain("网易云艺术家");

    await act(async () => button(container, "歌单").click());
    await act(async () => { vi.advanceTimersByTime(400); });
    await settle();
    expect(bridgeMocks.neteaseSearch).toHaveBeenCalledWith("测试", "playlist");
    expect(container.textContent).toContain("结果歌单");
    expect(container.textContent).toContain("歌单作者");
    await act(async () => button(container, "结果歌单").click());
    expect(useAppStore.getState()).toMatchObject({ view: "playlist", detailId: 401 });
    vi.useRealTimers();
  });

  it("publishes and likes comments through the confirmation write flow", async () => {
    bridgeMocks.neteaseStatus.mockResolvedValue({ enabled: true, authenticated: true, userId: "1", displayName: "测试用户" });
    bridgeMocks.neteaseAlbumDetail.mockResolvedValue({ album: { id: 5, name: "评论专辑", coverUrl: null }, description: null, publishTimeMs: null, artist: null, tracks: [backendTrack("detail-5", "评论专辑曲目", "netease")] });
    bridgeMocks.neteaseComments.mockResolvedValue({ comments: [{ id: 71, content: "这条评论很好", timeText: "刚刚", likedCount: 3, liked: false, user: { userId: 2, nickname: "路人甲", avatarUrl: null } }], totalCount: 1, hasMore: false, nextCursor: null });
    bridgeMocks.neteasePrepareMutation.mockImplementation(async (mutation) => ({ confirmationToken: "token-abc", summary: mutation.kind === "setCommentFavorite" ? "like comment" : "publish comment", expiresAtMs: Date.now() + 60_000 }));
    bridgeMocks.neteaseCommitMutation.mockResolvedValue({ succeeded: true, createdPlaylist: null, comment: null });
    useAppStore.setState({ domain: "netease", view: "album", detailId: 5 });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    expect(container.textContent).toContain("这条评论很好");
    const likeButton = container.querySelector<HTMLButtonElement>('[aria-label="点赞 路人甲 的评论"]');
    expect(likeButton).not.toBeNull();
    await act(async () => likeButton!.click());
    await settle();
    expect(bridgeMocks.neteasePrepareMutation).toHaveBeenCalledWith({ kind: "setCommentFavorite", resource: "album", resourceId: 5, commentId: 71, favorite: true });
    expect(container.textContent).toContain("确认点赞评论");
    expect(container.textContent).toContain("like comment");
    await act(async () => button(container, "确认执行").click());
    await settle();
    expect(bridgeMocks.neteaseCommitMutation).toHaveBeenCalledWith("token-abc", true);
    expect(bridgeMocks.neteaseComments).toHaveBeenCalledTimes(2);

    typeInto(container.querySelector<HTMLTextAreaElement>(".comment-composer-field textarea")!, "新发布的内容");
    await act(async () => button(container, "发布评论").click());
    await settle();
    expect(bridgeMocks.neteasePrepareMutation).toHaveBeenLastCalledWith({ kind: "addComment", resource: "album", resourceId: 5, content: "新发布的内容" });
    expect(container.textContent).toContain("确认发布评论");
    await act(async () => button(container, "确认执行").click());
    await settle();
    expect(bridgeMocks.neteaseCommitMutation).toHaveBeenLastCalledWith("token-abc", true);
  });

  it("disables comment writes and explains login when unauthenticated", async () => {
    bridgeMocks.neteaseAlbumDetail.mockResolvedValue({ album: { id: 6, name: "只读专辑", coverUrl: null }, description: null, publishTimeMs: null, artist: null, tracks: [backendTrack("detail-6", "只读专辑曲目", "netease")] });
    bridgeMocks.neteaseComments.mockResolvedValue({ comments: [{ id: 81, content: "只读评论", timeText: "昨天", likedCount: 1, liked: false, user: { userId: 2, nickname: "路人乙", avatarUrl: null } }], totalCount: 1, hasMore: false, nextCursor: null });
    useAppStore.setState({ domain: "netease", view: "album", detailId: 6 });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    expect(container.textContent).toContain("登录后可以发表评论");
    expect(container.querySelector<HTMLTextAreaElement>(".comment-composer-field textarea")).toBeNull();
    const likeButton = container.querySelector<HTMLButtonElement>('[aria-label="点赞 路人乙 的评论"]');
    expect(likeButton).not.toBeNull();
    expect(likeButton!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".comment-reply-btn")!.disabled).toBe(true);
    expect(bridgeMocks.neteasePrepareMutation).not.toHaveBeenCalled();
  });

  it("deletes own comments only after confirmation", async () => {
    bridgeMocks.neteaseStatus.mockResolvedValue({ enabled: true, authenticated: true, userId: "1", displayName: "测试用户" });
    bridgeMocks.neteaseAlbumDetail.mockResolvedValue({ album: { id: 7, name: "自评专辑", coverUrl: null }, description: null, publishTimeMs: null, artist: null, tracks: [backendTrack("detail-7", "自评专辑曲目", "netease")] });
    bridgeMocks.neteaseComments.mockResolvedValue({ comments: [{ id: 91, content: "自己发的评论", timeText: "今天", likedCount: 0, liked: false, user: { userId: 1, nickname: "测试用户", avatarUrl: null } }], totalCount: 1, hasMore: false, nextCursor: null });
    bridgeMocks.neteasePrepareMutation.mockResolvedValue({ confirmationToken: "token-del", summary: "delete comment", expiresAtMs: Date.now() + 60_000 });
    bridgeMocks.neteaseCommitMutation.mockResolvedValue({ succeeded: true, createdPlaylist: null, comment: null });
    useAppStore.setState({ domain: "netease", view: "album", detailId: 7 });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    const deleteButton = container.querySelector<HTMLButtonElement>('[aria-label="删除自己的评论"]');
    expect(deleteButton).not.toBeNull();
    await act(async () => deleteButton!.click());
    await settle();
    expect(bridgeMocks.neteasePrepareMutation).toHaveBeenCalledWith({ kind: "deleteComment", resource: "album", resourceId: 7, commentId: 91 });
    expect(container.textContent).toContain("确认删除评论");
    await act(async () => button(container, "取消").click());
    expect(bridgeMocks.neteaseCommitMutation).not.toHaveBeenCalled();
  });

  it("surfaces failed mutation preparse as an inline error", async () => {
    bridgeMocks.neteaseStatus.mockResolvedValue({ enabled: true, authenticated: true, userId: "1", displayName: "测试用户" });
    bridgeMocks.neteaseAlbumDetail.mockResolvedValue({ album: { id: 8, name: "错误专辑", coverUrl: null }, description: null, publishTimeMs: null, artist: null, tracks: [backendTrack("detail-8", "错误专辑曲目", "netease")] });
    bridgeMocks.neteaseComments.mockResolvedValue({ comments: [{ id: 95, content: "评论", timeText: null, likedCount: 0, liked: false, user: { userId: 2, nickname: "路人丙", avatarUrl: null } }], totalCount: 1, hasMore: false, nextCursor: null });
    bridgeMocks.neteasePrepareMutation.mockRejectedValue({ code: "unauthorized", message: "会话已失效" });
    useAppStore.setState({ domain: "netease", view: "album", detailId: 8 });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="点赞 路人丙 的评论"]')!.click());
    await settle();
    expect(container.textContent).toContain("会话已失效");
    expect(container.querySelector<HTMLElement>(".comment-error")).not.toBeNull();
  });

  it("renders the listen summary under the netease library and switches periods", async () => {
    bridgeMocks.neteaseStatus.mockResolvedValue({ enabled: true, authenticated: true, userId: "1", displayName: "测试用户" });
    bridgeMocks.neteaseAccount.mockResolvedValue({ user: { userId: 1, nickname: "测试用户", avatarUrl: null }, vip: { active: false, expiresAtMs: null, level: null, verifiedAtMs: 0 } });
    bridgeMocks.neteaseListenTotal.mockResolvedValue({ totalMinutes: 120, totalPlays: 45, songs: [] });
    bridgeMocks.neteaseListenReport.mockResolvedValue({ period: "week", endTime: null, stats: { totalMinutes: 30, totalPlays: 10, songs: [] } });
    bridgeMocks.neteaseListenSongRank.mockResolvedValue({ tracks: [{ ...backendTrack("listen-1", "常听歌曲", "netease"), album: "专辑B" }] });
    useAppStore.setState({ domain: "netease", view: "library" });
    await act(async () => root.render(<CurrentView />));
    await settle();
    await settle();

    expect(container.textContent).toContain("2 小时");
    expect(container.textContent).toContain("累计收听时长");
    expect(container.textContent).toContain("本周播放");
    expect(container.textContent).toContain("常听歌曲");
    expect(container.textContent).toContain("常听歌曲".length > 0 ? "常听歌曲" : "");

    await act(async () => button(container, "最近一月").click());
    await settle();
    await settle();
    expect(bridgeMocks.neteaseListenReport).toHaveBeenCalledWith("month");
    expect(bridgeMocks.neteaseListenSongRank).toHaveBeenCalledWith("month");
    expect(container.textContent).toContain("本月播放");
  });

  it("guides unauthenticated users in the netease library instead of empty results", async () => {
    useAppStore.setState({ domain: "netease", view: "library" });
    await act(async () => root.render(<CurrentView />));
    await settle();

    expect(container.textContent).toContain("登录后查看收藏");
    // 未登录不得把账号数据区块当空结果展示
    expect(container.textContent).not.toContain("暂无收藏");
    expect(container.textContent).not.toContain("暂无收藏艺人");
    expect(container.textContent).not.toContain("后端返回了空结果");
    await act(async () => button(container, "前往网易云账号").click());
    expect(useAppStore.getState()).toMatchObject({ view: "account" });
  });

  it("renders the home collection hero with the stable layout classes", async () => {
    bridgeMocks.neteaseHome.mockResolvedValue({ recommendedTracks: [], recommendedPlaylists: [], anonymous: true, unavailableSections: [] });
    bridgeMocks.neteaseBanner.mockResolvedValue([]);
    useAppStore.setState({ domain: "netease", view: "home" });
    await act(async () => root.render(<CurrentView />));
    await settle();

    // 首页英雄卡使用 styles.css 已定义的 continue-main，塌陷的 collection-summary/collection-toolbar 不得再出现
    expect(container.querySelector(".continue-main")).not.toBeNull();
    expect(container.querySelector(".view-toolbar")).not.toBeNull();
    expect(container.querySelector(".collection-summary")).toBeNull();
    expect(container.querySelector(".collection-toolbar")).toBeNull();
    expect(container.textContent).toContain("你的音乐收藏");
    expect(container.textContent).toContain("推荐曲目");
    await act(async () => button(container, "筛选音乐").click());
    expect(useAppStore.getState()).toMatchObject({ view: "search" });
  });

});
