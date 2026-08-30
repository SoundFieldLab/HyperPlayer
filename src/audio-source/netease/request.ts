/**
 * 请求层：weapi / eapi（默认加密）/ xeapi 三通道 + 设备 cookie 信封 + 会话引导。
 * 用户登录态 cookie 由调用方每次传入，本层不持久化。
 */
import {
  DEVICE_APPVER,
  DEVICE_CHANNEL,
  DEVICE_OS,
  DEVICE_OSVER,
  DOMAIN_CLIENTLOG,
  DOMAIN_EAPI,
  DOMAIN_XEAPI,
  SPECIAL_OK_CODES,
  USER_AGENT_ANDROID,
  USER_AGENT_IOS,
  XEAPI_APP_VERSION,
  XEAPI_OS,
  XEAPI_OSVER,
} from './config'
import { encryptEapi, encryptWeapi, encryptXeapi, decryptXeapiResponse } from './crypto'
import {
  ensureSession,
  getAnonymousToken,
  getDeviceId,
  getEncodedAnonymousUsername,
  getXeapiPublicKeyState,
  getXeapiSession,
  setAnonymousToken,
  updateXeapiSession,
} from './session'

export class NeteaseApiError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'NeteaseApiError'
    this.code = code
  }
}

export interface CallOptions {
  /** 用户登录态，如 `MUSIC_U=...; __csrf=...` */
  cookie?: string
  /** 单次请求超时毫秒 */
  timeoutMs?: number
  /** 覆盖 eapi 域名（clientlog 打点用） */
  domain?: string
  /** 附带易盾 antiCheatToken（v2） */
  checkToken?: 'v2'
}

/* --------------------------------- cookie --------------------------------- */

type CookieObj = Record<string, string>

