import type { TauriFs } from '../../../infra/tauriFs';
import type { LyricsFetcher, LyricsSource } from '../LyricsTimeline';
import type { NeteaseService } from '../../netease/NeteaseService';

export interface LyricsFetchers {
  local: LyricsFetcher;
  netease: LyricsFetcher;
}

export function createLyricsFetchers(deps: { fs: TauriFs; netease: NeteaseService }): LyricsFetchers {
  return {
    local: async (trackId) => {
      const path = trackId;
      const base = path.replace(/\.[^.\\/]+$/, '');
      for (const extension of ['.yrc', '.lrc', '.ttml']) {
        const candidate = `${base}${extension}`;
        try {
          if (!(await deps.fs.exists(candidate))) continue;
          const bytes = await deps.fs.readFile(candidate);
          const text = new TextDecoder().decode(bytes);
          return { text, format: extension.slice(1) as LyricsSource['format'] };
        } catch {
          // A missing/unreadable sidecar falls through to the next format.
        }
      }
      return null;
    },
    netease: async (trackId) => {
      const response = await deps.netease.route('/netease/lyric', { id: trackId }) as {
        body?: {
          lrc?: { lyric?: string | null };
          yrc?: { lyric?: string | null };
          ttml?: string | null;
        };
      };
      const answer: {
        lrc?: { lyric?: string | null };
        yrc?: { lyric?: string | null };
        ttml?: string | null;
      } = 'body' in response
        ? ((response.body ?? {}) as { lrc?: { lyric?: string | null }; yrc?: { lyric?: string | null }; ttml?: string | null })
        : (response as unknown as { lrc?: { lyric?: string | null }; yrc?: { lyric?: string | null }; ttml?: string | null });
      const yrc = answer.yrc?.lyric;
      if (yrc) return { text: yrc, format: 'yrc' };
      const lrc = answer.lrc?.lyric;
      if (lrc) return { text: lrc, format: 'lrc' };
      if (answer.ttml) return { text: answer.ttml, format: 'ttml' };
      return null;
    },
  };
}
