// HyperPlayer adaptations: 浏览器版传输（axios → infra tauriHttp 注入；无 node fs/path/os/tunnel）
const encrypt = require('./crypto')
const CryptoJS = require('crypto-js')
const axios = require('./browserHttp')
const logger = require('./logger')
const {
  cookieToJson,
  cookieObjToString,
  toBoolean,
} = require('./index')
const { URLSearchParams, URL } = globalThis
const { APP_CONF } = require('../util/config.json')
const {
  getToken: antiCheatTokenV2,
} = require('../module/register_checktoken_v2')
const {
  getToken: antiCheatTokenV3,
} = require('../module/register_checktoken_v3')

// HyperPlayer adaptations: 浏览器无 fs；xeapi 公钥由注入 storage 提供（含 tauri store 持久化）
let browserStorage = {
  getAnonymousToken: async () => '',
  getXeapiPublicKey: async () => null,
}
let anonymousTokenPromise = null
const getAnonymousToken = () => {
  if (!anonymousTokenPromise) {
    // 失败不缓存：否则首次异常会把所有后续请求一起拖死；
    // 空结果也不缓存：匿名注册后台重试后能自动恢复。
    anonymousTokenPromise = browserStorage.getAnonymousToken().then((token) => {
      if (!token) anonymousTokenPromise = null
      return token
    }, (error) => {
      anonymousTokenPromise = null
      throw error
    })
  }
  return anonymousTokenPromise
}
let xeapiPublicKeyState = null
const loadXeapiPublicKey = async () => {
  if (xeapiPublicKeyState) return xeapiPublicKeyState
  try {
    xeapiPublicKeyState = await browserStorage.getXeapiPublicKey()
  } catch {
    xeapiPublicKeyState = null
  }
  return xeapiPublicKeyState
}
let xeapiSessionId = ''
let xeapiSessionKey = ''

// 预先绑定常用函数和常量
const floor = Math.floor
const random = Math.random
const now = Date.now
const keys = Object.keys
const stringify = JSON.stringify
const parse = JSON.parse
const characters = 'abcdefghijklmnopqrstuvwxyz'
const charactersLength = characters.length

// 预先计算WNMCID（只计算一次）
const WNMCID = (function () {
  let randomString = ''
  for (let i = 0; i < 6; i++) {
    randomString += characters.charAt(floor(random() * charactersLength))
  }
  return `${randomString}.${now().toString()}.01.0`
})()

// 预先定义osMap
const osMap = {
  pc: {
    os: 'pc',
    appver: '3.1.17.204416',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    channel: 'netease',
  },
  linux: {
    os: 'linux',
    appver: '1.2.1.0428',
    osver: 'Deepin 20.9',
    channel: 'netease',
  },
  android: {
    os: 'android',
    appver: '8.20.20.231215173437',
    osver: '14',
    channel: 'xiaomi',
  },
  iphone: {
    os: 'iPhone OS',
    appver: '9.0.90',
    osver: '16.2',
    channel: 'distribution',
  },
  osx: {
    os: 'osx',
    appver: '3.1.10.5100',
    osver: '15.5',
    channel: 'netease',
  },
}

// 预先定义userAgentMap
const userAgentMap = {
  weapi: {
    pc: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  },
  linuxapi: {
    linux:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
  },
  api: {
    pc: 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117',
    android:
      'NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)',
    iphone: 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
  },
}

// 预先定义常量
const DOMAIN = APP_CONF.domain
const API_DOMAIN = APP_CONF.apiDomain
const EAPI_DOMAIN = APP_CONF.eapiDomain
const XEAPI_DOMAIN = APP_CONF.xeapiDomain
const ENCRYPT_RESPONSE = APP_CONF.encryptResponse
const SPECIAL_STATUS_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803])

// chooseUserAgent函数
const chooseUserAgent = (crypto, uaType = 'pc') => {
  return (userAgentMap[crypto] && userAgentMap[crypto][uaType]) || ''
}

// cookie处理
const processCookieObject = (cookie, uri, anonymousToken) => {
  const _ntes_nuid = CryptoJS.lib.WordArray.random(32).toString()
  const os = osMap[cookie.os] || osMap['pc']

  const processedCookie = {
    ...cookie,
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: cookie._ntes_nuid || _ntes_nuid,
    _ntes_nnid: cookie._ntes_nnid || `${_ntes_nuid},${now().toString()}`,
    WNMCID: cookie.WNMCID || WNMCID,
    WEVNSM: cookie.WEVNSM || '1.0.0',
    osver: cookie.osver || os.osver,
    deviceId: cookie.deviceId || '',
    os: cookie.os || os.os,
    channel: cookie.channel || os.channel,
    appver: cookie.appver || os.appver,
  }

  if (uri.indexOf('login') === -1) {
    processedCookie['NMTID'] = CryptoJS.lib.WordArray.random(16).toString()
  }

  if (!processedCookie.MUSIC_U) {
    // MUSIC_A 仅在拿到真实匿名 token 时携带；伪造/空 token 不写入
    // （无效凭据是网易云风控"设备环境异常"的典型诱因）。
    const musicA = processedCookie.MUSIC_A || anonymousToken
    if (musicA) processedCookie.MUSIC_A = musicA
  }

  return processedCookie
}

