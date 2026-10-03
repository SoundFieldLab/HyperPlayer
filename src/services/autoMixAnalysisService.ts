/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 HyperPlayer，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { debugLog } from '../utils/debugLog'
import { refreshSongUrlOnce } from './musicApi'
import { ANALYSIS_VERSION, analyzePcmData } from './autoMixAnalysisDsp'
import type { TrackAnalysis } from '../audio/types'

// 纯 DSP 与音频环境解耦（§6.1b 抽出 autoMixAnalysisDsp）：这里保持既有公开 API 的
// 再导出（mvAlignment 等下游 import 不变），本体在 autoMixAnalysisDsp.ts。
export { computeFrameEnvelope, detectMusicStart, detectLiveMusicEntry, envelopeOffsetOf } from './autoMixAnalysisDsp'

export interface TrackAnalysisInput {
  trackKey: string
  url: string
  duration?: number
  /**
   * 期望 BPM（可选）。MV 对齐等场景：MV 音频与歌曲同源时，用歌曲 BPM 重建 MV
   * 节拍网格，避免浏览器回退 DSP 锁到 2x/3x 慢拍子谐波，导致两套节拍对不上。
   * 提示错误时网格贴合度（confidence）会很低，下游自然拒绝，不会误伤。
   */
  bpmHint?: number
  /**
   * 期望拍点模式（可选，秒）：歌曲的真实节拍时间序列。MV 与歌曲同源 → MV 的拍点
   * 就是「歌曲拍点 + 整体偏移」。规则网格在歌曲变速/漂移（librosa BPM 只是平均
   * 节奏，实测一首歌累积漂移可达 4s+）时与真实拍点失配，紧容差匹配必失败；
   * 用真实拍点模式在 MV onset 上滑动相关求偏移，对变速鲁棒。
   */
  beatTimesHint?: number[]
  /**
   * 与 beatTimesHint 逐拍对应的能量权重（歌曲分析 beatFeatures[].energy）。
   * 整条拍点模式平移整数个拍周期仍能对上相邻拍 onset（稳定节拍下各峰几乎等高），
   * 造成偏移歧义（实测可错 2 句歌词）。加权相关让强拍/段落强弱差异打破混叠。
   */
  beatWeightsHint?: number[]
  /**
   * 歌曲音频的逐帧 RMS 包络（可选）：MV 与歌曲同源 → 两者的包络一致（相差偏移）。
   * 提供时用包络互相关求精确偏移——对安静前奏/节拍混叠最鲁棒（onset 相关在安静
   * 前奏区噪声大，实测 rainy tone 偏移晚 ~10s）。
   */
  rmsEnvelopeHint?: number[]
  sourceSignature?: string
  signal?: AbortSignal
}

/** 低于该置信度的 browser-fallback 结果视为节拍网格不可信，不缓存/不复用 */
const BROWSER_FALLBACK_MIN_PERSIST_CONFIDENCE = 0.4
const memoryCache = new Map<string, TrackAnalysis>()
const inFlightAnalyses = new Map<string, Promise<TrackAnalysis>>()
const MAX_MEMORY_CACHE_ENTRIES = 32

function cacheKey(input: TrackAnalysisInput): string {
  // rmsEnvelopeHint 是否携带也入键：预热分析（无歌曲包络 → 音乐起始锚点）与 commit
  // 分析（有歌曲包络 → 包络互相关锚点）算出的网格不同，混用会让预热结果污染精确结果
  // （实测ニコカラ 14.34s 被预热结果覆盖成 12.91s）。
  const hasEnvelopeHint = Array.isArray(input.rmsEnvelopeHint) && input.rmsEnvelopeHint.length > 0 ? 'rms1' : 'rms0'
  return `${input.trackKey}:${Math.round(input.duration || 0)}:${input.sourceSignature || ''}:${input.bpmHint || ''}:${hasEnvelopeHint}:${ANALYSIS_VERSION}`
}

function cacheInMemory(key: string, analysis: TrackAnalysis): void {
  memoryCache.delete(key)
  memoryCache.set(key, analysis)
  while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value
    if (oldestKey === undefined) break
    memoryCache.delete(oldestKey)
  }
}

function isSupportedAnalysis(analysis: TrackAnalysis): boolean {
  // 仅认本地浏览器回退分析产物（独立 Python 分析服务已移除）。
  return analysis.analysisVersion === ANALYSIS_VERSION
}

