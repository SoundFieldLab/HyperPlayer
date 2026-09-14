/**
 * 打包体积闸门（CI 与本地都可跑）：`node scripts/check-packaging.mjs`
 *
 * 背景（2026-09-14）
 * ----------------
 * 减配重构后 app.asar 一度膨胀到 **411 MB**，根因不是打包配置写错，而是
 * `package.json` 的 **`dependencies` 里混进了 19 个纯前端库**（react / react-dom /
 * three / pixi.js / hls.js / lucide-react / framer-motion / leaflet …）。
 *
 * 为什么这会双重打包：
 *   - 这些库**已经被 Vite 打进 `dist/`**（渲染进程真正加载的是 dist，不是 node_modules）；
 *   - 而 electron-builder 默认只打包 **生产依赖**（`dependencies`，不含 `devDependencies`）——
 *     于是它们被原样搬进 asar 第二遍。同一份代码在安装包里存了两份。
 *   实测：19 个前端库 + 它们的 110 个传递依赖 = 264 MB（其中 120 MB 还是 `.map` sourcemap）。
 *   此外 `build/**` 里的 NSIS 安装器位图（32 MB）与 netease API 的 `public/` 文档截图
 *   （13 MB）也搭便车进了运行期包 —— 二者运行时都不读。
 *
 * 判据（本闸门的核心）
 * ------------------
 * 一个 `dependencies` 条目算「合法运行期依赖」，当且仅当
 * **在运行期模块树里能找到对它的 require/import**。
 *
 * 「运行期模块树」= 后端入口（`local-server.mjs`）+ Electron 主进程/preload（`desktop/*.cjs`）
 * + `server/`、`shared/` + 从这些入口静态可达的整个 `node_modules` 闭包。
 *
 * ⚠️ 不能只看入口文件的直接 import：netease API 用 `readdirSync` **动态加载** `module/*.js`，
 * 其中 `login_qr_create.js` 需要 `qrcode`、`song_url_v1.js` 需要 `dotenv` —— 静态遍历
 * 入口看不到它们，但它们**确实是运行期依赖**，删掉会让扫码登录 / 取歌链挂掉。
 * 所以本闸门扫的是「闭包内所有文件」，而不是「入口的直接 import」。
 *
 * 检查三类内容
 * ------------
 *   A. `dependencies` 每一项都必须在运行期模块树里被 require 到（否则说明它是前端库）。
 *   B. `build.files` 必须保留体积排除规则（`build/ui**`、`*.map`、netease `public/`）。
 *   C. （可选）已构建的 app.asar：体积不超预算，且内部不含前端库 / sourcemap / 安装器位图。
 *
 * 用法：
 *   node scripts/check-packaging.mjs            完整检查（含已构建产物的体积与内容）
 *   node scripts/check-packaging.mjs --config-only
 *       只查 A + B（不读 app.asar）。构建链在 **打包前** 用它做「0.1 秒早失败」——
 *       依赖分区/排除规则写错时立刻拦下，不必等两分钟打包完才报错。
 *       打包后由同脚本的完整模式再核对真实产物（见 package.json 的 build:electron:dir）。
 *
 * 退出码 0 = 通过；1 = 有违规项。
 */
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'

const CONFIG_ONLY = process.argv.includes('--config-only')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/** 运行期自有入口文件（后端 + Electron 主进程/preload + 路由模块） */
function runtimeOwnFiles() {
  const out = [path.join(ROOT, 'local-server.mjs')].filter((f) => fs.existsSync(f))
  for (const dir of ['desktop', 'server', 'shared']) {
    const full = path.join(ROOT, dir)
    if (!fs.existsSync(full)) continue
    for (const f of fs.readdirSync(full)) {
      if (/\.(cjs|mjs|js)$/.test(f)) out.push(path.join(full, f))
    }
  }
  return out
}

