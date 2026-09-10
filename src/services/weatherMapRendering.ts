export interface WeatherContourPoint {
  x: number
  y: number
}

export interface WeatherContourSegment {
  level: number
  from: WeatherContourPoint
  to: WeatherContourPoint
}

export interface WeatherContourPath {
  level: number
  points: WeatherContourPoint[]
  closed: boolean
}

const pointKey = (point: WeatherContourPoint, precision: number) =>
  `${Math.round(point.x / precision)}:${Math.round(point.y / precision)}`

export const stitchWeatherContourSegments = (
  segments: WeatherContourSegment[],
  precision = 0.35,
): WeatherContourPath[] => {
  const byLevel = new Map<number, WeatherContourSegment[]>()
  segments.forEach(segment => byLevel.set(segment.level, [...(byLevel.get(segment.level) || []), segment]))
  const paths: WeatherContourPath[] = []

  for (const [level, levelSegments] of byLevel) {
    const remaining = [...levelSegments]
    while (remaining.length > 0) {
      const seed = remaining.pop()!
      const points = [seed.from, seed.to]
      let extended = true
      while (extended && remaining.length > 0) {
        extended = false
        const firstKey = pointKey(points[0], precision)
        const lastKey = pointKey(points[points.length - 1], precision)
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          const segment = remaining[index]
          const fromKey = pointKey(segment.from, precision)
          const toKey = pointKey(segment.to, precision)
          if (fromKey === lastKey) points.push(segment.to)
          else if (toKey === lastKey) points.push(segment.from)
          else if (toKey === firstKey) points.unshift(segment.from)
          else if (fromKey === firstKey) points.unshift(segment.to)
          else continue
          remaining.splice(index, 1)
          extended = true
          break
        }
      }
      const closed = points.length > 2 && pointKey(points[0], precision) === pointKey(points[points.length - 1], precision)
      if (closed) points[points.length - 1] = points[0]
      paths.push({ level, points, closed })
    }
  }

  return paths
}

export const smoothWeatherContourPath = (
  points: WeatherContourPoint[],
  closed: boolean,
  iterations = 2,
): WeatherContourPoint[] => {
  let current = points
  for (let iteration = 0; iteration < iterations && current.length > 2; iteration += 1) {
    const source = closed && current[0] === current[current.length - 1] ? current.slice(0, -1) : current
    const next: WeatherContourPoint[] = closed ? [] : [source[0]]
    const pairCount = closed ? source.length : source.length - 1
    for (let index = 0; index < pairCount; index += 1) {
      const left = source[index]
      const right = source[(index + 1) % source.length]
      next.push(
        { x: left.x * 0.75 + right.x * 0.25, y: left.y * 0.75 + right.y * 0.25 },
        { x: left.x * 0.25 + right.x * 0.75, y: left.y * 0.25 + right.y * 0.75 },
      )
    }
    if (!closed) next.push(source[source.length - 1])
    else next.push(next[0])
    current = next
  }
  return current
}

export const weatherContourPathLength = (points: WeatherContourPoint[]) => points.slice(1).reduce(
  (length, point, index) => length + Math.hypot(point.x - points[index].x, point.y - points[index].y),
  0,
)

export const weatherContourPointAt = (points: WeatherContourPoint[], ratio: number) => {
  const target = weatherContourPathLength(points) * Math.max(0, Math.min(1, ratio))
  let travelled = 0
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const segmentLength = Math.hypot(to.x - from.x, to.y - from.y)
    if (travelled + segmentLength >= target) {
      const fraction = segmentLength === 0 ? 0 : (target - travelled) / segmentLength
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      let readableAngle = angle
      if (readableAngle > Math.PI / 2) readableAngle -= Math.PI
      else if (readableAngle < -Math.PI / 2) readableAngle += Math.PI
      return {
        point: { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction },
        angle: readableAngle,
      }
    }
    travelled += segmentLength
  }
  return { point: points[points.length - 1], angle: 0 }
}

export const advanceWeatherMapPlayback = (
  currentHour: number,
  elapsedMilliseconds: number,
  speed: number,
  maximumHour = 48,
) => Math.min(maximumHour, Math.max(0, currentHour + Math.max(0, elapsedMilliseconds) / 1000 * speed))
