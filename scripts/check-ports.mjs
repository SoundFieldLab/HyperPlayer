/**
 * 端口一致性闸门（CI 与本地都可跑）：`node scripts/check-ports.mjs`
 *
 * 背景：本机另有 WaveForge（3000 / 3001 / 3002 / 30082…）与 ReWaveForge（3001 / 3101）
 * 常驻占用 300x 段。HyperPlayer 自 2026-09-14 起固定使用：
 *   - **3210** Vite dev / preview（渲染服务）
 *   - **3211** Express 本地后端（127.0.0.1）
 * 一旦有人把端口写回 3000–3002，就会出现「后端起不来 / 前端连到别的服务拿到空数据」
 * 这类排查成本极高的故障，故用本闸门在 CI 上直接拦下。
 *
 * 检查两类内容：
 *   A. 禁止项：代码/配置里出现落在 WaveForge 段的端口字面量（3000/3001/3002）
 *   B. 必备项：五处关键锚点确实是 3210/3211（防止只改了一半）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.portable-extract', 'cache', 'logs', 'data', '.zcode'])
const SCAN_EXT = new Set(['.ts', '.tsx', '.cjs', '.mjs', '.js', '.json', '.html', '.yml', '.yaml', '.vbs'])
/** 历史/否定性说明允许出现旧端口（如「已停用 3002」） */
const ALLOW_LINE = /已停用|历史|不再使用|不要绕|占用坑|避开|avoid/i

const FORBIDDEN = [
  [/:300[0-2]\b/, 'WaveForge 段端口字面量（3000/3001/3002）'],
  [/\bport: 300[0-2]\b/, 'port: 300x 配置'],
  [/--port=300[0-2]\b/, '--port=300x 脚本参数'],
  [/BACKEND_PORTS = \[300/, 'BACKEND_PORTS 指向 WaveForge 段'],
  [/PORT\) \|\| 300[0-2]\b/, '后端默认端口回退到 WaveForge 段'],
]

const REQUIRED = [
  ['vite.config.ts', /port: 3210/, 'Vite dev/preview 端口 = 3210'],
  ['package.json', /--port=3210/, 'dev 脚本端口 = 3210'],
  ['local-server.mjs', /\|\| 3211/, 'Express 默认端口 = 3211'],
  ['local-server.mjs', /'http:\/\/localhost:3210'/, 'CORS 白名单放行 3210 前端源'],
  ['src/services/apiConfig.ts', /:3211\/api/, '前端 API 基址 = 127.0.0.1:3211'],
  ['desktop/main.cjs', /BACKEND_PORTS = \[3211\]/, '主进程后端端口表 = [3211]'],
  ['desktop/main.cjs', /127\.0\.0\.1:3211\/health/, '主进程健康检查指向 3211'],
  ['scripts/dev-electron.mjs', /3211/, 'dev 启动器使用 3211'],
]

const failures = []

// ── A. 禁止项扫描 ──
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || rel.startsWith('src/generated')) continue
      walk(full)
      continue
    }
    if (!SCAN_EXT.has(path.extname(entry.name).toLowerCase())) continue
    let text
    try { text = fs.readFileSync(full, 'utf8') } catch { continue }
    text.split('\n').forEach((line, i) => {
      if (ALLOW_LINE.test(line)) return
      for (const [re, label] of FORBIDDEN) {
        if (re.test(line)) failures.push(`✗ 禁止项 ${rel}:${i + 1} — ${label}\n      ${line.trim().slice(0, 140)}`)
      }
    })
  }
}
walk(ROOT)

// ── B. 必备锚点 ──
for (const [rel, re, label] of REQUIRED) {
  const file = path.join(ROOT, rel)
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { failures.push(`✗ 找不到文件 ${rel}（${label}）`); continue }
  if (!re.test(text)) failures.push(`✗ 必备锚点缺失 ${rel} — ${label}`)
}

if (failures.length > 0) {
  console.error('[check-ports] 端口约定不一致：\n' + failures.map(f => '  ' + f).join('\n'))
  console.error('\n约定：3210 = Vite dev/preview，3211 = Express 后端（见 AGENTS.md「端口」段）。')
  process.exit(1)
}
console.log('[check-ports] ✓ 端口约定一致：3210（Vite dev/preview）+ 3211（Express 后端），未触碰 WaveForge 占用的 3000–3002。')
