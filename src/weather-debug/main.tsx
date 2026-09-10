import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronLeft, ChevronRight, CloudSun, Moon, Sun } from 'lucide-react'
import '../index.css'
import './debug.css'
import AppleWeatherScene from '../components/weatherScene/AppleWeatherScene'
import AppleWeatherCompactScene from '../components/weatherScene/AppleWeatherCompactScene'
import { APPLE_WEATHER_SCENES } from '../components/weatherScene/appleWeatherAssets.generated'
import { createAppleWeatherSceneModel } from '../components/weatherScene/weatherSceneModel'
import { WeatherSimpleCard } from '../components/WeatherSimpleCard'
import WeatherDetailsModal, { WeatherGlyph } from '../components/WeatherDetailsModal'
import { getWeatherLabel } from '../services/weatherService'
import { WEATHER_DEBUG_SCENARIOS, createWeatherDebugSnapshot, type WeatherDebugScenarioId } from './scenarios'

function FullCardPreview({ weather, ready }: { weather: ReturnType<typeof createWeatherDebugSnapshot>; ready: boolean }) {
  return (
    <div className="weather-debug-card weather-debug-full-card">
      <div className="weather-debug-card-content">
        <div className="weather-debug-location">上海 · 浦东新区</div>
        <div className="weather-debug-temperature-row"><span>{Math.round(weather.current.temperature)}</span><sup>°</sup></div>
        <div className="weather-debug-condition">{getWeatherLabel(weather.current.weatherCode)}</div>
        <div className="weather-debug-secondary">体感 {Math.round(weather.current.apparentTemperature)}° · 最高 {Math.round(weather.daily[0]?.temperatureMax ?? weather.current.temperature)}°</div>
        <WeatherGlyph code={weather.current.weatherCode} isDay={weather.current.isDay} className="weather-debug-glyph" />
        <div className="weather-debug-card-stats"><span>风 {Math.round(weather.current.windSpeed)} km/h</span><span>湿度 {weather.current.humidity}%</span><span>降水 {weather.daily[0]?.precipitationProbability ?? 0}%</span></div>
      </div>
      {ready && <div className="weather-debug-card-shade" />}
    </div>
  )
}

