export type PlaybackMode = 'sequential' | 'shuffle' | 'repeat'

export type TransitionStrategy =
  | 'smart-rendered'
  | 'smart-rendered-v2'
  | 'beat-crossfade'
  | 'fixed-crossfade'
  | 'gapless'
  | 'none'

/** 过渡调试信息（调试弹窗展示用，从过渡计划摘要而来） */
export interface TransitionDebugInfo {
  /** 引擎：v1 / v2 / 兜底计划 */
  engine: 'v1' | 'v2' | 'fallback'
  strategy: TransitionStrategy
  fallbackReason?: string
  sourceTrackKey: string
  targetTrackKey: string
  beatCount: number
  sourceBpm: number
  targetBpm: number
  confidence: number
  rendererVersion: string
  sourceStartTime: number
  sourceEndTime: number
  targetStartTime: number
  targetEndTime: number
  /** 实际编排的 DJ 效果清单（中文名，展示用） */
  effects?: string[]
  /** 响度补偿 dB */
  gainOffsetDb?: number
  /** 分析来源（调试用：librosa / beat_this / browser / metadata） */
  sourceProvider?: string
  targetProvider?: string
}

export type TransitionState =
  | 'idle'
  | 'loading-current'
  | 'playing'
  | 'preparing-next'
  | 'armed'
  | 'running-transition'
  | 'committed'
  | 'cancelled'
  | 'failed'

export interface BeatTrackingResult {
  beats: number[]
  downbeats: number[]
  beatConfidence: number[]
  downbeatConfidence: number[]
  estimatedBpm: number
  meter?: number
  confidence: number
}

export interface SectionMarker {
  time: number
  beatIndex: number
  type: 'intro' | 'verse' | 'chorus' | 'bridge' | 'drop' | 'break' | 'outro' | 'unknown'
  confidence: number
}

export interface BeatFeatureFrame {
  beatIndex: number
  time: number
  loudness: number
  rms: number
  chroma: number[]
  timbre: number[]
  vocalness: number
  energy: number
}

export interface TrackAnalysis {
  schemaVersion: number
  trackKey: string
  duration: number
  provider: 'beat_this' | 'librosa-fallback' | 'browser-fallback' | 'electron-unavailable' | 'metadata-only' | 'tv-metadata-only'
  beats: number[]
  downbeats: number[]
  beatConfidence: number[]
  downbeatConfidence: number[]
  estimatedBpm: number
  meter?: number
  confidence: number
  sections: SectionMarker[]
  beatFeatures: BeatFeatureFrame[]
  /** ITU-R BS.1770 积分响度（LUFS，Python 分析提供；响度归一化用） */
  integratedLufs?: number
  introSilence: number
  outroSilence: number
  /** 源文件音频格式（Python 分析提供真实文件格式；浏览器回退提供解码前容器格式）。
   *  过渡格式预检（多声道→固定交叉）与后续无缝裁剪消费 */
  audioFormat?: { sampleRate: number; channels: number }
  /** 逐帧 RMS 包络（浏览器回退分析计算；MV 对齐包络互相关用） */
  rmsEnvelope?: number[]
  /** 包络互相关峰值（≥0.6 表示 MV 与歌曲同录音；网格置信度失效时可兜底用包络偏移） */
  envelopePeak?: number
  /** 包络互相关偏移（秒；仅 envelopePeak ≥0.6 时可信） */
  envelopeOffset?: number
  sourceSignature?: string
  analysisVersion: string
  createdAt: number
  lastAccessAt: number
}

export interface TransitionPlan {
  id: string
  sourceTrackKey: string
  targetTrackKey: string
  sourceStartTime: number
  sourceEndTime: number
  targetStartTime: number
  targetEndTime: number
  beatCount: number
  sourceBpm: number
  targetBpm: number
  tempoRamp: number[]
  sourceDownbeatIndex: number
  targetDownbeatIndex: number
  sourceSection?: SectionMarker
  targetSection?: SectionMarker
  sourceBeatTimes?: number[]  // Beat positions in seconds for progressive stretching
  targetBeatTimes?: number[]  // Beat positions in seconds for progressive stretching
  gainCurve: { source: number[]; target: number[] }
  /** 响度补偿（dB）：作用于 target 侧，正数=抬高目标，负数=压低目标（clamp ±3.5dB） */
  gainOffsetDb?: number
  confidence: number
  strategy: TransitionStrategy
  fallbackReason?: string
  analysisVersion: string
  rendererVersion: string
  /** AI 长混音专用：缓冲尾段渐出/目标 deck 提前渐入的重叠窗口（秒），掩蔽 handoff 速度台阶 */
  overlapSeconds?: number
  /** AI 长混音专用：混音尾段 target 内容相对原曲的播放速度比（<1 慢 / >1 快）。
   *  handoff 时 deck 以此 playbackRate 起步，overlap 窗口内渐回 1.0（post-settle） */
  mixSpeedRatio?: number
}

export interface RenderedTransition {
  id: string
  url: string
  duration: number
  sourceTrackKey: string
  targetTrackKey: string
  createdAt: number
}

export interface TransitionCommit {
  sourceTrackKey: string
  targetTrackKey: string
  targetIndex?: number
  targetTime: number
  strategy: TransitionStrategy
  isVisualSwitch?: boolean  // true = 仅视觉切换，false/undefined = 真正的歌曲切换
}

export interface PreloadTrack {
  url: string
  trackKey?: string
  index?: number
  duration?: number
  albumId?: string
  albumCover?: string
  /** Apple Music 原生 HLS 音源元数据（url 为 .m3u8 时由引擎用 hls.js 播放） */
  appleHls?: import('../services/applePlayback').AppleNativeStream
  /** 预载管线完成通知；用于瞬时失败后由队列层决定是否重试。 */
  onPreloadSettled?: (success: boolean) => void
}

export interface PlaybackEngineState {
  isPlaying?: boolean
  currentTime?: number
  duration?: number
  /** 直播流（Apple 电台等）：时长置 0，UI 显示直播指示、禁拖动 */
  live?: boolean
  volume?: number
  buffered?: number
  ended?: boolean
  transitioning?: boolean
  seamlessTransition?: boolean
  transitionState?: TransitionState
  transitionStrategy?: TransitionStrategy
  fallbackReason?: string
  transitionCommit?: TransitionCommit
  visualSwitchCommit?: TransitionCommit
  transitionProgress?: number  // 过渡进度 0-1
  transitionDuration?: number  // 过渡总时长（秒）
  /** 渲染过渡缓冲内当前可听到的目标歌曲绝对时间（MV 目标槽同步用） */
  transitionTargetTime?: number
  transitionStartTime?: number | null // 当前音轨进入计划过渡的时间点（秒）
  transitionFromTrackKey?: string  // 前一曲的 trackKey
  transitionToTrackKey?: string    // 下一曲的 trackKey
  transitionStyle?: 'energetic' | 'atmospheric' | 'clean' | undefined // v2 过渡风格标签（UI 提示用）
  transitionDebug?: TransitionDebugInfo // 过渡调试信息（过渡调试弹窗用）
}
