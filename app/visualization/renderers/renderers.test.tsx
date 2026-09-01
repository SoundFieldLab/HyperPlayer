import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeterStrip } from "./MeterStrip";
import { drawSpectrumCanvas2D, SpectrumCanvas2D } from "./SpectrumCanvas2D";
import { drawWaveformCanvas2D } from "./WaveformCanvas2D";
import { responseCurvePath } from "./ResponseCurveSvg";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function drawingContext() {
  return {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D;
}

describe("fallback renderer primitives", () => {
  it("emits deterministic stereo waveform commands", () => {
    const context = drawingContext();
    drawWaveformCanvas2D(context, 20, 20, [
      { leftMin: -1, leftMax: 1, rightMin: -0.5, rightMax: 0.5 },
      { leftMin: 0, leftMax: 0.5, rightMin: -1, rightMax: 0 },
    ], { lineWidth: 2 });

    expect(context.moveTo).toHaveBeenNthCalledWith(1, 0, 10);
    expect(context.lineTo).toHaveBeenNthCalledWith(1, 20, 10);
    expect(context.moveTo).toHaveBeenNthCalledWith(2, 5, 1);
    expect(context.lineTo).toHaveBeenNthCalledWith(2, 5, 9);
    expect(context.stroke).toHaveBeenCalledTimes(3);
  });

  it("maps spectrum dB values into fixed bars", () => {
    const context = drawingContext();
    drawSpectrumCanvas2D(context, 30, 100, [-90, -45, 0], { gapRatio: 0 });
    expect(context.fillRect).toHaveBeenNthCalledWith(1, 0, 100, 10, 0);
    expect(context.fillRect).toHaveBeenNthCalledWith(2, 10, 50, 10, 50);
    expect(context.fillRect).toHaveBeenNthCalledWith(3, 20, 0, 10, 100);
  });

  it("renders truthful RMS and channel peak labels without claiming LUFS", () => {
    const markup = renderToStaticMarkup(<MeterStrip meters={{
      peakLeft: 1,
      peakRight: 0.5,
      truePeakLeft: 1,
      truePeakRight: 0.5,
      rmsLeft: 0.5,
      rmsRight: 0.25,
      limiterReduction: 2,
    }} />);

    expect(markup).toContain("RMS");
    expect(markup).toContain("左声道采样峰值");
    expect(markup).toContain("-6.0");
    expect(markup).not.toContain("真峰值");
    expect(markup).not.toContain("限幅衰减");
    expect(markup).not.toContain("LUFS");
  });

  it("builds a logarithmic response curve path", () => {
    expect(responseCurvePath([
      { frequencyHz: 20, gainDb: -24 },
      { frequencyHz: 200, gainDb: 0 },
      { frequencyHz: 20_000, gainDb: 24 },
    ], 300, 120)).toBe("M0.00 120.00 L100.00 60.00 L300.00 0.00");
  });
});

describe("responsive canvas lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const disconnect = vi.fn();
  const observe = vi.fn();

  beforeEach(() => {
    disconnect.mockClear();
    observe.mockClear();
    class ResizeObserverMock {
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("devicePixelRatio", 3);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 40,
      top: 0,
      right: 120,
      bottom: 40,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawingContext());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("caps high DPR backing stores at 2 and disconnects each StrictMode observer", async () => {
    await act(async () => root.render(
      <StrictMode><SpectrumCanvas2D bins={new Float32Array([-30, -12])} /></StrictMode>,
    ));
    const canvas = container.querySelector("canvas");
    expect(canvas?.width).toBe(240);
    expect(canvas?.height).toBe(80);
    expect(observe).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });
});
