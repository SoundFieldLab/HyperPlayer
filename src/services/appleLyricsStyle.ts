/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 HyperPlayer，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple 风格歌词工具（对唱着色 / TTML → 播放时间轴）
 *
 * 本模块是 Apple Music **音源**移除后保留的歌词侧能力，全程纯本地：
 * 没有登录、没有令牌、没有任何网络请求。
 * 1. 对唱 / 多声部着色：TTML 的 ttm:agent → 演唱者配色（设置项 appleDuetColors）
 * 2. TTML（含多语言 localization 合并）→ LyricLine：逐字、翻译、罗马音、
 *    对唱 agent 与背景人声一并保留
 *
 * 逐字歌词的数据来源与 Apple 官方接口无关：网易云 / QQ 曲目由
 * musicApi.getAMLLTTMLLyrics 从 AMLL TTML DB 免 token 拉取。
 */
import type { LyricLine } from './musicApi'
import { parseTTML, type TTMLAgent } from '../utils/ttmlParser'

// ─────────────────────────── 设置 ───────────────────────────

export interface LyricDuetSettings {
  /** 对唱歌词按演唱者着色 */
  duetColors: boolean
}

/** 对唱着色默认开启（仅读本地开关，不依赖任何账号）。 */
export function getLyricDuetSettings(): LyricDuetSettings {
  return { duetColors: localStorage.getItem('appleDuetColors') !== 'false' }
}

// ─────────────────────────── TTML 本地化合并 ───────────────────────────

export interface AppleTtmlBundle {
  primary: string
  localizations: string[]
}

function normalizeLocaleCode(value: string): string {
  return value.toLowerCase().replace(/_/g, '-')
}

/**
 * 从 AMP 风格的 attributes（ttml + ttmlLocalizations）里挑选首选文档：
 * 按请求语言 → 同字系 → 简中 → 繁中 → 英文 排优先级，再以「逐字行数最多」为准。
 */
export function collectAppleTtml(attributes: any, settings: { lyricLang: string }): AppleTtmlBundle | null {
  const localizations = attributes?.ttmlLocalizations && typeof attributes.ttmlLocalizations === 'object'
    ? attributes.ttmlLocalizations as Record<string, unknown>
    : {}
  const requested = normalizeLocaleCode(settings.lyricLang)
  const requestedScript = requested.includes('hant') ? 'zh-hant' : requested.includes('hans') ? 'zh-hans' : requested.split('-').slice(0, 2).join('-')
  const entries = Object.entries(localizations)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
    .sort(([left], [right]) => {
      const rank = (code: string) => {
        const normalized = normalizeLocaleCode(code)
        if (normalized === requested) return 0
        if (normalized.startsWith(requestedScript)) return 1
        if (normalized.startsWith('zh-hans')) return 2
        if (normalized.startsWith('zh-hant')) return 3
        if (normalized.startsWith('en')) return 4
        return 5
      }
      return rank(left) - rank(right)
    })
  const values = entries.map(([, value]) => value)
  if (typeof attributes?.ttml === 'string' && attributes.ttml.trim()) values.push(attributes.ttml)
  const unique = values.filter((value, index) => values.indexOf(value) === index)
  if (unique.length === 0) return null

  let primary = unique[0]
  let bestPrimaryLines = -1
  for (const value of unique) {
    try {
      const primaryLines = parseTTML(value).lines.filter(line => line.words.length > 0).length
      if (primaryLines > bestPrimaryLines) {
        primary = value
        bestPrimaryLines = primaryLines
      }
    } catch { /* malformed candidate ignored */ }
  }
  return { primary, localizations: unique.filter(value => value !== primary) }
}

/** 把多份 localization 的翻译/罗马音按「行时间 + agent」合并回主文档。 */
export function mergeAppleTtmlBundle(bundle: AppleTtmlBundle): string {
  if (bundle.localizations.length === 0) return bundle.primary
  const primaryDoc = new DOMParser().parseFromString(bundle.primary, 'text/xml')
  const primaryParagraphs = Array.from(primaryDoc.getElementsByTagNameNS('*', 'p'))
    .filter(element => !['x-translation', 'x-roman'].includes(
      element.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || element.getAttribute('ttm:role') || '',
    ))
  const keyOf = (element: Element) => {
    const begin = element.getAttribute('begin') || ''
    const end = element.getAttribute('end') || ''
    const agent = element.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'agent') || element.getAttribute('ttm:agent') || ''
    return `${begin}|${end}|${agent}`
  }
  const byKey = new Map(primaryParagraphs.map(element => [keyOf(element), element]))
  for (const localization of bundle.localizations) {
    try {
      const doc = new DOMParser().parseFromString(localization, 'text/xml')
      for (const paragraph of Array.from(doc.getElementsByTagNameNS('*', 'p'))) {
        const role = paragraph.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || paragraph.getAttribute('ttm:role') || ''
        const target = byKey.get(keyOf(paragraph))
        if (!target) continue
        const appendAlternate = (source: Element, alternateRole: string) => {
          const wrapper = primaryDoc.createElementNS(target.namespaceURI, 'span')
          wrapper.setAttributeNS('http://www.w3.org/ns/ttml#metadata', 'ttm:role', alternateRole)
          const lang = source.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') || source.getAttribute('xml:lang')
          if (lang) wrapper.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', lang)
          const imported = primaryDoc.importNode(source, true)
          while (imported.firstChild) wrapper.appendChild(imported.firstChild)
          const text = wrapper.textContent?.trim()
          const duplicate = Array.from(target.children).some(child => {
            const childRole = child.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || child.getAttribute('ttm:role') || ''
            return childRole === alternateRole && child.textContent?.trim() === text
          })
          if (!duplicate) target.appendChild(wrapper)
        }
        if (role === 'x-translation' || role === 'x-roman') {
          appendAlternate(paragraph, role)
          continue
        }
        for (const child of Array.from(paragraph.children)) {
          const childRole = child.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || child.getAttribute('ttm:role') || ''
          if (childRole === 'x-translation' || childRole === 'x-roman') appendAlternate(child, childRole)
        }
      }
    } catch { /* malformed localization ignored */ }
  }
  return new XMLSerializer().serializeToString(primaryDoc)
}