/** 从自有入口出发，静态解析出可达的顶层包集合 */
function reachablePackages() {
  const NODE_BUILTIN = new Set(Module.builtinModules)
  const VALID_SPEC = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/i
  const SPEC_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"\n]*)['"]/g
  const visited = new Set()
  const top = new Set()
  const stack = [...runtimeOwnFiles()]

  const specsOf = (file) => {
    let src
    try { src = fs.readFileSync(file, 'utf8') } catch { return [] }
    const out = []
    let m
    SPEC_RE.lastIndex = 0
    while ((m = SPEC_RE.exec(src))) out.push(m[1])
    return out
  }

  while (stack.length) {
    const file = stack.pop()
    if (visited.has(file)) continue
    visited.add(file)
    for (const spec of specsOf(file)) {
      if (!spec || spec.startsWith('node:')) continue
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec)
        for (const c of [base, `${base}.mjs`, `${base}.cjs`, `${base}.js`, `${base}.json`,
          path.join(base, 'index.js'), path.join(base, 'index.mjs')]) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) { stack.push(c); break }
        }
        continue
      }
      if (NODE_BUILTIN.has(spec) || spec === 'electron') continue
      if (!VALID_SPEC.test(spec)) continue
      top.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
      let resolved
      try { resolved = Module.createRequire(file).resolve(spec) } catch { continue }
      if (!visited.has(resolved)) stack.push(resolved)
    }
  }
  return top
}

/** 收集运行期模块树里的所有 js 文件（闭包内每个包整目录 + 自有入口） */
function runtimeTreeFiles(packages) {
  const files = runtimeOwnFiles()
  const walk = (dir, depth = 0) => {
    if (depth > 14) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === '.bin') continue
        walk(p, depth + 1)
      } else if (/\.(js|cjs|mjs)$/.test(e.name)) files.push(p)
    }
  }
  for (const pkg of packages) {
    const dir = path.join(ROOT, 'node_modules', pkg)
    if (fs.existsSync(dir)) walk(dir)
  }
  return files
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies || {})

const reachable = reachablePackages()
const treeFiles = runtimeTreeFiles(reachable)
const treeContents = []
for (const f of treeFiles) {
  try { treeContents.push([f, fs.readFileSync(f, 'utf8')]) } catch { /* 忽略不可读项 */ }
}

