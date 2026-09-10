import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AlbumDetailPage, LocalDetailPage, MvPage, PlaylistDetailPage } from './pages';
import { createFakeServices, renderWithServices } from '../../../tests/ui/test-utils';

const entry = (routeId: string, entityId = '42', params?: Record<string, unknown>) => ({ routeId, entityId, params });

describe('详情页面', () => {
  it('专辑详情使用真实接口并播放返回曲目', async () => {
    const route = vi.fn().mockResolvedValue({ body: { album: { name: '真实专辑', picUrl: 'cover.jpg' }, songs: [{ id: 7, name: '真实歌曲', ar: [{ name: '歌手' }] }] } });
    const playNow = vi.fn().mockResolvedValue(undefined);
    renderWithServices(<AlbumDetailPage domain="netease" entry={entry('netease-album')} />, createFakeServices({ netease: { route }, player: { playNow } } as never));
    expect(await screen.findByRole('heading', { name: '真实专辑', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('真实歌曲')).toBeInTheDocument();
    screen.getByRole('button', { name: '播放 真实歌曲' }).click();
    expect(playNow).toHaveBeenCalled();
    expect(route).toHaveBeenCalledWith('/netease/album', { id: '42' });
  });

  it('歌单详情直接使用 playlist/detail 返回的完整曲目', async () => {
    const route = vi.fn().mockResolvedValue({ body: { playlist: { name: '真实歌单', trackCount: 1, tracks: [{ id: 8, name: '歌单歌曲' }] } } });
    renderWithServices(<PlaylistDetailPage domain="netease" entry={entry('netease-playlist')} />, createFakeServices({ netease: { route } } as never));
    expect(await screen.findByRole('heading', { name: '真实歌单', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('歌单歌曲')).toBeInTheDocument();
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith('/netease/playlist/detail', { id: '42' });
    expect(route).not.toHaveBeenCalledWith('/netease/playlist/tracks', expect.anything());
  });

  it('歌单详情只有 trackIds 时通过 song/detail 补齐曲目', async () => {
    const route = vi.fn()
      .mockResolvedValueOnce({ body: { playlist: { name: 'ID 歌单', trackIds: [{ id: 8 }, { id: 9 }] } } })
      .mockResolvedValueOnce({ body: { songs: [{ id: 8, name: '补齐歌曲' }] } });
    renderWithServices(<PlaylistDetailPage domain="netease" entry={entry('netease-playlist')} />, createFakeServices({ netease: { route } } as never));
    expect(await screen.findByText('补齐歌曲')).toBeInTheDocument();
    expect(route).toHaveBeenNthCalledWith(2, '/netease/song/detail', { ids: '8,9' });
    expect(route).not.toHaveBeenCalledWith('/netease/playlist/tracks', expect.anything());
  });

  it('MV 没有真实视频 URL 时显示明确错误且不渲染视频', async () => {
    const route = vi.fn().mockResolvedValue({ body: { data: {} } });
    renderWithServices(<MvPage domain="netease" entry={entry('netease-mv')} />, createFakeServices({ netease: { route } } as never));
    expect(await screen.findByText('接口未返回 MV 视频地址，无法播放。')).toBeInTheDocument();
    expect(screen.queryByRole('video')).not.toBeInTheDocument();
  });

  it('本地专辑详情从曲库查询，不制造本地数据', async () => {
    const queryTracks = vi.fn().mockResolvedValue([{ id: 'local-1', path: 'song.mp3', folder: 'music', title: '本地歌曲', artist: '本地歌手', album: '本地专辑', album_artist: null, duration: 1, format: 'mp3', bitrate: null, size: 1, mtime_ms: 1, added_at: 1 }]);
    renderWithServices(<LocalDetailPage domain="local" entry={entry('local-album', 'local-album', { album: '本地专辑' })} />, createFakeServices({ library: { queryTracks } } as never));
    expect(await screen.findByText('本地歌曲')).toBeInTheDocument();
    expect(queryTracks).toHaveBeenCalledWith({ album: '本地专辑' });
  });
});
