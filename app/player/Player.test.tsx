import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendCacheStatusDto, PlaybackSnapshotDto, TrackDto } from "../bridge/contracts";
import type { TelemetryTransport } from "../visualization/telemetry";

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
  cacheStatus: vi.fn(),
  cacheTrack: vi.fn(),
  cacheRemove: vi.fn(),
  lyricsGet: vi.fn(),
  createTelemetryTransport: vi.fn(),
  setVolume: vi.fn(),
  setRepeatMode: vi.fn(),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMocks } };
});

vi.mock("../visualization/renderers", () => ({
  WaveformCanvas2D: ({ bins, ariaLabel }: { bins: readonly unknown[]; ariaLabel?: string }) => (
    <canvas aria-label={ariaLabel} data-bin-count={bins.length} />
  ),
}));

import { ExpandedPlayer, PlayerDock } from "./Player";
import { useAppStore } from "../store";
import { makeTelemetryFrame } from "../visualization/telemetry/test-fixtures";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const track = (id: string, quality: TrackDto["quality"] = "无损"): TrackDto => ({
  id,
  title: `歌曲 ${id}`,
  artists: ["测试歌手"],
  album: "测试专辑",
  durationMs: 180_000,
  source: "netease",
  entitlement: "free",
  quality,
  cache: "none",
  coverSeed: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
});

const playback = (current: TrackDto): PlaybackSnapshotDto => ({
  revision: "1",
  current,
  currentQueueItemId: `queue-${current.id}`,
  status: "playing",
  positionMs: 10_000,
  durationMs: current.durationMs,
  volume: 0.6,
  queue: [],
  nextUp: [],
  repeat: "sequence",
  shuffled: false,
  dspExecution: { revision: "0", safeBypassActive: false, fault: null },
});

function status(id: string, value: BackendCacheStatusDto["status"]): BackendCacheStatusDto {
  const ready = value === "ready";
  return {
    status: value,
    bytesUsed: ready ? 8 * 1024 * 1024 : 0,
    entryCount: ready ? 1 : 0,
    activeTasks: 0,
    lockedEntries: value === "entitlement-locked" ? 1 : 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

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

describe("PlayerDock 固定播放栏", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAppStore.getState().dispose();
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ playback: null, overlay: "none" });
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
  });

  it("keeps the transport visible and disabled before a track is loaded", async () => {
    await act(async () => root.render(<PlayerDock />));
    expect(container.textContent).toContain("选择一首歌曲");
    expect(container.querySelector(".player-dock.empty")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="停止"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="播放队列"]')?.disabled).toBe(true);
  });

  it("never shows a placeholder quality label without a track", async () => {
    await act(async () => root.render(<PlayerDock />));
    expect(container.querySelector(".quality")?.textContent).toBe("—");
  });

  it("shows the loaded track quality in the dock", async () => {
    useAppStore.setState({ playback: playback(track("first", "Hi-Res")), overlay: "none" });
    await act(async () => root.render(<PlayerDock />));
    expect(container.querySelector(".quality")?.textContent).toBe("Hi-Res");
  });
});

