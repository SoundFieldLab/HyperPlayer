// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— fs 浏览器 shim。
// 匿名 token / xeapi 公钥经 localStorage 持久化（与 D35 Q17 DPAPI 保险库同语义，
// 这里是协议包内部落盘点的替换，不承载 Cookie 主存储）。
// china_ip_ranges.txt 由构建脚本内联（fs shim 无真实文件系统）。

import { CHINA_IP_RANGES_CONTENT } from '../generated/china-ip-ranges.generated'

type FileStore = Record<string, string>

const KEY = 'hyperplayer.netease.protocol-fs.v1'

// Node/测试环境无 localStorage 时退化为纯内存存储（请求流程不受影响，
// 跨会话持久化仅在 WebView2 内生效）。
function load(): FileStore {
  try {
    if (typeof localStorage === 'undefined') return {}
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as FileStore
  } catch {
    return {}
  }
}

function save(store: FileStore): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // 存储不可用（隐私模式等）时仅内存持有，不影响请求流程
  }
}

let store: FileStore = load()

// 外部（neteaseService）显式设置协议包需要的种子文件内容
export function setProtocolFile(name: string, content: string): void {
  store[name] = content
  save(store)
}

export function getProtocolFile(name: string): string | undefined {
  return store[name]
}

export function existsSync(p: string): boolean {
  return p.includes('anonymous_token') || p.includes('xeapi_public_key')
}

export function readFileSync(p: string, encoding?: string): string {
  const content =
    (p.includes('china_ip_ranges.txt') && CHINA_IP_RANGES_CONTENT) ||
    (p.includes('anonymous_token') && store['anonymous_token']) ||
    (p.includes('xeapi_public_key') && store['xeapi_public_key']) ||
    ''
  if (encoding === 'utf-8' || encoding === 'utf8') return content
  return content
}

export function writeFileSync(p: string, data: string, encoding?: string): void {
  if (p.includes('anonymous_token')) {
    store['anonymous_token'] = String(data)
    save(store)
  } else if (p.includes('xeapi_public_key')) {
    store['xeapi_public_key'] = String(data)
    save(store)
  }
}

export function readdirSync(): string[] {
  return []
}

// 上传类模块（cloud/voice_upload，构建期已排除）专用；浏览器端不支持
export const promises = {
  stat: async (): Promise<never> => {
    throw new Error('fs.promises is unavailable in the browser protocol shim')
  },
  open: async (): Promise<never> => {
    throw new Error('fs.promises is unavailable in the browser protocol shim')
  },
}

export function createReadStream(): never {
  throw new Error('createReadStream is unavailable in the browser protocol shim')
}
