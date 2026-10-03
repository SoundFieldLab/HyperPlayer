import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 内置字体不再全局注册（§6.3 按需注入，见 utils/builtinFonts.ts）
import './index.css'
import App from './App'
import { startMemoryWatchdog } from './utils/memoryWatchdog'
import { startPerfTrace } from './utils/perfTrace'
import { installElectronShim } from './electronShim'
import { initPerfMode } from './tv/perfMode'
import ErrorBoundary from './components/ErrorBoundary'

// 非 Electron 环境（纯浏览器）注入 window.electron 最小桩。
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
// 转发限额：模板/循环里抛错（或每帧重复报同一个错）会形成错误风暴，而每条都要付一次
// JSON.stringify + 一次 IPC，足以卡住主线程并冲爆后端日志。故按「同文本 2s 内最多 1 条」
// 去重 + 「每分钟最多 10 条」限流，超出只计数；被抑制的条数会拼在下一条真正转发的消息尾部，
// 不静默丢失。console.error 本体永远照常输出（控制台可见性不受限额影响）。
const ERROR_FORWARD_DEDUPE_MS = 2_000
const ERROR_FORWARD_MAX_PER_WINDOW = 10
const ERROR_FORWARD_WINDOW_MS = 60_000
const origConsoleError = console.error
let errorForwardWindowStart = Date.now()
let errorForwardedInWindow = 0
let errorSuppressedCount = 0
// 去重表只记录「已获准转发」的文本，每窗口最多 10 个键，不会随错误种类无限增长
const errorForwardedAt = new Map<string, number>()
console.error = (...args: unknown[]) => {
  try { origConsoleError(...args) } catch { /* ignore */ }
  try {
    const w = window as unknown as { electron?: { automixLog?: (s: string, m: string) => Promise<unknown> } }
    const text = args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) }
    }).join(' ').slice(0, 400)
    const now = Date.now()
    if (now - errorForwardWindowStart >= ERROR_FORWARD_WINDOW_MS) {
      errorForwardWindowStart = now
      errorForwardedInWindow = 0
      errorForwardedAt.clear()
    }
    const lastForwardedAt = errorForwardedAt.get(text)
    const tooSoon = lastForwardedAt !== undefined && now - lastForwardedAt < ERROR_FORWARD_DEDUPE_MS
    if (tooSoon || errorForwardedInWindow >= ERROR_FORWARD_MAX_PER_WINDOW) {
      errorSuppressedCount += 1
      return
    }
    errorForwardedAt.set(text, now)
    errorForwardedInWindow += 1
    const suppressed = errorSuppressedCount
    errorSuppressedCount = 0
    w.electron?.automixLog?.(
      'renderer-error',
      suppressed > 0 ? `${text} [已抑制 ${suppressed} 条]` : text,
    )?.catch?.(() => undefined)
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

// 内存观察哨：仅当 localStorage 中设置了 hyperplayer:memory-debug=1 时生效，
// 用于定位播放期间内存持续增长的来源（控制台执行 localStorage.setItem('hyperplayer:memory-debug','1') 后重启）。
startMemoryWatchdog()

// 性能探针：仅当 localStorage 中设置了 hyperplayer:perf-trace=1 时生效，
// 每 10 秒输出一行聚合日志（longtask / 帧间隔 / JS 堆），未开启时零开销。
startPerfTrace()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
