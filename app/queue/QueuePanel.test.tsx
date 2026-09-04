import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSnapshotDto, TrackDto } from "../bridge/contracts";
import { useAppStore } from "../store";
import { QueuePanel } from "./QueuePanel";

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } satisfies Storage,
  });
});

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const track = (id: string): TrackDto => ({
  id,
  title: `歌曲 ${id}`,
  artists: ["测试歌手"],
  album: "测试专辑",
  durationMs: 180_000,
  source: "netease",
  entitlement: "free",
  quality: "无损",
  cache: "none",
  coverSeed: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
});

const playback: PlaybackSnapshotDto = {
  revision: "1",
  current: track("current"),
  currentQueueItemId: "queue-current",
  status: "playing",
  positionMs: 12_000,
  durationMs: 120_000,
  volume: 0.6,
  queue: [{ queueItemId: "queue-context", track: track("context") }],
  nextUp: [{ queueItemId: "queue-next", track: track("next") }],
  repeat: "sequence",
  shuffled: false,
  dspExecution: { revision: "0", safeBypassActive: false, fault: null },
};

describe("QueuePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  const playTrack = vi.fn(async () => undefined);

  beforeEach(() => {
    localStorage.clear();
    playTrack.mockClear();
    useAppStore.getState().dispose();
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ playback, overlay: "queue", playTrack });
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

  it("keeps next-up and context items available in the on-demand panel", async () => {
    await act(async () => root.render(<QueuePanel/>));

    expect(container.textContent).toContain("接下来播放");
    expect(container.textContent).toContain("歌曲 next");
    expect(container.textContent).toContain("当前上下文");
    expect(container.textContent).toContain("歌曲 context");
  });

  it("does not expose next-up rows as fake playback controls", async () => {
    await act(async () => root.render(<QueuePanel/>));
    const nextUpRow = [...container.querySelectorAll<HTMLElement>(".queue-item")]
      .find((item) => item.textContent?.includes("歌曲 next"));

    expect(nextUpRow).toBeDefined();
    expect(nextUpRow?.getAttribute("tabindex")).toBeNull();
    expect(nextUpRow?.getAttribute("aria-current")).toBeNull();
    await act(async () => nextUpRow?.click());
    expect(playTrack).not.toHaveBeenCalled();
  });

  it("shows source, entitlement, quality, and cache semantics without making rows controls", async () => {
    useAppStore.setState({
      playback: {
        ...playback,
        nextUp: [{ queueItemId: "queue-next", track: { ...track("next"), entitlement: "vip", cache: "ready", quality: "Hi-Res" } }],
      },
    });
    await act(async () => root.render(<QueuePanel/>));
    const nextUpRow = [...container.querySelectorAll<HTMLElement>(".queue-item")]
      .find((item) => item.textContent?.includes("歌曲 next"));

    expect(nextUpRow?.textContent).toContain("云");
    expect(nextUpRow?.textContent).toContain("VIP");
    expect(nextUpRow?.textContent).toContain("Hi-Res");
    expect(nextUpRow?.querySelector('[aria-label="已缓存"]')).not.toBeNull();
    expect(nextUpRow?.getAttribute("role")).toBe("listitem");
  });

  it("switches between the main and floating surfaces without persisting floating", async () => {
    await act(async () => root.render(<QueuePanel/>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="队列布局"]')?.click());
    await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "浮动")?.click());

    expect(useAppStore.getState()).toMatchObject({ overlay: "none", queueFloating: true });
    expect(localStorage.getItem("hyperplayer.queue-placement")).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<QueuePanel floating/>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="队列布局"]')?.click());
    await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "左侧")?.click());

    expect(useAppStore.getState()).toMatchObject({ overlay: "queue", queueFloating: false });
    expect(localStorage.getItem("hyperplayer.queue-placement")).toBe("left");
  });

  it("persists constrained dock dimensions and exposes truthful layout state", async () => {
    localStorage.setItem("hyperplayer.queue-width", "999");
    localStorage.setItem("hyperplayer.queue-height", "100");
    await act(async () => root.render(<QueuePanel/>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="队列布局"]')?.click());

    const width = container.querySelector<HTMLInputElement>('[aria-label="队列停靠宽度"]');
    const height = container.querySelector<HTMLInputElement>('[aria-label="队列停靠高度"]');
    expect(width?.value).toBe("560");
    expect(height?.value).toBe("220");
    expect(container.querySelector('[role="radiogroup"][aria-label="队列停靠位置"]')).not.toBeNull();
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("右侧");
    expect([...container.querySelectorAll<HTMLButtonElement>(".layout-preset")].filter((item) => item.classList.contains("active")).map((item) => item.textContent)).toEqual([expect.stringContaining("聆听")]);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(width, "460");
      width?.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(height, "380");
      height?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(localStorage.getItem("hyperplayer.queue-width")).toBe("460");
    expect(localStorage.getItem("hyperplayer.queue-height")).toBe("380");
    expect(container.querySelector<HTMLElement>(".queue-panel")?.style.getPropertyValue("--queue-dock-width")).toBe("460px");
    expect(container.querySelector<HTMLElement>(".queue-panel")?.style.getPropertyValue("--queue-dock-height")).toBe("380px");

    await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("曲库管理"))?.click());
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("底部");
    expect([...container.querySelectorAll<HTMLButtonElement>(".layout-preset")].find((item) => item.textContent?.includes("曲库管理"))?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("DSP 调音"))?.click());
    expect(useAppStore.getState().view).toBe("dsp");
    expect([...container.querySelectorAll<HTMLButtonElement>(".layout-preset")].find((item) => item.textContent?.includes("DSP 调音"))?.getAttribute("aria-pressed")).toBe("true");
  });

  it("supports tab arrow keys, Escape close, and focus restoration", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    await act(async () => root.render(<QueuePanel floating/>));

    const queueTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    expect(document.activeElement).not.toBe(trigger);
    expect(queueTab?.getAttribute("aria-controls")).toBeTruthy();
    await act(async () => queueTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("布局");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBeTruthy();

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(useAppStore.getState().queueFloating).toBe(false);
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(trigger);
    trigger.remove();

    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
});
