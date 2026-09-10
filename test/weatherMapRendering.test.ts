import { describe, expect, it } from 'vitest'
import {
  advanceWeatherMapPlayback,
  smoothWeatherContourPath,
  stitchWeatherContourSegments,
  weatherContourPathLength,
  weatherContourPointAt,
} from '../src/services/weatherMapRendering'

describe('weather map contour rendering', () => {
  it('joins adjacent contour segments into a continuous path', () => {
    const paths = stitchWeatherContourSegments([
      { level: 1008, from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
      { level: 1008, from: { x: 20, y: 5 }, to: { x: 10, y: 0 } },
      { level: 1012, from: { x: 0, y: 10 }, to: { x: 10, y: 10 } },
    ])

    expect(paths).toHaveLength(2)
    expect(paths.find(path => path.level === 1008)?.points).toHaveLength(3)
  })

  it('smooths paths while preserving open endpoints', () => {
    const source = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]
    const smoothed = smoothWeatherContourPath(source, false, 2)

    expect(smoothed[0]).toEqual(source[0])
    expect(smoothed.at(-1)).toEqual(source.at(-1))
    expect(smoothed.length).toBeGreaterThan(source.length)
    expect(weatherContourPathLength(smoothed)).toBeGreaterThan(20)
  })

  it('returns a readable tangent for a label along the path', () => {
    const result = weatherContourPointAt([{ x: 20, y: 0 }, { x: 0, y: 0 }], 0.5)

    expect(result.point).toEqual({ x: 10, y: 0 })
    expect(Math.abs(result.angle)).toBeLessThan(0.001)
  })
})

describe('weather map playback clock', () => {
  it('scales elapsed time and stops at the final forecast hour', () => {
    expect(advanceWeatherMapPlayback(10, 1000, 0.5)).toBe(10.5)
    expect(advanceWeatherMapPlayback(10, 1000, 2)).toBe(12)
    expect(advanceWeatherMapPlayback(47.5, 1000, 2)).toBe(48)
  })
})
