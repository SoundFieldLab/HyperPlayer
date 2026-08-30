/**
 * 网易云协议加密族：weapi / eapi / xeapi（安卓端）+ xeapi 公钥解密。
 * 仅依赖 node:crypto。
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  publicEncrypt,
} from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import {
  EAPI_KEY,
  RSA_WEAPI_BLOCK_SIZE,
  RSA_WEAPI_PUBLIC_KEY_PEM,
  WEAPI_IV,
  WEAPI_PRESET_KEY,
  WEAPI_SECRET_POOL,
  X25519_SPKI_PREFIX_HEX,
  XEAPI_SIGN_KEY_BASE64,
  XEAPI_STATIC_KEY_HEX,
} from './config'

function aesCbcBase64(plaintext: string, key: string | Buffer, iv: string | Buffer): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv))
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
}

function aesEcbEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function aesEcbDecrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * RSA 无填充（weapi encSecKey）：明文（反转后的 16 字节 secret）左零填充至 128 字节
 * 后做原生 RSA_NO_PADDING，输出 128 字节 hex 大写。已与 forge NONE 逐字节比对等价。
 */
function rsaNoPad(data: Buffer): Buffer {
  const reversed = Buffer.from(data)
  reversed.reverse()
  const padded = Buffer.alloc(RSA_WEAPI_BLOCK_SIZE)
  reversed.copy(padded, RSA_WEAPI_BLOCK_SIZE - reversed.length)
  return publicEncrypt(
    { key: createPublicKey(RSA_WEAPI_PUBLIC_KEY_PEM), padding: constants.RSA_NO_PADDING },
    padded,
  )
}

function randomSecret(length: number, pool: string): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += pool[Math.floor(Math.random() * pool.length)]
  return out
}

/** weapi 表单字段：params（双层 AES-CBC）+ encSecKey（RSA） */
export function encryptWeapi(payloadJson: string): { params: string; encSecKey: string } {
  const secret = randomSecret(16, WEAPI_SECRET_POOL)
  const params = aesCbcBase64(aesCbcBase64(payloadJson, WEAPI_PRESET_KEY, WEAPI_IV), secret, WEAPI_IV)
  const encSecKey = rsaNoPad(Buffer.from(secret.split('').reverse().join(''), 'utf8')).toString('hex').toUpperCase()
  return { params, encSecKey }
}

/**
 * eapi 表单字段 params：digest 拼接后 AES-128-ECB，hex 大写。
 * url 为接口路径（如 /api/v3/song/detail），payload 需已含 header 设备信封。
 */
export function encryptEapi(eapiPath: string, payloadJson: string): string {
  const digest = createHash('md5').update(`nobody${eapiPath}use${payloadJson}md5forencrypt`, 'utf8').digest('hex')
  const message = `${eapiPath}-36cd479b6b5-${payloadJson}-36cd479b6b5-${digest}`
  return aesEcbEncrypt(Buffer.from(EAPI_KEY, 'utf8'), Buffer.from(message, 'utf8')).toString('hex').toUpperCase()
}

/* ------------------------------- xeapi（安卓） ------------------------------ */

const XEAPI_STATIC_KEY = Buffer.from(XEAPI_STATIC_KEY_HEX, 'hex')
const XEAPI_SIGN_KEY = Buffer.from(XEAPI_SIGN_KEY_BASE64, 'base64')

/** 反作弊签名：HMAC-SHA256(timestamp+nonce)，base64。密钥为 base64 字面串直接作 UTF-8 密钥（协议原样，勿解码） */
export function xeapiSign(timestamp: string, nonce: string): string {
  return createHmac('sha256', XEAPI_SIGN_KEY_BASE64).update(`${timestamp}${nonce}`).digest('base64')
}

/** 中间变换：随机会话前缀 XOR 后 base64 循环旋转 */
function xeapiMidTransform(ciphertext: Buffer): Buffer {
  const random = globalThis.crypto?.getRandomValues
    ? Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
    : createHash('sha256').update(String(Date.now())).digest().subarray(0, 16)
  const xored = Buffer.alloc(ciphertext.length)
  for (let i = 0; i < ciphertext.length; i += 1) xored[i] = ciphertext[i] ^ random[i & 0x0f]!
  const b64 = Buffer.from(xored.toString('base64'))
  const rotation = b64.length > 0 ? (random[0]! & 0x0f) % b64.length : 0
  return Buffer.concat([random, b64.subarray(rotation), b64.subarray(0, rotation)])
}

