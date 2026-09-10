/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * TransitionRenderer（减配后）——仅保留 standard-v1 的纯前端 equal-power 交叉淡化渲染。
 * smart-rendered / smart-rendered-v2 的 Python/Electron 渲染桥、DJTransGAN AI 混音、
 * HTDemucs 分轨交接等分支已移除。
 */
import { debugLog } from '../utils/debugLog'
import type { TransitionPlan } from './types'

interface RenderProgress {
  stage: 'analyzing' | 'stretching' | 'mixing' | 'finalizing'
  progress: number
}

interface RenderResult {
  audioBuffer: AudioBuffer
  plan: TransitionPlan
  renderTime: number
}

interface RenderCache {
  buffer: AudioBuffer
  timestamp: number
  plan: TransitionPlan
  bytes: number
}

/** AudioBuffer → 16bit PCM WAV（保留：通用音频转码工具，被单测直接消费）。 */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.max(1, buffer.numberOfChannels)
  const sampleRate = buffer.sampleRate
  const frames = buffer.length
  const blockAlign = numChannels * 2
  const dataSize = frames * blockAlign
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  const channels: Float32Array[] = []
  for (let ch = 0; ch < numChannels; ch += 1) channels.push(buffer.getChannelData(ch))
  let offset = 44
  for (let i = 0; i < frames; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return arrayBuffer
}

export class TransitionRenderer {
  private audioContext: AudioContext
  private masterGain: GainNode | null = null
  private cache: Map<string, RenderCache> = new Map()
  private activeSource: AudioBufferSourceNode | null = null
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null
  private cacheBytes = 0
  private readonly MAX_CACHE_SIZE = 10
  private readonly MAX_CACHE_BYTES = 128 * 1024 * 1024
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(audioContext: AudioContext, masterGain?: GainNode) {
    this.audioContext = audioContext
    this.masterGain = masterGain || null
    this.startCacheCleanup()
  }

  setMasterGain(masterGain: GainNode): void {
    this.masterGain = masterGain
  }

  /**
   * 渲染标准固定交叉淡化（standard-v1，纯前端 equal-power）。
   * smart 渲染路径已移除：本方法只做交叉淡化，调用方需提供源/目标 AudioBuffer。
   */
  async renderTransition(
    plan: TransitionPlan,
    sourceUrl: string,
    targetUrl: string,
    sourceBuffer?: AudioBuffer,
    targetBuffer?: AudioBuffer,
    onProgress?: (progress: RenderProgress) => void,
    isStale?: () => boolean
  ): Promise<RenderResult> {
    void sourceUrl
    void targetUrl
    const startTime = performance.now()
    if (!plan.id?.trim()) throw new Error('Transition plan requires a non-empty ID')
    if (!plan.sourceTrackKey?.trim() || !plan.targetTrackKey?.trim()) {
      throw new Error('Transition plan requires non-empty track keys')
    }

    // Check cache first
    const cached = this.cache.get(plan.id)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      debugLog(`[TransitionRenderer] Cache hit for ${plan.id}`)
      return {
        audioBuffer: cached.buffer,
        plan: cached.plan,
        renderTime: performance.now() - startTime,
      }
    }
    if (cached) this.deleteCacheEntry(plan.id)

    debugLog(`[TransitionRenderer] Rendering transition with strategy: ${plan.strategy}`)
    if (!sourceBuffer || !targetBuffer) {
      throw new Error('AudioBuffers required for crossfade strategy')
    }
    const audioBuffer = await this.renderCrossfade(plan, sourceBuffer, targetBuffer, onProgress)

    const renderTime = performance.now() - startTime
    debugLog(`[TransitionRenderer] Rendered in ${renderTime.toFixed(2)}ms`)

    // If this render was superseded by a newer request, discard the result:
    // do not write it into the cache so a stale AudioBuffer (tens of MB) is
    // not pinned in memory until TTL expiry.
    if (isStale?.()) {
      debugLog(`[TransitionRenderer] Discarding superseded render ${plan.id}`)
      return { audioBuffer, plan, renderTime }
    }

