import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackRecord } from '../../domains/library/ScanMachine';
import { LocalAlbumsPage, LocalArtistsPage, LocalFoldersPage, LocalPlaylistsPage, LocalSongsPage, trackToQueueItem } from './LocalPages';
import { createFakeServices, renderWithServices } from '../../../tests/ui/test-utils';
import { useAppStore } from '../../stores/store';

const track: TrackRecord = {
  id: 'track-1', path: 'D:/music/song.mp3', folder: 'D:/music', title: '夜航', artist: '测试艺术家', album: '第一张', album_artist: null, duration: 188, format: 'mp3', bitrate: 320, size: 100, mtime_ms: 1, added_at: 1,
};

describe('local content pages', () => {
  afterEach(() => useAppStore.setState({ navigate: useAppStore.getInitialState().navigate }));

  it('maps local tracks to playable QueueItems', () => {
    expect(trackToQueueItem(track)).toMatchObject({ id: 'track-1', source: 'local', localPath: track.path, entitlement: 'free', cacheStatus: 'none' });
  });

  it('plays a real local track from the songs table', async () => {
    const playNow = vi.fn().mockResolvedValue(undefined);
    const services = createFakeServices({ library: { queryTracks: vi.fn().mockResolvedValue([track]) }, player: { playNow } } as never);
    renderWithServices(<LocalSongsPage />, services);
    await waitFor(() => expect(screen.getByText('夜航')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '播放 夜航' }));
    await waitFor(() => expect(playNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-1', localPath: track.path }), expect.anything()));
  });

  it('creates, opens and deletes local playlists through LibraryService', async () => {
    const navigate = vi.fn();
    useAppStore.setState({ navigate });
    const createPlaylist = vi.fn().mockResolvedValue(2);
    const deletePlaylist = vi.fn().mockResolvedValue(undefined);
    const listPlaylists = vi.fn().mockResolvedValue([{ id: 1, name: '收藏', created_at: 1 }]);
    const services = createFakeServices({ library: { listPlaylists, createPlaylist, deletePlaylist } } as never);
    renderWithServices(<LocalPlaylistsPage />, services);
    await waitFor(() => expect(screen.getByText('收藏')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '打开 收藏' }));
    expect(navigate).toHaveBeenCalledWith('local', expect.objectContaining({ routeId: 'local-playlist', entityId: '1', params: { name: '收藏' } }));
    fireEvent.change(screen.getByRole('textbox', { name: '播放列表名称' }), { target: { value: '通勤' } });
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => expect(createPlaylist).toHaveBeenCalledWith('通勤'));
    fireEvent.click(screen.getByRole('button', { name: '删除 收藏' }));
    await waitFor(() => expect(deletePlaylist).toHaveBeenCalledWith(1));
  });

  it('专辑和艺术家聚合项进入对应本地详情', async () => {
    const navigate = vi.fn();
    useAppStore.setState({ navigate });
    const services = createFakeServices({ library: {
      listAlbums: vi.fn().mockResolvedValue([{ album: '第一张', artist: '测试艺术家', count: 1 }]),
      listArtists: vi.fn().mockResolvedValue([{ artist: '测试艺术家', count: 1 }]),
    } } as never);
    const album = renderWithServices(<LocalAlbumsPage />, services);
    fireEvent.click(await screen.findByRole('button', { name: '打开 第一张' }));
    expect(navigate).toHaveBeenCalledWith('local', expect.objectContaining({ routeId: 'local-album', params: { album: '第一张' } }));
    album.unmount();
    renderWithServices(<LocalArtistsPage />, services);
    fireEvent.click(await screen.findByRole('button', { name: '打开 测试艺术家' }));
    expect(navigate).toHaveBeenCalledWith('local', expect.objectContaining({ routeId: 'local-artist', params: { artist: '测试艺术家' } }));
  });

  it('选择目录后持久化目录并启动真实扫描', async () => {
    const settings = { libraryFolders: [] };
    const services = createFakeServices({
      library: { listFolders: vi.fn().mockResolvedValue([]) },
      dialog: { pickDirectory: vi.fn().mockResolvedValue('D:/Music') },
      scanMachine: { snapshot: { phase: 'idle' }, scan: vi.fn().mockResolvedValue(undefined) },
      settings: { snapshot: settings, update: vi.fn().mockResolvedValue({ ...settings, libraryFolders: ['D:/Music'] }) },
    } as never);
    renderWithServices(<LocalFoldersPage />, services);
    fireEvent.click(screen.getByRole('button', { name: '添加并扫描文件夹' }));
    await waitFor(() => expect(services.settings.update).toHaveBeenCalledWith({ libraryFolders: ['D:/Music'] }));
    expect(services.scanMachine.scan).toHaveBeenCalledWith(['D:/Music']);
  });
});
