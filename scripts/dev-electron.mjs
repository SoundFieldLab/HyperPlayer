import { spawn, execFile, spawnSync } from 'child_process'
import { build, createServer, preview } from 'vite'
import electron from 'electron'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { dirname, isAbsolute, resolve } from 'path'
import { homedir } from 'os'
import net from 'net'
import dns from 'node:dns'
import { randomBytes } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { isCompatibleLocalApiHealth } from '../server/local-api-health.mjs'

// 当前 Windows 网络的 IPv6 路由可能不可达；外部音乐 CDN/API 优先走 IPv4。
dns.setDefaultResultOrder('ipv4first')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const launcherStartedAt = performance.now()
const startupLogDir = resolve(__dirname, '../logs')
const startupLogFile = resolve(startupLogDir, 'startup-timing.log')
mkdirSync(startupLogDir, { recursive: true })
writeFileSync(startupLogFile, '', 'utf8')
const logStartup = message => {
  const line = '[Startup +' + Math.round(performance.now() - launcherStartedAt) + 'ms] ' + message
  console.log(line)
  appendFileSync(startupLogFile, line + '\n', 'utf8')
}

const projectRoot = resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const { selectHyperPlayerUserData } = require('../desktop/user-data-profile.cjs')
const viteConfigFile = resolve(projectRoot, 'vite.config.ts')
const distDir = resolve(projectRoot, 'dist')

// 直接执行本脚本（快捷方式/IDE/`node scripts/dev-electron.mjs`）时 npm 不会运行
// predev:electron。这里再次确保 ECS production streaming VMP，避免原生 Apple CENC
// 因 development VMP 被 -1021 拒绝后误走 WebView2 兼容兜底。
const vmpCheck = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/ensure-dev-vmp.cjs')], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
})
if (vmpCheck.status !== 0) {
  console.error('[EVS/VMP] 开发运行时校验失败，终止启动以避免静默退回非原生音源')
  process.exit(vmpCheck.status || 1)
}

const localServiceToken = process.env.HYPERPLAYER_LOCAL_TOKEN || randomBytes(32).toString('base64url')
const appDataRoot = process.platform === 'win32'
  ? resolve(process.env.APPDATA || resolve(homedir(), 'AppData/Roaming'))
  : resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'))
const userDataRoot = selectHyperPlayerUserData({
  appDataRoot,
  isPackaged: false,
  overridePath: process.env.HYPERPLAYER_USER_DATA,
})
let pythonCacheRoot = resolve(userDataRoot, 'cache')
try {
  const configured = JSON.parse(readFileSync(resolve(userDataRoot, 'config.json'), 'utf8'))?.cachePath
  if (typeof configured === 'string' && isAbsolute(configured.trim())) pythonCacheRoot = resolve(configured.trim())
} catch { /* Missing or invalid config uses the Electron default cache path. */ }
mkdirSync(pythonCacheRoot, { recursive: true })
const localServiceEnv = {
  ...process.env,
  HYPERPLAYER_LOCAL_TOKEN: localServiceToken,
  HYPERPLAYER_CACHE_PATH: pythonCacheRoot,
  HYPERPLAYER_USERDATA: userDataRoot,
}

function getNewestMtime(targetPath) {
  if (!existsSync(targetPath)) return 0
  const stats = statSync(targetPath)
  if (!stats.isDirectory()) return stats.mtimeMs

  let newest = stats.mtimeMs
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    newest = Math.max(newest, getNewestMtime(resolve(targetPath, entry.name)))
  }
  return newest
}

