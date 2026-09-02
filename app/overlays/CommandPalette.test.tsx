import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSnapshotDto, ShenzhenWeatherDto, TrackDto } from "../bridge/contracts";

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

import { useAppStore } from "../store";
import { CommandPalette } from "./CommandPalette";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const weather: ShenzhenWeatherDto = {
  location: "深圳",
  observedAt: "2026-09-01T12:30",
  temperatureC: 31.2,
  apparentTemperatureC: 35.7,
  relativeHumidityPercent: 72,
  weatherCode: 61,
  condition: "雨",
  windSpeedKmh: 8.4,
  isDay: true,
};

const track: TrackDto = {
  id: "current",
  title: "深圳夜曲",
  artists: ["测试歌手"],
  album: "测试专辑",
  durationMs: 180_000,
  source: "local",
  entitlement: "free",
  quality: "无损",
  cache: "none",
  coverSeed: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
};

const playback: PlaybackSnapshotDto = {
  revision: 1,
  current: track,
  currentQueueItemId: "queue-current",
  status: "playing",
  positionMs: 42_000,
  volume: 0.7,
  queue: [],
  nextUp: [],
  repeat: "sequence",
  dsp: { available: true, bypassed: true, label: "Rust DSP runtime 已内建；完整 22 阶段与 DspPort 尚未接通" },
  dspExecution: { revision: 0n, safeBypassActive: false, fault: null },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CommandPalette 命令中心", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAppStore.setState({
      playback,
      tasks: [{ id: "scan", kind: "scan", title: "扫描曲库", detail: "读取标签", progress: 0.5, state: "running" }],
      searchOpen: true,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows real clock, playback, tasks and resolved Shenzhen weather", async () => {
    const request = deferred<ShenzhenWeatherDto>();
    await act(async () => root.render(<CommandPalette loadWeather={() => request.promise} now={() => new Date("2026-09-01T08:05:00+08:00")}/>));
    expect(container.textContent).toContain("08:05");
    expect(container.textContent).toContain("9月1日星期二");
    expect(container.textContent).toContain("正在获取天气");
    expect(container.textContent).toContain("深圳夜曲");
    expect(container.textContent).toContain("1 个后台任务进行中");

    request.resolve(weather);
    await settle();
    expect(container.textContent).toContain("31°");
    expect(container.textContent).toContain("雨 · 体感 36°");
    expect(container.textContent).toContain("湿度 72%");
  });

  it("keeps the center open after failure and retries weather", async () => {
    const loadWeather = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(weather);
    await act(async () => root.render(<CommandPalette loadWeather={loadWeather} now={() => new Date("2026-09-01T08:05:00+08:00")}/>));
    await settle();
    expect(container.textContent).toContain("天气暂不可用");
    expect(useAppStore.getState().searchOpen).toBe(true);

    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="重试深圳天气"]');
    await act(async () => retry?.click());
    await settle();
    expect(loadWeather).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("31°");
  });

  it("opens the first filtered command with Enter", async () => {
    await act(async () => root.render(<CommandPalette loadWeather={async () => weather} now={() => new Date("2026-09-01T08:05:00+08:00")}/>));
    await settle();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索命令"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "设置");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().searchOpen).toBe(false);
  });

  it("filters command shortcuts without showing stale dashboard content", async () => {
    await act(async () => root.render(<CommandPalette loadWeather={async () => weather} now={() => new Date("2026-09-01T08:05:00+08:00")}/>));
    await settle();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索命令"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "设置");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("打开设置");
    expect(container.textContent).not.toContain("深圳夜曲");
    expect(container.textContent).not.toContain("打开网易云首页");
  });
});
