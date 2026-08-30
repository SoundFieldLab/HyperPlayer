/** 歌词格式族共享类型。所有时间为绝对毫秒。 */

export interface LyricWord {
  text: string
  startMs: number
  durationMs: number
}

export interface LyricLine {
  startMs: number
  durationMs: number
  text: string
  words: LyricWord[]
}

export interface TimedLyrics {
  lines: LyricLine[]
}

/** 歌词原文包（多语言/多粒度并存） */
export interface LyricsBundle {
  original: string
  translation: string
  romanization: string
  wordSynced: string
  wordSyncedTranslation: string
  ttml: string
  /** 解析结果：优先级 YRC → LRC → TTML */
  parsed: TimedLyrics | null
}
