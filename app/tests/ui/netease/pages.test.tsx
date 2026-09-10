import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountPage, DiscoverPage, NeteaseHomePage, NeteaseLibraryPage, SearchPage } from '../../../src/pages/netease';
import { useAppStore } from '../../../src/stores/store';
import { useSessionStore } from '../../../src/stores/slices/session';
import { renderWithServices, createFakeServices } from '../test-utils';

function entry(routeId: string, params?: Record<string, unknown>) { return { routeId, params }; }

describe('网易云页面', () => {
  afterEach(() => {
    useSessionStore.setState({ sessionState: 'anonymous', notice: null });
    useAppStore.setState({ navigate: useAppStore.getInitialState().navigate });
  });

  it('搜索通过 NeteaseService.route 并展示真实返回', async () => {
    const route = vi.fn().mockResolvedValue({ body: { result: { songs: [{ id: 1, name: '真实歌曲', artistName: '真实歌手' }] } } });
    renderWithServices(<SearchPage entry={entry('search')} />, createFakeServices({ netease: { route } } as never));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), { target: { value: '真实' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('真实歌曲')).toBeInTheDocument();
    expect(route).toHaveBeenCalledWith('/netease/search', { keywords: '真实', limit: 30, type: 1 });
  });

  it.each([
    ['album', 10, '专辑'],
    ['artist', 100, '歌手'],
  ])('搜索 %s 使用真实类型参数', async (segment, type, label) => {
    const route = vi.fn().mockResolvedValue({ body: { result: {} } });
    renderWithServices(<SearchPage entry={entry('search', { q: '关键字', segment })} />, createFakeServices({ netease: { route } } as never));
    expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(route).toHaveBeenCalledWith('/netease/search', { keywords: '关键字', limit: 30, type }));
  });

  it('首页歌曲可以直接播放真实返回曲目', async () => {
    const route = vi.fn().mockResolvedValue({ body: { result: [{ id: 100, name: '推荐项', song: { id: 1, name: '首页歌曲', artists: [{ name: '首页歌手' }], album: { name: '首页专辑' } } }] } });
    const playNow = vi.fn().mockResolvedValue(undefined);
    renderWithServices(<NeteaseHomePage entry={entry('netease-home')} />, createFakeServices({ netease: { route }, player: { playNow } } as never));
    fireEvent.click(await screen.findByRole('button', { name: '播放 首页歌曲' }));
    expect(playNow).toHaveBeenCalledWith(expect.objectContaining({ id: '1', source: 'netease' }), expect.objectContaining({ context: expect.any(Array) }));
  });

  it('搜索歌单与发现榜单进入正确详情路由', async () => {
    const navigate = vi.fn();
    useAppStore.setState({ navigate });
    const route = vi.fn().mockResolvedValue({ body: { result: { playlists: [{ id: 12, name: '搜索歌单', trackCount: 3 }] }, list: [{ id: 34, name: '榜单', trackCount: 20 }] } });
    const services = createFakeServices({ netease: { route } } as never);
    const search = renderWithServices(<SearchPage entry={entry('search', { q: '歌单', segment: 'playlist' })} />, services);
    fireEvent.click(await screen.findByRole('button', { name: '打开 搜索歌单' }));
    expect(route).toHaveBeenCalledWith('/netease/search', { keywords: '歌单', limit: 30, type: 1000 });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ routeId: 'netease-playlist', entityId: '12' }));
    search.unmount();
    renderWithServices(<DiscoverPage entry={entry('discover')} />, services);
    fireEvent.click(await screen.findByRole('button', { name: '打开 榜单' }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ routeId: 'netease-playlist', entityId: '34' }));
  });

  it('匿名账号显示匿名状态，不渲染虚假 QR 或内容并在卸载时停止轮询', () => {
    const session = { snapshot: 'anonymous', isLoggedIn: false, startQrLogin: vi.fn(), startQrPolling: vi.fn(), stopQrPolling: vi.fn() };
    const view = renderWithServices(<AccountPage entry={entry('account')} />, createFakeServices({ session } as never));
    expect(screen.getByText('未登录')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '网易云登录二维码' })).not.toBeInTheDocument();
    view.unmount();
    expect(session.stopQrPolling).toHaveBeenCalledOnce();
  });

  it('音乐库读取云歌单缓存并以分段状态展示', async () => {
    const navigate = vi.fn();
    useAppStore.setState({ navigate });
    const listCached = vi.fn().mockResolvedValue([{ id: '1', name: '缓存歌单', trackCount: 3, creator: null, coverUrl: null, syncedAt: 1 }]);
    renderWithServices(<NeteaseLibraryPage entry={entry('netease-library')} />, createFakeServices({ cloudPlaylistSync: { listCached } } as never));
    expect(await screen.findByText('缓存歌单')).toBeInTheDocument();
    expect(listCached).toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: '云歌单' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: '打开 缓存歌单' }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ routeId: 'netease-playlist', entityId: '1' }));
  });

  it('liked 使用登录 uid 拉取 ID 并补全歌曲详情', async () => {
    useSessionStore.setState({ sessionState: 'loggedIn' });
    const route = vi.fn()
      .mockResolvedValueOnce({ body: { ids: [7, 8] } })
      .mockResolvedValueOnce({ body: { songs: [{ id: 7, name: '喜欢的歌 A' }, { id: 8, name: '喜欢的歌 B' }] } });
    const session = { isLoggedIn: true, getCookie: () => ({ userId: '1001' }) };
    renderWithServices(<NeteaseLibraryPage entry={entry('netease-library', { segment: 'liked' })} />, createFakeServices({ netease: { route }, session } as never));
    expect(await screen.findByText('喜欢的歌 A')).toBeInTheDocument();
    expect(route).toHaveBeenNthCalledWith(1, '/netease/likelist', { uid: 1001 });
    expect(route).toHaveBeenNthCalledWith(2, '/netease/song/detail', { ids: '7,8' });
  });

  it('liked 未登录时说明真实原因且不请求接口', async () => {
    const route = vi.fn();
    renderWithServices(<NeteaseLibraryPage entry={entry('netease-library', { segment: 'liked' })} />, createFakeServices({ netease: { route } } as never));
    expect(screen.getByText('登录网易云账号后才能查看我喜欢的音乐。')).toBeInTheDocument();
    await waitFor(() => expect(route).not.toHaveBeenCalled());
  });
});
