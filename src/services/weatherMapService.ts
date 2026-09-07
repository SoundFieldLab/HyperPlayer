export type WeatherMapLayerId =
  | 'wind'
  | 'temperature'
  | 'humidity'
  | 'cloud'
  | 'pressure'
  | 'cape'
  | 'wave'
  | 'aurora'
  | 'snow'
  | 'dewPoint'
  | 'radar'
  | 'pm25'
  | 'fire'
  | 'solar'

export interface WeatherMapColorStop {
  value: number
  color: string
}

export interface WeatherMapLayerDefinition {
  id: WeatherMapLayerId
  label: string
  shortLabel: string
  unit: string
  min: number
  max: number
  decimals?: number
  colors: WeatherMapColorStop[]
  description: string
}

export interface WeatherMapPointValue {
  layer: WeatherMapLayerId
  value: number
  unit: string
  label: string
  latitude: number
  longitude: number
  hourOffset: number
  time: string
  source: 'forecast' | 'air-quality' | 'marine' | 'derived' | 'estimate'
  secondary?: string
}

export const WEATHER_MAP_LAYERS: WeatherMapLayerDefinition[] = [
  {
    id: 'wind', label: '风', shortLabel: '风速', unit: 'km/h', min: 0, max: 80,
    colors: [
      { value: 0, color: '#5b67c8' }, { value: 5, color: '#4b86cf' }, { value: 10, color: '#35a7c6' },
      { value: 20, color: '#42bd8b' }, { value: 30, color: '#b8cf4a' }, { value: 40, color: '#f1c53c' },
      { value: 55, color: '#ef7b38' }, { value: 70, color: '#d74655' }, { value: 80, color: '#8f3a86' },
    ],
    description: '10 米风速与风向',
  },
  {
    id: 'temperature', label: '温度', shortLabel: '温度', unit: '°C', min: -30, max: 45,
    colors: [
      { value: -30, color: '#7132a8' }, { value: -20, color: '#4651bd' }, { value: -10, color: '#347bd0' },
      { value: 0, color: '#39a9c4' }, { value: 10, color: '#5fbd91' }, { value: 20, color: '#b8cf57' },
      { value: 30, color: '#f2c645' }, { value: 40, color: '#ec7140' }, { value: 45, color: '#b9364a' },
    ],
    description: '地面 2 米气温',
  },
  {
    id: 'humidity', label: '相对湿度', shortLabel: '湿度', unit: '%', min: 0, max: 100,
    colors: [
      { value: 0, color: '#7c5f43' }, { value: 20, color: '#b08a4b' }, { value: 40, color: '#c9bd65' },
      { value: 60, color: '#74b88e' }, { value: 75, color: '#40a8ad' }, { value: 90, color: '#3977aa' },
      { value: 100, color: '#3e4f88' },
    ],
    description: '2 米相对湿度',
  },
  {
    id: 'cloud', label: '云量', shortLabel: '云量', unit: '%', min: 0, max: 100,
    colors: [
      { value: 0, color: '#6f8fae' }, { value: 15, color: '#879fb4' }, { value: 35, color: '#a8b5bf' },
      { value: 55, color: '#c4cbd0' }, { value: 75, color: '#dce0e3' }, { value: 90, color: '#eef0f2' },
      { value: 100, color: '#ffffff' },
    ],
    description: '总云量覆盖率',
  },
  {
    id: 'pressure', label: '压强', shortLabel: '气压', unit: 'hPa', min: 960, max: 1040,
    colors: [
      { value: 960, color: '#59449a' }, { value: 980, color: '#496bb1' }, { value: 995, color: '#408fae' },
      { value: 1005, color: '#55a590' }, { value: 1015, color: '#96b66a' }, { value: 1025, color: '#c9bd59' },
      { value: 1040, color: '#ce7552' },
    ],
    description: '地面气压',
  },
  {
    id: 'cape', label: '对流能量', shortLabel: '雷暴潜势', unit: 'J/kg', min: 0, max: 4000,
    colors: [{ value: 0, color: '#596b82' }, { value: 500, color: '#5fa269' }, { value: 1500, color: '#d6bc49' }, { value: 2500, color: '#e06b39' }, { value: 4000, color: '#8d244d' }],
    description: '对流有效位能（CAPE），数值越高越有利于雷暴发展',
  },
  {
    id: 'wave', label: '海浪高度', shortLabel: '浪高', unit: 'm', min: 0, max: 10,
    colors: [{ value: 0, color: '#397fb2' }, { value: 1.5, color: '#4fb9a1' }, { value: 3, color: '#d4c452' }, { value: 6, color: '#dc7044' }, { value: 10, color: '#6e326f' }],
    description: '海面有效波高',
  },
  {
    id: 'aurora', label: '极光概率', shortLabel: '极光', unit: '%', min: 0, max: 100,
    colors: [{ value: 0, color: '#27375b' }, { value: 25, color: '#2d7b80' }, { value: 55, color: '#4bbd78' }, { value: 80, color: '#b7de64' }, { value: 100, color: '#ec8be6' }],
    description: '基于纬度与时段的可见概率估计',
  },
  {
    id: 'snow', label: '雪深', shortLabel: '雪深', unit: 'cm', min: 0, max: 120,
    colors: [{ value: 0, color: '#577a93' }, { value: 10, color: '#a6d5df' }, { value: 35, color: '#eef8fb' }, { value: 75, color: '#bfc6f1' }, { value: 120, color: '#796cba' }],
    description: '地表积雪深度',
  },
  {
    id: 'dewPoint', label: '露点温度', shortLabel: '露点', unit: '°C', min: -30, max: 35,
    colors: [{ value: -30, color: '#52419a' }, { value: -10, color: '#397eb2' }, { value: 5, color: '#55ad92' }, { value: 20, color: '#d0c34e' }, { value: 35, color: '#d96a45' }],
    description: '2 米露点温度',
  },
  {
    id: 'radar', label: '雷达组合反射率', shortLabel: '雷达', unit: 'dBZ', min: 0, max: 70,
    colors: [{ value: 0, color: '#375386' }, { value: 10, color: '#3ba6c5' }, { value: 25, color: '#57bc67' }, { value: 40, color: '#e2d548' }, { value: 55, color: '#e15838' }, { value: 70, color: '#a5288e' }],
    description: '由逐小时降水强度换算的雷达表现',
  },
  {
    id: 'pm25', label: 'PM2.5', shortLabel: 'PM2.5', unit: 'μg/m³', min: 0, max: 250,
    colors: [{ value: 0, color: '#4eb77d' }, { value: 35, color: '#d4c844' }, { value: 75, color: '#e8983d' }, { value: 115, color: '#d95545' }, { value: 150, color: '#8f3b86' }, { value: 250, color: '#682f45' }],
    description: '细颗粒物浓度',
  },
  {
    id: 'fire', label: '森林火灾', shortLabel: '火险', unit: '指数', min: 0, max: 100,
    colors: [{ value: 0, color: '#387e75' }, { value: 25, color: '#83ae57' }, { value: 50, color: '#d5bd48' }, { value: 75, color: '#dc6b37' }, { value: 100, color: '#8e2c30' }],
    description: '基于温度、湿度、风速和降水的火险估计',
  },
  {
    id: 'solar', label: '太阳净辐照', shortLabel: '辐照', unit: 'W/m²', min: 0, max: 1000,
    colors: [{ value: 0, color: '#34456d' }, { value: 200, color: '#4d8ab1' }, { value: 450, color: '#71ad75' }, { value: 700, color: '#dbc44c' }, { value: 1000, color: '#e06b38' }],
    description: '短波太阳辐射',
  },
]

