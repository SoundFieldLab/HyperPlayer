import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendCacheStatusDto, PlaybackSnapshotDto, TrackDto } from "../bridge/contracts";

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
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMocks } };
});

import { ExpandedPlayer } from "./Player";
import { useAppStore } from "../store";

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
  current,
  currentQueueItemId: `queue-${current.id}`,
  status: "playing",
  positionMs: 10_000,
  volume: 0.6,
  queue: [],
  nextUp: [],
  repeat: "sequence",
  dsp: { available: false, bypassed: true, label: "规格待接入" },
});

function status(id: string, value: BackendCacheStatusDto["status"]): BackendCacheStatusDto {
  return {
    track: { id, source: "netease" },
    quality: value === "missing" ? null : "lossless",
    cachedVersions: value === "missing" ? 0 : 1,
    status: value,
    accessClass: value === "lockedEntitlement" ? "accountEntitled" : "public",
    ownerUserId: value === "lockedEntitlement" ? "owner" : null,
    lastValidatedAt: null,
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

describe("ExpandedPlayer 缓存控制", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMocks.cacheStatus.mockResolvedValue(status("first", "missing"));
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
    await act(async () => root.unmount());
    container.remove();
  });

  it.each([
    ["missing", "缓存", false],
    ["failed", "重试缓存", false],
    ["queued", "已加入缓存队列", true],
    ["caching", "正在缓存", true],
    ["ready", "移除缓存", false],
    ["lockedEntitlement", "权益缓存已锁定", true],
  ] as const)("renders the %s cache state", async (cacheState, label, disabled) => {
    bridgeMocks.cacheStatus.mockResolvedValue(status("first", cacheState));
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();

    expect(button(container, label).disabled).toBe(disabled);
    if (cacheState === "lockedEntitlement") {
      expect(container.textContent).toContain("当前绑定账号的服务端权益验证通过后才能使用");
    }
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="更多"]')?.disabled).toBe(true);
    expect(button(container, "喜欢").disabled).toBe(true);
  });

  it("uses the trusted current track ref and actual quality, then refreshes status", async () => {
    useAppStore.setState({ playback: playback(track("first", "Hi-Res")) });
    bridgeMocks.cacheStatus
      .mockResolvedValueOnce(status("first", "missing"))
      .mockResolvedValueOnce(status("first", "queued"));
    await act(async () => root.render(<ExpandedPlayer />));
    await settle();
    await act(async () => button(container, "缓存").click());
    await settle();

    expect(bridgeMocks.cacheTrack).toHaveBeenCalledWith({ id: "first", source: "netease" }, "Hi-Res");
    expect(bridgeMocks.cacheStatus).toHaveBeenNthCalledWith(1, { id: "first", source: "netease" });
    expect(bridgeMocks.cacheStatus).toHaveBeenNthCalledWith(2, { id: "first", source: "netease" });
    expect(button(container, "已加入缓存队列").disabled).toBe(true);
  });

  it("removes a ready cache and refreshes status", async () => {
    bridgeMocks.cacheStatus
      .mockResolvedValueOnce(status("first", "ready"))
      .mockResolvedValueOnce(status("first", "missing"));
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
    first.resolve(status("first", "missing"));
    await settle();

    expect(bridgeMocks.cacheStatus).toHaveBeenNthCalledWith(2, { id: "second", source: "netease" });
    expect(button(container, "移除缓存").disabled).toBe(false);
    expect(container.textContent).not.toContain("缓存当前曲目");
  });

  it("shows status errors inline and retries without affecting playback", async () => {
    bridgeMocks.cacheStatus
      .mockRejectedValueOnce(new Error("缓存状态暂时不可用"))
      .mockResolvedValueOnce(status("first", "missing"));
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
});
