/**
 * AutoMix DSP 等价性测试（性能优化计划 1.0 §6.1b 验收）。
 *
 * analyzeBuffer（主线程入口，AudioBuffer 签名）与 analyzePcmData（Worker 内核，
 * PCM 签名）必须对同一音频产出完全一致的分析结果——Worker 化后两者跑的是同一份
 * 纯函数，但此测试把「包装层不引入数值差异」钉死，防止后续改动漂移。
 * 合成信号：固定节拍的正弦脉冲列 + 噪声，覆盖「无提示（tempo 路径）」与
 * 「beatTimesHint/bpmHint/rmsEnvelopeHint（拍点模式路径）」两条主分支。
 */
import { describe, expect, it } from 'vitest'
import { analyzePcmData } from '../src/services/autoMixAnalysisDsp'
import { analyzeBuffer } from '../src/services/autoMixAnalysisService'
import type { TrackAnalysisInput } from '../src/services/autoMixAnalysisService'

const SAMPLE_RATE = 22050
const DURATION_SECONDS = 30
const BPM = 120

/** 固定节拍的正弦脉冲 + 低幅噪声： onset 清晰、tempo 可检出 */
function makeChannel(): Float32Array {
  const length = SAMPLE_RATE * DURATION_SECONDS
  const channel = new Float32Array(length)
  const beatInterval = 60 / BPM
  const pulseSeconds = 0.08
  let seed = 42
  const noise = () => {
    // 线性同余伪随机：保证测试可复现
    seed = (seed * 1103515245 + 12345) % 2147483648
    return (seed / 2147483648) * 2 - 1
  }
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE
    const beatPhase = t % beatInterval
    const inPulse = beatPhase < pulseSeconds
    channel[i] = inPulse
      ? Math.sin(2 * Math.PI * 220 * t) * 0.5
      : noise() * 0.01
  }
  return channel
}

/** 鸭子类型 AudioBuffer：analyzeBuffer 只消费 getChannelData/sampleRate/duration */
function makeBuffer(channel: Float32Array) {
  return {
    getChannelData: () => channel,
    sampleRate: SAMPLE_RATE,
    duration: DURATION_SECONDS,
  } as unknown as AudioBuffer
}

function stripTimestamps(analysis: unknown): unknown {
  const clone = { ...(analysis as Record<string, unknown>) }
  delete clone.createdAt
  delete clone.lastAccessAt
  return clone
}

describe('AutoMix DSP 主线程/Worker 等价性', () => {
  const channel = makeChannel()
  const buffer = makeBuffer(channel)

  it('无提示路径（detectTempo + buildBeatGrid）两者完全一致', () => {
    const input: TrackAnalysisInput = { trackKey: 'eq-no-hint', url: 'unused://' }
    const viaBuffer = analyzeBuffer(input, buffer, { sampleRate: SAMPLE_RATE, channels: 1 })
    const viaPcm = analyzePcmData(input, channel, SAMPLE_RATE, DURATION_SECONDS, { sampleRate: SAMPLE_RATE, channels: 1 })
    expect(stripTimestamps(viaBuffer)).toEqual(stripTimestamps(viaPcm))
    // 合成信号 120 BPM 恒定节拍，检出结果必须落在可信区间
    expect(Math.abs(viaPcm.estimatedBpm - BPM)).toBeLessThanOrEqual(2)
    expect(viaPcm.beats.length).toBeGreaterThan(32)
  })

  it('beatTimesHint/bpmHint/rmsEnvelopeHint 路径（findBeatPatternGrid）两者完全一致', () => {
    const beatInterval = 60 / BPM
    const beatTimesHint = Array.from({ length: 48 }, (_, i) => 1 + i * beatInterval)
    const beatWeightsHint = beatTimesHint.map((_, i) => (i % 4 === 0 ? 1 : 0.6))
    const input: TrackAnalysisInput = {
      trackKey: 'eq-with-hint',
      url: 'unused://',
      bpmHint: BPM,
      beatTimesHint,
      beatWeightsHint,
      rmsEnvelopeHint: undefined,
      sourceSignature: 'test-signature',
    }
    const viaBuffer = analyzeBuffer(input, buffer)
    const viaPcm = analyzePcmData(input, channel, SAMPLE_RATE, DURATION_SECONDS)
    expect(stripTimestamps(viaBuffer)).toEqual(stripTimestamps(viaPcm))
    expect(viaPcm.provider).toBe('browser-fallback')
    expect(viaPcm.confidence).toBeGreaterThan(0)
  })
})
