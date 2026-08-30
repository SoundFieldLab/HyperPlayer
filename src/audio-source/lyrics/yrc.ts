/**
 * YRC 逐字歌词解析（网易云逐字格式，兼容 QQ QRC 同构文本）：
 * 行头 `[行开始,行时长]`，随后若干 `(字开始,字时长[,0])文本`。
 * 解析行为：JSON 元数据行跳过、孤立标签前缀剔除、时间戳碎片过滤、
 * 无时间词串线性分摊、空白 token 保留但时长 0。时间统一为绝对毫秒。
 */
import type { LyricLine, LyricWord, TimedLyrics } from './types'

const YRC_HEADER = /^\[(\d+),(\d+)\]/
const YRC_TIMESTAMP = /\((\d+),(\d+)(?:,\d+)?\)/g
const LABEL_PREFIX = /^[\p{Script=Han}A-Za-z]+[:：]\s*$/u

function isTimestampFragment(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && /^[\d(),\s]+$/u.test(trimmed) && /\d/u.test(trimmed) && /,/u.test(trimmed)
}

function charCount(text: string): number {
  return Array.from(text.trim()).length
}

/** 无时间词串的时间分摊：区间线性分摊，否则按字符数估算 min(2400, max(280, n×180))ms */
function inferUntimedRun(run: LyricWord[], previousEndMs: number, nextTimedStartMs: number | null): number {
  const totalChars = Math.max(1, run.reduce((sum, word) => sum + charCount(word.text), 0))
  const inferredTotalMs =
    nextTimedStartMs !== null && nextTimedStartMs > previousEndMs
      ? nextTimedStartMs - previousEndMs
      : Math.min(2400, Math.max(280, totalChars * 180))
  let elapsedMs = 0
  for (const word of run) {
    const share = (inferredTotalMs * charCount(word.text)) / totalChars
    word.startMs = previousEndMs + elapsedMs
    word.durationMs = share
    elapsedMs += share
  }
  return previousEndMs + inferredTotalMs
}

export function parseYrc(raw: string): TimedLyrics | null {
  if (!raw) return null

  const lines: LyricLine[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('{')) continue

    const header = YRC_HEADER.exec(line)
    if (!header) continue
    const lineStartMs = Number(header[1])
    const lineDurationMs = Number(header[2])
    let content = line.slice(header[0].length)

    const firstTimestamp = /\(\d+,\d+/.exec(content)
    if (firstTimestamp && firstTimestamp.index > 0) {
      const prefix = content.slice(0, firstTimestamp.index).trim()
      if (LABEL_PREFIX.test(prefix)) content = content.slice(firstTimestamp.index)
    }

    YRC_TIMESTAMP.lastIndex = 0
    const timestamps: { startMs: number; durationMs: number; index: number; length: number }[] = []
    let match: RegExpExecArray | null
    while ((match = YRC_TIMESTAMP.exec(content)) !== null) {
      timestamps.push({
        startMs: Number(match[1]),
        durationMs: Number(match[2]),
        index: match.index,
        length: match[0].length,
      })
    }
    if (timestamps.length === 0) continue

    const words: LyricWord[] = []
    if (timestamps[0].index > 0) {
      const prefix = content.slice(0, timestamps[0].index).trim()
      if (prefix && !isTimestampFragment(prefix)) {
        words.push({
          text: prefix,
          startMs: lineStartMs,
          durationMs: timestamps[0].startMs - lineStartMs,
        })
      }
    }
    for (let i = 0; i < timestamps.length; i += 1) {
      const ts = timestamps[i]
      const after = content.slice(ts.index + ts.length)
      const next = timestamps[i + 1]
      const text = next ? after.slice(0, next.index - (ts.index + ts.length)) : after
      if (!text.trim() || isTimestampFragment(text)) continue
      words.push({ text, startMs: ts.startMs, durationMs: ts.durationMs })
    }

    let previousEndMs = lineStartMs
    let run: LyricWord[] = []
    for (const word of words) {
      if (/^\s*$/u.test(word.text)) {
        if (run.length > 0) {
          previousEndMs = inferUntimedRun(run, previousEndMs, word.startMs)
          run = []
        }
        word.startMs = previousEndMs
        word.durationMs = 0
        continue
      }
      if (word.durationMs > 0) {
        if (run.length > 0) {
          previousEndMs = inferUntimedRun(run, previousEndMs, word.startMs)
          run = []
        }
        previousEndMs = Math.max(previousEndMs, word.startMs + word.durationMs)
        continue
      }
      run.push(word)
    }
    if (run.length > 0) previousEndMs = inferUntimedRun(run, previousEndMs, null)

    lines.push({
      startMs: lineStartMs,
      durationMs: lineDurationMs,
      text: words.map((word) => word.text).join(''),
      words,
    })
  }

  return lines.length > 0 ? { lines } : null
}
