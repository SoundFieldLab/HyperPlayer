import { describe, expect, it } from 'vitest'
import { getAqiDescriptor } from '../src/services/weatherService'

describe('European AQI presentation', () => {
  it.each([
    [0, '优', '#22c55e'],
    [20, '良', '#eab308'],
    [40, '中等', '#f97316'],
    [60, '较差', '#ef4444'],
    [80, '很差', '#a855f7'],
    [101, '极差', '#881337'],
  ])('maps %s to %s', (aqi, label, color) => {
    expect(getAqiDescriptor(aqi)).toEqual({ label, color })
  })

  it('does not present an invalid value as good air quality', () => {
    expect(getAqiDescriptor(Number.NaN)).toEqual({ label: '暂无数据', color: '#94a3b8' })
  })
})
