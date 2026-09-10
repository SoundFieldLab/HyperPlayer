import type { WeatherSnapshot } from '../../services/weatherService'
import { getWeatherVisualTheme, type WeatherSceneKind } from '../weatherVisualTheme'

export interface AppleWeatherSceneModel {
  id: `${WeatherSceneKind}-${'day' | 'night'}`
  kind: WeatherSceneKind
  isDay: boolean
  cloudCover: number
  precipitation: number
  snowfall: number
  windSpeed: number
  windDirection: number
  seed: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

const hashSeed = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function createAppleWeatherSceneModel(weather: WeatherSnapshot): AppleWeatherSceneModel {
  const theme = getWeatherVisualTheme(weather.current.weatherCode, weather.current.isDay)
  const nearestHour = weather.hourly.find(hour => hour.time >= weather.current.time) ?? weather.hourly[0]
  return {
    id: `${theme.kind}-${theme.isDay ? 'day' : 'night'}`,
    kind: theme.kind,
    isDay: theme.isDay,
    cloudCover: clamp(weather.current.cloudCover, 0, 100),
    precipitation: clamp(Math.max(weather.current.precipitation, nearestHour?.precipitation ?? 0), 0, 30),
    snowfall: clamp(nearestHour?.snowfall ?? 0, 0, 20),
    windSpeed: clamp(weather.current.windSpeed, 0, 180),
    windDirection: ((weather.current.windDirection % 360) + 360) % 360,
    seed: hashSeed(`${weather.location.latitude}:${weather.location.longitude}:${theme.kind}`),
  }
}