    this.addToCache(plan, audioBuffer)
    return { audioBuffer, plan, renderTime }
  }

  private async renderCrossfade(
    plan: TransitionPlan,
    sourceBuffer: AudioBuffer,
    targetBuffer: AudioBuffer,
    onProgress?: (progress: RenderProgress) => void
  ): Promise<AudioBuffer> {
    onProgress?.({ stage: 'mixing', progress: 0 })

    // The output buffer must cover the TARGET window span so the resume point
    // (plan.targetEndTime) matches what the listener heard at handoff. When
    // source and target BPM differ the spans differ, so the source window is
    // scaled across the output span below to keep beat alignment. Degenerate
    // target spans (targetEndTime <= targetStartTime) fall back to the previous
    // source-span behavior.
    const sourceSpan = plan.sourceEndTime - plan.sourceStartTime
    const targetSpan = plan.targetEndTime - plan.targetStartTime
    const duration = targetSpan > 0 ? targetSpan : sourceSpan
    const sampleRate = sourceBuffer.sampleRate
    const samples = Math.floor(duration * sampleRate)
    const channels = Math.max(sourceBuffer.numberOfChannels, targetBuffer.numberOfChannels)

    const outputBuffer = this.audioContext.createBuffer(channels, samples, sampleRate)

    const sourceStart = Math.floor(plan.sourceStartTime * sampleRate)
    const targetStart = Math.floor(plan.targetStartTime * sampleRate)

    // Apply gain curves
    const sourceGain = plan.gainCurve.source
    const targetGain = plan.gainCurve.target
    const curveLength = Math.max(1, sourceGain.length)

    for (let ch = 0; ch < channels; ch++) {
      const output = outputBuffer.getChannelData(ch)
      const sourceData = ch < sourceBuffer.numberOfChannels ? sourceBuffer.getChannelData(ch) : null
      const targetData = ch < targetBuffer.numberOfChannels ? targetBuffer.getChannelData(ch) : null

      for (let i = 0; i < samples; i++) {
        const progress = samples > 1 ? i / (samples - 1) : 0
        const curveIndex = Math.min(curveLength - 1, Math.floor(progress * curveLength))
        const sourceGainValue = sourceGain[curveIndex] ?? 0
        const targetGainValue = targetGain[curveIndex] ?? 0

        const sourceIndex = targetSpan > 0
          ? sourceStart + Math.floor(i * sourceSpan / targetSpan)
          : sourceStart + i
        const sourceSample = sourceData ? (sourceData[sourceIndex] || 0) : 0
        const targetSample = targetData ? (targetData[targetStart + i] || 0) : 0

        output[i] = sourceSample * sourceGainValue + targetSample * targetGainValue
      }

      onProgress?.({ stage: 'mixing', progress: (ch + 1) / channels })
    }

    return outputBuffer
  }

  private getBufferBytes(buffer: AudioBuffer): number {
    return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT
  }

  private deleteCacheEntry(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    this.cache.delete(key)
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.bytes)
    return true
  }

  private evictOldestCacheEntry(): boolean {
    let oldestKey: string | null = null
    let oldestTime = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp
        oldestKey = key
      }
    }
    return oldestKey !== null && this.deleteCacheEntry(oldestKey)
  }

  private addToCache(plan: TransitionPlan, buffer: AudioBuffer): void {
    const bytes = this.getBufferBytes(buffer)
    this.deleteCacheEntry(plan.id)

    // A single unusually long transition must not pin more than the entire
    // decoded PCM budget. It can still be returned and played by the caller.
    if (bytes > this.MAX_CACHE_BYTES) return

    while (
      this.cache.size >= this.MAX_CACHE_SIZE
      || this.cacheBytes + bytes > this.MAX_CACHE_BYTES
    ) {
      if (!this.evictOldestCacheEntry()) break
    }

    this.cache.set(plan.id, {
      buffer,
      timestamp: Date.now(),
      plan,
      bytes,
    })
    this.cacheBytes += bytes
  }

  private startCacheCleanup(): void {
    this.cacheCleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.cache.entries()) {
        if (entry.timestamp + this.CACHE_TTL < now) {
          this.deleteCacheEntry(key)
        }
      }
    }, 60000) // Cleanup every minute
  }

  getRendered(planId: string): AudioBuffer | null {
    const cached = this.cache.get(planId)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      return cached.buffer
    }
    if (cached) this.deleteCacheEntry(planId)
    return null
  }

  async playTransition(
    planId: string,
    sourceCurrentTime: number,
    onEnded?: () => void,
    options?: { overlap?: number },
  ): Promise<{
    targetResumeTime: number
    playbackOffset: number
    remainingDuration: number
    /** 缓冲尾段渐出 + deck 提前渐入的重叠窗口（秒）；0 = 普通硬交接 */
    overlap?: number
    /** true = 触发过晚（已越过缓冲 85%），缓冲未启动，调用方应回退交叉淡化 */
    tooLate?: boolean
  } | null> {
    const cached = this.cache.get(planId)
    if (!cached || cached.timestamp + this.CACHE_TTL <= Date.now()) {
      if (cached) this.deleteCacheEntry(planId)
      return null
    }

    const plan = cached.plan
    const buffer = cached.buffer

    // Transition is one-shot: remove from cache immediately to release the
    // decoded AudioBuffer as soon as the source node finishes with it.
    this.deleteCacheEntry(planId)

    // 迟到保护：触发已越过缓冲 85% 时，播放缓冲只剩极小一段（近似硬切 + 音量阶梯），
    // 放弃缓冲让调用方回退标准交叉淡化。
    const rawOffset = Math.max(0, sourceCurrentTime - plan.sourceStartTime)
    if (rawOffset > buffer.duration * 0.85) {
      this.stopPlayback()
      debugLog(`[TransitionRenderer] Late trigger (offset ${rawOffset.toFixed(2)}s > 85% of ${buffer.duration.toFixed(2)}s), abandoning buffer`)
      return {
        targetResumeTime: plan.targetEndTime,
        playbackOffset: rawOffset,
        remainingDuration: 0.05,
        tooLate: true,
      }
    }

    // Create a buffer source to play the transition
    this.stopPlayback()
    const source = this.audioContext.createBufferSource()
    this.activeSource = source
    source.buffer = buffer

    const playbackOffset = Math.max(0, Math.min(rawOffset, Math.max(0, buffer.duration - 0.05)))
    // overlap handoff：缓冲尾段渐出 + 目标 deck 提前启动交叉。
    // 结束时刻相对播放起点 = buffer.duration - playbackOffset。
    const bufferRemaining = Math.max(0.05, buffer.duration - playbackOffset)
    const overlapRequested = Math.max(0, Math.min(options?.overlap ?? 0, bufferRemaining * 0.35))
    let transitionGain: GainNode | null = null
    if (overlapRequested > 0.05) {
      transitionGain = this.audioContext.createGain()
      const now = this.audioContext.currentTime
      const endAt = now + bufferRemaining
      // 入场 400ms 渐入 + 尾段渐出到静音
      transitionGain.gain.setValueAtTime(0.0001, now)
      transitionGain.gain.linearRampToValueAtTime(1, now + 0.4)
      transitionGain.gain.setValueAtTime(1, Math.max(now + 0.4, endAt - overlapRequested))
      transitionGain.gain.linearRampToValueAtTime(0.12, Math.max(now + 0.4, endAt - overlapRequested * 0.5))
      transitionGain.gain.linearRampToValueAtTime(0.0001, endAt)
      source.connect(transitionGain)
      if (this.masterGain) {
        transitionGain.connect(this.masterGain)
      } else {
        transitionGain.connect(this.audioContext.destination)
      }
    }

    // Connect through master gain if available, otherwise directly to destination
    if (!transitionGain) {
      if (this.masterGain) {
        source.connect(this.masterGain)
      } else {
        source.connect(this.audioContext.destination)
      }
    }

    source.addEventListener('ended', () => {
      if (this.activeSource === source) this.activeSource = null
      // Release the buffer reference from the source node so GC can reclaim it
      source.buffer = null
      if (transitionGain) {
        transitionGain.disconnect()
        transitionGain = null
      }
      source.disconnect()
      // 事件驱动 handoff：缓冲精确结束时通知调用方启动 target
      onEnded?.()
    }, { once: true })
    source.start(0, playbackOffset)

    // The rendered audio contains both tracks mixed together:
    // - Source: from sourceStartTime to sourceEndTime
    // - Target: from targetStartTime to targetEndTime
    // After playing the rendered transition, we should resume from targetEndTime
    const targetResumeTime = plan.targetEndTime
    const remainingDuration = bufferRemaining

    debugLog(`[TransitionRenderer] Playing cached transition ${planId}`)
    debugLog(`  - Transition buffer duration: ${buffer.duration.toFixed(2)}s`)
    debugLog(`  - Late-trigger offset: ${playbackOffset.toFixed(3)}s`)
    debugLog(`  - Target was mixed from ${plan.targetStartTime.toFixed(2)}s to ${plan.targetEndTime.toFixed(2)}s`)
    debugLog(`  - Will resume target at ${targetResumeTime.toFixed(2)}s`)

    return {
      targetResumeTime,
      playbackOffset,
      remainingDuration,
      overlap: overlapRequested,
    }
  }

  stopPlayback(): void {
    const source = this.activeSource
    this.activeSource = null
    if (!source) return
    try {
      source.stop()
    } catch {
      // The transition buffer may already have ended.
    }
    // Drop the buffer reference before disconnecting so the decoded audio
    // can be garbage collected when a transition is cancelled or replaced.
    source.buffer = null
    source.disconnect()
  }

  clearCache(): void {
    this.cache.clear()
    this.cacheBytes = 0
  }

  getCacheSize(): number {
    return this.cache.size
  }

  dispose(): void {
    this.stopPlayback()
    if (this.cacheCleanupTimer !== null) {
      clearInterval(this.cacheCleanupTimer)
      this.cacheCleanupTimer = null
    }
    this.clearCache()
  }
}