function parseCookie(cookie: string | undefined): CookieObj {
  const obj: CookieObj = {}
  for (const part of (cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    obj[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return obj
}

function serializeCookie(obj: CookieObj): string {
  return Object.entries(obj)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('; ')
}

function randomHex(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += '0123456789abcdef'[Math.floor(Math.random() * 16)]
  return out
}

/** 设备 cookie 信封：用户 cookie + 设备画像 + 匿名 token 兜底 */
function buildDeviceCookie(userCookie: string | undefined, eapiPath: string): CookieObj {
  const base = parseCookie(userCookie)
  const nuid = base._ntes_nuid || randomHex(32)
  const merged: CookieObj = {
    ...base,
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: nuid,
    _ntes_nnid: `${nuid},${Date.now()}`,
    WNMCID: base.WNMCID || `${randomHex(6)}.${Date.now()}.01.0`,
    WEVNSM: base.WEVNSM || '1.0.0',
    osver: base.osver || DEVICE_OSVER,
    os: base.os || DEVICE_OS,
    channel: base.channel || DEVICE_CHANNEL,
    appver: base.appver || DEVICE_APPVER,
    deviceId: base.deviceId || getDeviceId(),
  }
  if (!eapiPath.includes('login')) merged.NMTID = base.NMTID || randomHex(16)
  if (!merged.MUSIC_U) merged.MUSIC_A = merged.MUSIC_A || getAnonymousToken()
  return merged
}

function buildEapiDeviceHeader(cookieObj: CookieObj): CookieObj {
  const header: CookieObj = {
    osver: cookieObj.osver ?? DEVICE_OSVER,
    deviceId: cookieObj.deviceId ?? getDeviceId(),
    os: cookieObj.os ?? DEVICE_OS,
    appver: cookieObj.appver ?? DEVICE_APPVER,
    versioncode: '140',
    mobilename: '',
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: '1920x1080',
    __csrf: cookieObj.__csrf ?? '',
    channel: cookieObj.channel ?? DEVICE_CHANNEL,
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
  }
  if (cookieObj.MUSIC_U) header.MUSIC_U = cookieObj.MUSIC_U
  if (cookieObj.MUSIC_A) header.MUSIC_A = cookieObj.MUSIC_A
  return header
}

/* --------------------------------- 通道实现 -------------------------------- */

interface NeteaseEnvelope {
  code?: number | string
  [key: string]: unknown
}

function isOkCode(code: number): boolean {
  return code === 200 || SPECIAL_OK_CODES.has(code)
}

/** 外层 URL 路径：剥掉接口路径的 /api 前缀（/weapi/v1/...、/eapi/v3/...、/xeapi/v1/...）；eapi 摘要仍用完整路径 */
function outerPath(path: string): string {
  return path.replace(/^\/api/, '')
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ body: unknown; setCookie: string[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    })
    if (!response.ok) throw new NeteaseApiError(`HTTP ${response.status}`, response.status)
    const body = (await response.json()) as unknown
    const setCookie = response.headers.getSetCookie?.() ?? []
    return { body, setCookie: setCookie.map((item) => item.replace(/\s*Domain=[^(;|$)]+;*/, '')) }
  } finally {
    clearTimeout(timer)
  }
}

function assertOk(body: NeteaseEnvelope): void {
  const code = Number(body.code ?? 0)
  if (code !== 0 && !isOkCode(code)) {
    throw new NeteaseApiError(`网易云接口返回 code=${body.code}`, code)
  }
}

/**
 * weapi 语义端点的实际通道：**统一走 eapi**（协议库默认加密即 eapi，服务端 /api/* 路径
 * 全量兼容；weapi 加密通道经 undici fetch 实测被服务端 WAF 空响应拒绝，详见行为规范 §7）。
 */
export async function callWeapi<T>(path: string, payload: object, options: CallOptions = {}): Promise<T> {
  return callEapi<T>(path, payload, options)
}

/** 原始响应变体（登录二维码轮询等语义码端点） */
export async function callWeapiRaw<T>(path: string, payload: object, options: CallOptions = {}): Promise<T> {
  return callEapiRaw<T>(path, payload, options)
}

/** eapi 通道（协议默认加密）：interfacepc.music.163.com/eapi */
export async function callEapi<T>(path: string, payload: object, options: CallOptions = {}): Promise<T> {
  const body = await callEapiRaw<T>(path, payload, options)
  assertOk(body as NeteaseEnvelope)
  return body
}

export async function callEapiRaw<T>(path: string, payload: object, options: CallOptions = {}): Promise<T> {
  await ensureNetworkReady()
  const cookieObj = buildDeviceCookie(options.cookie, path)
  const header = buildEapiDeviceHeader(cookieObj)
  const payloadJson = JSON.stringify({ ...payload, header })
  const params = encryptEapi(path, payloadJson)
  const { body } = await postForm(
    `${options.domain ?? DOMAIN_EAPI}/eapi${outerPath(path)}`,
    { params },
    {
      'User-Agent': USER_AGENT_IOS,
      Cookie: serializeCookie(header),
      ...(options.checkToken ? { 'X-antiCheatToken': await getAntiCheatTokenV2() } : {}),
    },
    options.timeoutMs ?? 12_000,
  )
  return body as T
}

/** 网络就绪：公钥获取 + 匿名注册（各一次，惰性） */
let anonymousReady = false

export async function ensureNetworkReady(): Promise<void> {
  await ensureSession()
  if (!anonymousReady && !getAnonymousToken()) {
    anonymousReady = true
    await registerAnonymous()
  }
}

/** xeapi 通道（安卓加密，播放地址等关键端点）：interface3.music.163.com/xeapi */
export async function callXeapi<T>(path: string, payload: object, options: CallOptions = {}): Promise<T> {
  const body = await callXeapiRaw<T>(path, payload, options)
  assertOk(body as NeteaseEnvelope)
  return body
}

/** xeapi 原始响应（不校验 code；匿名注册等） */
export async function callXeapiRaw<T>(path: string, payload: object, options: CallOptions = {}): Promise<T> {
  await ensureNetworkReady()
  return callXeapiRawInternal<T>(path, payload, options)
}

async function callXeapiRawInternal<T>(path: string, payload: object, options: CallOptions = {}): Promise<T & { setCookie?: string[] }> {
  await ensureSession()
  const keyState = getXeapiPublicKeyState()
  const sessionState = getXeapiSession()
  const userCookie = parseCookie(options.cookie)

  const fields = encryptXeapi(payload as Record<string, unknown>, keyState, {
    sessionKey: sessionState.sessionKey || undefined,
    sessionId: sessionState.sessionId || undefined,
    os: XEAPI_OS,
  })
  const cookieObj: CookieObj = {
    os: XEAPI_OS,
    osver: XEAPI_OSVER,
    appver: XEAPI_APP_VERSION,
    buildver: String(Math.floor(Date.now() / 1000)),
    deviceId: getDeviceId(),
    sDeviceId: getDeviceId(),
    ...(userCookie.MUSIC_U ? { MUSIC_U: userCookie.MUSIC_U } : {}),
  }
  // 补全设备画像（匿名 token 在 xeapi 通道不注入，避免鸡生蛋）
  Object.assign(cookieObj, buildDeviceCookie('', path), {
    os: XEAPI_OS,
    osver: XEAPI_OSVER,
    appver: XEAPI_APP_VERSION,
    buildver: String(Math.floor(Date.now() / 1000)),
    deviceId: getDeviceId(),
    sDeviceId: getDeviceId(),
  })
  delete cookieObj.MUSIC_A
  if (userCookie.MUSIC_U) cookieObj.MUSIC_U = userCookie.MUSIC_U
  const response = await fetch(`${DOMAIN_XEAPI}/xeapi${outerPath(path)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'User-Agent': USER_AGENT_ANDROID,
      'X-Client-Enc-State': 'ENCRYPTED',
      'x-aeapi': 'true',
      'x-deviceid': getDeviceId(),
      'x-os': XEAPI_OS,
      'x-osver': XEAPI_OSVER,
      'x-appver': XEAPI_APP_VERSION,
      'x-sdeviceid': getDeviceId(),
      'x-buildver': String(Math.floor(Date.now() / 1000)),
      ...(userCookie.MUSIC_U ? { 'x-music-u': userCookie.MUSIC_U } : {}),
      Cookie: serializeCookie(cookieObj),
    },
    body: new URLSearchParams(fields).toString(),
  })
  const newSessionId = response.headers.get('x-encr-ssid') ?? ''
  const newSessionKey = response.headers.get('x-encr-sskey') ?? ''

  const rawBody = Buffer.from(await response.arrayBuffer())
  updateXeapiSession(newSessionId, newSessionKey)
  const setCookie = response.headers.getSetCookie?.() ?? []
  const body = decryptXeapiResponse(rawBody) as T & { setCookie?: string[] }
  return Object.assign(body, { setCookie: setCookie.map((item) => item.replace(/\s*Domain=[^(;|$)]+;*/, '')) })
}

/** 匿名注册（xeapi）：拿游客 MUSIC_A token（走内部通道避免 ensure 递归） */
export async function registerAnonymous(): Promise<void> {
  if (getAnonymousToken()) return
  try {
    const response = await callXeapiRawInternal<{ cookie?: string[] }>('/api/register/anonimous', {
      username: getEncodedAnonymousUsername(),
    })
    const cookie = (response.setCookie ?? response.cookie ?? []).join(';')
    const token = parseCookie(cookie).MUSIC_A
    if (token) setAnonymousToken(token)
  } catch (error) {
    console.warn('[netease session] 匿名注册失败:', error instanceof Error ? error.message : error)
  }
}

/* ------------------------------ 防作弊 token ------------------------------ */

let antiCheatTokenV2Cache = ''
let antiCheatTokenV2Promise: Promise<string> | null = null

async function getAntiCheatTokenV2(): Promise<string> {
  if (antiCheatTokenV2Cache) return antiCheatTokenV2Cache
  if (!antiCheatTokenV2Promise) {
    antiCheatTokenV2Promise = (async () => {
      // 易盾配置端点：返回 result.conf 作为 token
      const response = await fetch('https://dun.163.com/v2/config/js?pn=YD00000558929251', {
        signal: AbortSignal.timeout(10_000),
      })
      const data = (await response.json()) as { code?: number; result?: { conf?: string } }
      const token = data?.result?.conf ?? ''
      if (!token) throw new Error('易盾 token 获取失败')
      antiCheatTokenV2Cache = token
      return token
    })().catch((error) => {
      antiCheatTokenV2Promise = null
      throw error
    })
  }
  return antiCheatTokenV2Promise
}

/* --------------------------------- 重试 --------------------------------- */

/** 带退避重试（500ms×次数递增，参考项目通用策略） */
export async function withRetry<T>(task: (attempt: number) => Promise<T>, retries = 3, delayStepMs = 500): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await task(attempt)
    } catch (error) {
      lastError = error
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayStepMs * (attempt + 1)))
      }
    }
  }
  throw lastError
}

/** 客户端日志打点域名（听歌打卡用） */
export const CLIENTLOG_DOMAIN = DOMAIN_CLIENTLOG
