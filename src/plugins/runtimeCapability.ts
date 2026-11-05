/**
 * 导入插件运行时的「能不能跑」判定。
 *
 * 背景（2026-10-29 代码库调查复现）：导入插件的代码用 `new Function` 编译执行，
 * 而主入口 index.html 的 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`——不含
 * `'unsafe-eval'`。于是 `new Function` 抛 EvalError，旧实现 catch 后返回 `{}`，
 * 而开关 UI 照旧写「已启用」并弹成功 toast：用户以为插件在跑，其实一次都没执行。
 *
 * 本模块只做两件确定的事：
 *   1. 把「运行时不可用」变成可读的失败原因（含 CSP 提示），供 UI 如实提示；
 *   2. 在启用插件前先探测能力，避免写下一个永远不可能生效的开启状态。
 *
 * 不做的：不放开主窗口 CSP（那会整体削弱渲染进程防线），也不另建执行环境——
 * 受控插件到底跑在哪里属于产品决定，留待单独一轮。
 */

/** 插件运行时不可用的原因分类，供 UI 决定提示文案与是否回滚开关。 */
export type PluginRuntimeFailure =
  /** 代码语法错误 / 运行期抛错。 */
  | { kind: 'parse-error'; message: string }
  /** CSP 禁止动态求值（new Function / eval 被拦），当前入口下导入插件无法执行。 */
  | { kind: 'csp-blocked'; message: string }
  /** 代码没导出约定的函数形态。 */
  | { kind: 'bad-export'; message: string }

/** CSP 拦截的典型错误特征（各引擎文案不同，按特征而非精确串匹配）。 */
const CSP_PATTERN = /unsafe-eval|Content Security Policy|EvalError|Refused to evaluate/i

/**
 * 探测当前执行环境是否允许动态求值（即 `new Function`）。
 * 用独立的极小函数体，避免把插件代码的报错误当成能力探测结果。
 */
export function canEvaluateDynamicCode(): boolean {
  try {
    // eslint-disable-next-line no-new-func
    const probe = new Function('return 1')
    return probe() === 1
  } catch {
    return false
  }
}

/** 把 catch 到的异常归类成 PluginRuntimeFailure。 */
export function classifyRuntimeFailure(error: unknown): PluginRuntimeFailure {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (CSP_PATTERN.test(message)) {
    return {
      kind: 'csp-blocked',
      message: '当前安全策略（CSP）禁止执行动态代码，导入插件无法在此运行。'
        + '请在插件详情中查看原因；这需要产品层面决定插件的执行位置，不是插件本身写错了。',
    }
  }
  return { kind: 'parse-error', message: message || '插件运行时代码解析失败' }
}

/**
 * 编译插件代码为工厂函数。
 * 返回 `{ ok: true, factory }` 或 `{ ok: false, failure }`——**不再**在失败时
 * 静默返回空 runtime（那正是「显示成功但没生效」的根源）。
 */
export function compilePluginFactory(code: string):
  | { ok: true; factory: () => unknown }
  | { ok: false; failure: PluginRuntimeFailure } {
  const wrapped = `
return function (ctx) {
  "use strict";
  const plugin = (${code});
  return typeof plugin === 'function' ? plugin(ctx) : plugin;
}`
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(wrapped) as () => unknown
    return { ok: true, factory }
  } catch (error) {
    return { ok: false, failure: classifyRuntimeFailure(error) }
  }
}