export const WEATHER_MAP_LAYER_BY_ID = Object.fromEntries(
  WEATHER_MAP_LAYERS.map(layer => [layer.id, layer]),
) as Record<WeatherMapLayerId, WeatherMapLayerDefinition>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const WEATHER_MAP_BASE_UTC_HOUR = (() => {
  const now = new Date()
  return now.getUTCHours() + now.getUTCMinutes() / 60
})()
const WEATHER_MAP_LAYER_SEED = Object.fromEntries(WEATHER_MAP_LAYERS.map((layer, index) => [layer.id, index + 1])) as Record<WeatherMapLayerId, number>

const longitudeDistance = (longitude: number, center: number) => {
  const distance = Math.abs(longitude - center) % 360
  return Math.min(distance, 360 - distance)
}

const pressureSystem = (
  latitude: number,
  longitude: number,
  centerLatitude: number,
  centerLongitude: number,
  latitudeRadius: number,
  longitudeRadius: number,
) => {
  const latitudeDistance = (latitude - centerLatitude) / latitudeRadius
  const wrappedLongitudeDistance = longitudeDistance(longitude, centerLongitude) / longitudeRadius
  return Math.exp(-(latitudeDistance * latitudeDistance + wrappedLongitudeDistance * wrappedLongitudeDistance) * 1.35)
}

const samplePressureField = (latitude: number, longitude: number, hourOffset: number) => {
  const phase = hourOffset / 24
  const lowEastAsia = pressureSystem(latitude, longitude, 35 + Math.sin(phase * 1.3) * 4, 122 + phase * 9, 18, 24)
  const highCentralAsia = pressureSystem(latitude, longitude, 43 + Math.cos(phase * .8) * 3, 82 + phase * 5, 22, 31)
  const lowNorthPacific = pressureSystem(latitude, longitude, 28 + Math.cos(phase * 1.1) * 5, 164 + phase * 7, 24, 35)
  const highIndianOcean = pressureSystem(latitude, longitude, 4 + Math.sin(phase) * 5, 92 + phase * 4, 27, 40)
  const planetaryWave = Math.sin((longitude - hourOffset * 1.4) * Math.PI / 58 + latitude * Math.PI / 95) * 3.2
    + Math.cos((latitude + hourOffset * .55) * Math.PI / 31 - longitude * Math.PI / 145) * 2.1
  const latitudeBand = Math.cos((Math.abs(latitude) - 32) * Math.PI / 52) * 1.8
  return clamp(1012 + highCentralAsia * 17 + highIndianOcean * 9 - lowEastAsia * 21 - lowNorthPacific * 15 + planetaryWave + latitudeBand, 960, 1040)
}

