import { describe, expect, it } from 'vitest'
import { advanceWeatherFrameDeadline, createWeatherScenePerformanceState, shouldRenderWeatherFrame, updateWeatherScenePerformance } from '../src/components/weatherScene/weatherScenePerformance'

describe('weather scene adaptive performance', () => {
  it('downgrades only after three overloaded windows', () => {
    let state = createWeatherScenePerformanceState()
    state = updateWeatherScenePerformance(state, [12], 40)
    state = updateWeatherScenePerformance(state, [12], 40)
    expect(state.quality).toBe('high')
    state = updateWeatherScenePerformance(state, [12], 40)
    expect(state.quality).toBe('balanced')
  })

  it('recovers only after eight healthy windows', () => {
    let state = { quality: 'low' as const, overloadedWindows: 0, healthyWindows: 0 }
    for (let index = 0; index < 7; index += 1) state = updateWeatherScenePerformance(state, [2, 3, 4], 60) as typeof state
    expect(state.quality).toBe('low')
    state = updateWeatherScenePerformance(state, [2, 3, 4], 60) as typeof state
    expect(state.quality).toBe('balanced')
  })

  it('keeps a 30Hz device stable in the 30Hz low tier', () => {
    const state = updateWeatherScenePerformance({ quality: 'low', overloadedWindows: 0, healthyWindows: 0 }, [2, 3], 30, 1000)
    expect(state.quality).toBe('low')
  })

  it('caps a high refresh callback stream at about 60 frames', () => {
    let deadline = 0
    let rendered = 0
    for (let now = 0; now < 1000; now += 1000 / 240) {
      if (!shouldRenderWeatherFrame(now, deadline, 60)) continue
      rendered += 1
      deadline = advanceWeatherFrameDeadline(now, deadline, 60)
    }
    expect(rendered).toBeGreaterThanOrEqual(58)
    expect(rendered).toBeLessThanOrEqual(61)
  })
})
