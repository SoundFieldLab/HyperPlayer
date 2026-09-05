/**
 * 歌词域类型（自 waveforge-lyrics 提取后按 HyperPlayer 令牌定义；字段语义与上游一致）。
 * 无 React 依赖；LyricsTimeline 与歌词渲染组件共享。
 */

/** 歌词行（兼容 waveforge musicApi 的 LyricLine 语义）。 */
export interface LyricLine {
  /** 行开始时间（毫秒）。 */
  time: number;
  text: string;
  /** 逐字歌词（YRC/TTML 才有）；缺省 = 无逐字时间，退化行级渐进填充。 */
  words?: LyricWord[];
  translation?: string;
  roman?: string;
  romanWords?: LyricWord[];
  /** Apple Music 对唱/多声部：ttm:agent id。 */
  agent?: string;
  agentName?: string;
}

/** 逐字时间（相对行开始，毫秒）。 */
export interface LyricWord {
  word: string;
  startTime: number;
  duration: number;
}

/** 逐字轴级别（UI-D26：只有 YRC 才做逐字；普通 LRC 不伪造逐字符节拍）。 */
export type LyricTimingLevel = 'word' | 'line';

export interface ParsedLyrics {
  lines: LyricLine[];
  /** 逐字轴级别判定。 */
  timingLevel: LyricTimingLevel;
  /** 原始格式来源。 */
  format: 'ttml' | 'lrc' | 'yrc' | 'plain';
}

/** LRC 时间标签解析（[mm:ss.xx] 或 [mm:ss]）。 */
export function parseLrcTimeTag(tag: string): number {
  const match = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/u.exec(tag);
  if (!match) return Number.NaN;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2] ?? 0);
  const fractionRaw = match[3] ?? '';
  const fraction = fractionRaw.length === 3 ? Number(fractionRaw) : Number(fractionRaw.padEnd(3, '0'));
  return minutes * 60_000 + seconds * 1000 + fraction;
}

/** 解析 LRC 文本（含逐字 YRC 扩展 [mm:ss.xx]<word 时长>，若存在）。 */
export function parseLrc(text: string): ParsedLyrics {
  const lines: LyricLine[] = [];
  let hasWordTiming = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    const tags = [...line.matchAll(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/gu)].map((m) => m[0]);
    if (tags.length === 0) continue;
    const time = parseLrcTimeTag(tags[0] as string);
    if (Number.isNaN(time)) continue;
    const rest = line.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/gu, '').trim();
    // YRC 逐字扩展：<字 时长ms> 序列（网易云逐字格式）。
    const words = parseYrcWords(rest);
    if (words.length > 0) hasWordTiming = true;
    lines.push({ time, text: words.length > 0 ? words.map((w) => w.word).join('') : rest, words: words.length > 0 ? words : undefined });
  }
  lines.sort((a, b) => a.time - b.time);
  return { lines, timingLevel: hasWordTiming ? 'word' : 'line', format: hasWordTiming ? 'yrc' : 'lrc' };
}

/** 解析网易云 YRC 逐字扩展：<字 时长>。 */
function parseYrcWords(text: string): LyricWord[] {
  const words: LyricWord[] = [];
  const re = /<([^<>\s]+)\s+(\d+)(?:,\s*(\d+))?>/gu;
  let cursor = 0;
  for (const match of text.matchAll(re)) {
    const word = match[1] ?? '';
    const duration = Number(match[2] ?? 0);
    if (!word) continue;
    words.push({ word, startTime: cursor, duration });
    cursor += duration;
  }
  return words;
}
