import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DspConfigurationDto } from "../bridge/contracts";

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
  dspGetConfiguration: vi.fn(),
  dspListPresets: vi.fn(),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMocks } };
});

import { DspWorkbenchView } from "./DspWorkbench";
import { useAppStore } from "../store";
import { makeTelemetryFrame } from "../visualization/telemetry/test-fixtures";
import { TELEMETRY_VALID_RMS, TELEMETRY_VALID_SAMPLE_PEAK, TELEMETRY_VALID_SPECTRUM, TELEMETRY_VALID_WAVEFORM } from "../visualization/telemetry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  spatial: { mode: "off", masterGain: 0.9, instantAmount: 0.7, instantSpreadDeg: 60, instantRoom: "studio", instantRoomAmount: 0.15, distanceModel: "inverse", refDistance: 1, maxDistance: 50, convolution: "partitioned", hrtfInterp: "nearest", stagePreset: "stage", seat: "middle", stageRoomSize: 1, stageReverbAmount: 0.35, worldOcclusion: 0, ambienceEnabled: false, ambienceAmount: 0.3 },
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

async function openModule(container: HTMLElement, name: string): Promise<void> {
  const card = container.querySelector<HTMLElement>(`[aria-label="${name}设置"]`);
  if (!card) throw new Error(`找不到效果卡片：${name}`);
  await act(async () => card.click());
  await settle();
}

async function closeModal(container: HTMLElement, name: string): Promise<void> {
  const modal = container.querySelector(`[role="dialog"][aria-label="${name}设置"]`);
  const close = modal?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
  if (!close) throw new Error(`找不到关闭按钮：${name}`);
  await act(async () => close.click());
  await settle();
}

