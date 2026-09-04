/**
 * dev 编排器（D36）：并行启动网易云协议 sidecar 与 `tauri dev`。
 *
 * - sidecar = node server/netease-sidecar.mjs（stdio 直通，日志即控制台）。
 * - tauri dev 经 shell 调 pnpm（Windows 下 .cmd 需要 shell）。
 * - 任一子进程退出则整组退出；宿主 Ctrl+C 时清理两个子进程。
 */

import { spawn } from 'node:child_process'

const sidecar = spawn(process.execPath, ['server/netease-sidecar.mjs'], {
  stdio: 'inherit',
  env: process.env,
})

const tauri = spawn('pnpm', ['tauri', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
})

let shuttingDown = false
function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of [sidecar, tauri]) {
    try { child.kill() } catch { /* 已退出 */ }
  }
  process.exit(exitCode)
}

sidecar.on('exit', (code) => shutdown(code ?? 0))
tauri.on('exit', (code) => shutdown(code ?? 0))
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
