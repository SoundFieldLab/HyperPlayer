import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import HSEMixingStudio from '../services/HyperSoundEngine-v1/ui/HSEMixingStudio'
import SpatialAudioPage from '../services/HyperSoundEngine-v1/ui/pages/SpatialAudioPage'
import { createHSEUiBridge } from '../services/HyperSoundEngine-v1/ui/bridge'
import { useHSEParams } from '../services/HyperSoundEngine-v1/ui/hooks'
import { useHSETheme, themeVariables } from '../services/HyperSoundEngine-v1/ui/hse-theme'
import { HyperSoundEngineHost, type HSEAudioContextLike } from '../services/HyperSoundEngine-v1/src/integration/HyperSoundEngineHost'
import { createDefaultParams, createDefaultSpatialSettings } from '../services/HyperSoundEngine-v1/src/types'
import { ActionBtn } from '../services/HyperSoundEngine-v1/ui/components/Primitives'
import { decodeSpatialAudioFile } from '../services/HyperSoundEngine-v1/src/integration/SpatialAudioSource'
import './preview.css'

const host = new HyperSoundEngineHost({ mode: 'auto', workletUrl: '/hse-worklet.js' })
const raw = createHSEUiBridge(host.engine, 48000)
const setRawParams = raw.setParams, getRawStats = raw.getStats, getRawAnalysis = raw.getAnalysis
const paramsListeners = new Set<() => void>()
// 场景接口内部通过 impl.setParams 应用参数，必须包装同一个桥对象。
const bridge = Object.assign(raw, {
  setParams: (params: Parameters<typeof raw.setParams>[0]) => {
    setRawParams(params); host.setParams(params)
    for (const listener of Array.from(paramsListeners)) listener()
  },
  subscribeParams: (listener: () => void) => { paramsListeners.add(listener); return () => { paramsListeners.delete(listener) } },
  getStats: () => host.getLastStats() ?? getRawStats(),
  getAnalysis: () => host.getLastAnalysis() ?? getRawAnalysis(),
  setSpatialHrtf: host.setSpatialHrtf.bind(host),
  setSpatialHeadPose: host.setSpatialHeadPose.bind(host),
  getSpatialHrtfSource: () => host.engine.getSpatialHrtfSource(),
  getWaveform: () => {
    if (!host.getMode() || !leftAnalyser || !rightAnalyser || !leftSamples || !rightSamples) return null
    leftAnalyser.getFloatTimeDomainData(leftSamples)
    rightAnalyser.getFloatTimeDomainData(rightSamples)
    return { left: leftSamples, right: rightSamples }
  },
})
const open3d = new URLSearchParams(location.search).get('view') === '3d'
const params = createDefaultParams(48000); params.eq.enabled = false; params.spatial!.mode = open3d ? 'world' : 'instant'; params.spatial!.masterGain = 1
bridge.setParams(params)
let context: AudioContext | null = null, input: GainNode | null = null, source: AudioBufferSourceNode | null = null
let audible: GainNode | null = null
let leftAnalyser: AnalyserNode | null = null, rightAnalyser: AnalyserNode | null = null
let leftSamples: Float32Array<ArrayBuffer> | null = null, rightSamples: Float32Array<ArrayBuffer> | null = null
let preparing: Promise<void> | null = null

