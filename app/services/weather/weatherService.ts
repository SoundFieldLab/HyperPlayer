// 天气服务（D35 Q20）：TS 完整实现，外部请求走 tauri-plugin-http。
// 定位：设置页/侧栏的天气卡（深圳）。接口：open-meteo（免费、无 key、
// HTTPS 任意域由 D35 Q19 放开）；失败返回上次缓存或 unavailable。

import { fetch } from '@tauri-apps/plugin-http'
import type { ShenzhenWeatherDto } from '../../bridge/contracts'

const SHENZHEN_LAT = 22.5431
const SHENZHEN_LON = 114.0579
const CACHE_KEY = 'hyperplayer.weather.shenzhen.v1'
const WEATHER_CODE_TEXT: Record<number, string> = {
  0: '晴', 1: '基本晴朗', 2: '局部多云', 3: '阴',
  45: '雾', 48: '雾凇', 51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪',
  80: '小阵雨', 81: '中阵雨', 82: '强阵雨', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
}

function readCache(): ShenzhenWeatherDto | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as ShenzhenWeatherDto) : null
  } catch {
    return null
  }
}

function writeCache(value: ShenzhenWeatherDto): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value))
  } catch {
    // 忽略
  }
}

export class WeatherService {
  async shenzhen(): Promise<ShenzhenWeatherDto> {
    const cached = readCache()
    if (cached && Date.now() - cached.updatedAtMs < 30 * 60 * 1000) return cached
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${SHENZHEN_LAT}&longitude=${SHENZHEN_LON}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day,wind_speed_10m&timezone=Asia%2FShanghai`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`weather request failed: ${response.status}`)
      const data = (await response.json()) as {
        current?: {
          temperature_2m?: number
          relative_humidity_2m?: number
          apparent_temperature?: number
          weather_code?: number
          is_day?: number
          wind_speed_10m?: number
        }
      }
      const current = data.current ?? {}
      const weatherCode = Number(current.weather_code ?? 0)
      const description = WEATHER_CODE_TEXT[weatherCode] ?? '未知'
      const value: ShenzhenWeatherDto = {
        temperatureC: Number(current.temperature_2m ?? 0),
        humidityPercent: Number(current.relative_humidity_2m ?? 0),
        weatherCode,
        description,
        updatedAtMs: Date.now(),
        isDay: Number(current.is_day ?? 1) === 1,
        condition: description,
        apparentTemperatureC: Number(current.apparent_temperature ?? current.temperature_2m ?? 0),
        relativeHumidityPercent: Number(current.relative_humidity_2m ?? 0),
        windSpeedKmh: Number(current.wind_speed_10m ?? 0),
      }
      writeCache(value)
      return value
    } catch {
      if (cached) return cached
      throw new Error('天气服务不可用')
    }
  }
}

export const weatherService = new WeatherService()
