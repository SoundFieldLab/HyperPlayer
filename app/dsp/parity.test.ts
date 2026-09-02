/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BassEnhancer,
  Biquad,
  ChorusEffect,
  Compressor,
  Convolver,
  Deesser,
  DelayEffect,
  DynamicEq,
  EqChain,
  FlangerEffect,
  FdnReverb,
  HyperSoundEngine,
  Limiter,
  LoudnessComp,
  MidSide,
  ModulationMatrix,
  PhaserEffect,
  ReverbSimple,
  TremoloEffect,
  createDefaultParams,
  type BassEnhancerSettings,
  type BiquadType,
  type ChorusSettings,
  type CompressorSettings,
  type DeesserSettings,
  type DelaySettings,
  type EqBand,
  type FlangerSettings,
  type HyperSoundEngineParams,
  type ModulationRoute,
  type PhaserSettings,
  type TremoloSettings,
} from '@hyperplayer/hse-ts-core'

interface VectorMeta {
  schemaVersion: number
  module: string
  case: string
  sampleRate: number
  blockSize: number
  channels: number
  frames: number
  params: Record<string, unknown>
  tolerance: { kind: string; value: number; floor: number }
  source: { project: string; version: string; commit: string }
}

interface VectorCase {
  label: string
  meta: VectorMeta
  bytes: Uint8Array
}

const VECTOR_DIRECTORY = resolve(process.cwd(), 'tests', 'fixtures', 'dsp')

function discoverCases(): VectorCase[] {
  if (!existsSync(VECTOR_DIRECTORY)) throw new Error('DSP 共享向量目录不存在')
  const names = readdirSync(VECTOR_DIRECTORY).filter((name) => name.endsWith('.json')).sort()
  return names.map((name) => {
    const label = name.replace(/\.json$/, '')
    const binaryPath = resolve(VECTOR_DIRECTORY, `${label}.f32`)
    if (!existsSync(binaryPath)) throw new Error(`${label}: 缺少同名 .f32 文件`)
    return {
      label,
      meta: JSON.parse(readFileSync(resolve(VECTOR_DIRECTORY, name), 'utf8')) as VectorMeta,
      bytes: readFileSync(binaryPath),
    }
  })
}

function validate(vector: VectorCase): void {
  const { meta, label, bytes } = vector
  if (meta.schemaVersion !== 1) throw new Error(`${label}: schemaVersion 必须为 1`)
  if (!['biquad', 'mid-side', 'compressor', 'chorus', 'deesser', 'delay', 'flanger', 'phaser', 'bass-enhancer', 'eq-chain', 'loudness-normalization', 'night-mode', 'surround3d', 'tremolo', 'reverb-simple', 'fdn-reverb', 'convolver', 'loudness-comp', 'dynamic-eq', 'limiter', 'modulation-matrix'].includes(meta.module)) {
    throw new Error(`${label}: 未知 DSP 模块 ${meta.module}`)
  }
  if (`${meta.module}.${meta.case}` !== label) throw new Error(`${label}: 文件名与元数据不一致`)
  if (meta.channels !== 2) throw new Error(`${label}: channels 必须为 2`)
  if (!(meta.frames > 0) || !(meta.blockSize > 0) || !(meta.sampleRate > 0)) {
    throw new Error(`${label}: frames/blockSize/sampleRate 必须为正数`)
  }
  if (meta.tolerance.kind !== 'relative' || !(meta.tolerance.value > 0) || !(meta.tolerance.floor >= 0)) {
    throw new Error(`${label}: tolerance 无效`)
  }
  if (meta.source.project !== 'HyperSoundEngine' || meta.source.version !== '1.5.1' || meta.source.commit !== 'f7017621b7d84005fbfed8a3c42a119487a17326') {
    throw new Error(`${label}: 向量来源不是固定 HSE v1.5.1`)
  }
  if (bytes.byteLength !== meta.frames * 4 * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`${label}: .f32 长度不符合四段 planar 布局`)
  }
}

function readSegments(bytes: Uint8Array, frames: number): [Float32Array, Float32Array, Float32Array, Float32Array] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const all = new Float32Array(bytes.byteLength / 4)
  for (let index = 0; index < all.length; index++) all[index] = view.getFloat32(index * 4, true)
  return [
    all.slice(0, frames),
    all.slice(frames, frames * 2),
    all.slice(frames * 2, frames * 3),
    all.slice(frames * 3, frames * 4),
  ]
}

type Process = (left: Float32Array, right: Float32Array) => void

