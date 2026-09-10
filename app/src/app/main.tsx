import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles/tokens.css';
import '../shared/styles/splash.css';
import { bootApplication, BootTimeoutError, disposeServices } from './boot';
import type { Services } from './wiring';
import { ServicesProvider } from './providers/ServicesProvider';
import { ErrorBoundary } from './providers/ErrorBoundary';
import { SplashScreen } from './providers/SplashScreen';
import { AppShell, LimitedShell } from '../shell/AppShell';
import { ThemeSynchronizer } from './ThemeSynchronizer';
import { errorMessage } from '../shared/errors';

export function RootApp() {
  const generation = useRef(0);
  const [services, setServices] = useState<Services | null>(null);
  const [status, setStatus] = useState<'booting' | 'ready' | 'error' | 'timeout'>('booting');
  const [message, setMessage] = useState('正在准备 HyperPlayer…');
  const [continueLimited, setContinueLimited] = useState(false);
  const [splashExited, setSplashExited] = useState(false);

  const start = useCallback(() => {
    const currentGeneration = ++generation.current;
    setStatus('booting');
    setMessage('正在准备 HyperPlayer…');
    setContinueLimited(false);
    setSplashExited(false);
    void bootApplication({
      onProgress: (nextMessage) => {
        if (currentGeneration === generation.current) setMessage(nextMessage);
      },
      onLateServices: (lateServices) => { void disposeServices(lateServices); },
    }).then(({ services: nextServices }) => {
      if (currentGeneration !== generation.current) {
        void disposeServices(nextServices);
        return;
      }
      setServices(nextServices);
      setStatus('ready');
    }).catch((error: unknown) => {
      if (currentGeneration !== generation.current) return;
      // 必须保留原始错误可见性：否则 UI 只剩兜底文案，构建版无 DevTools 难以排查。
      console.error('boot: 启动失败', error);
      setStatus(error instanceof BootTimeoutError ? 'timeout' : 'error');
      setMessage(errorMessage(error));
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(start, 0);
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [start]);

  useEffect(() => () => {
    if (services) void disposeServices(services);
  }, [services]);

  const proceedLimited = useCallback(() => {
    setContinueLimited(true);
    setStatus('ready');
  }, []);

  const finishSplashExit = useCallback(() => {
    setSplashExited(true);
  }, []);

  // 兜底：motion 退场动画依赖 rAF；窗口被遮挡/最小化时 WebView2 会节流 rAF，
  // onAnimationComplete 可能永不触发 → 永远停在启动页。就绪后定时强制放行。
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = window.setTimeout(() => setSplashExited(true), 700);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (!splashExited) {
    return (
      <SplashScreen
        status={status}
        message={message}
        onRetry={start}
        onContinue={proceedLimited}
        onExitComplete={finishSplashExit}
      />
    );
  }
  if (!services && continueLimited) return <LimitedShell />;
  if (!services) return null;

  return (
    <ServicesProvider services={services}>
      <ThemeSynchronizer />
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
    </ServicesProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <RootApp />
    </ErrorBoundary>
  </StrictMode>,
);
