/**
 * 导入插件运行时能力判定 + 启用门控的回归测试。
 *
 * 复现的故障（见 2026-10-29 代码库调查）：插件代码在 CSP 下无法 new Function，
 * 解析失败被吞掉后 UI 仍提示「已启用」。这里钉住三件事：
 *   1. CSP 类错误被归类为 csp-blocked（可给用户可读原因）；
 *   2. 编译失败时 runtime 带 unavailableReason，而不是伪装成可用的空对象；
 *   3. 正常代码仍然能编译并跑通生命周期。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  canEvaluateDynamicCode,
  classifyRuntimeFailure,
  compilePluginFactory,
} from '../src/plugins/runtimeCapability'
import { createImportedPluginRuntime } from '../src/plugins/registry'

describe('runtimeCapability', () => {
  it('CSP 拒绝动态求值时被归类为 csp-blocked', () => {
    const failure = classifyRuntimeFailure(
      new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script"),
    )
    expect(failure.kind).toBe('csp-blocked')
    expect(failure.message).toMatch(/CSP|安全策略/)
  })

  it('普通语法错误归类为 parse-error 并保留原始信息', () => {
    const failure = classifyRuntimeFailure(new SyntaxError('Unexpected token }'))
    expect(failure.kind).toBe('parse-error')
    expect(failure.message).toBe('Unexpected token }')
  })

  it('空异常也给出可读文案而不是 undefined', () => {
    expect(classifyRuntimeFailure(null).message).toBeTruthy()
  })

  it('能力探测在禁止 new Function 的环境返回 false', () => {
    const original = globalThis.Function
    try {
      // 模拟 CSP：任何动态函数构造都抛错
      ;(globalThis as unknown as { Function: unknown }).Function = function Blocked() {
        throw new EvalError('unsafe-eval is not an allowed source')
      }
      expect(canEvaluateDynamicCode()).toBe(false)
    } finally {
      ;(globalThis as unknown as { Function: unknown }).Function = original
    }
  })

  it('合法代码编译成功并可返回工厂', () => {
    const compiled = compilePluginFactory('function (ctx) { return { onEnable: () => { ctx.log("hi") } } }')
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const lifecycle = compiled.factory()?.({ log: () => {} }) as { onEnable?: () => void }
    expect(typeof lifecycle.onEnable).toBe('function')
  })

  it('语法错误代码编译失败并带原因，不抛异常', () => {
    const compiled = compilePluginFactory('function (ctx) { ' )
    expect(compiled.ok).toBe(false)
    if (compiled.ok) return
    expect(compiled.failure.kind).toBe('parse-error')
  })
})

describe('registry 不再把失败伪装成可用 runtime', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

  it('编译失败时 runtime 带 unavailableReason', () => {
    const runtime = createImportedPluginRuntime('function (ctx) {')
    expect(runtime.unavailableReason).toBeDefined()
    expect(runtime.onEnable).toBeUndefined()
  })

  it('编译成功时不带 unavailableReason', () => {
    const runtime = createImportedPluginRuntime('function () { return {} }')
    expect(runtime.unavailableReason).toBeUndefined()
    expect(typeof runtime.onEnable).toBe('function')
  })
})

describe('启用流程接线', () => {
  const toggle = readFileSync(new URL('../src/plugins/toggle.ts', import.meta.url), 'utf8')
  const overlay = readFileSync(new URL('../src/components/PluginOverlay.tsx', import.meta.url), 'utf8')

  it('开关写入前先检查运行时可用性', () => {
    expect(toggle).toContain('enableIfRuntimeUsable')
    expect(toggle).toContain('runtime?.unavailableReason')
  })

  it('生命周期桥在不可用时不留下 enabled=true', () => {
    expect(overlay).toContain('setPluginEnabled(manifest.id, false)')
    expect(overlay).toContain('runtime.unavailableReason')
  })
})
