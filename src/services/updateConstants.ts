/**
 * 更新清单多源地址（TV / PC / 网页共用同一协议）。
 *
 * 网络现实：国内用户大多无法裸连 GitHub，也没有自建服务器。
 * 因此按"ghproxy 加速的 GitHub → GitHub 直连"顺序尝试。
 */

/** 更新清单（update.json，版本无关的固定地址）的多源候选 */
export const UPDATE_MANIFEST_URLS = [
  'https://ghproxy.net/https://raw.githubusercontent.com/SoundFieldLab/HyperPlayer/main/update.json',
  'https://raw.githubusercontent.com/SoundFieldLab/HyperPlayer/main/update.json',
]

/** GitHub 下载加速前缀（ghproxy 系列，按顺序尝试） */
export const GITHUB_DOWNLOAD_PROXIES = ['https://ghproxy.net/', 'https://mirror.ghproxy.com/']

/**
 * 把产物下载地址展开为多源候选：先加 ghproxy 加速，最后 GitHub 直连。
 */
export function withDownloadProxies(url: string): string[] {
  const proxied = GITHUB_DOWNLOAD_PROXIES.map((p) => p + url)
  return [...proxied, url]
}

/** 更新清单结构（publish-release.mjs 生成） */
export interface UpdateManifest {
  version?: string
  androidVersionCode?: number
  notes?: string
  artifacts?: Record<string, { urls?: string[]; sha256?: string }>
}

export const RELEASES_URL = 'https://github.com/SoundFieldLab/HyperPlayer/releases'

/** 逐个源拉取更新清单，任一成功即返回；全部失败返回 null。 */
export async function fetchUpdateManifest(): Promise<UpdateManifest | null> {
  for (const url of UPDATE_MANIFEST_URLS) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (res.ok) return (await res.json()) as UpdateManifest
    } catch {
      // 尝试下一个源
    }
  }
  return null
}

/** 语义化版本比较：a > b 返回正数，相等 0，a < b 负数（支持 0.2.0 / v0.2.0 前缀）。 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da - db
  }
  return 0
}
