import { describe, expect, it, vi } from 'vitest';
import { LyricsTimeline } from '../../../src/domains/player/LyricsTimeline';
import { parseLrc, parseLrcTimeTag } from '../../../src/domains/player/lyrics/lyricsTypes';
import { createFakeCacheStore } from '../../../src/infra/fakes';

const LRC = `[ti:test]
[00:01.00]第一句歌词
[00:03.50]第二句歌词
[00:06.00]第三句歌词`;

const YRC = `[1000,2000](1000,500,0)第(1500,300,0)一(1800,400,0)句(2200,300,0)歌
[3500,1500](3500,300,0)第(3800,300,0)二(4100,300,0)句`;

describe('lyrics 解析（parseLrc / parseLrcTimeTag）', () => {
  it('parseLrcTimeTag 支持 mm:ss 与 mm:ss.xx', () => {
    expect(parseLrcTimeTag('[01:05]')).toBe(65_000);
    expect(parseLrcTimeTag('[00:01.50]')).toBe(1500);
    expect(parseLrcTimeTag('[00:01.5]')).toBe(1500);
  });

  it('普通 LRC：行级（不伪造逐字符节拍，UI-D26）', () => {
    const parsed = parseLrc(LRC);
    expect(parsed.timingLevel).toBe('line');
    expect(parsed.format).toBe('lrc');
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[0]?.time).toBe(1000);
    expect(parsed.lines[0]?.text).toBe('第一句歌词');
  });

  it('YRC 逐字（真实格式 [ms,ms](start,dura,0)字）：解析为逐字轴（timingLevel=word）', () => {
    const parsed = parseLrc(YRC);
    expect(parsed.timingLevel).toBe('word');
    expect(parsed.format).toBe('yrc');
    const line0 = parsed.lines[0];
    expect(line0?.words).toHaveLength(4);
    expect(line0?.words?.[0]).toEqual({ word: '第', startTime: 0, duration: 500 });
    expect(line0?.words?.[1]).toEqual({ word: '一', startTime: 500, duration: 300 });
    expect(line0?.text).toBe('第一句歌'); // 时间戳已清理，无残留
    expect(parsed.lines[0]?.time).toBe(1000); // 行时间毫秒
  });

  it('YRC 前缀标签（词:）不污染逐字轴', () => {
    const parsed = parseLrc(`[5000,1000]词:(5000,500,0)前(5500,500,0)言`);
    expect(parsed.lines[0]?.words).toHaveLength(2);
    expect(parsed.lines[0]?.words?.[0]?.word).toBe('前');
    expect(parsed.lines[0]?.text).toBe('前言');
  });

  it('[t:]/[r:] 独立行辅助轨：同时间合并进主行（后端补充规划 #11）', () => {
    const parsed = parseLrc(`[00:01.00]第一句
[t:00:01.00]The first line
[r:00:01.00]Dai ichi kyō
[00:03.50]第二句
[r:00:03.50]Dai ni kyō`);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toMatchObject({ time: 1000, text: '第一句', translation: 'The first line', roman: 'Dai ichi kyō' });
    expect(parsed.lines[1]).toMatchObject({ time: 3500, text: '第二句', roman: 'Dai ni kyō' });
  });

  it('行内 [t:译文][r:罗马音] 标签：文本剥离并挂载（后端补充规划 #11）', () => {
    const parsed = parseLrc(`[00:01.00]第一句[t:译文一][r:Ro-1]`);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({ text: '第一句', translation: '译文一', roman: 'Ro-1' });
  });

  it('[offset:±ms] 全局偏移：时间戳整体平移（LRC 规范）', () => {
    const parsed = parseLrc(`[offset:-500]
[00:01.00]第一句
[00:03.00]第二句`);
    expect(parsed.lines.map((l) => l.time)).toEqual([500, 2500]);
  });

  it('无匹配主行的 [t:]/[r:] 辅助行不参与渲染', () => {
    const parsed = parseLrc(`[00:01.00]第一句
[t:00:02.00]悬空译文`);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]?.translation).toBeUndefined();
  });
});

describe('LyricsTimeline', () => {
  it('indexAt：帧级返回当前逐字索引（YRC 逐字轴，二分查找）', async () => {
    const onWordIndex = vi.fn();
    const timeline = new LyricsTimeline({ cache: createFakeCacheStore(), onWordIndex });
    await timeline.load('t1', async () => ({ text: YRC, format: 'yrc' }));

    expect(timeline.level).toBe('word');
    expect(timeline.indexAt(0.9)).toBe(-1); // 第一行开始前
    expect(timeline.indexAt(1.0)).toBe(0); // 第
    expect(timeline.indexAt(1.5)).toBe(1); // 一
    expect(timeline.indexAt(2.0)).toBe(2); // 句
    expect(timeline.indexAt(3.6)).toBe(4); // 第二行第一个字（行 1 的第 0 字，全轴索引 4）
    expect(onWordIndex).toHaveBeenLastCalledWith(4);
  });

  it('行级 LRC：indexAt 返回行首索引（行级渐进由渲染层做）', async () => {
    const timeline = new LyricsTimeline({ cache: createFakeCacheStore() });
    await timeline.load('t1', async () => ({ text: LRC, format: 'lrc' }));
    expect(timeline.level).toBe('line');
    expect(timeline.indexAt(1.5)).toBe(0);
    expect(timeline.indexAt(4.0)).toBe(1);
  });

  it('setOffsetMs：正偏移 = 歌词提前（indexAt 查询前移，后端补充规划 #12）', async () => {
    const timeline = new LyricsTimeline({ cache: createFakeCacheStore() });
    await timeline.load('t1', async () => ({ text: LRC, format: 'lrc' }));
    timeline.setOffsetMs(500);
    expect(timeline.indexAt(0.9)).toBe(0); // 原本 1.0s 的行，提前 500ms 命中
    expect(timeline.indexAt(3.4)).toBe(1); // 原本 3.5s 的行
    timeline.setOffsetMs(-1000);
    expect(timeline.indexAt(0.9)).toBe(-1); // 推迟后不命中
    expect(timeline.indexAt(2.0)).toBe(0);
  });

  it('IndexedDB 缓存：二次加载不调 fetcher', async () => {
    const cache = createFakeCacheStore();
    const fetcher = vi.fn(async () => ({ text: LRC, format: 'lrc' as const }));
    const timeline = new LyricsTimeline({ cache });
    await timeline.load('t1', fetcher);
    await timeline.load('t1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('无歌词：返回 null 并清空', async () => {
    const timeline = new LyricsTimeline({ cache: createFakeCacheStore() });
    const parsed = await timeline.load('t1', async () => null);
    expect(parsed).toBeNull();
    expect(timeline.level).toBeNull();
    expect(timeline.indexAt(0)).toBe(-1);
  });

  it('clear 重置歌词与索引', async () => {
    const timeline = new LyricsTimeline({ cache: createFakeCacheStore() });
    await timeline.load('t1', async () => ({ text: LRC, format: 'lrc' }));
    timeline.clear();
    expect(timeline.level).toBeNull();
    expect(timeline.lines).toHaveLength(0);
  });
});
