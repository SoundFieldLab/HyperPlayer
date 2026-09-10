import { describe, expect, it, vi } from 'vitest';
import { createLyricsFetchers } from '../../../src/domains/player/lyrics/LyricsFetchers';
import type { TauriFs } from '../../../src/infra/tauriFs';
import type { NeteaseService } from '../../../src/domains/netease/NeteaseService';

function makeFs(files: Record<string, string>): TauriFs {
  return {
    exists: vi.fn(async (path) => path in files),
    readFile: vi.fn(async (path) => new TextEncoder().encode(files[path] ?? '')),
    writeFile: vi.fn(), appendFile: vi.fn(), mkdir: vi.fn(), readDir: vi.fn(), removeFile: vi.fn(), renameFile: vi.fn(), stat: vi.fn(),
  } as unknown as TauriFs;
}

describe('LyricsFetchers contract', () => {
  it('loads the first available local sidecar and preserves its format', async () => {
    const fetchers = createLyricsFetchers({
      fs: makeFs({ '/music/song.lrc': '[00:01.00]hello' }),
      netease: {} as NeteaseService,
    });
    await expect(fetchers.local('/music/song.mp3')).resolves.toEqual({ text: '[00:01.00]hello', format: 'lrc' });
  });

  it('normalizes the Netease response with YRC preferred over LRC', async () => {
    const route = vi.fn(async () => ({ body: { lrc: { lyric: '[00:01.00]line' }, yrc: { lyric: '[1000,500](1000,500,0)word' } } }));
    const fetchers = createLyricsFetchers({ fs: makeFs({}), netease: { route } as unknown as NeteaseService });
    await expect(fetchers.netease('song-1')).resolves.toEqual({ text: '[1000,500](1000,500,0)word', format: 'yrc' });
    expect(route).toHaveBeenCalledWith('/netease/lyric', { id: 'song-1' });
  });
});
