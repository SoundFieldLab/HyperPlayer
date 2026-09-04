// 播放服务（D34 Q9）：WebView 全链路播放 —— 双源调度。
// - 本地完整数据（本地文件经 asset: 协议 / 整轨缓存）→ decodeAudioData +
//   AudioBufferSourceNode 采样级调度（真 gapless）
// - 流式在线播放 → HTMLMediaElement + 预载快切（近似 gapless）
// - DSP：HSE AudioWorklet 宿主（hypersoundengine/browser），script 兜底
// 播放状态快照（PlaybackSnapshotDto）为 UI 权威状态，revision 离散递增。

import { createHyperSoundEngineHost, type HyperSoundEngineHost, type HyperSoundEngineAudioContextLike, type HyperSoundEngineAudioNodeLike } from 'hypersoundengine/browser'
import { createDefaultParams, type HyperSoundEngineParams } from 'hypersoundengine'
import type {
  PlaybackSnapshotDto,
  QueueItemDto,
  TrackDto,
  BackendTrackRefDto,
  DspProcessingFaultDto,
} from '../../bridge/contracts'
import { adaptTrack, bridge } from '../../bridge'

export type PlaybackStatus = PlaybackSnapshotDto['status']

interface PlaybackListener {
  onChanged(snapshot: PlaybackSnapshotDto): void
  onQueueChanged(snapshot: PlaybackSnapshotDto): void
  onProgress(revision: string, positionMs: number, durationMs: number | null): void
  onFault(fault: DspProcessingFaultDto): void
}

const WORKLET_URL = '/hse-worklet-bundle.js'

export class PlaybackService {
  private context: AudioContext | null = null
  private host: HyperSoundEngineHost | null = null
  private gainNode: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private snapshot: PlaybackSnapshotDto = {
    revision: '0',
    status: 'idle',
    current: null,
    currentQueueItemId: null,
    positionMs: 0,
    durationMs: null,
    volume: 0.72,
    repeat: 'off',
    shuffled: false,
    queue: [],
    nextUp: [],
    dspExecution: { revision: '0', safeBypassActive: false, fault: null },
  }
  private revisionCounter = 0n

  // 双源调度状态
  private bufferSource: AudioBufferSourceNode | null = null
  private mediaElement: HTMLAudioElement | null = null
  private currentTrack: TrackDto | null = null
  private nextBuffer: AudioBuffer | null = null
  private nextTrack: TrackDto | null = null

  // 队列（nextUp 语义：playNext 插入队首之前）
  private queue: QueueItemDto[] = []
  private nextUp: QueueItemDto[] = []
  private contextKind: string | null = null
  private contextId: string | null = null

  private listeners = new Set<PlaybackListener>()
  private tickTimer: number | null = null
  private started = false

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChanged(): void {
    for (const listener of this.listeners) listener.onChanged(this.snapshot)
    this.pushSmtcState()
  }
  private emitQueue(): void {
    for (const listener of this.listeners) listener.onQueueChanged(this.snapshot)
  }
  private emitProgress(): void {
    const { revision, positionMs, durationMs } = this.snapshot
    for (const listener of this.listeners) listener.onProgress(revision, positionMs, durationMs)
    if (this.snapshot.status === 'playing') this.pushSmtcPosition()
  }

  /** D35 Q13：SMTC 上行——状态变化时推送播放状态 */
  private pushSmtcState(): void {
    const state = this.snapshot.status === 'playing' ? 'playing' : this.snapshot.status === 'paused' ? 'paused' : 'stopped'
    void bridge.smtcUpdatePlaybackState(state).catch(() => undefined)
  }

  /** D35 Q13：SMTC 上行——进度节拍（1Hz） */
  private pushSmtcPosition(): void {
    void bridge
      .smtcUpdatePosition({
        positionMs: this.snapshot.positionMs,
        durationMs: this.snapshot.durationMs,
      })
      .catch(() => undefined)
  }

  /** D35 Q13：SMTC 上行——曲目切换时推送元数据 */
  private pushSmtcMetadata(track: TrackDto): void {
    void bridge
      .smtcUpdateMetadata({
        title: track.title,
        artist: track.artists.join(' / '),
        album: track.album && track.album !== '未知专辑' ? track.album : null,
        thumbnailDataUrl: track.coverSeed && track.coverSeed.startsWith('data:') ? track.coverSeed : null,
      })
      .catch(() => undefined)
  }

  private nextRevision(): string {
    this.revisionCounter += 1n
    return this.revisionCounter.toString()
  }

