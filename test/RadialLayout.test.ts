import { describe, expect, it } from 'vitest'
import { getAnnularSectorPath, getRadialIndex, getRadialPoint, moveRadialItem } from '../src/services/radialLayout'

describe('radial layout', () => {
  it('places index zero at the top and resolves cardinal indices', () => {
    expect(getRadialPoint(0, 8, 100)).toMatchObject({ x: expect.closeTo(0), y: expect.closeTo(-100) })
    expect(getRadialIndex(100, 0, 100, 100, 8)).toBe(0)
    expect(getRadialIndex(200, 100, 100, 100, 8)).toBe(2)
    expect(getRadialIndex(100, 200, 100, 100, 8)).toBe(4)
  })

  it('moves an item into a radial slot without losing entries', () => {
    expect(moveRadialItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('builds valid annular sectors for one through eight items', () => {
    for (let count = 1; count <= 8; count += 1) {
      const paths = Array.from({ length: count }, (_, index) => getAnnularSectorPath(index, count, 160, 61, 152))
      expect(paths).toHaveLength(count)
      paths.forEach(path => {
        expect(path).toContain('M ')
        expect(path).toContain(' A ')
        expect(path).toContain(' Z')
        expect(path).not.toMatch(/NaN|Infinity/)
      })
    }
  })
})
