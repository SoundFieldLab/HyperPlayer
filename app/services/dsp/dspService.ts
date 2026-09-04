// DSP 服务（D34）：HSE TS 控制面 —— 配置快照管理、预设、HSE2 导入导出。
// 权威 DSP = shared/hypersoundengine（AudioWorklet 渲染线程）；
// 本服务只管理参数快照（主线程），revision 严格递增、latest-config-wins 语义对齐 D32。
// 配置持久化：Rust app-data JSON 哑 KV（settings_get/set，schema 归 TS）。

import { createDefaultParams, SCENE_PRESETS, encodeShareCode, decodeShareCode, type HyperSoundEngineParams } from 'hypersoundengine'
import type { DspApplyResultDto, DspConfigurationDto, DspPresetDto } from '../../bridge/contracts'
import { bridge } from '../../bridge'
import { playbackService } from '../playback/playbackService'

const DSP_CONFIG_VERSION = 1

/** 配置 ↔ HSE 参数快照映射：DspConfigurationDto 的 section 直接对应 HSE section */
function configurationToParams(configuration: DspConfigurationDto, sampleRate: number): HyperSoundEngineParams {
  const params = createDefaultParams(sampleRate)
  for (const [section, value] of Object.entries(configuration)) {
    if (section === 'revision' || section === 'midSide') continue
    const target = params[section as keyof HyperSoundEngineParams]
    if (target && typeof target === 'object' && typeof value === 'object' && value !== null) {
      Object.assign(target, value)
    }
  }
  return params
}

function paramsToConfiguration(params: HyperSoundEngineParams, revision: string): DspConfigurationDto {
  const configuration: Record<string, unknown> = { revision }
  for (const [section, value] of Object.entries(params)) {
    if (section === 'sampleRate' || section === 'sceneId' || section === 'customized') continue
    if (value && typeof value === 'object') {
      configuration[section] = { ...(value as Record<string, unknown>) }
    }
  }
  return configuration as unknown as DspConfigurationDto
}

export class DspService {
  private revision = 1n
  private configuration: DspConfigurationDto | null = null
  private presets: DspPresetDto[] = []
  private unsupportedStages: string[] = []

  async load(): Promise<void> {
    // 从哑 KV 恢复配置（fail-close：版本未知/缺失回落默认）
    try {
      const settings = await bridge.getSettings()
      const dsp = (settings as unknown as { dsp?: { version?: number; revision?: string; configuration?: unknown } }).dsp
      if (dsp && dsp.version === DSP_CONFIG_VERSION && dsp.configuration) {
        this.configuration = { revision: dsp.revision ?? '1', ...(dsp.configuration as Record<string, unknown>) } as DspConfigurationDto
        this.revision = BigInt(dsp.revision ?? '1')
      }
    } catch {
      this.configuration = null
    }
    this.buildPresets()
  }

  private buildPresets(): void {
    this.presets = SCENE_PRESETS.map((scene) => ({
      id: scene.id,
      name: scene.name ?? scene.id,
      description: scene.description ?? null,
      configuration: paramsToConfiguration(scene.params, '1'),
    }))
  }

  getConfiguration(): DspConfigurationDto {
    if (!this.configuration) {
      const sampleRate = typeof window !== 'undefined' ? 48000 : 48000
      this.configuration = paramsToConfiguration(createDefaultParams(sampleRate), this.revision.toString())
    }
    return this.configuration
  }

  listPresets(): DspPresetDto[] {
    return this.presets
  }

  async configure(request: DspConfigurationDto): Promise<DspApplyResultDto> {
    const incoming = BigInt(request.revision)
    if (incoming <= this.revision) {
      throw new Error(`DSP revision 必须严格递增：收到 ${request.revision}，当前 ${this.revision}`)
    }
    this.revision = incoming
    this.configuration = { ...request }
    await this.applyToEngine()
    await this.persist()
    return {
      status: 'applied',
      revision: this.revision.toString(),
      configuration: this.configuration,
      engine: { dspExecution: { revision: this.revision.toString() } },
      partial: false,
      unsupportedStages: this.unsupportedStages,
    }
  }

  async applyPreset(presetId: string, revision: string): Promise<DspApplyResultDto> {
    const preset = this.presets.find((item) => item.id === presetId)
    if (!preset) throw new Error(`未知 DSP 预设：${presetId}`)
    return this.configure({ ...preset.configuration, revision })
  }

  async importHse2(code: string, revision: string): Promise<DspApplyResultDto> {
    const params = decodeShareCode(code)
    const configuration = paramsToConfiguration(params, revision)
    return this.configure(configuration)
  }

  async exportHse2(): Promise<{ code: string; unsupportedStages: string[] }> {
    const sampleRate = typeof window !== 'undefined' ? 48000 : 48000
    const params = configurationToParams(this.getConfiguration(), sampleRate)
    return { code: encodeShareCode(params), unsupportedStages: this.unsupportedStages }
  }

  private async applyToEngine(): Promise<void> {
    const host = playbackService.getHseHost()
    if (!host) return
    const sampleRate = host.engine.getParams().sampleRate || 48000
    const params = configurationToParams(this.getConfiguration(), sampleRate)
    await host.setParams(params)
  }

  private async persist(): Promise<void> {
    try {
      const settings = await bridge.getSettings()
      await bridge.updateSettings({
        ...settings,
        dsp: {
          version: DSP_CONFIG_VERSION,
          revision: this.revision.toString(),
          configuration: this.configuration,
        },
      } as never)
    } catch {
      // 持久化失败不影响本次会话
    }
  }
}

export const dspService = new DspService()
