/**
 * 版本代号与对外展示。
 *
 * 版本编号起点：本仓库自 v1.0.0 起重新编号（减配 + 改名后的首个版本）。
 * 1.0 及以后统一沿用「澜 おおなみ」——即「波澜」的收束，不再按 minor 分配代号；
 * v1.0.0 之前的 0.x 代号系列（涟漪 / 潮汐 / 涌浪 …）已随旧版本号一并退役。
 */

export interface VersionCodename {
  zh: string
  ja: string
  romaji: string
}

/** 1.0 起的统一代号：澜（波澜的收束） */
const FORMAL_CODENAME: VersionCodename = { zh: '澜', ja: 'おおなみ', romaji: 'ōnami' }

/**
 * 发布通道标识。
 *
 * 项目当前处于测试阶段，所有对外版本均标记为「预览版」。
 * 唯一事实源在此处——关于页与文档都引用它，避免两处写死后互相矛盾。
 */
export const VERSION_CHANNEL_LABEL = '预览版'

/**
 * 取版本代号：1.0 起统一为「澜」；更早的 0.x 版本号已退役，返回 null。
 */
export function getVersionCodename(version: string): VersionCodename | null {
  const parts = String(version).replace(/^v/i, '').split('.')
  const major = parseInt(parts[0] || '', 10)
  if (!Number.isFinite(major)) return null
  return major >= 1 ? FORMAL_CODENAME : null
}

/** 对外展示：1.0.0「澜 おおなみ」 */
export function getVersionDisplay(version: string): string {
  const v = String(version).replace(/^v/i, '')
  const c = getVersionCodename(version)
  return c ? `${v}「${c.zh} ${c.ja}」` : v
}

/** 关于页展示：1.0.0「澜 おおなみ」 · 预览版 */
export function getVersionLabel(version: string): string {
  return `${getVersionDisplay(version)} · ${VERSION_CHANNEL_LABEL}`
}
