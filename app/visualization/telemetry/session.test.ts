import { describe, expect, it, vi } from "vitest";
import { activityRate, createActivityController, type VisualizationActivity } from "./activity";
import { createTelemetrySessionClient, type TelemetryTransport } from "./session";
import { makeTelemetryFrame } from "./test-fixtures";

const active: VisualizationActivity = {
  open: true,
  visible: true,
  focused: true,
  reducedMotion: false,
  powerSave: false,
};

describe("visualization activity", () => {
  it.each([
    [{ ...active }, 30],
    [{ ...active, focused: false }, 15],
    [{ ...active, powerSave: true }, 15],
    [{ ...active, reducedMotion: true }, 2],
    [{ ...active, visible: false }, 0],
    [{ ...active, open: false }, 0],
  ] as const)("maps activity to $expected Hz", (state, expected) => {
    expect(activityRate(state)).toBe(expected);
  });

  it("stops notifying an unsubscribed activity listener", () => {
    const controller = createActivityController(active);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.update({ focused: false });
    unsubscribe();
    controller.update({ focused: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(15, expect.objectContaining({ focused: false }));
  });
});

describe("telemetry session", () => {
  it("accepts only monotonic epoch and sequence ordering and acknowledges valid frames", async () => {
    let onFrame: ((frame: ArrayBuffer) => void) | undefined;
    const transport: TelemetryTransport = {
      open: vi.fn((_rate, handler) => { onFrame = handler; }),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    const activity = createActivityController(active);
    const client = createTelemetrySessionClient(transport, activity);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.start();

    onFrame?.(makeTelemetryFrame({ epoch: 5n, sequence: 10n }));
    onFrame?.(makeTelemetryFrame({ epoch: 5n, sequence: 9n }));
    onFrame?.(makeTelemetryFrame({ epoch: 2n, sequence: 1n }));
    onFrame?.(makeTelemetryFrame({ epoch: 5n, sequence: 99n }));

    expect(client.getSnapshot()).toMatchObject({ epoch: 5n, sequence: 99n });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(transport.acknowledge).toHaveBeenNthCalledWith(1, 5n, 10n, 12n);
    expect(transport.acknowledge).toHaveBeenCalledTimes(4);
    activity.update({ focused: false });
    expect(transport.setRate).toHaveBeenCalledWith(15);
  });

  it("cleans up subscriptions and ignores late frames after stop", async () => {
    let onFrame: ((frame: ArrayBuffer) => void) | undefined;
    const transport: TelemetryTransport = {
      open: (_rate, handler) => { onFrame = handler; },
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    const activity = createActivityController(active);
    const errors = vi.fn();
    const client = createTelemetrySessionClient(transport, activity, errors);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    await client.start();
    await client.stop();
    unsubscribe();
    onFrame?.(makeTelemetryFrame({ epoch: 1n, sequence: 1n }));
    activity.update({ powerSave: true });

    expect(client.getSnapshot()).toBeNull();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(transport.acknowledge).not.toHaveBeenCalled();
    expect(transport.setRate).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("applies the latest rate after asynchronous open and closes a late session", async () => {
    let resolveOpen!: () => void;
    const opening = new Promise<void>((resolve) => { resolveOpen = resolve; });
    const transport: TelemetryTransport = {
      open: vi.fn(() => opening),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    const activity = createActivityController(active);
    const client = createTelemetrySessionClient(transport, activity);
    const start = client.start();
    activity.update({ focused: false });
    expect(transport.setRate).not.toHaveBeenCalled();
    resolveOpen();
    await start;
    expect(transport.setRate).toHaveBeenCalledWith(15);

    const lateTransport: TelemetryTransport = {
      open: vi.fn(() => new Promise<void>((resolve) => { resolveOpen = resolve; })),
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    const lateClient = createTelemetrySessionClient(lateTransport, activity);
    const lateStart = lateClient.start();
    const lateStop = lateClient.stop();
    await Promise.resolve();
    resolveOpen();
    await Promise.all([lateStart, lateStop]);
    expect(lateTransport.close).toHaveBeenCalledOnce();
    expect(lateTransport.setRate).not.toHaveBeenCalled();
  });

  it("closes and reports a rejected acknowledgement instead of stalling", async () => {
    let onFrame: ((frame: ArrayBuffer) => void) | undefined;
    const transport: TelemetryTransport = {
      open: (_rate, handler) => { onFrame = handler; },
      setRate: vi.fn(),
      acknowledge: vi.fn(() => false),
      close: vi.fn(),
    };
    const error = vi.fn();
    const client = createTelemetrySessionClient(transport, createActivityController(active), error);
    await client.start();
    onFrame?.(makeTelemetryFrame());
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Telemetry acknowledgement was rejected" }));
    expect(transport.close).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toBeNull();
  });

  it("reports malformed frames without acknowledging them", async () => {
    let onFrame: ((frame: ArrayBuffer) => void) | undefined;
    const transport: TelemetryTransport = {
      open: (_rate, handler) => { onFrame = handler; },
      setRate: vi.fn(),
      acknowledge: vi.fn(() => true),
      close: vi.fn(),
    };
    const error = vi.fn();
    const client = createTelemetrySessionClient(transport, createActivityController(active), error);
    await client.start();
    onFrame?.(new ArrayBuffer(4));
    expect(error).toHaveBeenCalledOnce();
    expect(transport.acknowledge).not.toHaveBeenCalled();
  });
});
