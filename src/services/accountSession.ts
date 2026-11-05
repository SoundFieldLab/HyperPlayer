/**
 * 账号会话代际（account session generation）。
 *
 * 要防的故障形态：登录流程是「先置本地登录态 → 再 await 网络请求拿资料 → 无条件回写」。
 * 用户在等待期间点了退出（或换了个号），旧请求返回后仍把昵称 / 用户 ID / VIP /
 * 登录有效期写回 localStorage 并派发认证变化事件 —— 界面于是「已退出却又出现上个账号」。
 *
 * 做法：每个平台一条会话代际。开启新一轮会话（登录 / 换号）或退出时把代际 +1，
 * 此前发出的请求在提交时发现自己已过期就整个丢弃。与 `musicApi.ts` 里
 * `songUrlCacheGeneration` 是同一套请求代际写法（那边管歌链缓存，这边管账号资料）。
 *
 * 边界：本模块只回答「这一轮请求还有没有资格提交」，不碰 UI state、不碰 localStorage、
 * 不发请求。调用方拿到 `commit()` 后再决定写什么 —— 语义集中在一处，写入仍归调用处。
 */

import type { MusicPlatform } from './platforms'

/** 支持会话代际的平台（B 站看歌登录不走音乐平台账号体系，暂不纳入）。 */
export type AccountSessionPlatform = MusicPlatform

export interface AccountSessionToken {
  /** 本轮会话的代际号，仅用于诊断/断言。 */
  readonly generation: number
  /** 期间是否发生过退出或换号；false 表示本轮结果不能再落库。 */
  isCurrent(): boolean
  /**
   * 仅当会话仍然有效时执行提交逻辑，过期则整体丢弃并返回 undefined。
   * **所有回写（setState / localStorage / 派发事件）都应走这里**，
   * 否则「判定了却还是写了」的漏洞会重新出现。
   */
  commit<T>(write: () => T): T | undefined
}

const generations = new Map<AccountSessionPlatform, number>()

const generationOf = (platform: AccountSessionPlatform): number => generations.get(platform) ?? 0

/**
 * 开启一轮新的账号会话，并让此前所有在途会话失效。
 *
 * 登录和换号是同一个入口：换号也必须先让旧会话失效，否则旧账号的迟到资料会覆盖新账号。
 */
export function beginAccountSession(platform: AccountSessionPlatform): AccountSessionToken {
  const generation = generationOf(platform) + 1
  generations.set(platform, generation)
  const isCurrent = () => generationOf(platform) === generation
  return {
    generation,
    isCurrent,
    commit: <T,>(write: () => T): T | undefined => (isCurrent() ? write() : undefined),
  }
}

/**
 * 让该平台所有在途会话立即失效（退出登录时调用）。
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
