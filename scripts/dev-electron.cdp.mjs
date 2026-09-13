import { spawn } from 'child_process'
import { createServer } from 'vite'
import electron from 'electron'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import net from 'net'

// CDP 调试启动器：与 scripts/dev-electron.mjs 同样的三件套（Vite + 本地 API + Electron），
// 区别只是给 Electron 打开 --remote-debugging-port。端口与主启动器保持一致：
// Vite 3210 / 本地 API 3211（避开 WaveForge 系的 3000–3002，两者可同时运行）。
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const VITE_PORT = 3210
const API_PORT = 3211

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

async function startDev() {
  let apiProcess = null

  const startAPI = async () => {
    if (await isPortOpen(API_PORT)) {
      console.log(`Local API server already running on http://localhost:${API_PORT}`)
      return null
    }

    console.log('Starting Local API Server...')
    const apiProc = spawn(
      process.execPath,
      [resolve(__dirname, '../local-server.mjs')],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...process.env,
          FORCE_COLOR: '1'
        }
      }
    )

    waitForPort(API_PORT, 10000).then(success => {
      if (success) {
        console.log(`Local API server started successfully on http://localhost:${API_PORT}`)
      } else {
        console.warn(`Local API server did not open port ${API_PORT} within 10 seconds`)
      }
    })

    return apiProc
  }

  const startVite = async () => {
    const server = await createServer({
      configFile: resolve(__dirname, '../vite.config.ts'),
    })
    await server.listen()
    server.printUrls()
    return server
  }

  // 并行启动所有服务
  const [api, server] = await Promise.all([
    startAPI(),
    startVite()
  ])

  apiProcess = api

  const devServerUrl = server.resolvedUrls?.local?.[0] || `http://127.0.0.1:${VITE_PORT}/`
  console.log(`Electron loading ${devServerUrl}`)

  const electronProcess = spawn(
    electron,
    [resolve(__dirname, '../desktop/main.cjs'), '--remote-debugging-port=9222'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        HYPERPLAYER_DEV_SERVER_URL: devServerUrl,
      },
    }
  )

  const cleanup = () => {
    server.close()

    if (apiProcess && !apiProcess.killed) {
      apiProcess.kill()
    }
  }

  electronProcess.on('close', () => {
    cleanup()
    process.exit()
  })

  process.on('SIGINT', () => {
    cleanup()
    process.exit()
  })
}

startDev()
