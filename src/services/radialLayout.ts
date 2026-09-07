export interface RadialPoint {
  x: number
  y: number
}

export function getRadialPoint(index: number, count: number, radius: number): RadialPoint {
  if (count <= 0) return { x: 0, y: 0 }
  const angle = getRadialAngle(index, count) - Math.PI / 2
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

export function getRadialAngle(index: number, count: number): number {
  return count > 0 ? (index / count) * Math.PI * 2 : 0
}

function polarPoint(center: number, angle: number, radius: number): RadialPoint {
  return {
    x: center + Math.sin(angle) * radius,
    y: center - Math.cos(angle) * radius,
  }
}

export function getAnnularSectorPath(
  index: number,
  count: number,
  center: number,
  innerRadius: number,
  outerRadius: number,
  gapAngle = Math.PI / 90,
): string {
  if (count <= 0 || innerRadius <= 0 || outerRadius <= innerRadius) return ''
  if (count === 1) {
    const topOuter = polarPoint(center, 0, outerRadius)
    const bottomOuter = polarPoint(center, Math.PI, outerRadius)
    const topInner = polarPoint(center, 0, innerRadius)
    const bottomInner = polarPoint(center, Math.PI, innerRadius)
    return `M ${topOuter.x} ${topOuter.y} A ${outerRadius} ${outerRadius} 0 1 1 ${bottomOuter.x} ${bottomOuter.y} A ${outerRadius} ${outerRadius} 0 1 1 ${topOuter.x} ${topOuter.y} L ${topInner.x} ${topInner.y} A ${innerRadius} ${innerRadius} 0 1 0 ${bottomInner.x} ${bottomInner.y} A ${innerRadius} ${innerRadius} 0 1 0 ${topInner.x} ${topInner.y} Z`
  }
  const step = Math.PI * 2 / count
  const centerAngle = getRadialAngle(index, count)
  const startAngle = centerAngle - step / 2 + gapAngle / 2
  const endAngle = centerAngle + step / 2 - gapAngle / 2
  const outerStart = polarPoint(center, startAngle, outerRadius)
  const outerEnd = polarPoint(center, endAngle, outerRadius)
  const innerEnd = polarPoint(center, endAngle, innerRadius)
  const innerStart = polarPoint(center, startAngle, innerRadius)
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
  return `M ${outerStart.x} ${outerStart.y} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y} Z`
}

export function getRadialIndex(clientX: number, clientY: number, centerX: number, centerY: number, count: number): number {
  if (count <= 1) return 0
  const angle = Math.atan2(clientY - centerY, clientX - centerX) + Math.PI / 2
  const normalized = (angle + Math.PI * 2) % (Math.PI * 2)
  return Math.round(normalized / (Math.PI * 2 / count)) % count
}

export function moveRadialItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items]
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= next.length || toIndex >= next.length || fromIndex === toIndex) return next
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}
