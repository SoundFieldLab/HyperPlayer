// 网易云会话管理（D34/D35）：Cookie 在 TS 内存持有，持久化经 Rust DPAPI
// 保险库（credential_get/credential_set，防数据目录拷贝盗号档位）。
// 协议包内部 anonymous_token / xeapi_public_key 走 shims/fs.ts 的浏览器存储。

import { bridge } from '../../bridge'
import type { NeteaseCookie } from './cookie'

export type { NeteaseCookie }

export class NeteaseSession {
  private cookie: NeteaseCookie = {}
  private restored = false

  /** 登录/更新后调用：合并 cookie 并异步落盘（DPAPI） */
  async update(cookie: NeteaseCookie): Promise<void> {
    this.cookie = { ...this.cookie, ...cookie }
    await this.persist()
  }

  /** 登出：清空内存与保险库 */
  async clear(): Promise<void> {
    this.cookie = {}
    try {
      await bridge.credentialSet(null)
    } catch {
      // 保险库不可用不影响登出
    }
  }

  /** 供协议请求使用的 cookie 对象（协议包会再补充设备字段） */
  current(): NeteaseCookie {
    return { ...this.cookie }
  }

  /** 是否有登录态（MUSIC_U 存在） */
  get isLoggedIn(): boolean {
    return Boolean(this.cookie.MUSIC_U)
  }

  /** 启动时从 DPAPI 保险库恢复（一次性） */
  async restore(): Promise<void> {
    if (this.restored) return
    this.restored = true
    try {
      const payload = await bridge.credentialGet()
      if (payload) {
        const parsed = JSON.parse(payload) as { cookie?: NeteaseCookie }
        if (parsed.cookie) this.cookie = parsed.cookie
      }
    } catch {
      // 无持久化会话或保险库不可用：匿名状态继续
    }
  }

  private async persist(): Promise<void> {
    try {
      await bridge.credentialSet(JSON.stringify({ cookie: this.cookie }))
    } catch {
      // 保险库写入失败仅影响下次启动恢复，不阻断本次会话
    }
  }
}

export const neteaseSession = new NeteaseSession()