describe("PlayerDock 弹层交互", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().dispose();
    useAppStore.setState(useAppStore.getInitialState(), true);
    // bridge 回包沿用注入的曲目快照，避免真实 playback 服务的空快照覆盖 store 状态
    bridgeMocks.setVolume.mockImplementation(async (volume: number) => ({ ...playback(track("first")), volume }));
    bridgeMocks.setRepeatMode.mockImplementation(async (repeat: PlaybackSnapshotDto["repeat"]) => ({ ...playback(track("first")), repeat }));
    useAppStore.setState({ playback: playback(track("first")), overlay: "none" });
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
  });

  function volumeButton(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(".volume-control .icon-button")!;
  }

  function popoverButton(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll<HTMLButtonElement>(".volume-popover button")].find((item) => item.textContent?.includes(label));
    if (!match) throw new Error(`找不到弹层按钮：${label}`);
    return match;
  }

  it("toggles the volume panel open and closed without muting", async () => {
    await act(async () => root.render(<PlayerDock />));
    expect(container.querySelector(".volume-popover")).toBeNull();

    await act(async () => volumeButton().click());
    expect(container.querySelector(".volume-popover")).not.toBeNull();
    expect(useAppStore.getState().playback?.volume).toBe(0.6);

    await act(async () => volumeButton().click());
    expect(container.querySelector(".volume-popover")).toBeNull();
  });

  it("toggles mute inside the panel and restores the previous level", async () => {
    await act(async () => root.render(<PlayerDock />));
    await act(async () => volumeButton().click());
    await act(async () => popoverButton("静音").click());
    await settle();
    expect(useAppStore.getState().playback?.volume).toBe(0);
    expect(container.querySelector(".volume-popover")?.textContent).toContain("取消静音");

    await act(async () => popoverButton("取消静音").click());
    await settle();
    expect(useAppStore.getState().playback?.volume).toBe(0.72);
    expect(container.querySelector(".volume-popover")).not.toBeNull();
  });

  it("closes the volume panel on Escape and outside pointer down", async () => {
    await act(async () => root.render(<PlayerDock />));
    await act(async () => volumeButton().click());
    expect(container.querySelector(".volume-popover")).not.toBeNull();

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".volume-popover")).toBeNull();

    await act(async () => volumeButton().click());
    await act(async () => { container.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(container.querySelector(".volume-popover")).toBeNull();
  });

  it("keeps the volume panel open when interacting inside it", async () => {
    await act(async () => root.render(<PlayerDock />));
    await act(async () => volumeButton().click());
    await act(async () => { container.querySelector<HTMLButtonElement>(".volume-popover button")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(container.querySelector(".volume-popover")).not.toBeNull();
  });

  it("opens the playback mode menu and closes it on Escape or outside pointer down", async () => {
    await act(async () => root.render(<PlayerDock />));
    const hit = container.querySelector<HTMLButtonElement>(".mode-menu-hit")!;
    await act(async () => hit.click());
    expect(container.querySelector(".mode-menu")).not.toBeNull();

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".mode-menu")).toBeNull();

    await act(async () => hit.click());
    await act(async () => { container.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(container.querySelector(".mode-menu")).toBeNull();
  });

  it("selects a playback mode from the menu and closes it", async () => {
    await act(async () => root.render(<PlayerDock />));
    await act(async () => container.querySelector<HTMLButtonElement>(".mode-menu-hit")!.click());
    await act(async () => button(container, "单曲循环").click());
    await settle();
    expect(useAppStore.getState().playback?.repeat).toBe("one");
    expect(container.querySelector(".mode-menu")).toBeNull();
  });
});

