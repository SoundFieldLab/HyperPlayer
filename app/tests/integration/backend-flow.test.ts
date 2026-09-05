/**
 * 后端最终验收（任务书 §4）：fake 环境下完整走通
 *  LOAD→resolving→buffering→playing→ended→队列推进→预取
 *  + 音频流缓存写读（StreamCacheService）
 *  + 扫库增量（ScanMachine）
 * 全部在 vitest 中断言；不碰 Tauri。
 */
import { describe, expect, it, vi } from 'vitest';
import { PlayerController } from '../../src/services/PlayerController';
import { PlaybackStateMachine } from '../../src/domains/player/PlaybackStateMachine';
import { QueueController } from '../../src/domains/player/QueueController';
import { DualElementSource } from '../../src/domains/player/DualElementSource';
import type { AudioElementEventName, AudioElementLike } from '../../src/domains/player/DualElementSource';
import type { AudioEngineController } from '../../src/domains/player/AudioEngineController';
import { StreamCacheService } from '../../src/services/StreamCacheService';
import { ScanMachine } from '../../src/domains/library/ScanMachine';
import { LibraryService } from '../../src/domains/library/LibraryService';
import { createFakeFs, createFakeHttp, createFakeSql } from '../../src/infra/fakes';
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

const encoder = new TextEncoder();
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('后端最终验收（fake 环境完整流）', () => {
  it('LOAD→resolving→buffering→playing→ended→队列推进→预取 + 缓存写读', async () => {
    const fs = createFakeFs();
    const http = createFakeHttp();
    const sql = createFakeSql();
    // 三个音源流：t1/t2/t3
    for (const id of ['t1', 't2', 't3']) {
      http.respond(`https://cdn/${id}.mp3`, [encoder.encode(`${id}-part1`), encoder.encode(`${id}-part2`)], 200);
    }
    const cache = new StreamCacheService({ http, fs, sql, cacheDir: '/cache', logger: createNullLogger() });

    const elements = new DualElementSource(() => new FakeAudioElement());
    const machine = new PlaybackStateMachine({ logger: createNullLogger() });
    const queue = new QueueController();
    const statuses: string[] = [];
    machine.subscribe((s) => statuses.push(s.status));
    const prefetch = vi.fn(async (_track: QueueItem) => {});

    // resolveSource：缓存命中 → 本地；未命中 → 直链 + 异步写缓存（P2/P4 接线的 P1 简化实现）
    const resolveSource = async (item: QueueItem): Promise<ResolvedSource> => {
      const cached = await cache.getPlayable(item);
      if (cached) return { url: cached.filePath, kind: 'local' };
      void cache.ensureCached(item, `https://cdn/${item.id}.mp3`); // 边播边缓存（异步）
      return { url: `https://cdn/${item.id}.mp3`, kind: 'stream' };
    };
    const audio = { ensureContext: vi.fn(() => ({}) as unknown as AudioContext), resume: vi.fn(async () => {}) };
    const controller = new PlayerController({
      stateMachine: machine,
      elements,
      queue,
      audio: audio as unknown as AudioEngineController,
      resolveSource,
      prefetch,
      logger: createNullLogger(),
    });

    const t1 = track('t1');
    const t2 = track('t2');
    const t3 = track('t3');

    // 1) 播放 t1：LOAD → resolving → buffering
    await controller.playNow(t1, { context: [t1, t2, t3], autoplay: true });
    expect(machine.snapshot.status).toBe('buffering');
    expect(statuses).toContain('resolving');

    // 2) canplay → playing（自动播放）
    (elements.inactive as FakeAudioElement).emit('canplay');
    await flush();
    expect(machine.snapshot.status).toBe('playing');

    // 3) 缓存写读：t1 流式写盘 → 可播放读取
    await flush();
    const cachedT1 = await cache.getPlayable(t1);
    expect(cachedT1?.kind).toBe('public');
    expect(await fs.exists('/cache/t1.cache')).toBe(true);

    // 4) 预取 t2
    await flush();
    expect(prefetch.mock.calls.some((c) => c[0]?.id === 't2')).toBe(true);

    // 5) ENDED → 队列推进 → t2 → buffering → canplay → playing
    (elements.active as FakeAudioElement).emit('ended');
    expect(machine.snapshot.status).toBe('resolving');
    expect(queue.snapshot.current?.id).toBe('t2');
    await flush();
    expect(machine.snapshot.status).toBe('buffering');
    (elements.inactive as FakeAudioElement).emit('canplay');
    await flush();
    expect(machine.snapshot.status).toBe('playing');

    // 6) 预取 t3（队列变动即时取消过时预取）
    await flush();
    expect(prefetch.mock.calls.some((c) => c[0]?.id === 't3')).toBe(true);
    queue.playNext(track('x'));
    await flush();
    expect(prefetch.mock.calls.some((c) => c[0]?.id === 'x')).toBe(true);

    // 7) t2 ENDED → upNext 优先（UI-D43）→ x → canplay → playing
    (elements.active as FakeAudioElement).emit('ended');
    await flush();
    expect(queue.snapshot.current?.id).toBe('x');
    (elements.inactive as FakeAudioElement).emit('canplay');
    await flush();
    expect(machine.snapshot.status).toBe('playing');

    // 8) x ENDED → t3 → canplay → playing；t3 ENDED → 顺序模式到尾 → ready
    (elements.active as FakeAudioElement).emit('ended');
    await flush();
    expect(queue.snapshot.current?.id).toBe('t3');
    (elements.inactive as FakeAudioElement).emit('canplay');
    await flush();
    expect(machine.snapshot.status).toBe('playing');
    (elements.active as FakeAudioElement).emit('ended');
    await flush();
    expect(machine.snapshot.status).toBe('ready'); // 无下一首 → ready
  });

  it('扫库增量：首次 added=3，mtime 未变第二次 added=0', async () => {
    const fs = createFakeFs();
    const sql = createFakeSql();
    fs.writeFile('/music/a/s1.mp3', encoder.encode('a'));
    fs.writeFile('/music/a/s2.flac', encoder.encode('b'));
    fs.writeFile('/music/b/s3.mp3', encoder.encode('c'));

    const parse = async (path: string) => ({
      title: path.split('/').pop()?.replace(/\.[^.]+$/u, '') ?? 'unknown',
      artist: 'Artist',
      duration: 180,
    });
    const machine = new ScanMachine({ fs, sql, parseMetadata: parse, logger: createNullLogger() });
    await machine.scan(['/music/a', '/music/b']);
    expect(machine.snapshot.phase).toBe('done');
    expect(machine.snapshot.added).toBe(3);

    const library = new LibraryService(sql);
    expect(await library.queryTracks()).toHaveLength(3);

    // 增量：mtime 未变 → 跳过
    await machine.scan(['/music/a', '/music/b']);
    expect(machine.snapshot.added).toBe(3); // 不新增
    expect(machine.snapshot.filesScanned).toBe(3); // 增量跳过
  });
});
