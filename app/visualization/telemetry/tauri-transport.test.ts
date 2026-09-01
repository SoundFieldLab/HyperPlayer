import { describe, expect, it, vi } from "vitest";
import { createTauriTelemetryTransport, type TauriTelemetryDependencies } from "./tauri-transport";

const commands = {
  subscribe: "telemetry_subscribe",
  acknowledge: "telemetry_ack",
  setActivity: "telemetry_set_activity",
  close: "telemetry_close",
};

function harness(invoke: TauriTelemetryDependencies["invoke"]) {
  let deliver: ((payload: unknown) => void) | undefined;
  const transport = createTauriTelemetryTransport({
    invoke,
    commands,
    createChannel(onmessage) {
      deliver = onmessage;
      return { onmessage };
    },
  });
  return { transport, deliver: (payload: unknown) => deliver?.(payload) };
}

describe("Tauri telemetry transport", () => {
  it("always subscribes at 30 Hz capacity, then applies activity and decimal u64 control DTOs", async () => {
    const invoke = vi.fn(async (command: string) => (
      command === commands.subscribe
        ? { sessionId: "session-1", epoch: "18446744073709551613", maxFrameBytes: 1024, maxFramesPerSecond: 30 }
        : command === commands.acknowledge ? { accepted: true } : undefined
    )) as TauriTelemetryDependencies["invoke"];
    const { transport, deliver } = harness(invoke);
    const onFrame = vi.fn();

    await transport.open(15, onFrame);
    deliver([1, 2, 3]);
    deliver(new Uint16Array([0x0201]));
    deliver(new Uint8Array([4, 5]).buffer);
    deliver([256]);
    await expect(transport.acknowledge(
      18_446_744_073_709_551_613n,
      9_007_199_254_740_993n,
      18_446_744_073_709_551_614n,
    )).resolves.toBe(true);
    await transport.setRate(2);
    await transport.close();

    expect(invoke).toHaveBeenNthCalledWith(1, commands.subscribe, expect.objectContaining({
      request: { maxFrameBytes: 1024, maxFramesPerSecond: 30 },
      channel: expect.any(Object),
    }));
    expect(invoke).toHaveBeenNthCalledWith(2, commands.setActivity, {
      request: { sessionId: "session-1", epoch: "18446744073709551613", rateHz: 15 },
    });
    expect(onFrame.mock.calls[0][0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(onFrame.mock.calls[1][0]).toEqual(new Uint8Array(new Uint16Array([0x0201]).buffer));
    expect(onFrame.mock.calls[2][0]).toEqual(new Uint8Array([4, 5]));
    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenCalledWith(commands.acknowledge, {
      request: {
        sessionId: "session-1",
        epoch: "18446744073709551613",
        sequence: "9007199254740993",
        revision: "18446744073709551614",
      },
    });
    expect(invoke).toHaveBeenCalledWith(commands.close, {
      request: { sessionId: "session-1", epoch: "18446744073709551613" },
    });
  });

  it("keeps 30 Hz subscribe capacity when opening inactive so activity can recover", async () => {
    const invoke = vi.fn(async (command: string) => (
      command === commands.subscribe
        ? { sessionId: "inactive", epoch: "1", maxFrameBytes: 1024, maxFramesPerSecond: 30 }
        : undefined
    )) as TauriTelemetryDependencies["invoke"];
    const { transport } = harness(invoke);
    await transport.open(0, vi.fn());
    await transport.setRate(30);

    expect(invoke).toHaveBeenNthCalledWith(1, commands.subscribe, expect.objectContaining({
      request: { maxFrameBytes: 1024, maxFramesPerSecond: 30 },
    }));
    expect(invoke).toHaveBeenNthCalledWith(2, commands.setActivity, {
      request: { sessionId: "inactive", epoch: "1", rateHz: 0 },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, commands.setActivity, {
      request: { sessionId: "inactive", epoch: "1", rateHz: 30 },
    });
  });

  it("returns a rejected acknowledgement to the session client", async () => {
    const invoke = vi.fn(async (command: string) => (
      command === commands.subscribe
        ? { sessionId: "rejected", epoch: "2", maxFrameBytes: 1024, maxFramesPerSecond: 30 }
        : command === commands.acknowledge ? { accepted: false } : undefined
    )) as TauriTelemetryDependencies["invoke"];
    const { transport } = harness(invoke);
    await transport.open(30, vi.fn());
    await expect(transport.acknowledge(2n, 3n, 4n)).resolves.toBe(false);
  });

  it("buffers a channel frame delivered before subscribe resolves", async () => {
    let resolveSubscribe!: (session: object) => void;
    const subscribe = new Promise<object>((resolve) => { resolveSubscribe = resolve; });
    const invoke = vi.fn(async (command: string) => {
      if (command === commands.subscribe) return subscribe;
      return undefined;
    }) as TauriTelemetryDependencies["invoke"];
    const { transport, deliver } = harness(invoke);
    const onFrame = vi.fn();

    const opening = Promise.resolve(transport.open(30, onFrame));
    deliver(new Uint8Array([1, 2]).buffer);
    resolveSubscribe({ sessionId: "early", epoch: "3", maxFrameBytes: 1024, maxFramesPerSecond: 30 });
    await opening;

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  });

  it("closes a session that resolves after close and ignores its channel", async () => {
    let resolveSubscribe!: (session: object) => void;
    const subscribe = new Promise<object>((resolve) => { resolveSubscribe = resolve; });
    const invoke = vi.fn(async (command: string) => {
      if (command === commands.subscribe) return subscribe;
      return undefined;
    }) as TauriTelemetryDependencies["invoke"];
    const { transport, deliver } = harness(invoke);
    const onFrame = vi.fn();

    const opening = Promise.resolve(transport.open(30, onFrame));
    const closing = Promise.resolve(transport.close());
    resolveSubscribe({ sessionId: "late", epoch: "4", maxFrameBytes: 1024, maxFramesPerSecond: 30 });
    await Promise.all([opening, closing]);
    deliver(new Uint8Array([1]));

    expect(invoke).toHaveBeenCalledWith(commands.close, {
      request: { sessionId: "late", epoch: "4" },
    });
    expect(invoke).not.toHaveBeenCalledWith(commands.setActivity, expect.anything());
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("ignores malformed channel payloads and rejects invalid u64 values", async () => {
    const invoke = vi.fn(async (command: string) => (
      command === commands.subscribe
        ? { sessionId: "session-1", epoch: "1", maxFrameBytes: 1024, maxFramesPerSecond: 30 }
        : { accepted: true }
    )) as TauriTelemetryDependencies["invoke"];
    const { transport, deliver } = harness(invoke);
    const onFrame = vi.fn();
    await transport.open(30, onFrame);

    deliver([256]);
    expect(onFrame).not.toHaveBeenCalled();
    await expect(transport.acknowledge(-1n, 1n, 1n)).rejects.toThrow("u64");
  });
});
