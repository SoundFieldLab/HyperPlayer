const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { pathToFileURL } = require('node:url')
// Playwright 可使用 Codex 工具运行时或外部安装，不进入应用依赖。
const toolsRoot = process.env.HYPERPLAYER_BROWSER_TOOLS
if (!toolsRoot) throw new Error('请设置 HYPERPLAYER_BROWSER_TOOLS 为包含 playwright 的 node_modules 绝对路径')
const { _electron } = require(path.join(toolsRoot, 'playwright'))
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'logs', 'perf')
fs.mkdirSync(out, { recursive: true })
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#315b70"/><circle cx="80" cy="80" r="42" fill="#73bfa5"/></svg>'
const image = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
const rowCount = Number(process.env.HYPERPLAYER_PERF_ROWS || 100)
const runName = process.env.HYPERPLAYER_PERF_RUN || 'baseline'
if (!Number.isInteger(rowCount) || rowCount < 10 || rowCount > 1000) throw new Error('行数须为 10–1000 的整数')
if (!/^[\w-]+$/.test(runName)) throw new Error('运行名称仅允许字母、数字、下划线与短横线')
const songs = Array.from({ length: rowCount }, (_, i) => ({
  id: i + 1, name: `性能基准歌曲 ${String(i + 1).padStart(3, '0')}`,
  artists: [{ id: 1, name: '基准歌手' }], album: { id: i + 1, name: '基准专辑', picUrl: image },
  duration: 210000, platform: 'netease', fee: 0,
}))