const hashNoise = (latitude: number, longitude: number, hourOffset: number, seed: number) => {
  const waveA = Math.sin((longitude + seed * 13.7 + hourOffset * 1.8) * Math.PI / 24)
  const waveB = Math.cos((latitude - seed * 7.3 - hourOffset * 1.25) * Math.PI / 18)
  const waveC = Math.sin((latitude + longitude * 0.72 + seed * 19 + hourOffset * 2.6) * Math.PI / 31)
  return (waveA * 0.46 + waveB * 0.34 + waveC * 0.2 + 1) / 2
}

/**
 * Generates a continuous visual field for the interactive map. Point clicks are
 * replaced with live forecast values whenever the public forecast endpoints respond.
 */
export function sampleWeatherMapField(layerId: WeatherMapLayerId, latitude: number, longitude: number, hourOffset: number) {
  if (layerId === 'pressure') return samplePressureField(latitude, longitude, hourOffset)
  const layer = WEATHER_MAP_LAYER_BY_ID[layerId]
  const noise = hashNoise(latitude, longitude, hourOffset, WEATHER_MAP_LAYER_SEED[layerId])
  const latitudeFactor = Math.abs(latitude) / 90
  const localHour = ((WEATHER_MAP_BASE_UTC_HOUR + longitude / 15 + hourOffset) % 24 + 24) % 24
  const daylight = Math.max(0, Math.sin(((localHour - 6) / 12) * Math.PI))
  let normalized = noise

  switch (layerId) {
    case 'temperature': normalized = clamp(0.78 - latitudeFactor * 0.78 + (daylight - 0.5) * 0.18 + (noise - 0.5) * 0.32, 0, 1); break
    case 'humidity': normalized = clamp(0.36 + noise * 0.48 + latitudeFactor * 0.08 - daylight * 0.12, 0, 1); break
    case 'cloud': normalized = clamp(noise * 0.82 + Math.sin(hourOffset / 7) * 0.12, 0, 1); break
    case 'cape': normalized = clamp((1 - latitudeFactor) * daylight * 0.76 + noise * 0.28, 0, 1); break
    case 'wave': normalized = clamp(0.08 + noise * 0.56 + latitudeFactor * 0.22, 0, 1); break
    case 'aurora': normalized = clamp((latitudeFactor - 0.48) * 2.1 + noise * 0.18, 0, 1); break
    case 'snow': normalized = clamp((latitudeFactor - 0.42) * 1.55 + (1 - daylight) * 0.08 + noise * 0.14, 0, 1); break
    case 'dewPoint': normalized = clamp(0.68 - latitudeFactor * 0.6 + noise * 0.25, 0, 1); break
    case 'radar': normalized = clamp(Math.pow(noise, 3.1), 0, 1); break
    case 'pm25': normalized = clamp(0.12 + noise * 0.58 + Math.max(0, 0.35 - latitudeFactor) * 0.18, 0, 1); break
    case 'fire': normalized = clamp(daylight * 0.42 + (1 - latitudeFactor) * 0.18 + noise * 0.46, 0, 1); break
    case 'solar': normalized = clamp(daylight * (0.78 + noise * 0.22), 0, 1); break
    case 'wind': normalized = clamp(0.14 + noise * 0.63 + latitudeFactor * 0.16, 0, 1); break
  }

  return layer.min + (layer.max - layer.min) * normalized
}

export interface WeatherMapWindVector {
  speed: number
  /** Eastward component in km/h. */
  u: number
  /** Northward component in km/h. */
  v: number
  /** Meteorological direction in degrees (where the wind comes from). */
  direction: number
}

export interface WeatherGridBounds {
  north: number
  south: number
  east: number
  west: number
}

export const WEATHER_GRID_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'cloud_cover',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'precipitation',
] as const

export type WeatherGridField = typeof WEATHER_GRID_FIELDS[number]

export interface WeatherGridFrame {
  time: string
  timestamp: number
  width: number
  height: number
  bounds: WeatherGridBounds
  values: Record<WeatherGridField, Float32Array>
}

export interface WeatherGrid {
  bounds: WeatherGridBounds
  width: number
  height: number
  latitudes: Float32Array
  longitudes: Float32Array
  frames: WeatherGridFrame[]
  fetchedAt: number
}

export interface WeatherGridFramePair {
  current: WeatherGridFrame
  next: WeatherGridFrame
  ratio: number
}

export interface WeatherGridWindVector extends WeatherMapWindVector {
  gust: number
}

/**
 * Produces a smooth, deterministic wind vector for the visual particle layer.
 * The direction follows the local pressure gradient, so streamlines bend around
 * pressure systems instead of moving as a flat CSS texture.
 */
