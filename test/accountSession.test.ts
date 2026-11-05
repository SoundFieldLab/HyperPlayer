/**
 * 账号会话代际回归测试：覆盖本轮报告里的「退出后迟到资料又回填」形态。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  beginAccountSession,
  invalidateAccountSession,
  currentAccountSession,
  __resetAccountSessions,
} from '../src/services/accountSession'

describe('accountSession', () => {
  beforeEach(() => { __resetAccountSessions() })

  it('会话未被打断时正常提交', () => {
    const session = beginAccountSession('netease')
    expect(session.isCurrent()).toBe(true)
    expect(session.commit(() => 'written')).toBe('written')
  })

  it('退出后旧会话的迟到提交被整段丢弃', () => {
    const session = beginAccountSession('netease')
    invalidateAccountSession('netease')
    expect(session.isCurrent()).toBe(false)
    let writes = 0
    // 与 App 里一致：整段回写都放在 commit 内，过期后连一次都不应发生
    const result = session.commit(() => { writes += 1; return 'late' })
    expect(result).toBeUndefined()
    expect(writes).toBe(0)
  })

  it('同一平台重新登录会让上一轮失效（换号不能覆盖新号）', () => {
    const first = beginAccountSession('netease')
    const second = beginAccountSession('netease')
    expect(first.isCurrent()).toBe(false)
    expect(second.isCurrent()).toBe(true)
    expect(first.commit(() => 'old')).toBeUndefined()
    expect(second.commit(() => 'new')).toBe('new')
  })

  it('两个平台的会话互不影响', () => {
    const netease = beginAccountSession('netease')
    const qq = beginAccountSession('qq')
    invalidateAccountSession('qq')
    expect(netease.isCurrent()).toBe(true)
    expect(qq.isCurrent()).toBe(false)
  })

  it('退出后再登录，新一轮会话可以正常提交', () => {
    const stale = beginAccountSession('qq')
    invalidateAccountSession('qq')
    const fresh = beginAccountSession('qq')
    expect(stale.isCurrent()).toBe(false)
    expect(fresh.isCurrent()).toBe(true)
  })

  it('每次开启/失效都推进代际号', () => {
    expect(currentAccountSession('netease')).toBe(0)
    beginAccountSession('netease')
    expect(currentAccountSession('netease')).toBe(1)
    invalidateAccountSession('netease')
    expect(currentAccountSession('netease')).toBe(2)
    beginAccountSession('netease')
    expect(currentAccountSession('netease')).toBe(3)
  })
})

/**
 * 接线回归：光有模块不算修好——App 的真实登录/退出回调必须真的走这套语义。
 * 这里按 test/modeIntegrationWiring.test.ts 的同一做法做源码级断言，
 * 因为 App.tsx 是巨型组件、无法在 node 环境里实例化。
 */
describe('App 登录/退出接线', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  it('两个平台的登录回调都开启新会话并用 commit 包住资料回写', () => {
    expect(app).toContain("beginAccountSession('netease')")
    expect(app).toContain("beginAccountSession('qq')")
    // 资料回写必须在 commit 内（过期即整段丢弃），不能被裸写绕过
    expect(app).toContain('const expired = session.commit(')
  })

  it('两个平台的退出回调都先作废在途会话', () => {
    expect(app).toContain("invalidateAccountSession('netease')")
    expect(app).toContain("invalidateAccountSession('qq')")
  })

  it('QQ 登录失败清理也受会话约束（不覆盖新会话的登录态）', () => {
    const catchStart = app.indexOf("console.error('❌ QQ音乐登录失败:', error)")
    expect(catchStart).toBeGreaterThan(0)
    const commitAfter = app.indexOf('session.commit(', catchStart)
    expect(commitAfter).toBeGreaterThan(catchStart)
    expect(app.slice(catchStart, catchStart + 900)).toContain('if (showToastMessage && !stale)')
  })

  it('退出回调里作废会话的动作先于清空本地资料', () => {
    const logoutStart = app.indexOf('const handleNeteaseLogout')
    const invalidate = app.indexOf("invalidateAccountSession('netease')", logoutStart)
    const clearCookie = app.indexOf("localStorage.removeItem('netease_cookie')", logoutStart)
    expect(invalidate).toBeGreaterThan(logoutStart)
    expect(clearCookie).toBeGreaterThan(invalidate)
  })
})
