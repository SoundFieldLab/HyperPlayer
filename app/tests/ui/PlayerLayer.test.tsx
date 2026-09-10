import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { PlayerLayer } from '../../src/shell/PlayerLayer';
import { useAppStore } from '../../src/stores/store';
import type { QueueItem } from '../../src/domains/player/types';
import type { LyricsSnapshot } from '../../src/domains/player/LyricsTimeline';
import { createFakeServices, renderWithServices } from './test-utils';

vi.mock('../../src/infra/assetUrl', () => ({ toAssetUrl: (path: string) => `asset://${path}` }));

const track: QueueItem = { id: 'current', title: 'Night Drive', artist: 'Hyper Artist', album: 'After Dark', source: 'local', entitlement: 'free', cacheStatus: 'public' };
const nextTrack: QueueItem = { ...track, id: 'next', title: 'Next Signal' };

function lyricService(initial: LyricsSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    get snapshot() { return snapshot; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    update(next: LyricsSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

const idleLyrics: LyricsSnapshot = { status: 'idle', lines: [], timingLevel: null, currentLineIndex: -1, currentWordIndex: -1, error: null };

function playerServices(overrides: Record<string, unknown> = {}) {
  return createFakeServices({
    lyrics: lyricService(idleLyrics) as never,
    telemetry: { latestFrame: null } as never,
    player: { play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), retry: vi.fn(), selectQueueItem: vi.fn(), clearAll: vi.fn() } as never,
    queue: { cycleMode: vi.fn(), remove: vi.fn(), clearNext: vi.fn() } as never,
    ...overrides,
  });
}

let animationCallback: FrameRequestCallback | null = null;

afterEach(() => {
  cleanup();
  animationCallback = null;
  vi.unstubAllGlobals();
});

function openLayer() {
  useAppStore.setState({ overlay: { kind: 'modal', id: 'player-layer' }, track, status: 'playing', mode: 'sequence', upNext: [nextTrack], context: [track, nextTrack] });
}

describe('PlayerLayer', () => {
  it('renders current track, both queue zones, and real empty media states', () => {
    const services = playerServices();
    openLayer();
    renderWithServices(<PlayerLayer />, services);

    expect(screen.getByRole('heading', { name: 'Night Drive' })).toBeInTheDocument();
    expect(screen.getByText('接下来播放')).toBeInTheDocument();
    expect(screen.getByText('当前上下文')).toBeInTheDocument();
    expect(screen.getByText('当前曲目未加载歌词')).toBeInTheDocument();
    expect(screen.getByText('等待分析数据')).toBeInTheDocument();
  });

  it('loads the real cover for a local queue item', async () => {
    const getTrack = vi.fn().mockResolvedValue({ ...track, album_artist: 'Hyper Artist' });
    const getCoverPath = vi.fn().mockResolvedValue('C:/covers/after-dark.jpg');
    const services = playerServices({ library: { getTrack } as never, covers: { getCoverPath } as never });
    openLayer();
    renderWithServices(<PlayerLayer />, services);

    await screen.findByRole('img', { name: 'After Dark 封面' });
    await vi.waitFor(() => expect(document.querySelector('img[alt="After Dark 封面"]')).toHaveAttribute('src', 'asset://C:/covers/after-dark.jpg'));
    expect(getTrack).toHaveBeenCalledWith('current');
    expect(getCoverPath).toHaveBeenCalledWith('hyper artist|after dark');
  });

  it('closes on Escape and calls transport and mode actions', () => {
    const player = { play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), retry: vi.fn() };
    const queue = { cycleMode: vi.fn(), remove: vi.fn(), clearNext: vi.fn() };
    const services = playerServices({ player: player as never, queue: queue as never });
    openLayer();
    renderWithServices(<PlayerLayer />, services);

    fireEvent.click(screen.getByRole('button', { name: '上一首' }));
    fireEvent.click(screen.getByRole('button', { name: '下一首' }));
    fireEvent.click(screen.getByRole('button', { name: '重试当前歌曲' }));
    fireEvent.click(screen.getByRole('button', { name: '播放模式：顺序播放' }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(player.prev).toHaveBeenCalledTimes(1);
    expect(player.next).toHaveBeenCalledTimes(1);
    expect(player.retry).toHaveBeenCalledTimes(1);
    expect(queue.cycleMode).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().overlay).not.toEqual({ kind: 'modal', id: 'player-layer' });
  });

  it('renders word-timed lyrics, auxiliary text, and updates real highlights', () => {
    const lyrics = lyricService({
      status: 'ready',
      timingLevel: 'word',
      currentLineIndex: 0,
      currentWordIndex: 0,
      error: null,
      lines: [{ time: 0, text: 'Hello world', words: [{ word: 'Hello ', startTime: 0, duration: 300 }, { word: 'world', startTime: 300, duration: 300 }], translation: '你好世界', roman: 'hello world' }],
    });
    openLayer();
    renderWithServices(<PlayerLayer />, playerServices({ lyrics: lyrics as never }));

    const hello = screen.getByText('Hello');
    const world = screen.getByText('world');
    expect(hello).toHaveClass('is-highlighted');
    expect(world).not.toHaveClass('is-highlighted');
    expect(screen.getByText('你好世界')).toBeInTheDocument();
    expect(screen.getByText('hello world')).toBeInTheDocument();

    act(() => lyrics.update({ ...lyrics.snapshot, currentWordIndex: 1 }));
    expect(world).toHaveClass('is-highlighted');
  });

  it('only highlights the current row for line-timed lyrics and reports failures', () => {
    const lyrics = lyricService({
      status: 'ready', timingLevel: 'line', currentLineIndex: 1, currentWordIndex: 1, error: null,
      lines: [{ time: 0, text: 'First line' }, { time: 1000, text: 'Second line' }],
    });
    openLayer();
    renderWithServices(<PlayerLayer />, playerServices({ lyrics: lyrics as never }));

    expect(screen.getByText('Second line').closest('li')).toHaveClass('is-current');
    expect(document.querySelectorAll('.player-lyric-original .is-highlighted')).toHaveLength(0);
    act(() => lyrics.update({ ...idleLyrics, status: 'error', error: '网络不可用' }));
    expect(screen.getByRole('alert')).toHaveTextContent('歌词加载失败：网络不可用');
  });

  it('draws the latest telemetry frame without storing it in React state', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { animationCallback = callback; return 1; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const fillRect = vi.fn();
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect, beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillStyle: '', strokeStyle: '', lineWidth: 1 };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    openLayer();
    renderWithServices(<PlayerLayer />, playerServices({ telemetry: { latestFrame: { type: 'frame', sequence: 1, wave: new Float32Array([-0.2, 0.4]), spectrum: new Float32Array([0.25, 0.75]), sampleRate: 44100, at: 0 } } as never }));

    act(() => animationCallback?.(40));
    expect(fillRect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('等待分析数据')).not.toBeInTheDocument();
    expect(screen.getByLabelText('实时频谱与波形')).toHaveClass('is-visible');
  });

  it('delegates queue selection, removal, and confirmed clearing', () => {
    const player = { play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), retry: vi.fn(), selectQueueItem: vi.fn() };
    const queue = { cycleMode: vi.fn(), remove: vi.fn(), clearNext: vi.fn() };
    openLayer();
    renderWithServices(<PlayerLayer />, playerServices({ player: player as never, queue: queue as never }));

    fireEvent.click(screen.getAllByRole('button', { name: '播放 Next Signal' })[0]!);
    expect(player.selectQueueItem).toHaveBeenCalledWith('next');
    fireEvent.click(screen.getAllByRole('button', { name: '从队列移除 Next Signal' })[0]!);
    expect(queue.remove).toHaveBeenCalledWith('next');
    fireEvent.click(screen.getByRole('button', { name: '清空接下来播放' }));
    expect(queue.clearNext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(queue.clearNext).toHaveBeenCalledTimes(1);
  });

  it('delegates confirmed full clearing to the player lifecycle', () => {
    const clearAll = vi.fn();
    openLayer();
    renderWithServices(<PlayerLayer />, playerServices({ player: { play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), retry: vi.fn(), selectQueueItem: vi.fn(), clearAll } as never }));

    fireEvent.click(screen.getByRole('button', { name: '停止并清空全部' }));
    expect(clearAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(clearAll).toHaveBeenCalledOnce();
  });
});
