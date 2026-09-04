// 歌词服务（D34 Q7）：WaveForge 歌词解析+渲染成套接入。
// 协议层歌词获取（neteaseService.getLyric）→ 解析 LRC/YRC → LyricsPayloadDto。
// 渲染组件由 app 侧直接使用 vendor/waveforge-lyrics 的 LyricsDisplay 等。

import type { BackendTrackRefDto, LyricsPayloadDto } from '../../bridge/contracts'
import { getLyric } from '../netease/neteaseService'

/** LRC 行：[mm:ss.xx] 文本；多时间戳同行展开 */
function parseLrc(lrc: string): Array<{ startMs: number; endMs: number; text: string }> {
  const lines: Array<{ startMs: number; endMs: number; text: string }> = []
  const pattern = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const rawLine of lrc.split('\n')) {
    const text = rawLine.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    const timestamps: number[] = []
    let match: RegExpExecArray | null
    pattern.lastIndex = 0
    while ((match = pattern.exec(rawLine)) !== null) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fractionRaw = match[3] ?? '0'
      const fraction = fractionRaw.length === 3 ? Number(fractionRaw) : Number(fractionRaw.padEnd(3, '0'))
      timestamps.push(minutes * 60_000 + seconds * 1000 + fraction)
    }
    for (const startMs of timestamps) {
      lines.push({ startMs, endMs: startMs, text })
    }
  }
  lines.sort((a, b) => a.startMs - b.startMs)
  for (let index = 0; index < lines.length - 1; index += 1) {
    lines[index].endMs = lines[index + 1].startMs
  }
  return lines
}

/** YRC 行：[行开始ms,行时长ms] (字开始ms,字时长ms,0)文本 ... */
function parseYrc(yrc: string): Array<{ startMs: number; endMs: number; text: string; words: Array<{ text: string; startMs: number; endMs: number }> }> {
  const lines: Array<{ startMs: number; endMs: number; text: string; words: Array<{ text: string; startMs: number; endMs: number }> }> = []
  const linePattern = /\[(\d+),(\d+)\](.*)/i
  const wordPattern = /\((\d+),(\d+),(\d+)\)([^()]*)/gi
  for (const rawLine of yrc.split('\n')) {
    const lineMatch = rawLine.match(linePattern)
    if (!lineMatch) continue
    const startMs = Number(lineMatch[1])
    const durationMs = Number(lineMatch[2])
    const payload = lineMatch[3]
    const words: Array<{ text: string; startMs: number; endMs: number }> = []
    let match: RegExpExecArray | null
    wordPattern.lastIndex = 0
    while ((match = wordPattern.exec(payload)) !== null) {
      words.push({
        text: match[4],
        startMs: startMs + Number(match[1]),
        endMs: startMs + Number(match[1]) + Number(match[2]),
      })
    }
    const text = words.map((word) => word.text).join('') || payload.trim()
    lines.push({ startMs, endMs: startMs + durationMs, text, words })
  }
  lines.sort((a, b) => a.startMs - b.startMs)
  return lines
}

export class LyricsService {
  async get(request: BackendTrackRefDto): Promise<LyricsPayloadDto> {
    if (request.source !== 'netease') {
      return { document: { lines: [] } }
    }
    const lyric = await getLyric(Number(request.id))
    const yrc = lyric.yrc?.lyric
    const lrc = lyric.lrc?.lyric ?? ''
    const translation = lyric.tlyric?.lyric ?? ''
    const translationMap = new Map<number, string>()
    for (const line of parseLrc(translation)) {
      translationMap.set(line.startMs, line.text)
    }

    if (yrc) {
      const lines = parseYrc(yrc)
      return {
        document: {
          lines: lines.map((line) => ({
            startMs: line.startMs,
            endMs: line.endMs,
            text: line.text,
            translation: translationMap.get(line.startMs),
            words: line.words,
          })),
        },
      }
    }

    const lines = parseLrc(lrc)
    return {
      document: {
        lines: lines.map((line) => ({
          startMs: line.startMs,
          endMs: line.endMs,
          text: line.text,
          translation: translationMap.get(line.startMs),
          words: [],
        })),
      },
    }
  }
}

export const lyricsService = new LyricsService()
