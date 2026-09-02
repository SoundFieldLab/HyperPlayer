import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendTrackDto, DspConfigurationDto, PlaybackSnapshotDto } from "../bridge/contracts";

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
  neteaseDjRadios: vi.fn(),
  neteaseDjPrograms: vi.fn(),
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
import { makeTelemetryFrame } from "../visualization/telemetry/test-fixtures";
import { TELEMETRY_VALID_RMS, TELEMETRY_VALID_SAMPLE_PEAK, TELEMETRY_VALID_SPECTRUM, TELEMETRY_VALID_WAVEFORM } from "../visualization/telemetry";

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

const dspConfiguration: DspConfigurationDto = {
  revision: "2",
  loudnessNormalization: { enabled: true, targetLufs: -14, maxGainDb: 9, minGainDb: -9, useRealtimeMeter: true, externalGainDb: 0 },
  surround3d: { enabled: true, distance: 0.5, speed: 1, angle: 0, direction: 1 },
  midSide: { enabled: true, stereoWidth: 1, voiceBalance: 0 },
  preEq: { enabled: true, bandCount: 1, qCompensation: true, stereoMode: "independent", bands: [{ frequency: 1000, gain: 0, q: 1 }] },
  deesser: { enabled: true, centerHz: 6000, q: 1, thresholdDb: -24, ratio: 4, attackMs: 5, releaseMs: 100, splitBand: true, mix: 1 },
  compressor: { enabled: true, thresholdDb: -18, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 200, makeupDb: 0, outputGain: 1 },
  nightMode: { enabled: false, amount: 0.5 },
  delay: { enabled: false, delayMs: 250, feedback: 0.25, mix: 0.2 },
  chorus: { enabled: false, rateHz: 1, depthMs: 5, mix: 0.2 },
  flanger: { enabled: false, rateHz: 1, depthMs: 2, feedback: 0.2, mix: 0.2 },
  phaser: { enabled: true, rateHz: 1, depth: 0.5, feedback: 0.2, mix: 0.5, stages: 4 },
  tremolo: { enabled: false, rateHz: 4, depth: 0.5, mix: 0.5 },
  reverb: { enabled: false, mode: "algorithmic", reverbType: "hall", roomSize: 0.5, damping: 0.5, wet: 0.3, dry: 0.7, preDelayMs: 0, width: 1, fdnLines: 8, mix: 0.3, partitionSize: 512, shortRegionMs: 100 },
  bassEnhancer: { enabled: false, cutoffHz: 120, q: 1, harmonicType: "soft", harmonicGain: 0.5, mix: 0.5, levelDb: 0, lowBoostDb: null },
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
};

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!match) throw new Error(`找不到按钮：${label}`);
  return match;
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
    expect(container.textContent).toContain("公开新歌");
    expect(container.textContent).toContain("现场 MV");
    expect(container.textContent).toContain("公开电台");
    expect(bridgeMocks.neteaseCharts).toHaveBeenCalledOnce();
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
    expect(container.textContent).toContain("尚未提供 MV 播放地址");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent?.includes("播放 MV"))).toBe(false);
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
    const result: PlaybackSnapshotDto = { revision: 1, current: null, currentQueueItemId: null, status: "paused", positionMs: 0, volume: 0.5, queue: [], nextUp: [], repeat: "sequence", dsp: { available: true, bypassed: true, label: "Rust DSP runtime 已内建；完整 22 阶段与 DspPort 尚未接通" }, dspExecution: { revision: 0n, safeBypassActive: false, fault: null } };
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

  it("renders the unavailable messages state and the implemented DSP overview", async () => {
    await act(async () => { useAppStore.setState({ view: "messages" }); });
    await act(async () => root.render(<CurrentView />));
    expect(container.textContent).toContain("此功能当前不可用");
    expect(container.textContent).toContain("正式模式不会显示虚构未读消息。");

    await act(async () => { useAppStore.setState({ view: "dsp" }); });
    await act(async () => root.render(<CurrentView />));
    expect(container.textContent).toContain("音效工作台");
    expect(container.textContent).toContain("Rust 配置编译中");
    expect(container.textContent).toContain("21 个处理器");
    expect(container.textContent).toContain("vendored HSE Rust");
    expect(container.textContent).toContain("BYPASS");
    expect(container.textContent).not.toContain("LIVE");
    expect(container.textContent).toContain("DSP 配置不可用");
    expect(container.textContent).toContain("HSE2 分享码");
    expect(button(container, "应用参数").disabled).toBe(true);
  });

  it("renders constrained DSP controls and keeps LUFS separate from RMS and peak telemetry", async () => {
    bridgeMocks.dspGetConfiguration.mockResolvedValue(dspConfiguration);
    bridgeMocks.dspListPresets.mockResolvedValue([{ id: "studio", name: "录音室", description: "测试", partial: false, unsupportedStages: [] }]);
    useAppStore.setState({ view: "dsp" });

    await act(async () => root.render(<CurrentView />));
    await settle();

    expect(container.textContent).toContain("LUFS tap 已接；等待实时读数（需播放中）。");
    expect(container.querySelector('[aria-label="实时 RMS 和峰值遥测"]')).not.toBeNull();
    const direction = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("方向"))?.querySelector("select");
    expect([...direction?.options ?? []].map((option) => option.value)).toEqual(["-1", "1"]);
    const stages = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("级数"))?.querySelector("input");
    expect(stages).toMatchObject({ min: "2", max: "8", step: "1" });
    const eqBand = container.querySelector(".dsp-eq-bands fieldset");
    expect(eqBand?.querySelectorAll('input[type="number"]')).toHaveLength(3);
    expect([...eqBand?.querySelectorAll("label > span") ?? []].map((item) => item.textContent)).toEqual(["频率 Hz", "增益 dB", "Q"]);
    const frequency = eqBand?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(frequency).toMatchObject({ min: "20", max: "20000", step: "1" });
    const surroundDistance = [...container.querySelectorAll(".dsp-module")].find((module) => module.textContent?.includes("环绕运动"))?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(surroundDistance).toMatchObject({ min: "0", max: "10" });
    const nightAmount = [...container.querySelectorAll(".dsp-module")].find((module) => module.textContent?.includes("夜间模式"))?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(nightAmount).toMatchObject({ min: "0", max: "10" });
    const bassInputs = [...container.querySelectorAll(".dsp-module")].find((module) => module.textContent?.includes("低频增强"))?.querySelectorAll<HTMLInputElement>('input[type="number"]');
    expect([...bassInputs ?? []].map((input) => [input.min, input.max])).toEqual([["20", "500"], ["0.1", "10"], ["0", "1"], ["0", "1"], ["-6", "6"], ["-6", "12"]]);
    expect(container.querySelector(".dsp-toolbar")).not.toBeNull();
    expect(container.querySelector(".dsp-share-actions")).not.toBeNull();
    expect(container.querySelector(".eq-reference")).not.toBeNull();
  });

  it("keeps pre-EQ bandCount and bands synchronized at both boundaries", async () => {
    bridgeMocks.dspGetConfiguration.mockResolvedValue(dspConfiguration);
    bridgeMocks.dspListPresets.mockResolvedValue([]);
    useAppStore.setState({ view: "dsp" });
    await act(async () => root.render(<CurrentView />));
    await settle();

    const bandCount = container.querySelector<HTMLInputElement>('input[aria-label="频段数"]') ?? [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("频段数"))?.querySelector<HTMLInputElement>("input");
    expect(bandCount).toMatchObject({ min: "1", max: "20", step: "1" });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(bandCount, "3");
      bandCount?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const preEqModule = [...container.querySelectorAll(".dsp-module")].find((module) => module.textContent?.includes("参数均衡"));
    if (!preEqModule) throw new Error("找不到参数均衡模块");
    expect(preEqModule.querySelectorAll(".dsp-eq-bands fieldset")).toHaveLength(3);
    expect([...preEqModule.querySelectorAll<HTMLInputElement>(".dsp-eq-bands fieldset input")].every((input) => Number.isFinite(Number(input.value)))).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(bandCount, "1");
      bandCount?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(preEqModule.querySelectorAll(".dsp-eq-bands fieldset")).toHaveLength(1);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(bandCount, "25");
      bandCount?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(preEqModule.querySelectorAll(".dsp-eq-bands fieldset")).toHaveLength(20);
  });

  it("blocks invalid DSP drafts and exposes accessible validation errors", async () => {
    const configure = vi.spyOn(useAppStore.getState(), "configureDsp");
    bridgeMocks.dspGetConfiguration.mockResolvedValue({ ...dspConfiguration, bassEnhancer: { ...dspConfiguration.bassEnhancer, harmonicGain: 2 } });
    bridgeMocks.dspListPresets.mockResolvedValue([]);
    useAppStore.setState({ view: "dsp" });
    await act(async () => root.render(<CurrentView />));
    await settle();

    const apply = button(container, "应用参数");
    expect(apply.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("谐波增益必须在 0 到 1 之间");
    await act(async () => apply.click());
    expect(configure).not.toHaveBeenCalled();
  });

  it("shows an active Rust chain as live and faults as safe bypass", async () => {
    const base = {
      revision: 2,
      current: null,
      currentQueueItemId: null,
      status: "paused" as const,
      positionMs: 0,
      volume: 0.5,
      queue: [],
      nextUp: [],
      repeat: "sequence" as const,
      dsp: { available: true, bypassed: false, label: "Rust DSP runtime 已内建" },
      dspExecution: { revision: 2n, safeBypassActive: false, fault: null },
    };
    useAppStore.setState({ view: "dsp", playback: base });
    await act(async () => root.render(<CurrentView />));
    expect(container.textContent).toContain("Rust 处理链在线");
    expect(container.textContent).toContain("LIVE");

    await act(async () => {
      useAppStore.setState({
        playback: {
          ...base,
          dsp: { ...base.dsp, bypassed: true },
          dspExecution: { revision: 2n, safeBypassActive: true, fault: null },
        },
      });
    });
    expect(container.textContent).toContain("Rust 安全旁路");
    expect(container.textContent).toContain("BYPASS");
  });

  it("uses real telemetry with fallback renderers while keeping DSP controls honest", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useAppStore.setState({ view: "dsp", playback: null });

    await act(async () => root.render(<CurrentView />));
    await settle();

    expect(bridgeMocks.createTelemetryTransport).toHaveBeenCalledOnce();
    expect(telemetryTransport.open).toHaveBeenCalledWith(30, expect.any(Function));
    expect(container.querySelector('[aria-label="频谱暂无数据"]')).not.toBeNull();
    expect(container.querySelector('canvas[aria-label="实时音频频谱"]')).toBeNull();
    expect(container.querySelector('[role="group"][aria-label="RMS 和峰值仪表"]')).not.toBeNull();
    expect(container.querySelector('svg[aria-label="固定 0 dB 参考响应"]')).not.toBeNull();

    await act(async () => telemetryFrame?.(makeTelemetryFrame({
      validityFlags: TELEMETRY_VALID_WAVEFORM | TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS | TELEMETRY_VALID_SPECTRUM,
      meters: { rmsLeft: 0.5, rmsRight: 0.25 },
    })));
    expect(container.querySelector('canvas[aria-label="实时音频频谱"]')).not.toBeNull();
    expect(Number(container.querySelector('[role="meter"][aria-label="左声道 RMS"]')?.getAttribute("aria-valuenow"))).toBeCloseTo(-6.02, 1);
    expect(container.textContent).not.toContain("真峰值");
    expect(container.textContent).not.toContain("限幅衰减");
    expect(telemetryTransport.acknowledge).toHaveBeenCalledWith(4n, 9n, 12n);
    expect(container.textContent).toContain("固定平直参考，不代表当前 DSP 配置");
    expect(button(container, "应用参数").disabled).toBe(true);
    expect(container.textContent).not.toContain("当前均衡响应");
  });

  it("scales telemetry for visibility, focus, and reduced motion, then closes on unmount", async () => {
    let motionListener: ((event: MediaQueryListEvent) => void) | undefined;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn((_type, listener) => { motionListener = listener; }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    useAppStore.setState({ view: "dsp" });

    await act(async () => root.render(<CurrentView />));
    await settle();
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(telemetryTransport.setRate).toHaveBeenLastCalledWith(15);

    await act(async () => motionListener?.({ matches: true } as MediaQueryListEvent));
    expect(telemetryTransport.setRate).toHaveBeenLastCalledWith(2);

    visibility.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(telemetryTransport.setRate).toHaveBeenLastCalledWith(0);

    await act(async () => root.unmount());
    expect(telemetryTransport.close).toHaveBeenCalledOnce();
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
});
