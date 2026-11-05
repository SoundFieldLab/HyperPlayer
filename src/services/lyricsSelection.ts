/**
 * 歌词源仲裁 module。
 *
 * 取数（平台 / AMLL / Lrclib）留在 musicApi 的 adapter 里；本模块只吃**候选歌词**，
 * 决定骨架、翻译 / 罗马音合并与来源记录。这样评分与同步校验可以用 fixture 测，
 * 不需要网络，也不会把 localStorage 读进策略。
 */

import type { LyricLine } from './musicApi'
import type { MusicPlatform } from './platforms'

export function platformLyricsSourceName(platform: MusicPlatform): string {
  return platform === 'qq' ? 'QQ音乐' : '网易云'
}

export interface LyricsCapabilities {
  hasWordByWord: boolean
  hasTranslation: boolean
  hasRoman: boolean
}

export function detectLyricsCapabilities(lyrics: LyricLine[]): LyricsCapabilities {
  return {
    hasWordByWord: lyrics.some(line => Boolean(line.words && line.words.length > 0)),
    hasTranslation: lyrics.some(line => Boolean(line.translation)),
    hasRoman: lyrics.some(line => Boolean(line.roman || (line.romanWords && line.romanWords.length > 0))),
  }
}

const LYRIC_METADATA_LINE = /^(词|曲|编曲|作词|作曲|演唱|歌手|制作人|录音|混音|母带)[：:\s]/u

const isLyricMetadataLine = (text: string): boolean => LYRIC_METADATA_LINE.test(text.trim())

/** 只有元数据（作词 / 作曲…）没有正文的「空壳歌词」：视为无效候选。 */
export function isMetadataOnlyLyrics(lyrics: LyricLine[]): boolean {
  if (!Array.isArray(lyrics) || lyrics.length === 0) return false
  return !lyrics.some(line => {
    const text = (line.text || '').trim()
    if (!text) return false
    return !isLyricMetadataLine(text)
  })
}

export interface LyricsCandidate {
  source: string
  lyrics: LyricLine[]
}

export interface LyricsSelectionPolicy {
  platform: MusicPlatform
  /** 用户设置的主源：'AMLL' / 'Platform' / 平台名。 */
  primarySource: string
  /** 歌曲时长（毫秒）；缺省时跳过时长一致性评分。 */
  duration?: number
}

export interface LyricsSelection {
  lyrics: LyricLine[]
  skeletonSource: string | null
  hasWordByWord: boolean
  hasTranslation: boolean
  hasRoman: boolean
  finalSources: {
    wordByWord?: string
    roman?: string
    translation?: string
  }
}

const emptySelection = (): LyricsSelection => ({
  lyrics: [],
  skeletonSource: null,
  hasWordByWord: false,
  hasTranslation: false,
  hasRoman: false,
  finalSources: {},
})

/**
 * 合并歌词、翻译和罗马音。
 * 贪婪匹配最近时间且未使用的一条；只补空缺，不覆盖骨架已有内容。
 */
export function mergeLyricsWithTranslationAndRoman(
  lyrics: LyricLine[],
  translations: LyricLine[],
  romans: LyricLine[] = [],
): LyricLine[] {
  if (translations.length === 0 && romans.length === 0) return lyrics

  const usedTranslations = new Set<number>()
  const usedRomans = new Set<number>()

  return lyrics.map((lyric) => {
    const text = lyric.text?.trim() || ''

    // 元数据行与歌曲标题行不需要匹配翻译和罗马音
    const isMetadata = isLyricMetadataLine(text)
    const isSongTitle = / - /.test(text) && lyric.time < 2

    if (isMetadata || isSongTitle) return lyric

    let bestTransMatch: LyricLine | undefined
    let bestRomanMatch: LyricLine | undefined
    let minTransDiff = Infinity
    let minRomanDiff = Infinity

    translations.forEach((translation, index) => {
      if (usedTranslations.has(index)) return
      const diff = Math.abs(translation.time - lyric.time)
      // 开头歌词（前 5 秒）放宽到 2 秒：时间戳经常不准确
      const threshold = lyric.time < 5 ? 2.0 : 1.0
      if (diff < threshold && diff < minTransDiff) {
        minTransDiff = diff
        bestTransMatch = translation
      }
    })

    romans.forEach((roman, index) => {
      if (usedRomans.has(index)) return
      const diff = Math.abs(roman.time - lyric.time)
      let threshold = 1.0
      if (lyric.time < 3) {
        // 第一句放宽到 3 秒，且允许罗马音时间晚于歌词
        threshold = 3.0
      } else if (lyric.time < 10) {
        threshold = 2.0
      }
      if (diff < threshold && diff < minRomanDiff) {
        minRomanDiff = diff
        bestRomanMatch = roman
      }
    })

    if (bestTransMatch) {
      const index = translations.indexOf(bestTransMatch)
      if (index !== -1) usedTranslations.add(index)
    }
    if (bestRomanMatch) {
      const index = romans.indexOf(bestRomanMatch)
      if (index !== -1) usedRomans.add(index)
    }

    return {
      ...lyric,
      translation: lyric.translation || bestTransMatch?.text || '',
      roman: lyric.roman || bestRomanMatch?.text || '',
      romanWords: lyric.romanWords || bestRomanMatch?.words || undefined,
    }
  })
}

