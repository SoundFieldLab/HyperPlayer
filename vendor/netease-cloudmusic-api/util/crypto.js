// HyperPlayer adaptations: 浏览器版加密模块。
// weapi / linuxapi / eapi 保持原语义（crypto-js / node-forge 纯 JS 实现）；
// xeapi（X25519/AES-GCM 会话）依赖 node:crypto 与 zlib，浏览器不支持——
// 相关入口抛错，由音质降级候选链覆盖（lossless/exhigh 走 eapi/weapi）。
// eapiResDecrypt 改为 async（aeapi=gzip 分支用浏览器 DecompressionStream）。
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

const xeapiUnsupported = () => {
  throw new Error('HyperPlayer adaptations: xeapi (X25519) unsupported in browser — 音质降级链覆盖')
}

module.exports = {
  weapi,
  linuxapi,
  eapi,
  xeapi: xeapiUnsupported,
  decrypt,
  aesEncrypt,
  aesDecrypt,
  eapiReqDecrypt,
  eapiResDecrypt,
  xeapiSign: xeapiUnsupported,
  xeapiResDecrypt: xeapiUnsupported,
  xeapiDecryptPublicKey: xeapiUnsupported,
}
