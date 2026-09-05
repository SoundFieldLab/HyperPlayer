/**
 * yrcParser —— 网易云 YRC 逐字歌词解析（真实格式）。
 *
 * HyperPlayer adaptations: 自 waveforge-netease/services/musicApi.ts 提取
 * （isYrcTimestampFragment / normalizeYrcWords / parseYrc），import 改写为本地
 * lyricsTypes；行时间单位统一为**毫秒**（上游为秒）。
 *
 * 真实格式（waveforge local-server.mjs:3345 注释）：
 *   [开始ms,持续ms](字开始ms,字持续ms,0)字(字开始ms,字持续ms,0)字...
 */
import type { LyricLine, LyricWord } from './lyricsTypes';

/** 判断是否为误匹配的时间戳碎片（纯数字/逗号/括号片段）。 */
const isYrcTimestampFragment = (value: string) => {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    /^[\d(),\s]+$/u.test(trimmed) &&
    /\d/u.test(trimmed) &&
    /,/u.test(trimmed)
  );
};

/** 规整逐字时间：空白词并入前一词结束点；无有效时长的片段按前后时间推断。 */
function normalizeYrcWords(words: LyricWord[]): LyricWord[] {
  const normalized: LyricWord[] = [];
  let previousEnd = 0;
  let index = 0;

  while (index < words.length) {
    const word = words[index] as LyricWord;
    if (/^\s+$/u.test(word.word)) {
      normalized.push({ ...word, startTime: previousEnd, duration: 0 });
      index += 1;
      continue;
    }

    if (word.duration > 0 && word.startTime >= 0) {
      const startTime = Math.max(0, word.startTime);
      normalized.push({ ...word, startTime });
      previousEnd = Math.max(previousEnd, startTime + word.duration);
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < words.length && !((words[index] as LyricWord).duration > 0 && (words[index] as LyricWord).startTime >= 0)) {
      index += 1;
    }
    const run = words.slice(runStart, index);
    const characterCount = Math.max(
      1,
      run.reduce((count, item) => count + (item.word.trim() ? Array.from(item.word).length : 0), 0),
    );
    const nextTimedStart = index < words.length ? Math.max(previousEnd, (words[index] as LyricWord).startTime) : null;
    const inferredDuration =
      nextTimedStart !== null && nextTimedStart > previousEnd
        ? nextTimedStart - previousEnd
        : Math.min(2400, Math.max(280, characterCount * 180));
    let elapsed = 0;

    run.forEach((item) => {
      if (/^\s+$/u.test(item.word)) {
        normalized.push({ ...item, startTime: previousEnd + elapsed, duration: 0 });
        return;
      }
      const itemCharacters = Math.max(1, Array.from(item.word).length);
      const duration = (inferredDuration * itemCharacters) / characterCount;
      normalized.push({ ...item, startTime: previousEnd + elapsed, duration });
      elapsed += duration;
    });
    previousEnd += inferredDuration;
  }

  return normalized;
}

/**
 * 解析 YRC 文本（网易云逐字歌词）为歌词行（时间单位：毫秒）。
 * 格式: [16210,3460](16210,670,0)还(16880,410,0)没...
 */
export function parseYrc(yrcText: string): LyricLine[] {
  if (!yrcText) return [];

  const lines = yrcText.split('\n');
  const result: LyricLine[] = [];

  for (const line of lines) {
    // 跳过 JSON 元数据行与空行
    if (line.trim().startsWith('{')) continue;
    if (!line.trim()) continue;

    const headerMatch = /^\[(\d+),(\d+)\]/.exec(line);
    if (!headerMatch) continue;

    const lineStartTimeMs = Number(headerMatch[1]); // 行开始绝对时间（毫秒）
    const contentAfterHeader = line.substring((headerMatch[0] as string).length);

    // 移除无时间戳的前缀文本（如 "词:"、"曲:" 等标签）
    const firstTimestampCheck = /\(\d+,\d+/.exec(contentAfterHeader);
    let content = contentAfterHeader;
    if (firstTimestampCheck && firstTimestampCheck.index > 0) {
      const prefixText = contentAfterHeader.substring(0, firstTimestampCheck.index).trim();
      if (/^[\u4e00-\u9fff]+[:：]\s*$/u.test(prefixText)) {
        content = contentAfterHeader.substring(firstTimestampCheck.index);
      }
    }

    // 两步法：先收集全部时间戳参数，再提取每个时间戳后的文本作为词
    const words: LyricWord[] = [];
    const timestampRegex = /\((\d+),(\d+)(?:,\d+)?\)/g;
    const timestamps: Array<{ startTime: number; duration: number; index: number; length: number }> = [];
    const firstTimestampMatch = timestampRegex.exec(content);
    const firstIndex = firstTimestampMatch ? firstTimestampMatch.index : -1;
    timestampRegex.lastIndex = 0;

    let tsMatch: RegExpExecArray | null;
    while ((tsMatch = timestampRegex.exec(content)) !== null) {
      timestamps.push({
        startTime: Number(tsMatch[1]) - lineStartTimeMs, // 相对行开始（毫秒）
        duration: Number(tsMatch[2]),
        index: tsMatch.index,
        length: tsMatch[0].length,
      });
    }

    // 第一个时间戳之前的文本（无时间戳前缀词）
    if (firstIndex > 0) {
      const prefixText = content.substring(0, firstIndex).trim();
      if (prefixText && !isYrcTimestampFragment(prefixText)) {
        const firstDuration = timestamps.length > 0 ? (timestamps[0] as { startTime: number }).startTime : 0;
        words.push({ word: prefixText, startTime: 0, duration: firstDuration });
      }
    }

    // 每个时间戳后的文本 = 词
    for (let i = 0; i < timestamps.length; i += 1) {
      const ts = timestamps[i] as { startTime: number; duration: number; index: number; length: number };
      const afterTimestamp = content.substring(ts.index + ts.length);
      const nextTs = timestamps[i + 1];
      const wordText = nextTs
        ? afterTimestamp.substring(0, nextTs.index - (ts.index + ts.length))
        : afterTimestamp;
      if (!wordText) continue;
      if (isYrcTimestampFragment(wordText)) continue;
      words.push({ word: wordText, startTime: ts.startTime, duration: ts.duration });
    }

    const normalizedWords = normalizeYrcWords(words);

    // 清理整行内容生成纯文本（移除时间戳与碎片）
    let fullText = content.replace(/\(\d+,\d+(?:,\d+)?\)/g, '');
    fullText = fullText.replace(/\d+,\d+\)/g, '');
    fullText = fullText.replace(/,\d+\)/g, '');
    fullText = fullText.replace(/\(\d+,/g, '');
    fullText = fullText.replace(/\(\d+$/g, '');
    const leftCount = (fullText.match(/\(/g) ?? []).length;
    const rightCount = (fullText.match(/\)/g) ?? []).length;
    if (leftCount !== rightCount) {
      fullText = fullText.replace(/[()]/g, '');
    }
    fullText = fullText.replace(/,+/g, '').trim().replace(/\s+/g, ' ');

    if (fullText) {
      result.push({
        time: lineStartTimeMs,
        text: fullText,
        words: normalizedWords.length > 0 ? normalizedWords : undefined,
      });
    }
  }
  return result;
}
