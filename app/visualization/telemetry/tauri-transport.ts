import type { TelemetryRate } from "./activity";
import type { TelemetryTransport } from "./session";

interface TelemetrySessionWireDto {
  sessionId: string;
  epoch: string;
  maxFrameBytes: number;
  maxFramesPerSecond: number;
}

interface TelemetrySession {
  sessionId: string;
  epoch: bigint;
}

interface TelemetryAckDto {
  accepted: boolean;
}

interface ChannelLike {
  onmessage: (payload: unknown) => void;
}

interface TelemetryCommands {
  subscribe: string;
  acknowledge: string;
  setActivity: string;
  close: string;
}

export interface TauriTelemetryDependencies {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  createChannel(onmessage: (payload: unknown) => void): ChannelLike;
  commands: TelemetryCommands;
}

const MAX_FRAME_BYTES = 1024;
const MAX_FRAMES_PER_SECOND = 30;
const U64_DECIMAL = /^(0|[1-9]\d*)$/;
const U64_MAX = (1n << 64n) - 1n;

function parseU64(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !U64_DECIMAL.test(value)) {
    throw new TypeError(`${name} must be an unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new RangeError(`${name} exceeds u64`);
  return parsed;
}

function decimalU64(value: bigint, name: string): string {
  if (value < 0n || value > U64_MAX) throw new RangeError(`${name} exceeds u64`);
  return value.toString(10);
}

function normalizeBinary(payload: unknown): Uint8Array | null {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Array.isArray(payload) && payload.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(payload);
  }
  return null;
}

function validateSession(session: TelemetrySessionWireDto): TelemetrySession {
  if (!session.sessionId) throw new TypeError("Telemetry subscribe returned an invalid session identity");
  return { sessionId: session.sessionId, epoch: parseU64(session.epoch, "session epoch") };
}

export function createTauriTelemetryTransport(
  dependencies: TauriTelemetryDependencies,
): TelemetryTransport {
  let session: TelemetrySession | null = null;
  let generation = 0;
  let pendingOpen: Promise<void> | null = null;
  let earlyPayload: Uint8Array | null = null;

  const requestFor = (current: TelemetrySession) => ({
    sessionId: current.sessionId,
    epoch: decimalU64(current.epoch, "epoch"),
  });

  const closeSession = async (current: TelemetrySession) => {
    await dependencies.invoke<void>(dependencies.commands.close, {
      request: requestFor(current),
    });
  };

  return {
    async open(rate, onFrame) {
      if (session || pendingOpen) throw new Error("Telemetry transport is already open");
      const openGeneration = ++generation;
      const channel = dependencies.createChannel((payload) => {
        if (openGeneration !== generation) return;
        const binary = normalizeBinary(payload);
        if (!binary) return;
        if (!session) {
          earlyPayload = binary;
          return;
        }
        onFrame(binary);
      });

      const operation = (async () => {
        const wireSession = await dependencies.invoke<TelemetrySessionWireDto>(dependencies.commands.subscribe, {
          request: {
            maxFrameBytes: MAX_FRAME_BYTES,
            maxFramesPerSecond: MAX_FRAMES_PER_SECOND,
          },
          channel,
        });
        const opened = validateSession(wireSession);
        if (openGeneration !== generation) {
          earlyPayload = null;
          await closeSession(opened);
          return;
        }
        session = opened;
        const bufferedPayload = earlyPayload;
        earlyPayload = null;
        if (bufferedPayload) onFrame(bufferedPayload);
        try {
          await dependencies.invoke<void>(dependencies.commands.setActivity, {
            request: { ...requestFor(opened), rateHz: rate },
          });
          if (openGeneration !== generation && session === opened) {
            session = null;
            await closeSession(opened);
          }
        } catch (error) {
          if (session === opened) session = null;
          generation += 1;
          await closeSession(opened).catch(() => undefined);
          throw error;
        }
      })();
      pendingOpen = operation;
      try {
        await operation;
      } finally {
        if (pendingOpen === operation) pendingOpen = null;
      }
    },

    async setRate(rate: TelemetryRate) {
      const current = session;
      if (!current) return;
      await dependencies.invoke<void>(dependencies.commands.setActivity, {
        request: { ...requestFor(current), rateHz: rate },
      });
    },

    async acknowledge(epoch, sequence, revision) {
      const current = session;
      if (!current) return false;
      const result = await dependencies.invoke<TelemetryAckDto>(dependencies.commands.acknowledge, {
        request: {
          sessionId: current.sessionId,
          epoch: decimalU64(epoch, "epoch"),
          sequence: decimalU64(sequence, "sequence"),
          revision: decimalU64(revision, "revision"),
        },
      });
      return result.accepted;
    },

    async close() {
      generation += 1;
      earlyPayload = null;
      if (pendingOpen) {
        await pendingOpen;
        return;
      }
      const current = session;
      session = null;
      if (current) await closeSession(current);
    },
  };
}
