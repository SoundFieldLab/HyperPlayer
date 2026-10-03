/**
 * V3Adapter —— v3 音效引擎适配器（studioMode: 'custom'）
 *
 * 转发 HyperSoundEngine-v1/attachV3Engine 的自由函数（模块单例模式）。
 * v3 是纯 TS DSP 内核引擎，响度归一化/频响补偿都在引擎内实时实现（不走外部服务）。
 * 导出状态（exporting）上提到 adapter，通过 onExportingChange 事件通知 App 重渲染。
 *
 * HSE 模块树经动态 import() 加载（性能优化计划 1.0 §6.2）：引擎只在首次建音频图时
 * 才真正需要，静态 import 会把整棵 HSE 树拖进首包。加载句柄全 adapter 共享（只加载一次）；
 * attach/exportMp3 等 async 方法 await 加载；dispose/isAttached/setSystemVolume 是同步
 * 签名，在模块就绪前按「引擎尚不存在」语义兜底（未加载 ⇒ 未 attach ⇒ 无需转发），
 * 就绪后经 engineModule 同步转发。App 在 preloadOnIdle 里调 warmV3EngineModule() 预热，
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
} from './types'

type AttachV3EngineModule = typeof import('../HyperSoundEngine-v1/attachV3Engine')

let engineModulePromise: Promise<AttachV3EngineModule> | null = null
let engineModule: AttachV3EngineModule | null = null

function loadEngineModule(): Promise<AttachV3EngineModule> {
  if (!engineModulePromise) {
    engineModulePromise = import('../HyperSoundEngine-v1/attachV3Engine').then((m) => {
      engineModule = m
      return m
    })
  }
  return engineModulePromise
}

/** 空闲期预热入口（App 的 preloadOnIdle 调用）：把 HSE chunk 提前备好，首次播放零等待 */
export function warmV3EngineModule(): Promise<AttachV3EngineModule> {
  return loadEngineModule()
}

const LazyMixingStudioV3 = lazy(() =>
  import('../HyperSoundEngine-v1/ui').then((m) => ({ default: m.V3MixingStudio })),
)

/**
 * 调音室门组件：V3MixingStudio 的 bridge prop 不可空（getV3Bridge 按需创建），
 * 而 getV3Bridge 属于 HSE 模块树——必须等模块加载完成再取 bridge 并渲染，
 * 否则模块未加载时（预热尚未跑完且从未播放）会拿到 undefined。
 */
function V3StudioWithEngine(props: Omit<React.ComponentProps<typeof LazyMixingStudioV3>, 'bridge'>) {
  const [engine, setEngine] = useState<AttachV3EngineModule | null>(engineModule)
  useEffect(() => {
    if (engine) return
    let active = true
    void loadEngineModule().then((m) => {
      if (active) setEngine(m)
    })
    return () => { active = false }
  }, [engine])
  if (!engine) return null
  return <LazyMixingStudioV3 bridge={engine.getV3Bridge()} {...props} />
}

export class V3Adapter implements IAudioEngineAdapter {
  private exporting = false
  private exportingCallbacks = new Set<(exporting: boolean) => void>()
  /** 模块就绪前收到的最近一次系统音量，attach 完成后重放，避免丢设定 */
  private lastSystemVolume: number | null = null

  readonly version: AudioEngineVersion = 'v3'
  readonly capabilities: EngineCapabilities = {
    supportsSystemVolume: true,
    supportsLoudnessNormalization: false, // v3 引擎内实时实现，不走外部服务
    supportsLowVolumeHint: false,
  }
  readonly studioMode = 'custom' as const

  async attach(handle: AudioGraphHandle): Promise<void> {
    const m = await loadEngineModule()
    await m.attachV3Engine(handle)
    if (this.lastSystemVolume !== null) m.setV3SystemVolume(this.lastSystemVolume)
  }

  dispose(): void {
    // 模块未加载 ⇒ 引擎从未 attach，无需 detach
    engineModule?.detachV3Engine()
  }

  isAttached(): boolean {
    return engineModule ? engineModule.isV3Attached() : false
  }

  setSystemVolume(volume: number): void {
    this.lastSystemVolume = volume
    engineModule?.setV3SystemVolume(volume)
  }

  applyLoudnessNormalization(): void {
    // v3 响度归一化在引擎内实时实现（LufsMeter DSP 模块），无需外部服务调用，no-op
  }

  resetLoudnessNormalization(): void {
    // v3 响度归一化引擎内自治，no-op
  }

  async exportMp3(sourceUrl: string, durationSeconds: number, options?: { fileName?: string }): Promise<void> {
    this.setExporting(true)
    try {
      const m = await loadEngineModule()
      await m.exportV3Mp3(sourceUrl, durationSeconds, options)
    } finally {
      this.setExporting(false)
    }
  }

  renderStudio(props: RenderStudioProps): React.ReactNode {
    const { sourceUrl, sourceDuration, exportFileName, ...commonProps } = props
    // v3 调音室需要 bridge + exportMp3 闭包 + exporting 状态
    // exportMp3 闭包：包装 adapter.exportMp3，错误时弹 toast
    const exportMp3 = sourceUrl
      ? async () => {
          try {
            await this.exportMp3(sourceUrl, sourceDuration || 0, { fileName: exportFileName })
          } catch (err) {
            window.dispatchEvent(new CustomEvent('showToast', {
              detail: { message: `导出失败：${err instanceof Error ? err.message : String(err)}`, type: 'error' },
            }))
          }
        }
      : null
    return (
      <V3StudioWithEngine
        exportMp3={exportMp3}
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
