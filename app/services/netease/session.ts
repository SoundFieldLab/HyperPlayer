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
        if (parsed.cookie) {
          this.cookie = parsed.cookie
          console.info('[netease] 会话恢复:', this.cookie.MUSIC_U ? '已恢复登录态' : '保险库无登录态')
        } else {
          console.info('[netease] 会话恢复: 保险库 payload 无 cookie 字段')
        }
      } else {
        console.info('[netease] 会话恢复: 保险库为空（首次使用或已登出）')
      }
    } catch (error) {
      // 保险库不可用：匿名状态继续，但必须可见——否则「上次登录成功本次却要重扫」无迹可循
      console.error('[netease] 会话恢复失败（保险库读取）:', String(error).slice(0, 160))
    }
  }

  private async persist(): Promise<void> {
    // 写入失败必须可见：扫码登录的 cookie 丢了就是「下次启动要重扫」，静默=事故
    try {
      await bridge.credentialSet(JSON.stringify({ cookie: this.cookie }))
      console.info('[netease] 会话持久化: 已写入保险库（MUSIC_U=', Boolean(this.cookie.MUSIC_U), '）')
    } catch (error) {
      console.error('[netease] 会话持久化失败（DPAPI 写入）:', String(error).slice(0, 160))
      throw error
    }
  }
}

export const neteaseSession = new NeteaseSession()
