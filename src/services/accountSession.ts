/**
 * 账号会话（account session）module。
 *
 * 要防的故障形态：登录流程是「先置本地登录态 → 再 await 网络请求拿资料 → 无条件回写」。
 * 用户在等待期间点了退出（或换了个号），旧请求返回后仍把昵称 / 用户 ID / VIP /
 * 登录有效期写回 localStorage 并派发认证变化事件 —— 界面于是「已退出却又出现上个账号」。
 *
 * 本模块现在同时负责：
 *   - 每平台一条会话代际，让迟到请求失效；
 *   - 两个平台的历史 localStorage 键与清理顺序；
 *   - 登录有效期与 `hyperplayer-auth-changed` 事件；
 *   - 通过 `AccountSessionUi` 把状态回写交给调用方，模块本身不碰 React。
 *
 * 平台差异只留在调用方的网络请求与 UI adapter；持久化与事件语义集中在这里。
 */

import { clearLoginExpiry, recordLogin } from './loginExpiry'
import type { MusicPlatform } from './platforms'

/** 支持会话代际的平台（B 站看歌登录不走音乐平台账号体系，暂不纳入）。 */
export type AccountSessionPlatform = MusicPlatform

export interface AccountSessionSnapshot {
  loggedIn: boolean
  cookie: string
  username: string
  avatar: string
  userId: string
  vip: boolean
}

export type AccountSessionPatch = Partial<AccountSessionSnapshot>

/** UI adapter：模块只描述该写什么，具体 React state 由调用方落地。 */
export interface AccountSessionUi {
  apply(patch: AccountSessionPatch): void
  clear(): void
  /** 登录成功 / 退出后递增认证版本；由调用方决定具体 state。 */
  onAuthChanged?(): void
}

export interface AccountLoginState {
  cookie: string
  userId?: string
}

export interface AccountProfile {
  username: string
  avatar: string
  userId: string
  vip: boolean
}

/** 本模块需要的宿主能力（便于在 node 环境测试，不必真起浏览器）。 */
export interface AccountSessionHost {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  recordLogin(platform: AccountSessionPlatform): void
  clearLoginExpiry(platform: AccountSessionPlatform): void
  notifyAuthChanged(platform: AccountSessionPlatform, userId?: string): void
}

interface PlatformStorageKeys {
  cookieKeys: readonly string[]
  loggedInKey?: string
  userId: string
  username: string
  avatar: string
  vip: string
}

const PLATFORM_STORAGE: Record<AccountSessionPlatform, PlatformStorageKeys> = {
  netease: {
    cookieKeys: ['netease_cookie', 'neteaseCookie'],
    userId: 'netease_user_id',
    username: 'netease_username',
    avatar: 'netease_avatar',
    vip: 'netease_vip',
  },
  qq: {
    cookieKeys: ['qq_cookie', 'qqCookie'],
    loggedInKey: 'qq_logged_in',
    userId: 'qq_user_id',
    username: 'qq_username',
    avatar: 'qq_avatar',
    vip: 'qq_vip',
  },
}

const defaultHost: AccountSessionHost = {
  getItem: (key) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
  setItem: (key, value) => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  },
  removeItem: (key) => {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  },
  recordLogin: (platform) => recordLogin(platform),
  clearLoginExpiry: (platform) => clearLoginExpiry(platform),
  notifyAuthChanged: (platform, userId) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('hyperplayer-auth-changed', {
      detail: { platform, ...(userId !== undefined ? { userId } : {}) },
    }))
  },
}

const clearAccountStorage = (platform: AccountSessionPlatform, host: AccountSessionHost) => {
  const keys = PLATFORM_STORAGE[platform]
  for (const cookieKey of keys.cookieKeys) host.removeItem(cookieKey)
  if (keys.loggedInKey) host.removeItem(keys.loggedInKey)
  host.removeItem(keys.userId)
  host.removeItem(keys.username)
  host.removeItem(keys.avatar)
  host.removeItem(keys.vip)
}

/** 从存储读出当前账号快照；兼容两个平台各自的历史 cookie 键。 */
export function readAccountSession(
  platform: AccountSessionPlatform,
  host: AccountSessionHost = defaultHost,
): AccountSessionSnapshot {
  const keys = PLATFORM_STORAGE[platform]
  const cookie = keys.cookieKeys
    .map((key) => host.getItem(key))
    .find((value): value is string => Boolean(value)) ?? ''
  return {
    loggedIn: Boolean(cookie) || (keys.loggedInKey ? host.getItem(keys.loggedInKey) === 'true' : false),
    cookie,
    username: host.getItem(keys.username) ?? '',
    avatar: host.getItem(keys.avatar) ?? '',
    userId: host.getItem(keys.userId) ?? '',
    vip: host.getItem(keys.vip) === 'true',
  }
}

