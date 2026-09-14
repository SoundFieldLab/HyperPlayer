/**
 * 平台常量（HyperPlayer）。
 *
 * 本文件只负责区分「桌面（Electron）」与「纯浏览器（web）」两种运行形态。
 * Android / TV 形态已随减配整体剥离，相关判定与 TV DPI 缩放 API 一并移除。
 */
export type PlatformKind = 'desktop' | 'web'

let cachedKind: PlatformKind | null = null

/** 桌面/浏览器判定：存在 Electron 桥视为桌面，否则视为 web。 */
export function detectPlatform(): PlatformKind {
  if (cachedKind) return cachedKind
  if (typeof navigator === 'undefined') {
    cachedKind = 'desktop'
    return cachedKind
  }
  const hasElectron = typeof window !== 'undefined' && Boolean((window as any).electron?.system)
  cachedKind = hasElectron ? 'desktop' : 'web'
  return cachedKind
}

export const getPlatform = detectPlatform
export const isDesktop = () => detectPlatform() === 'desktop'
