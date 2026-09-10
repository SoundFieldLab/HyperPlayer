import { useEffect, useRef } from 'react'
import type { WeatherSceneKind } from '../weatherVisualTheme'

interface HourlyForecastRainGlassProps {
  kind: WeatherSceneKind
  precipitation: number
  seed: number
  active: boolean
  reducedMotion?: boolean
  className?: string
}

interface Impact {
  active: boolean
  x: number
  y: number
  age: number
  duration: number
  radius: number
  alpha: number
  trail: number
}

const makeRandom = (seed: number) => {
  let value = seed || 1
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 0x100000000
  }
}

export default function HourlyForecastRainGlass({ kind, precipitation, seed, active, reducedMotion = false, className = '' }: HourlyForecastRainGlassProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !active) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const random = makeRandom(seed ^ 0x9e3779b9)
    const dense = kind === 'heavy-rain' || kind === 'thunder'
    const interval = kind === 'drizzle' ? 520 : dense ? 105 : 230
    const intensity = Math.min(1.8, Math.max(0.65, 0.75 + Math.max(0, precipitation) * 0.12))
    const impacts: Impact[] = Array.from({ length: dense ? 32 : 20 }, () => ({ active: false, x: 0, y: 0, age: 0, duration: 0, radius: 0, alpha: 0, trail: 0 }))
    const beads = Array.from({ length: kind === 'drizzle' ? 16 : dense ? 34 : 24 }, () => ({ x: random(), y: random(), r: 0.7 + random() * 2.1, alpha: 0.14 + random() * 0.19 }))
    let width = 1
    let height = 1
    let dpr = 1
    let raf = 0
    let last = performance.now()
    let accumulator = 0
    let spawnAccumulator = 0
    let visible = true
    let disposed = false

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const drawBead = (x: number, y: number, radius: number, alpha: number) => {
      const gradient = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.35, 0, x, y, radius)
      gradient.addColorStop(0, `rgba(255,255,255,${alpha * 1.35})`)
      gradient.addColorStop(0.28, `rgba(225,242,255,${alpha * 0.55})`)
      gradient.addColorStop(0.78, `rgba(122,161,190,${alpha * 0.18})`)
      gradient.addColorStop(1, 'rgba(80,110,140,0)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.ellipse(x, y, radius, radius * 1.08, 0, 0, Math.PI * 2)
      ctx.fill()
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'screen'
      beads.forEach(bead => drawBead(bead.x * width, bead.y * height, bead.r, bead.alpha))
      for (const impact of impacts) {
        if (!impact.active) continue
        const progress = impact.age / impact.duration
        const fade = Math.max(0, 1 - progress)
        const radius = impact.radius * (0.28 + progress * 1.1)
        ctx.globalAlpha = impact.alpha * fade
        ctx.strokeStyle = 'rgba(224,244,255,0.72)'
        ctx.lineWidth = Math.max(0.5, 1.4 - progress)
        ctx.beginPath()
        ctx.ellipse(impact.x, impact.y, radius, radius * 0.42, 0, 0, Math.PI * 2)
        ctx.stroke()
        for (let index = 0; index < 4; index += 1) {
          const angle = index * Math.PI * 0.5 + impact.radius
          const distance = radius * (0.6 + index * 0.13)
          drawBead(impact.x + Math.cos(angle) * distance, impact.y + Math.sin(angle) * distance * 0.45, 0.6 + impact.radius * 0.07, 0.2 * fade)
        }
        if (impact.trail > 0) {
          const trail = Math.min(impact.trail, progress * height * 0.18)
          const gradient = ctx.createLinearGradient(impact.x, impact.y, impact.x, impact.y + trail)
          gradient.addColorStop(0, `rgba(226,244,255,${0.22 * fade})`)
          gradient.addColorStop(1, 'rgba(180,216,238,0)')
          ctx.strokeStyle = gradient
          ctx.lineWidth = Math.max(0.7, impact.radius * 0.12)
          ctx.beginPath()
          ctx.moveTo(impact.x, impact.y)
          ctx.quadraticCurveTo(impact.x + Math.sin(impact.x) * 2, impact.y + trail * 0.55, impact.x, impact.y + trail)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    const spawnImpact = () => {
      const impact = impacts.find(item => !item.active)
      if (!impact) return
      impact.active = true
      impact.x = width * (0.03 + random() * 0.94)
      impact.y = height * (0.08 + random() * 0.78)
      impact.age = 0
      impact.duration = 360 + random() * 380
      impact.radius = (4 + random() * (dense ? 11 : 7)) * intensity
      impact.alpha = kind === 'drizzle' ? 0.32 : 0.42
      impact.trail = random() > (dense ? 0.72 : 0.88) ? 12 + random() * 26 : 0
    }

    const stop = () => {
      cancelAnimationFrame(raf)
      raf = 0
    }
    const tick = (now: number) => {
      raf = 0
      if (disposed || document.hidden || !visible) return
      const delta = Math.min(66, now - last)
      last = now
      accumulator += delta
      spawnAccumulator += delta
      if (spawnAccumulator >= interval / intensity) {
        spawnAccumulator %= interval / intensity
        spawnImpact()
      }
      impacts.forEach(impact => {
        if (!impact.active) return
        impact.age += delta
        if (impact.age >= impact.duration) impact.active = false
      })
      if (accumulator >= 1000 / 30) {
        accumulator %= 1000 / 30
        draw()
      }
      raf = requestAnimationFrame(tick)
    }
    const start = () => {
      if (disposed || reducedMotion || document.hidden || !visible || raf) return
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }
    const handleVisibility = () => document.hidden ? stop() : start()

    resize()
    if (reducedMotion) draw()
    else {
      document.addEventListener('visibilitychange', handleVisibility)
      start()
    }
    const resizeObserver = new ResizeObserver(() => { resize(); draw() })
    resizeObserver.observe(canvas)
    const intersectionObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true
      if (visible) start()
      else stop()
    }, { threshold: 0.05 })
    intersectionObserver?.observe(canvas)

    return () => {
      disposed = true
      stop()
      document.removeEventListener('visibilitychange', handleVisibility)
      resizeObserver.disconnect()
      intersectionObserver?.disconnect()
    }
  }, [active, kind, precipitation, reducedMotion, seed])

  return <canvas ref={canvasRef} aria-hidden="true" data-hourly-rain-glass className={`pointer-events-none h-full w-full ${className}`} />
}
