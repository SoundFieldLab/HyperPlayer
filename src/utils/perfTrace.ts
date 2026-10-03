/**
 * 运行时性能探针（仅调试用，默认零开销）
 *
 * 在开发者工具控制台执行 localStorage.setItem('hyperplayer:perf-trace', '1') 并重启应用后生效：
 * 观察 longtask、采样相邻帧间隔、读取 JS 堆，每 10 秒输出一行聚合日志，为渲染层优化提供
 * 客观数字（长任务、掉帧、堆增长）。只观测、不处置。
 * 未开启时 startPerfTrace() 立即返回空函数——不注册 PerformanceObserver、不自建 rAF、不建定时器。
 */

// 输出窗口时长：过密输出本身就是噪音，过疏看不出抖动
const REPORT_INTERVAL_MS = 10_000
// 掉帧判定下限：相邻间隔超过 50ms 才算「卡了一下」
const DROPPED_FRAME_MIN_MS = 50
// 基线倍数：间隔要超过正常帧周期的 2 倍（即至少多丢 1 帧）才计入掉帧
const DROPPED_FRAME_BASELINE_RATIO = 2
// 小于 1ms 的相邻间隔是 rAF 调度抖动而非刷新节奏，不参与基线
const BASELINE_MIN_SAMPLE_MS = 1

interface TraceStats {
  longTaskCount: number
  longTaskTotalMs: number
  longTaskMaxMs: number
  frameSamples: number
  frameMaxMs: number
  frameBaselineMs: number
  droppedFrames: number
}

export function startPerfTrace(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  try {
    if (localStorage.getItem('hyperplayer:perf-trace') !== '1') return () => undefined
  } catch {
    return () => undefined
  }

  const stats: TraceStats = {
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    frameSamples: 0,
    frameMaxMs: 0,
    frameBaselineMs: 0,
    droppedFrames: 0,
  }
  let reportTimer: number | null = null
  let frameRequest: number | null = null
  // null 表示「下一帧只做锚点、不出间隔」：暂停/恢复后的第一帧不能把停摆时长算成一次超长间隔
  let lastFrameAt: number | null = null

  // longtask 并非所有 Chromium 配置（及非 Chromium 环境）都支持：先查 supportedEntryTypes，
  // 构造与 observe 再包 try/catch，失败即降级为「不采 longtask」，其余采样照常
  let observer: PerformanceObserver | null = null
  const supportedEntryTypes = typeof PerformanceObserver !== 'undefined'
    ? (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes
    : undefined
  if (Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes('longtask')) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          stats.longTaskCount += 1
          stats.longTaskTotalMs += entry.duration
          if (entry.duration > stats.longTaskMaxMs) stats.longTaskMaxMs = entry.duration
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      observer = null
    }
  }

  const resetStats = () => {
    stats.longTaskCount = 0
    stats.longTaskTotalMs = 0
    stats.longTaskMaxMs = 0
    stats.frameSamples = 0
    stats.frameMaxMs = 0
    stats.frameBaselineMs = 0
    stats.droppedFrames = 0
  }

  const recordFrame = (deltaMs: number) => {
    stats.frameSamples += 1
    if (deltaMs > stats.frameMaxMs) stats.frameMaxMs = deltaMs
    // 基线取窗口内最小的正常相邻间隔（≈显示器帧周期）：60Hz≈16.7ms、120Hz≈8.3ms、144Hz≈6.9ms，
    // 写死 16.7ms 会把高刷屏的正常节奏误判为掉帧
    if (deltaMs >= BASELINE_MIN_SAMPLE_MS && (stats.frameBaselineMs === 0 || deltaMs < stats.frameBaselineMs)) {
      stats.frameBaselineMs = deltaMs
    }
    const baseline = stats.frameBaselineMs > 0 ? stats.frameBaselineMs : deltaMs
    if (deltaMs >= DROPPED_FRAME_MIN_MS && deltaMs > baseline * DROPPED_FRAME_BASELINE_RATIO) {
      stats.droppedFrames += 1
    }
  }

  const tick = (now: number) => {
    frameRequest = window.requestAnimationFrame(tick)
    if (lastFrameAt !== null) recordFrame(now - lastFrameAt)
    lastFrameAt = now
  }

  const emitReport = () => {
    const windowSeconds = Math.round(REPORT_INTERVAL_MS / 1000)
    const longTaskPart = observer
      ? `longtask ${stats.longTaskCount} 次/共 ${Math.round(stats.longTaskTotalMs)}ms 最大 ${Math.round(stats.longTaskMaxMs)}ms`
      : 'longtask 不可用'
    const framePart = stats.frameSamples > 0
      ? `帧间隔 最大 ${Math.round(stats.frameMaxMs)}ms (基线 ${stats.frameBaselineMs.toFixed(1)}ms) 掉帧 ${stats.droppedFrames} 次`
      : '帧间隔 无采样'
    const segments = [`[perf-trace] ${windowSeconds}s 内 ${longTaskPart}`, framePart]
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    if (memory) segments.push(`JS堆 ${(memory.usedJSHeapSize / 1048576).toFixed(0)}MB`)
    console.log(segments.join(' | '))
  }

  const scheduleReport = () => {
    reportTimer = window.setTimeout(() => {
      reportTimer = null
      emitReport()
      // 每窗口重新算基线：刷新率/负载可能已变，旧窗口的基线会污染新窗口的掉帧判定
      resetStats()
      scheduleReport()
    }, REPORT_INTERVAL_MS)
  }

  const startFrameLoop = () => {
    if (frameRequest === null) frameRequest = window.requestAnimationFrame(tick)
  }

  const stopFrameLoop = () => {
    if (frameRequest !== null) {
      window.cancelAnimationFrame(frameRequest)
      frameRequest = null
    }
    lastFrameAt = null
  }

  // 页面隐藏期间 rAF 停摆、也采不到 longtask，残留的半窗数据没有参考价值：丢弃
  const pause = () => {
    if (reportTimer !== null) {
      window.clearTimeout(reportTimer)
      reportTimer = null
    }
    stopFrameLoop()
    resetStats()
  }

  const resume = () => {
    resetStats()
    startFrameLoop()
    if (reportTimer === null) scheduleReport()
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') pause()
    else resume()
  }

  const stop = () => {
    observer?.disconnect()
    observer = null
    if (reportTimer !== null) {
      window.clearTimeout(reportTimer)
      reportTimer = null
    }
    stopFrameLoop()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }

  console.log(`[perf-trace] 已启用，每 ${REPORT_INTERVAL_MS / 1000} 秒输出一行聚合日志`)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  // 启动即隐藏（后台窗口）时先不采样，等恢复可见的 visibilitychange 再开始
  if (document.visibilityState !== 'hidden') resume()

  return stop
}
