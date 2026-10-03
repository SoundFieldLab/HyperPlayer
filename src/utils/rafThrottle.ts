/**
 * 把高频回调合并到「下一帧只跑一次」。
 *
 * 为什么需要：拖拽缩放窗口时 Chromium 会在极短时间内连发多次 resize（一帧内就可能多次），
 * 而这些回调基本都要读布局（getBoundingClientRect / clientWidth / innerHeight）再 setState，
 * 同步执行等于在同一帧里反复「强制同步布局 → 重渲染」，缩放过程直接掉帧。
 * 合并到 requestAnimationFrame 后，一帧最多测量一次、渲染一次，与帧节拍对齐。
 *
 * 语义契约（调用方依赖）：
 * - 不丢首帧：首次调用当帧即注册 rAF，回调在下一帧以最新参数执行一次；
 * - 同一帧内重复调用不会追加注册，只更新参数——即「以最后一次调用的参数执行一次」；
 * - cancel() 撤销尚未执行的那一帧回调，此后本实例不会再执行任何回调；
 *   cancel() 不是「销毁」，再次调用仍会重新调度（effect 重复挂载时可直接复用实例）。
 *   组件卸载清理时**必须**调用，否则回调可能在卸载后 setState。
 */
export interface RafThrottled<F extends (...args: never[]) => void> {
  (...args: Parameters<F>): void
  /** 取消尚未执行的那一帧回调（清理时必须调用） */
  cancel: () => void
}

export function rafThrottle<F extends (...args: never[]) => void>(fn: F): RafThrottled<F> {
  const target = fn as (...args: Parameters<F>) => void
  let frame: number | null = null
  let latestArgs: Parameters<F> | null = null

  const run = () => {
    // 先清句柄与参数再执行：回调内部若再次调用本实例，不会被误判成「同帧重复调用」而丢失
    frame = null
    const args = latestArgs
    latestArgs = null
    if (args === null) return
    target(...args)
  }

  const throttled = ((...args: Parameters<F>) => {
    latestArgs = args
    if (frame !== null) return
    // 没有 rAF 的环境（非 DOM 运行时不提供）退化为同步执行，语义保持一致
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      run()
      return
    }
    frame = window.requestAnimationFrame(run)
  }) as RafThrottled<F>

  throttled.cancel = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame)
      frame = null
    }
    latestArgs = null
  }

  return throttled
}