function isRendererBuildFresh() {
  const outputFiles = [
    resolve(distDir, 'index.html'),
    resolve(distDir, 'desktop-player.html'),
    resolve(distDir, 'desktop-lyrics.html'),
  ]
  if (outputFiles.some(outputFile => !existsSync(outputFile))) return false

  const rendererInputs = [
    resolve(projectRoot, 'src'),
    viteConfigFile,
    resolve(projectRoot, 'package.json'),
    resolve(projectRoot, 'package-lock.json'),
    ...readdirSync(projectRoot)
      .filter(file => file.endsWith('.html'))
      .map(file => resolve(projectRoot, file)),
  ]
  const newestInput = Math.max(...rendererInputs.map(getNewestMtime))
  const oldestOutput = Math.min(...outputFiles.map(outputFile => statSync(outputFile).mtimeMs))
  return oldestOutput >= newestInput
}

async function ensureRendererBuild() {
  if (isRendererBuildFresh()) {
    logStartup('Using cached renderer build')
    return
  }

  logStartup('Renderer sources changed; refreshing cached build')
  await build({ configFile: viteConfigFile })
  logStartup('Renderer build cache refreshed')
}

function isPortOpen(port, host = 'localhost') {
  return new Promise(resolve => {
    const socket = net.connect({ port, host })

    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })

    socket.once('error', () => resolve(false))

    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(port, timeoutMs = 10000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port)) {
      return true
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  return false
}

// ---- 端口占用识别与残留进程清理 ----------------------------------------
// 端口被占用不等于服务可用：之前有残留的 vite dev server（他人/其他会话 `npm run dev`
// 留下、或本启动器崩溃后的孤儿）抢占 3001，导致 local API server 起不来，
// 渲染端所有 /api/* 请求打到 Vite 上返回 HTML → 登录/扫码/账号信息全部失败。
// 这里先 HTTP 验证端口上是否真是 API 服务，再决定是否需要清理。
const ps = (args, opts = {}) => new Promise(resolve => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], { windowsHide: true, timeout: 6000, ...opts }, (error, stdout) => {
    if (error) return resolve(null)
    resolve(String(stdout || '').trim())
  })
})

/** 端口上是否为本次开发会话可复用的 local API server。 */
async function isLocalApiServerHealthy() {
  let timer
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch('http://127.0.0.1:3001/health', {
      headers: { 'X-HyperPlayer-Local-Token': localServiceToken },
      signal: controller.signal,
    })
    if (!res.ok) return false
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) return false
    const body = await res.json()
    return isCompatibleLocalApiHealth(body)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForLocalApi(timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isLocalApiServerHealthy()) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

async function createStaleLocalApiError() {
  const pid = await getPidOnPort(3001)
  const pidText = pid ? `（PID ${pid}）` : ''
  return new Error([
    '',
    '============================================================',
    `检测到 3001 端口上存在旧的或其他会话的 HyperPlayer 后端${pidText}。`,
    '为避免当前调试界面连接到错误的登录会话，本次启动已停止。',
    '请先清理该残留后端，再重新运行 npm run dev:electron。',
    '启动器没有自动终止该进程，也没有读取或输出任何登录凭据。',
    '============================================================',
  ].join('\n'))
}

