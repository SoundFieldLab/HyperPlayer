import { describe, expect, it } from 'vitest';
import { QueueController } from '../../../src/domains/player/QueueController';
import type { QueueItem } from '../../../src/domains/player/types';

function track(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    title: `Track ${id}`,
    source: 'netease',
    entitlement: 'free',
    cacheStatus: 'none',
    contextId: 'ctx-a',
    ...overrides,
  };
}

function ctx(ids: string[]): QueueItem[] {
  return ids.map((id) => track(id));
}

describe('QueueController', () => {
  it('playNow：置当前曲、记录播放历史；upNext 为空', () => {
    const q = new QueueController();
    q.playNow(track('a'), { context: ctx(['a', 'b']) });
    expect(q.snapshot.current?.id).toBe('a');
    expect(q.snapshot.pointer).toBe(0);
    expect(q.snapshot.contextId).toBe('ctx-a');
    expect(q.snapshot.history).toEqual(['a']);
  });

  it('playNow 换上下文默认保留临时区（UI-D43）；可显式关闭', () => {
    const q = new QueueController();
    q.playNow(track('a'), { context: ctx(['a', 'b']) });
    q.playNext(track('x'));
    expect(q.snapshot.upNext).toHaveLength(1);

    // 换上下文：upNext 保留
    q.playNow(track('c'), { context: [track('c', { contextId: 'ctx-b' }), track('d', { contextId: 'ctx-b' })] });
    expect(q.snapshot.contextId).toBe('ctx-b');
    expect(q.snapshot.upNext).toHaveLength(1);

    // 显式 replaceContext=false：不替换上下文
    q.playNow(track('e'), { context: ctx(['e']), replaceContext: false });
    expect(q.snapshot.contextId).toBe('ctx-b');
  });

  it('playNext 插入临时区头部；next() 优先弹出并自动移除（播完删除）', () => {
    const q = new QueueController();
    q.playNow(track('a'), { context: ctx(['a', 'b', 'c']) });
    q.playNext(track('x'));
    q.playNext(track('y'));
    expect(q.snapshot.upNext.map((t) => t.id)).toEqual(['y', 'x']);

    expect(q.next()?.id).toBe('y');
    expect(q.snapshot.upNext.map((t) => t.id)).toEqual(['x']);
    expect(q.next()?.id).toBe('x');
    expect(q.snapshot.upNext).toHaveLength(0);
  });

  it('next() 顺序模式：推进指针；到尾返回 null（停止）', () => {
    const q = new QueueController();
    q.playNow(track('a'), { context: ctx(['a', 'b']) });
    expect(q.next()?.id).toBe('b');
    expect(q.snapshot.pointer).toBe(1);
    expect(q.next()).toBeNull();
  });

  it('next() 列表循环：到尾回绕到首项', () => {
    const q = new QueueController();
    q.setMode('loop');
    q.playNow(track('a'), { context: ctx(['a', 'b']) });
    expect(q.next()?.id).toBe('b');
    expect(q.next()?.id).toBe('a');
  });

  it('next() 单曲循环：只循环当前曲；手动 next 可打破循环（UI-D44）', () => {
    const q = new QueueController();
    q.setMode('single');
    q.playNow(track('a'), { context: ctx(['a', 'b']) });
    expect(q.next()?.id).toBe('a');
    expect(q.next()?.id).toBe('a');
    // 手动 playNext 插入临时区 → 打破单曲循环
    q.playNext(track('x'));
    expect(q.next()?.id).toBe('x');
  });

  it('随机模式：稳定洗牌序列（注入 random），循环回绕，upNext 永不参与洗牌', () => {
    const q = new QueueController({ random: () => 0.5 });
    q.playNow(track('a'), { context: ctx(['a', 'b', 'c', 'd']) });
    q.setMode('shuffle');
    // 稳定序列从当前曲开始
    expect(q.snapshot.shuffle[0]).toBe('a');
    const sequence = [...q.snapshot.shuffle];
    expect(new Set(sequence)).toEqual(new Set(['a', 'b', 'c', 'd']));

    const played: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = q.next();
      played.push(next?.id ?? 'null');
    }
    expect(played).toEqual(sequence.slice(1).concat([sequence[0] as string])); // 循环回绕
    // upNext 插队仍优先
    q.playNext(track('z'));
    expect(q.next()?.id).toBe('z');
  });

  it('prev()：按实际播放历史返回上一首（不重抽）', () => {
    const q = new QueueController({ random: () => 0.5 });
    q.playNow(track('a'), { context: ctx(['a', 'b', 'c', 'd']) });
    q.setMode('shuffle');
    const sequence = [...q.snapshot.shuffle];
    q.next(); // sequence[1]
    q.next(); // sequence[2]
    expect(q.snapshot.current?.id).toBe(sequence[2]);
    const prev = q.prev();
    expect(prev?.id).toBe(sequence[1]);
    expect(q.snapshot.current?.id).toBe(sequence[1]);
  });

  it('clearNext 不动上下文；clearAll 独立清空（保留播放模式）', () => {
    const q = new QueueController();
    q.playNow(track('a'), { context: ctx(['a', 'b', 'c']) });
    q.playNext(track('x'));
    q.setMode('shuffle');
    q.clearNext();
    expect(q.snapshot.upNext).toHaveLength(0);
    expect(q.snapshot.context).toHaveLength(3);

    q.clearAll();
    expect(q.snapshot.current).toBeNull();
    expect(q.snapshot.context).toHaveLength(0);
    expect(q.snapshot.upNext).toHaveLength(0);
    expect(q.snapshot.mode).toBe('shuffle');
  });

  it('remove 从两区移除；move 上下文内拖拽', () => {
    const q = new QueueController();
    q.playNow(track('a'), { context: ctx(['a', 'b', 'c']) });
    q.playNext(track('x'));
    q.remove('x');
    expect(q.snapshot.upNext).toHaveLength(0);
    q.remove('b');
    expect(q.snapshot.context.map((t) => t.id)).toEqual(['a', 'c']);

    q.move('c', 0);
    expect(q.snapshot.context.map((t) => t.id)).toEqual(['c', 'a']);
  });

  it('cycleMode 四态循环：顺序→列表循环→单曲循环→随机→顺序', () => {
    const q = new QueueController();
    expect(q.snapshot.mode).toBe('sequence');
    q.cycleMode();
    expect(q.snapshot.mode).toBe('loop');
    q.cycleMode();
    expect(q.snapshot.mode).toBe('single');
    q.cycleMode();
    expect(q.snapshot.mode).toBe('shuffle');
    q.cycleMode();
    expect(q.snapshot.mode).toBe('sequence');
  });

  it('peekNext：临时区首项 > 上下文下一曲（不推进状态）', () => {
    const q = new QueueController();
    q.playNow(track('a'), { context: ctx(['a', 'b', 'c']) });
    expect(q.peekNext()?.id).toBe('b');
    q.playNext(track('x'));
    expect(q.peekNext()?.id).toBe('x');
    // 不推进：current 未变
    expect(q.snapshot.current?.id).toBe('a');
  });

  it('subscribe 快照变更通知', () => {
    const q = new QueueController();
    const seen: string[] = [];
    q.subscribe((s) => seen.push(s.current?.id ?? 'null'));
    q.playNow(track('a'), { context: ctx(['a']) });
    q.next(); // 到尾无下一首：状态不变，不通知
    expect(seen).toEqual(['a']);
  });
});
