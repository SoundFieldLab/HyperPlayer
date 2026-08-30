/**
 * 词级时间归一化与卡拉OK图元化。
 * 面向渲染层的纯函数：括号补齐 → 绝对起点校正 → 间距修复 → 顺序归一化 → 图元展开。
 * 输入约定为绝对毫秒时间轴（与 types.ts 一致）。
 */
import type { LyricLine, LyricWord, TimedLyrics } from './types'

export interface TimedLyricGlyph {
  text: string
  startMs: number
  endMs: number
  wordIndex: number
  glyphIndex: number
  isWhitespace: boolean
}

const FALLBACK_WORD_DURATION_MS = 140

/** 图素切分：优先 Intl.Segmenter，降级 Array.from（码点） */
export function segmentGraphemes(text: string): string[] {
  const SegmenterCtor = (
    Intl as typeof Intl & {
      Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => {
        segment: (value: string) => Iterable<{ segment: string }>
      }
    }
  ).Segmenter
  if (!SegmenterCtor) return Array.from(text)
  return Array.from(new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(text), (item) => item.segment)
}

/** 仅补齐整行首尾缺失的括号（行内括号与既有时间不动） */
export function reconcileBoundaryParentheses(lineText: string, source: readonly LyricWord[]): LyricWord[] {
  if (!lineText || source.length === 0) return [...source]

  let tokens: LyricWord[] = source.map((word) => ({ ...word }))
  const leading = (text: string) => text.trimStart().match(/^[（(]+/u)?.[0] ?? ''
  const trailing = (text: string) => text.trimEnd().match(/[）)]+$/u)?.[0] ?? ''

  const completeLeading = Array.from(leading(lineText))
  const timedLeading = Array.from(leading(tokens.map((word) => word.text).join('')))
  const missingLeading = completeLeading.slice(0, Math.max(0, completeLeading.length - timedLeading.length))
  if (missingLeading.length > 0) {
    tokens = [...missingLeading.map((text) => ({ text, startMs: tokens[0]?.startMs ?? 0, durationMs: 0 })), ...tokens]
  }

  const completeTrailing = Array.from(trailing(lineText))
  const timedTrailing = Array.from(trailing(tokens.map((word) => word.text).join('')))
  const missingTrailingCount = Math.max(0, completeTrailing.length - timedTrailing.length)
  if (missingTrailingCount > 0) {
    const last = tokens[tokens.length - 1]
    const boundaryMs = Math.max(0, last.startMs + Math.max(0, last.durationMs))
    tokens.push(
      ...completeTrailing.slice(completeTrailing.length - missingTrailingCount).map((text) => ({ text, startMs: boundaryMs, durationMs: 0 })),
    )
  }
  return tokens
}

/** 修复词内粘连：拆出首尾空白为独立零时长 token，并按整行文本补插词间空格 */
export function restoreWordSpacing(words: readonly LyricWord[], lineText: string): LyricWord[] {
  const expanded = words.flatMap((word) => {
    if (/^\s+$/u.test(word.text)) return [{ ...word, durationMs: 0 }]
    const leadingWhitespace = word.text.match(/^\s+/u)?.[0] ?? ''
    const trailingWhitespace = word.text.match(/\s+$/u)?.[0] ?? ''
    const contentStart = leadingWhitespace.length
    const contentEnd = Math.max(contentStart, word.text.length - trailingWhitespace.length)
    const result: LyricWord[] = []
    if (leadingWhitespace) result.push({ text: leadingWhitespace, startMs: word.startMs, durationMs: 0 })
    if (contentEnd > contentStart) result.push({ ...word, text: word.text.slice(contentStart, contentEnd) })
    if (trailingWhitespace) {
      result.push({ text: trailingWhitespace, startMs: word.startMs + Math.max(0, word.durationMs), durationMs: 0 })
    }
    return result.length > 0 ? result : [word]
  })

  const normalizedLine = lineText.trim().replace(/\s+/gu, ' ')
  const visibleIndices = expanded.map((word, index) => (word.text.trim() ? index : -1)).filter((index) => index >= 0)
  const insertSpaceAfter = new Set<number>()
  let cursor = 0
  visibleIndices.forEach((wordIndex, visibleIndex) => {
    const token = expanded[wordIndex]?.text.trim() ?? ''
    const tokenIndex = normalizedLine.indexOf(token, cursor)
    if (tokenIndex < 0) return
    const tokenEnd = tokenIndex + token.length
    const separator = normalizedLine.slice(tokenEnd).match(/^\s+/u)?.[0] ?? ''
    cursor = tokenEnd + separator.length
    const nextVisibleIndex = visibleIndices[visibleIndex + 1]
    if (!separator || nextVisibleIndex === undefined) return
    const alreadyHasWhitespace = expanded.slice(wordIndex + 1, nextVisibleIndex).some((word) => /^\s+$/u.test(word.text))
    if (!alreadyHasWhitespace) insertSpaceAfter.add(wordIndex)
  })

  return expanded.flatMap((word, index) =>
    insertSpaceAfter.has(index)
      ? [word, { text: ' ', startMs: word.startMs + Math.max(0, word.durationMs), durationMs: 0 }]
      : [word],
  )
}

