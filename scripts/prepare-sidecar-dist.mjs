/**
 * 物化 sidecar 打包目录（D36）：把 server 脚本 + vendored 协议包 + 其真实
 * node_modules 依赖复制到 src-tauri/sidecar-dist/，供 tauri.conf.json 的
 * resources（"sidecar-dist/**"）整体带入安装包。
 *
 * 背景：pnpm workspace 下 vendor 包的 node_modules 是指向根 .pnpm 的符号链接，
 * Tauri 的 resources glob 解析不到链接目标；且逐包 glob 在 Windows 上对新复制
 * 目录偶发 stat 缓存失败。统一先物化到单一目录最稳。
 *
 * 用法：node scripts/prepare-sidecar-dist.mjs（pnpm build / build:debug 前置）。
 */

import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const vendor = join(root, 'vendor', 'netease-cloudmusic-api')
const dist = join(root, 'src-tauri', 'sidecar-dist')
const distVendor = join(dist, 'vendor')

rmSync(dist, { recursive: true, force: true })
mkdirSync(distVendor, { recursive: true })

// 1) sidecar 脚本
cpSync(join(root, 'server', 'netease-sidecar.mjs'), join(dist, 'netease-sidecar.mjs'))

// 2) vendored 包运行面（main/server/app/generateConfig/util/module/data/plugins + package.json）
for (const item of ['main.js', 'server.js', 'app.js', 'generateConfig.js', 'interface.d.ts', 'package.json', 'util', 'module', 'data', 'plugins']) {
  const src = join(vendor, item)
  if (existsSync(src)) cpSync(src, join(distVendor, item), { recursive: true })
}

// 3) 运行时依赖：vendor 包内 node_modules 为 npm 真实文件（含全部传递依赖，
// 见 D36 记录），整体复制（--omit=dev 已剔除 devDependencies）。
const nm = join(vendor, 'node_modules')
if (existsSync(nm)) {
  cpSync(nm, join(distVendor, 'node_modules'), { recursive: true, dereference: true })
}

const files = readdirSync(dist, { recursive: true }).length
console.log(`sidecar-dist ready: ${files} entries @ ${dist}`)
