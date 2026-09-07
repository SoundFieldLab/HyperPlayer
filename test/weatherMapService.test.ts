import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const forecastPayload = {
  hourly: {
    time: ['2026-08-30T00:00'],
    temperature_2m: [21],
  },
}

const successResponse = () => new Response(JSON.stringify(forecastPayload), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

describe('weather map point forecast cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T00:00:00Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('deduplicates concurrent requests and reuses a successful point', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    const first = fetchWeatherMapPointValue('temperature', 31.23, 121.47, 0)
    const second = fetchWeatherMapPointValue('humidity', 31.231, 121.469, 0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch?.(successResponse())
    await Promise.all([first, second])
    await fetchWeatherMapPointValue('temperature', 31.23, 121.47, 0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries the same key after a failed pending request', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValue(successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    const fallback = await fetchWeatherMapPointValue('temperature', 10, 20, 0)
    expect(fallback.source).toBe('estimate')
    const recovered = await fetchWeatherMapPointValue('temperature', 10, 20, 0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(recovered.source).toBe('forecast')
  })

  it('removes an aborted pending request so the key can retry', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))
      .mockResolvedValue(successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    const controller = new AbortController()
    const aborted = fetchWeatherMapPointValue('temperature', 11, 22, 0, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })

    const recovered = await fetchWeatherMapPointValue('temperature', 11, 22, 0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(recovered.source).toBe('forecast')
  })

  it('expires old entries and removes them when inserting fresh data', async () => {
    const fetchMock = vi.fn(async () => successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    await fetchWeatherMapPointValue('temperature', 1, 1, 0)
    vi.advanceTimersByTime(10 * 60 * 1000)
    await fetchWeatherMapPointValue('temperature', 2, 2, 0)
    await fetchWeatherMapPointValue('temperature', 1, 1, 0)

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the most recently used points within the capacity limit', async () => {
    const fetchMock = vi.fn(async () => successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    for (let index = 0; index < 64; index += 1) {
      await fetchWeatherMapPointValue('temperature', index, 0, 0)
    }
    await fetchWeatherMapPointValue('temperature', 0, 0, 0)
    await fetchWeatherMapPointValue('temperature', 64, 0, 0)
    await fetchWeatherMapPointValue('temperature', 0, 0, 0)
    await fetchWeatherMapPointValue('temperature', 1, 0, 0)

    expect(fetchMock).toHaveBeenCalledTimes(66)
  })
})

const gridFields = [
  'temperature_2m',
  'relative_humidity_2m',
  'cloud_cover',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'precipitation',
] as const

const createGridPayload = (pointCount = 48) => {
  const times = Array.from({ length: 49 }, (_, index) => new Date(Date.UTC(2026, 7, 30, index)).toISOString().slice(0, 16))
  return Array.from({ length: pointCount }, (_, pointIndex) => ({
    hourly: {
      time: times,
      ...Object.fromEntries(gridFields.map(field => [field, Array.from({ length: 49 }, (_, hour) => {
        if (field === 'wind_direction_10m') return 90
        return pointIndex + hour
      })])),
    },
  }))
}

const createFrame = async (values: number[]) => {
  const { WEATHER_GRID_FIELDS } = await import('../src/services/weatherMapService')
  return {
    time: '2026-08-30T00:00:00.000Z',
    timestamp: Date.parse('2026-08-30T00:00:00Z'),
    width: 2,
    height: 2,
    bounds: { north: 2, south: 0, east: 2, west: 0 },
    values: Object.fromEntries(WEATHER_GRID_FIELDS.map(field => [field, new Float32Array(
      field === 'temperature_2m' ? values : field === 'wind_speed_10m' ? [10, 10, 10, 10] : field === 'wind_direction_10m' ? [0, 90, 180, 270] : [0, 0, 0, 0],
    )])),
  }
}

describe('weather grid pure helpers', () => {
  beforeEach(() => vi.resetModules())

  it('converts meteorological wind direction to eastward and northward components', async () => {
    const { weatherDirectionToWindVector } = await import('../src/services/weatherMapService')

    expect(weatherDirectionToWindVector(10, 0)).toMatchObject({ u: -0, v: -10 })
    expect(weatherDirectionToWindVector(10, 90).u).toBeCloseTo(-10)
    expect(weatherDirectionToWindVector(10, 180).v).toBeCloseTo(10)
    expect(weatherDirectionToWindVector(10, 270).u).toBeCloseTo(10)
  })

  it('bilinearly interpolates scalar values in a frame', async () => {
    const { sampleWeatherGridScalar } = await import('../src/services/weatherMapService')
    const frame = await createFrame([0, 10, 20, 30])

    expect(sampleWeatherGridScalar(frame, 'temperature_2m', 1, 1)).toBeCloseTo(15)
    expect(sampleWeatherGridScalar(frame, 'temperature_2m', 0.5, 0.5)).toBeCloseTo(7.5)
    expect(sampleWeatherGridScalar(frame, 'temperature_2m', 3, 3)).toBeCloseTo(30)
  })
})

describe('weather grid request cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T00:00:00Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('deduplicates in-flight loads, reuses TTL cache, and refetches expired grids', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const payload = createGridPayload()
    const response = () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
      .mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    const { loadWeatherGrid, WEATHER_GRID_FIELDS } = await import('../src/services/weatherMapService')
    const bounds = { north: 6, south: 0, east: 8, west: 0 }

    const first = loadWeatherGrid(bounds)
    const second = loadWeatherGrid({ ...bounds })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolveFetch?.(response())
    const [firstGrid, secondGrid] = await Promise.all([first, second])

    expect(firstGrid).toBe(secondGrid)
    expect(firstGrid).toMatchObject({ width: 8, height: 6 })
    expect(firstGrid.frames).toHaveLength(49)
    expect(firstGrid.frames[0].values.temperature_2m).toBeInstanceOf(Float32Array)
    await loadWeatherGrid(bounds)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(requestedUrl.searchParams.get('latitude')?.split(',')).toHaveLength(48)
    expect(requestedUrl.searchParams.get('longitude')?.split(',')).toHaveLength(48)
    expect(requestedUrl.searchParams.get('hourly')?.split(',')).toEqual(WEATHER_GRID_FIELDS)
    expect(requestedUrl.searchParams.get('forecast_hours')).toBe('49')

    vi.advanceTimersByTime(10 * 60 * 1000)
    await loadWeatherGrid(bounds)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects failed grid requests instead of returning estimated data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const { loadWeatherGrid } = await import('../src/services/weatherMapService')

    await expect(loadWeatherGrid({ north: 6, south: 0, east: 8, west: 0 })).rejects.toThrow('无法加载天气网格: 天气网格请求失败 (503)')
  })
})