export function sampleWeatherMapWindVector(latitude: number, longitude: number, hourOffset: number): WeatherMapWindVector {
  const delta = 0.42
  const eastGradient = sampleWeatherMapField('pressure', latitude, longitude + delta, hourOffset)
    - sampleWeatherMapField('pressure', latitude, longitude - delta, hourOffset)
  const northGradient = sampleWeatherMapField('pressure', latitude + delta, longitude, hourOffset)
    - sampleWeatherMapField('pressure', latitude - delta, longitude, hourOffset)
  const hemisphere = latitude >= 0 ? 1 : -1
  const prevailing = Math.cos(latitude * Math.PI / 180) * 0.34
  let directionEast = -northGradient * hemisphere + prevailing
  let directionNorth = eastGradient * hemisphere + Math.sin((longitude + hourOffset * 1.2) * Math.PI / 70) * 0.18
  const magnitude = Math.hypot(directionEast, directionNorth) || 1
  directionEast /= magnitude
  directionNorth /= magnitude
  const speed = sampleWeatherMapField('wind', latitude, longitude, hourOffset)
  const direction = (Math.atan2(-directionEast, -directionNorth) * 180 / Math.PI + 360) % 360
  return { speed, u: directionEast * speed, v: directionNorth * speed, direction }
}

