'use strict'

/**
 * 可选 node --require preload。默认不 hook、不订阅 channel、不创建 timer。
 * FILE 必须为绝对路径，NDJSON 追加写入；runner 以 id 配对，以 at 划分场景窗口。
 * transport=sdk-fixture 是公开 SDK logical 调用，不能当作 SDK 内部 HTTP 扇出。
 * encodedBytes 是响应正文的编码字节，transferredBytes 是线上传输量；未知为 null。
 * 真实 fetch 用 undici diagnostics，不 clone/tee/提前消费响应，不改变正常响应流。
 * TEST_UPSTREAM_ORIGIN 仅允许一个临时 loopback origin；本地服务 3211 始终排除。
 * 有 IPC 时仅响应固定 hyperplayer-loading-snapshot 请求，不做周期采样。
 */
const outputFile = process.env.HYPERPLAYER_LOADING_PROBE_FILE
const empty = () => ({ enabled: false, started: 0, ended: 0, active: 0, peakActive: 0, byTransport: {} })
module.exports = { getSnapshot: empty }

if (outputFile) {
  const path = require('node:path')
  if (!path.isAbsolute(outputFile)) throw new Error('Loading probe requires an absolute output file')
  install(outputFile)
}

function install(file) {
  const fs = require('node:fs')
  const { channel } = require('node:diagnostics_channel')
  const { syncBuiltinESMExports } = require('node:module')
  const http = require('node:http')
  const https = require('node:https')
  const originalHttpRequest = http.request
  const originalHttpsRequest = https.request
  const fd = fs.openSync(file, 'a', 0o600)
  let sinkFailed = false
  const fixtureMode = process.env.HYPERPLAYER_LOADING_FIXTURES === '1'
  const latencyMs = setting('HYPERPLAYER_LOADING_LATENCY_MS')
  const bytesPerSecond = setting('HYPERPLAYER_LOADING_BYTES_PER_SECOND')
  const state = { enabled: true, started: 0, ended: 0, active: 0, peakActive: 0, byTransport: {} }
  let sequence = 0
  const undiciRequests = new WeakMap()
  const observedRequests = new WeakSet()
  let creatingFixture = 0
  let testOrigin = null
  try {
    const url = new URL(process.env.HYPERPLAYER_LOADING_TEST_UPSTREAM_ORIGIN)
    if (isLoopback(url.hostname) && url.port !== '3211') testOrigin = url.origin
  } catch { /* 未配置测试上游 */ }

  function write(event) {
    if (sinkFailed) return
    try { fs.writeSync(fd, JSON.stringify({ version: 1, ...event }) + '\n') }
    catch { sinkFailed = true } // 诊断文件故障不得打断正常网络流。
  }

  function external(url) {
    if (!url || !['http:', 'https:'].includes(url.protocol)) return false
    // 不把本地代理链 3211 或任意普通 loopback 请求统计为外部。
    if (isLoopback(url.hostname)) return url.port !== '3211' && url.origin === testOrigin
    return true
  }

  function begin(transport, classification, fixture = false, fixtureMiss = false) {
    const counters = state.byTransport[transport] ||= { started: 0, ended: 0, active: 0, peakActive: 0 }
    state.started++; state.active++; state.peakActive = Math.max(state.peakActive, state.active)
    counters.started++; counters.active++; counters.peakActive = Math.max(counters.peakActive, counters.active)
    const startedAt = Date.now()
    const base = { id: `${process.pid}-${++sequence}`, transport, ...classification, fixture, fixtureMiss }
    write({ ...base, event: 'request-start', at: startedAt, active: state.active, peakActive: state.peakActive })
    let ended = false
    return (status, outcome, encodedBytes = null, transferredBytes = null) => {
      if (ended) return
      ended = true
      state.ended++; state.active--; counters.ended++; counters.active--
      write({ ...base, event: 'request-end', at: Date.now(), startedAt,
        status: Number.isInteger(status) ? status : null, outcome, encodedBytes, transferredBytes,
        active: state.active, peakActive: state.peakActive })
    }
  }

  module.exports = { getSnapshot: () => ({ ...structuredClone(state), sinkFailed, fixtureMode }) }

  if (typeof process.send === 'function' && process.connected) {
    process.on('message', message => {
      if (!message || typeof message !== 'object' || Array.isArray(message) ||
          Object.keys(message).length !== 2 || message.type !== 'hyperplayer-loading-snapshot' ||
          typeof message.id !== 'number' || !Number.isFinite(message.id) || !process.connected) return
      const snapshot = {
        type: 'hyperplayer-loading-snapshot', id: message.id, at: Date.now(),
        cpu: numericFields(process.cpuUsage(), ['user', 'system']),
        memory: numericFields(process.memoryUsage(), ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']),
        resource: numericFields(process.resourceUsage(), ['userCPUTime', 'systemCPUTime', 'maxRSS']),
      }
      // 父进程可能在采样与 send 之间退出，诊断 IPC 故障不能打断后端业务。
      try { process.send(snapshot, () => {}) } catch { /* IPC 已断开 */ }
    })
  }

  // 观察 undici 的实际请求生命周期（重定向会有多条请求），不触碰 Response。
  channel('undici:request:create').subscribe(({ request }) => {
    const url = safeUrl(request.origin + request.path)
    if (external(url)) undiciRequests.set(request, { finish: begin('fetch', classify(url), fixtureMode, fixtureMode), status: null })
  })
  channel('undici:request:headers').subscribe(({ request, response }) => {
    const entry = undiciRequests.get(request)
    if (entry) entry.status = response.statusCode
  })
  channel('undici:request:trailers').subscribe(({ request }) => {
    const entry = undiciRequests.get(request)
    if (entry) { entry.finish(entry.status, outcomeForStatus(entry.status)); undiciRequests.delete(request) }
  })
  channel('undici:request:error').subscribe(({ request, error }) => {
    const entry = undiciRequests.get(request)
    if (entry) { entry.finish(entry.status, isCancelled(error) ? 'cancelled' : 'failed'); undiciRequests.delete(request) }
  })

  function observeRequest(req, transport, url, fixture = false, fixtureMiss = false) {
    if (observedRequests.has(req)) return req
    observedRequests.add(req)
    const finish = begin(transport, classify(url), fixture, fixtureMiss)
    const emit = req.emit
    let hasResponse = false, cancelled = false
    const destroy = req.destroy
    req.destroy = function (error) {
      cancelled ||= !error || isCancelled(error)
      return Reflect.apply(destroy, this, [error])
    }
    req.emit = function (event, ...args) {
      if (event === 'response') {
        hasResponse = true
        const response = args[0]
        const responseEmit = response.emit
        const responsePush = response.push
        let encodedBytes = 0
        response.push = function (chunk, ...rest) {
          // 在字符解码之前计数；不加 data listener、不主动 read/resume。
          if (chunk !== null) encodedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, rest[0])
          else finish(response.statusCode, outcomeForStatus(response.statusCode), encodedBytes)
          return Reflect.apply(responsePush, this, [chunk, ...rest])
        }
        response.emit = function (name, ...values) {
          if (name === 'end') finish(response.statusCode, outcomeForStatus(response.statusCode), encodedBytes)
          if (name === 'error' || name === 'aborted' || (name === 'close' && !response.complete)) {
            finish(response.statusCode, cancelled || isCancelled(values[0]) ? 'cancelled' : 'failed', encodedBytes)
          }
          return Reflect.apply(responseEmit, this, [name, ...values])
        }
      }
      if (event === 'abort') { cancelled = true; finish(null, 'cancelled') }
      if (event === 'error') { cancelled ||= isCancelled(args[0]); finish(null, cancelled ? 'cancelled' : 'failed') }
      if (event === 'close' && !hasResponse) finish(null, cancelled || req.destroyed ? 'cancelled' : 'failed')
      return Reflect.apply(emit, this, [event, ...args])
    }
    return req
  }

  // 覆盖绕过 http.request、直接 new ClientRequest 的调用；fixture 下仅失败关闭。
  channel('http.client.request.created').subscribe(({ request }) => {
    if (creatingFixture) return
    const transport = request.protocol === 'https:' ? 'https' : 'http'
    const url = requestUrl([{ protocol: request.protocol, host: request.getHeader('host'), path: request.path }], transport)
    if (external(url)) observeRequest(request, transport, url, fixtureMode, fixtureMode)
  })

  for (const [transport, network] of [['http', http], ['https', https]]) {
    const request = network.request
    const get = network.get
    network.request = function (...args) {
      const url = requestUrl(args, transport)
      if (!external(url)) return Reflect.apply(request, this, args)
      if (fixtureMode) return fixtureHttpRequest(args, transport, url)
      return observeRequest(Reflect.apply(request, this, args), transport, url)
    }
    // Node 的 get 闭包捕获原始 request，必须同时接线。
    network.get = function (...args) {
      const url = requestUrl(args, transport)
      if (!external(url)) return Reflect.apply(get, this, args)
      const req = Reflect.apply(network.request, this, args)
      req.end()
      return req
    }
  }
  syncBuiltinESMExports()

  function fixtureHttpRequest(args, transport, url) {
    const { Duplex } = require('node:stream')
    const fixtures = require('./loading-fixtures.cjs')
    const controller = new AbortController()
    let timeout
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback() },
      destroy(error, callback) { clearTimeout(timeout); controller.abort(); callback(error) },
    })
    socket.setNoDelay = socket.setKeepAlive = socket.ref = socket.unref = function () { return this }
    socket.setTimeout = function (ms, callback) {
      clearTimeout(timeout)
      if (callback) this.once('timeout', callback)
      if (ms > 0) timeout = setTimeout(() => this.emit('timeout'), ms)
      return this
    }
    // 使用真实 ClientRequest/HTTP parser，通过内存 socket 替换唯一外部网络边界。
    // 不创建临时 HTTP 服务，不将任何未知请求交给 DNS/真实 socket。
    const agent = new http.Agent({ keepAlive: false })
    agent.protocol = `${transport}:`; agent.defaultPort = transport === 'https' ? 443 : 80
    agent.createConnection = () => socket
    const firstIsUrl = typeof args[0] === 'string' || args[0] instanceof URL
    const suppliedOptions = firstIsUrl ? (typeof args[1] === 'object' ? args[1] : {}) : args[0]
    const callback = args.find(value => typeof value === 'function')
    const options = { ...suppliedOptions, agent }
    const request = transport === 'https' ? originalHttpsRequest : originalHttpRequest
    let req
    creatingFixture++
    try { req = firstIsUrl ? request(args[0], options, callback) : request(options, callback) }
    finally { creatingFixture-- }
    const chunks = []
    let bodySize = 0, finish, cancelled = false
    const appendBody = (chunk, encoding) => {
      if (typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined)
      bodySize += buffer.length
      if (bodySize <= 1024 * 1024) chunks.push(buffer)
    }
    const write = req.write, end = req.end, emit = req.emit
    const destroy = req.destroy
    req.destroy = function (error) { cancelled ||= !error || isCancelled(error); return Reflect.apply(destroy, this, [error]) }
    req.write = function (chunk, ...rest) { appendBody(chunk, rest[0]); return Reflect.apply(write, this, [chunk, ...rest]) }
    req.end = function (chunk, ...rest) { appendBody(chunk, rest[0]); return Reflect.apply(end, this, [chunk, ...rest]) }
    req.emit = function (event, ...values) {
      if (event === 'error' || event === 'abort' || event === 'close') {
        clearTimeout(timeout)
        if (!finish) finish = begin(transport, classify(url), true, false)
        finish(null, cancelled || event === 'abort' || isCancelled(values[0]) || event === 'close' ? 'cancelled' : 'failed')
      }
      return Reflect.apply(emit, this, [event, ...values])
    }
    req.once('finish', () => {
      const resolved = bodySize > 1024 * 1024 ? null : fixtures.resolveHttpFixture(url, {
        method: req.method, body: Buffer.concat(chunks).toString('utf8'),
      })
      const fixture = rangedFixture(resolved, req.getHeader('range'))
      finish = begin(transport, classify(url), true, !resolved)
      ;(async () => {
        await delay(latencyMs, controller.signal)
        if (req.destroyed) return
        const lines = [`HTTP/1.1 ${fixture.status} ${http.STATUS_CODES[fixture.status] || 'Unknown'}`,
          'connection: close', ...Object.entries(fixture.headers).map(([key, value]) => `${key}: ${value}`), '', '']
        socket.push(Buffer.from(lines.join('\r\n')))
        const body = req.method === 'HEAD' ? Buffer.alloc(0) : fixture.body
        for (let index = 0; index < body.length; index += 16384) {
          const chunk = body.subarray(index, index + 16384)
          if (bytesPerSecond) await delay(Math.ceil(chunk.length / bytesPerSecond * 1000), controller.signal)
          if (req.destroyed) return
          socket.push(chunk)
        }
        clearTimeout(timeout)
        finish(fixture.status, outcomeForStatus(fixture.status), body.length)
        socket.push(null)
      })().catch(error => { finish(null, isCancelled(error) || controller.signal.aborted ? 'cancelled' : 'failed'); if (!req.destroyed) req.destroy(error) })
    })
    return req
  }

  // 只替换第三方包的公开入口；填充 CJS cache 同时支持 require 与 ESM default import。
  if (fixtureMode) {
    const Module = require('node:module')
    const fixtures = require('./loading-fixtures.cjs')
    // 最后一道网络边界：阻断原生 fetch 跟随本地重定向、直接 ClientRequest 等旁路。
    // 已覆盖的 fixture 走内存 socket，不经过此处；旁路报告 unknown failure 而非假成功。
    const { Socket } = require('node:net')
    const connect = Socket.prototype.connect
    Socket.prototype.connect = function (...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0]
      const options = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' }
      if (!options.path) {
        const host = options.host || options.hostname || 'localhost'
        const url = safeUrl(`http://${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${options.port || 80}/`)
        if (!isLoopback(host) || external(url)) {
          // ClientRequest 的 socket 监听器在 nextTick 接线，错误必须在其后送达。
          this.connecting = true
          queueMicrotask(() => this.destroy(fixtures.unknownError()))
          return this
        }
      }
      return Reflect.apply(connect, this, args)
    }
    const invoke = async (platform, route, value) => {
      const miss = value === null
      const finish = begin('sdk-fixture', { platform, route, category: 'api' }, true, miss)
      const size = miss || value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))
      await delay(latencyMs + (bytesPerSecond ? Math.ceil(size / bytesPerSecond * 1000) : 0))
      finish(miss ? 501 : 200, miss ? 'http-error' : 'success')
      if (miss) throw fixtures.unknownError()
      return value
    }
    for (const [specifier, exports] of [
      ['@neteasecloudmusicapienhanced/api', fixtures.createNeteaseApi(invoke)],
      ['qq-music-api', fixtures.createQqMusicApi(invoke)],
      ['@neteasecloudmusicapienhanced/api/generateConfig.js', () => invoke('netease', 'account', undefined)],
    ]) {
      const filename = require.resolve(specifier)
      const entry = new Module(filename)
      entry.filename = filename; entry.loaded = true; entry.exports = exports
      require.cache[filename] = entry
    }

    const fetch = globalThis.fetch
    globalThis.fetch = async function (input, init) {
      const url = safeUrl(input instanceof Request ? input.url : String(input))
      if (!external(url)) return Reflect.apply(fetch, this, [input, init])
      const request = new Request(input, init)
      const body = request.body ? await request.text() : undefined
      const resolved = fixtures.resolveHttpFixture(url, { method: request.method, body })
      const fixture = rangedFixture(resolved, request.headers.get('range'))
      const finish = begin('fetch', classify(url), true, !resolved)
      const throttle = new AbortController()
      const signal = AbortSignal.any([request.signal, throttle.signal])
      let encodedBytes = 0, cancelled = false
      const cancel = () => { cancelled = true; throttle.abort(); finish(fixture.status, 'cancelled', encodedBytes) }
      const onAbort = () => { cancel(); streamController?.error(request.signal.reason); cleanup() }
      const cleanup = () => request.signal.removeEventListener('abort', onAbort)
      let streamController
      request.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await delay(latencyMs, signal)
        const noBody = request.method === 'HEAD' || [204, 304].includes(fixture.status)
        if (noBody) {
          cleanup(); finish(fixture.status, outcomeForStatus(fixture.status), 0)
          return new Response(null, { status: fixture.status, headers: fixture.headers })
        }
        const stream = new ReadableStream({
          start(controller) { streamController = controller },
          async pull(controller) {
            try {
              if (cancelled) return
              const end = Math.min(encodedBytes + 16384, fixture.body.length)
              const chunk = fixture.body.subarray(encodedBytes, end)
              if (bytesPerSecond) await delay(Math.ceil(chunk.length / bytesPerSecond * 1000), signal)
              if (cancelled) return
              encodedBytes = end
              if (chunk.length) controller.enqueue(new Uint8Array(chunk))
              if (end === fixture.body.length) {
                cleanup(); controller.close(); finish(fixture.status, outcomeForStatus(fixture.status), encodedBytes)
              }
            } catch (error) {
              cleanup(); finish(fixture.status, isCancelled(error) ? 'cancelled' : 'failed', encodedBytes)
              if (!cancelled) controller.error(error)
            }
          },
          cancel() { cancel(); cleanup() },
        })
        return new Response(stream, { status: fixture.status, headers: fixture.headers })
      } catch (error) {
        cleanup(); finish(null, isCancelled(error) ? 'cancelled' : 'failed')
        throw error
      }
    }
  }
}

