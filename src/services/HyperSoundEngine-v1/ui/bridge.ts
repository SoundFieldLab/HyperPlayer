/**
 * HyperPlayer v3 调音室 UI —— 引擎桥（HSEUiBridge）
 *
 * UI 只依赖本文件的桥接口（不直接 import HyperSoundEngine），融合时把桥接实现换到
 * HyperPlayer 侧（引擎实例来自 HyperSoundEngineHost.engine 或直接 new HyperSoundEngine）即可。
 *
 * 桥职责：
 *  - 参数快照读写（setParams 每次收完整快照）；
 *  - 引擎统计/分析读取（LUFS、频谱、特征）；
 *  - 场景：内置 11 场景 + 我的场景（localStorage 持久化，快照去 IR 数据）；
 *  - 分享串：encode/decode（版本+校验+白名单，非法输入抛错）；
 *  - 听力测试状态机（HearingTest 封装）。
 */

import type { EngineAnalysis, EngineStats, ScenePreset, HSEEngineParams } from '../src/types'
import { createDefaultParams } from '../src/types'
import { HyperSoundEngine } from '../src/engine/HyperSoundEngine'
import {
  mergeBuiltinScenes,
  saveBuiltinSceneOverride,
  resetBuiltinSceneOverride,
  exportSceneLibraryJson,
  importSceneLibraryJson,
  exportPublishSeedTs,
} from './sceneStore'
import { encodeShareCode, decodeShareCode } from '../src/engine/ShareCodec'
import { HearingTest, type AudiogramPoint } from '../src/analysis/HearingTest'

/** 我的场景存储键（v3 独立命名空间，与 v2 区分） */
const MY_SCENES_KEY = 'hyperplayer:hse-my-scenes'
/** V3→HSE 命名统一前的历史键：loadMyScenes 时一次性迁移后移除 */
const LEGACY_MY_SCENES_KEY = 'hyperplayer:v3-my-scenes'
/** 我的场景上限（v3 独立命名空间，较 v2 的 8 提升至 20） */
export const MAX_MY_SCENES = 20

export interface HSEHearingSession {
  /** 当前待测步骤；null=未开始或已完成 */
  step: { freqHz: number; levelDb: number } | null
  /** 进度：当前频点序号（0-6）/ 频点内轮数（0-4），共 7 频点 × 5 轮 */
  freqIndex: number
  round: number
  done: boolean
  audiogram: AudiogramPoint[]
}

export interface HSEUiBridge {
  /** 当前参数快照（深拷贝，防止外部突变） */
  getParams(): HSEEngineParams
  /** 设置完整快照（引擎 setParams；UI 侧始终传 getParams 深拷贝修改后的版本） */
  setParams(p: HSEEngineParams): void
  getStats(): EngineStats
  getAnalysis(): EngineAnalysis
  getLatencySamples(): number
  getSampleRate(): number
  /** 内置 11 场景（含开发者微调覆盖，被改过的带 overridden 标记）+ 我的场景 */
  getScenes(): (ScenePreset & { overridden?: boolean })[]
  applyScene(id: string): void
  saveMyScene(name: string): boolean
  deleteMyScene(id: string): void
  /** 开发者模式：把完整参数快照存为某内置场景的微调覆盖（localStorage 持久化） */
  updateBuiltinScene(id: string, p: HSEEngineParams): boolean
  /** 开发者模式：还原内置场景为代码默认值（删除覆盖层） */
  resetBuiltinScene(id: string): void
  /** 导出场景库 JSON（内置覆盖 + 我的场景），备份/迁移用 */
  exportSceneLibrary(): string
  /** 导入场景库 JSON；非法输入抛 Error，返回写入数量 */
  importSceneLibrary(json: string): { overrides: number; myScenes: number }
  /** 导出「发布种子」TS 源码文本：替换 builtinSceneSeed.ts 后 commit/push 即全员生效 */
  exportPublishSeed(): string
  /** 导出分享串（完整参数快照，含版本+校验） */
  encodeShare(p: HSEEngineParams): string
  /** 解析分享串；非法输入抛 Error */
  decodeShare(code: string): HSEEngineParams
  /** 听力测试 */
  beginHearing(): void
  hearingStep(): HSEHearingSession
  answerHearing(heard: boolean): HSEHearingSession
  resetHearing(): void
}

