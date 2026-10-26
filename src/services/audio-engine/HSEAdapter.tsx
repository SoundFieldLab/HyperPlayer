/**
 * HSEAdapter —— v3 音效引擎适配器（studioMode: 'custom'）
 *
 * 转发 HyperSoundEngine-v1/attachHSE 的自由函数（模块单例模式）。
 * v3 是纯 TS DSP 内核引擎，响度归一化/频响补偿都在引擎内实时实现（不走外部服务）。
 * 导出状态（exporting）上提到 adapter，通过 onExportingChange 事件通知 App 重渲染。
 *
 * HSE 模块树经动态 import() 加载（性能优化计划 1.0 §6.2）：引擎只在首次建音频图时
 * 才真正需要，静态 import 会把整棵 HSE 树拖进首包。加载句柄全 adapter 共享（只加载一次）；
 * attach/exportMp3 等 async 方法 await 加载；dispose/isAttached/setSystemVolume 是同步
 * 签名，在模块就绪前按「引擎尚不存在」语义兜底（未加载 ⇒ 未 attach ⇒ 无需转发），
 * 就绪后经 engineModule 同步转发。App 在 preloadOnIdle 里调 warmHSEEngineModule() 预热，
 * 保证首次播放前 chunk 已就绪（即使没来得及，attach 自身也会 await 加载，只是慢一拍）。
 */

import { lazy, useEffect, useState } from 'react'
import type { AudioEngineVersion } from '../audioEngineVersion'
import type {
  IAudioEngineAdapter,
  AudioGraphHandle,
  EngineCapabilities,
  RenderStudioProps,
  IAudioEngineUiBridge,
  EnginePlaybackSource,
} from './types'

type AttachHSEModule = typeof import('../HyperSoundEngine-v1/attachHSE')

let engineModulePromise: Promise<AttachHSEModule> | null = null
let engineModule: AttachHSEModule | null = null

function loadEngineModule(): Promise<AttachHSEModule> {
  if (!engineModulePromise) {
    engineModulePromise = import('../HyperSoundEngine-v1/attachHSE').then((m) => {
      engineModule = m
      return m
    })
  }
  return engineModulePromise
}

/** 空闲期预热入口（App 的 preloadOnIdle 调用）：把 HSE chunk 提前备好，首次播放零等待 */
export function warmHSEEngineModule(): Promise<AttachHSEModule> {
  return loadEngineModule()
}

const LazyHSEMixingStudio = lazy(() =>
  import('../HyperSoundEngine-v1/ui').then((m) => ({ default: m.HSEMixingStudio })),
)

/**
 * 调音室门组件：HSEMixingStudio 的 bridge prop 不可空（getHSEBridge 按需创建），
 * 而 getHSEBridge 属于 HSE 模块树——必须等模块加载完成再取 bridge 并渲染，
 * 否则模块未加载时（预热尚未跑完且从未播放）会拿到 undefined。
 */
function HSEStudioWithEngine(props: Omit<React.ComponentProps<typeof LazyHSEMixingStudio>, 'bridge'>) {
  const [engine, setEngine] = useState<AttachHSEModule | null>(engineModule)
  useEffect(() => {
    if (engine) return
    let active = true
    void loadEngineModule().then((m) => {
      if (active) setEngine(m)
    })
    return () => { active = false }
  }, [engine])
  if (!engine) return null
  return <LazyHSEMixingStudio bridge={engine.getHSEBridge()} {...props} />
}

export class HSEAdapter implements IAudioEngineAdapter {
  private exporting = false
  private exportingCallbacks = new Set<(exporting: boolean) => void>()
  /** 模块就绪前收到的最近一次系统音量，attach 完成后重放，避免丢设定 */
  private lastSystemVolume: number | null = null
  private playbackSource: EnginePlaybackSource | null = null
  private scanController: AbortController | null = null

  readonly version: AudioEngineVersion = 'hse'
  readonly capabilities: EngineCapabilities = {
    supportsSystemVolume: true,
    supportsLoudnessNormalization: false, // v3 引擎内实时实现，不走外部服务
    supportsLowVolumeHint: false,
  }
  readonly studioMode = 'custom' as const

  async attach(handle: AudioGraphHandle): Promise<void> {
    const m = await loadEngineModule()
    await m.attachHSE(handle)
    if (this.lastSystemVolume !== null) m.setHSESystemVolume(this.lastSystemVolume)
  }

  dispose(): void {
    // 模块未加载 ⇒ 引擎从未 attach，无需 detach
    this.scanController?.abort()
    this.scanController = null
    this.playbackSource = null
    engineModule?.setHSETrackReplayGainTags(null)
    engineModule?.detachHSE()
  }