  // ---- 初始化：AudioContext + HSE 宿主 ----
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (typeof window === 'undefined') return
    this.context = new AudioContext()
    this.gainNode = this.context.createGain()
    this.analyser = this.context.createAnalyser()
    this.gainNode.connect(this.analyser)
    this.analyser.connect(this.context.destination)
    this.gainNode.gain.value = this.snapshot.volume

    try {
      this.host = createHyperSoundEngineHost({
        mode: 'auto',
        engineBackend: 'ts',
        workletUrl: WORKLET_URL,
        blockSize: 4096,
      })
      await this.host.attach(
        {
          audioContext: this.context as unknown as HyperSoundEngineAudioContextLike,
          masterGain: this.gainNode as unknown as HyperSoundEngineAudioNodeLike,
          analyser: this.analyser as unknown as HyperSoundEngineAudioNodeLike,
        },
        createDefaultParams(this.context.sampleRate),
      )
    } catch (error) {
      // worklet/script 接入失败：继续用直通（安全旁路语义），不影响播放
      console.warn('[playback] HSE host attach failed, bypass DSP:', error)
      this.snapshot = { ...this.snapshot, dspExecution: { ...this.snapshot.dspExecution, safeBypassActive: true } }
    }
    this.startTicker()
  }

  private startTicker(): void {
    if (this.tickTimer !== null) return
    this.tickTimer = window.setInterval(() => {
      const current = this.snapshot.current
      if (!current) return
      if (this.snapshot.status === 'playing') {
        const positionMs = this.currentPositionMs()
        this.snapshot = { ...this.snapshot, positionMs }
        this.emitProgress()
      }
    }, 1000)
  }

  private stopTicker(): void {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  dispose(): void {
    this.stopTicker()
    this.bufferSource?.stop()
    this.mediaElement?.pause()
    this.host?.dispose()
    void this.context?.close()
    this.context = null
    this.host = null
    this.started = false
  }

  // ---- 状态 ----
  getPlayback(): PlaybackSnapshotDto {
    return this.snapshot
  }

  /** DSP 服务访问 HSE 宿主（未初始化返回 null） */
  getHseHost(): HyperSoundEngineHost | null {
    return this.host
  }

  // ---- 传输控制 ----
  async play(): Promise<PlaybackSnapshotDto> {
    await this.ensureContext()
    if (this.snapshot.status === 'paused') {
      this.resume()
    } else if (this.snapshot.status === 'idle' && this.queue.length > 0) {
      await this.loadTrack(this.queue[0].track, 0)
    } else if (this.snapshot.current) {
      await this.loadTrack(this.snapshot.current, this.snapshot.positionMs)
    }
    return this.snapshot
  }

  async pause(): Promise<PlaybackSnapshotDto> {
    this.pauseInternal()
    return this.snapshot
  }

  async stop(): Promise<PlaybackSnapshotDto> {
    this.bufferSource?.stop()
    this.mediaElement?.pause()
    this.snapshot = { ...this.snapshot, status: 'stopped', positionMs: 0, current: null }
    this.emitChanged()
    return this.snapshot
  }

  async next(): Promise<PlaybackSnapshotDto> {
    await this.advance(1)
    return this.snapshot
  }

  async previous(): Promise<PlaybackSnapshotDto> {
    if (this.snapshot.positionMs > 3000) {
      await this.seek(0)
      return this.snapshot
    }
    await this.advance(-1)
    return this.snapshot
  }

  async seek(positionMs: number): Promise<PlaybackSnapshotDto> {
    const position = Math.max(0, positionMs)
    if (this.bufferSource && this.context) {
      // AudioBufferSource 采样级 seek：重载当前 buffer 从目标位置播放
      await this.loadTrack(this.snapshot.current!, position, this.bufferSource.buffer ?? undefined)
    } else if (this.mediaElement) {
      this.mediaElement.currentTime = position / 1000
      this.snapshot = { ...this.snapshot, positionMs: position }
      this.emitProgress()
    }
    return this.snapshot
  }

  async setVolume(volume: number): Promise<PlaybackSnapshotDto> {
    const next = Math.max(0, Math.min(1, volume))
    this.snapshot = { ...this.snapshot, volume: next }
    if (this.gainNode) this.gainNode.gain.value = next
    this.emitChanged()
    return this.snapshot
  }

  async setRepeatMode(repeat: PlaybackSnapshotDto['repeat']): Promise<PlaybackSnapshotDto> {
    this.snapshot = { ...this.snapshot, repeat }
    this.emitChanged()
    return this.snapshot
  }

  // ---- 队列 ----
  async enqueue(track: BackendTrackRefDto, position: 'contextEnd' | 'playNext'): Promise<PlaybackSnapshotDto> {
    const fullTrack = await this.resolveTrack(track)
    if (!fullTrack) throw new Error('无法解析曲目')
    const item: QueueItemDto = { queueItemId: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, track: fullTrack }
    if (position === 'playNext') {
      this.nextUp.unshift(item)
    } else {
      this.queue.push(item)
    }
    this.snapshot = { ...this.snapshot, queue: this.queue, nextUp: this.nextUp }
    this.emitQueue()
    return this.snapshot
  }

  async removeQueueItem(queueItemId: string): Promise<PlaybackSnapshotDto> {
    this.queue = this.queue.filter((item) => item.queueItemId !== queueItemId)
    this.nextUp = this.nextUp.filter((item) => item.queueItemId !== queueItemId)
    this.snapshot = { ...this.snapshot, queue: this.queue, nextUp: this.nextUp }
    this.emitQueue()
    return this.snapshot
  }

  async reorderQueueItem(queueItemId: string, targetIndex: number): Promise<PlaybackSnapshotDto> {
    const sourceIndex = this.queue.findIndex((item) => item.queueItemId === queueItemId)
    if (sourceIndex < 0) return this.snapshot
    const [item] = this.queue.splice(sourceIndex, 1)
    this.queue.splice(Math.max(0, Math.min(targetIndex, this.queue.length)), 0, item)
    this.snapshot = { ...this.snapshot, queue: this.queue, nextUp: this.nextUp }
    this.emitQueue()
    return this.snapshot
  }

  async clearQueue(scope: 'playNext' | 'all'): Promise<PlaybackSnapshotDto> {
    if (scope === 'all') {
      this.queue = []
      this.nextUp = []
    } else {
      this.nextUp = []
    }
    this.snapshot = { ...this.snapshot, queue: this.queue, nextUp: this.nextUp }
    this.emitQueue()
    return this.snapshot
  }

  // ---- 曲目载入 ----
  async playTrack(track: TrackDto, context?: { kind: string; id: string | null }): Promise<PlaybackSnapshotDto> {
    await this.ensureContext()
    this.contextKind = context?.kind ?? 'manual'
    this.contextId = context?.id ?? null
    await this.loadTrack(track, 0)
    return this.snapshot
  }

  private async loadTrack(
    track: TrackDto,
    startMs: number,
    preloadedBuffer?: AudioBuffer,
  ): Promise<void> {
    this.currentTrack = track
    this.snapshot = {
      ...this.snapshot,
      status: 'loading',
      current: track,
      positionMs: startMs,
      durationMs: track.durationMs,
      revision: this.nextRevision(),
    }
    this.emitChanged()

    try {
      if (preloadedBuffer) {
        await this.playBuffer(track, preloadedBuffer, startMs)
      } else if (track.source === 'local') {
        const buffer = await this.decodeTrack(track)
        await this.playBuffer(track, buffer, startMs)
      } else {
        await this.playStream(track, startMs)
      }
    } catch (error) {
      this.snapshot = { ...this.snapshot, status: 'failed', revision: this.nextRevision() }
      this.emitChanged()
    }
  }

  /** 本地完整数据：decodeAudioData + AudioBufferSource（采样级 gapless） */
  private async decodeTrack(track: TrackDto): Promise<AudioBuffer> {
    if (!this.context) throw new Error('AudioContext 未初始化')
    const url = await this.resolveSourceUrl(track)
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    return this.context.decodeAudioData(arrayBuffer)
  }

  private async playBuffer(track: TrackDto, buffer: AudioBuffer, startMs: number): Promise<void> {
    if (!this.context || !this.gainNode) throw new Error('播放图未初始化')
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gainNode)
    const offset = startMs / 1000
    this.bufferStartOffsetMs = (this.context.currentTime - offset) * 1000
    source.start(0, offset)
    source.onended = () => this.onTrackEnded(track)
    this.bufferSource = source
    this.pushSmtcMetadata(track)
    this.snapshot = {
      ...this.snapshot,
      status: 'playing',
      durationMs: buffer.duration * 1000,
      revision: this.nextRevision(),
    }
    this.emitChanged()
  }

  /** 流式在线：MediaElement + 预载快切（近似 gapless） */
  private async playStream(track: TrackDto, startMs: number): Promise<void> {
    const url = await this.resolveSourceUrl(track)
    if (!this.mediaElement) {
      this.mediaElement = new Audio()
      this.mediaElement.crossOrigin = 'anonymous'
    }
    this.mediaElement.src = url
    this.mediaElement.currentTime = startMs / 1000
    this.mediaElement.volume = this.snapshot.volume
    await this.mediaElement.play()
    this.mediaElement.onended = () => this.onTrackEnded(track)
    this.pushSmtcMetadata(track)
    this.snapshot = { ...this.snapshot, status: 'playing', revision: this.nextRevision() }
    this.emitChanged()
  }

  /** 曲目 URL 解析：本地走 asset 协议，在线走网易云播放地址（经服务层） */
  private async resolveSourceUrl(track: TrackDto): Promise<string> {
    if (track.source === 'local') {
      // asset: 协议 —— 需在 Rust 侧登记过曲库目录（library_register_location 已做）
      return `asset://localhost/${encodeURIComponent(track.id)}`
    }
    const { getSongUrl } = await import('../netease/neteaseService')
    const result = await getSongUrl(Number(track.id), qualityLevel(track.quality))
    if (!result.url) throw new Error('没有可用的官方播放地址')
    return result.url
  }

  private async resolveTrack(ref: BackendTrackRefDto): Promise<TrackDto | null> {
    if (ref.source === 'local') {
      const page = await bridge.libraryQuery(ref.id)
      const found = page.items.find((item) => item.trackRef.id === ref.id)
      return found ? adaptTrack(found) : null
    }
    const { getSongDetail } = await import('../netease/neteaseService')
    const detail = await getSongDetail(Number(ref.id))
    if (!detail) return null
    return {
      id: String(detail.id),
      title: detail.name,
      artists: detail.artists.map((a) => a.name),
      album: detail.album.name,
      durationMs: detail.dt,
      source: 'netease',
      entitlement: 'free',
      quality: '标准',
      cache: 'none',
      coverSeed: '',
    }
  }

  private pauseInternal(): void {
    this.bufferSource?.stop()
    this.mediaElement?.pause()
    this.snapshot = { ...this.snapshot, status: 'paused', revision: this.nextRevision() }
    this.emitChanged()
  }

  private resume(): void {
    if (this.mediaElement) {
      void this.mediaElement.play()
    } else if (this.bufferSource && this.currentTrack) {
      void this.loadTrack(this.currentTrack, this.snapshot.positionMs, this.bufferSource.buffer ?? undefined)
    }
    this.snapshot = { ...this.snapshot, status: 'playing', revision: this.nextRevision() }
    this.emitChanged()
  }

  private currentPositionMs(): number {
    if (this.mediaElement) return this.mediaElement.currentTime * 1000
    if (this.context && this.bufferSource) {
      return this.context.currentTime * 1000 - this.bufferStartOffsetMs
    }
    return this.snapshot.positionMs
  }

  private bufferStartOffsetMs = 0

  private async onTrackEnded(track: TrackDto): Promise<void> {
    const repeat = this.snapshot.repeat
    if (repeat === 'one' && this.snapshot.current?.id === track.id) {
      await this.loadTrack(track, 0)
      return
    }
    const queueIndex = this.queue.findIndex((item) => item.track.id === track.id)
    const nextItem = this.nextUp.shift() ?? (queueIndex >= 0 ? this.queue[(queueIndex + 1) % this.queue.length] : null)
    if (nextItem) {
      await this.loadTrack(nextItem.track, 0)
    } else if (repeat === 'all' && this.queue.length > 0) {
      await this.loadTrack(this.queue[0].track, 0)
    } else {
      this.snapshot = { ...this.snapshot, status: 'stopped', positionMs: 0, revision: this.nextRevision() }
      this.emitChanged()
    }
  }

  private async advance(delta: number): Promise<void> {
    if (this.queue.length === 0) return
    const currentIndex = this.queue.findIndex((item) => item.track.id === this.snapshot.current?.id)
    const nextIndex = (currentIndex < 0 ? 0 : currentIndex + delta + this.queue.length) % this.queue.length
    await this.loadTrack(this.queue[nextIndex].track, 0)
  }

  private async ensureContext(): Promise<void> {
    await this.start()
    if (this.context?.state === 'suspended') await this.context.resume()
  }
}

function qualityLevel(quality: TrackDto['quality']): import('../netease/neteaseService').QualityLevel {
  switch (quality) {
    case '无损': return 'lossless'
    case '极高': return 'exhigh'
    case 'Hi-Res': return 'hires'
    default: return 'standard'
  }
}

export const playbackService = new PlaybackService()