/** 快照入库前去除不可序列化数据（卷积 IR 数组 → irName 引用语义） */
function sanitizeForStorage(p: HSEEngineParams): HSEEngineParams {
  const clone = JSON.parse(JSON.stringify(p)) as HSEEngineParams
  clone.reverb.convolution.ir = null
  return clone
}

function loadMyScenes(): ScenePreset[] {
  try {
    // 历史键迁移（V3→HSE 命名统一）：旧键一次性搬到新键，我的场景不丢
    let raw = localStorage.getItem(MY_SCENES_KEY)
    if (raw === null) {
      const legacy = localStorage.getItem(LEGACY_MY_SCENES_KEY)
      if (legacy !== null) {
        localStorage.setItem(MY_SCENES_KEY, legacy)
        localStorage.removeItem(LEGACY_MY_SCENES_KEY)
        raw = legacy
      }
    }
    if (!raw) return []
    const list = JSON.parse(raw) as ScenePreset[]
    return Array.isArray(list) ? list.filter((s) => s && typeof s.id === 'string') : []
  } catch {
    return []
  }
}

function saveMyScenes(list: ScenePreset[]): void {
  try {
    localStorage.setItem(MY_SCENES_KEY, JSON.stringify(list))
  } catch {
    // 存储不可用时静默（不影响播放）
  }
}

/** 把 HyperSoundEngine 包装成 UI 桥（融合时在 HyperPlayer 侧调用） */
export function createHSEUiBridge(engine: HyperSoundEngine, sampleRate: number): HSEUiBridge {
  const hearing = new HearingTest(sampleRate)
  let current: HSEEngineParams = createDefaultParams(sampleRate)
  engine.setParams(current)

  const readHearing = (): HSEHearingSession => {
    const step = hearing.nextStep()
    return {
      step,
      freqIndex: hearing.getFreqIndex(),
      round: hearing.getRound(),
      done: hearing.isDone(),
      audiogram: hearing.getAudiogram(),
    }
  }

  const impl: HSEUiBridge = {
    getParams: () => JSON.parse(JSON.stringify(current)) as HSEEngineParams,
    setParams: (p: HSEEngineParams) => {
      current = JSON.parse(JSON.stringify(p)) as HSEEngineParams
      engine.setParams(current)
    },
    getStats: () => engine.getStats(),
    getAnalysis: () => engine.getAnalysis(),
    getLatencySamples: () => engine.getLatencySamples(),
    getSampleRate: () => sampleRate,
    getScenes: () => [...mergeBuiltinScenes(), ...loadMyScenes()],
    applyScene: (id: string) => {
      const scene = mergeBuiltinScenes().find((s) => s.id === id) ?? loadMyScenes().find((s) => s.id === id)
      if (!scene) return
      // 音量控制是实时控制，独立于场景预设/组合：应用场景时保留当前响度归一化
      // 状态（外部增益/归一化模式），场景快照不得重置用户音量
      const ln = current.loudnessNormalization
      impl.setParams(scene.params)
      impl.setParams({ ...current, loudnessNormalization: ln })
    },
    saveMyScene: (name: string): boolean => {
      const mine = loadMyScenes()
      if (mine.length >= MAX_MY_SCENES) return false
      const snapshot = sanitizeForStorage(current)
      snapshot.sceneId = null
      snapshot.customized = true
      const scene: ScenePreset = {
        id: `my-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name,
        builtin: false,
        params: snapshot,
      }
      mine.push(scene)
      saveMyScenes(mine)
      return true
    },
    deleteMyScene: (id: string) => {
      saveMyScenes(loadMyScenes().filter((s) => s.id !== id))
    },
    updateBuiltinScene: (id: string, p: HSEEngineParams): boolean => saveBuiltinSceneOverride(id, p),
    resetBuiltinScene: (id: string) => {
      resetBuiltinSceneOverride(id)
    },
    exportSceneLibrary: () => exportSceneLibraryJson(loadMyScenes()),
    importSceneLibrary: (json: string) => importSceneLibraryJson(json, (list) => saveMyScenes(list)),
    exportPublishSeed: () => exportPublishSeedTs(),
    encodeShare: (p: HSEEngineParams) => encodeShareCode(p),
    decodeShare: (code: string) => decodeShareCode(code),
    beginHearing: () => hearing.begin(),
    hearingStep: () => readHearing(),
    answerHearing: (heard: boolean) => {
      hearing.answer(heard)
      return readHearing()
    },
    resetHearing: () => hearing.reset(),
  }
  return impl
}