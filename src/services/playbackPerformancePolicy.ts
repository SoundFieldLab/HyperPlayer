export type GpuFeatureStatus = {
  gpu_compositing?: string
  webgl?: string
} | null | undefined

export function isGpuSoftwareCompositing(featureStatus: GpuFeatureStatus): boolean {
  return featureStatus?.gpu_compositing === 'disabled_software'
    || featureStatus?.gpu_compositing === 'disabled'
    || featureStatus?.webgl === 'disabled_software'
    || featureStatus?.webgl === 'disabled'
}

/**
 * MV 背景「低清起步 → 音频稳定后升清」的带宽保障策略（歌曲音频优先）：
 * 切歌头几秒歌曲音频正在抢下行缓冲，背景视频以低档（480P，约 1/4-1/6 码率）快速起画让路；
 * 音频向前缓冲充足后由 BilibiliMvBackground 升档 watcher 无感切到高清（双槽交叉淡化）。
 */
export const MV_BACKGROUND_STARTUP_QUALITY = 32 // 480P：起步档，匿名/受限账号的实际可用档也在这附近
export const MV_BACKGROUND_TARGET_QUALITY = 112 // 升档上限：服务器按账号实际可用的最高档协商

export function resolveMvBackgroundStartupQuality(): number {
  return MV_BACKGROUND_STARTUP_QUALITY
}

export function resolveMvBackgroundQuality(): number {
  // The server negotiates the actual stream against the account's accepted qualities.
  // 112 yields 1080P+ for eligible members and automatically falls back to 1080P.
  return MV_BACKGROUND_TARGET_QUALITY
}

export function clampMvBlur(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, numeric))
}