/**
 * 弱 browser-fallback 结果（置信度过低的节拍网格，如 B 站 MV 音频被 DSP 锁到
 * 慢拍子谐波时的 55 BPM 假网格）。这类结果不可信，不能进入缓存：一旦持久化会被
 * 复用 30 天，把歌曲钉死在空/坏网格上；也不应从缓存里取出来复用。
 * 例外：带拍点模式签名（pattern:）的结果网格锚定歌曲真实节拍，其质量由对齐判定
 * （detectOffsetFromBeats + 网格贴合度把关）把关，不受 0.4 阈值误伤（否则每次会话重算）。
 */
function isWeakBrowserFallback(analysis: TrackAnalysis | null | undefined): boolean {
  if (!analysis || analysis.provider !== 'browser-fallback') return false
  if (typeof analysis.sourceSignature === 'string' && analysis.sourceSignature.startsWith('pattern:')) return false
  return (analysis.confidence ?? 0) < BROWSER_FALLBACK_MIN_PERSIST_CONFIDENCE
}

/** 分析结果是否带可用节拍网格（空网格 = 解码失败/元数据兜底，不能用于智能混音规划） */
function hasUsableBeats(analysis: TrackAnalysis | null | undefined): boolean {
  return Boolean(analysis && Array.isArray(analysis.beats) && analysis.beats.length >= 8 && Array.isArray(analysis.downbeats) && analysis.downbeats.length >= 2)
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('Analysis was cancelled', 'AbortError')
}

function waitForAnalysis<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

// ── Worker 分析通道（性能优化计划 1.0 §6.1b）──
// 全曲 DSP（包络/自相关 BPM/节拍网格/逐拍特征）整体搬进 Web Worker：decodeAudioData
// 是原生异步、本就不占 JS 线程，留在主线程；PCM 以 transferable Float32Array 移交，
// Worker 跑同一份 autoMixAnalysisDsp 纯函数（同一输入必得同一输出），回传纯数据。
// Worker 创建失败（CSP/受限环境）或运行出错时自动回退主线程 analyzeBuffer，结果等价。
let analysisWorker: Worker | null = null
let analysisWorkerBroken = false
let analysisWorkerSeq = 0
const analysisWorkerPending = new Map<number, { resolve: (analysis: TrackAnalysis) => void; reject: (error: Error) => void }>()

/** 单次分析的兜底超时：Worker 极端卡死时不无限等待，回退主线程重算 */
const ANALYSIS_WORKER_TIMEOUT_MS = 60_000