function Preview() {
  const theme = useHSETheme(), controller = useHSEParams(bridge)
  const [studioOpen, setStudioOpen] = useState(new URLSearchParams(location.search).get('studio') === '1')
  const [status, setStatus] = useState('独立快照 · 未启动音频'), [muted, setMuted] = useState(true)
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  const picker = useRef<HTMLInputElement>(null)
  const [sourceOrder, setSourceOrder] = useState('')
  const prepare = async () => {
    if (!context && !preparing) preparing = (async () => {
      const nextContext = new AudioContext({ sampleRate: 48000 })
      context = nextContext; input = nextContext.createGain(); audible = nextContext.createGain()
      audible.gain.value = mutedRef.current ? 0 : 0.3; audible.connect(nextContext.destination)
      const splitter = nextContext.createChannelSplitter(2)
      leftAnalyser = nextContext.createAnalyser(); rightAnalyser = nextContext.createAnalyser()
      for (const analyser of [leftAnalyser, rightAnalyser]) {
        analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0
        analyser.channelCount = 1; analyser.channelCountMode = 'explicit'; analyser.channelInterpretation = 'discrete'
      }
      leftSamples = new Float32Array(leftAnalyser.fftSize); rightSamples = new Float32Array(rightAnalyser.fftSize)
      splitter.connect(leftAnalyser, 0); splitter.connect(rightAnalyser, 1)
      // 在试听静音之前读取 DSP 输出；独立静音分支保证分析节点持续收到音频。
      const analysisSink = nextContext.createGain(); analysisSink.gain.value = 0
      leftAnalyser.connect(analysisSink); rightAnalyser.connect(analysisSink); analysisSink.connect(nextContext.destination)
      try {
        // 宿主接口把 onaudioprocess 建模为可选项；DOM 原生类型另允许 null。
        await host.attach({ audioContext: nextContext as unknown as HSEAudioContextLike, masterGain: input, analyser: audible,
          channelSplitterNode: splitter }, bridge.getParams())
      } catch (error) {
        await nextContext.close()
        context = null; input = null; audible = null; leftAnalyser = null; rightAnalyser = null; leftSamples = null; rightSamples = null
        throw error
      }
    })().finally(() => { preparing = null })
    await preparing
    if (!context) throw new Error('音频设备尚未准备好，请重试。')
    await context.resume()
  }
  const toggleAudition = () => {
    const value = !mutedRef.current
    mutedRef.current = value; setMuted(value)
    if (audible && context) audible.gain.setTargetAtTime(value ? 0 : 0.3, context.currentTime, 0.02)
  }
  const transportControls = <div className="hse-preview-transport" role="group" aria-label="本地音频试听">
    <button type="button" className="hse-glass-button" onClick={() => void play()}>生成测试信号</button>
    <button type="button" className="hse-glass-button" onClick={() => picker.current?.click()}>加载本地音频</button>
    <button type="button" className={`hse-glass-button ${muted ? '' : 'hse-glass-primary'}`} aria-pressed={!muted}
      onClick={toggleAudition}>{muted ? '开启试听' : '静音'}</button>
    <span className="hse-preview-source-status" role="status" title={status}>{status}</span>
  </div>
  const play = async (file?: File) => {
    try {
      await prepare(); source?.stop(); source?.disconnect()
      let buffer: AudioBuffer
      let sourceDescription = '立体声合成信号'
      if (file) {
        const selectedFormat = bridge.getParams().spatial?.inputFormat
        const ambisonic = selectedFormat?.startsWith('ambix') || selectedFormat === 'fuma'
        const decoded = await decodeSpatialAudioFile(file, context!, {
          inputFormat: ambisonic ? selectedFormat as 'ambix' | 'ambix1' | 'ambix2' | 'ambix3' | 'fuma' : 'channels',
          ...(!ambisonic && sourceOrder.trim() ? { sourceChannelLabels: sourceOrder.trim().split(/[\s,]+/) } : {}),
        })
        if (decoded.layout === 'unknown' || decoded.layout === 'custom') throw new Error('该音源的声道顺序尚未确认；请先按已知声道标签转换为标准布局 WAV。')
        buffer = context!.createBuffer(decoded.channels.length, decoded.frames, decoded.sampleRate)
        decoded.channels.forEach((channel, index) => buffer.copyToChannel(channel, index))
        const next = bridge.getParams()
        next.spatial ??= createDefaultSpatialSettings()
        if (['quad', '51', '71', '714'].includes(decoded.layout)) {
          next.spatial.inputFormat = 'channels'; next.spatial.instant.multichannelAuto = true
          next.spatial.instant.multichannelLayout = decoded.layout as 'quad' | '51' | '71' | '714'
        } else if (decoded.layout === 'mono' || decoded.layout === 'stereo') {
          next.spatial.instant.multichannelLayout = 'auto'
          if (next.spatial.inputFormat === 'channels') next.spatial.instant.multichannelAuto = false
        }
        bridge.setParams(next)
        sourceDescription = `${file.name} · ${decoded.channelLabels.join(' / ')}${decoded.warnings.length ? ' · ' + decoded.warnings.join('；') : ''}`
      } else {
        buffer = context!.createBuffer(2, 48000 * 4, 48000)
        const next = bridge.getParams()
        next.spatial ??= createDefaultSpatialSettings()
        next.spatial.instant.multichannelLayout = 'auto'
        next.spatial.instant.multichannelAuto = false
        // 保留用户主动选择的立体声上混；合成信号不能沿用之前文件的 HOA 声道约定。
        if (next.spatial.inputFormat !== 'stereo51' && next.spatial.inputFormat !== 'stereo71')
          next.spatial.inputFormat = 'channels'
        bridge.setParams(next)
      }
      if (!file) for (let channel = 0; channel < 2; channel++) {
        const output = buffer.getChannelData(channel)
        for (let i = 0; i < output.length; i++) output[i] = 0.08 * Math.sin(i * 2 * Math.PI * (channel ? 523.25 : 392) / 48000)
      }
      source = context!.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(input!); source.start()
      host.setSpatialInputChannelCount(buffer.numberOfChannels)
      setStatus(`${host.getMode()} · ${sourceDescription} · ${buffer.numberOfChannels} 声道`)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  ;(window as unknown as { spatialPreview: unknown }).spatialPreview = { bridge, host, play, getParams: bridge.getParams }
  return <div className="hse-ui mx-auto max-w-[1320px] px-4 py-6 md:px-8" style={themeVariables(theme)}>
    <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-xs font-semibold tracking-[0.2em] text-[#31685a]">HSE / SPATIAL LAB</p><h1 className="mt-2 text-2xl font-semibold">空间音频独立预览</h1><p role="status" className="mt-2 text-xs text-[#4e6258]">{status}</p></div>
      <div className="flex flex-wrap gap-2"><ActionBtn theme={theme} onClick={() => setStudioOpen(true)}>打开完整调音室</ActionBtn>
        {!studioOpen && transportControls}</div>
    </header>
    <input ref={picker} type="file" accept="audio/*" className="hidden" aria-label="加载本地音频文件" onChange={event => { const file = event.target.files?.[0]; if (file) void play(file); event.target.value = '' }} />
    <label className="mb-5 block text-xs text-[#4e6258]">可选：音源物理声道顺序（无布局标记时填写，如 FL FR FC LFE BL BR SL SR）
      <input aria-label="音源物理声道顺序" className="mt-2 min-h-10 w-full rounded-xl border border-[#b5c6ba] bg-[#f8faf7] px-3" value={sourceOrder} onChange={event => setSourceOrder(event.currentTarget.value)} /></label>
    {!studioOpen && <SpatialAudioPage bridge={bridge} controller={controller} theme={theme} initialView={open3d ? '3d' : 'top'} />}
    {studioOpen && <HSEMixingStudio bridge={bridge} onClose={() => setStudioOpen(false)} playerTheme="light" transportControls={transportControls} />}
    <footer className="mt-6 text-xs leading-relaxed text-[#4e6258]">仅使用独立快照源码与 Worklet。本地音频不上传，默认静音。此页面不连接主播放器账号或设置。</footer>
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