function neutralize(params: HyperSoundEngineParams): void {
  params.eq.enabled = false
  params.deesser.enabled = false
  params.compressor.enabled = false
  params.nightMode.enabled = false
  params.reverb.enabled = false
  params.surround3d.enabled = false
  params.bassEnhancer.enabled = false
  params.loudnessCompensation.enabled = false
  params.loudnessNormalization.enabled = false
  params.limiter.enabled = false
  params.ieq.enabled = false
  params.dynamicEq.enabled = false
  params.pitch.enabled = false
  params.modulation.enabled = false
  params.modulation.routes = []
  for (const effect of Object.values(params.modEffects)) effect.enabled = false
  params.stereoWidth = 1
  if (params.spatial) params.spatial.mode = 'off'
}

function inlineEngineProcessor(meta: VectorMeta): Process {
  const params = createDefaultParams(meta.sampleRate)
  neutralize(params)
  if (meta.module === 'loudness-normalization') {
    params.loudnessNormalization = meta.params as unknown as HyperSoundEngineParams['loudnessNormalization']
  } else if (meta.module === 'night-mode') {
    params.compressor = {
      ...(meta.params.compressor as unknown as CompressorSettings),
      enabled: false,
    }
    params.nightMode = {
      enabled: meta.params.enabled as boolean,
      amount: meta.params.amount as number,
    }
  } else {
    params.surround3d = meta.params as unknown as HyperSoundEngineParams['surround3d']
  }
  const engine = new HyperSoundEngine(meta.sampleRate, 2)
  engine.setParams(params)
  engine.prepare(meta.blockSize)
  return (left, right) => {
    const outputLeft = new Float32Array(left.length)
    const outputRight = new Float32Array(right.length)
    engine.process([left, right], [outputLeft, outputRight])
    left.set(outputLeft)
    right.set(outputRight)
  }
}

/// 确定性 IR 配方（逐字复刻 HSE v1.5.1 `buildIrRecipe`：f64 求值、存入 f32
/// 一次量化；LCG 先推进再取值，结合序 `((u·2 − 1)·amp)·exp(−decay·i/(length−1))`）。
function buildIrRecipe(ir: Record<string, unknown>): Float32Array {
  const kind = ir.kind as string
  if (kind === 'delta') {
    const delay = Math.round(ir.delay as number)
    if (!(delay >= 0)) throw new Error('delta IR 配方 delay 非法')
    const irData = new Float32Array(delay + 1)
    irData[delay] = 1
    return irData
  }
  if (kind === 'expNoise') {
    const length = Math.round(ir.length as number)
    const decay = ir.decay as number
    const amp = ir.amp as number
    if (!(length >= 2) || !(decay > 0)) throw new Error('expNoise IR 配方 length/decay 非法')
    let s = ir.seed as number
    const irData = new Float32Array(length)
    for (let index = 0; index < length; index++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      const u = s / 4294967296
      irData[index] = ((u * 2 - 1) * amp) * Math.exp((-decay * index) / (length - 1))
    }
    return irData
  }
  throw new Error(`unsupported ir recipe kind ${kind}`)
}

