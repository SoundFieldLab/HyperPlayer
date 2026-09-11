/**
 * 更新清单与「更新渠道」。
 *
 * 两条更新渠道：
 *   - stable（正式版）：拉取 main 分支的 update.json —— 由 pre-release.yml 在发布
 *     **纯语义版本号**（如 1.0.0）时生成并提交，是推送给所有普通用户的通道。
 *   - nightly（每日构建）：拉取 main 分支的 update-nightly.json —— 由 nightly.yml
 *     每次构建后生成并提交，指向当天的 pre-release。只有主动切换渠道的用户才会收到。
 *
 * 两个清单都是「版本无关的固定地址」，与具体 release/tag 无关：
 * 清单内部各自指向对应的 release 产物（正式版 tag / nightly-<日期> pre-release）。
 * 因此切换渠道 = 切换拉取的清单文件，无需知道 tag 命名细节。
 *
 * 网络现实：国内用户大多无法裸连 GitHub，也没有自建服务器。
 * 因此按「ghproxy 加速的 GitHub → GitHub 直连」顺序尝试。
 */

/** 更新渠道标识 */
export type UpdateChannel = 'stable' | 'nightly'

/** 渠道设置的 localStorage 键（与设置注册表 / SettingsPanel 同键） */
export const UPDATE_CHANNEL_KEY = 'hyperplayer:update-channel'

/** 默认渠道：正式版（普通用户不应被动收到测试版） */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable'

const RAW_BASE = 'https://raw.githubusercontent.com/SoundFieldLab/HyperPlayer/main'
/** ghproxy 只作用于 raw 直链前缀，用于绕过国内直连 GitHub 的不稳定 */
const GH_PROXY = 'https://ghproxy.net/'

/** 静态 import.meta.env 之外，保持与旧行为一致的「代理优先、直连兜底」顺序 */
function withProxyFirst(rawUrl: string): string[] {
  return [`${GH_PROXY}${rawUrl}`, rawUrl]
}

/** 各渠道的清单文件名（版本无关的固定地址） */
const MANIFEST_FILE: Record<UpdateChannel, string> = {
  stable: 'update.json',
  nightly: 'update-nightly.json',
}

/** 读取当前更新渠道（无存储 / 非法值 → 默认正式版） */
export function readUpdateChannel(): UpdateChannel {
  try {
    const raw = localStorage.getItem(UPDATE_CHANNEL_KEY)
    return raw === 'nightly' ? 'nightly' : DEFAULT_UPDATE_CHANNEL
  } catch {
    return DEFAULT_UPDATE_CHANNEL
  }
}

/** 写入更新渠道（供设置 UI 调用） */
export function writeUpdateChannel(channel: UpdateChannel): void {
  try {
    localStorage.setItem(UPDATE_CHANNEL_KEY, channel === 'nightly' ? 'nightly' : 'stable')
  } catch {
    // ignore
  }
}

/** 渠道展示名（UI 文案唯一事实源） */
export const UPDATE_CHANNEL_LABEL: Record<UpdateChannel, string> = {
  stable: '正式版',
  nightly: '每日构建（Nightly）',
}

/** 取某渠道的清单多源候选地址（代理优先 → 直连兜底） */
export function getManifestUrls(channel: UpdateChannel = readUpdateChannel()): string[] {
  return withProxyFirst(`${RAW_BASE}/${MANIFEST_FILE[channel]}`)
}

/** GitHub 下载加速前缀（ghproxy 系列，按顺序尝试） */
export const GITHUB_DOWNLOAD_PROXIES = ['https://ghproxy.net/', 'https://mirror.ghproxy.com/']

/**
 * 把产物下载地址展开为多源候选：先加 ghproxy 加速，最后 GitHub 直连。
 */
export function withDownloadProxies(url: string): string[] {
  const proxied = GITHUB_DOWNLOAD_PROXIES.map((p) => p + url)
  return [...proxied, url]
}

/** 更新清单结构（由 CI 工作流生成：pre-release.yml → update.json / nightly.yml → update-nightly.json） */
export interface UpdateManifest {
  /** 渠道标识：stable = 正式版清单，nightly = 每日构建清单 */
  channel?: UpdateChannel
  version?: string
  androidVersionCode?: number
  notes?: string
  artifacts?: Record<string, { urls?: string[]; sha256?: string }>
}

export const RELEASES_URL = 'https://github.com/SoundFieldLab/HyperPlayer/releases'

/**
 * 逐个源拉取指定渠道的更新清单，任一成功即返回；全部失败返回 null。
 * 不传渠道时读取用户当前设置（默认正式版）。
 */
export async function fetchUpdateManifest(channel: UpdateChannel = readUpdateChannel()): Promise<UpdateManifest | null> {
  for (const url of getManifestUrls(channel)) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (res.ok) return (await res.json()) as UpdateManifest
    } catch {
      // 尝试下一个源
    }
  }
  return null
}

/**
 * 解析版本号为可比较的片段。
 *
 * 兼容三类写法：
 *   `1.0.0`                → { nums: [1,0,0], pre: [] }
 *   `v1.0.1`               → { nums: [1,0,1], pre: [] }
 *   `1.0.1-nightly.20260911` → { nums: [1,0,1], pre: ['nightly','20260911'] }
 *
 * 预发布后缀按 semver 规则处理：**有预发布 < 无预发布**（1.0.1-nightly < 1.0.1），
 * 从而保证「正式版 1.0.0 用户切到 nightly 渠道」能检测到 1.0.1-nightly（patch 已 +1）。
 */
function parseVersionParts(version: string): { nums: number[]; pre: string[] } {
  const clean = String(version || '').trim().replace(/^v/i, '')
  // 先按 build 元数据（+）截断，再分离预发布（-）
  const withoutBuild = clean.split('+')[0]
  const dashIndex = withoutBuild.indexOf('-')
  const corePart = dashIndex >= 0 ? withoutBuild.slice(0, dashIndex) : withoutBuild
  const prePart = dashIndex >= 0 ? withoutBuild.slice(dashIndex + 1) : ''
  const nums = corePart.split('.').map((n) => parseInt(n, 10) || 0)
  const pre = prePart ? prePart.split('.').filter(Boolean) : []
  return { nums, pre }
}

/**
 * 比较两个预发布标识片段（semver 规则）：
 *   - 数字标识按数值比，数字 < 字母
 *   - 标识少者更小（1.0.1-beta < 1.0.1-beta.1）
 */
function comparePreIdentifiers(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx > dy ? 1 : -1
    } else if (xNum !== yNum) {
      // 数字标识优先级低于字母标识
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

/**
 * 语义化版本比较：a > b 返回正数，相等 0，a < b 负数。
 *
 * 支持 `1.0.0` / `v1.0.0` / `1.0.1-nightly.20260911` 等写法，
 * 且遵循 semver 预发布规则（1.0.1-nightly < 1.0.1）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const da = pa.nums[i] || 0
    const db = pb.nums[i] || 0
    if (da !== db) return da - db
  }
  // 核心版本号相同：无预发布 > 有预发布
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  return comparePreIdentifiers(pa.pre, pb.pre)
}