describe("DspWorkbench 音效工作台", () => {
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
    bridgeMocks.dspGetConfiguration.mockRejectedValue(new Error("DSP fixture not enabled"));
    bridgeMocks.dspListPresets.mockResolvedValue([]);
    useAppStore.setState({
      domain: "local",
      view: "dsp",
      detailId: null,
      detailKind: null,
      navigation: {
        netease: { current: { view: "home", detailId: null, detailKind: null }, back: [], forward: [] },
        local: { current: { view: "dsp", detailId: null, detailKind: null }, back: [], forward: [] },
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

  it("renders the engine overview honestly when configuration is unavailable", async () => {
    await act(async () => root.render(<DspWorkbenchView />));
    await settle();

    expect(container.textContent).toContain("音效工作台");
    expect(container.textContent).toContain("Rust 配置编译中");
    expect(container.textContent).toContain("22 个处理器");
    expect(container.textContent).toContain("vendored HSE Rust");
    expect(container.textContent).toContain("BYPASS");
    expect(container.textContent).not.toContain("LIVE");
    expect(container.textContent).toContain("DSP 配置不可用");
    expect(container.textContent).toContain("HSE2 分享码");
    expect(container.querySelector(".dsp-applybar")).toBeNull();
  });

  it("renders grouped effect cards and constrained controls inside module dialogs", async () => {
    bridgeMocks.dspGetConfiguration.mockResolvedValue(dspConfiguration);
    bridgeMocks.dspListPresets.mockResolvedValue([{ id: "studio", name: "录音室", description: "测试", partial: false, unsupportedStages: [] }]);
    await act(async () => root.render(<DspWorkbenchView />));
    await settle();

    expect(container.textContent).toContain("响度与音量");
    expect(container.textContent).toContain("空间与声场");
    expect(container.textContent).toContain("均衡与音色");
    expect(container.textContent).toContain("动态与调制");
    expect(container.textContent).toContain("等待播放");
    expect(container.querySelector(".dsp-scenes")).not.toBeNull();
    expect(container.querySelector(".dsp-share-actions")).not.toBeNull();
    expect(container.querySelector(".eq-reference")).not.toBeNull();

    await openModule(container, "环绕运动");
    let modal = container.querySelector('[role="dialog"][aria-label="环绕运动设置"]');
    expect(modal).not.toBeNull();
    const direction = [...modal!.querySelectorAll("label")].find((label) => label.textContent?.includes("方向"))?.querySelector("select");
    expect([...direction?.options ?? []].map((option) => option.value)).toEqual(["-1", "1"]);
    const surroundDistance = modal!.querySelector<HTMLInputElement>('input[type="number"]');
    expect(surroundDistance).toMatchObject({ min: "0", max: "10" });
    await closeModal(container, "环绕运动");

    await openModule(container, "移相");
    modal = container.querySelector('[role="dialog"][aria-label="移相设置"]');
    const stages = modal!.querySelector<HTMLInputElement>('input[aria-label="级数"]');
    expect(stages).toMatchObject({ min: "2", max: "8", step: "1" });
    await closeModal(container, "移相");

    await openModule(container, "夜间模式");
    modal = container.querySelector('[role="dialog"][aria-label="夜间模式设置"]');
    const nightAmount = modal!.querySelector<HTMLInputElement>('input[type="number"]');
    expect(nightAmount).toMatchObject({ min: "0", max: "10" });
    await closeModal(container, "夜间模式");

    await openModule(container, "低频增强");
    modal = container.querySelector('[role="dialog"][aria-label="低频增强设置"]');
    const bassInputs = [...modal!.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    expect(bassInputs.map((input) => [input.min, input.max])).toEqual([["20", "500"], ["0.1", "10"], ["0", "1"], ["0", "1"], ["-6", "6"], ["-6", "12"]]);
    await closeModal(container, "低频增强");
  });

  it("keeps pre-EQ bandCount and bands synchronized at both boundaries", async () => {
    bridgeMocks.dspGetConfiguration.mockResolvedValue(dspConfiguration);
    await act(async () => root.render(<DspWorkbenchView />));
    await settle();

    await openModule(container, "参数均衡");
    const modal = container.querySelector('[role="dialog"][aria-label="参数均衡设置"]');
    if (!modal) throw new Error("找不到参数均衡弹窗");
    const bandCount = modal.querySelector<HTMLInputElement>('input[aria-label="频段数 精确值"]');
    expect(bandCount).toMatchObject({ min: "1", max: "20", step: "1" });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(bandCount, "3");
      bandCount?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(modal.querySelectorAll(".dsp-eq-bands fieldset")).toHaveLength(3);
    expect([...modal.querySelectorAll<HTMLInputElement>(".dsp-eq-bands fieldset input")].every((input) => Number.isFinite(Number(input.value)))).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(bandCount, "1");
      bandCount?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(modal.querySelectorAll(".dsp-eq-bands fieldset")).toHaveLength(1);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(bandCount, "25");
      bandCount?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(modal.querySelectorAll(".dsp-eq-bands fieldset")).toHaveLength(20);

    const eqBand = modal.querySelector(".dsp-eq-bands fieldset");
    expect(eqBand?.querySelectorAll('input[type="number"]')).toHaveLength(3);
    expect([...eqBand?.querySelectorAll(".dsp-param-head > span") ?? []].map((item) => item.textContent)).toEqual(["频率 Hz", "增益 dB", "Q"]);
    const frequency = eqBand?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(frequency).toMatchObject({ min: "20", max: "20000", step: "1" });
  });

  it("blocks invalid DSP drafts and exposes accessible validation errors", async () => {
    const configure = vi.spyOn(useAppStore.getState(), "configureDsp");
    bridgeMocks.dspGetConfiguration.mockResolvedValue({ ...dspConfiguration, bassEnhancer: { ...dspConfiguration.bassEnhancer, harmonicGain: 2 } });
    await act(async () => root.render(<DspWorkbenchView />));
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
    await act(async () => root.render(<DspWorkbenchView />));
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
    bridgeMocks.dspGetConfiguration.mockResolvedValue(dspConfiguration);
    useAppStore.setState({ view: "dsp", playback: null });

    await act(async () => root.render(<DspWorkbenchView />));
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
    const telemetrySection = container.querySelector('[aria-label="实时 RMS 和峰值遥测"]');
    expect(telemetrySection?.textContent).not.toContain("真峰值");
    expect(telemetrySection?.textContent).not.toContain("限幅衰减");
    expect(telemetryTransport.acknowledge).toHaveBeenCalledWith(4n, 9n, 12n);
    expect(container.textContent).toContain("固定平直参考，不代表当前 DSP 配置");
    expect(button(container, "应用参数").disabled).toBe(false);
    expect(container.textContent).toContain("与引擎当前配置一致");
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

    await act(async () => root.render(<DspWorkbenchView />));
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
