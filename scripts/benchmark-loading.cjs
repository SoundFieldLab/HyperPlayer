'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { observeRendererNetwork, summarizeNetwork, networkWindow, summarizeRuns, distribution, upstreamWindow } = require('./lib/loading-metrics.cjs')
const root = path.resolve(__dirname, '..')
const allScenarios = ['startup-cold', 'startup-warm', 'search', 'search-scroll', 'artist-tabs', 'playlist-open', 'playlist-play-all', 'continuous-play', 'mv-toggle', 'idle']
const milestones = { 'startup-cold': 'shell-interactive', 'startup-warm': 'shell-interactive', search: 'first-result-visible', 'artist-tabs': 'tabs-loaded-and-returned', 'playlist-open': 'playlist-play-button-ready', 'playlist-play-all': 'audio-playing', 'continuous-play': 'three-next-actions-playing', 'mv-toggle': 'watch-surface-enabled-and-disabled' }
const networkProfiles = { normal: { latencyMs: 0, download: 0, upload: 0 }, slow: { latencyMs: 180, download: 131072, upload: 65536 } }

function planFromArgs(args) {
  const options = { modes: 'minimal,traditional,explore,desktop', platforms: 'netease,qq', networks: 'normal,slow', repeats: '3', run: 'loading-baseline', scenarios: allScenarios.join(','), source: 'fixture', idle: '4000' }
  for (const arg of args) {
    if (arg === '--plan') continue
    const match = /^--([a-z]+)=(.+)$/.exec(arg)
    if (!match || !Object.hasOwn(options, match[1])) throw new Error('未知参数；请用 --plan 查看默认计划')
    options[match[1]] = match[2]
  }
  const select = (key, choices) => {
    const values = options[key].split(',')
    if (!values.length || values.some(x => !choices.includes(x)) || new Set(values).size !== values.length) throw new Error(`无效 ${key}`)
    return values
  }
  const modes = select('modes', ['minimal', 'traditional', 'explore', 'desktop'])
  const platforms = select('platforms', ['netease', 'qq'])
  const networks = select('networks', ['normal', 'slow'])
  const scenarios = select('scenarios', allScenarios)
  if (!/^[\w-]+$/.test(options.run)) throw new Error('运行名称仅允许字母、数字、下划线和短横线')
  const repeats = Number(options.repeats)
  const idleMs = Number(options.idle)
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isInteger(idleMs) || idleMs < 1000 || idleMs > 600000) throw new Error('repeats须为1至10；idle须为1000至600000ms')
  if (!['fixture', 'live'].includes(options.source)) throw new Error('source须为fixture或live')
  if (options.source === 'live' && scenarios.some(x => !['startup-cold', 'startup-warm', 'idle'].includes(x))) throw new Error('匿名真实网络仅自动运行启动／空闲；不能用合成关键词冒充真实业务验收')
  const runs = modes.flatMap(mode => platforms.flatMap(platform => networks.flatMap(network => Array.from({ length: repeats }, (_, i) => ({ mode, platform, network, repeat: i + 1 })))))
  return { run: options.run, source: options.source === 'fixture' ? 'controlled-sdk-fixtures' : 'live-anonymous', scenarios, idleMs, runs }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function portOccupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = occupied => { socket.destroy(); resolve(occupied) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(true))
  })
}