const generations = new Map<AccountSessionPlatform, number>()

const generationOf = (platform: AccountSessionPlatform): number => generations.get(platform) ?? 0

export interface AccountSessionToken {
  readonly platform: AccountSessionPlatform
  /** 本轮会话的代际号，仅用于诊断/断言。 */
  readonly generation: number
  /** 期间是否发生过退出或换号；false 表示本轮结果不能再落库。 */
  isCurrent(): boolean
  /** 仅当会话仍然有效时执行提交逻辑，过期则整体丢弃并返回 undefined。 */
  commit<T>(write: () => T): T | undefined
  /** 提交 cookie / 登录态；成功后调用方才能继续等待资料。 */
  commitLogin(login: AccountLoginState, ui: AccountSessionUi): boolean
  /** 提交资料并记录有效期、派发认证变化；profile 为 null 时不覆盖已有资料。 */
  commitProfile(profile: AccountProfile | null, ui: AccountSessionUi): boolean
  /** 登录失败清理；过期会话不得覆盖新会话。 */
  fail(ui: AccountSessionUi): boolean
}

/**
 * 开启一轮新的账号会话，并让此前所有在途会话失效。
 *
 * 登录和换号是同一个入口：换号也必须先让旧会话失效，否则旧账号的迟到资料会覆盖新账号。
 */
export function beginAccountSession(
  platform: AccountSessionPlatform,
  host: AccountSessionHost = defaultHost,
): AccountSessionToken {
  const generation = generationOf(platform) + 1
  generations.set(platform, generation)
  const isCurrent = () => generationOf(platform) === generation
  const commit = <T,>(write: () => T): T | undefined => (isCurrent() ? write() : undefined)

  return {
    platform,
    generation,
    isCurrent,
    commit,
    commitLogin: (login, ui) => commit(() => {
      const keys = PLATFORM_STORAGE[platform]
      for (const cookieKey of keys.cookieKeys) host.setItem(cookieKey, login.cookie)
      if (keys.loggedInKey) host.setItem(keys.loggedInKey, 'true')
      if (login.userId) host.setItem(keys.userId, login.userId)
      ui.apply({
        loggedIn: true,
        cookie: login.cookie,
        ...(login.userId ? { userId: login.userId } : {}),
      })
      return true
    }) === true,
    commitProfile: (profile, ui) => commit(() => {
      const keys = PLATFORM_STORAGE[platform]
      if (profile) {
        host.setItem(keys.username, profile.username)
        host.setItem(keys.avatar, profile.avatar)
        if (profile.userId) host.setItem(keys.userId, profile.userId)
        host.setItem(keys.vip, String(profile.vip))
        ui.apply(profile)
      }
      const userId = profile?.userId ?? readAccountSession(platform, host).userId
      host.recordLogin(platform)
      host.notifyAuthChanged(platform, userId)
      ui.onAuthChanged?.()
      return true
    }) === true,
    fail: (ui) => commit(() => {
      clearAccountStorage(platform, host)
      ui.clear()
      return true
    }) === true,
  }
}

/**
 * 让该平台所有在途会话立即失效（退出登录时调用），并清空账号持久化与 UI。
 * 返回新的代际号，便于调用方在需要时断言。
 */
export function endAccountSession(
  platform: AccountSessionPlatform,
  ui: AccountSessionUi,
  host: AccountSessionHost = defaultHost,
): number {
  const next = invalidateAccountSession(platform)
  clearAccountStorage(platform, host)
  host.clearLoginExpiry(platform)
  ui.clear()
  host.notifyAuthChanged(platform)
  ui.onAuthChanged?.()
  return next
}

/**
 * 让该平台所有在途会话立即失效（不清理存储；供底层/测试使用）。
 * 返回新的代际号，便于调用方在需要时断言。
 */
export function invalidateAccountSession(platform: AccountSessionPlatform): number {
  const next = generationOf(platform) + 1
  generations.set(platform, next)
  return next
}

/** 当前代际（诊断 / 测试用）。 */
export function currentAccountSession(platform: AccountSessionPlatform): number {
  return generationOf(platform)
}

/** 仅供测试：清空全部代际状态。 */
export function __resetAccountSessions(): void {
  generations.clear()
}
