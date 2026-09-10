// HyperPlayer adaptations: 浏览器版加密模块。
// weapi / linuxapi / eapi 保持原语义（crypto-js / node-forge 纯 JS 实现）；
// xeapi 已移植到浏览器：X25519/HKDF/AES-GCM 走 WebCrypto，gzip 走 DecompressionStream，
// AES-ECB（二进制密钥）走 crypto-js——与上游 node:crypto 语义逐位对齐（含 PKCS7 与 auth tag 追加）。
// eapiResDecrypt 为 async（aeapi=gzip 分支用浏览器 DecompressionStream）。
'use strict'

const CryptoJS = require('crypto-js')
const forge = require('node-forge')
const iv = '0102030405060708'
const presetKey = '0CoJUm6Qyw8W8jud'
const linuxapiKey = 'rFgB&h#%2?^eDg:Q'
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`
const eapiKey = 'e82ckenh8dichen8'
const xeapiStaticKeyHex =
  'ab1d5a430f6bb04a3f01e81ddd72bd916d5ce591248ac128714806d7f8fb1b84'
const xeapiSignKeyB64 =
  'mUHCwVNWJbunMqAHf5MImuirT6plvs6VSFW62MGHstFQxhBGdEoIhLItH3djc4+FB/OKty3+lL2rGeoFBpVe5g=='

const aesEncrypt = (text, mode, key, iv, format = 'base64') => {
  let encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(text),
    CryptoJS.enc.Utf8.parse(key),
    {
      iv: CryptoJS.enc.Utf8.parse(iv),
      mode: CryptoJS.mode[mode.toUpperCase()],
      padding: CryptoJS.pad.Pkcs7,
    },
  )
  if (format === 'base64') {
    return encrypted.toString()
  }
  return encrypted.ciphertext.toString().toUpperCase()
}
const aesDecrypt = (ciphertext, key, iv, format = 'base64') => {
  let bytes
  if (format === 'base64') {
    bytes = CryptoJS.AES.decrypt(ciphertext, CryptoJS.enc.Utf8.parse(key), {
      iv: CryptoJS.enc.Utf8.parse(iv),
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    })
  } else {
    bytes = CryptoJS.AES.decrypt(
      { ciphertext: CryptoJS.enc.Hex.parse(ciphertext) },
      CryptoJS.enc.Utf8.parse(key),
      {
        iv: CryptoJS.enc.Utf8.parse(iv),
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7,
      },
    )
  }
  return bytes
}
const rsaEncrypt = (str, key) => {
  const forgePublicKey = forge.pki.publicKeyFromPem(key)
  const encrypted = forgePublicKey.encrypt(str, 'NONE')
  return forge.util.bytesToHex(encrypted)
}

const weapi = (object) => {
  const text = JSON.stringify(object)
  let secretKey = ''
  for (let i = 0; i < 16; i++) {
    secretKey += base62.charAt(Math.round(Math.random() * 61))
  }
  return {
    params: aesEncrypt(
      aesEncrypt(text, 'cbc', presetKey, iv),
      'cbc',
      secretKey,
      iv,
    ),
    encSecKey: rsaEncrypt(secretKey.split('').reverse().join(''), publicKey),
  }
}

const linuxapi = (object) => {
  const text = JSON.stringify(object)
  return {
    eparams: aesEncrypt(text, 'ecb', linuxapiKey, '', 'hex'),
  }
}

const eapi = (url, object) => {
  const text = typeof object === 'object' ? JSON.stringify(object) : object
  const message = `nobody${url}use${text}md5forencrypt`
  const digest = CryptoJS.MD5(message).toString()
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return {
    params: aesEncrypt(data, 'ecb', eapiKey, '', 'hex'),
  }
}

// —— 浏览器 bytes ↔ base64/utf8 工具（替代 node Buffer）——
const base64ToBytes = (b64) => {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const bytesToBase64 = (bytes) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

const concatBytes = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const wordArrayFromBytes = (bytes) => {
  const words = []
  for (let i = 0; i < bytes.length; i += 4) {
    words.push(
      ((bytes[i] || 0) << 24) |
        ((bytes[i + 1] || 0) << 16) |
        ((bytes[i + 2] || 0) << 8) |
        (bytes[i + 3] || 0),
    )
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length)
}

const bytesFromWordArray = (wordArray) => {
  const words = wordArray.words
  const out = new Uint8Array(wordArray.sigBytes)
  for (let i = 0; i < out.length; i++) {
    out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff
  }
  return out
}

const gunzipBytes = async (bytes) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const eapiResDecrypt = async (encryptedParams, aeapi = false) => {
  try {
    const decrypted = aesDecrypt(encryptedParams, eapiKey, '', 'hex') // WordArray
    if (aeapi) {
      // 带压缩的解密：先转 Base64 再解压
      const bytes = base64ToBytes(decrypted.toString(CryptoJS.enc.Base64))
      const decompressed = await gunzipBytes(bytes)
      return JSON.parse(new TextDecoder().decode(decompressed))
    }
    return JSON.parse(decrypted.toString(CryptoJS.enc.Utf8))
  } catch (error) {
    console.log(`eapiResDecrypt error:`, error)
    return null
  }
}
const eapiReqDecrypt = (encryptedParams) => {
  const decryptedData = aesDecrypt(
    encryptedParams,
    eapiKey,
    '',
    'hex',
  ).toString(CryptoJS.enc.Utf8)
  const match = decryptedData.match(/(.*?)-36cd479b6b5-(.*?)-36cd479b6b5-(.*)/)
  if (match) {
    const url = match[1]
    const data = JSON.parse(match[2])
    return { url, data }
  }
  return null
}
const decrypt = (cipher) => {
  const decipher = CryptoJS.AES.decrypt(
    {
      ciphertext: CryptoJS.enc.Hex.parse(cipher),
    },
    eapiKey,
    {
      mode: CryptoJS.mode.ECB,
    },
  )
  return CryptoJS.enc.Utf8.stringify(decipher)
}

// —— xeapi：X25519/AES-GCM 会话（上游 node:crypto 实现的浏览器移植，均为 async）——
const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
const xeapiStaticKey = hexToBytes(xeapiStaticKeyHex)
// 上游 crypto.createHmac('sha256', <string>) 把密钥字符串按 UTF-8 字节取用（不是 base64 解码）
const xeapiSignKeyBytes = new TextEncoder().encode(xeapiSignKeyB64)

// AES-ECB（PKCS7，与 node createCipheriv 默认一致），密钥为二进制字节。
const aesEcbEncrypt = (keyBytes, plaintextBytes) => {
  const encrypted = CryptoJS.AES.encrypt(
    wordArrayFromBytes(plaintextBytes),
    wordArrayFromBytes(keyBytes),
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
  )
  return bytesFromWordArray(encrypted.ciphertext)
}

const aesEcbDecrypt = (keyBytes, ciphertextBytes) => {
  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: wordArrayFromBytes(ciphertextBytes) },
    wordArrayFromBytes(keyBytes),
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
  )
  return bytesFromWordArray(decrypted)
}

const xeapiSign = async (timestamp, nonce) => {
  const key = await crypto.subtle.importKey(
    'raw',
    xeapiSignKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(String(timestamp) + nonce),
  )
  return bytesToBase64(new Uint8Array(mac))
}

const xeapiMidTransform = (ciphertext) => {
  const random = crypto.getRandomValues(new Uint8Array(16))
  const xored = new Uint8Array(ciphertext.length)
  for (let i = 0; i < ciphertext.length; i++) {
    xored[i] = ciphertext[i] ^ random[i & 0x0f]
  }
  const b64 = new TextEncoder().encode(bytesToBase64(xored))
  const rot = b64.length ? (random[0] & 0x0f) % b64.length : 0
  const out = new Uint8Array(16 + b64.length)
  out.set(random, 0)
  out.set(b64.subarray(rot), 16)
  out.set(b64.subarray(0, rot), 16 + (b64.length - rot))
  return out
}

// 上游语义：PRK = HMAC-SHA256(key=0^32, IKM=sharedSecret)；OKM = HMAC-SHA256(key=PRK, msg=eph||0x01)[0:16]。
// 用 HMAC 显式复刻而非 deriveBits('HKDF')：不同运行时的 HKDF 实现存在差异（node 25 实测与 RFC 不符），
// 而 HMAC 原语在各平台语义唯一。
const deriveX25519AesKey = async (sharedSecret, ephemeralRaw) => {
  const extractKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const prk = new Uint8Array(
    await crypto.subtle.sign('HMAC', extractKey, sharedSecret),
  )
  const expandKey = await crypto.subtle.importKey(
    'raw',
    prk,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const info = concatBytes(ephemeralRaw, new Uint8Array([1]))
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', expandKey, info))
  return okm.slice(0, 16)
}

const xeapiEncryptS = async (dynamicKey, publicKeyState, os) => {
  const peerRaw = base64ToBytes(publicKeyState.publicKey)
  const peerKey = await crypto.subtle.importKey(
    'raw',
    peerRaw,
    { name: 'X25519' },
    false,
    [],
  )
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])
  const ephemeralRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  )
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // WebCrypto X25519 复用 EcdhKeyDeriveParams：对端密钥字段名为 public
      { name: 'X25519', public: peerKey },
      pair.privateKey,
      256,
    ),
  )
  const aesKey = await deriveX25519AesKey(sharedSecret, ephemeralRaw)
  const ivBytes = crypto.getRandomValues(new Uint8Array(12))
  const aesKeyImported = await crypto.subtle.importKey(
    'raw',
    aesKey,
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const plaintext = new TextEncoder().encode(
    `${bytesToBase64(dynamicKey)}|${os}|${publicKeyState.sk || ''}`,
  )
  // WebCrypto 输出 = ciphertext || tag(16)，与上游 Buffer.concat([encrypted, authTag]) 一致
  const encryptedWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, aesKeyImported, plaintext),
  )
  return concatBytes(ephemeralRaw, ivBytes, encryptedWithTag)
}

const buildXeapiPlaintext = (uri, data, options = {}) => {
  const fields = {}
  const contentType =
    options.contentType || 'application/x-www-form-urlencoded;charset=utf-8'
  const mediaType = contentType.split(';', 1)[0].toLowerCase()
  if (mediaType !== 'application/x-www-form-urlencoded') {
    fields.contentType = contentType
  }

  const method = (options.method || 'POST').toUpperCase()
  if (method !== 'POST') fields.method = method

  const url = new URL(uri, 'https://interface.music.163.com')
  if (url.search) fields.queryString = url.search.slice(1)

  if (data !== undefined && data !== null) {
    const bodyData = { ...data }
    delete bodyData.e_r
    const body = new TextEncoder().encode(
      new URLSearchParams(bodyData).toString(),
    )
    fields.body = bytesToBase64(body)
  }

  if (fields.queryString) {
    fields.queryString += '&e_r=true'
  } else {
    fields.queryString = 'e_r=true'
  }
  return JSON.stringify(fields)
}

const xeapi = async (uri, data, options = {}) => {
  const publicKeyState = options.publicKeyState
  if (!publicKeyState) {
    throw new Error('xeapi publicKeyState is required')
  }
  const activeSessionKey = options.sessionKey
    ? new TextEncoder().encode(String(options.sessionKey))
    : null
  const activeSessionId = options.sessionId || ''
  const dynamicKey =
    activeSessionKey || crypto.getRandomValues(new Uint8Array(16))
  const plaintext = new TextEncoder().encode(
    buildXeapiPlaintext(uri, data, options),
  )

  const b = aesEcbEncrypt(
    dynamicKey,
    xeapiMidTransform(aesEcbEncrypt(xeapiStaticKey, plaintext)),
  )
  const s = await xeapiEncryptS(dynamicKey, publicKeyState, options.os || 'android')
  const r = aesEcbEncrypt(
    xeapiStaticKey,
    new TextEncoder().encode(
      `${publicKeyState.version}|${activeSessionKey ? activeSessionId : ''}`,
    ),
  )

  return {
    B: bytesToBase64(b),
    S: bytesToBase64(s),
    R: bytesToBase64(r),
  }
}

const eapiUtf8Bytes = () => new TextEncoder().encode(eapiKey)

const xeapiResDecrypt = async (bodyBytes) => {
  const decrypted = aesEcbDecrypt(eapiUtf8Bytes(), bodyBytes)
  const plaintext =
    decrypted[0] === 0x1f && decrypted[1] === 0x8b
      ? await gunzipBytes(decrypted)
      : decrypted
  return JSON.parse(new TextDecoder().decode(plaintext))
}

const xeapiDecryptPublicKey = (encryptedData) => {
  return JSON.parse(
    new TextDecoder().decode(
      aesEcbDecrypt(xeapiStaticKey, base64ToBytes(encryptedData)),
    ),
  )
}

module.exports = {
  weapi,
  linuxapi,
  eapi,
  xeapi,
  decrypt,
  aesEncrypt,
  aesDecrypt,
  eapiReqDecrypt,
  eapiResDecrypt,
  xeapiSign,
  xeapiResDecrypt,
  xeapiDecryptPublicKey,
}