function DebugApp() {
  const [scenarioId, setScenarioId] = useState<WeatherDebugScenarioId>('clear')
  const [isDay, setIsDay] = useState(true)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [fullReady, setFullReady] = useState(false)
  const [compactReady, setCompactReady] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const scenarioIndex = WEATHER_DEBUG_SCENARIOS.findIndex(item => item.id === scenarioId)
  const scenario = WEATHER_DEBUG_SCENARIOS[scenarioIndex]
  const weather = useMemo(() => createWeatherDebugSnapshot(scenarioId, isDay), [scenarioId, isDay])
  const scene = useMemo(() => createAppleWeatherSceneModel(weather), [weather])
  const sceneDefinition = APPLE_WEATHER_SCENES[scene.id as keyof typeof APPLE_WEATHER_SCENES]

  const selectScenario = (id: WeatherDebugScenarioId) => {
    setScenarioId(id)
    setFullReady(false)
    setCompactReady(false)
  }
  const moveScenario = (offset: number) => {
    const next = (scenarioIndex + offset + WEATHER_DEBUG_SCENARIOS.length) % WEATHER_DEBUG_SCENARIOS.length
    selectScenario(WEATHER_DEBUG_SCENARIOS[next].id)
  }

  return (
    <main className="weather-debug-root">
      <header className="weather-debug-header">
        <div>
          <div className="weather-debug-eyebrow">WAVEFORGE WEATHER LAB</div>
          <h1>Apple Weather Scene Comparison</h1>
          <p>选择一种天气和昼夜状态，逐项检查完整场景与桌面卡片。</p>
        </div>
        <label className="weather-debug-motion-toggle">
          <input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} />
          静态帧
        </label>
      </header>

      <section className="weather-debug-controls" aria-label="天气场景选择">
        <button type="button" onClick={() => moveScenario(-1)} aria-label="上一个天气"><ChevronLeft /></button>
        <div className="weather-debug-scenario-list">
          {WEATHER_DEBUG_SCENARIOS.map(item => (
            <button key={item.id} type="button" data-active={scenarioId === item.id} onClick={() => selectScenario(item.id)}>{item.label}</button>
          ))}
        </div>
        <button type="button" onClick={() => moveScenario(1)} aria-label="下一个天气"><ChevronRight /></button>
        <div className="weather-debug-day-toggle">
          <button type="button" data-active={isDay} onClick={() => { setIsDay(true); setFullReady(false); setCompactReady(false) }}><Sun />白天</button>
          <button type="button" data-active={!isDay} onClick={() => { setIsDay(false); setFullReady(false); setCompactReady(false) }}><Moon />夜间</button>
        </div>
      </section>

      <section className="weather-debug-overview">
        <div className="weather-debug-overview-meta">
          <span className="weather-debug-chip">scene={scene.id}</span>
          <span className="weather-debug-chip">wmo={scenario.code}</span>
          <span className="weather-debug-chip">card=full/simple</span>
          <span className="weather-debug-chip">{fullReady && compactReady ? 'Apple assets ready' : 'Loading Apple assets...'}</span>
        </div>
        <button className="weather-debug-detail-button" type="button" onClick={() => setDetailsOpen(true)}><CloudSun />打开完整天气页</button>
      </section>

      <section className="weather-debug-stage" data-scene={scene.id}>
        <AppleWeatherScene key={`full-${scene.id}-${reducedMotion}`} scene={scene} active reducedMotion={reducedMotion} onReady={() => setFullReady(true)} onUnavailable={() => setFullReady(false)} />
        <div className="weather-debug-stage-shade" />
        <div className="weather-debug-stage-copy">
          <div className="weather-debug-stage-label">FULL-SCREEN APPLE SCENE</div>
          <h2>{scenario.label} · {isDay ? '白天' : '夜间'}</h2>
          <div className="weather-debug-stage-temp">{Math.round(weather.current.temperature)}°</div>
          <p>{getWeatherLabel(weather.current.weatherCode)} · 云量 {weather.current.cloudCover}% · 风 {Math.round(weather.current.windSpeed)} km/h</p>
          <div className="weather-debug-assets">{sceneDefinition?.assets.join(' · ')}</div>
        </div>
      </section>

      <section className="weather-debug-section">
        <div className="weather-debug-section-heading"><div><div>DESKTOP WEATHER CARDS</div><p>与桌面模式同尺寸和低性能预算的背景对照。</p></div><span>{scene.id}</span></div>
        <div className="weather-debug-card-grid">
          <article><h3>Desktop Full <code>card=full</code></h3><div className="weather-debug-card-host">
            <AppleWeatherCompactScene key={`compact-full-${scene.id}-${reducedMotion}`} scene={scene} active reducedMotion={reducedMotion} onReady={() => setCompactReady(true)} onUnavailable={() => setCompactReady(false)} />
            <FullCardPreview weather={weather} ready={compactReady} />
          </div></article>
          <article><h3>Desktop Simple <code>card=simple</code></h3><div className="weather-debug-card-host weather-debug-simple-host">
            <AppleWeatherCompactScene key={`compact-simple-${scene.id}-${reducedMotion}`} scene={scene} active reducedMotion={reducedMotion} onReady={() => setCompactReady(true)} onUnavailable={() => setCompactReady(false)} />
            <WeatherSimpleCard weather={weather} locationLabel="浦东新区" appleSceneReady={compactReady} />
          </div></article>
        </div>
      </section>

      <section className="weather-debug-feedback">
        <h2>反馈标识</h2>
        <p>直接告诉我：<code>scene={scene.id}</code> 的云、太阳、月亮、雨雪或闪电需要怎样调整；也可以指定 <code>card=full</code> 或 <code>card=simple</code>。</p>
        <pre>{JSON.stringify({ scene: scene.id, wmo: scenario.code, isDay, fullReady, compactReady, assets: sceneDefinition?.assets ?? [] }, null, 2)}</pre>
      </section>

      <WeatherDetailsModal
        open={detailsOpen}
        weather={weather}
        onClose={() => setDetailsOpen(false)}
        onRefresh={() => undefined}
        loading={false}
        hazards={null}
        hazardLoading={false}
        hazardErrors={{ typhoons: '', earthquakes: '' }}
        hazardTransportError=""
        initialTab="weather"
        onHazardRefresh={() => undefined}
        onHazardEnsure={() => undefined}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<DebugApp />)
