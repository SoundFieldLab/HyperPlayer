/**
 * 账号会话 module：代际 + 持久化 + UI 回写 + 认证事件的回归测试。
 *
 * 旧实现只保护「迟到资料回写」这一件事，localStorage 键、清理顺序、认证事件
 * 仍散在 App 的两个平台回调里。这里把 module 当成深接口测试：
 *   - 登录提交与资料提交都必须穿过代际；
 *   - 过期会话不能写存储、不能通知 UI；
 *   - 退出一次清空存储、有效期、UI 与认证事件。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetAccountSessions,
  beginAccountSession,
  currentAccountSession,
  endAccountSession,
  invalidateAccountSession,
  readAccountSession,
  type AccountSessionHost,
  type AccountSessionUi,
} from '../src/services/accountSession'

function makeHost(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const authEvents: Array<{ platform: string; userId?: string }> = []
  const loggedIn: string[] = []
  const clearedExpiry: string[] = []
  const host: AccountSessionHost = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, value) },
    removeItem: (key) => { store.delete(key) },
    recordLogin: (platform) => { loggedIn.push(platform) },
    clearLoginExpiry: (platform) => { clearedExpiry.push(platform) },
    notifyAuthChanged: (platform, userId) => { authEvents.push({ platform, userId }) },
  }
  return {
    host,
    raw: (key: string) => store.get(key) ?? null,
    authEvents,
    loggedIn,
    clearedExpiry,
  }
}

function makeUi() {
  const patches: Array<Record<string, unknown>> = []
  let cleared = 0
  let authChanged = 0
  const ui: AccountSessionUi = {
    apply: (patch) => { patches.push(patch) },
    clear: () => { cleared += 1 },
    onAuthChanged: () => { authChanged += 1 },
  }
  return {
    ui,
    patches,
    get cleared() { return cleared },
    get authChanged() { return authChanged },
  }
}

beforeEach(() => { __resetAccountSessions() })

describe('账号会话代际', () => {
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

describe('登录提交', () => {
  it('网易云写入两个历史 cookie 键并更新 UI', () => {
    const { host, raw } = makeHost()
    const ui = makeUi()
    const session = beginAccountSession('netease', host)

    expect(session.commitLogin({ cookie: 'n-cookie' }, ui.ui)).toBe(true)
    expect(raw('netease_cookie')).toBe('n-cookie')
    expect(raw('neteaseCookie')).toBe('n-cookie')
    expect(ui.patches).toEqual([{ loggedIn: true, cookie: 'n-cookie' }])
  })

  it('QQ 额外写入 logged_in 与 userId', () => {
    const { host, raw } = makeHost()
    const ui = makeUi()
    const session = beginAccountSession('qq', host)

    expect(session.commitLogin({ cookie: 'q-cookie', userId: '123' }, ui.ui)).toBe(true)
    expect(raw('qq_cookie')).toBe('q-cookie')
    expect(raw('qqCookie')).toBe('q-cookie')
    expect(raw('qq_logged_in')).toBe('true')
    expect(raw('qq_user_id')).toBe('123')
    expect(ui.patches).toEqual([{ loggedIn: true, cookie: 'q-cookie', userId: '123' }])
  })

  it('退出后迟到的登录提交不写 cookie、不更新 UI', () => {
    const { host, raw } = makeHost()
    const ui = makeUi()
    const session = beginAccountSession('netease', host)
    invalidateAccountSession('netease')

    expect(session.commitLogin({ cookie: 'late-cookie' }, ui.ui)).toBe(false)
    expect(raw('netease_cookie')).toBeNull()
    expect(raw('neteaseCookie')).toBeNull()
    expect(ui.patches).toEqual([])
  })
})

describe('资料提交', () => {
  it('写入资料、记录有效期并派发认证变化', () => {
    const { host, raw, loggedIn, authEvents } = makeHost()
    const ui = makeUi()
    const session = beginAccountSession('netease', host)
    session.commitLogin({ cookie: 'n-cookie' }, ui.ui)

    expect(session.commitProfile({
      username: '小明',
      avatar: 'https://example.test/a.png',
      userId: '42',
      vip: true,
    }, ui.ui)).toBe(true)

    expect(raw('netease_username')).toBe('小明')
    expect(raw('netease_avatar')).toBe('https://example.test/a.png')
    expect(raw('netease_user_id')).toBe('42')
    expect(raw('netease_vip')).toBe('true')
    expect(loggedIn).toEqual(['netease'])
    expect(authEvents).toEqual([{ platform: 'netease', userId: '42' }])
    expect(ui.authChanged).toBe(1)
  })

  it('退出后迟到的资料提交不写存储、不派发事件', () => {
    const { host, raw, loggedIn, authEvents } = makeHost()
    const ui = makeUi()
    const session = beginAccountSession('qq', host)
    session.commitLogin({ cookie: 'q-cookie', userId: '123' }, ui.ui)

    invalidateAccountSession('qq')
    expect(session.commitProfile({
      username: '迟到用户',
      avatar: '',
      userId: '123',
      vip: false,
    }, ui.ui)).toBe(false)

    expect(raw('qq_username')).toBeNull()
    expect(loggedIn).toEqual([])
    expect(authEvents).toEqual([])
    expect(ui.authChanged).toBe(0)
  })

  it('资料为 null 时不覆盖已存资料，但仍记录有效期与认证变化', () => {
    const { host, raw, loggedIn, authEvents } = makeHost({
      netease_username: '旧昵称',
      netease_avatar: 'old.png',
      netease_user_id: '7',
      netease_vip: 'true',
    })
    const ui = makeUi()
    const session = beginAccountSession('netease', host)
    session.commitLogin({ cookie: 'n-cookie' }, ui.ui)

    expect(session.commitProfile(null, ui.ui)).toBe(true)
    expect(raw('netease_username')).toBe('旧昵称')
    expect(raw('netease_avatar')).toBe('old.png')
    expect(raw('netease_user_id')).toBe('7')
    expect(raw('netease_vip')).toBe('true')
    expect(loggedIn).toEqual(['netease'])
    expect(authEvents).toEqual([{ platform: 'netease', userId: '7' }])
  })
})

describe('失败清理与退出', () => {
  it('当前会话失败时清空存储与 UI', () => {
    const { host, raw } = makeHost({
      qq_cookie: 'q-cookie',
      qqCookie: 'q-cookie',
      qq_logged_in: 'true',
      qq_user_id: '123',
      qq_username: '用户',
      qq_vip: 'true',
    })
    const ui = makeUi()
    const session = beginAccountSession('qq', host)

    expect(session.fail(ui.ui)).toBe(true)
    expect(raw('qq_cookie')).toBeNull()
    expect(raw('qqCookie')).toBeNull()
    expect(raw('qq_logged_in')).toBeNull()
    expect(raw('qq_user_id')).toBeNull()
    expect(raw('qq_username')).toBeNull()
    expect(raw('qq_vip')).toBeNull()
    expect(ui.cleared).toBe(1)
  })

  it('过期会话的失败清理不覆盖新会话', () => {
    const { host, raw } = makeHost({ qq_cookie: 'new-cookie' })
    const ui = makeUi()
    const session = beginAccountSession('qq', host)
    invalidateAccountSession('qq')

    expect(session.fail(ui.ui)).toBe(false)
    expect(raw('qq_cookie')).toBe('new-cookie')
    expect(ui.cleared).toBe(0)
  })

  it('退出清空存储、有效期、UI 并派发认证变化', () => {
    const { host, raw, clearedExpiry, authEvents } = makeHost({
      netease_cookie: 'n-cookie',
      neteaseCookie: 'n-cookie',
      netease_user_id: '42',
      netease_username: '小明',
      netease_avatar: 'a.png',
      netease_vip: 'true',
    })
    const ui = makeUi()
    beginAccountSession('netease', host)

    endAccountSession('netease', ui.ui, host)

    expect(raw('netease_cookie')).toBeNull()
    expect(raw('netease_user_id')).toBeNull()
    expect(raw('netease_username')).toBeNull()
    expect(raw('netease_avatar')).toBeNull()
    expect(raw('netease_vip')).toBeNull()
    expect(clearedExpiry).toEqual(['netease'])
    expect(authEvents).toEqual([{ platform: 'netease' }])
    expect(ui.cleared).toBe(1)
    expect(ui.authChanged).toBe(1)
  })
})

describe('读取账号快照', () => {
  it('兼容历史 cookie 键并读出资料', () => {
    const { host } = makeHost({
      neteaseCookie: 'legacy-cookie',
      netease_username: '小明',
      netease_avatar: 'a.png',
      netease_user_id: '42',
      netease_vip: 'true',
    })

    expect(readAccountSession('netease', host)).toEqual({
      loggedIn: true,
      cookie: 'legacy-cookie',
      username: '小明',
      avatar: 'a.png',
      userId: '42',
      vip: true,
    })
  })
})