const normalizeLyricText = (text: string) => (text || '')
  .toLowerCase()
  .replace(/[\s·•\-–—()（）[\]【】「」『』〈〉《》"'`、，。！？!?,.&/|:：]+/g, '')

/** 候选歌词 vs 平台官方歌词：文本对齐后的时间偏差中位数 → 同步分。 */
function lyricTimingSyncScore(candidate: LyricLine[], reference: LyricLine[]): number {
  const referenceTimes = new Map<string, number[]>()
  reference.forEach((line) => {
    const key = normalizeLyricText(line.text)
    if (!key) return
    const list = referenceTimes.get(key) ?? []
    list.push(line.time)
    referenceTimes.set(key, list)
  })

  const diffs: number[] = []
  candidate.forEach((line) => {
    const key = normalizeLyricText(line.text)
    if (!key) return
    const times = referenceTimes.get(key)
    if (times && times.length > 0) diffs.push(line.time - times[0])
  })

  // 匹配对数不足（平台歌词过劣/过少）视为无法验证：不加分也不降权
  if (diffs.length < Math.max(3, Math.floor(candidate.length * 0.3))) return 0
  diffs.sort((a, b) => a - b)
  const medianDiff = Math.abs(diffs[Math.floor(diffs.length / 2)])
  if (medianDiff < 1.0) return 30
  if (medianDiff < 2.5) return 10
  return -150
}

interface ScoreContext {
  policy: LyricsSelectionPolicy
  platformSourceName: string
  preferredSource: string
  platformResult: LyricsCandidate | undefined
}

interface ScoredCandidate {
  candidate: LyricsCandidate
  capabilities: LyricsCapabilities
  score: number
}

function scoreCandidate(
  candidate: LyricsCandidate,
  capabilities: LyricsCapabilities,
  context: ScoreContext,
): number {
  const { policy, platformSourceName, preferredSource, platformResult } = context
  let score = (capabilities.hasWordByWord ? 100 : 0)
    + (capabilities.hasTranslation ? 20 : 0)
    + (capabilities.hasRoman ? 20 : 0)
    + (candidate.source === preferredSource ? 35 : 0)
    + (candidate.source === platformSourceName ? 5 : 0)
    + Math.min(10, candidate.lyrics.length / 20)

  // 时长一致性：歌词时间轴必须落在歌曲时长内（duration 为毫秒）
  if (policy.duration && candidate.lyrics.length > 0) {
    const lastTime = candidate.lyrics[candidate.lyrics.length - 1].time
    const durationSeconds = policy.duration / 1000
    if (lastTime >= durationSeconds * 0.5 && lastTime <= durationSeconds * 1.05) {
      score += 10
    } else {
      score -= 40
    }
  }

  // 平台歌词交叉验证：第三方源需与当前平台官方歌词时间轴对齐
  if (platformResult && candidate.source !== platformSourceName
    && candidate.lyrics.length > 0 && platformResult.lyrics.length > 0) {
    score += lyricTimingSyncScore(candidate.lyrics, platformResult.lyrics)
  }

  return score
}

export function selectLyrics(
  candidates: LyricsCandidate[],
  policy: LyricsSelectionPolicy,
): LyricsSelection {
  const successful = candidates.filter(candidate =>
    candidate.lyrics.length > 0 && !isMetadataOnlyLyrics(candidate.lyrics))
  if (successful.length === 0) return emptySelection()

  const platformSourceName = platformLyricsSourceName(policy.platform)
  const preferredSource = policy.primarySource === 'AMLL' ? 'AMLL TTML DB' : platformSourceName
  const platformResult = successful.find(candidate => candidate.source === platformSourceName)
  const scoreContext: ScoreContext = {
    policy,
    platformSourceName,
    preferredSource,
    platformResult,
  }

  const scored: ScoredCandidate[] = successful.map((candidate) => {
    const capabilities = detectLyricsCapabilities(candidate.lyrics)
    return {
      candidate,
      capabilities,
      score: scoreCandidate(candidate, capabilities, scoreContext),
    }
  })

  // QQ 官方歌词权威：第三方逐字源不得顶掉 QQ 骨架；网易云保持评分制。
  const base = policy.platform === 'qq'
    ? [...scored].sort((a, b) => (
      (a.candidate.source === platformSourceName ? -1 : 0)
      - (b.candidate.source === platformSourceName ? -1 : 0)
    ))[0]
    : [...scored].sort((a, b) => b.score - a.score)[0]

  let lyrics = base.candidate.lyrics
  let hasWordByWord = base.capabilities.hasWordByWord
  let hasTranslation = base.capabilities.hasTranslation
  let hasRoman = base.capabilities.hasRoman

  const finalSources: LyricsSelection['finalSources'] = {}
  if (hasWordByWord) finalSources.wordByWord = base.candidate.source
  if (hasRoman) finalSources.roman = base.candidate.source
  if (hasTranslation) finalSources.translation = base.candidate.source

  for (const result of successful) {
    if (result === base.candidate) continue

    const translations = result.lyrics
      .filter(line => line.translation)
      .map(line => ({ time: line.time, text: line.translation || '' }))
    const romans = result.lyrics
      .filter(line => line.roman || line.romanWords)
      .map(line => ({ time: line.time, text: line.roman || '', words: line.romanWords }))
    if (translations.length === 0 && romans.length === 0) continue

    const before = detectLyricsCapabilities(lyrics)
    lyrics = mergeLyricsWithTranslationAndRoman(lyrics, translations, romans)

    const after = detectLyricsCapabilities(lyrics)
    if (!before.hasTranslation && after.hasTranslation) {
      hasTranslation = true
      finalSources.translation = result.source
    }
    if (!before.hasRoman && after.hasRoman) {
      hasRoman = true
      finalSources.roman = result.source
    }
  }

  return {
    lyrics,
    skeletonSource: base.candidate.source,
    hasWordByWord,
    hasTranslation,
    hasRoman,
    finalSources,
  }
}