/** 顺序归一化：起点单调不减、时长与下一词起点冲突时收缩、非法值兜底 */
export function normalizeSequentialTiming(words: readonly LyricWord[]): LyricWord[] {
  if (words.length === 0) return [...words]
  const visibleIndices = words.map((word, index) => (word.text.trim() ? index : -1)).filter((index) => index >= 0)
  if (visibleIndices.length === 0) return [...words]

  const starts: number[] = []
  visibleIndices.forEach((wordIndex, visibleIndex) => {
    const rawStart = Number.isFinite(words[wordIndex]?.startMs) ? Math.max(0, words[wordIndex]?.startMs ?? 0) : 0
    if (visibleIndex === 0) {
      starts.push(rawStart)
      return
    }
    const previousStart = starts[visibleIndex - 1] ?? 0
    const previousWord = words[visibleIndices[visibleIndex - 1] ?? 0]
    const previousDurationUsable = Number.isFinite(previousWord?.durationMs) && (previousWord?.durationMs ?? 0) > 8
    const minimumGapMs = rawStart <= previousStart || !previousDurationUsable ? FALLBACK_WORD_DURATION_MS : 1
    starts.push(rawStart >= previousStart + minimumGapMs ? rawStart : previousStart + minimumGapMs)
  })

  const normalized = words.map((word) => ({ ...word }))
  visibleIndices.forEach((wordIndex, visibleIndex) => {
    const word = words[wordIndex]
    const startTime = starts[visibleIndex] ?? 0
    const nextStart = starts[visibleIndex + 1]
    const rawDuration = Number.isFinite(word?.durationMs) && (word?.durationMs ?? 0) > 8 ? (word?.durationMs ?? 0) : FALLBACK_WORD_DURATION_MS
    const durationMs = nextStart !== undefined ? Math.max(1, Math.min(rawDuration, nextStart - startTime)) : Math.max(1, rawDuration)
    const target = normalized[wordIndex]
    if (target) {
      target.startMs = startTime
      target.durationMs = durationMs
    }
  })

  let previousEndMs = 0
  normalized.forEach((word) => {
    if (word.text.trim()) {
      previousEndMs = word.startMs + word.durationMs
    } else {
      word.startMs = previousEndMs
      word.durationMs = 0
    }
  })
  return normalized
}

/** 渲染前处理：括号补齐 → 间距修复 → 顺序归一化 */
export function prepareLineWords(line: LyricLine): LyricWord[] {
  return normalizeSequentialTiming(restoreWordSpacing(reconcileBoundaryParentheses(line.text, line.words), line.text))
}

/** 判定是否为真逐字行（≥2 个可见词且时间有效，或整行单图元） */
export function hasTrueWordTiming(line: LyricLine): boolean {
  const words = line.words.filter((word) => Boolean(word.text.trim()))
  const hasTimedWord = words.some(
    (word) => Number.isFinite(word.startMs) && Number.isFinite(word.durationMs) && word.durationMs > 0,
  )
  if (!hasTimedWord) return false
  return words.length > 1 || segmentGraphemes(line.text.trim()).length <= 1
}

/** 卡拉OK图元：逐字行按词展开为字符图元 */
export function buildTimedGlyphs(line: LyricLine): TimedLyricGlyph[] {
  if (!hasTrueWordTiming(line)) return []
  return prepareLineWords(line).flatMap((word, wordIndex) => {
    const glyphs = segmentGraphemes(word.text)
    if (glyphs.length === 0) return []
    const isWhitespaceWord = /^\s+$/u.test(word.text)
    const glyphDurationMs = isWhitespaceWord ? 0 : Math.max(0.001, word.durationMs) / glyphs.length
    return glyphs.map((text, glyphIndex) => ({
      text,
      startMs: word.startMs + glyphDurationMs * glyphIndex,
      endMs: word.startMs + glyphDurationMs * (glyphIndex + 1),
      wordIndex,
      glyphIndex,
      isWhitespace: /^\s+$/u.test(text),
    }))
  })
}

/** 无逐字数据时的渐进式图元（按行时长均分） */
export function buildProgressiveGlyphs(line: LyricLine, fallbackDurationMs?: number): TimedLyricGlyph[] {
  const timed = buildTimedGlyphs(line)
  if (timed.length > 0) return timed

  const glyphs = segmentGraphemes(line.text)
  const visibleCount = glyphs.filter((text) => !/^\s+$/u.test(text)).length
  if (visibleCount === 0 || line.durationMs <= 0) return []

  const totalMs = fallbackDurationMs ?? line.durationMs
  const glyphDurationMs = totalMs / visibleCount
  let visibleIndex = 0
  return glyphs.map((text, glyphIndex) => {
    const isWhitespace = /^\s+$/u.test(text)
    const startMs = line.startMs + glyphDurationMs * (isWhitespace ? visibleIndex : visibleIndex++)
    return { text, startMs, endMs: isWhitespace ? startMs : startMs + glyphDurationMs, wordIndex: glyphIndex, glyphIndex, isWhitespace }
  })
}

/** 便捷入口：解析结果 → 整篇图元序列 */
export function buildGlyphTimeline(parsed: TimedLyrics): TimedLyricGlyph[] {
  return parsed.lines.flatMap((line) => buildTimedGlyphs(line).length > 0 ? buildTimedGlyphs(line) : buildProgressiveGlyphs(line))
}