// ── A. 每个 dependencies 条目都必须在运行期树里被 require 到 ──
for (const dep of deps) {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:require\\(\\s*|from\\s*|import\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`)
  let hit = null
  for (const [f, src] of treeContents) {
    if (re.test(src)) { hit = f; break }
  }
  if (!hit) {
    failures.push(
      `✗ dependencies 里的「${dep}」在运行期模块树中无人 require。\n`
      + '      它极可能只是前端库（已被 Vite 打进 dist/），留在 dependencies 会让 electron-builder\n'
      + '      把它连同传递依赖重复打包进 app.asar。请移到 devDependencies。',
    )
  } else {
    notes.push(`${dep} ← ${path.relative(ROOT, hit).split(path.sep).join('/').slice(0, 64)}`)
  }
}

// ── B. build.files 必须保留体积排除规则 ──
const files = (pkg.build && pkg.build.files) || []
const REQUIRED_EXCLUDES = [
  ['!build/ui/**', 'NSIS 安装器页面位图（运行期不读，仅安装器编译期用）'],
  ['!build/ui-clone/**', 'NSIS 备用安装器位图'],
  ['!**/*.map', 'sourcemap（生产包无用，曾占 120 MB）'],
  ['!node_modules/@neteasecloudmusicapienhanced/api/public/**', 'netease API 自带文档截图（运行期不读，约 13 MB）'],
]
for (const [pattern, why] of REQUIRED_EXCLUDES) {
  if (!files.includes(pattern)) failures.push(`✗ build.files 缺少排除规则「${pattern}」— ${why}`)
}

// ── C. 已构建产物（存在才查） ──
const ASAR = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar')
const ASAR_BUDGET_MB = 130 // 实测约 80 MB；超过即说明有东西被重复打包
if (CONFIG_ONLY) {
  notes.push('--config-only：跳过已构建产物的体积与内容检查（打包后由完整模式核对）')
} else if (fs.existsSync(ASAR)) {
  const sizeMb = fs.statSync(ASAR).size / 1048576
  if (sizeMb > ASAR_BUDGET_MB) {
    failures.push(
      `✗ app.asar 体积 ${sizeMb.toFixed(1)} MB 超出预算 ${ASAR_BUDGET_MB} MB。`
      + '\n      常见原因：前端库被挪回 dependencies、或 build.files 的排除规则被删。',
    )
  } else {
    notes.push(`app.asar ${sizeMb.toFixed(1)} MB（预算 ${ASAR_BUDGET_MB} MB）`)
  }

  try {
    const buf = fs.readFileSync(ASAR)
    const jsonLen = buf.readUInt32LE(12)
    const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
    const entries = []
    const walkHeader = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const p = `${prefix}/${name}`
        if (child.files) walkHeader(child, p)
        else entries.push(p)
      }
    }
    walkHeader(header, '')

    const FE = ['react', 'react-dom', 'three', 'pixi.js', 'hls.js', 'lucide-react', 'framer-motion',
      'leaflet', 'three-stdlib', '@mediapipe', '@react-three', 'country-state-city', 'lamejs',
      'opencc-js', 'react-window', '@tanstack', 'china-area-data', '@svg-maps', 'qrcode.react',
      '@soundtouchjs', '@dimforge', 'stats-gl', 'motion-dom', 'gifuct-js']
    const leaked = FE.filter((p) => entries.some((e) => e.startsWith(`/node_modules/${p}/`)))
    if (leaked.length) failures.push(`✗ app.asar 内混入前端库（应在 devDependencies）：${leaked.join(', ')}`)

    const maps = entries.filter((e) => e.endsWith('.map')).length
    if (maps > 0) failures.push(`✗ app.asar 内含 ${maps} 个 .map sourcemap，排除规则未生效`)

    const bmp = entries.filter((e) => /^\/build\/ui(-clone)?\//.test(e)).length
    if (bmp > 0) failures.push(`✗ app.asar 内含 ${bmp} 个安装器位图（build/ui*），排除规则未生效`)

    const neteasePub = entries.filter((e) => e.includes('cloudmusicapienhanced/api/public/')).length
    if (neteasePub > 0) failures.push(`✗ app.asar 内含 ${neteasePub} 个 netease public/ 文档文件，排除规则未生效`)

    for (const must of ['/package.json', '/local-server.mjs', '/logo.png', '/build/icon.ico',
      '/desktop/main.cjs', '/dist/index.html']) {
      if (!entries.includes(must)) failures.push(`✗ app.asar 缺少运行期必需文件：${must}`)
    }
  } catch (error) {
    failures.push(`✗ 无法解析 app.asar 头部：${error.message}`)
  }
} else {
  notes.push('未发现已构建 app.asar（跳过体积与内容检查；CI 打包作业会覆盖）')
}

// ── 输出 ──
if (failures.length > 0) {
  console.error('[check-packaging] 打包约定被破坏：\n' + failures.map((f) => '  ' + f).join('\n'))
  console.error('\n约定见 AGENTS.md「打包体积约束」：前端库必须留在 devDependencies；'
    + '\n运行期依赖 = 运行期模块树里真正被 require 到的包。')
  process.exit(1)
}
console.log(`[check-packaging] ✓ 打包约定一致：dependencies ${deps.length} 项全部在运行期模块树中被 require`
  + `（可达闭包 ${reachable.size} 个包，扫描 ${treeContents.length} 个文件），build.files 排除规则齐全。`)
for (const n of notes) console.log(`  · ${n}`)