async function main() {
  async function isListening(port) {
    return new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const done = value => { socket.destroy(); resolve(value) }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.setTimeout(1000, () => done(true))
    })
  }
  // 主程序退出有后端孤儿清扫；已有服务时直接拒绝启动，绝不复用或停止它。
  if (await isListening(3210) || await isListening(3211)) throw new Error('3210/3211 已被占用，请在服务空闲时运行独立性能基准')
  const { preview } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href)
  const server = await preview({ configFile: path.join(root, 'vite.config.ts'), preview: { host: '127.0.0.1', port: 3210, strictPort: true } })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperplayer-perf-'))
  const env = { ...process.env, HYPERPLAYER_USER_DATA: profile, HYPERPLAYER_DEV_SERVER_URL: 'http://127.0.0.1:3210', HYPERPLAYER_PERF: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'desktop/main.cjs')], cwd: root, env, timeout: 30000 })
    const context = app.context()
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url())
      if (url.port === '3210') return route.continue()
      if (url.pathname.includes('cover') || url.pathname.includes('proxy-image')) return route.fulfill({ contentType: 'image/svg+xml', body: svg })
      if (url.pathname === '/api/netease/search') return route.fulfill({ json: { code: 200, result: { songs, songCount: songs.length } } })
      return route.fulfill({ json: { code: 200, data: [], result: { songs: [], hots: [] }, banners: [], playlists: [], songs: [], list: [], hotSongs: [], albums: [], artist: {}, success: true } })
    })
    await context.addInitScript(({ songs }) => {
      localStorage.setItem('viewMode', 'minimal')
      sessionStorage.setItem('hyperplayer_search_keyword', '性能基准')
      sessionStorage.setItem('hyperplayer_search_all_results', JSON.stringify(songs))
      sessionStorage.setItem('hyperplayer_search_displayed_results', JSON.stringify(songs))
    }, { songs })
    let page
    for (let i = 0; i < 80; i++) {
      page = app.windows().find(p => p.url().includes('3210'))
      if (page) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (!page) throw new Error('main window missing')
    await page.reload()
    await page.waitForTimeout(6000)
    const runtime = await app.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('3210'))
      if (main) { main.setSize(1400, 900); main.show(); main.focus() }
      return { electron: process.versions.electron, chromium: process.versions.chrome, gpu: app.getGPUFeatureStatus(), processes: app.getAppMetrics().map(m => ({ type: m.type, memory: m.memory })) }
    })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')

    async function measure(name, action) {
      await page.evaluate(() => {
        const state = { frames: [], longTasks: [], stopped: false, previous: 0 }
        window.__perfProbe = state
        state.observer = new PerformanceObserver(list => {
          for (const e of list.getEntries()) state.longTasks.push(e.duration)
        })
        state.observer.observe({ type: 'longtask', buffered: false })
        const tick = now => {
          if (state.stopped) return
          if (state.previous) state.frames.push(now - state.previous)
          state.previous = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const before = await cdp.send('Performance.getMetrics')
      const tracing = name === 'search-scroll' && process.env.HYPERPLAYER_PERF_TRACE === '1'
      if (tracing) {
        await cdp.send('Profiler.enable')
        await cdp.send('Profiler.start')
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' })
      }
      const start = Date.now()
      if (action) await action()
      else await page.waitForTimeout(4000)
      const after = await cdp.send('Performance.getMetrics')
      const duration = Date.now() - start
      const result = await page.evaluate(() => {
        const s = window.__perfProbe
        s.stopped = true
        s.observer.disconnect()
        const sorted = s.frames.slice().sort((a,b) => a-b)
        return {
          frames: sorted.length, p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1),
          over33: sorted.filter(x => x > 33.5).length,
          over50: sorted.filter(x => x > 50).length,
          longTasks: s.longTasks.length, longTaskMs: s.longTasks.reduce((a,b) => a+b, 0),
          dom: document.querySelectorAll('*').length, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
          mountedRows: document.querySelectorAll('[data-song-index]').length,
        }
      })
      if (tracing) {
        const { profile } = await cdp.send('Profiler.stop')
        fs.writeFileSync(path.join(out, `${runName}.cpuprofile`), JSON.stringify(profile))
        const completed = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))
        await cdp.send('Tracing.end')
        const { stream } = await completed
        let data = ''
        for (;;) {
          const chunk = await cdp.send('IO.read', { handle: stream })
          data += chunk.data
          if (chunk.eof) break
        }
        await cdp.send('IO.close', { handle: stream })
        fs.writeFileSync(path.join(out, `${runName}.trace.json`), data)
      }
      const get = (m, n) => m.metrics.find(x => x.name === n)?.value || 0
      const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, workingSetMB: m.memory.workingSetSize / 1024, privateMB: m.memory.privateBytes / 1024 })))
      const sample = { name, duration, ...result,
        taskMs: 1000 * (get(after, 'TaskDuration') - get(before, 'TaskDuration')),
        layoutMs: 1000 * (get(after, 'LayoutDuration') - get(before, 'LayoutDuration')),
        heapMB: get(after, 'JSHeapUsedSize') / 1048576, processes }
      console.log(JSON.stringify(sample))
      return sample
    }
    const samples = []
    samples.push(await measure('home-idle'))
    await page.locator('.home-bottom-bar').hover()
    await page.getByTitle('搜索音乐', { exact: true }).click()
    await page.getByPlaceholder('搜索歌曲、艺术家...').waitFor()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(out, 'search.png') })
    samples.push(await measure('search-idle'))
    samples.push(await measure('search-scroll', async () => {
      await page.mouse.move(800, 450)
      for (let i = 0; i < 50; i++) {
        await page.mouse.wheel(0, i < 25 ? 220 : -220)
        await page.waitForTimeout(35)
      }
    }))
    const listCheck = await page.evaluate(() => {
      const first = document.querySelector('[data-song-index]')
      let container = first?.parentElement
      while (container && getComputedStyle(container).overflowY !== 'auto') container = container.parentElement
      if (!container) throw new Error('歌曲滚动容器缺失')
      container.scrollTop = container.scrollHeight
      return { height: container.scrollHeight, clientHeight: container.clientHeight }
    })
    await page.waitForTimeout(500)
    const lastPresent = await page.locator(`[data-song-index="${rowCount - 1}"]`).count()
    if (!lastPresent) throw new Error('滚动到底部未挂载最后一首歌曲')
    const lastRow = page.locator(`[data-song-index="${rowCount - 1}"]`)
    await lastRow.scrollIntoViewIfNeeded()
    await page.mouse.move(300, 150)
    await page.waitForTimeout(350)
    await lastRow.hover()
    await page.waitForTimeout(350)
    const hovered = await lastRow.evaluate(e => getComputedStyle(e).transform)
    if (hovered === 'none') throw new Error('静止悬停动画未保留')
    await lastRow.click({ button: 'right' })
    await page.waitForTimeout(250)
    const menu = await page.locator('body').innerText()
    if (!menu.includes('下一首播放')) throw new Error('歌曲右键菜单不可用')
    await page.screenshot({ path: path.join(out, `${runName}-bottom-menu.png`) })
    await page.keyboard.press('Escape')
    // 完成相同交互后的回收堆采样；GC 仅用于隔离实验，产品不调用 GC。
    const memoryCycles = []
    const cycles = Number(process.env.HYPERPLAYER_PERF_CYCLES || 0)
    if (!Number.isInteger(cycles) || cycles < 0 || cycles > 30) throw new Error('循环次数须为 0–30 的整数')
    for (let i = 0; i < cycles; i++) {
      const heading = page.getByRole('heading', { name: '搜索音乐', exact: true })
      await heading.locator('..').locator('button').click()
      await page.waitForTimeout(350)
      await page.locator('.home-bottom-bar').hover()
      await page.getByTitle('搜索音乐', { exact: true }).click()
      await page.getByPlaceholder('搜索歌曲、艺术家...').waitFor()
      await page.waitForTimeout(350)
      await cdp.send('HeapProfiler.collectGarbage')
      const metric = await cdp.send('Performance.getMetrics')
      const dom = await cdp.send('Memory.getDOMCounters')
      memoryCycles.push({ cycle: i + 1, heapMB: metric.metrics.find(x => x.name === 'JSHeapUsedSize').value / 1048576, ...dom })
    }
    const frameBudget = samples[0].p95 * 2.2
    const verdict = { frameBudget, scrollP95: samples.at(-1).p95, pass: samples.at(-1).p95 <= frameBudget }
    fs.writeFileSync(path.join(out, `${runName}.json`), JSON.stringify({ runtime, rowCount, samples, listCheck, lastPresent, hovered, memoryCycles, verdict }, null, 2))
    console.log(JSON.stringify({ file: `logs/perf/${runName}.json`, rowCount, verdict }))
    if (!verdict.pass) process.exitCode = 2
  } finally {
    if (app) {
      // app.exit 不派发 will-quit，避开生产主进程全局端口清扫；只退出本次拥有的实例。
      const child = app.process()
      const exited = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise(resolve => child.once('exit', resolve))
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
      let timeout
      await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 3000) })])
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await exited
      }
    }
    await new Promise(resolve => server.httpServer.close(resolve))
    // 仅删除本次 mkdtemp 创建的匿名测试配置；从不读取或删除用户配置目录。
    if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('hyperplayer-perf-')) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