// ─────────────────────────── TTML → LyricLine（含对唱） ───────────────────────────

export interface AppleLyricsResult {
  lyrics: LyricLine[]
  hasDuet: boolean
  agents: TTMLAgent[]
}

/**
 * 把 TTML 转成 HyperPlayer 时间轴。
 * - 行时间 = TTML 时间 − leadingSilence（前导静音整体平移）
 * - 词时间保持行内相对（毫秒）
 * - 对唱：line.agent = ttm:agent id，line.agentName 由艺人列表按声明顺序映射
 */
export function convertAppleTTMLToLyrics(
  ttmlText: string,
  artistNames?: string[],
): AppleLyricsResult {
  const parsed = parseTTML(ttmlText)
  const silenceMs = parsed.leadingSilenceMs ?? 0
  const agents = parsed.agents ?? []

  const agentNameOf = (id: string): string | undefined => {
    if (!artistNames || artistNames.length === 0) return undefined
    const index = agents.findIndex(agent => agent.id === id)
    if (index < 0) return undefined
    return artistNames[Math.min(index, artistNames.length - 1)]
  }

  const lyrics: LyricLine[] = parsed.lines
    .map(line => {
      const words = line.words.map(word => ({
        word: word.text,
        startTime: Math.max(0, word.startTime - line.startTime),
        duration: Math.max(0, word.endTime - word.startTime),
      }))
      const text = words.map(word => word.word).join('').trim()
      const lineTime = Math.max(0, line.startTime - silenceMs) / 1000
      const alternateTexts = line.alternateTexts?.map(alternate => ({
        role: alternate.role,
        type: alternate.type,
        language: alternate.language,
        lang: alternate.lang,
        text: alternate.text,
        agent: alternate.agent,
        time: Math.max(0, alternate.startTime - silenceMs) / 1000,
        endTime: Math.max(0, alternate.endTime - silenceMs) / 1000,
        words: alternate.words?.map(word => ({
          word: word.text,
          startTime: Math.max(0, word.startTime - alternate.startTime),
          duration: Math.max(0, word.endTime - word.startTime),
        })),
      }))
      const backgroundVocals = line.backgroundVocals?.map(vocal => ({
        time: Math.max(0, vocal.startTime - silenceMs) / 1000,
        endTime: Math.max(0, vocal.endTime - silenceMs) / 1000,
        text: vocal.text,
        words: vocal.words.map(word => ({
          word: word.text,
          startTime: Math.max(0, word.startTime - vocal.startTime),
          duration: Math.max(0, word.endTime - word.startTime),
        })),
        translation: vocal.translation,
        roman: vocal.roman || vocal.romanization,
        romanization: vocal.romanization || vocal.roman,
        agent: vocal.agent,
        agentId: vocal.agentId || vocal.agent,
        agentName: vocal.agent ? agentNameOf(vocal.agent) : undefined,
        alternateTexts: vocal.alternateTexts?.map(alternate => ({
          role: alternate.role,
          type: alternate.type,
          language: alternate.language,
          lang: alternate.lang,
          text: alternate.text,
          agent: alternate.agent,
        })),
      }))
      return {
        time: lineTime,
        endTime: Math.max(0, line.endTime - silenceMs) / 1000,
        text,
        words: words.length > 0 ? words : undefined,
        translation: line.translation?.trim() || undefined,
        roman: line.roman?.trim() || undefined,
        role: line.role,
        agent: line.agent || undefined,
        agentId: line.agent || undefined,
        agentName: line.agent ? agentNameOf(line.agent) : undefined,
        alternateTexts: alternateTexts?.length ? alternateTexts : undefined,
        backgroundVocals: backgroundVocals?.length ? backgroundVocals : undefined,
      }
    })
    .filter(line => line.text)
    .sort((a, b) => a.time - b.time)

  const hasDuet = agents.length >= 2 && lyrics.some(line => line.agent)
  return { lyrics, hasDuet, agents }
}

// ─────────────────────────── 对唱配色 ───────────────────────────

/** 演唱者调色板（Apple Music 风格：主唱保持高亮，副唱取不同色相） */
export const DUET_AGENT_COLORS = ['#ffffff', '#ff9f43', '#4dc9f6', '#ff6b81', '#a3e635', '#c084fc']

/**
 * 返回某演唱者（agent）的着色：
 * - 无对唱数据或主唱（第一个 agent）→ 使用默认白/主题色
 * - 其余演唱者 → 从调色板按索引取色
 */
export function getAgentTintColor(
  agentId: string | undefined,
  agentCount: number,
  dark: boolean,
  accentColor?: string,
  agentOrder?: string[],
): string | undefined {
  if (!agentId || agentCount < 2) return undefined
  const numeric = agentId.match(/(\d+)$/)?.[1]
  const index = numeric ? Math.max(0, Number(numeric) - 1) : Math.max(0, agentOrder?.indexOf(agentId) ?? 0)
  if (index === 0) return undefined
  const palette = dark
    ? DUET_AGENT_COLORS
    : ['#111114', '#e8682f', '#0f83c9', '#e0556d', '#4d7c0f', '#7c3aed']
  return palette[Math.min(index, palette.length - 1)]
}