function processor(meta: VectorMeta): Process {
  switch (meta.module) {
    case 'biquad': {
      const create = () => new Biquad(
        meta.params.type as BiquadType,
        meta.params.f0 as number,
        meta.params.q as number,
        meta.params.gainDb as number,
        meta.sampleRate,
      )
      const leftProcessor = create()
      const rightProcessor = create()
      return (left, right) => {
        leftProcessor.processBlock(left, left)
        rightProcessor.processBlock(right, right)
      }
    }
    case 'chorus': {
      const processor = new ChorusEffect(meta.sampleRate)
      processor.setParams(meta.params as unknown as ChorusSettings)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'delay': {
      const processor = new DelayEffect(meta.sampleRate)
      processor.setParams(meta.params as unknown as DelaySettings)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'flanger': {
      const processor = new FlangerEffect(meta.sampleRate)
      processor.setParams(meta.params as unknown as FlangerSettings)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'loudness-normalization':
    case 'night-mode':
    case 'surround3d':
      return inlineEngineProcessor(meta)
    case 'phaser': {
      const processor = new PhaserEffect(meta.sampleRate)
      processor.setParams(meta.params as unknown as PhaserSettings)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'tremolo': {
      const processor = new TremoloEffect(meta.sampleRate)
      processor.setParams(meta.params as unknown as TremoloSettings)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'mid-side': {
      const processor = new MidSide()
      processor.setParams(meta.params.width as number, meta.params.voiceBalance as number)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'compressor': {
      const processor = new Compressor(meta.sampleRate)
      const settings = meta.params as unknown as CompressorSettings
      processor.setParams(settings)
      if (settings.sidechainEnabled) {
        return (left, right) => {
          const side = new Float32Array(left.length)
          for (let index = 0; index < side.length; index++) side[index] = left[index] + right[index]
          processor.processStereo(left, right, side, side)
        }
      }
      return (left, right) => processor.processStereo(left, right)
    }
    case 'deesser': {
      const processor = new Deesser(meta.sampleRate)
      const settings = meta.params as unknown as DeesserSettings
      processor.setParams(settings)
      if (settings.sidechainEnabled) {
        return (left, right) => {
          const side = new Float32Array(left.length)
          for (let index = 0; index < side.length; index++) side[index] = left[index] + right[index]
          processor.processStereo(left, right, side, side)
        }
      }
      return (left, right) => processor.processStereo(left, right)
    }
    case 'bass-enhancer': {
      const processor = new BassEnhancer(meta.sampleRate)
      processor.setParams(meta.params as unknown as BassEnhancerSettings)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'eq-chain': {
      const params = meta.params as unknown as {
        bandCount: number
        qCompensation: boolean
        bands: EqBand[]
      }
      const processor = new EqChain(meta.sampleRate, params.bandCount)
      processor.setBands(params.bands)
      processor.setQCompensation(params.qCompensation)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'reverb-simple': {
      const processor = new ReverbSimple(meta.sampleRate)
      processor.setParams(meta.params as unknown as Parameters<ReverbSimple['setParams']>[0])
      return (left, right) => processor.processStereo(left, right)
    }
    case 'fdn-reverb': {
      const processor = new FdnReverb(meta.sampleRate)
      processor.setParams(meta.params as unknown as Parameters<FdnReverb['setParams']>[0])
      return (left, right) => processor.processStereo(left, right)
    }
    case 'convolver': {
      const processor = new Convolver(meta.sampleRate, {
        partitionSize: meta.params.partitionSize as number,
        longPartitionSize: meta.params.longPartitionSize as number,
        shortRegionMs: meta.params.shortRegionMs as number,
        dePeriodize: meta.params.dePeriodize as boolean,
      })
      processor.loadIR(buildIrRecipe(meta.params.ir as Record<string, unknown>))
      processor.setMix(meta.params.mix as number)
      processor.setPreDelayMs(meta.params.preDelayMs as number)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'loudness-comp': {
      const processor = new LoudnessComp(meta.sampleRate)
      processor.setParams(meta.params as unknown as Parameters<LoudnessComp['setParams']>[0])
      return (left, right) => processor.processStereo(left, right)
    }
    case 'dynamic-eq': {
      const processor = new DynamicEq(meta.sampleRate)
      processor.setParams(meta.params as unknown as Parameters<DynamicEq['setParams']>[0])
      return (left, right) => processor.processStereo(left, right)
    }
    case 'limiter': {
      const processor = new Limiter(meta.sampleRate)
      processor.setParams(meta.params as unknown as Parameters<Limiter['setParams']>[0])
      return (left, right) => processor.processStereo(left, right)
    }
    case 'modulation-matrix': {
      // 复刻 Rust `dsp_parity_modulation.rs` 核心驱动器（specs/dsp/
      // modulation-matrix.md §4.4）：推进矩阵 + masterGain 逐样本乘；
      // stereoWidth 产物不入向量（应用路径由适配器单独覆盖）。
      const params = meta.params as { routes?: ModulationRoute[]; lfo?: { shape: string; rateHz: number; depth: number }; envelope?: { attackMs: number; releaseMs: number; amount: number } }
      const matrix = new ModulationMatrix(
        meta.sampleRate,
        (params.routes ?? []).map((route) => ({ source: route.source, target: route.target, amount: route.amount, offset: route.offset })),
        {
          shape: (params.lfo?.shape ?? 'sine') as 'sine' | 'triangle' | 'square' | 'saw',
          rateHz: params.lfo?.rateHz ?? 1,
          depth: params.lfo?.depth ?? 0.5,
        },
        {
          attackMs: params.envelope?.attackMs ?? 10,
          releaseMs: params.envelope?.releaseMs ?? 200,
          amount: params.envelope?.amount ?? 0.5,
        },
      )
      return (left, right) => {
        const n = Math.min(left.length, right.length)
        const targets = matrix.processBlock(left, right, n)
        const g = targets.masterGain
        if (g !== 1) {
          for (let i = 0; i < n; i++) { left[i] = (left[i] * g); right[i] = (right[i] * g) }
        }
      }
    }
    default:
      throw new Error(`未知 DSP 模块 ${meta.module}`)
  }
}

function assertClose(
  label: string,
  channel: string,
  actual: Float32Array,
  expected: Float32Array,
  tolerance: VectorMeta['tolerance'],
): void {
  for (let index = 0; index < expected.length; index++) {
    const difference = Math.abs(actual[index] - expected[index])
    const bound = tolerance.value * Math.max(Math.abs(expected[index]), tolerance.floor)
    if (!Number.isFinite(actual[index]) || !(difference <= bound)) {
      throw new Error(
        `${label} ${channel}[${index}]: got ${actual[index]}, want ${expected[index]}, ` +
        `diff ${difference}, bound ${bound}`,
      )
    }
  }
}

describe('Phaser HSE 边界语义', () => {
  const enabled: PhaserSettings = {
    enabled: true,
    rateHz: 1.5,
    depth: 0.8,
    feedback: 0.5,
    mix: 0.5,
    stages: 6,
  }

  it('按 frameCount 与较短声道截断且不改写余量', () => {
    const unequal = new PhaserEffect(48_000)
    unequal.setParams(enabled)
    const left = new Float32Array([0.25, 0.5, 0.75])
    const right = new Float32Array([-0.25, -0.5])
    unequal.processStereo(left, right)
    expect(left[2]).toBe(0.75)

    const bounded = new PhaserEffect(48_000)
    bounded.setParams(enabled)
    const boundedLeft = new Float32Array([0.25, 0.5, 0.75])
    const boundedRight = new Float32Array([-0.25, -0.5, -0.75])
    bounded.processStereo(boundedLeft, boundedRight, 1)
    expect(Array.from(boundedLeft.slice(1))).toEqual([0.5, 0.75])
    expect(Array.from(boundedRight.slice(1))).toEqual([-0.5, -0.75])
  })
})

const vectors = discoverCases()

describe('HSE 已迁入算法共享冻结向量', () => {
  it('包含第一组与第二组的精确向量清单', () => {
    expect(vectors.map(({ label }) => label)).toEqual([
      'bass-enhancer.case1',
      'bass-enhancer.case2',
      'bass-enhancer.case3',
      'bass-enhancer.case4',
      'biquad.case1',
      'biquad.case2',
      'biquad.case3',
      'biquad.case4',
      'chorus.case1',
      'chorus.case2',
      'chorus.case3',
      'chorus.case4',
      'compressor.case1',
      'compressor.case2',
      'compressor.case3',
      'compressor.case4',
      'convolver.case1',
      'convolver.case2',
      'convolver.case3',
      'convolver.case4',
      'deesser.case1',
      'deesser.case2',
      'deesser.case3',
      'deesser.case4',
      'delay.case1',
      'delay.case2',
      'delay.case3',
      'delay.case4',
      'dynamic-eq.case1',
      'dynamic-eq.case2',
      'dynamic-eq.case3',
      'dynamic-eq.case4',
      'eq-chain.case1',
      'eq-chain.case2',
      'eq-chain.case3',
      'eq-chain.case4',
      'fdn-reverb.case1',
      'fdn-reverb.case2',
      'fdn-reverb.case3',
      'fdn-reverb.case4',
      'flanger.case1',
      'flanger.case2',
      'flanger.case3',
      'flanger.case4',
      'limiter.case1',
      'limiter.case2',
      'limiter.case3',
      'limiter.case4',
      'loudness-comp.case1',
      'loudness-comp.case2',
      'loudness-comp.case3',
      'loudness-comp.case4',
      'loudness-normalization.realtime-400ms',
      'mid-side.case1',
      'mid-side.case2',
      'mid-side.case3',
      'mid-side.case4',
      'modulation-matrix.case1',
      'modulation-matrix.case2',
      'modulation-matrix.case3',
      'modulation-matrix.case4',
      'night-mode.case1',
      'night-mode.case2',
      'night-mode.case3',
      'night-mode.case4',
      'phaser.case1',
      'phaser.case2',
      'phaser.case3',
      'phaser.case4',
      'reverb-simple.case1',
      'reverb-simple.case2',
      'reverb-simple.case3',
      'surround3d.case1',
      'surround3d.case2',
      'surround3d.case3',
      'surround3d.case4',
      'tremolo.case1',
      'tremolo.case2',
      'tremolo.case3',
      'tremolo.case4',
    ])
  })

  for (const vector of vectors) {
    it(`${vector.label} 与 HSE v1.5.1 一致`, () => {
      validate(vector)
      const [inputLeft, inputRight, expectedLeft, expectedRight] = readSegments(
        vector.bytes,
        vector.meta.frames,
      )
      const actualLeft = inputLeft.slice()
      const actualRight = inputRight.slice()
      const process = processor(vector.meta)
      for (let offset = 0; offset < vector.meta.frames; offset += vector.meta.blockSize) {
        const end = Math.min(offset + vector.meta.blockSize, vector.meta.frames)
        process(actualLeft.subarray(offset, end), actualRight.subarray(offset, end))
      }
      assertClose(vector.label, 'L', actualLeft, expectedLeft, vector.meta.tolerance)
      assertClose(vector.label, 'R', actualRight, expectedRight, vector.meta.tolerance)
    })
  }
})
