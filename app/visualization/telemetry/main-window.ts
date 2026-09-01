import { useEffect, useRef, useState } from "react";
import type { TelemetryTransport } from "./session";
import { createActivityController, type VisualizationActivity } from "./activity";
import { createTelemetrySessionClient, type TelemetrySessionClient } from "./session";
import type { TelemetryFrame } from "./schema";

export interface MainWindowTelemetryLease {
  client: TelemetrySessionClient;
  updateActivity(patch: Partial<VisualizationActivity>): void;
  release(): void;
}

interface SharedSession {
  activity: ReturnType<typeof createActivityController>;
  client: TelemetrySessionClient;
  leases: Map<number, VisualizationActivity>;
  nextLeaseId: number;
  closeToken: number;
}

let shared: SharedSession | null = null;

function combinedActivity(leases: Iterable<VisualizationActivity>): VisualizationActivity {
  const values = [...leases];
  return {
    open: values.some((value) => value.open),
    visible: values.some((value) => value.open && value.visible),
    focused: values.some((value) => value.open && value.visible && value.focused),
    reducedMotion: values.length > 0 && values.every((value) => value.reducedMotion),
    powerSave: values.some((value) => value.powerSave),
  };
}

function refreshActivity(session: SharedSession): void {
  session.activity.update(combinedActivity(session.leases.values()));
}

export function acquireMainWindowTelemetry(
  createTransport: () => TelemetryTransport,
  initial: VisualizationActivity,
  onError: (error: unknown) => void = () => undefined,
): MainWindowTelemetryLease {
  if (!shared) {
    const activity = createActivityController();
    shared = {
      activity,
      client: createTelemetrySessionClient(createTransport(), activity, onError),
      leases: new Map(),
      nextLeaseId: 0,
      closeToken: 0,
    };
  }
  const session = shared;
  session.closeToken += 1;
  const leaseId = ++session.nextLeaseId;
  session.leases.set(leaseId, initial);
  refreshActivity(session);
  void session.client.start().catch(onError);
  let released = false;

  return {
    client: session.client,
    updateActivity(patch) {
      if (released) return;
      const current = session.leases.get(leaseId);
      if (!current) return;
      session.leases.set(leaseId, { ...current, ...patch });
      refreshActivity(session);
    },
    release() {
      if (released) return;
      released = true;
      session.leases.delete(leaseId);
      refreshActivity(session);
      const closeToken = ++session.closeToken;
      queueMicrotask(() => {
        if (session.closeToken !== closeToken || session.leases.size > 0) return;
        if (shared === session) shared = null;
        void session.client.stop().catch(onError);
      });
    },
  };
}

export function useMainWindowTelemetry(
  createTransport: () => TelemetryTransport,
  open: boolean,
  reducedMotion: boolean | undefined,
): TelemetryFrame | null {
  const [frame, setFrame] = useState<TelemetryFrame | null>(null);
  const createTransportRef = useRef(createTransport);
  createTransportRef.current = createTransport;

  useEffect(() => {
    if (!open) {
      setFrame(null);
      return;
    }
    const motion = typeof globalThis.matchMedia === "function"
      ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    const currentReducedMotion = () => reducedMotion === true || motion?.matches === true;
    const lease = acquireMainWindowTelemetry(() => createTransportRef.current(), {
      open: true,
      visible: document.visibilityState !== "hidden",
      focused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
      reducedMotion: currentReducedMotion(),
      // No trusted frontend power-status API is wired yet.
      powerSave: false,
    });
    const updateVisibility = () => lease.updateActivity({ visible: document.visibilityState !== "hidden" });
    const onFocus = () => lease.updateActivity({ focused: true });
    const onBlur = () => lease.updateActivity({ focused: false });
    const updateReducedMotion = (event: MediaQueryListEvent) => lease.updateActivity({
      reducedMotion: reducedMotion === true || event.matches,
    });
    const unsubscribe = lease.client.subscribe(() => setFrame(lease.client.getSnapshot()));
    setFrame(lease.client.getSnapshot());
    document.addEventListener("visibilitychange", updateVisibility);
    globalThis.addEventListener("focus", onFocus);
    globalThis.addEventListener("blur", onBlur);
    motion?.addEventListener("change", updateReducedMotion);

    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      globalThis.removeEventListener("focus", onFocus);
      globalThis.removeEventListener("blur", onBlur);
      motion?.removeEventListener("change", updateReducedMotion);
      unsubscribe();
      lease.release();
    };
  }, [open, reducedMotion]);

  return frame;
}