describe("ExpandedPlayer 缓存控制", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().dispose();
    useAppStore.setState(useAppStore.getInitialState(), true);
    bridgeMocks.createTelemetryTransport.mockImplementation((): TelemetryTransport => ({
      open: vi.fn(),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    }));
    bridgeMocks.cacheStatus.mockResolvedValue(status("first", "none"));
    bridgeMocks.cacheTrack.mockResolvedValue({ taskId: "cache-first", accepted: true });
    bridgeMocks.cacheRemove.mockResolvedValue(undefined);
    bridgeMocks.lyricsGet.mockResolvedValue({
      document: { source: "lrc", title: null, artists: [], album: null, language: null, offsetMs: 0, lines: [] },
      rawOriginal: "", rawTranslation: "", rawRomanization: "", rawWordSynced: "", rawWordSyncedTranslation: "", rawTtml: "",
    });
    useAppStore.setState({ playback: playback(track("first")), overlay: "none", expandedPlayer: true });
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
  });

  it.each([
    ["none", "缓存", false],
    ["failed", "重试缓存", false],
    ["prefetching", "正在缓存", true],
    ["prefetching", "正在缓存", true],
    ["ready", "移除缓存", false],
    ["entitlement-locked", "权益缓存已锁定", true],
  ] as const)("renders the %s cache state", async (cacheState, label, disabled) => {
    bridgeMocks.cacheStatus.mockResolvedValue(status("first", cacheState));
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();

    expect(button(container, label).disabled).toBe(disabled);
    if (cacheState === "entitlement-locked") {
      expect(container.textContent).toContain("当前绑定账号的服务端权益验证通过后才能使用");
    }
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="更多"]')?.disabled).toBe(true);
    expect(button(container, "喜欢").disabled).toBe(true);
  });

  it("uses the trusted current track ref and actual quality, then refreshes status", async () => {
    useAppStore.setState({ playback: playback(track("first", "Hi-Res")) });
    bridgeMocks.cacheStatus
      .mockResolvedValueOnce(status("first", "none"))
      .mockResolvedValueOnce(status("first", "prefetching"));
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();
    await act(async () => button(container, "缓存").click());
    await settle();

    expect(bridgeMocks.cacheTrack).toHaveBeenCalledWith({ id: "first", source: "netease" }, "Hi-Res");
    expect(bridgeMocks.cacheStatus).toHaveBeenNthCalledWith(1, { id: "first", source: "netease" });
    expect(bridgeMocks.cacheStatus).toHaveBeenNthCalledWith(2, { id: "first", source: "netease" });
    expect(button(container, "正在缓存").disabled).toBe(true);
  });

  it("removes a ready cache and refreshes status", async () => {
    bridgeMocks.cacheStatus
      .mockResolvedValueOnce(status("first", "ready"))
      .mockResolvedValueOnce(status("first", "none"));
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();
    await act(async () => button(container, "移除缓存").click());
    await settle();

    expect(bridgeMocks.cacheRemove).toHaveBeenCalledWith({ id: "first", source: "netease" });
    expect(bridgeMocks.cacheStatus).toHaveBeenCalledTimes(2);
    expect(button(container, "缓存").disabled).toBe(false);
  });

  it("ignores an old status response after the current track changes", async () => {
    const first = deferred<BackendCacheStatusDto>();
    const second = deferred<BackendCacheStatusDto>();
    bridgeMocks.cacheStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => root.render(<ExpandedPlayer />));

    await act(async () => useAppStore.setState({ playback: playback(track("second", "Hi-Res")) }));
    second.resolve(status("second", "ready"));
    await settle();
    first.resolve(status("first", "none"));
    await settle();

    expect(bridgeMocks.cacheStatus).toHaveBeenNthCalledWith(2, { id: "second", source: "netease" });
    expect(button(container, "移除缓存").disabled).toBe(false);
    expect(container.textContent).not.toContain("缓存当前曲目");
  });

  it("shows status errors inline and retries without affecting playback", async () => {
    bridgeMocks.cacheStatus
      .mockRejectedValueOnce(new Error("缓存状态暂时不可用"))
      .mockResolvedValueOnce(status("first", "none"));
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("缓存状态暂时不可用");
    expect(useAppStore.getState().playback?.status).toBe("playing");
    await act(async () => button(container, "重试查询").click());
    await settle();

    expect(bridgeMocks.cacheStatus).toHaveBeenCalledTimes(2);
    expect(button(container, "缓存").disabled).toBe(false);
    expect(useAppStore.getState().playback?.status).toBe("playing");
  });

  it("keeps the cache action retryable when the mutation fails", async () => {
    bridgeMocks.cacheTrack.mockRejectedValueOnce(new Error("缓存任务启动失败"));
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();
    await act(async () => button(container, "缓存").click());
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("缓存任务启动失败");
    expect(button(container, "重试缓存").disabled).toBe(false);
    expect(useAppStore.getState().playback?.status).toBe("playing");
    await act(async () => button(container, "重试缓存").click());
    await settle();

    expect(bridgeMocks.cacheTrack).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.cacheTrack).toHaveBeenLastCalledWith({ id: "first", source: "netease" }, "无损");
  });

  it("keeps Stop available for a loaded track", async () => {
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();
    const stopButton = container.querySelector<HTMLButtonElement>('button[aria-label="停止"]');
    expect(stopButton?.disabled).toBe(false);
  });

  it("opens waveform telemetry, renders decoded bins, and closes it on unmount", async () => {
    let onFrame: ((frame: ArrayBuffer | ArrayBufferView) => void) | undefined;
    const transport: TelemetryTransport = {
      open: vi.fn((_rate, handler) => { onFrame = handler; }),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    bridgeMocks.createTelemetryTransport.mockReturnValue(transport);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="波形"]')?.click());
    await settle();
    expect(bridgeMocks.createTelemetryTransport).toHaveBeenCalledOnce();
    expect(transport.open).toHaveBeenCalledWith(30, expect.any(Function));
    expect(container.querySelector('[aria-label="波形暂无数据"]')).not.toBeNull();

    await act(async () => onFrame?.(makeTelemetryFrame()));
    expect(container.querySelector('canvas[aria-label="实时立体声波形"]')?.getAttribute("data-bin-count")).toBe("64");
    expect(transport.acknowledge).toHaveBeenCalledWith(4n, 9n, 12n);

    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(transport.setRate).toHaveBeenCalledWith(15);
    await act(async () => root.unmount());
    await settle();
    expect(transport.close).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it("reuses one telemetry session across the StrictMode effect probe", async () => {
    const transport: TelemetryTransport = {
      open: vi.fn(),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    bridgeMocks.createTelemetryTransport.mockReturnValue(transport);
    await act(async () => root.render(<StrictMode><ExpandedPlayer /></StrictMode>));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="波形"]')?.click());
    await settle();

    expect(bridgeMocks.createTelemetryTransport).toHaveBeenCalledOnce();
    expect(transport.open).toHaveBeenCalledOnce();
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("keeps the empty baseline when waveform telemetry is unavailable", async () => {
    const transport: TelemetryTransport = {
      open: vi.fn().mockRejectedValue(new Error("telemetry unavailable")),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    bridgeMocks.createTelemetryTransport.mockReturnValue(transport);
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="波形"]')?.click());
    await settle();

    expect(container.querySelector('[aria-label="波形暂无数据"]')).not.toBeNull();
    expect(container.querySelector('canvas[aria-label="实时立体声波形"]')).toBeNull();
  });
});
