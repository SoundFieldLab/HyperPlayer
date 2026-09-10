import { describe, expect, it } from 'vitest'
import { WEATHER_DEBUG_SCENARIOS, createWeatherDebugSnapshot } from '../src/weather-debug/scenarios'
import { createAppleWeatherSceneModel } from '../src/components/weatherScene/weatherSceneModel'

describe('weather debug scenarios', () => {
  it('covers the nine supported weather scene kinds in both day and night', () => {
    expect(WEATHER_DEBUG_SCENARIOS).toHaveLength(9)
    for (const scenario of WEATHER_DEBUG_SCENARIOS) {
      expect(createAppleWeatherSceneModel(createWeatherDebugSnapshot(scenario.id, true)).id).toBe(`${scenario.id}-day`)
      expect(createAppleWeatherSceneModel(createWeatherDebugSnapshot(scenario.id, false)).id).toBe(`${scenario.id}-night`)
    }
  })

  it('generates a complete API-free forecast payload for each preview', () => {
    const rain = createWeatherDebugSnapshot('rain', true)
    const snow = createWeatherDebugSnapshot('snow', false)
    const thunder = createWeatherDebugSnapshot('thunder', true)
    expect(rain.hourly).toHaveLength(25)
    expect(rain.daily).toHaveLength(10)
    expect(rain.current.precipitation).toBeGreaterThan(0)
    expect(snow.hourly[0].snowfall).toBeGreaterThan(0)
    expect(thunder.current.windGusts).toBeGreaterThan(thunder.current.windSpeed)
    expect(rain.alerts).toEqual([])
    expect(rain.airQuality).toBeNull()
  })
})
