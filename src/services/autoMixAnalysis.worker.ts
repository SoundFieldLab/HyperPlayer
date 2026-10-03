/**
 * AutoMix 分析 Worker（性能优化计划 1.0 §6.1b）。
 *
 * 跑的是与主线程完全相同的纯 DSP 内核（autoMixAnalysisDsp.analyzePcmData）：
 * 主线程只保留 fetch + decodeAudioData（原生异步、不占 JS 线程），PCM 以
 * transferable Float32Array 移交到这里做全曲 DSP（包络/自相关 BPM/节拍网格/
 * 逐拍特征/分段），回传纯数据 TrackAnalysis。同一输入必得同一输出——等价性
 * 由 test/autoMixWorkerEquivalence.test.ts 钉住。
 */
import { analyzePcmData } from './autoMixAnalysisDsp'
import type { TrackAnalysisInput } from './autoMixAnalysisService'

interface AnalyzeRequest {
  id: number
  channel: Float32Array
  sampleRate: number
  duration: number
  input: Pick<TrackAnalysisInput, 'trackKey' | 'duration' | 'bpmHint' | 'beatTimesHint' | 'beatWeightsHint' | 'rmsEnvelopeHint' | 'sourceSignature'>
  format?: { sampleRate: number; channels: number }
}

// 不引用 webworker lib（避免与 DOM lib 全局声明冲突），用最小结构化视图拿 self
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

ctx.onmessage = (event) => {
  const { id, channel, sampleRate, duration, input, format } = event.data
  try {
    const analysis = analyzePcmData(input, channel, sampleRate, duration, format)
    ctx.postMessage({ id, analysis })
  } catch (error) {
    ctx.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
