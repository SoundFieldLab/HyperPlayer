/**
 * HyperPlayer 网易云协议 sidecar（D36，2026-09-05 用户定调）。
 *
 * 职责：以标准 Node 进程运行 vendored `vendor/netease-cloudmusic-api` 自带的
 * express 服务（serveNcmApi），431+ 端点原生可用——axios/加密/fs/模块自动发现
 * 全部回归 Node 原生，浏览器化 shims/适配层已按 D36 删除、不得复活。
 *
 * 约束：
 * - 只挂协议核心，无任何业务规则（音质阶梯/付费拦截等留在前端 TS 服务层）。
 * - `ENABLE_GENERAL_UNBLOCK` 永不设置（跨平台匹配红线，D34/D36 重申）。
 * - 登录态主权在前端：MUSIC_U 每请求随 body 传入，本进程不持久化任何登录凭据；
 *   匿名身份（anonymous_token / xeapi 公钥）由包的 generateConfig 原生自管。
 * - 开发期端口 14321（HYPERPLAYER_NETEASE_PORT 可覆盖）；打包期由 Rust 壳托管
 *   node.exe 生命周期，M6 定稿。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 双布局锚定（D36）：开发期脚本在 server/、vendored 包在 ../vendor/netease-cloudmusic-api；
// 打包期脚本在 sidecar-dist/（或安装资源 netease-sidecar/）、包在同级 ./vendor。
// createRequire 锚到包目录的 server.js，require 解析走包自身 node_modules。
const vendorServerPath = existsSync(fileURLToPath(new URL('./vendor/server.js', import.meta.url)))
  ? fileURLToPath(new URL('./vendor/server.js', import.meta.url))
  : fileURLToPath(new URL('../vendor/netease-cloudmusic-api/server.js', import.meta.url))
const require = createRequire(vendorServerPath)

const { serveNcmApi } = require('./server.js')
const generateConfig = require('./generateConfig.js')

const PORT = Number(process.env.HYPERPLAYER_NETEASE_PORT || 14321)

// 进程级兜底：协议包内部任何未处理异常只记录不退出（与 WaveForge local-server 同策略）
process.on('unhandledRejection', (reason) => {
  console.error('[netease-sidecar][unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason)
})
process.on('uncaughtException', (error) => {
  console.error('[netease-sidecar][uncaughtException]', error?.stack || error)
})

async function start() {
  // 复刻上游 app.js 启动序：匿名 token 文件存在性 + generateConfig（注册匿名身份）
  const tokenFile = path.resolve(os.tmpdir(), 'anonymous_token')
  if (!fs.existsSync(tokenFile)) {
    fs.writeFileSync(tokenFile, '', 'utf-8')
  }
  await generateConfig()

  try {
    await serveNcmApi({ port: PORT, checkVersion: false })
  } catch (error) {
    // EADDRINUSE 等：明确落盘（壳看门狗会重拉；孤儿接管由壳按 pidfile 处理）
    console.error('[netease-sidecar] serveNcmApi 失败:', error?.message || error)
    process.exit(1)
  }
  // pidfile：壳按它接管孤儿进程（实例崩溃未清理时，新实例启动先杀旧 node）
  try {
    const pidFile = process.env.HYPERPLAYER_SIDECAR_PIDFILE
    if (pidFile) fs.writeFileSync(pidFile, String(process.pid), 'utf-8')
  } catch { /* pidfile 失败不阻塞 */ }
  console.log(`[netease-sidecar] ready @ http://127.0.0.1:${PORT}`)
}

start().catch((error) => {
  console.error('[netease-sidecar] 启动失败:', error?.stack || error)
  process.exit(1)
})
