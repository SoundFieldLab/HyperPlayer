import { describe, expect, it } from 'vitest'
import { getAppleMoonPhaseFrames } from '../src/components/weatherScene/appleMoonPhases'

describe('Apple moon phase interpolation', () => {
  it.each([
    [0, 0], [0.25, 7], [0.5, 14], [0.75, 21], [1, 0],
  ])('maps phase %f to frame %i', (phase, frame) => {
    expect(getAppleMoonPhaseFrames(phase)).toMatchObject({ lower: frame, mix: 0 })
  })

  it('crossfades cyclically from frame 27 to frame 0', () => {
    const frames = getAppleMoonPhaseFrames(27.5 / 28)
    expect(frames.lower).toBe(27)
    expect(frames.upper).toBe(0)
    expect(frames.mix).toBeCloseTo(0.5)
  })

  it('normalizes invalid and negative phases', () => {
    expect(getAppleMoonPhaseFrames(Number.NaN).lower).toBe(0)
       expect(getAppleMoonPhaseFrames(-0.25).lower).toBe(21)
  })
})
