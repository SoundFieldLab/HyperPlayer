/**
 * 平台常量（WaveForge 减配版）。
 *
 * 原实现区分桌面（Electron/Windows）、Android TV、Android 平板与纯浏览器。
 * 随着 Android/TV 形态整体剥离，本文件统一按「桌面版」语义实现，但**保留全部原有
 * 导出符号与签名**，使其余约 18 个调用点无需改动即可编译：
 *  - isTv() / isAndroid() / isTvModeActive() 恒为 false；
 *  - applyTvScale() / initPlatformUI() / setTvModeForced() 等为空实现（no-op）；
 *  - TV_SCALE_* 等常量保留，便于旧调用点继续引用（值不再生效）。
 */
export type PlatformKind = 'desktop' | 'android-tv' | 'android-tablet' | 'web'

let cachedKind: PlatformKind | null = null

/**
 * 桌面/浏览器判定：存在 Electron 桥视为桌面，否则视为 web。
 * Android/TV 分支已移除，不再返回 android-tv / android-tablet。
 */
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
/** Android 形态已剥离，恒为 false。 */
export const isAndroid = () => false
/** TV 形态已剥离，恒为 false。 */
export const isTv = () => false

/**
 * TV UI 是否激活：TV 形态已剥离，恒为 false。
 * 保留签名供旧调用点（App/DesktopView/HomeView 等）继续使用。
 */
export function isTvModeActive(): boolean {
  return false
}

export const TV_SCALE_KEY = 'waveforge:tv-scale'

/** TV 强制模式开关：TV 形态已剥离，恒为 false（不再读取 localStorage / ?tv=1）。 */
export function isTvModeForced(): boolean {
  return false
}

/** TV 强制模式开关：空实现（no-op）。 */
export function setTvModeForced(on: boolean): void {
  void on
}

/**
 * 在 <html> 上标记平台（data-platform / tv-mode）：TV 形态已剥离，空实现（no-op）。
 */
export function initPlatformUI(): void {}

// ── TV DPI 缩放（常量与签名保留，实现为空）──
// 保留档位常量，便于设置面板等旧调用点继续引用；缩放本身不再生效。
export const TV_SCALE_OPTIONS = [60, 80, 100, 125, 150, 175] as const

/** TV 缩放档位读取：桌面版恒为默认 100。 */
export function getTvScale(): number {
  return 100
}

/** TV 缩放档位设置：空实现（no-op）。 */
export function setTvScale(scale: number): void {
  void scale
}

/** 保留常量（原 TV 布局基准视口宽）。 */
export const TV_BASELINE_VIEWPORT = 2133

/** TV DPI 缩放应用：空实现（no-op），不再改写 viewport / CSS 变量。 */
export function applyTvScale(scale?: number): void {
  void scale
}
