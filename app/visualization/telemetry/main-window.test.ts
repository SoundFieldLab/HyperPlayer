import { describe, expect, it, vi } from "vitest";
import type { TelemetryTransport } from "./session";
import { acquireMainWindowTelemetry } from "./main-window";

const active = {
  open: true,
  visible: true,
  focused: true,
  reducedMotion: false,
  powerSave: false,
} as const;

async function flushLifecycle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("main-window telemetry ownership", () => {
  it("shares one backend session across hosts and closes after the final release", async () => {
    const transport: TelemetryTransport = {
      open: vi.fn(),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    const createTransport = vi.fn(() => transport);
    const player = acquireMainWindowTelemetry(createTransport, active);
    const dsp = acquireMainWindowTelemetry(createTransport, active);
    await flushLifecycle();

    expect(createTransport).toHaveBeenCalledOnce();
    expect(transport.open).toHaveBeenCalledOnce();
    player.release();
    await flushLifecycle();
    expect(transport.close).not.toHaveBeenCalled();
    dsp.release();
    await flushLifecycle();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("cancels a deferred close when StrictMode immediately reacquires", async () => {
    const transport: TelemetryTransport = {
      open: vi.fn(),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    const createTransport = vi.fn(() => transport);
    const probe = acquireMainWindowTelemetry(createTransport, active);
    await flushLifecycle();
    probe.release();
    const mounted = acquireMainWindowTelemetry(createTransport, active);
    await flushLifecycle();

    expect(createTransport).toHaveBeenCalledOnce();
    expect(transport.open).toHaveBeenCalledOnce();
    expect(transport.close).not.toHaveBeenCalled();
    mounted.release();
    await flushLifecycle();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
