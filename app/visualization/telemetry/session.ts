import type { ActivityController, TelemetryRate } from "./activity";
import { decodeTelemetryFrame, type TelemetryFrame } from "./schema";

export interface TelemetryTransport {
  open(rate: TelemetryRate, onFrame: (frame: ArrayBuffer | ArrayBufferView) => void): Promise<void> | void;
  setRate(rate: TelemetryRate): Promise<void> | void;
  acknowledge(epoch: bigint, sequence: bigint, revision: bigint): Promise<boolean> | boolean;
  close(): Promise<void> | void;
}

export interface TelemetrySessionClient {
  getSnapshot(): TelemetryFrame | null;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createTelemetrySessionClient(
  transport: TelemetryTransport,
  activity: ActivityController,
  onError: (error: unknown) => void = () => undefined,
): TelemetrySessionClient {
  let snapshot: TelemetryFrame | null = null;
  let started = false;
  let generation = 0;
  let removeActivityListener: (() => void) | null = null;
  let lifecycle: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((listener) => listener());
  const report = (operation: Promise<unknown> | unknown) => {
    Promise.resolve(operation).catch(onError);
  };
  const closeRejectedSession = (activeGeneration: number) => {
    if (!started || activeGeneration !== generation) return;
    started = false;
    generation += 1;
    removeActivityListener?.();
    removeActivityListener = null;
    snapshot = null;
    notify();
    const error = new Error("Telemetry acknowledgement was rejected");
    onError(error);
    const close = lifecycle.then(() => transport.close());
    lifecycle = close.then(() => undefined, () => undefined);
    report(close);
  };

  const accept = (binary: ArrayBuffer | ArrayBufferView, activeGeneration: number) => {
    if (!started || activeGeneration !== generation) return;
    try {
      const candidate = decodeTelemetryFrame(binary);
      const current = snapshot;
      const newer = !current
        || candidate.epoch > current.epoch
        || (candidate.epoch === current.epoch && candidate.sequence > current.sequence);
      if (newer) {
        snapshot = candidate;
        notify();
      }
      report(Promise.resolve(transport.acknowledge(
        candidate.epoch,
        candidate.sequence,
        candidate.revision,
      )).then((accepted) => {
        if (!accepted) closeRejectedSession(activeGeneration);
      }));
    } catch (error) {
      onError(error);
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (started) return;
      started = true;
      const activeGeneration = ++generation;
      try {
        const openingRate = activity.getRate();
        const open = lifecycle.then(() => transport.open(openingRate, (frame) => accept(frame, activeGeneration)));
        lifecycle = open.then(() => undefined, () => undefined);
        await open;
        if (activeGeneration !== generation) return;
        removeActivityListener = activity.subscribe((rate) => report(transport.setRate(rate)));
        const currentRate = activity.getRate();
        if (currentRate !== openingRate) report(transport.setRate(currentRate));
      } catch (error) {
        if (activeGeneration === generation) {
          started = false;
          removeActivityListener?.();
          removeActivityListener = null;
          throw error;
        }
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      generation += 1;
      removeActivityListener?.();
      removeActivityListener = null;
      snapshot = null;
      notify();
      const close = lifecycle.then(() => transport.close());
      lifecycle = close.then(() => undefined, () => undefined);
      await close;
    },
  };
}