  isAttached(): boolean {
    return engineModule ? engineModule.isHSEAttached() : false
  }

  setSystemVolume(volume: number): void {
    this.lastSystemVolume = volume
    engineModule?.setHSESystemVolume(volume)
  }

  /**
   * 播放源通知（useAudioPlayer 在正式提交/接管/清空时经 App 推送）：
   * 身份（trackKey）与 URL 分开判重，避免同 URL 换曲目被吞；先清旧增益，
   * 任何失败、直播和取消路径都不会沿用上一首。已有标签直传，否则按 url 扫描。
   * 模块未就绪时链式等待加载后转发（attach 前 HSE 模块内部安全 no-op）。
   */
  setPlaybackSource(source: EnginePlaybackSource | null): void {
    const previous = this.playbackSource
    if (source && previous && source.trackKey === previous.trackKey && source.url === previous.url
      && source.isLive === previous.isLive && source.replayGainTags === previous.replayGainTags) return
    this.scanController?.abort()
    this.scanController = null
    this.playbackSource = source
    void loadEngineModule()
      .then((m) => {
        m.setHSETrackReplayGainTags(null)
        if (!source || source.isLive || !source.url) return
        if (source.replayGainTags !== undefined) {
          m.setHSETrackReplayGainTags(source.replayGainTags)
          return
        }
        const controller = new AbortController()
        this.scanController = controller
        return m.scanHSETrackReplayGain(source.url, controller.signal)
      })
      .catch(() => { /* 模块加载失败：引擎不可用，跳过注入 */ })
  }

  applyLoudnessNormalization(): void {
    // v3 响度归一化在引擎内实时实现（LufsMeter DSP 模块），无需外部服务调用，no-op
  }

  resetLoudnessNormalization(): void {
    // v3 响度归一化引擎内自治，no-op
  }

  async exportMp3(sourceUrl: string, durationSeconds: number, options?: { fileName?: string }): Promise<void> {
    return this.exportAudio('mp3', sourceUrl, durationSeconds, options)
  }

  /** 离线 WAV 导出（16-bit PCM，量化模式默认 TPDF）；与 MP3 共用同一段 HSE PCM 渲染链 */
  async exportWav(sourceUrl: string, durationSeconds: number, options?: { fileName?: string }): Promise<void> {
    return this.exportAudio('wav', sourceUrl, durationSeconds, options)
  }

  private async exportAudio(format: 'mp3' | 'wav', sourceUrl: string, durationSeconds: number, options?: { fileName?: string }): Promise<void> {
    if (this.exporting) throw new Error('已有音频正在导出，请稍候')
    if (!sourceUrl) throw new Error('请先播放要导出的歌曲')
    this.setExporting(true)
    try {
      const m = await loadEngineModule()
      await (format === 'wav' ? m.exportHSEWav : m.exportHSEMp3)(sourceUrl, durationSeconds, options)
    } finally {
      this.setExporting(false)
    }
  }

  renderStudio(props: RenderStudioProps): React.ReactNode {
    const { sourceUrl, sourceDuration, exportFileName, ...commonProps } = props
    // v3 调音室需要 bridge + 导出闭包（MP3/WAV 共用 exporting 状态，由 exportMp3/exportWav 内部管理）+ exporting 状态
    // 导出闭包：包装 adapter 导出方法，错误时弹 toast
    const runExport = async (format: 'mp3' | 'wav') => {
      if (!sourceUrl) return
      try {
        if (format === 'mp3') await this.exportMp3(sourceUrl, sourceDuration || 0, { fileName: exportFileName })
        else await this.exportWav(sourceUrl, sourceDuration || 0, { fileName: exportFileName })
      } catch (err) {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: `导出失败：${err instanceof Error ? err.message : String(err)}`, type: 'error' },
        }))
      }
    }
    const exportMp3 = sourceUrl ? () => runExport('mp3') : null
    const exportWav = sourceUrl ? () => runExport('wav') : null
    return (
      <HSEStudioWithEngine
        exportMp3={exportMp3}
        exportWav={exportWav}
        exporting={this.exporting}
        {...commonProps}
      />
    )
  }

  getUiBridge(): IAudioEngineUiBridge | null {
    return null
  }

  isExporting(): boolean {
    return this.exporting
  }

  onExportingChange(cb: (exporting: boolean) => void): () => void {
    this.exportingCallbacks.add(cb)
    return () => {
      this.exportingCallbacks.delete(cb)
    }
  }

  private setExporting(value: boolean): void {
    this.exporting = value
    for (const cb of this.exportingCallbacks) cb(value)
  }
}
