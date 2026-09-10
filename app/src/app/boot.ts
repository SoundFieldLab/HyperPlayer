import type { Services } from './wiring';
import { useAppStore } from '../stores/store';
import type { NavDomain, NavEntry } from '../stores/slices/nav';

export type BootStatus = 'booting' | 'ready' | 'error' | 'timeout';

export interface BootResult {
  services: Services;
  timedOut: boolean;
}

export interface BootOptions {
  initialize?: () => Promise<Services>;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  onLateServices?: (services: Services) => void;
}

/** Runs the service graph and the user-visible startup lifecycle as one operation. */
export async function bootApplication(options: BootOptions = {}): Promise<BootResult> {
  const initialize = options.initialize ?? (async () => {
    const { initServices } = await import('./wiring');
    return initServices();
  });
  // 首启含 stronghold argon2 派生 + SQLite 建库 + 封面/历史表初始化，慢盘可能超 8s；
  // 超时只是放弃等待（服务后续仍会就绪并接管），给足余量避免误报。
  const timeoutMs = options.timeoutMs ?? 15_000;
  options.onProgress?.('正在准备 HyperPlayer…');
  let acquiredServices: Services | null = null;
  let lateServicesReported = false;
  const reportLateServices = (services: Services): void => {
    if (lateServicesReported) return;
    lateServicesReported = true;
    options.onLateServices?.(services);
  };

  const boot = async (): Promise<Services> => {
    let services: Services | null = null;
    try {
      services = await initialize();
      acquiredServices = services;
      options.onProgress?.('正在恢复工作区…');
      await services.settings.load();
    const settingsSnapshot = services.settings.snapshot;
    const store = useAppStore.getState();
    store.setSettings(settingsSnapshot);
    store.setVolume(settingsSnapshot.lastNonZeroVolume);
    store.setMuted(settingsSnapshot.muted);
    if (!settingsSnapshot.muted) store.setVolume(settingsSnapshot.volume);
    store.setOutputDevice(settingsSnapshot.outputDevice);
    await services.session.restoreSession();
    if (settingsSnapshot.restoreQueue) {
        const persisted = await services.settings.restoreQueue();
        if (persisted) {
          const current = persisted.currentId
            ? [...persisted.context, ...persisted.upNext].find((item) => item.id === persisted.currentId)
            : null;
          services.queue.restore({
            current: current ?? null,
            upNext: persisted.upNext,
            context: persisted.context,
            mode: persisted.mode,
          });
        }
      }
      await services.library.init();
      await applyStartupNavigation(services);
      services.audio.startClock();
      return services;
    } catch (error) {
      if (services) reportLateServices(services);
      throw error;
    }
  };

  const bootPromise = boot();
  let services: Services;
  try {
    services = await withTimeout(bootPromise, timeoutMs);
  } catch (error) {
    if (error instanceof BootTimeoutError) {
      if (acquiredServices) reportLateServices(acquiredServices);
      else void bootPromise.then(reportLateServices).catch(() => {});
    }
    throw error;
  }
  options.onProgress?.('准备完成');

  return { services, timedOut: false };
}

async function applyStartupNavigation(services: Services): Promise<void> {
  const settings = services.settings.snapshot;
  let domain: NavDomain = 'netease';
  let entry: NavEntry = { routeId: 'netease-home' };

  if (!settings.onboarding.completedAt) {
    entry = { routeId: 'onboarding' };
  } else if (settings.startupPage === 'local-home') {
    domain = 'local';
    entry = { routeId: 'local-home' };
  } else if (settings.startupPage === 'last-page') {
    const persisted = await services.settings.restoreLastPage();
    if (persisted) ({ domain, entry } = persisted);
  }

  useAppStore.getState().navigate(domain, entry);
}

/** Releases long-lived browser/Tauri resources owned by the service graph. */
export async function disposeServices(services: Services): Promise<void> {
  services.cloudPlaylistSync.stopAutoSync();
  services.session.stopQrPolling();
  services.disposeSubscriptions?.();
  services.player.dispose();
  services.stateMachine.dispose();
  services.audio.dispose();
  services.telemetry.dispose();
  await Promise.allSettled([
    services.settings.flushQueuePersist(),
    services.shortcut.dispose(),
    services.tray.dispose(),
  ]);
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BootTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class BootTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`应用初始化超过 ${timeoutMs}ms`);
    this.name = 'BootTimeoutError';
  }
}
