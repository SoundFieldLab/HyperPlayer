import { describe, expect, it } from 'vitest'
import {
  clampMvBlur,
  isGpuSoftwareCompositing,
  MV_BACKGROUND_STARTUP_QUALITY,
  resolveMvBackgroundQuality,
  resolveMvBackgroundStartupQuality,
} from '../src/services/playbackPerformancePolicy'

describe('playback performance policy', () => {
  it('recognizes software GPU paths', () => {
    expect(isGpuSoftwareCompositing({ gpu_compositing: 'disabled_software', webgl: 'enabled' })).toBe(true)
    expect(isGpuSoftwareCompositing({ gpu_compositing: 'enabled', webgl: 'disabled' })).toBe(true)
    expect(isGpuSoftwareCompositing({ gpu_compositing: 'enabled', webgl: 'enabled' })).toBe(false)
  })

  it('keeps background MV within the 1080P plus account-negotiated tier', () => {
    expect(resolveMvBackgroundQuality()).toBe(112)
  })

  it('starts the background MV at a low-bandwidth tier below the upgrade ceiling', () => {
    // 带宽保障：起步低档（480P）给歌曲音频让路，音频缓冲健康后再升档
    expect(resolveMvBackgroundStartupQuality()).toBe(MV_BACKGROUND_STARTUP_QUALITY)
    expect(MV_BACKGROUND_STARTUP_QUALITY).toBeLessThan(resolveMvBackgroundQuality())
  })

  it('clamps MV blur values before creating full-screen filters', () => {
    expect(clampMvBlur(-4)).toBe(0)
    expect(clampMvBlur(12.5)).toBe(12.5)
    expect(clampMvBlur(999)).toBe(100)
    expect(clampMvBlur(Number.NaN)).toBe(0)
  })
})