function getAnalysisWorker(): Worker | null {
  if (analysisWorkerBroken || typeof Worker === 'undefined') return null
  if (analysisWorker) return analysisWorker
  try {
    const worker = new Worker(new URL('./autoMixAnalysis.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; analysis?: TrackAnalysis; error?: string }>) => {
      const pending = analysisWorkerPending.get(event.data.id)
      if (!pending) return
      analysisWorkerPending.delete(event.data.id)
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve(event.data.analysis as TrackAnalysis)
    }
    worker.onerror = (event) => {
      // 模块加载失败等致命错误：拒绝所有在途请求并永久回退主线程（本次会话内不再重试）
      const error = new Error(event.message || 'analysis worker error')
      for (const pending of analysisWorkerPending.values()) pending.reject(error)
      analysisWorkerPending.clear()
      analysisWorkerBroken = true
      analysisWorker = null
      try { worker.terminate() } catch { /* 忽略 */ }
    }
    analysisWorker = worker
    return worker
  } catch {
    analysisWorkerBroken = true
    return null
  }
}

function analyzeViaWorker(input: TrackAnalysisInput, buffer: AudioBuffer, format?: { sampleRate: number; channels: number }): Promise<TrackAnalysis> {
  const worker = getAnalysisWorker()
  if (!worker) return Promise.reject(new Error('analysis worker unavailable'))
  const id = ++analysisWorkerSeq
  // 复制后 transfer（不 transfer 原数组：Worker 路径失败时主线程兜底还要用它）
  const channel = buffer.getChannelData(0).slice()
  // 只发 DSP 需要的字段（signal 不可结构化克隆，url 不参与计算）
  const payload = {
    id,
    channel,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    input: {
      trackKey: input.trackKey,
      duration: input.duration,
      bpmHint: input.bpmHint,
      beatTimesHint: input.beatTimesHint,
      beatWeightsHint: input.beatWeightsHint,
      rmsEnvelopeHint: input.rmsEnvelopeHint,
      sourceSignature: input.sourceSignature,
    },
    format,
  }
  return new Promise<TrackAnalysis>((resolve, reject) => {
    const timer = setTimeout(() => {
      analysisWorkerPending.delete(id)
      reject(new Error('analysis worker timeout'))
    }, ANALYSIS_WORKER_TIMEOUT_MS)
    analysisWorkerPending.set(id, {
      resolve: (analysis) => { clearTimeout(timer); resolve(analysis) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    try {
      worker.postMessage(payload, [channel.buffer])
    } catch (error) {
      clearTimeout(timer)
      analysisWorkerPending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * 主线程分析（Worker 不可用/超时/出错时的兜底；导出供等价性测试）。
 * DSP 本体在 autoMixAnalysisDsp.analyzePcmData —— Worker 与主线程跑同一份纯函数，
 * 同一输入必得同一输出（等价性由 test/autoMixWorkerEquivalence.test.ts 钉住）。
 */
export function analyzeBuffer(input: TrackAnalysisInput, buffer: AudioBuffer, format?: { sampleRate: number; channels: number }): TrackAnalysis {
  return analyzePcmData(input, buffer.getChannelData(0), buffer.sampleRate, buffer.duration, format)
}

function metadataOnly(input: TrackAnalysisInput, reason: TrackAnalysis['provider'] = 'metadata-only'): TrackAnalysis {
  const now = Date.now()
  const duration = Math.max(0, input.duration || 0)
  return {
    schemaVersion: 1,
    trackKey: input.trackKey,
    duration,
    provider: reason,
    beats: [],
    downbeats: [],
    beatConfidence: [],
    downbeatConfidence: [],
    estimatedBpm: 120,
    meter: 4,
    confidence: 0,
    sections: [],
    beatFeatures: [],
    introSilence: 0,
    outroSilence: 0,
    sourceSignature: input.sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
    createdAt: now,
    lastAccessAt: now,
  }
}

// 保守降采样：单声道 + 22050Hz，供浏览器本地节拍检测使用。
// 直接整曲解码（数分钟 48kHz 立体声 ≈ 数十 MB Float32）在播放/切歌热路径
// 会形成内存峰值；降采样后的单声道 buffer 大幅缩减峰值，且分析的频带最高到
// 5200Hz（22050Hz 奈奎斯特 11025Hz 完整覆盖），BPM/能量/静音等结果语义不变。
// 已经是单声道且采样率不超过目标值时直接复用原 buffer，避免多余拷贝。
function toMonoDownsampled(buffer: AudioBuffer, context: AudioContext, targetRate = 22050): AudioBuffer {
  const channels = buffer.numberOfChannels
  const sourceRate = buffer.sampleRate
  if (channels === 1 && sourceRate <= targetRate) return buffer

  const outLength = Math.max(1, Math.floor(buffer.duration * targetRate))
  const output = context.createBuffer(1, outLength, targetRate)
  const outData = output.getChannelData(0)
  const ratio = sourceRate / targetRate
  // 盒式滤波降采样：对每个输出样本取对应输入区间内各声道样本的平均，
  // 既完成单声道混合，又抑制高频混叠并平滑包络。
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(buffer.length, Math.ceil((i + 1) * ratio))
    let sum = 0
    for (let ch = 0; ch < channels; ch += 1) {
      const data = buffer.getChannelData(ch)
      for (let j = start; j < end; j += 1) sum += data[j]
    }
    outData[i] = sum / Math.max(1, (end - start) * channels)
  }
  return output
}

/** 解码产物：buffer 为降采样单声道分析载体；format 保留解码前容器真实格式 */
export interface DecodedAudio {
  buffer: AudioBuffer
  format: { sampleRate: number; channels: number }
}

export async function decodeAudioUrl(url: string, signal?: AbortSignal): Promise<DecodedAudio> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`)
  const data = await response.arrayBuffer()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable')
  const context = new AudioContextCtor()
  try {
    const decoded = await context.decodeAudioData(data)
    // 记录解码前容器的真实格式（声道数/采样率）——过渡格式预检消费；
    // 随后立即降采样为单声道，避免整曲立体声 PCM 留在内存里
    const format = { sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels }
    return { buffer: toMonoDownsampled(decoded, context), format }
  } finally {
    void context.close()
  }
}

class AutoMixAnalysisService {
  /** 同步快查首尾静音边界（仅内存层，不触发磁盘/网络）：
   *  无缝衔接的确定性裁剪触发用——分析由 AutoMix 正常产生后无缝免费复用，
   *  无缓存时返回 null，消费方维持原有运行时探测行为。 */
  peekSilenceBounds(trackKey: string): { introSilence: number; outroSilence: number } | null {
    const normalized = trackKey.trim()
    if (!normalized) return null
    for (const analysis of memoryCache.values()) {
      if (analysis.trackKey !== normalized || !isSupportedAnalysis(analysis)) continue
      // metadata-only 等降级产物没有真实静音数据（恒为 0），不作为有效边界
      if (analysis.provider === 'metadata-only' || analysis.provider === 'tv-metadata-only' || analysis.provider === 'electron-unavailable') continue
      if (!Number.isFinite(analysis.introSilence) || !Number.isFinite(analysis.outroSilence)) continue
      return { introSilence: analysis.introSilence, outroSilence: analysis.outroSilence }
    }
    return null
  }

  async getCached(trackKey: string): Promise<TrackAnalysis | null> {
    const normalizedTrackKey = trackKey.trim()
    if (!normalizedTrackKey) return null
    // 只认"带可用节拍网格"的缓存：空节拍（metadata-only 等解码失败降级）一旦命中会
    // 把 m4a/aac 的浏览器解码回退（唯一能解的路）永远挡掉——MV 背景对不上的根因之一。
    for (const [key, analysis] of memoryCache.entries()) {
      if (analysis.trackKey === normalizedTrackKey && isSupportedAnalysis(analysis) && hasUsableBeats(analysis) && !isWeakBrowserFallback(analysis)) {
        cacheInMemory(key, analysis)
        return { ...analysis, lastAccessAt: Date.now() }
      }
    }
    // Electron 分析 runtime 已移除：只认内存缓存，无磁盘持久化可读。
    return null
  }

  /**
   * 浏览器端整曲分析（Chromium decodeAudioData 原生支持 m4a/aac）。这是移除独立
   * Python 分析服务后的唯一分析路径。优先解码已下载的本地文件（hyperplayer-media://），
   * 失败再回退直接抓取原始 URL；结果会正常缓存，同一首歌只解码一次。
   * 解码后的 DSP 优先在 Worker 里跑（§6.1b），主线程只剩 fetch + decodeAudioData。
   */
  private async analyzeInBrowser(input: TrackAnalysisInput): Promise<TrackAnalysis> {
    let audioPath: string | null = null
    try {
      audioPath = await window.electron?.audioDownload?.prepare?.(input.url, input.trackKey) || null
      const mediaUrl = audioPath ? await window.electron?.audioDownload?.getMediaUrl?.(audioPath) : undefined
      if (mediaUrl) {
        debugLog('🎧 [AutoMix] 浏览器解码本地文件（可支持 m4a/aac）:', audioPath)
        const decoded = await decodeAudioUrl(mediaUrl, input.signal)
        return await this.analyzeDecoded(input, decoded.buffer, decoded.format)
      }
    } catch (error) {
      if (isHttp403(error)) {
        const identity = parseRefreshIdentity(input.trackKey)
        if (identity) {
          const refreshedUrl = await refreshSongUrlOnce(identity.id, identity.platform, input.url).catch(() => null)
          if (refreshedUrl && refreshedUrl !== input.url) {
            const localPath = await window.electron?.audioDownload?.prepare?.(refreshedUrl, input.trackKey)
            const mediaUrl = localPath ? await window.electron?.audioDownload?.getMediaUrl?.(localPath) : undefined
            if (mediaUrl) {
              const decoded = await decodeAudioUrl(mediaUrl, input.signal)
              return await this.analyzeDecoded(input, decoded.buffer, decoded.format)
            }
          }
        }
      }
      debugLog('⚠️ [AutoMix] 本地文件解码失败，尝试直接抓取 URL:', error)
    }
    debugLog('🎧 [AutoMix] 直接抓取原始 URL 解码')
    const decoded = await decodeAudioUrl(input.url, input.signal)
    return await this.analyzeDecoded(input, decoded.buffer, decoded.format)
  }

  /** 解码后的分析：优先 Worker（不占主线程），失败/超时回退主线程同一 DSP（结果等价） */
  private async analyzeDecoded(input: TrackAnalysisInput, buffer: AudioBuffer, format?: { sampleRate: number; channels: number }): Promise<TrackAnalysis> {
    try {
      return await analyzeViaWorker(input, buffer, format)
    } catch (error) {
      debugLog('🎧 [AutoMix] Worker 分析不可用，回退主线程:', error)
      return analyzeBuffer(input, buffer, format)
    }
  }

  private async analyzeAndCache(input: TrackAnalysisInput, key: string): Promise<TrackAnalysis> {
    const persisted = await this.getCached(input.trackKey)
    const signatureMatches = !input.sourceSignature || persisted?.sourceSignature === input.sourceSignature
    if (persisted && isSupportedAnalysis(persisted) && !isWeakBrowserFallback(persisted) && Math.abs(persisted.duration - (input.duration || persisted.duration)) < 2) {
      cacheInMemory(key, persisted)
      return persisted
    }

    let analysis: TrackAnalysis
    // 独立 Python 分析服务与 Electron 分析 runtime 已移除：分析只走本地浏览器
    // 整曲解码（Chromium decodeAudioData，原生支持 m4a/aac）。分析失败属瞬时性，
    // 不缓存/不持久化，避免把歌曲永久钉在空节拍网格上。
    let isTransientFallback = false
    try {
      debugLog('⚠️ [AutoMix] 使用浏览器本地节拍检测')
      analysis = await this.analyzeInBrowser(input)
    } catch (error) {
      if (input.signal?.aborted) throw error
      console.warn('⚠️ [AutoMix] 本地分析失败，使用保守回退方案', error)
      isTransientFallback = true
      analysis = metadataOnly(input, 'metadata-only')
    }

    // Only cache genuine analyses. A transient metadata-only fallback is still
    // returned so the current transition keeps working via the fallback, but it
    // is not stored under the normal key: caching it would pin the track to an
    // empty beat grid (fixed-crossfade) until eviction and mask any later good
    // analysis. The same applies to weak browser-fallback grids
    // (低置信度节拍网格，如 MV 音频被锁到慢拍子谐波时的假网格)。
    if (!isTransientFallback && !isWeakBrowserFallback(analysis)) {
      cacheInMemory(key, analysis)
    }
    return analysis
  }

  async analyze(input: TrackAnalysisInput): Promise<TrackAnalysis> {
    if (input.signal?.aborted) throw abortReason(input.signal)

    const trackKey = input.trackKey.trim()
    const url = input.url.trim()
    if (!trackKey) throw new Error('Track analysis requires a non-empty track key')
    if (!url) throw new Error('Track analysis requires a non-empty audio URL or path')
    input = { ...input, trackKey, url }

    const key = cacheKey(input)
    const inMemory = memoryCache.get(key)
    if (inMemory && isSupportedAnalysis(inMemory) && hasUsableBeats(inMemory) && !isWeakBrowserFallback(inMemory)) {
      cacheInMemory(key, inMemory)
      return { ...inMemory, lastAccessAt: Date.now() }
    }
    if (inMemory) memoryCache.delete(key)

    let analysisPromise = inFlightAnalyses.get(key)
    if (!analysisPromise) {
      // The shared job is intentionally independent of any single caller. Each
      // caller can cancel its own wait without spawning or killing duplicate work.
      analysisPromise = this.analyzeAndCache({ ...input, signal: undefined }, key)
      inFlightAnalyses.set(key, analysisPromise)
      analysisPromise.then(
        () => { if (inFlightAnalyses.get(key) === analysisPromise) inFlightAnalyses.delete(key) },
        () => { if (inFlightAnalyses.get(key) === analysisPromise) inFlightAnalyses.delete(key) },
      )
    }

    return waitForAnalysis(analysisPromise, input.signal)
  }

  clearMemoryCache() {
    memoryCache.clear()
  }

  /**
   * 只读内存缓存中的节拍时间点（秒）：看歌视频漂移校正吸附到最近节拍用。
   * 不触发任何分析/网络请求——仅当 automix 已分析过这首歌（beat_this/librosa）才有数据。
   */
  getCachedBeats(trackKey: string, url: string, duration?: number): number[] | null {
    const analysis = memoryCache.get(cacheKey({ trackKey, url, duration }))
    if (analysis && isSupportedAnalysis(analysis) && Array.isArray(analysis.beats) && analysis.beats.length > 0) {
      return analysis.beats
    }
    return null
  }

  async clearCache() {
    this.clearMemoryCache()
  }
}

export const autoMixAnalysisService = new AutoMixAnalysisService()

function parseRefreshIdentity(trackKey: string): { id: string; platform: 'qq' | 'netease' } | null {
  const match = /^(qq|netease)-(.+)$/.exec(trackKey.trim())
  return match ? { platform: match[1] as 'qq' | 'netease', id: match[2] } : null
}

function isHttp403(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('AUDIO_DOWNLOAD_HTTP_403') || message.includes('HTTP 403')
}
