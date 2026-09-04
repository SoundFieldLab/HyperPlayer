// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— crypto 浏览器 shim。
// 协议包 util/crypto.js（xeapi X25519/AES-GCM/HMAC）与 util/ncbl.js 用到
// Node 内置 crypto 的同步 API；此处用纯 JS 同步库等价实现：
// - AES-ECB：crypto-js（MIT，vendored 包自身依赖）
// - AES-GCM：@noble/ciphers（MIT）
// - X25519/ECDH：@noble/curves（MIT）
// - HMAC-SHA256/SHA256：@noble/hashes（MIT）
// - Buffer：buffer 包（MIT，node-globals.mjs 已挂全局）
// 仅实现协议包实际使用的 API 面，不追求 Node 全量兼容。

import { Buffer } from 'buffer'
import CryptoJS from 'crypto-js'
import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

export function randomBytes(size: number): Buffer {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes)
}

export function randomUUID(): string {
  return crypto.randomUUID()
}

// ---- HMAC（createHmac('sha256') → { update, digest }） ----
interface Hmac {
  update(chunk: Uint8Array | string): Hmac
  digest(encoding?: 'hex' | 'base64'): Buffer | string
}

export function createHmac(algorithm: string, key: Uint8Array): Hmac {
  if (algorithm !== 'sha256') {
    throw new Error(`crypto shim: unsupported HMAC algorithm: ${algorithm}`)
  }
  const keyBytes = toBytes(key)
  const chunks: Uint8Array[] = []
  return {
    update(chunk: Uint8Array | string): Hmac {
      chunks.push(toBytes(chunk))
      return this
    },
    digest(encoding?: 'hex' | 'base64'): Buffer | string {
      const digest = hmac(sha256, keyBytes, concatBytes(...chunks))
      if (encoding === 'hex') return Buffer.from(digest).toString('hex')
      if (encoding === 'base64') return Buffer.from(digest).toString('base64')
      return Buffer.from(digest)
    },
  }
}

// ---- 摘要（createHash('md5'/'sha256') → { update, digest }） ----
interface Hash {
  update(chunk: Uint8Array | string): Hash
  digest(encoding?: 'hex' | 'base64'): Buffer | string
}

export function createHash(algorithm: string): Hash {
  const chunks: Uint8Array[] = []
  return {
    update(chunk: Uint8Array | string): Hash {
      chunks.push(toBytes(chunk))
      return this
    },
    digest(encoding?: 'hex' | 'base64'): Buffer | string {
      const wordArray = CryptoJS.enc.Utf8.parse(Buffer.from(concatBytes(...chunks)).toString('utf-8'))
      const hash =
        algorithm === 'md5'
          ? CryptoJS.MD5(wordArray)
          : algorithm === 'sha256'
            ? CryptoJS.SHA256(wordArray)
            : (() => {
                throw new Error(`crypto shim: unsupported hash: ${algorithm}`)
              })()
      if (encoding === 'hex') return hash.toString(CryptoJS.enc.Hex)
      if (encoding === 'base64') return hash.toString(CryptoJS.enc.Base64)
      return Buffer.from(hash.toString(CryptoJS.enc.Hex), 'hex')
    },
  }
}

// ---- 对称加密（createCipheriv / createDecipheriv） ----
// Node 用法：cipher.update(chunk) 多次累积 → cipher.final() 返回 Buffer。
// AES-ECB 用 crypto-js（noble 有意不提供 ECB）；AES-GCM 用 noble。
function toWordArray(bytes: Uint8Array): CryptoJS.lib.WordArray {
  // 经 hex 中转保证任意字节保真（WordArray.create 直接吃 TypedArray 会按字解释）
  return CryptoJS.enc.Hex.parse(Buffer.from(bytes).toString('hex'))
}

function aesEcb(
  operation: 'encrypt' | 'decrypt',
  key: Uint8Array,
  chunks: Uint8Array[],
): Buffer {
  const keyWordArray = toWordArray(key)
  const data = concatBytes(...chunks)
  if (operation === 'encrypt') {
    const result = CryptoJS.AES.encrypt(toWordArray(data), keyWordArray, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    })
    return Buffer.from(result.ciphertext.toString(CryptoJS.enc.Hex), 'hex')
  }
  const result = CryptoJS.AES.decrypt(
    CryptoJS.lib.CipherParams.create({ ciphertext: toWordArray(data) }),
    keyWordArray,
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
  )
  return Buffer.from(result.toString(CryptoJS.enc.Hex), 'hex')
}