const hexToRgb = (hex: string) => {
  const normalized = hex.replace('#', '')
  const value = Number.parseInt(normalized.length === 3
    ? normalized.split('').map(character => character + character).join('')
    : normalized, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function getWeatherMapColor(layerId: WeatherMapLayerId, value: number, alpha = 1) {
  const stops = WEATHER_MAP_LAYER_BY_ID[layerId].colors
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (value <= first.value) {
    const rgb = hexToRgb(first.color)
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
  }
  if (value >= last.value) {
    const rgb = hexToRgb(last.color)
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
  }
  const upperIndex = stops.findIndex(stop => stop.value >= value)
  const lower = stops[Math.max(0, upperIndex - 1)]
  const upper = stops[upperIndex]
  const ratio = (value - lower.value) / Math.max(0.0001, upper.value - lower.value)
  const from = hexToRgb(lower.color)
  const to = hexToRgb(upper.color)
  const r = Math.round(from.r + (to.r - from.r) * ratio)
  const g = Math.round(from.g + (to.g - from.g) * ratio)
  const b = Math.round(from.b + (to.b - from.b) * ratio)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface ForecastPayload {
  hourly?: Record<string, Array<number | string>> & { time?: string[] }
}

interface PointForecastBundle {
  data: ForecastPayload
  fetchedAt: number
}

const pointForecastCache = new Map<string, PointForecastBundle>()
const pointRequestCache = new Map<string, Promise<PointForecastBundle>>()
const POINT_CACHE_AGE = 10 * 60 * 1000
const POINT_CACHE_CAPACITY = 64

const pointKey = (latitude: number, longitude: number) => `${latitude.toFixed(2)}:${longitude.toFixed(2)}`

const getCachedForecastBundle = (key: string, now: number) => {
  const cached = pointForecastCache.get(key)
  if (!cached) return undefined
  if (now - cached.fetchedAt >= POINT_CACHE_AGE) {
    pointForecastCache.delete(key)
    return undefined
  }
  pointForecastCache.delete(key)
  pointForecastCache.set(key, cached)
  return cached
}

const cacheForecastBundle = (key: string, bundle: PointForecastBundle) => {
  const now = Date.now()
  for (const [cachedKey, cached] of pointForecastCache) {
    if (now - cached.fetchedAt >= POINT_CACHE_AGE) pointForecastCache.delete(cachedKey)
  }
  pointForecastCache.delete(key)
  pointForecastCache.set(key, bundle)
  while (pointForecastCache.size > POINT_CACHE_CAPACITY) {
    const oldestKey = pointForecastCache.keys().next().value
    if (oldestKey === undefined) break
    pointForecastCache.delete(oldestKey)
  }
}

const getForecastBundle = async (latitude: number, longitude: number, signal?: AbortSignal) => {
  const key = pointKey(latitude, longitude)
  const cached = getCachedForecastBundle(key, Date.now())
  if (cached) return cached
  const pending = pointRequestCache.get(key)
  if (pending) return pending

  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('hourly', [
    'temperature_2m', 'relative_humidity_2m', 'cloud_cover', 'surface_pressure', 'cape',
    'snow_depth', 'dew_point_2m', 'shortwave_radiation', 'wind_speed_10m',
    'wind_direction_10m', 'wind_gusts_10m', 'precipitation',
  ].join(','))
  url.searchParams.set('forecast_days', '3')
  url.searchParams.set('timezone', 'UTC')

  const request = fetch(url.toString(), { signal })
    .then(async response => {
      if (!response.ok) throw new Error('天气地图数据暂时不可用')
      return { data: await response.json() as ForecastPayload, fetchedAt: Date.now() }
    })
    .then(bundle => {
      cacheForecastBundle(key, bundle)
      return bundle
    })
    .finally(() => pointRequestCache.delete(key))
  pointRequestCache.set(key, request)
  return request
}

const findForecastIndex = (times: string[] = [], hourOffset: number) => {
  if (!times.length) return 0
  const target = Date.now() + hourOffset * 60 * 60 * 1000
  let bestIndex = 0
  let bestDifference = Number.POSITIVE_INFINITY
  times.forEach((time, index) => {
    const difference = Math.abs(new Date(`${time}Z`).getTime() - target)
    if (difference < bestDifference) {
      bestIndex = index
      bestDifference = difference
    }
  })
  return bestIndex
}

const valueAt = (hourly: ForecastPayload['hourly'], key: string, index: number) => {
  const value = Number(hourly?.[key]?.[index])
  return Number.isFinite(value) ? value : null
}

const fetchAirQualityValue = async (latitude: number, longitude: number, hourOffset: number, signal?: AbortSignal) => {
  const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('hourly', 'pm2_5')
  url.searchParams.set('forecast_days', '3')
  url.searchParams.set('timezone', 'UTC')
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('空气质量数据暂时不可用')
  const data = await response.json()
  const index = findForecastIndex(data.hourly?.time, hourOffset)
  return Number(data.hourly?.pm2_5?.[index])
}

const fetchWaveValue = async (latitude: number, longitude: number, hourOffset: number, signal?: AbortSignal) => {
  const url = new URL('https://marine-api.open-meteo.com/v1/marine')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('hourly', 'wave_height')
  url.searchParams.set('forecast_days', '3')
  url.searchParams.set('timezone', 'UTC')
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('海浪数据暂时不可用')
  const data = await response.json()
  const index = findForecastIndex(data.hourly?.time, hourOffset)
  return Number(data.hourly?.wave_height?.[index])
}

export async function fetchWeatherMapPointValue(
  layerId: WeatherMapLayerId,
  latitude: number,
  longitude: number,
  hourOffset: number,
  signal?: AbortSignal,
): Promise<WeatherMapPointValue> {
  const layer = WEATHER_MAP_LAYER_BY_ID[layerId]
  const fallback = sampleWeatherMapField(layerId, latitude, longitude, hourOffset)
  const targetTime = new Date(Date.now() + hourOffset * 60 * 60 * 1000).toISOString()

  try {
    if (layerId === 'pm25') {
      const value = await fetchAirQualityValue(latitude, longitude, hourOffset, signal)
      if (!Number.isFinite(value)) throw new Error('missing air-quality value')
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'air-quality' }
    }
    if (layerId === 'wave') {
      const value = await fetchWaveValue(latitude, longitude, hourOffset, signal)
      if (!Number.isFinite(value)) throw new Error('missing marine value')
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'marine' }
    }

    const bundle = await getForecastBundle(latitude, longitude, signal)
    const hourly = bundle.data.hourly
    const index = findForecastIndex(hourly?.time as string[] | undefined, hourOffset)
    const map: Partial<Record<WeatherMapLayerId, string>> = {
      wind: 'wind_speed_10m', temperature: 'temperature_2m', humidity: 'relative_humidity_2m',
      cloud: 'cloud_cover', pressure: 'surface_pressure', cape: 'cape', snow: 'snow_depth',
      dewPoint: 'dew_point_2m', solar: 'shortwave_radiation',
    }

    if (layerId === 'aurora') {
      return { layer: layerId, value: fallback, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'derived', secondary: '依据纬度与当前时段估计' }
    }

    if (layerId === 'radar') {
      const precipitation = valueAt(hourly, 'precipitation', index) ?? 0
      const value = precipitation <= 0 ? 0 : clamp(10 * Math.log10(200 * Math.pow(precipitation, 1.6)), 0, 70)
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'derived', secondary: `降水 ${precipitation.toFixed(1)} mm/h` }
    }

    if (layerId === 'fire') {
      const temperature = valueAt(hourly, 'temperature_2m', index) ?? 20
      const humidity = valueAt(hourly, 'relative_humidity_2m', index) ?? 60
      const wind = valueAt(hourly, 'wind_speed_10m', index) ?? 10
      const precipitation = valueAt(hourly, 'precipitation', index) ?? 0
      const value = clamp((temperature - 5) * 1.35 + (100 - humidity) * 0.48 + wind * 0.42 - precipitation * 13, 0, 100)
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'derived', secondary: '由温度、湿度、风速与降水推算' }
    }

    const key = map[layerId]
    let value = key ? valueAt(hourly, key, index) : null
    if (layerId === 'snow' && value !== null) value *= 100
    if (value === null) throw new Error('missing forecast value')
    const direction = layerId === 'wind' ? valueAt(hourly, 'wind_direction_10m', index) : null
    return {
      layer: layerId, value, unit: layer.unit, label: layer.shortLabel,
      latitude, longitude, hourOffset, time: targetTime, source: 'forecast',
      secondary: direction === null ? undefined : `风向 ${Math.round(direction)}°`,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      layer: layerId, value: fallback, unit: layer.unit, label: layer.shortLabel,
      latitude, longitude, hourOffset, time: targetTime, source: 'estimate',
      secondary: '网络数据不可用，显示本地场景估计',
    }
  }
}

