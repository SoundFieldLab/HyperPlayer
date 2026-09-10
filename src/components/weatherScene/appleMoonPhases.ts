import moonPhase0 from '../../assets/weather/apple-moon/moonPhase0.webp'
import moonPhase1 from '../../assets/weather/apple-moon/moonPhase1.webp'
import moonPhase2 from '../../assets/weather/apple-moon/moonPhase2.webp'
import moonPhase3 from '../../assets/weather/apple-moon/moonPhase3.webp'
import moonPhase4 from '../../assets/weather/apple-moon/moonPhase4.webp'
import moonPhase5 from '../../assets/weather/apple-moon/moonPhase5.webp'
import moonPhase6 from '../../assets/weather/apple-moon/moonPhase6.webp'
import moonPhase7 from '../../assets/weather/apple-moon/moonPhase7.webp'
import moonPhase8 from '../../assets/weather/apple-moon/moonPhase8.webp'
import moonPhase9 from '../../assets/weather/apple-moon/moonPhase9.webp'
import moonPhase10 from '../../assets/weather/apple-moon/moonPhase10.webp'
import moonPhase11 from '../../assets/weather/apple-moon/moonPhase11.webp'
import moonPhase12 from '../../assets/weather/apple-moon/moonPhase12.webp'
import moonPhase13 from '../../assets/weather/apple-moon/moonPhase13.webp'
import moonPhase14 from '../../assets/weather/apple-moon/moonPhase14.webp'
import moonPhase15 from '../../assets/weather/apple-moon/moonPhase15.webp'
import moonPhase16 from '../../assets/weather/apple-moon/moonPhase16.webp'
import moonPhase17 from '../../assets/weather/apple-moon/moonPhase17.webp'
import moonPhase18 from '../../assets/weather/apple-moon/moonPhase18.webp'
import moonPhase19 from '../../assets/weather/apple-moon/moonPhase19.webp'
import moonPhase20 from '../../assets/weather/apple-moon/moonPhase20.webp'
import moonPhase21 from '../../assets/weather/apple-moon/moonPhase21.webp'
import moonPhase22 from '../../assets/weather/apple-moon/moonPhase22.webp'
import moonPhase23 from '../../assets/weather/apple-moon/moonPhase23.webp'
import moonPhase24 from '../../assets/weather/apple-moon/moonPhase24.webp'
import moonPhase25 from '../../assets/weather/apple-moon/moonPhase25.webp'
import moonPhase26 from '../../assets/weather/apple-moon/moonPhase26.webp'
import moonPhase27 from '../../assets/weather/apple-moon/moonPhase27.webp'

export const APPLE_MOON_PHASES = [moonPhase0, moonPhase1, moonPhase2, moonPhase3, moonPhase4, moonPhase5, moonPhase6, moonPhase7, moonPhase8, moonPhase9, moonPhase10, moonPhase11, moonPhase12, moonPhase13, moonPhase14, moonPhase15, moonPhase16, moonPhase17, moonPhase18, moonPhase19, moonPhase20, moonPhase21, moonPhase22, moonPhase23, moonPhase24, moonPhase25, moonPhase26, moonPhase27] as const

export function getAppleMoonPhaseFrames(phase: number) {
  const normalized = Number.isFinite(phase) ? ((phase % 1) + 1) % 1 : 0
  const position = normalized * APPLE_MOON_PHASES.length
  const lower = Math.floor(position) % APPLE_MOON_PHASES.length
  const upper = (lower + 1) % APPLE_MOON_PHASES.length
  return { lower, upper, mix: position - Math.floor(position) }
}
