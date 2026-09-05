/**
 * 歌词域类型（自 waveforge-lyrics 提取后按 HyperPlayer 令牌定义；字段语义与上游一致）。
 * 无 React 依赖；LyricsTimeline 与歌词渲染组件共享。
 */
import { parseYrc } from './yrcParser';

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

/** 解析 LRC / YRC 文本。YRC（网易云逐字格式 [ms,ms](start,dura,0)字…）由 yrcParser 处理。 */
export function parseLrc(text: string): ParsedLyrics {
  // 网易云 YRC 逐字格式：[开始ms,持续ms](字开始ms,字持续ms,0)字...
  if (hasYrcFormat(text)) {
    const lines = parseYrc(text);
    return { lines, timingLevel: 'word', format: 'yrc' };
  }

  // 普通 LRC：[mm:ss.xx] 行级（不伪造逐字符节拍，UI-D26）
  const lines: LyricLine[] = [];
  /** [t:]/[r:] 独立行的辅助轨条目（网易云翻译/罗马音轨，按同时间合并进主行）。 */
  const aux: Array<{ time: number; kind: 't' | 'r'; text: string }> = [];
  /** [offset:±ms] 全局时间偏移（LRC 规范：正值 = 时间戳整体增加）。 */
  let metaOffset = 0;

  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;

    const offsetMatch = /^\[offset:([+-]?\d+)\]\s*$/iu.exec(line);
    if (offsetMatch) {
      metaOffset += Number(offsetMatch[1] ?? 0);
      continue;
    }

    const auxMatch = /^\[([tTrR]):(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]([\s\S]*)$/u.exec(line);
    if (auxMatch) {
      const time = parseLrcTimeTag(`[${auxMatch[2] ?? ''}]`);
      if (!Number.isNaN(time)) {
        aux.push({
          time: Math.max(0, time + metaOffset),
          kind: (auxMatch[1] ?? '').toLowerCase() as 't' | 'r',
          text: (auxMatch[3] ?? '').trim(),
        });
      }
      continue;
    }

    const tags = [...line.matchAll(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/gu)].map((m) => m[0]);
    if (tags.length === 0) continue;
    const time = parseLrcTimeTag(tags[0] as string);
    if (Number.isNaN(time)) continue;
    const rest = line.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/gu, '');
    // 行内辅助标签：[t:译文] / [r:罗马音]
    const inlineT = /\[[tT]:([^\]]*)\]/u.exec(rest);
    const inlineR = /\[[rR]:([^\]]*)\]/u.exec(rest);
    const entry: LyricLine = {
      time: Math.max(0, time + metaOffset),
      text: rest.replace(/\[[tTrR]:[^\]]*\]/gu, '').trim(),
    };
    if (inlineT?.[1] !== undefined) entry.translation = inlineT[1];
    if (inlineR?.[1] !== undefined) entry.roman = inlineR[1];
    lines.push(entry);
  }

  lines.sort((a, b) => a.time - b.time);
  // 辅助轨合并：与主行同时间的挂 translation/roman；无匹配的辅助行不参与渲染。
  const byTime = new Map<number, LyricLine>();
  for (const entry of lines) if (!byTime.has(entry.time)) byTime.set(entry.time, entry);
  for (const item of aux) {
    const target = byTime.get(item.time);
    if (!target) continue;
    if (item.kind === 't') target.translation = item.text;
    else target.roman = item.text;
  }
  return { lines, timingLevel: 'line', format: 'lrc' };
}

/** YRC 格式检测：行头 [数字,数字] 且内容含 (数字,数字) 时间戳。 */
export function hasYrcFormat(text: string): boolean {
  return /^\[\d+,\d+\]/mu.test(text) && /\(\d+,\d+[^)]*\)/mu.test(text);
}
