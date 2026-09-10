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

export function resolveMvBackgroundQuality(): number {
  // The server negotiates the actual stream against the account's accepted qualities.
  // 112 yields 1080P+ for eligible members and automatically falls back to 1080P.
  return 112
}

export function clampMvBlur(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, numeric))
}
