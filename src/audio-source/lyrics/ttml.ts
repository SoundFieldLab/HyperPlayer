/**
 * TTML（Timed Text Markup Language，AMLL/Apple Music 方言）解析器。
 * 用受限的正则解析实现（不依赖 DOMParser，Node 与渲染进程均可用），
 * 覆盖子集：<p begin end ttm:agent>、<span begin end ttm:role>、
 * role = x-translation / x-roman / x-bg、ttm:agent 声明、itunes:leadingSilence。
 */
import type { LyricLine, LyricWord, TimedLyrics } from './types'

export interface TtmlAgent {
  id: string
  type: string
}

export interface TtmlParseResult extends TimedLyrics {
  agents?: TtmlAgent[]
  leadingSilenceMs?: number
}

/** 时间串：HH:MM:SS.mmm / MM:SS.mmm / 纯秒 / `秒,毫秒`（AMLL 方言）/ 毫秒后缀 */
function parseTime(raw: string): number {
  const value = raw.trim()
  if (value.endsWith('ms')) return Number.parseFloat(value) || 0
  if (/^\d+,\d+$/.test(value)) {
    const [seconds, ms] = value.split(',')
    return (Number.parseInt(seconds, 10) || 0) * 1000 + (Number.parseInt(ms, 10) || 0)
  }
  if (value.includes(':')) {
    const parts = value.split(':')
    const seconds =
      parts.length === 3
        ? Number.parseInt(parts[0] ?? '0', 10) * 3600 + Number.parseInt(parts[1] ?? '0', 10) * 60 + Number.parseFloat(parts[2] ?? '0')
        : Number.parseInt(parts[0] ?? '0', 10) * 60 + Number.parseFloat(parts[1] ?? '0')
    return seconds * 1000
  }
  return (Number.parseFloat(value) || 0) * 1000
}

function attrOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)
  return match?.[1]
}

export function parseTtml(raw: string): TtmlParseResult | null {
  if (!raw) return null

  const agents: TtmlAgent[] = []
  let leadingSilenceMs: number | undefined

  // 头部元数据：演唱者声明与前导静音
  for (const meta of raw.matchAll(/<(?:ttm:)?agent\b([^>]*)\/?>(?:([^<]*)<\/(?:ttm:)?agent>)?/g)) {
    const id = /(?:xml:)?id="([^"]*)"/.exec(meta[1])?.[1] ?? ''
    const type = /(?:^|\s)type="([^"]*)"/.exec(meta[1])?.[1] ?? 'other'
    if (id && !agents.some((agent) => agent.id === id)) agents.push({ id, type })
  }
  const silence = /leadingSilence[^>]*>([^<]+)</.exec(raw)?.[1]?.trim()
  if (silence) {
    const value = Number.parseFloat(silence)
    if (Number.isFinite(value)) {
      leadingSilenceMs = silence.endsWith('ms') ? Math.round(value) : silence.includes('.') ? Math.round(value * 1000) : Math.round(value)
    }
  }

  const lines: LyricLine[] = []
  for (const p of raw.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const openTag = p[1] ?? ''
    const inner = p[2] ?? ''
    const role = /ttm:role="([^"]*)"/.exec(openTag)?.[1]
    if (role === 'x-translation' || role === 'x-roman') continue

    const beginRaw = /(?:^|\s)begin="([^"]*)"/.exec(openTag)?.[1]
    const endRaw = /(?:^|\s)end="([^"]*)"/.exec(openTag)?.[1]
    if (!beginRaw || !endRaw) continue
    const lineStartMs = parseTime(beginRaw)
    const lineEndMs = parseTime(endRaw)
    const agent = /ttm:agent="([^"]*)"/.exec(openTag)?.[1]

    const words: LyricWord[] = []
    let translation = ''
    let roman = ''
    const plainText: string[] = []

    // 先剥出翻译/罗马音/背景和声 span，再按顺序解析主歌词词
    const segments = inner.split(/(<span\b[^>]*>[\s\S]*?<\/span>)/g)
    for (const segment of segments) {
      if (!segment) continue
      const spanMatch = /^<span\b([^>]*)>([\s\S]*?)<\/span>$/.exec(segment)
      if (!spanMatch) {
        plainText.push(segment)
        continue
      }
      const spanTag = spanMatch[1] ?? ''
      const spanInner = spanMatch[2] ?? ''
      const spanRole = /ttm:role="([^"]*)"/.exec(spanTag)?.[1]
      if (spanRole === 'x-translation') {
        translation = spanInner.replace(/<[^>]*>/g, '')
        continue
      }
      if (spanRole === 'x-roman') {
        roman = spanInner.replace(/<[^>]*>/g, '')
        continue
      }
      if (spanRole === 'x-bg') {
        // 背景和声：递归解析内嵌带时间的词，弱化渲染由上层决定
        for (const bg of spanInner.matchAll(/<span\b[^>]*\bbegin="([^"]*)"[^>]*\bend="([^"]*)"[^>]*>([^<]*)<\/span>/g)) {
          words.push({ text: bg[3] ?? '', startMs: parseTime(bg[1] ?? '0'), durationMs: parseTime(bg[2] ?? '0') - parseTime(bg[1] ?? '0') })
        }
        continue
      }
      const wordBegin = /(?:^|\s)begin="([^"]*)"/.exec(spanTag)?.[1]
      const wordEnd = /(?:^|\s)end="([^"]*)"/.exec(spanTag)?.[1]
      const text = spanInner.replace(/<[^>]*>/g, '')
      if (wordBegin && wordEnd && text) {
        words.push({ text, startMs: parseTime(wordBegin), durationMs: parseTime(wordEnd) - parseTime(wordBegin) })
      } else {
        plainText.push(text)
      }
    }

    let lineWords = words
    const plain = plainText.join('')
    if (lineWords.length === 0 && plain.trim()) {
      lineWords = [{ text: plain.trim(), startMs: lineStartMs, durationMs: lineEndMs - lineStartMs }]
    }
    if (lineWords.length === 0) continue

    lines.push({
      startMs: lineStartMs,
      durationMs: lineEndMs - lineStartMs,
      text: lineWords.map((word) => word.text).join('') + (plain.trim() && lineWords !== words ? plain : ''),
      words: lineWords,
      ...(translation ? { translation } : {}),
      ...(roman ? { roman } : {}),
      ...(agent ? { agent } : {}),
    } as LyricLine & { translation?: string; roman?: string; agent?: string })
  }

  if (lines.length === 0) return null
  return { lines, agents: agents.length > 0 ? agents : undefined, leadingSilenceMs }
}