const WEATHER_GRID_MAX_WIDTH = 8
const WEATHER_GRID_MAX_HEIGHT = 6
const WEATHER_GRID_HOURS = 49
const WEATHER_GRID_CACHE_AGE = 10 * 60 * 1000
const WEATHER_GRID_CACHE_CAPACITY = 12
const weatherGridCache = new Map<string, WeatherGrid>()
const weatherGridRequestCache = new Map<string, Promise<WeatherGrid>>()

type GridForecastPayload = ForecastPayload & {
  latitude?: number
  longitude?: number
}

const normalizeLongitude = (longitude: number) => {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180
  return normalized === -180 && longitude > 0 ? 180 : normalized
}

const longitudeSpan = (bounds: WeatherGridBounds) => {
  const raw = bounds.east - bounds.west
  return raw >= 0 ? Math.min(raw, 360) : ((raw % 360) + 360) % 360
}

const validateGridBounds = (bounds: WeatherGridBounds): WeatherGridBounds => {
  const values = [bounds.north, bounds.south, bounds.east, bounds.west]
  if (!values.every(Number.isFinite)) throw new Error('天气网格范围必须是有限数值')
  if (bounds.north <= bounds.south) throw new Error('天气网格北界必须大于南界')
  if (bounds.north > 90 || bounds.south < -90) throw new Error('天气网格纬度必须位于 -90 到 90 度之间')
  const span = longitudeSpan(bounds)
  if (span <= 0 || span >= 360) throw new Error('天气网格经度跨度必须大于 0 且小于 360 度')
  return { north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west }
}

const chooseGridSize = (bounds: WeatherGridBounds) => {
  const latitudeSpan = bounds.north - bounds.south
  const adjustedLongitudeSpan = longitudeSpan(bounds) * Math.max(0.15, Math.cos((bounds.north + bounds.south) / 2 * Math.PI / 180))
  const aspect = adjustedLongitudeSpan / latitudeSpan
  if (aspect >= WEATHER_GRID_MAX_WIDTH / WEATHER_GRID_MAX_HEIGHT) {
    return { width: WEATHER_GRID_MAX_WIDTH, height: Math.max(2, Math.min(WEATHER_GRID_MAX_HEIGHT, Math.round(WEATHER_GRID_MAX_WIDTH / aspect))) }
  }
  return { width: Math.max(2, Math.min(WEATHER_GRID_MAX_WIDTH, Math.round(WEATHER_GRID_MAX_HEIGHT * aspect))), height: WEATHER_GRID_MAX_HEIGHT }
}

const createGridCoordinates = (bounds: WeatherGridBounds, width: number, height: number) => {
  const latitudes = new Float32Array(width * height)
  const longitudes = new Float32Array(width * height)
  const span = longitudeSpan(bounds)
  for (let y = 0; y < height; y += 1) {
    const latitude = bounds.south + (bounds.north - bounds.south) * y / (height - 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      latitudes[index] = latitude
      longitudes[index] = normalizeLongitude(bounds.west + span * x / (width - 1))
    }
  }
  return { latitudes, longitudes }
}

const gridKey = (bounds: WeatherGridBounds, width: number, height: number) => [
  bounds.north, bounds.south, bounds.east, bounds.west,
].map(value => value.toFixed(4)).concat(`${width}x${height}`).join(':')

const getCachedWeatherGrid = (key: string, now: number) => {
  const cached = weatherGridCache.get(key)
  if (!cached) return undefined
  if (now - cached.fetchedAt >= WEATHER_GRID_CACHE_AGE) {
    weatherGridCache.delete(key)
    return undefined
  }
  weatherGridCache.delete(key)
  weatherGridCache.set(key, cached)
  return cached
}

const cacheWeatherGrid = (key: string, grid: WeatherGrid) => {
  const now = Date.now()
  for (const [cachedKey, cached] of weatherGridCache) {
    if (now - cached.fetchedAt >= WEATHER_GRID_CACHE_AGE) weatherGridCache.delete(cachedKey)
  }
  weatherGridCache.delete(key)
  weatherGridCache.set(key, grid)
  while (weatherGridCache.size > WEATHER_GRID_CACHE_CAPACITY) {
    const oldestKey = weatherGridCache.keys().next().value
    if (oldestKey === undefined) break
    weatherGridCache.delete(oldestKey)
  }
}

const parseGridTime = (time: string) => {
  const timestamp = Date.parse(time.endsWith('Z') ? time : `${time}Z`)
  if (!Number.isFinite(timestamp)) throw new Error(`天气网格包含无效时间: ${time}`)
  return timestamp
}

