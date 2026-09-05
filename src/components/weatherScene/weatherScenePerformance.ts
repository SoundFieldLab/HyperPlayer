export type WeatherSceneQuality = 'high' | 'balanced' | 'low' | 'fallback'

export interface WeatherSceneQualityPreset {
  fps: 60 | 30
  dprCap: number
  particleRatio: number
}

export const WEATHER_SCENE_QUALITY: Record<WeatherSceneQuality, WeatherSceneQualityPreset> = {
  high: { fps: 60, dprCap: 2, particleRatio: 1 },
  balanced: { fps: 60, dprCap: 1.5, particleRatio: 0.85 },
  low: { fps: 30, dprCap: 1, particleRatio: 0.65 },
  fallback: { fps: 30, dprCap: 0.85, particleRatio: 0.5 },
}

const QUALITY_ORDER: WeatherSceneQuality[] = ['high', 'balanced', 'low', 'fallback']

export interface WeatherScenePerformanceState {
  quality: WeatherSceneQuality
  overloadedWindows: number
  healthyWindows: number
}

export const createWeatherScenePerformanceState = (): WeatherScenePerformanceState => ({
  quality: 'high',
  overloadedWindows: 0,
  healthyWindows: 0,
})

export function updateWeatherScenePerformance(
  state: WeatherScenePerformanceState,
  renderCosts: number[],
  deliveredFrames: number,
  elapsedMs = 1000,
): WeatherScenePerformanceState {
  if (renderCosts.length === 0) return { ...state, overloadedWindows: 0, healthyWindows: 0 }
  const sorted = [...renderCosts].sort((a, b) => a - b)
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
  const preset = WEATHER_SCENE_QUALITY[state.quality]
  const deliveredFps = deliveredFrames / Math.max(0.001, elapsedMs / 1000)
  const overloaded = p90 > 10 || deliveredFps < preset.fps * 0.82
  const healthy = p90 < 6 && deliveredFps >= preset.fps * 0.94
  const overloadedWindows = overloaded ? state.overloadedWindows + 1 : 0
  const healthyWindows = healthy ? state.healthyWindows + 1 : 0
  const index = QUALITY_ORDER.indexOf(state.quality)

  if (overloadedWindows >= 3 && index < QUALITY_ORDER.length - 1) {
    return { quality: QUALITY_ORDER[index + 1], overloadedWindows: 0, healthyWindows: 0 }
  }
  if (healthyWindows >= 8 && index > 0) {
    return { quality: QUALITY_ORDER[index - 1], overloadedWindows: 0, healthyWindows: 0 }
  }
  return { quality: state.quality, overloadedWindows, healthyWindows }
}

export const shouldRenderWeatherFrame = (now: number, nextFrameAt: number, fps: number) => now + 0.5 >= nextFrameAt || nextFrameAt === 0

export const advanceWeatherFrameDeadline = (now: number, nextFrameAt: number, fps: number) => {
  const interval = 1000 / fps
  return nextFrameAt === 0 ? now + interval : Math.max(nextFrameAt + interval, now + interval * 0.2)
}
