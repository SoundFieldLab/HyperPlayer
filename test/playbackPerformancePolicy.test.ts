import { describe, expect, it } from 'vitest'
import {
  clampMvBlur,
  isGpuSoftwareCompositing,
  resolveDioramaRenderQuality,
  resolveMvBackgroundQuality,
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

  it('disables Diorama post-processing for software composition and MV overlay', () => {
    expect(resolveDioramaRenderQuality({ mvBackgroundActive: false, gpuSoftwareCompositing: false })).toEqual({
      dpr: [1, 2], postFx: true, lightweightScene: false,
    })
    expect(resolveDioramaRenderQuality({ mvBackgroundActive: true, gpuSoftwareCompositing: false })).toEqual({
      dpr: [1, 1.25], postFx: false, lightweightScene: true,
    })
    expect(resolveDioramaRenderQuality({ mvBackgroundActive: false, gpuSoftwareCompositing: true })).toEqual({
      dpr: [1, 1], postFx: false, lightweightScene: true,
    })
  })

  it('clamps MV blur values before creating full-screen filters', () => {
    expect(clampMvBlur(-4)).toBe(0)
    expect(clampMvBlur(12.5)).toBe(12.5)
    expect(clampMvBlur(999)).toBe(100)
    expect(clampMvBlur(Number.NaN)).toBe(0)
  })
})