/** 监听指定端口的 PID（仅 State=Listen 的进程） */
async function getPidOnPort(port) {
  const out = await ps([`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1`])
  const pid = Number((out || '').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** 进程命令行是否为「本项目残留的 dev 进程」（vite dev server / local-server / python 服务） */
function isHyperPlayerDevLeftover(commandLine) {
  if (!commandLine) return false
  // 统一为正斜杠比较，避免 Windows 命令行的反斜杠/正斜杠混用误判
  const normalized = commandLine.replace(/[\\/]+/g, '/')
  const root = projectRoot.replace(/[\\/]+/g, '/')
  if (!normalized.includes(root)) return false
  return /vite\/bin\/vite|local-server\.mjs|apple_bridge\.py/.test(normalized)
}

async function killProcess(pid) {
  await ps([`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`])
}

/**
 * 若端口被非 API 服务的残留 dev 进程占用，精确清理后返回 true；
 * 占用者不是本项目残留进程（可能是其他应用）则返回 false 并提示。
 */
async function freePortIfHijacked(port, serviceName) {
  const pid = await getPidOnPort(port)
  if (!pid) return true // 端口已空闲，无需处理

  const cmdline = await ps([`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`])
  if (isHyperPlayerDevLeftover(cmdline)) {
    console.warn(`[dev] 端口 ${port} 被残留的 HyperPlayer dev 进程(PID ${pid})占用，正在清理…`)
    await killProcess(pid)
    // 等端口真正释放
    for (let i = 0; i < 20; i++) {
      if (!(await isPortOpen(port))) return true
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return true
  }
  console.error(`[dev] 端口 ${port} 被其他进程(PID ${pid})占用，无法启动 ${serviceName}。请手动关闭占用该端口的程序后重试。`)
  return false
}

async function startDev() {
  logStartup('Development launcher started')
  let apiProcess = null

  const startAPI = async () => {
    if (await isPortOpen(3001)) {
      if (await isLocalApiServerHealthy()) {
        console.log('Local API server already running on http://localhost:3001')
        return null
      }
      throw await createStaleLocalApiError()
    }

    console.log('Starting Local API Server...')
    const apiProc = spawn(
      process.execPath,
      [resolve(__dirname, '../local-server.mjs')],
      { 
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...localServiceEnv,
          FORCE_COLOR: '1'
        }
      }
    )
    
    waitForLocalApi(10000).then(success => {
      if (success) {
        console.log('Local API server started successfully on http://localhost:3001')
      } else {
        console.warn('Local API server did not become ready on port 3001 within 10 seconds')
      }
    })
    
    return apiProc
  }

  const startRendererServer = async () => {
    const useLiveRenderer = process.env.HYPERPLAYER_LIVE_UI === '1'

    // 3000 是渲染服务专用端口：被残留的 vite dev server 占用会因 strictPort 直接失败
    if (await isPortOpen(3000)) {
      await freePortIfHijacked(3000, 'renderer server')
    }

    if (useLiveRenderer) {
      logStartup('Creating live Vite renderer server')
      const server = await createServer({
        configFile: viteConfigFile,
        server: {
          host: '127.0.0.1',
          port: 3000,
          strictPort: true,
        },
      })
      await server.listen()
      logStartup('Live Vite renderer server is listening')
      server.printUrls()
      return server
    }

    await ensureRendererBuild()
    logStartup('Creating cached renderer server')
    const server = await preview({
      configFile: viteConfigFile,
      preview: {
        host: '127.0.0.1',
        port: 3000,
        strictPort: true,
      },
    })
    logStartup('Cached renderer server is listening')
    server.printUrls()
    return server
  }

  // The cached production renderer is the default fast path; set HYPERPLAYER_LIVE_UI=1
  // to restore full Vite HMR.
  // 先完成 3001 预检，避免旧会话存在时仍启动其余服务并遗留更多进程。
  const api = await startAPI()
  const server = await startRendererServer()

  apiProcess = api

  logStartup('Backend launch tasks dispatched')
  const devServerUrl = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:3000/'
  console.log(`Electron loading ${devServerUrl}`)

  logStartup('Spawning Electron')
  const electronProcess = spawn(
    electron,
    [resolve(__dirname, '../desktop/main.cjs')],
    {
      stdio: 'inherit',
      env: {
        ...localServiceEnv,
        HYPERPLAYER_USER_DATA: userDataRoot,
        HYPERPLAYER_DEV_SERVER_URL: devServerUrl,
        HYPERPLAYER_STARTUP_LOG: startupLogFile,
      },
    }
  )

  const cleanup = () => {
    server.close()

    if (apiProcess && !apiProcess.killed) {
      apiProcess.kill()
    }
  }

  electronProcess.on('close', code => {
    cleanup()
    process.exit(typeof code === 'number' ? code : 1)
  })

  process.on('SIGINT', () => {
    cleanup()
    process.exit()
  })
}

startDev().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
