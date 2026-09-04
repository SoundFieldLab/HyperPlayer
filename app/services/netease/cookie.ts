// 网易云 Cookie 纯函数（无 bridge 依赖，可单测）。
// 与协议包 util/index.js 的 cookieToJson 语义一致：分号分隔、首个等号切分。

export interface NeteaseCookie {
  MUSIC_U?: string
  MUSIC_A?: string
  __csrf?: string
  os?: string
  osver?: string
  deviceId?: string
  channel?: string
  appver?: string
  NMTID?: string
  _ntes_nuid?: string
  _ntes_nnid?: string
  WNMCID?: string
  WEVNSM?: string
  [key: string]: string | undefined
}

/** cookie 字符串 → 对象（与协议包 util/index.js cookieToJson 语义一致） */
export function cookieToJson(cookie: string): NeteaseCookie {
  const obj: NeteaseCookie = {}
  for (const item of cookie.split(';')) {
    const [key, ...rest] = item.trim().split('=')
    if (key && rest.length > 0) {
      obj[key.trim()] = rest.join('=').trim()
    }
  }
  return obj
}

/** 对象 → Set-Cookie 数组（持久化用，仅保留已知键） */
const KNOWN_KEYS = [
  'MUSIC_U',
  'MUSIC_A',
  '__csrf',
  'os',
  'osver',
  'deviceId',
  'channel',
  'appver',
  'NMTID',
  '_ntes_nuid',
  '_ntes_nnid',
  'WNMCID',
  'WEVNSM',
] as const

export function cookieToArray(cookie: NeteaseCookie): string[] {
  const result: string[] = []
  for (const key of KNOWN_KEYS) {
    const value = cookie[key]
    if (value) result.push(`${key}=${value}`)
  }
  return result
}

/** 提取协议包响应中的登录 Cookie（body.cookie 字符串优先） */
export function extractLoginCookie(body: { cookie?: string | string[] }): NeteaseCookie {
  const raw = Array.isArray(body.cookie)
    ? body.cookie.join(';')
    : typeof body.cookie === 'string'
      ? body.cookie
      : ''
  return cookieToJson(raw)
}