function setting(key) {
  const value = Number(process.env[key])
  return Number.isFinite(value) && value > 0 ? value : 0
}
function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
function rangedFixture(resolved, range) {
  const value = resolved || { status: 501, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"code":"HYPERPLAYER_FIXTURE_UNKNOWN"}') }
  let { body, status, headers } = value
  headers = { ...headers, 'content-length': String(body.length), 'accept-ranges': 'bytes' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || '')
  if (match && status === 200) {
    const start = match[1] ? Number(match[1]) : Math.max(0, body.length - Number(match[2]))
    const end = match[1] && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1
    if (start > end || start >= body.length) return { status: 416, headers: { 'content-range': `bytes */${body.length}`, 'content-length': '0' }, body: Buffer.alloc(0) }
    headers['content-range'] = `bytes ${start}-${end}/${body.length}`
    body = body.subarray(start, end + 1); status = 206
    headers['content-length'] = String(body.length)
  }
  return { body, status, headers }
}

function safeUrl(value) { try { return new URL(value) } catch { return null } }
function isLoopback(host) {
  const address = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (address === 'localhost') return true
  const family = require('node:net').isIP(address)
  if (family === 4) return address.split('.')[0] === '127'
  if (family !== 6) return false
  // URL 将完整 IPv6 和 dotted IPv4-mapped 地址归一化为压缩十六进制格式。
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  if (canonical === '::1') return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  return Boolean(mapped && (parseInt(mapped[1], 16) >>> 8) === 127)
}
function numericFields(value, keys) {
  return Object.fromEntries(keys.filter(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
    .map(key => [key, value[key]]))
}
function requestUrl(args, transport) {
  const first = args[0]
  const suppliedUrl = typeof first === 'string' || first instanceof URL ? safeUrl(String(first)) : null
  const options = suppliedUrl ? (typeof args[1] === 'object' ? args[1] : {}) : (first || {})
  // axios 可能通过本机 HTTP proxy 发送 absolute-form；分类针对上游而非代理地址。
  if (typeof options.path === 'string' && /^https?:\/\//.test(options.path)) return safeUrl(options.path)
  const protocol = options.protocol || suppliedUrl?.protocol || `${transport}:`
  const host = options.hostname || options.host || suppliedUrl?.hostname || 'localhost'
  const bracketed = host.includes(':') && !host.startsWith('[') && !host.match(/:\d+$/) ? `[${host}]` : host
  const port = options.port || suppliedUrl?.port
  return safeUrl(`${protocol}//${bracketed}${port ? ':' + port : ''}${options.path || (suppliedUrl ? suppliedUrl.pathname + suppliedUrl.search : '/')}`)
}
function outcomeForStatus(status) { return status >= 400 ? 'http-error' : 'success' }
function isCancelled(error) {
  return ['AbortError', 'TimeoutError'].includes(error?.name) || ['ABORT_ERR', 'UND_ERR_ABORTED'].includes(error?.code)
}

// 只有常量分类可进入日志；未知 path/id/query 不做截断或散列后输出。
function classify(url) {
  const host = url?.hostname || ''
  const platform = /(^|\.)music\.163\.com$/.test(host) ? 'netease' :
    /(^|\.)(y\.qq\.com|qqmusic\.qq\.com)$/.test(host) ? 'qq' :
      /(^|\.)(bilibili\.com|bilivideo\.com)$/.test(host) ? 'bilibili' : 'unknown'
  const pathname = url?.pathname || ''
  const prefix = platform === 'bilibili' ? 'bilibili-' : ''
  let route = 'unknown', category = platform === 'unknown' ? 'unknown' : 'api'
  if (platform !== 'unknown') {
    if (/search/.test(pathname)) route = prefix + 'search'
    else if (/playlist|songlist|ucc_getcdinfo/.test(pathname)) route = 'playlist'
    else if (/artist|singer/.test(pathname)) route = 'artist'
    else if (/album/.test(pathname)) route = 'album'
    else if (/lyric/.test(pathname)) route = 'lyrics'
    else if (/song\/detail/.test(pathname)) route = 'song-detail'
    else if (/song.*url/.test(pathname)) route = 'song-url'
    else if (/recommend|personalized|toplist/.test(pathname)) route = 'recommendation'
    else if (/login|user|account|nav|finger/.test(pathname)) route = platform === 'bilibili' ? 'bilibili-account' : 'account'
    else if (/playurl/.test(pathname)) route = 'bilibili-playurl'
    else if (/\/view$/.test(pathname)) route = 'bilibili-view'
    else if (/subtitle|\/player\//.test(pathname)) route = 'bilibili-subtitle'
  }
  if (/\.(svg|png|jpg|jpeg|webp)$/i.test(pathname) || /(^|\.)(gtimg\.cn|music\.126\.net)$/.test(host)) {
    route = 'image'; category = 'image'
  }
  if (/\.(wav|mp3|m4a|mp4|flac|m4s)$/i.test(pathname) || /(^|\.)bilivideo\.com$/.test(host)) {
    route = 'media'; category = 'media'
  }
  return { platform, route, category }
}