const parseWeatherGrid = (
  payload: GridForecastPayload | GridForecastPayload[],
  bounds: WeatherGridBounds,
  width: number,
  height: number,
  latitudes: Float32Array,
  longitudes: Float32Array,
): WeatherGrid => {
  const locations = Array.isArray(payload) ? payload : [payload]
  const pointCount = width * height
  if (locations.length !== pointCount) {
    throw new Error(`天气网格响应坐标数不匹配: 预期 ${pointCount}，实际 ${locations.length}`)
  }
  const times = locations[0]?.hourly?.time
  if (!Array.isArray(times) || times.length < WEATHER_GRID_HOURS) throw new Error('天气网格响应缺少未来 49 小时时间序列')
  const frameCount = WEATHER_GRID_HOURS
  const frames = Array.from({ length: frameCount }, (_, frameIndex): WeatherGridFrame => ({
    time: times[frameIndex],
    timestamp: parseGridTime(times[frameIndex]),
    width,
    height,
    bounds,
    values: Object.fromEntries(WEATHER_GRID_FIELDS.map(field => [field, new Float32Array(pointCount)])) as Record<WeatherGridField, Float32Array>,
  }))

  locations.forEach((location, pointIndex) => {
    const locationTimes = location.hourly?.time
    if (!Array.isArray(locationTimes) || locationTimes.length < frameCount) throw new Error(`天气网格坐标 ${pointIndex + 1} 缺少时间序列`)
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (locationTimes[frameIndex] !== times[frameIndex]) throw new Error('天气网格各坐标时间序列不一致')
      for (const field of WEATHER_GRID_FIELDS) {
        const rawValue = location.hourly?.[field]?.[frameIndex]
        const value = rawValue === null || rawValue === '' || rawValue === undefined ? Number.NaN : Number(rawValue)
        if (!Number.isFinite(value)) throw new Error(`天气网格字段 ${field} 在坐标 ${pointIndex + 1}、时次 ${frameIndex + 1} 无效`)
        frames[frameIndex].values[field][pointIndex] = value
      }
    }
  })

  return { bounds, width, height, latitudes, longitudes, frames, fetchedAt: Date.now() }
}