/** 会话信封：X25519 ECDH 派生 AES-128-GCM 加密 dynamicKey|os|sk */
function xeapiSessionEnvelope(dynamicKey: Buffer, publicKeyBase64: string, sk: string, os: string): Buffer {
  const peerRaw = Buffer.from(publicKeyBase64, 'base64')
  const peerKey = createX25519PublicKey(peerRaw)
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const ephemeralRaw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(-32)
  const sharedSecret = diffieHellman({ privateKey, publicKey: peerKey })
  const prk = createHmac('sha256', Buffer.alloc(32)).update(sharedSecret.length > 0 ? sharedSecret : Buffer.alloc(32)).digest()
  const aesKey = createHmac('sha256', prk).update(Buffer.concat([ephemeralRaw, Buffer.from([1])])).digest().subarray(0, 16)
  const iv = Buffer.from(globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(12)) : createHash('sha256').update(String(Math.random())).digest().subarray(0, 12))
  const cipher = createCipheriv('aes-128-gcm', aesKey, iv)
  const plaintext = Buffer.from(`${dynamicKey.toString('base64')}|${os}|${sk}`, 'utf8')
  return Buffer.concat([ephemeralRaw, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

function createX25519PublicKey(raw: Buffer) {
  // Node 要求 X25519 公钥带 RFC 8410 SPKI 头
  return createPublicKey({ key: Buffer.concat([Buffer.from(X25519_SPKI_PREFIX_HEX, 'hex'), raw]), format: 'der', type: 'spki' })
}

/** xeapi 明文构造：body/queryString 装配（e_r 固定 true） */
function buildXeapiPlaintext(payload: Record<string, unknown>): string {
  const fields: Record<string, string> = {}
  const bodyData = { ...payload }
  delete bodyData.e_r
  fields.body = Buffer.from(new URLSearchParams(stringifyRecord(bodyData)).toString()).toString('base64')
  fields.queryString = 'e_r=true'
  return JSON.stringify(fields)
}

function stringifyRecord(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return out
}

export interface XeapiPublicKeyState {
  publicKey: string
  sk: string
  version: string
}

/**
 * xeapi 加密：返回表单三字段 B/S/R（base64）。
 * sessionKey 缺省时生成随机动态密钥（新会话）。
 */
export function encryptXeapi(
  payload: Record<string, unknown>,
  keyState: XeapiPublicKeyState,
  options: { sessionKey?: string; sessionId?: string; os?: string },
): { B: string; S: string; R: string } {
  const dynamicKey = options.sessionKey ? Buffer.from(options.sessionKey, 'utf8') : randomBytes16()
  const plaintext = Buffer.from(buildXeapiPlaintext(payload), 'utf8')
  const b = aesEcbEncrypt(dynamicKey, xeapiMidTransform(aesEcbEncrypt(XEAPI_STATIC_KEY, plaintext)))
  const s = xeapiSessionEnvelope(dynamicKey, keyState.publicKey, keyState.sk, options.os ?? 'android')
  const r = aesEcbEncrypt(
    XEAPI_STATIC_KEY,
    Buffer.from(`${keyState.version}|${options.sessionKey ? (options.sessionId ?? '') : ''}`, 'utf8'),
  )
  return { B: b.toString('base64'), S: s.toString('base64'), R: r.toString('base64') }
}

function randomBytes16(): Buffer {
  return Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)))
}

/** xeapi 响应解密：AES-ECB(eapi key) → gzip 魔数则解压 → JSON */
export function decryptXeapiResponse(body: Buffer): unknown {
  const decrypted = aesEcbDecrypt(Buffer.from(EAPI_KEY, 'utf8'), body)
  const plaintext = decrypted[0] === 0x1f && decrypted[1] === 0x8b ? gunzipSync(decrypted) : decrypted
  return JSON.parse(plaintext.toString('utf8'))
}

/** 解密公钥下发数据：AES-ECB(静态密钥) → JSON {publicKey, sk, version} */
export function decryptXeapiPublicKey(encryptedBase64: string): XeapiPublicKeyState {
  return JSON.parse(aesEcbDecrypt(XEAPI_STATIC_KEY, Buffer.from(encryptedBase64, 'base64')).toString('utf8'))
}