// 与既有 benchmark:ui 使用相同 Electron／生产 dist／匿名 profile；不复用其 renderer 固定响应。
async function runCase(plan, conditions, out, playwright, signal) {
  if (await portOccupied(3210) || await portOccupied(3211)) throw new Error('3210/3211已被占用；拒绝复用、停止或清扫现有服务')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperplayer-loading-'))
  const caseId = `${conditions.mode}-${conditions.platform}-${conditions.network}-${conditions.repeat}`
  const probeFile = path.join(out, `${caseId}.upstream.ndjson`)
  const token = crypto.randomBytes(32).toString('hex')
  const slow = conditions.network === 'slow'
  const networkProfile = networkProfiles[conditions.network]
  const fixture = plan.source === 'controlled-sdk-fixtures'
  const env = { ...process.env, HYPERPLAYER_USER_DATA: profile, HYPERPLAYER_USERDATA: profile,
    HYPERPLAYER_LOCAL_TOKEN: token, HYPERPLAYER_DEV_SERVER_URL: 'about:blank', HYPERPLAYER_DISABLE_LOCAL_BACKEND: '1',
    HYPERPLAYER_LOADING_PROBE_FILE: probeFile, HYPERPLAYER_LOADING_FIXTURES: fixture ? '1' : '0',
    HYPERPLAYER_LOADING_LATENCY_MS: String(networkProfile.latencyMs), HYPERPLAYER_LOADING_BYTES_PER_SECOND: String(networkProfile.download), PORT: '3211' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  let server, backend, app, cdp, stopNetwork
  const interrupt = () => { if (app) void app.evaluate(({ app }) => app.exit(0)).catch(() => {}) }
  signal.addEventListener('abort', interrupt, { once: true })
  const result = { conditions: { ...conditions, account: 'anonymous', weather: 'unconfigured', cache: 'new isolated profile; warm means reload same session', rows: 160,
    networkScope: fixture ? 'SDK-fixture and fetch-fixture per response; renderer external fixtures; HTTP cache disabled by Playwright routing; no shared-link bandwidth contention' : 'CDP main-renderer only; upstream live, unthrottled',
    latencyMs: networkProfile.latencyMs, bytesPerSecondPerResponse: networkProfile.download || null }, samples: [] }
  try {
    const { preview } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href)
    server = await preview({ configFile: path.join(root, 'vite.config.ts'), preview: { host: '127.0.0.1', port: 3210, strictPort: true } })
    const backendStart = Date.now()
    backend = spawn(process.execPath, ['--require', path.join(__dirname, 'lib/loading-network-probe.cjs'), path.join(root, 'local-server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let backendError = false
    backend.on('error', () => { backendError = true })
    for (let i = 0; ; i++) {
      signal.throwIfAborted()
      if (backendError || backend.exitCode !== null) throw new Error('隔离后端启动失败')
      try {
        const response = await fetch('http://127.0.0.1:3211/health', { headers: { 'x-hyperplayer-local-token': token }, signal: AbortSignal.timeout(1000) })
        const body = await response.json()
        if (body.service === 'hyperplayer-local-api' && body.neteaseAPI === 'loaded') break
      } catch { /* 只轮询本次拥有的后端。 */ }
      if (i >= 100) throw new Error('隔离后端未就绪')
      await delay(100)
    }
    result.backendReadyMs = Date.now() - backendStart
    const launchStart = Date.now()
    app = await playwright._electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'desktop/main.cjs')], cwd: root, env, timeout: 30000 })
    const context = app.context()
    await context.addInitScript(({ mode, platform }) => {
      if (location.origin !== 'http://127.0.0.1:3210') return
      if (!localStorage.getItem('hyperplayer:loading-profile')) {
        localStorage.setItem('hyperplayer:loading-profile', '1')
        localStorage.setItem('viewMode', mode)
        localStorage.setItem('hyperplayer_last_search_platform', platform)
        for (const key of ['selectedPlatform', 'explorePlatform', 'desktopModePlatform', 'traditionalPlatform']) localStorage.setItem(key, platform)
      }
      const s = { frames: [], longTasks: [], jsonAwaitMs: 0, jsonCalls: 0, playing: [], audio: [], raf: 0, observer: null, actionStart: performance.now() }
      window.__loadingProbe = s
      window.Audio = new Proxy(window.Audio, { construct(target, args, newTarget) {
        const audio = Reflect.construct(target, args, newTarget)
        s.audio.push(audio)
        audio.addEventListener('playing', () => s.playing.push(performance.now()))
        return audio
      } })
      let previous = 0
      const frame = now => { if (previous && document.visibilityState === 'visible') s.frames.push(now - previous); previous = now; s.raf = requestAnimationFrame(frame) }
      s.raf = requestAnimationFrame(frame)
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        s.observer = new PerformanceObserver(list => list.getEntries().forEach(e => s.longTasks.push(e.duration)))
        s.observer.observe({ type: 'longtask' })
      }
      const original = Response.prototype.json
      Response.prototype.json = async function (...args) {
        const start = performance.now()
        try { return await original.apply(this, args) } finally { s.jsonCalls++; s.jsonAwaitMs += performance.now() - start }
      }
      document.addEventListener('playing', () => s.playing.push(performance.now()), true)
      // 所有内容都来自合成 fixture；不记录正文、关键词或错误日志。
    }, conditions)
    if (fixture) {
      const { rendererFixture } = require('./lib/loading-renderer-fixture.cjs')
      await context.route(/^https?:\/\//, async route => {
        const url = new URL(route.request().url())
        if (['localhost', '127.0.0.1'].includes(url.hostname) && ['3210', '3211'].includes(url.port)) return route.continue()
        const response = rendererFixture(url)
        if (slow) await delay(networkProfile.latencyMs + Math.ceil(response.body.length / networkProfile.download * 1000))
        await route.fulfill(response).catch(() => {})
      })
    }
    let page
    for (let i = 0; i < 100; i++) {
      page = app.windows().find(p => p.url() === 'about:blank')
      if (page) break
      await delay(100)
    }
    if (!page) throw new Error('主窗口缺失')
    page.setDefaultTimeout(8000)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === 'about:blank')
      main.setSize(1400, 900); main.show(); main.focus()
    })
    cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Performance.enable')
    if (slow && !fixture) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: networkProfile.latencyMs, downloadThroughput: networkProfile.download, uploadThroughput: networkProfile.upload })
    stopNetwork = observeRendererNetwork(cdp)
    const metric = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics')
      return Object.fromEntries(metrics.map(x => [x.name, x.value]))
    }
    let snapshotSequence = 0
    const backendSnapshot = () => new Promise(resolve => {
      const id = ++snapshotSequence
      const finish = value => { clearTimeout(timer); backend.off('message', handler); resolve(value) }
      const handler = value => { if (value?.type === 'hyperplayer-loading-snapshot' && value.id === id) finish(value) }
      const timer = setTimeout(() => finish(null), 1000)
      backend.on('message', handler)
      if (backend.connected) backend.send({ type: 'hyperplayer-loading-snapshot', id }, error => { if (error) finish(null) })
      else finish(null)
    })
    const browserSnapshot = () => page.evaluate(() => {
      const s = window.__loadingProbe
      return s ? { frames: s.frames, longTasks: s.longTasks, jsonAwaitMs: s.jsonAwaitMs, jsonCalls: s.jsonCalls, playingEvents: s.playing.length,
        firstPlayingMs: s.playing.length ? s.playing[0] - s.actionStart : null, dom: document.querySelectorAll('*').length, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio } : null
    })
    async function measure(name, action, navigating = false) {
      signal.throwIfAborted()
      const before = await metric()
      const backendBefore = await backendSnapshot()
      if (!navigating) await page.evaluate(() => { const s = window.__loadingProbe; s.frames = []; s.longTasks = []; s.jsonAwaitMs = 0; s.jsonCalls = 0; s.playing = []; s.actionStart = performance.now() })
      const wallStart = Date.now()
      const nominalWindowMs = name === 'idle' ? plan.idleMs : 1500
      // 动作完成可在观察窗之后；固定窗口不因慢网或超时而扩大。
      const checkpoint = delay(nominalWindowMs).then(async () => {
        const after = await metric()
        const wallEnd = Date.now()
        const network = networkWindow(stopNetwork.snapshot(), before.Timestamp, after.Timestamp)
        const browser = await browserSnapshot()
        const backendAfter = await backendSnapshot()
        const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, cpuPercent: m.cpu.percentCPUUsage, workingSetMB: m.memory.workingSetSize / 1024, privateMB: m.memory.privateBytes / 1024 })))
        return { after, wallEnd, network, browser, backendAfter, processes }
      })
      // 立即订阅拒绝，动作仍在等待时也不会生成 unhandled rejection。
      checkpoint.catch(() => {})
      let status = 'measured', usableMs = null, failure = null, actionLocation = null
      try { await action(); usableMs = Date.now() - wallStart } catch (error) {
        status = 'failed'; failure = error.name === 'TimeoutError' ? 'timeout' : 'action-error'
        actionLocation = String(error.stack).match(/loading-scenarios.cjs:\d+:\d+/)?.[0] || null
        if (fixture) await page.screenshot({ path: path.join(out, `${caseId}-${name}-failed.png`) }).catch(() => {})
      }
      const actionDurationMs = Date.now() - wallStart
      const { after, wallEnd, network, browser, backendAfter, processes } = await checkpoint
      const finalPlaying = await page.evaluate(() => { const s = window.__loadingProbe; return s?.playing.length ? s.playing[0] - s.actionStart : null })
      const sample = { name, status, failure, actionLocation, milestone: milestones[name] || 'observation-window', wallStart, wallEnd, nominalWindowMs, usableMs: milestones[name] ? usableMs : null, durationMs: wallEnd - wallStart, actionDurationMs,
        network,
        frames: distribution(browser?.frames || []), longTasks: distribution(browser?.longTasks || []), longTaskTotalMs: browser?.longTasks.reduce((a,b) => a+b, 0) ?? null,
        responseJsonAwaitMs: browser?.jsonAwaitMs ?? null, jsonCalls: browser?.jsonCalls ?? null, parseCpuMs: null,
        taskMs: navigating ? null : 1000 * (after.TaskDuration - before.TaskDuration), scriptMs: navigating ? null : 1000 * (after.ScriptDuration - before.ScriptDuration),
        layoutMs: navigating ? null : 1000 * (after.LayoutDuration - before.LayoutDuration), heapMB: after.JSHeapUsedSize / 1048576,
        playingEventsInWindow: browser?.playingEvents ?? 0, firstPlayingMs: finalPlaying, dom: browser?.dom ?? null, viewport: browser?.viewport, dpr: browser?.dpr, processes,
        backend: backendBefore && backendAfter ? { cpuUserMs: (backendAfter.cpu.user - backendBefore.cpu.user) / 1000, cpuSystemMs: (backendAfter.cpu.system - backendBefore.cpu.system) / 1000,
          rssMB: backendAfter.memory.rss / 1048576, heapUsedMB: backendAfter.memory.heapUsed / 1048576, externalMB: backendAfter.memory.external / 1048576, sampleWindowMs: backendAfter.at - backendBefore.at } : null }
      result.samples.push(sample)
      console.log(JSON.stringify({ case: caseId, scenario: name, status, requests: sample.network.started, usableMs }))
      return status === 'measured'
    }
    const run = async (name, action, navigating = false) => plan.scenarios.includes(name) ? measure(name, action, navigating) : null
    async function ready() {
      await page.locator('#root > *').first().waitFor()
      if (conditions.mode === 'desktop') await page.getByLabel('显示歌单', { exact: true }).waitFor()
      else if (conditions.mode === 'minimal') {
        await page.locator('.home-bottom-bar').hover()
        await page.getByTitle('搜索音乐', { exact: true }).waitFor()
      }
      else if (conditions.mode === 'traditional') await page.getByRole('button', { name: /^(打开搜索|搜索)$/ }).first().waitFor()
      else await page.getByRole('button', { name: '搜索', exact: true }).waitFor()
      await delay(400)
    }
    await run('startup-cold', async () => { await page.goto('http://127.0.0.1:3210'); await ready() }, true)
    if (page.url() === 'about:blank') { await page.goto('http://127.0.0.1:3210'); await ready() }
    result.screen = await app.evaluate(({ screen, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('3210'))
      const display = screen.getDisplayMatching(win.getBounds())
      return { refreshRate: display.displayFrequency, scaleFactor: display.scaleFactor, size: display.size }
    })
    result.settings = await page.evaluate(() => Object.fromEntries(['crossfadeEnabled', 'crossfadeDuration', 'gaplessEnabled', 'albumGaplessEnabled', 'lyricDisplayMode', 'mvBackgroundEnabled', 'backgroundEffect', 'coverPulseEnabled', 'hyperplayer:perf-mode', 'hyperplayer:audio-engine-version'].map(key => {
      const raw = localStorage.getItem(key)
      return [key, raw === null ? 'unset/default' : /^(true|false|\d+(\.\d+)?|modern|immersive|video|pv|v3|hse|normal|low|high|none|transparent)$/.test(raw) ? raw : 'configured']
    })))
    result.electronLaunchToColdCompleteMs = Date.now() - launchStart
    await run('startup-warm', async () => { await page.reload(); await ready() }, true)
    await run('idle', () => page.waitForTimeout(plan.idleMs))
    const { exerciseScenarios } = require('./lib/loading-scenarios.cjs')
    await exerciseScenarios({ page, conditions, run })
    result.runtime = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, gpu: app.getGPUFeatureStatus() }))
    result.completedAt = new Date().toISOString()
    return result
  } catch (error) {
    result.fatal = { type: error.name, location: String(error.stack).split('\n').find(line => line.includes('benchmark-loading.cjs:'))?.match(/benchmark-loading.cjs:\d+:\d+/)?.[0] || null }
    return result
  } finally {
    signal.removeEventListener('abort', interrupt)
    const cleanupErrors = []
    const cleanup = async (label, action) => { try { await action() } catch { cleanupErrors.push(label) } }
    await cleanup('renderer-observer', () => { if (stopNetwork) result.rendererTotal = summarizeNetwork(stopNetwork()) })
    await cleanup('electron', async () => {
      if (!app) return
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await stopOwned(app.process(), true)
    })
    await cleanup('backend', async () => { if (backend) await stopOwned(backend) })
    await cleanup('upstream-report', () => {
      if (!fs.existsSync(probeFile)) return
      const events = fs.readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      for (const sample of result.samples) sample.upstream = upstreamWindow(events, sample.wallStart, sample.wallEnd)
      result.upstreamTotal = upstreamWindow(events, 0, Date.now())
    })
    await cleanup('preview', async () => { if (server?.httpServer) { server.httpServer.closeAllConnections(); await new Promise(resolve => server.httpServer.close(resolve)) } })
    // 递归删除前核对最终绝对路径，仅清理本次 mkdtemp 拥有的目录。
    if (!cleanupErrors.includes('electron') && !cleanupErrors.includes('backend') && path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('hyperplayer-loading-')) {
      await cleanup('profile', () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
    }
    if (cleanupErrors.length) { result.cleanupErrors = cleanupErrors; result.fatal ||= { type: 'cleanup-failed' } }
  }
}

