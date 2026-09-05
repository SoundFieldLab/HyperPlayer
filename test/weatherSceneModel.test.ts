import { describe, expect, it } from 'vitest'
import { createAppleWeatherSceneModel } from '../src/components/weatherScene/weatherSceneModel'
import type { WeatherSnapshot } from '../src/services/weatherService'

const makeWeather = (weatherCode: number, isDay: boolean): WeatherSnapshot => ({
  location: { name: 'Test', country: 'Test', countryCode: 'TS', province: '', city: '', district: '', latitude: 31.2, longitude: 121.5, source: 'manual' },
  timezone: 'Asia/Shanghai',
  current: {
    time: '2026-09-04T12:00', temperature: 25, apparentTemperature: 26, humidity: 70, weatherCode, isDay,
    windSpeed: 12, windDirection: 370, windGusts: 18, pressure: 1012, visibility: 10000, precipitation: 0.5, cloudCover: 55,
  },
  hourly: [{
    time: '2026-09-04T12:00', temperature: 25, apparentTemperature: 26, precipitationProbability: 50, precipitation: 0.8,
    snowfall: 1.2, weatherCode, windSpeed: 12, windGusts: 18, visibility: 10000, uvIndex: 4, humidity: 70, pressure: 1012,
    dewPoint: 18, cloudCover: 55,
  }],
  daily: [], alerts: [], airQuality: null, updatedAt: 0,
})

describe('Apple weather scene model', () => {
  it.each([
    [0, 'clear'], [2, 'partly-cloudy'], [3, 'cloudy'], [45, 'fog'], [51, 'drizzle'], [63, 'rain'], [65, 'heavy-rain'], [75, 'snow'], [95, 'thunder'],
  ])('maps WMO %i to the Apple %s scene', (code, kind) => {
    expect(createAppleWeatherSceneModel(makeWeather(code, true))).toMatchObject({ id: `${kind}-day`, kind, isDay: true })
    expect(createAppleWeatherSceneModel(makeWeather(code, false))).toMatchObject({ id: `${kind}-night`, kind, isDay: false })
  })

  it('uses forecast intensity and creates a stable location seed', () => {
    const first = createAppleWeatherSceneModel(makeWeather(63, true))
    const second = createAppleWeatherSceneModel(makeWeather(63, true))
    expect(first.precipitation).toBe(0.8)
    expect(first.snowfall).toBe(1.2)
    expect(first.windDirection).toBe(10)
    expect(first.seed).toBe(second.seed)
  })
})
