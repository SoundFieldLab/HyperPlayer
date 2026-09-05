import { describe, expect, it, vi } from 'vitest';
import { PlayerController } from '../../src/services/PlayerController';
import { PlaybackStateMachine } from '../../src/domains/player/PlaybackStateMachine';
import { QueueController } from '../../src/domains/player/QueueController';
import { DualElementSource } from '../../src/domains/player/DualElementSource';
import type { AudioElementEventName, AudioElementLike } from '../../src/domains/player/DualElementSource';
import type { AudioEngineController } from '../../src/domains/player/AudioEngineController';
import type { QueueItem, ResolvedSource } from '../../src/domains/player/types';
import { createNullLogger } from '../../src/shared/logger';

class FakeAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = 180;
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface PlayerHarness {
  controller: PlayerController;
  elements: DualElementSource;
  machine: PlaybackStateMachine;
  queue: QueueController;
  resolveSource: ReturnType<typeof vi.fn>;
  prefetch: ReturnType<typeof vi.fn>;
  statuses: string[];
  audio: { ensureContext: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
}

function makePlayer(): PlayerHarness {
  const elements = new DualElementSource(() => new FakeAudioElement());
  const machine = new PlaybackStateMachine({ logger: createNullLogger() });
  const queue = new QueueController();
  const statuses: string[] = [];
  machine.subscribe((s) => statuses.push(s.status));
  const resolveSource = vi.fn(async (_track: QueueItem): Promise<ResolvedSource> => {
    return { url: `https://cdn.example.com/${_track.id}.mp3`, kind: 'stream' };
  });
  const prefetch = vi.fn(async () => {});
  const audio = {
    ensureContext: vi.fn(() => ({}) as unknown as AudioContext),
    resume: vi.fn(async () => {}),
  };
  const controller = new PlayerController({
    stateMachine: machine,
    elements,
    queue,
    audio: audio as unknown as AudioEngineController,
    resolveSource,
    prefetch,
    logger: createNullLogger(),
  });
  return { controller, elements, machine, queue, resolveSource, prefetch, statuses, audio };
}

describe('PlayerController 完整事件流（fake 环境）', () => {
  it('LOAD→resolving→buffering→playing→ended→队列推进→预取', async () => {
    const { controller, elements, machine, queue, prefetch } = makePlayer();
    const t1 = track('t1');
    const t2 = track('t2');
    const t3 = track('t3');

    const start = controller.playNow(t1, { context: [t1, t2, t3], autoplay: true });
    expect(machine.snapshot.status).toBe('resolving');
    await start;
    expect(machine.snapshot.status).toBe('buffering'); // resolveSource → RESOLVED

    // 新元素 canplay → 切换 active → CAN_PLAY → 自动播放
    const pending1 = elements.inactive;
    (pending1 as FakeAudioElement).emit('canplay');
    await flush();
    expect(machine.snapshot.status).toBe('playing');
    expect(queue.snapshot.current?.id).toBe('t1');
    expect(elements.active).toBe(pending1);

    // 预取：t1 播放中 → 下一曲 t2
    await flush();
    expect(prefetch).toHaveBeenCalled();
    expect(prefetch.mock.calls[0]?.[0]?.id).toBe('t2');

    // ENDED → 队列推进 → t2 解析
    (elements.active as FakeAudioElement).emit('ended');
    expect(machine.snapshot.status).toBe('resolving'); // LOAD(t2) 已同步派发
    expect(queue.snapshot.current?.id).toBe('t2');
    await flush();
    expect(machine.snapshot.status).toBe('buffering');

    // t2 canplay → 自动播放 + 预取 t3
    const pending2 = elements.inactive;
    (pending2 as FakeAudioElement).emit('canplay');
    await flush();
    expect(machine.snapshot.status).toBe('playing');
    await flush();
    expect(prefetch.mock.calls.at(-1)?.[0]?.id).toBe('t3');
  });

  it('resolveSource 失败 → error(SOURCE_RESOLVE_FAIL)，错误不整队清空且自动跳下一首', async () => {
    const { controller, machine, queue, resolveSource, statuses } = makePlayer();
    const errors: string[] = [];
    machine.subscribe((s) => {
      if (s.error) errors.push(s.error.taxonomy);
    });
    resolveSource.mockRejectedValueOnce(new Error('network down'));
    const t1 = track('t1');
    const t2 = track('t2');
    const t3 = track('t3');

    await controller.playNow(t1, { context: [t1, t2, t3], autoplay: true });
    await flush();
    // error 是瞬态：autoSkip 立即推进下一首；错误状态与 taxonomy 曾被进入
    expect(statuses).toContain('error');
    expect(errors).toContain('SOURCE_RESOLVE_FAIL');
    expect(machine.snapshot.status).toBe('buffering');
    // 错误不整队清空：context 仍在
    expect(queue.snapshot.context).toHaveLength(3);
    expect(queue.snapshot.current?.id).toBe('t2');
  });

  it('resolveSource 失败且 autoSkipOnError 关闭 → 停在 error', async () => {
    const { controller, machine, resolveSource } = makePlayer();
    resolveSource.mockRejectedValueOnce(new Error('network down'));
    const controller2 = new PlayerController({
      stateMachine: machine,
      elements: new DualElementSource(() => new FakeAudioElement()),
      queue: new QueueController(),
      audio: { ensureContext: vi.fn(), resume: vi.fn() } as unknown as AudioEngineController,
      resolveSource,
      autoSkipOnError: () => false,
      logger: createNullLogger(),
    });
    await controller2.playNow(track('t1'), { context: [track('t1'), track('t2')], autoplay: true });
    await flush();
    expect(machine.snapshot.status).toBe('error');
    void controller;
  });

  it('playNext 插入临时区并立即播放（upNext 优先）', async () => {
    const { controller, elements, machine, queue } = makePlayer();
    await controller.playNow(track('t1'), { context: [track('t1'), track('t2')], autoplay: true });
    const pending1 = elements.inactive;
    (pending1 as FakeAudioElement).emit('canplay');
    await flush();

    const playPromise = controller.playNext(track('x'));
    expect(queue.snapshot.upNext.map((t) => t.id)).toEqual(['x']);
    expect(machine.snapshot.status).toBe('resolving');
    await playPromise;
    await flush();
    expect(machine.snapshot.status).toBe('buffering');
  });

  it('pause → 元素暂停；元素 pause 事件 → ready', async () => {
    const { controller, elements, machine } = makePlayer();
    await controller.playNow(track('t1'), { context: [track('t1')], autoplay: true });
    const pending1 = elements.inactive;
    (pending1 as FakeAudioElement).emit('canplay');
    await flush();
    expect(machine.snapshot.status).toBe('playing');

    await controller.pause();
    expect((elements.active as FakeAudioElement).pauseCalls).toBe(1);
    (elements.active as FakeAudioElement).emit('pause');
    expect(machine.snapshot.status).toBe('ready');
  });

  it('seek 设置元素位置并派发 SEEK', async () => {
    const { controller, elements, machine } = makePlayer();
    await controller.playNow(track('t1'), { context: [track('t1')], autoplay: true });
    const pending1 = elements.inactive;
    (pending1 as FakeAudioElement).emit('canplay');
    await flush();
    await controller.seek(42);
    expect((elements.active as FakeAudioElement).currentTime).toBe(42);
    expect(machine.snapshot.status).toBe('playing'); // SEEK 不改状态
  });

  it('durationchange → onDurationChange 回调', async () => {
    const onDurationChange = vi.fn();
    const { controller, elements } = makePlayer();
    const elements2 = elements;
    void elements2;
    // 用独立 harness 验证回调接线
    const machine = new PlaybackStateMachine({ logger: createNullLogger() });
    const queue = new QueueController();
    const el = new DualElementSource(() => new FakeAudioElement());
    const pc = new PlayerController({
      stateMachine: machine,
      elements: el,
      queue,
      audio: { ensureContext: vi.fn(), resume: vi.fn() } as unknown as AudioEngineController,
      resolveSource: vi.fn(async () => ({ url: 'u', kind: 'stream' as const })),
      onDurationChange,
      logger: createNullLogger(),
    });
    await pc.playNow(track('t1'), { context: [track('t1')], autoplay: false });
    const pending = el.inactive as FakeAudioElement;
    pending.duration = 240;
    (pending as FakeAudioElement).emit('durationchange');
    expect(onDurationChange).toHaveBeenCalledWith(240);
    void controller;
  });

  it('队列变动（playNext/remove）触发重新预取，取消过时目标', async () => {
    const { controller, elements, queue, prefetch } = makePlayer();
    await controller.playNow(track('t1'), { context: [track('t1'), track('t2')], autoplay: true });
    (elements.inactive as FakeAudioElement).emit('canplay');
    await flush();
    await flush();
    expect(prefetch.mock.calls.some((call) => call[0]?.id === 't2')).toBe(true);

    // 队列变动 → upNext 插入 → 预取目标变为临时区首项
    queue.playNext(track('x'));
    await flush();
    expect(prefetch.mock.calls.some((call) => call[0]?.id === 'x')).toBe(true);
    expect(prefetch.mock.calls.at(-1)?.[0]?.id).toBe('x');
  });
});
