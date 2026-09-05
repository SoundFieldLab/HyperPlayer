// HyperPlayer adaptations: 浏览器传输层（axios → infra tauriHttp）。
// 通过 setBrowserHttpTransport 注入真实传输（app 侧 wiring 用 tauriHttp 适配），
// 单测注入 fake 传输回放响应。保持 axios-like 接口（data/headers/status），
// 使 vendored request.js / register_checktoken_* 无需改动调用语义。
'use strict'

let transport = null

/** @param {{ fetch(url: string, opts?: object): Promise<{status:number;headers:Record<string,string>;body:ReadableStream<Uint8Array>}> }} t */
function setBrowserHttpTransport(t) {
  transport = t
}

async function readAllBytes(stream) {
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function normalizeHeaders(headers) {
  const normalized = {}
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[key.toLowerCase()] = value
  }
  return normalized
}

/**
 * axios-like 调用入口：{ method, url, headers, data, timeout, responseType }
 * → { data, headers, status }（data 为解析后对象或 Uint8Array）。
 */
async function browserHttp(options = {}) {
  if (!transport) throw new Error('browserHttp: transport not injected (HyperPlayer wiring)')
  const method = options.method || 'GET'
  const headers = { ...(options.headers || {}) }
  const timeoutMs = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : undefined
  const response = await transport.fetch(options.url, {
    method,
    headers,
    body: options.data,
    timeoutMs,
  })
  const responseHeaders = normalizeHeaders(response.headers)
  const setCookie = responseHeaders['set-cookie']
  const body = await readAllBytes(response.body)
  let data
  if (options.responseType === 'arraybuffer') {
    data = body
  } else {
    const text = new TextDecoder().decode(body)
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = text
    }
  }
  return {
    data,
    headers: {
      ...responseHeaders,
      'set-cookie': setCookie ? (Array.isArray(setCookie) ? setCookie : [setCookie]) : [],
    },
    status: response.status,
  }
}

browserHttp.get = (url, opts = {}) => browserHttp({ ...opts, method: 'GET', url })

browserHttp.post = (url, data, opts = {}) => browserHttp({ ...opts, method: 'POST', url, data })

module.exports = browserHttp
module.exports.default = browserHttp
module.exports.setBrowserHttpTransport = setBrowserHttpTransport
module.exports.bytesToBase64 = bytesToBase64