// header cookie生成
const createHeaderCookie = (header) => {
  const headerKeys = keys(header)
  const cookieParts = new Array(headerKeys.length)

  for (let i = 0, len = headerKeys.length; i < len; i++) {
    const key = headerKeys[i]
    cookieParts[i] =
      encodeURIComponent(key) + '=' + encodeURIComponent(header[key])
  }

  return cookieParts.join('; ')
}

// 浏览器 bytes → hex（替代 node Buffer.toString('hex')）
const bytesToHex = (bytes) => {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex.toUpperCase()
}

// requestId生成
const generateRequestId = () => {
  return `${now()}_${floor(random() * 1000)
    .toString()
    .padStart(4, '0')}`
}

const createRequest = async (uri, data, options) => {
  const anonymousToken = await getAnonymousToken()
  let token = ''
  switch (options.checkToken) {
    // HyperPlayer adaptations: 反作弊 token 拉取失败不阻塞请求
    case 'v2':
      try { token = antiCheatTokenV2() } catch { token = '' }
      break
    case 'v3':
      try { token = antiCheatTokenV3() } catch { token = '' }
      break
  }

  // HyperPlayer adaptations: 请求装配移出 Promise executor——xeapi 加密是 async
  // （WebCrypto），executor 内无法 await；装配抛错同样使 createRequest 拒绝。
  const headers = options.headers ? { ...options.headers } : {}
  let cookie = options.cookie || {}
  if (typeof cookie === 'string') {
    cookie = cookieToJson(cookie)
  }

  if (typeof cookie === 'object') {
    cookie = processCookieObject(cookie, uri, anonymousToken)
    headers['Cookie'] = cookieObjToString(cookie)
  }
  let url = ''
  let encryptData = ''
  let crypto = options.crypto
  const csrfToken = cookie['__csrf'] || ''

  // 加密方式选择
  if (crypto === '') {
    crypto = APP_CONF.encrypt ? 'eapi' : 'api'
  }

  const answer = { status: 500, body: {}, cookie: [] }

  data.e_r = toBoolean(
    options.e_r !== undefined
      ? options.e_r
      : data.e_r !== undefined
        ? data.e_r
        : ENCRYPT_RESPONSE,
  )
  // 根据加密方式处理
  switch (crypto) {
    case 'weapi':
      headers['Referer'] = options.domain || DOMAIN
      headers['User-Agent'] = options.ua || chooseUserAgent('weapi')
      data.csrf_token = csrfToken
      if (options.checkToken) {
        headers['X-antiCheatToken'] = token
      }
      encryptData = encrypt.weapi(data)
      url = (options.domain || DOMAIN) + '/weapi/' + uri.substr(5)
      break

    case 'linuxapi':
      headers['User-Agent'] =
        options.ua || chooseUserAgent('linuxapi', 'linux')
      encryptData = encrypt.linuxapi({
        method: 'POST',
        url: (options.domain || DOMAIN) + uri,
        params: data,
      })
      url = (options.domain || DOMAIN) + '/api/linux/forward'
      break

    case 'xeapi': {
      // HyperPlayer adaptations: 公钥经注入 storage 异步获取（tauri store 持久化）
      const xeapiPublicKey = await loadXeapiPublicKey()
      if (!xeapiPublicKey) {
        throw new Error('xeapi public key is missing')
      }
      const xeapiOs = cookie.os === 'android' ? cookie.os : 'android'
      const xeapiAppver =
        cookie.os === 'android' && cookie.appver ? cookie.appver : '9.1.65'
      const xeapiOsver =
        cookie.os === 'android' && cookie.osver ? cookie.osver : '16'
      const xeapiBuildver = cookie.buildver || now().toString().substr(0, 10)
      headers['User-Agent'] = options.ua || chooseUserAgent('api', 'android')
      headers['X-Client-Enc-State'] = 'ENCRYPTED'
      headers['x-aeapi'] = true
      headers['content-type'] =
        'application/x-www-form-urlencoded;charset=utf-8'
      headers['x-deviceid'] = cookie.deviceId
      headers['x-os'] = xeapiOs
      headers['x-osver'] = xeapiOsver
      headers['x-appver'] = xeapiAppver
      headers['x-sdeviceid'] = cookie.sDeviceId || cookie.deviceId
      headers['x-buildver'] = xeapiBuildver
      if (cookie.MUSIC_U) headers['x-music-u'] = cookie.MUSIC_U
      if (options.checkToken) {
        headers['X-antiCheatToken'] = token
      }
      const xeapiCookie = {
        ...cookie,
        os: xeapiOs,
        osver: xeapiOsver,
        appver: xeapiAppver,
        buildver: xeapiBuildver,
        deviceId: cookie.deviceId,
        sDeviceId: cookie.sDeviceId || cookie.deviceId,
      }
      headers['Cookie'] = cookieObjToString(xeapiCookie)
      url = (options.domain || XEAPI_DOMAIN) + '/xeapi/' + uri.substr(5)
      encryptData = await encrypt.xeapi(uri, data, {
        ...options,
        publicKeyState: xeapiPublicKey,
        sessionId: xeapiSessionId,
        sessionKey: xeapiSessionKey,
        appver: xeapiAppver,
        deviceId: cookie.deviceId,
        os: xeapiOs,
        uid: cookie.uid || cookie.userId || '',
      })
      break
    }

    case 'eapi':
    case 'api':
      // header创建
      var header = {
        osver: cookie.osver,
        deviceId: cookie.deviceId,
        os: cookie.os,
        appver: cookie.appver,
        versioncode: cookie.versioncode || '140',
        mobilename: cookie.mobilename || '',
        buildver: cookie.buildver || now().toString().substr(0, 10),
        resolution: cookie.resolution || '1920x1080',
        __csrf: csrfToken,
        channel: cookie.channel,
        requestId: generateRequestId(),
        // clientSign: APP_CONF.clientSign,
      }

      if (cookie.MUSIC_U) header['MUSIC_U'] = cookie.MUSIC_U
      if (cookie.MUSIC_A) header['MUSIC_A'] = cookie.MUSIC_A
      if (options.checkToken) {
        header['X-antiCheatToken'] = token
      }

      headers['Cookie'] = createHeaderCookie(header)
      headers['User-Agent'] =
        options.ua ||
        (cookie.os === 'osx'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          : chooseUserAgent('api', 'iphone'))

      if (crypto === 'eapi') {
        // headers['x-aeapi'] = true // 服务器会使用gzip压缩返回值
        data.header = header

        encryptData = encrypt.eapi(uri, data)
        url = (options.domain || EAPI_DOMAIN) + '/eapi/' + uri.substr(5)
      } else if (crypto === 'api') {
        url = (options.domain || API_DOMAIN) + uri
        encryptData = data
      }
      break

    default:
      console.log('[ERR]', 'Unknown Crypto:', crypto)
      break
  }
  // settings创建
  let settings = {
    method: 'POST',
    url: url,
    headers: headers,
    data: new URLSearchParams(encryptData).toString(),
  }

  // 自定义超时
  if (options.timeout > 0) {
    settings.timeout = options.timeout
  }

  // 使用返回值加密
  const use_e_r = (crypto === 'eapi' || crypto === 'weapi') && data.e_r
  const use_xeapi = crypto === 'xeapi'
  if (use_e_r || use_xeapi) {
    settings.encoding = null
    settings.responseType = 'arraybuffer'
  }

  // HyperPlayer adaptations: 浏览器不支持代理（忽略 options.proxy）
  return new Promise((resolve, reject) => {
    axios(settings)
      .then(async (res) => {
        const body = res.data
        answer.cookie = (res.headers['set-cookie'] || []).map((x) =>
          x.replace(/\s*Domain=[^(;|$)]+;*/, ''),
        )

        try {
          if (use_xeapi) {
            // xeapi 会话：服务端经响应头下发会话密钥，后续请求复用（上游语义）
            if (res.headers['x-encr-ssid']) xeapiSessionId = res.headers['x-encr-ssid']
            if (res.headers['x-encr-sskey']) xeapiSessionKey = res.headers['x-encr-sskey']
            answer.body = await encrypt.xeapiResDecrypt(
              body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? '')),
            )
          } else if (use_e_r) {
            answer.body = await encrypt.eapiResDecrypt(
              bytesToHex(body),
              headers['x-aeapi'],
            )
          } else {
            answer.body =
              typeof body === 'object' ? body : parse(body.toString())
          }

          if (answer.body && answer.body.code) {
            answer.body.code = Number(answer.body.code)
          }

          answer.status = Number(answer.body.code || res.status)

          // 状态码检查（使用Set提升查找性能）
          if (SPECIAL_STATUS_CODES.has(answer.body.code)) {
            answer.status = 200
          }
        } catch (e) {
          answer.body = body
          answer.status = res.status
        }

        answer.status =
          answer.status > 100 && answer.status < 600 ? answer.status : 400

        if (answer.status === 200) {
          resolve(answer)
        } else {
          console.log('[ERR]', answer)
          reject(answer)
        }
      })
      .catch((err) => {
        answer.status = 502
        // 传输层可能以 null/undefined/字符串拒绝（tauri invoke、ACL 拒绝等），
        // err.message 直接解引用会把 Promise 永久挂起。
        answer.body = { code: 502, msg: err?.message || String(err ?? 'network error') }
        console.log('[ERR]', answer)
        reject(answer)
      })
  })
}

module.exports = createRequest
module.exports.setBrowserHttpTransport = axios.setBrowserHttpTransport
module.exports.setBrowserStorage = (storage) => {
  browserStorage = storage
  anonymousTokenPromise = null
  xeapiPublicKeyState = null
}