interface Cipher {
  update(chunk: Uint8Array | string): Cipher
  final(): Buffer
  getAuthTag(): Buffer
  setAuthTag?(tag: Uint8Array): Cipher
}

function createAesCipher(
  operation: 'encrypt' | 'decrypt',
  algorithm: string,
  key: Uint8Array,
  iv: Uint8Array | null,
): Cipher {
  const keyBytes = toBytes(key)
  const chunks: Uint8Array[] = []
  let authTag: Uint8Array | null = null
  let finished = false

  const finalize = (): Buffer => {
    if (finished) throw new Error('crypto shim: cipher already finalized')
    finished = true
    const data = concatBytes(...chunks)
    if (algorithm.endsWith('-ecb')) {
      return aesEcb(operation, keyBytes, [data])
    }
    if (algorithm === 'aes-128-gcm' || algorithm === 'aes-256-gcm') {
      if (!iv) throw new Error('crypto shim: GCM requires an IV')
      const cipher = gcm(keyBytes, toBytes(iv))
      const tagLength = gcm.tagLength
      if (operation === 'encrypt') {
        const out = cipher.encrypt(data)
        // noble gcm 将认证标签追加在密文尾部；拆出 tag 以对齐 Node API
        authTag = out.subarray(out.length - tagLength)
        return Buffer.from(out.subarray(0, out.length - tagLength))
      }
      if (!authTag) throw new Error('crypto shim: GCM decrypt requires setAuthTag')
      const tagged = concatBytes(data, authTag)
      return Buffer.from(cipher.decrypt(tagged))
    }
    throw new Error(`crypto shim: unsupported cipher algorithm: ${algorithm}`)
  }

  return {
    update(chunk: Uint8Array | string): Cipher {
      chunks.push(toBytes(chunk))
      return this
    },
    final(): Buffer {
      return finalize()
    },
    getAuthTag(): Buffer {
      if (!authTag) throw new Error('crypto shim: auth tag not available')
      return Buffer.from(authTag)
    },
    setAuthTag(tag: Uint8Array): Cipher {
      authTag = toBytes(tag)
      return this
    },
  }
}

export function createCipheriv(
  algorithm: string,
  key: Uint8Array,
  iv: Uint8Array | null,
): Cipher {
  return createAesCipher('encrypt', algorithm, key, iv)
}

export function createDecipheriv(
  algorithm: string,
  key: Uint8Array,
  iv: Uint8Array | null,
): Cipher {
  return createAesCipher('decrypt', algorithm, key, iv)
}

// ---- X25519（generateKeyPairSync / createPublicKey / diffieHellman） ----
interface X25519KeyObject {
  export(options: { format: 'der'; type: 'spki' | 'pkcs8' }): Buffer
  readonly raw: Uint8Array
}

export function generateKeyPairSync(type: 'x25519') {
  if (type !== 'x25519') {
    throw new Error(`crypto shim: unsupported key type: ${type}`)
  }
  const privateKey = x25519.utils.randomSecretKey()
  const publicKey = x25519.getPublicKey(privateKey)
  const publicObj: X25519KeyObject = {
    export() {
      return Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(publicKey)])
    },
    raw: publicKey,
  }
  const privateObj: X25519KeyObject = {
    export() {
      return Buffer.from(privateKey)
    },
    raw: privateKey,
  }
  return { publicKey: publicObj, privateKey: privateObj }
}

export function createPublicKey(options: {
  key: Uint8Array
  format: 'der'
  type: 'spki'
}): X25519KeyObject {
  const der = toBytes(options.key)
  if (der.length === 32) {
    // 直接传 raw key 的容错路径
    return { export: () => Buffer.from(der), raw: der }
  }
  if (der.length === 44 && der[0] === 0x30) {
    // SPKI DER：剥掉 12 字节前缀取 raw
    const raw = der.subarray(12)
    return { export: () => Buffer.from(der), raw }
  }
  throw new Error('crypto shim: unsupported public key DER')
}

export function diffieHellman(options: {
  privateKey: X25519KeyObject
  publicKey: X25519KeyObject
}): Buffer {
  const shared = x25519.getSharedSecret(options.privateKey.raw, options.publicKey.raw)
  return Buffer.from(shared)
}

function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value, 'utf-8')
  return value instanceof Uint8Array ? value : new Uint8Array(value as never)
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
