/** LRC 行级歌词解析：`[mm:ss.xx]` 标签（可多标签同行），元数据标签跳过。 */
import type { LyricLine, LyricWord, TimedLyrics } from './types'

const LRC_TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const LRC_METADATA = /^\[(ti|ar|al|by|offset|kana):/i

export function parseLrc(raw: string): TimedLyrics | null {
  if (!raw) return null

  const entries: { startMs: number; text: string }[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line || LRC_METADATA.test(line)) continue

    LRC_TIME_TAG.lastIndex = 0
    const starts: number[] = []
    let match: RegExpExecArray | null
    let lastTagEnd = 0
    while ((match = LRC_TIME_TAG.exec(line)) !== null) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fractionRaw = match[3] ?? '0'
      const fractionMs = Number(fractionRaw) * 10 ** (3 - fractionRaw.length)
      starts.push(minutes * 60_000 + seconds * 1000 + fractionMs)
      lastTagEnd = match.index + match[0].length
    }
    if (starts.length === 0) continue
    const text = line.slice(lastTagEnd).trim()
    for (const startMs of starts) entries.push({ startMs, text })
  }

  if (entries.length === 0) return null
  entries.sort((a, b) => a.startMs - b.startMs)

  const lines: LyricLine[] = entries.map((entry, index) => {
    const nextStartMs = entries[index + 1]?.startMs ?? entry.startMs
    const durationMs = Math.max(0, nextStartMs - entry.startMs)
    const word: LyricWord = { text: entry.text, startMs: entry.startMs, durationMs }
    return { startMs: entry.startMs, durationMs, text: entry.text, words: [word] }
  })

  return { lines }
}