/** Loads a bounded real forecast grid. Failed requests reject and never return estimated data. */
export async function loadWeatherGrid(bounds: WeatherGridBounds, signal?: AbortSignal): Promise<WeatherGrid> {
  const normalizedBounds = validateGridBounds(bounds)
  const { width, height } = chooseGridSize(normalizedBounds)
  const key = gridKey(normalizedBounds, width, height)
  const cached = getCachedWeatherGrid(key, Date.now())
  if (cached) return cached
  const pending = weatherGridRequestCache.get(key)
  if (pending) return pending

  const { latitudes, longitudes } = createGridCoordinates(normalizedBounds, width, height)
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', Array.from(latitudes).join(','))
  url.searchParams.set('longitude', Array.from(longitudes).join(','))
  url.searchParams.set('hourly', WEATHER_GRID_FIELDS.join(','))
  url.searchParams.set('forecast_hours', String(WEATHER_GRID_HOURS))
  url.searchParams.set('timezone', 'UTC')

  const request = fetch(url.toString(), { signal })
    .then(async response => {
      if (!response.ok) throw new Error(`天气网格请求失败 (${response.status})`)
      try {
        return await response.json() as GridForecastPayload | GridForecastPayload[]
      } catch {
        throw new Error('天气网格响应不是有效 JSON')
      }
    })
    .then(payload => parseWeatherGrid(payload, normalizedBounds, width, height, latitudes, longitudes))
    .then(grid => {
      cacheWeatherGrid(key, grid)
      return grid
    })
    .catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无法加载天气网格: ${detail}`)
    })
    .finally(() => weatherGridRequestCache.delete(key))
  weatherGridRequestCache.set(key, request)
  return request
}

const sampleGridArray = (frame: WeatherGridFrame, values: Float32Array, latitude: number, longitude: number) => {
  if (values.length !== frame.width * frame.height) throw new Error('天气网格帧数据尺寸不匹配')
  const latitudeRatio = clamp((latitude - frame.bounds.south) / (frame.bounds.north - frame.bounds.south), 0, 1)
  const span = longitudeSpan(frame.bounds)
  const rawLongitudeOffset = ((longitude - frame.bounds.west) % 360 + 360) % 360
  const longitudeOffset = rawLongitudeOffset > span && 360 - rawLongitudeOffset < rawLongitudeOffset - span ? 0 : rawLongitudeOffset
  const longitudeRatio = clamp(longitudeOffset / span, 0, 1)
  const gridX = longitudeRatio * (frame.width - 1)
  const gridY = latitudeRatio * (frame.height - 1)
  const x0 = Math.floor(gridX)
  const y0 = Math.floor(gridY)
  const x1 = Math.min(frame.width - 1, x0 + 1)
  const y1 = Math.min(frame.height - 1, y0 + 1)
  const tx = gridX - x0
  const ty = gridY - y0
  const top = values[y0 * frame.width + x0] * (1 - tx) + values[y0 * frame.width + x1] * tx
  const bottom = values[y1 * frame.width + x0] * (1 - tx) + values[y1 * frame.width + x1] * tx
  return top * (1 - ty) + bottom * ty
}

export function sampleWeatherGridScalar(frame: WeatherGridFrame, field: WeatherGridField, latitude: number, longitude: number) {
  return sampleGridArray(frame, frame.values[field], latitude, longitude)
}

export function weatherDirectionToWindVector(speed: number, direction: number): WeatherMapWindVector {
  const radians = direction * Math.PI / 180
  return {
    speed,
    u: -speed * Math.sin(radians),
    v: -speed * Math.cos(radians),
    direction: ((direction % 360) + 360) % 360,
  }
}

export function sampleWeatherGridWindVector(frame: WeatherGridFrame, latitude: number, longitude: number): WeatherGridWindVector {
  const pointCount = frame.width * frame.height
  const u = new Float32Array(pointCount)
  const v = new Float32Array(pointCount)
  for (let index = 0; index < pointCount; index += 1) {
    const vector = weatherDirectionToWindVector(frame.values.wind_speed_10m[index], frame.values.wind_direction_10m[index])
    u[index] = vector.u
    v[index] = vector.v
  }
  const sampledU = sampleGridArray(frame, u, latitude, longitude)
  const sampledV = sampleGridArray(frame, v, latitude, longitude)
  const speed = Math.hypot(sampledU, sampledV)
  const direction = speed === 0 ? 0 : (Math.atan2(-sampledU, -sampledV) * 180 / Math.PI + 360) % 360
  return {
    speed,
    u: sampledU,
    v: sampledV,
    direction,
    gust: sampleWeatherGridScalar(frame, 'wind_gusts_10m', latitude, longitude),
  }
}

export function getWeatherGridFramePair(grid: WeatherGrid, targetTime: number | string | Date): WeatherGridFramePair {
  if (!grid.frames.length) throw new Error('天气网格不包含任何帧')
  const timestamp = targetTime instanceof Date ? targetTime.getTime() : typeof targetTime === 'string' ? parseGridTime(targetTime) : targetTime
  if (!Number.isFinite(timestamp)) throw new Error('天气网格目标时间无效')
  if (timestamp <= grid.frames[0].timestamp) return { current: grid.frames[0], next: grid.frames[0], ratio: 0 }
  const last = grid.frames[grid.frames.length - 1]
  if (timestamp >= last.timestamp) return { current: last, next: last, ratio: 0 }
  const nextIndex = grid.frames.findIndex(frame => frame.timestamp >= timestamp)
  const current = grid.frames[nextIndex - 1]
  const next = grid.frames[nextIndex]
  return { current, next, ratio: (timestamp - current.timestamp) / (next.timestamp - current.timestamp) }
}

export function interpolateWeatherGridFrame(current: WeatherGridFrame, next: WeatherGridFrame, ratio: number): WeatherGridFrame {
  if (current.width !== next.width || current.height !== next.height) throw new Error('无法插值尺寸不同的天气网格帧')
  const amount = clamp(ratio, 0, 1)
  const pointCount = current.width * current.height
  const values = Object.fromEntries(WEATHER_GRID_FIELDS.map(field => [field, new Float32Array(pointCount)])) as Record<WeatherGridField, Float32Array>
  for (const field of WEATHER_GRID_FIELDS) {
    if (field === 'wind_direction_10m') continue
    for (let index = 0; index < pointCount; index += 1) {
      values[field][index] = current.values[field][index] * (1 - amount) + next.values[field][index] * amount
    }
  }
  for (let index = 0; index < pointCount; index += 1) {
    const from = weatherDirectionToWindVector(current.values.wind_speed_10m[index], current.values.wind_direction_10m[index])
    const to = weatherDirectionToWindVector(next.values.wind_speed_10m[index], next.values.wind_direction_10m[index])
    const u = from.u * (1 - amount) + to.u * amount
    const v = from.v * (1 - amount) + to.v * amount
    values.wind_speed_10m[index] = Math.hypot(u, v)
    values.wind_direction_10m[index] = Math.hypot(u, v) === 0 ? current.values.wind_direction_10m[index] : (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360
  }
  const timestamp = current.timestamp + (next.timestamp - current.timestamp) * amount
  return { time: new Date(timestamp).toISOString(), timestamp, width: current.width, height: current.height, bounds: current.bounds, values }
}

export function interpolateWeatherGridAt(grid: WeatherGrid, targetTime: number | string | Date): WeatherGridFrame {
  const pair = getWeatherGridFramePair(grid, targetTime)
  return pair.current === pair.next ? pair.current : interpolateWeatherGridFrame(pair.current, pair.next, pair.ratio)
}

export function formatWeatherMapValue(layer: WeatherMapLayerDefinition, value: number) {
  const decimals = layer.decimals ?? (layer.id === 'wave' || Math.abs(value) < 10 ? 1 : 0)
  return `${value.toFixed(decimals)}${layer.unit === '°C' ? '°C' : ` ${layer.unit}`}`
}

