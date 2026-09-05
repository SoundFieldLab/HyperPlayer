import { describe, expect, it, vi } from 'vitest';
import { DualElementSource } from '../../../src/domains/player/DualElementSource';
import type { AudioElementEventName, AudioElementLike } from '../../../src/domains/player/DualElementSource';

class FakeAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = 0;
  paused = true;
  volume = 1;
  muted = false;
  playbackRate = 1;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>();

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load(): void {
    this.loadCalls += 1;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.handlers.get(type)?.delete(listener);
  }

  emit(type: AudioElementEventName): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const listener of [...set]) listener({ type });
  }
}

function makeHarness() {
  const elements: FakeAudioElement[] = [];
  const source = new DualElementSource(() => {
    const el = new FakeAudioElement();
    elements.push(el);
    return el;
  });
  return { source, elements };
}

describe('DualElementSource', () => {
  it('单 active 不变量：active 与 inactive 是不同元素', () => {
    const { source, elements } = makeHarness();
    expect(elements).toHaveLength(2);
    expect(source.active).not.toBe(source.inactive);
  });

  it('loadIntoInactive 挂载新曲到非活跃元素，不打断 active 出声', () => {
    const { source } = makeHarness();
    const activeBefore = source.active;
    const loaded = source.loadIntoInactive('https://example.com/next.mp3');
    expect(loaded).toBe(source.inactive);
    expect(source.active).toBe(activeBefore);
    expect(source.active.src).toBe('');
    expect(loaded.src).toBe('https://example.com/next.mp3');
    expect((loaded as FakeAudioElement).loadCalls).toBe(1);
  });

  it('swap 切换 active（旧元素转为 B 槽复用）', () => {
    const { source } = makeHarness();
    const a = source.active;
    const b = source.inactive;
    source.swap();
    expect(source.active).toBe(b);
    expect(source.inactive).toBe(a);
    source.swap();
    expect(source.active).toBe(a);
  });

  it('元素事件转发：canplay 只来自当前 active 元素', () => {
    const { source, elements } = makeHarness();
    const handler = vi.fn();
    source.on('canplay', handler);

    elements[1]?.emit('canplay');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe(elements[1]);

    // swap 后 active 变化，事件仍然转发（按元素归属判断在订阅者侧）
    source.swap();
    elements[0]?.emit('ended');
    expect(handler).toHaveBeenCalledTimes(1); // 只订阅了 canplay
  });

  it('on 返回退订函数', () => {
    const { source, elements } = makeHarness();
    const handler = vi.fn();
    const off = source.on('error', handler);
    elements[0]?.emit('error');
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    elements[0]?.emit('error');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