async function stopOwned(child, graceful = false) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  if (graceful) await Promise.race([exited, delay(3000)])
  if (child.exitCode === null && child.signalCode === null) child.kill()
  await Promise.race([exited, delay(3000)])
  if (child.exitCode === null && child.signalCode === null) throw new Error('本次拥有的进程未退出；保留profile以免删除仍使用的文件')
}

async function main() {
  const plan = planFromArgs(process.argv.slice(2))
  if (process.argv.includes('--plan')) return console.log(JSON.stringify(plan, null, 2))
  if (await portOccupied(3210) || await portOccupied(3211)) throw Object.assign(new Error('ports occupied'), { code: 'EPORTBUSY' })
  const tools = process.env.HYPERPLAYER_BROWSER_TOOLS
  if (!tools || !path.isAbsolute(tools)) throw new Error('请设置 HYPERPLAYER_BROWSER_TOOLS 为包含 playwright 的 node_modules 绝对路径')
  const playwright = require(path.join(tools, 'playwright'))
  const out = path.join(root, 'logs/perf', plan.run)
  if (fs.existsSync(out)) throw new Error('运行目录已存在；使用新的 --run 名称，防止覆盖基线')
  fs.mkdirSync(out, { recursive: true })
  const runs = []
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const hash = crypto.createHash('sha256')
  function fingerprint(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const file = path.join(directory, entry.name); if (entry.isDirectory()) fingerprint(file); else { hash.update(path.relative(root, file)); hash.update(fs.readFileSync(file)) } } }
  fingerprint(path.join(root, 'dist'))
  const buildHash = hash.digest('hex')
  const toolHash = crypto.createHash('sha256')
  for (const file of [__filename, ...fs.readdirSync(path.join(__dirname, 'lib')).filter(n => n.startsWith('loading-')).sort().map(n => path.join(__dirname, 'lib', n))]) toolHash.update(fs.readFileSync(file))
  const toolFingerprint = toolHash.digest('hex')
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
  const report = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ schemaVersion: 1, plan, buildHash, toolFingerprint, revision, host: { node: process.versions.node, os: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
    coverage: { plannedRuns: plan.runs.length, recordedRuns: runs.length, failedRuns: runs.filter(r => r.fatal).length, failedScenarios: runs.flatMap(r => r.samples).filter(s => s.status !== 'measured').length, measuredScenarios: runs.flatMap(r => r.samples).filter(s => s.status === 'measured').length },
    runs, summary: summarizeRuns(runs),
    limitations: ['匿名隔离profile；未验证真实账号', '冷启动指全新profile的首次renderer导航，非OS冷启动或打包版启动门控', '受控SDK调用是逻辑上游，不是SDK内部真实HTTP扇出', 'responseJsonAwaitMs包含等待正文和解析，不能作为纯解析CPU；parseCpuMs未知', '每响应限速不模拟共享链路争用；未凭单次波动判断因果'] }, null, 2))
  try {
    for (const conditions of plan.runs) {
      if (controller.signal.aborted || fs.existsSync(path.join(out, 'STOP'))) break
      const run = await runCase(plan, conditions, out, playwright, controller.signal)
      runs.push(run)
      report()
    }
  } finally { report(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
  if (controller.signal.aborted || runs.length !== plan.runs.length || runs.some(r => r.fatal || r.samples.some(s => s.status !== 'measured'))) process.exitCode = 2
}

if (require.main === module) main().catch(error => { console.error(JSON.stringify({ failure: error.name, code: error.code === 'EPORTBUSY' ? 'EPORTBUSY' : null, location: String(error.stack).split('\n').find(line => line.includes('benchmark-loading.cjs:'))?.match(/benchmark-loading.cjs:\d+:\d+/)?.[0] || null })); process.exitCode = 1 })
module.exports = { planFromArgs, portOccupied }
