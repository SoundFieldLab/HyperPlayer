// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— axios 浏览器 shim。
// 协议包 util/request.js 与若干 module 直接以 axios 形状调用；此处用
// tauri-plugin-http（Rust 哑管道，绕 CORS）实现等价语义：
// - axios(config) 与 axios.get(url, config)
// - 响应形状 { data, status, statusText, headers }（headers['set-cookie'] 为数组）
// - responseType: 'arraybuffer' 时 data 为 Buffer（对齐 Node axios 的 toString('hex')）
// 忽略 agent/proxy（浏览器端无意义）。

import { Buffer } from 'buffer'
import { fetch } from '@tauri-apps/plugin-http'

interface AxiosConfig {
  method?: string
  url?: string
  headers?: Record<string, string>
  data?: string | URLSearchParams | null
  responseType?: 'arraybuffer' | 'json' | 'text'
  timeout?: number
  proxy?: unknown
  httpAgent?: unknown
  httpsAgent?: unknown
  encoding?: unknown
}

interface AxiosResponse {
  data: unknown
  status: number
  statusText: string
  headers: Record<string, string | string[]>
}

function normalizeHeaders(headers: Headers): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'set-cookie') {
      // 多值 set-cookie 保真：优先 getSetCookie()，否则逗号分隔
      const setCookie =
        typeof headers.getSetCookie === 'function'
          ? headers.getSetCookie()
          : value.split(/,(?=[^;=]+=)/)
      result[lower] = setCookie
    } else {
      result[lower] = value
    }
  })
  return result
}

async function perform(config: AxiosConfig): Promise<AxiosResponse> {
  const method = (config.method ?? 'get').toUpperCase()
  const url = config.url ?? ''
  const init: RequestInit & Record<string, unknown> = {
    method,
    headers: config.headers ? new Headers(config.headers) : undefined,
  }
  if (config.data != null) {
    init.body = String(config.data)
  }
  if (typeof config.timeout === 'number' && config.timeout > 0) {
    init.connectTimeout = config.timeout
  }

  const response = await fetch(url, init)
  const headers = normalizeHeaders(response.headers)

  let data: unknown
  if (config.responseType === 'arraybuffer') {
    data = Buffer.from(await response.arrayBuffer())
  } else {
    const text = await response.text()
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    } else {
      data = ''
    }
  }

  return { data, status: response.status, statusText: response.statusText, headers }
}

function axiosShim(config: AxiosConfig): Promise<AxiosResponse> {
  return perform(config)
}

axiosShim.get = (url: string, config: AxiosConfig = {}): Promise<AxiosResponse> =>
  perform({ ...config, url, method: 'get' })
axiosShim.post = (url: string, data?: string | URLSearchParams, config: AxiosConfig = {}): Promise<AxiosResponse> =>
  perform({ ...config, url, method: 'post', data })

export default axiosShim
