/**
 * 会话状态：设备 id、xeapi 公钥、会话密钥、匿名 token。
 * 惰性初始化：首次网络调用前自动完成「取公钥 → 匿名注册」。
 */
import { createHash } from 'node:crypto'
import { DOMAIN_API, ID_XOR_KEY, XEAPI_APP_VERSION, XEAPI_OS } from './config'
import { decryptXeapiPublicKey, xeapiSign, type XeapiPublicKeyState } from './crypto'

/** 52 位大写十六进制设备 id */
function generateDeviceId(): string {
  const hexChars = '0123456789ABCDEF'
  let out = ''
  for (let i = 0; i < 52; i += 1) out += hexChars[Math.floor(Math.random() * hexChars.length)]
  return out
}

/** 设备指纹：与固定键 XOR 后取 MD5-base64（匿名注册用） */
function dllEncodeId(deviceId: string): string {
  let xored = ''
  for (let i = 0; i < deviceId.length; i += 1) {
    xored += String.fromCharCode(deviceId.charCodeAt(i) ^ ID_XOR_KEY.charCodeAt(i % ID_XOR_KEY.length))
  }
  return createHash('md5').update(xored, 'utf8').digest('base64')
}

interface SessionState {
  deviceId: string
  publicKey: XeapiPublicKeyState | null
  /** xeapi 会话（响应头 x-encr-ssid / x-encr-sskey 下发） */
  sessionId: string
  sessionKey: string
  /** 游客 MUSIC_A（匿名注册下发），无登录 cookie 时兜底 */
  anonymousToken: string
  bootstrapPromise: Promise<void> | null
}

const session: SessionState = {
  deviceId: generateDeviceId(),
  publicKey: null,
  sessionId: '',
  sessionKey: '',
  anonymousToken: '',
  bootstrapPromise: null,
}

async function postFormRaw(url: string, fields: Record<string, string>, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', ...headers },
    body: new URLSearchParams(fields).toString(),
  })
  return (await response.json()) as unknown
}

/** 向反作弊端点请求 xeapi 公钥（明文请求 + HMAC 签名自校验） */
async function fetchXeapiPublicKey(): Promise<XeapiPublicKeyState> {
  const nonce = randomDigits(16)
  const timestamp = String(Date.now())
  const fields: Record<string, string> = {
    appVersion: XEAPI_APP_VERSION,
    currentKeyVersion: session.publicKey?.version ?? '',
    deviceId: session.deviceId,
    nonce,
    os: XEAPI_OS,
    requestType: 'active',
    signature: xeapiSign(timestamp, nonce),
    t1: '',
    t2: '',
    timestamp,
    uid: '',
  }
  const body = (await postFormRaw(`${DOMAIN_API}/api/gorilla/anti/crawler/security/key/get`, fields, {
    'User-Agent': `NeteaseMusic/${XEAPI_APP_VERSION}.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)`,
    Cookie: `deviceId=${encodeURIComponent(session.deviceId)}`,
  })) as { code?: number; data?: { encryptedData?: string; signature?: string; timestamp?: string } }

  const encrypted = body.data?.encryptedData
  if (body.code !== 200 || !encrypted) throw new Error('xeapi 公钥下发失败')
  if (body.data?.signature !== xeapiSign(String(body.data?.timestamp ?? ''), nonce)) {
    throw new Error('xeapi 公钥响应签名不匹配')
  }
  const keyState = decryptXeapiPublicKey(encrypted)
  if (!keyState.sk) throw new Error('xeapi 公钥缺失 sk')
  return keyState
}

function randomDigits(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String(Math.floor(Math.random() * 10))
  return out
}

/** 一次性引导：取 xeapi 公钥 → 匿名注册拿游客 token（失败不致命，逐项降级） */
async function bootstrap(): Promise<void> {
  try {
    session.publicKey = await fetchXeapiPublicKey()
  } catch (error) {
    console.warn('[netease session] xeapi 公钥获取失败:', error instanceof Error ? error.message : error)
  }
}

export function ensureSession(): Promise<void> {
  if (!session.bootstrapPromise) {
    session.bootstrapPromise = bootstrap()
  }
  return session.bootstrapPromise
}

export function getDeviceId(): string {
  return session.deviceId
}

export function getXeapiPublicKeyState(): XeapiPublicKeyState {
  if (!session.publicKey) throw new Error('xeapi 公钥未初始化')
  return session.publicKey
}

export function getXeapiSession(): { sessionId: string; sessionKey: string } {
  return { sessionId: session.sessionId, sessionKey: session.sessionKey }
}

export function updateXeapiSession(sessionId: string, sessionKey: string): void {
  if (sessionId) session.sessionId = sessionId
  if (sessionKey) session.sessionKey = sessionKey
}

export function getAnonymousToken(): string {
  return session.anonymousToken
}

export function setAnonymousToken(token: string): void {
  if (token) session.anonymousToken = token
}

export function getEncodedAnonymousUsername(): string {
  const fingerprint = dllEncodeId(session.deviceId)
  return Buffer.from(`${session.deviceId} ${fingerprint}`, 'utf8').toString('base64')
}
