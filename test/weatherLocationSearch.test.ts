import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getWeatherLocationAddress,
  getWeatherLocationCompactName,
  normalizeAdministrativeName,
  resolveWeatherLocationSearchResult,
  searchWeatherLocations,
} from '../src/services/weatherService'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('weather location search', () => {
  it('finds Chinese cities and districts locally without a network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const cityResults = await searchWeatherLocations('苏州市')
    const districtResults = await searchWeatherLocations('姑苏区')

    expect(cityResults[0]).toMatchObject({
      countryCode: 'CN',
      province: '江苏省',
      city: '苏州市',
      district: '',
      cityCode: '320500',
      latitude: null,
      longitude: null,
    })
    expect(districtResults[0]).toMatchObject({
      province: '江苏省',
      city: '苏州市',
      district: '姑苏区',
      districtCode: '320508',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves only the selected local administrative result to coordinates', async () => {
    const [result] = await searchWeatherLocations('姑苏区')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: [{ properties: { center: [120.6173, 31.3363] } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const resolved = await resolveWeatherLocationSearchResult(result)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/320508.json')
    expect(resolved).toMatchObject({ latitude: 31.3363, longitude: 120.6173 })
  })

  it('uses Nominatim only when Open-Meteo returns no matches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          place_id: 42,
          lat: '35.6895',
          lon: '139.6917',
          name: '测试远方城',
          address: { country: '日本', country_code: 'jp', state: '东京都', city: '测试远方城' },
        }],
      })
    vi.stubGlobal('fetch', fetchMock)

    const results = await searchWeatherLocations('测试远方城')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('geocoding-api.open-meteo.com')
    expect(String(fetchMock.mock.calls[1][0])).toContain('nominatim.openstreetmap.org')
    expect(results[0]).toMatchObject({ countryCode: 'JP', city: '测试远方城' })
  })
})

describe('weather administrative names', () => {
  it('drops isolated suffixes and fixes legacy 市苏州 display data', () => {
    const location = {
      name: '苏州',
      country: '中国',
      province: '江苏省',
      city: '市',
      district: '苏州',
      region: '江苏省 · 市 · 苏州',
      formattedAddress: '中国江苏省市苏州',
    }

    expect(normalizeAdministrativeName('市')).toBe('')
    expect(getWeatherLocationCompactName(location)).toBe('苏州')
    expect(getWeatherLocationAddress(location)).toBe('江苏省苏州')
  })
})
