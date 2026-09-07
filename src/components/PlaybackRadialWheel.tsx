import type { LucideIcon } from 'lucide-react'
import { getAnnularSectorPath, getRadialPoint } from '../services/radialLayout'

export interface PlaybackRadialWheelItem {
  id: string
  label: string
  Icon: LucideIcon
}

interface Props {
  items: PlaybackRadialWheelItem[]
  selectedIndex: number | null
  accentColor: string
  isDark: boolean
  size?: number
  interactiveContent?: boolean
  showContent?: boolean
  centerLabel?: string
}

export default function PlaybackRadialWheel({ items, selectedIndex, accentColor, isDark, size = 320, interactiveContent = false, showContent = true, centerLabel }: Props) {
  const center = size / 2
  const outerRadius = size * 0.475
  const innerRadius = size * 0.19
  const contentRadius = size * 0.345
  const selectedForeground = '#ffffff'
  const wheelBackground = isDark ? 'rgba(9,14,27,.68)' : 'rgba(248,250,252,.72)'
  const wheelBorder = isDark ? 'rgba(255,255,255,.18)' : 'rgba(15,23,42,.14)'
  const neutralFill = isDark ? 'rgba(51,65,85,.68)' : 'rgba(255,255,255,.84)'
  const neutralStroke = isDark ? 'rgba(255,255,255,.22)' : 'rgba(15,23,42,.15)'

  return (
    <div aria-hidden="true" className={`relative ${interactiveContent ? '' : 'pointer-events-none'}`} style={{ width: size, height: size }}>
      <div
        className="absolute rounded-full border backdrop-blur-2xl"
        style={{
          inset: size * 0.025,
          backgroundColor: wheelBackground,
          borderColor: wheelBorder,
          boxShadow: isDark
            ? '0 18px 55px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.08)'
            : '0 18px 55px rgba(15,23,42,.16), inset 0 1px 0 rgba(255,255,255,.7)',
        }}
      />
      <svg viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 h-full w-full overflow-visible">
        {items.map((item, index) => {
          const selected = selectedIndex === index
          return (
            <path
              key={item.id}
              d={getAnnularSectorPath(index, items.length, center, innerRadius, outerRadius)}
              fill={selected ? accentColor : neutralFill}
              stroke={selected ? accentColor : neutralStroke}
              strokeWidth="1.2"
              opacity={selectedIndex !== null && !selected ? 0.62 : 1}
              style={{ filter: selected ? `drop-shadow(0 8px 15px ${accentColor}66)` : 'drop-shadow(0 5px 12px rgba(0,0,0,.14))', transition: 'fill .14s ease, opacity .14s ease, filter .14s ease' }}
            />
          )
        })}
      </svg>

      {showContent && items.map((item, index) => {
        const point = getRadialPoint(index, items.length, contentRadius)
        const selected = selectedIndex === index
        return (
          <div key={item.id} className="absolute flex h-[62px] w-[76px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 text-center" style={{ left: center + point.x, top: center + point.y, color: selected ? selectedForeground : isDark ? 'rgba(255,255,255,.9)' : 'rgba(15,23,42,.78)', opacity: selectedIndex !== null && !selected ? 0.67 : 1 }}>
            <item.Icon className="h-6 w-6 shrink-0" />
            <span className="block w-full truncate text-[11px] font-semibold">{item.label}</span>
          </div>
        )
      })}

      <div className={`absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-center text-[11px] font-semibold backdrop-blur-2xl ${isDark ? 'border-white/20 bg-slate-950/85 text-white/65' : 'border-black/15 bg-white/90 text-black/55'}`} style={{ width: size * 0.275, height: size * 0.275, boxShadow: `0 6px 24px ${accentColor}20` }}>
        {centerLabel ?? (selectedIndex === null ? '拖动选择' : '松开执行')}
      </div>
    </div>
  )
}
