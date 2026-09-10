import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// @ts-ignore: allow side-effect CSS import without module declaration
import './assets/fonts/fonts.css'
import './index.css'
import App from './App'
import { startMemoryWatchdog } from './utils/memoryWatchdog'
import { initPlatformUI } from './platform'
import { installElectronShim } from './electronShim'
import { initPerfMode } from './tv/perfMode'
import ErrorBoundary from './components/ErrorBoundary'

// 平台初始化：桌面版为空实现（保留调用点，符号仍在 platform.ts）。
// 并给非 Electron 环境（纯浏览器）注入 window.electron 最小桩。
initPlatformUI()
installElectronShim()

// ── AutoMix 桥自检（诊断用）：确认 window.electron 真实可用性 ──
// 若 preload 未加载，isDesktop() 会误判为 web 并装桩（render 抛"仅桌面版可用"、
// 无 automixLog/analysis）→ automix 永远交叉。此标记写入 localStorage 便于读取。
try {
  const w = window as unknown as { electron?: { system?: { minimize?: unknown }; automixLog?: (s: string, m: string) => Promise<unknown> } }
  const bridgeOk = Boolean(w.electron?.system && typeof w.electron.system.minimize === 'function')
  localStorage.setItem('wf_bridge_test', bridgeOk ? 'ok' : 'missing')
  if (bridgeOk && w.electron?.automixLog) {
    w.electron.automixLog('bridge', 'electron bridge OK').catch(() => undefined)
  }
} catch {
  // 忽略
}

// 渲染端 console.error 转发到后端日志（preload 可用时），捕获真实错误
const origConsoleError = console.error
console.error = (...args: unknown[]) => {
  try { origConsoleError(...args) } catch { /* ignore */ }
  try {
    const w = window as unknown as { electron?: { automixLog?: (s: string, m: string) => Promise<unknown> } }
    const text = args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) }
    }).join(' ').slice(0, 400)
    w.electron?.automixLog?.('renderer-error', text)?.catch?.(() => undefined)
  } catch { /* ignore */ }
}

// 性能模式：按档位（默认普通档）在 <html> 上打 wf-perf-* 类
initPerfMode()

// 诊断：Tailwind v4 透明度依赖 color-mix（需 Chromium 111+），旧内核不支持会导致颜色失效
try {
  console.log(`[COLOR-MIX] ${CSS.supports('color', 'color-mix(in oklab, red 50%, blue)')}`)
} catch {
  console.log('[COLOR-MIX] 不可检测')
}

// 内存观察哨：仅当 localStorage 中设置了 waveforge:memory-debug=1 时生效，
// 用于定位播放期间内存持续增长的来源（控制台执行 localStorage.setItem('waveforge:memory-debug','1') 后重启）。
startMemoryWatchdog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
