/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BassEnhancer, type BassEnhancerSettings } from './bass-enhancer'
import { Biquad, type BiquadType } from './biquad'
import { Compressor, type CompressorSettings } from './compressor'
import { ChorusEffect, type ChorusSettings } from './chorus'
import { Deesser, type DeesserSettings } from './deesser'
import { DelayEffect, type DelaySettings } from './delay'
import { EqChain, type EqBandParam } from './eq-chain'
import { FlangerEffect, type FlangerSettings } from './flanger'
import { LoudnessNormalization, type LoudnessNormalizationSettings } from './loudness-normalization'
import { LufsMeter } from './lufs-meter'
import { MidSide } from './mid-side'
import { NightMode, type NightModeSettings } from './night-mode'
import { PhaserEffect, type PhaserSettings } from './phaser'
import { Surround3d, type Surround3dSettings } from './surround3d'
import { TremoloEffect, type TremoloSettings } from './tremolo'

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
  source?: { project: string; version: string; commit: string }
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
  if (!['biquad', 'mid-side', 'compressor', 'chorus', 'deesser', 'delay', 'flanger', 'phaser', 'bass-enhancer', 'eq-chain', 'loudness-normalization', 'night-mode', 'surround3d', 'tremolo'].includes(meta.module)) {
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
  if (['night-mode', 'delay', 'chorus', 'flanger', 'phaser', 'tremolo'].includes(meta.module)) {
    if (meta.source?.project !== 'HyperSoundEngine' || meta.source.version !== '1.5.1' || meta.source.commit !== 'f7017621b7d84005fbfed8a3c42a119487a17326') {
      throw new Error(`${label}: 向量来源不是固定 HSE v1.5.1`)
    }
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
    case 'loudness-normalization': {
      const meter = new LufsMeter(meta.sampleRate)
      const normalization = new LoudnessNormalization(meta.sampleRate, meter)
      normalization.setParams(meta.params as unknown as LoudnessNormalizationSettings)
      return (left, right) => {
        normalization.processStereo(left, right)
        meter.processStereo(left, right)
      }
    }
    case 'night-mode': {
      const base = meta.params.compressor as unknown as CompressorSettings
      const processor = new NightMode(meta.sampleRate, base)
      processor.setParams(meta.params as unknown as NightModeSettings, base)
      return (left, right) => processor.processStereo(left, right)
    }
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
    case 'surround3d': {
      const processor = new Surround3d(meta.sampleRate)
      processor.setParams(meta.params as unknown as Surround3dSettings)
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
        bands: EqBandParam[]
      }
      const processor = new EqChain(meta.sampleRate, params.bandCount)
      processor.setBands(params.bands)
      processor.setQCompensation(params.qCompensation)
      return (left, right) => processor.processStereo(left, right)
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
      'deesser.case1',
      'deesser.case2',
      'deesser.case3',
      'deesser.case4',
      'delay.case1',
      'delay.case2',
      'delay.case3',
      'delay.case4',
      'eq-chain.case1',
      'eq-chain.case2',
      'eq-chain.case3',
      'eq-chain.case4',
      'flanger.case1',
      'flanger.case2',
      'flanger.case3',
      'flanger.case4',
      'loudness-normalization.realtime-400ms',
      'mid-side.case1',
      'mid-side.case2',
      'mid-side.case3',
      'mid-side.case4',
      'night-mode.case1',
      'night-mode.case2',
      'night-mode.case3',
      'night-mode.case4',
      'phaser.case1',
      'phaser.case2',
      'phaser.case3',
      'phaser.case4',
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
