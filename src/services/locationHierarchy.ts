/**
 * 行政区划数据服务（懒加载优化）
 *
 * 数据来源：
 * - country-state-city：全球国家 / 州省 / 城市数据。城市数据（city.json 约 148k 条 / 7.9MB）
 *   会在 `npm run build` 时被 scripts/split-city-data.mjs 按国家/地区拆分为
 *   `src/generated/city-data/<code>.json`，这里通过 `import.meta.glob` 按国家懒加载，
 *   避免打包出 8MB+ 巨型 chunk。仅在选择非中国地区的省/州时才动态加载对应国家的数据。
 * - china-area-data：中国省市区数据（约 637KB），全国省市县在本地轻量读取。
 */
import Country from 'country-state-city/lib/country'
import State from 'country-state-city/lib/state'
import chinaAreaData from 'china-area-data'

export interface LocationOption {
  code: string
  name: string
}

type ChinaAreaMap = Record<string, Record<string, string>>

const chinaAreas = chinaAreaData as ChinaAreaMap
const countryNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['zh-CN'], { type: 'region' })
  : null

const sortByName = (items: LocationOption[]) =>
  items.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

export const getCountries = (): LocationOption[] => {
  const countries = Country.getAllCountries().map(country => ({
    code: country.isoCode,
    name: countryNames?.of(country.isoCode) || country.name,
  }))

  return sortByName(countries)
}

export const getProvinces = (countryCode: string): LocationOption[] => {
  if (countryCode === 'CN') {
    return Object.entries(chinaAreas['86'] || {}).map(([code, name]) => ({ code, name }))
  }

  return sortByName(State.getStatesOfCountry(countryCode).map(state => ({
    code: state.isoCode,
    name: state.name,
  })))
}

// 城市数据懒加载：由 scripts/split-city-data.mjs 拆分为按国家/地区的 JSON 文件，
// 每个文件都是一个独立 chunk（最大约 2MB，美国），仅在用户选择非中国地区的省/州时加载。
interface CityEntry {
  name: string
  stateCode: string
  latitude: string
  longitude: string
}

const cityDataModules = import.meta.glob<CityEntry[]>('../generated/city-data/*.json')

export const getCities = async (
  countryCode: string,
  provinceCode: string,
): Promise<LocationOption[]> => {
  if (!provinceCode) return []
  if (countryCode === 'CN') {
    return Object.entries(chinaAreas[provinceCode] || {}).map(([code, name]) => ({ code, name }))
  }

  const loader = cityDataModules[`../generated/city-data/${countryCode}.json`]
  if (!loader) return []
  const cities = await loader()
  return sortByName(cities
    .filter(city => city.stateCode === provinceCode)
    .map(city => ({
      code: `${city.name}|${city.latitude || ''}|${city.longitude || ''}`,
      name: city.name,
    })))
}

export const getDistricts = (
  countryCode: string,
  _provinceCode: string,
  cityCode: string,
): LocationOption[] => {
  if (!cityCode || countryCode !== 'CN') return []
  return Object.entries(chinaAreas[cityCode] || {}).map(([code, name]) => ({ code, name }))
}

export interface ChinaAreaSearchResult {
  provinceCode: string
  province: string
  cityCode: string
  city: string
  districtCode: string
  district: string
}

const normalizeSearchText = (value: string) => value
  .trim()
  .toLocaleLowerCase('zh-CN')
  .replace(/\s+/g, '')
  .replace(/(?:特别行政区|省|市|区|县|旗|盟|州)$/u, '')

/** 在本地行政区数据中快速查找省、市、区县，避免输入阶段依赖外部地理编码服务。 */
export const searchChinaAreas = (query: string, limit = 12): ChinaAreaSearchResult[] => {
  const keyword = normalizeSearchText(query)
  if (!keyword) return []
  const matches: ChinaAreaSearchResult[] = []
  for (const [provinceCode, province] of Object.entries(chinaAreas['86'] || {})) {
    const provinceKey = normalizeSearchText(province)
    if (provinceKey.includes(keyword)) matches.push({ provinceCode, province, cityCode: '', city: '', districtCode: '', district: '' })
    for (const [cityCode, city] of Object.entries(chinaAreas[provinceCode] || {})) {
      const cityKey = normalizeSearchText(city)
      if (cityKey.includes(keyword)) matches.push({ provinceCode, province, cityCode, city, districtCode: '', district: '' })
      for (const [districtCode, district] of Object.entries(chinaAreas[cityCode] || {})) {
        if (normalizeSearchText(district).includes(keyword)) matches.push({ provinceCode, province, cityCode, city, districtCode, district })
        if (matches.length >= limit * 3) break
      }
      if (matches.length >= limit * 3) break
    }
    if (matches.length >= limit * 3) break
  }
  const seen = new Set<string>()
  return matches.filter(item => {
    const key = [item.provinceCode, item.cityCode, item.districtCode].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, limit)
}
