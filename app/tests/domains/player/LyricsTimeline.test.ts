import { describe, expect, it, vi } from 'vitest';
import { LyricsTimeline } from '../../../src/domains/player/LyricsTimeline';
import { parseLrc, parseLrcTimeTag } from '../../../src/domains/player/lyrics/lyricsTypes';
import { createFakeCacheStore } from '../../../src/infra/fakes';

const LRC = `[ti:test]
[00:01.00]第一句歌词
[00:03.50]第二句歌词
[00:06.00]第三句歌词`;

const YRC = `[00:01.00]<第 500><一 300><句 400><歌 300>
[00:03.50]<第 300><二 300><句 300>`;

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

  it('YRC 逐字扩展：解析为逐字轴（timingLevel=word）', () => {
    const parsed = parseLrc(YRC);
    expect(parsed.timingLevel).toBe('word');
    expect(parsed.format).toBe('yrc');
    const line0 = parsed.lines[0];
    expect(line0?.words).toHaveLength(4);
    expect(line0?.words?.[0]).toEqual({ word: '第', startTime: 0, duration: 500 });
    expect(line0?.words?.[1]).toEqual({ word: '一', startTime: 500, duration: 300 });
    expect(line0?.text).toBe('第一句歌');
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
