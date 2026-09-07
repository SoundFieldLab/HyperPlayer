import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Cloud, Droplets, Sun, Sunrise, Sunset, ThermometerSun, Umbrella, Wind, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { getWeatherLabel, type WeatherSnapshot } from '../services/weatherService'
import { WeatherGlyph, getUvLabel } from './weatherVisualTheme'

interface WeatherDayDetailProps {
  open: boolean
  dayIndex: number
  weather: WeatherSnapshot
  onClose: () => void
  onSelectDay: (index: number) => void
}

const formatClock = (value: string) => value?.slice(11, 16) || '--:--'
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${value}T12:00:00`))

export default function WeatherDayDetail({ open, dayIndex, weather, onClose, onSelectDay }: WeatherDayDetailProps) {
  const day = weather.daily[dayIndex]
  if (!day || typeof document === 'undefined') return null
  const hours = weather.hourly.filter(hour => hour.time.slice(0, 10) === day.date)
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  const humidity = Math.round(average(hours.map(hour => hour.humidity)))
  const cloudCover = Math.round(average(hours.map(hour => hour.cloudCover)))
  const isDay = day.weatherCode < 3

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[430] flex items-center justify-center bg-slate-950/38 p-3 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.section role="dialog" aria-modal="true" aria-label={`${formatDate(day.date)}天气详情`} className="max-h-[calc(100dvh-24px)] w-full max-w-[720px] overflow-y-auto rounded-[30px] border border-white/14 bg-slate-900/88 p-5 text-white shadow-[0_28px_90px_rgba(0,0,0,.5)] backdrop-blur-2xl wf-no-scrollbar sm:p-6" initial={{ y: 18, opacity: 0, scale: .98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 14, opacity: 0, scale: .98 }} onClick={event => event.stopPropagation()}>
            <header className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
              <button type="button" onClick={() => onSelectDay(dayIndex - 1)} disabled={dayIndex === 0} aria-label="前一天" className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 disabled:opacity-25"><ChevronLeft className="h-4 w-4" /></button>
              <div className="text-center"><div className="text-lg font-semibold">{formatDate(day.date)}</div><div className="mt-1 text-xs text-white/45">{weather.location.name}</div></div>
              <div className="flex gap-2"><button type="button" onClick={() => onSelectDay(dayIndex + 1)} disabled={dayIndex >= weather.daily.length - 1} aria-label="后一天" className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 disabled:opacity-25"><ChevronRight className="h-4 w-4" /></button><button type="button" onClick={onClose} aria-label="关闭单日天气详情" className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8"><X className="h-4 w-4" /></button></div>
            </header>

            <div className="mt-5 flex items-center justify-between gap-5">
              <div><div className="text-sm text-white/48">{getWeatherLabel(day.weatherCode)}</div><div className="mt-1 text-[3.25rem] font-semibold leading-none tabular-nums">{Math.round(day.temperatureMin)}~{Math.round(day.temperatureMax)}<span className="ml-1 text-xl font-normal text-white/50">°C</span></div><div className="mt-2 text-sm text-white/48">体感 {Math.round(day.apparentTemperatureMin)}~{Math.round(day.apparentTemperatureMax)}°</div></div>
              <WeatherGlyph code={day.weatherCode} isDay={isDay} className="h-20 w-20" />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                [Sunrise, '日出', formatClock(day.sunrise), '#fbbf24'], [Sunset, '日落', formatClock(day.sunset), '#fb923c'],
                [Umbrella, '降水概率', `${Math.round(day.precipitationProbability)}%`, '#38bdf8'], [Droplets, '降水量', `${day.precipitationSum.toFixed(1)} mm`, '#60a5fa'],
                [ThermometerSun, '平均湿度', hours.length ? `${humidity}%` : '—', '#2dd4bf'], [Wind, '最大风速', `${Math.round(day.windSpeedMax)} km/h`, '#7dd3fc'],
                [Sun, '紫外线', `${Math.round(day.uvIndexMax)} · ${getUvLabel(day.uvIndexMax)}`, '#facc15'], [Cloud, '平均云量', hours.length ? `${cloudCover}%` : '—', '#cbd5e1'],
              ].map(([Icon, label, value, color]) => {
                const Glyph = Icon as typeof Sun
                return <div key={String(label)} className="rounded-2xl border border-white/9 bg-white/[0.045] p-3.5"><Glyph className="h-5 w-5" style={{ color: String(color) }} /><div className="mt-3 text-xs text-white/38">{String(label)}</div><div className="mt-1 text-sm font-semibold tabular-nums">{String(value)}</div></div>
              })}
            </div>

            <section className="mt-5 rounded-2xl border border-white/9 bg-white/[0.035] p-4">
              <div className="mb-3 text-sm font-medium text-white/55">逐小时预报</div>
              {hours.length > 0 ? <div className="flex gap-2 overflow-x-auto pb-1 wf-no-scrollbar">{hours.map(hour => <div key={hour.time} className="flex min-w-[72px] flex-col items-center rounded-xl bg-black/12 px-2 py-3"><span className="text-xs text-white/52">{hour.time.slice(11, 16)}</span><WeatherGlyph code={hour.weatherCode} isDay={hour.time >= day.sunrise && hour.time < day.sunset} className="my-2 h-7 w-7" /><span className="font-semibold">{Math.round(hour.temperature)}°</span><span className="mt-1 text-[10px] text-cyan-200/75">{hour.precipitationProbability > 0 ? `${Math.round(hour.precipitationProbability)}%` : '—'}</span></div>)}</div> : <div className="py-5 text-center text-sm text-white/38">该日期暂无逐小时数据，以上为日级预报。</div>}
            </section>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
