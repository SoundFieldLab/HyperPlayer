export type TelemetryRate = 0 | 2 | 15 | 30;

export interface VisualizationActivity {
  open: boolean;
  visible: boolean;
  focused: boolean;
  reducedMotion: boolean;
  powerSave: boolean;
}

export const DEFAULT_VISUALIZATION_ACTIVITY: VisualizationActivity = {
  open: false,
  visible: true,
  focused: true,
  reducedMotion: false,
  powerSave: false,
};

export function activityRate(activity: VisualizationActivity): TelemetryRate {
  if (!activity.open || !activity.visible) return 0;
  if (activity.reducedMotion) return 2;
  if (!activity.focused || activity.powerSave) return 15;
  return 30;
}

export interface ActivityController {
  getState(): VisualizationActivity;
  getRate(): TelemetryRate;
  update(patch: Partial<VisualizationActivity>): void;
  subscribe(listener: (rate: TelemetryRate, state: VisualizationActivity) => void): () => void;
}

export function createActivityController(
  initial: Partial<VisualizationActivity> = {},
): ActivityController {
  let state = { ...DEFAULT_VISUALIZATION_ACTIVITY, ...initial };
  let rate = activityRate(state);
  const listeners = new Set<(nextRate: TelemetryRate, nextState: VisualizationActivity) => void>();

  return {
    getState: () => state,
    getRate: () => rate,
    update(patch) {
      const next = { ...state, ...patch };
      const changed = Object.keys(patch).some((key) => (
        next[key as keyof VisualizationActivity] !== state[key as keyof VisualizationActivity]
      ));
      const nextRate = activityRate(next);
      state = next;
      if (!changed) return;
      rate = nextRate;
      listeners.forEach((listener) => listener(rate, state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
