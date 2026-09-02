import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsDto } from "../bridge/contracts";

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
  libraryOverview: vi.fn(),
  cacheStats: vi.fn(),
  neteaseStatus: vi.fn(),
  updaterStatus: vi.fn(),
  updaterCheck: vi.fn(),
  updaterUpdate: vi.fn(),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMocks } };
});

import { SettingsView } from "./SettingsView";
import { useAppStore } from "../store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("SettingsView 更新器与不可用状态", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMocks.libraryOverview.mockResolvedValue({ trackCount: 0, albumCount: 0, artistCount: 0, scanActive: false });
    bridgeMocks.cacheStats.mockResolvedValue({ entryCount: 0, bytesUsed: 0, activeTasks: 0, lockedEntries: 0 });
    bridgeMocks.neteaseStatus.mockResolvedValue({ enabled: true, authenticated: false, userId: null, displayName: null });
    bridgeMocks.updaterStatus.mockResolvedValue({ enabled: true, reason: null });
    bridgeMocks.updaterCheck.mockResolvedValue({ available: false, version: null, currentVersion: "0.1.0", notes: null });
    bridgeMocks.updaterUpdate.mockResolvedValue(true);
    useAppStore.setState({ settings, playback: null, tasks: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows updater status failures and keeps checking disabled", async () => {
    bridgeMocks.updaterStatus.mockRejectedValue(new Error("missing key"));
    await act(async () => root.render(<SettingsView />));
    await settle();
    await act(async () => button(container, "关于").click());

    expect(container.textContent).toContain("更新器状态暂不可用");
    expect(container.textContent).toContain("状态读取失败");
    expect(button(container, "检查更新").disabled).toBe(true);
  });

  it("shows check and install errors instead of retaining success state", async () => {
    await act(async () => root.render(<SettingsView />));
    await settle();
    await act(async () => button(container, "关于").click());

    bridgeMocks.updaterCheck.mockRejectedValueOnce(new Error("offline"));
    await act(async () => button(container, "检查更新").click());
    await settle();
    expect(container.textContent).toContain("检查更新失败");

    bridgeMocks.updaterCheck.mockResolvedValueOnce({ available: true, version: "0.2.0", currentVersion: "0.1.0", notes: "安全更新" });
    await act(async () => button(container, "检查更新").click());
    await settle();
    bridgeMocks.updaterUpdate.mockRejectedValueOnce(new Error("signature rejected"));
    await act(async () => button(container, "下载并安装").click());
    await settle();

    expect(bridgeMocks.updaterUpdate).toHaveBeenCalledWith("0.2.0");
    expect(container.textContent).toContain("更新安装失败");
  });

  it("treats a false install result as no update remaining", async () => {
    bridgeMocks.updaterCheck.mockResolvedValue({ available: true, version: "0.2.0", currentVersion: "0.1.0", notes: "安全更新" });
    bridgeMocks.updaterUpdate.mockResolvedValue(false);
    await act(async () => root.render(<SettingsView />));
    await settle();
    await act(async () => button(container, "关于").click());
    await act(async () => button(container, "检查更新").click());
    await settle();
    await act(async () => button(container, "下载并安装").click());
    await settle();

    expect(bridgeMocks.updaterUpdate).toHaveBeenCalledWith("0.2.0");
    expect(container.textContent).toContain("当前已是最新版本");
    expect(container.textContent).not.toContain("发现新版本 0.2.0");
    expect(container.textContent).not.toContain("可用更新");
  });

  it("states unavailable and read-only settings explicitly", async () => {
    await act(async () => root.render(<SettingsView />));
    await settle();

    await act(async () => button(container, "音频与 DSP").click());
    expect(container.textContent).toContain("Rust DSP 核心已接通");
    expect(container.textContent).toContain("14 个处理器");
    expect(container.textContent).toContain("参数配置、预设与 HSE2 分享码通过 DspPort 生效");
    expect(container.textContent).toContain("DspPort");
    expect(container.textContent).toContain("HSE2");
    expect(container.textContent).toContain("功能降级");
    expect(container.textContent).toContain("不接管播放");
    expect(container.textContent).toContain("Rust Engine");

    await act(async () => button(container, "系统集成").click());
    expect(container.textContent).toContain("系统独占输出");
    expect(container.textContent).toContain("不可用");

    await act(async () => button(container, "隐私").click());
    expect(container.textContent).toContain("不可导出");
    expect(container.textContent).toContain("不提供下载或导出能力");
  });
});
