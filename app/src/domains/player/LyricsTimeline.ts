/**
 * LyricsTimeline —— 歌词解析/缓存/逐字轴（播放器架构.md §3.5 / §4.1）。
 *
 * - 解析：TTML/LRC/YRC → 逐字轴（waveforge-lyrics 提取：ttmlParser/lyricWordTiming）；
 * - 缓存：IndexedDB（infra idbCache；打开失败由 infra 降级内存）；
 * - 逐字索引：indexAt(position) 帧级调用 → 写 store.currentWordIndex（窄选择器）；
 * - UI-D26：只有 YRC/TTML 才有逐字时间；普通 LRC 退化行级渐进填充，不伪造逐字符节拍。
 */
import type { CacheStore } from '../../infra/idbCache';
import { parseLrc } from './lyrics/lyricsTypes';
import type { LyricLine, LyricTimingLevel, ParsedLyrics } from './lyrics/lyricsTypes';
import { parseTTML } from './lyrics/ttmlParser';
import type { TTMLLyric } from './lyrics/ttmlParser';

export interface LyricsSource {
  text: string;
  format: 'ttml' | 'lrc' | 'yrc';
}

export type LyricsFetcher = (trackId: string) => Promise<LyricsSource | null>;

interface FlatGlyph {
  lineIndex: number;
  glyphIndex: number;
  /** 绝对开始（ms）。 */
  start: number;
  /** 绝对结束（ms）。 */
  end: number;
}

export interface LyricsTimelineDeps {
  cache: CacheStore;
  /** 帧级写 store.currentWordIndex。 */
  onWordIndex?: (index: number) => void;
}

const CACHE_PREFIX = 'lyric:';

export class LyricsTimeline {
  private parsed: ParsedLyrics | null = null;
  private readonly glyphs: FlatGlyph[] = [];
  private readonly cache: CacheStore;
  private readonly onWordIndex: ((index: number) => void) | undefined;

  constructor(deps: LyricsTimelineDeps) {
    this.cache = deps.cache;
    this.onWordIndex = deps.onWordIndex;
  }

  get level(): LyricTimingLevel | null {
    return this.parsed?.timingLevel ?? null;
  }

  get lines(): readonly LyricLine[] {
    return this.parsed?.lines ?? [];
  }

  /** 获取并缓存歌词；返回解析结果（无歌词返回 null）。 */
  async load(trackId: string, fetcher: LyricsFetcher): Promise<ParsedLyrics | null> {
    const cacheKey = `${CACHE_PREFIX}${trackId}`;
    let source = await this.cache.get<LyricsSource>(cacheKey);
    if (!source) {
      source = await fetcher(trackId);
      if (source) {
        try {
          await this.cache.set(cacheKey, source);
        } catch {
          // 缓存失败不阻塞歌词显示
        }
      }
    }
    if (!source) {
      this.clear();
      return null;
    }
    this.parsed = parseLyricsSource(source);
    this.rebuildGlyphs();
    return this.parsed;
  }

  /** 帧级调用：给定播放位置（秒）→ 当前逐字索引（-1 = 无歌词/未开始）。 */
  indexAt(positionSeconds: number): number {
    const positionMs = positionSeconds * 1000;
    if (this.glyphs.length === 0) return -1;
    // 二分：最后一个 start <= positionMs 的字。
    let lo = 0;
    let hi = this.glyphs.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const glyph = this.glyphs[mid] as FlatGlyph;
      if (glyph.start <= positionMs) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const index = result;
    this.onWordIndex?.(index);
    return index;
  }

  clear(): void {
    this.parsed = null;
    this.glyphs.length = 0;
  }

  private rebuildGlyphs(): void {
    this.glyphs.length = 0;
    const lines = this.parsed?.lines ?? [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] as LyricLine;
      if (this.parsed?.timingLevel === 'word' && line.words && line.words.length > 0) {
        let cursor = line.time;
        for (const word of line.words) {
          const start = line.time + word.startTime;
          const end = line.time + word.startTime + word.duration;
          this.glyphs.push({ lineIndex, glyphIndex: this.glyphs.length, start, end: Math.max(end, start + 1) });
          cursor = end;
        }
        void cursor;
      } else {
        // 行级：整行一个字块（行级渐进填充由渲染层做）。
        this.glyphs.push({ lineIndex, glyphIndex: this.glyphs.length, start: line.time, end: line.time + 1 });
      }
    }
  }
}

/** 解析 TTML/LRC/YRC 文本为统一逐字轴（TTML 有逐字时间；LRC 无则行级）。 */
export function parseLyricsSource(source: LyricsSource): ParsedLyrics {
  if (source.format === 'ttml') {
    try {
      const ttml = parseTTML(source.text);
      return ttmlToParsed(ttml);
    } catch {
      return parseLrc(source.text);
    }
  }
  return parseLrc(source.text);
}

function ttmlToParsed(ttml: TTMLLyric): ParsedLyrics {
  const lines: LyricLine[] = ttml.lines.map((line) => ({
    time: line.startTime,
    text: line.words.map((w) => w.text).join(''),
    words: line.words.map((w) => ({
      word: w.text,
      startTime: Math.max(0, w.startTime - line.startTime),
      duration: Math.max(1, w.endTime - w.startTime),
    })),
    translation: line.translation,
    roman: line.roman,
    agent: line.agent,
  }));
  return { lines, timingLevel: 'word', format: 'ttml' };
}
