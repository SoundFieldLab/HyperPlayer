import { createElement, type ComponentType } from 'react';
import { LocalAlbumsPage, LocalArtistsPage, LocalFoldersPage, LocalHomePage, LocalPlaylistsPage, LocalSongsPage } from '../pages/local/LocalPages';
import { AccountPage, DiscoverPage, NeteaseHomePage, NeteaseLibraryPage, RecentPage, SearchPage } from '../pages/netease';
import { DiagnosticsPage, DspPage, OnboardingPage, SettingsPage, StatusCenterPage } from '../pages/system';
import { AlbumDetailPage, ArtistDetailPage, LocalDetailPage, MvPage, PlaylistDetailPage } from '../pages/detail';
import type { NavDomain, NavEntry } from '../stores/slices/nav';

export const NOT_FOUND_ROUTE_ID = 'not-found' as const;

export const ROUTE_IDS = [
  'netease-home',
  'search',
  'netease-library',
  'discover',
  'recent',
  'netease-playlist',
  'netease-album',
  'netease-artist',
  'netease-mv',
  'account',
  'local-home',
  'local-songs',
  'local-albums',
  'local-artists',
  'local-folders',
  'local-playlists',
  'local-album',
  'local-artist',
  'local-playlist',
  'status-center',
  'onboarding',
  'diagnostics',
  'dsp',
  'settings',
  NOT_FOUND_ROUTE_ID,
] as const;

export type RouteId = (typeof ROUTE_IDS)[number];
export type RouteDomain = NavDomain | 'shared';

export interface RouteContext {
  domain: NavDomain;
  entry: NavEntry;
  requestedRouteId?: string;
}

export type RouteComponent = ComponentType<RouteContext>;

export interface RouteDefinition {
  routeId: RouteId;
  title: string;
  domain: RouteDomain;
  kind: 'page' | 'not-found';
  component: RouteComponent;
}

function NotFoundPage({ entry, requestedRouteId }: RouteContext) {
  const routeId = requestedRouteId ?? entry.routeId;
  return createElement(
    'section',
    { 'aria-labelledby': 'route-not-found-title' },
    createElement('h1', { id: 'route-not-found-title' }, '页面未找到'),
    createElement('p', null, `无法打开路由 “${routeId}”。`),
  );
}

const page = (
  routeId: Exclude<RouteId, typeof NOT_FOUND_ROUTE_ID>,
  title: string,
  domain: RouteDomain,
): RouteDefinition => ({
  routeId,
  title,
  domain,
  kind: 'page',
  component: NotFoundPage,
});

export const routeRegistry: Record<RouteId, RouteDefinition> = {
  'netease-home': { ...page('netease-home', '首页', 'netease'), component: NeteaseHomePage },
  search: { ...page('search', '搜索', 'netease'), component: SearchPage },
  'netease-library': { ...page('netease-library', '音乐库', 'netease'), component: NeteaseLibraryPage },
  discover: { ...page('discover', '发现', 'netease'), component: DiscoverPage },
  recent: { ...page('recent', '最近播放', 'netease'), component: RecentPage },
  'netease-playlist': { ...page('netease-playlist', '歌单详情', 'netease'), component: PlaylistDetailPage },
  'netease-album': { ...page('netease-album', '专辑详情', 'netease'), component: AlbumDetailPage },
  'netease-artist': { ...page('netease-artist', '歌手详情', 'netease'), component: ArtistDetailPage },
  'netease-mv': { ...page('netease-mv', 'MV 播放', 'netease'), component: MvPage },
  account: { ...page('account', '账号', 'netease'), component: AccountPage },
  'local-home': { ...page('local-home', '概览', 'local'), component: LocalHomePage },
  'local-songs': { ...page('local-songs', '歌曲', 'local'), component: LocalSongsPage },
  'local-albums': { ...page('local-albums', '专辑', 'local'), component: LocalAlbumsPage },
  'local-artists': { ...page('local-artists', '艺术家', 'local'), component: LocalArtistsPage },
  'local-folders': { ...page('local-folders', '文件夹', 'local'), component: LocalFoldersPage },
  'local-playlists': { ...page('local-playlists', '播放列表', 'local'), component: LocalPlaylistsPage },
  'local-album': { ...page('local-album', '专辑详情', 'local'), component: LocalDetailPage },
  'local-artist': { ...page('local-artist', '艺术家详情', 'local'), component: LocalDetailPage },
  'local-playlist': { ...page('local-playlist', '播放列表详情', 'local'), component: LocalDetailPage },
  'status-center': { ...page('status-center', '状态中心', 'shared'), component: StatusCenterPage },
  onboarding: { ...page('onboarding', '初始化向导', 'shared'), component: OnboardingPage },
  diagnostics: { ...page('diagnostics', '诊断', 'shared'), component: DiagnosticsPage },
  dsp: { ...page('dsp', '音效', 'shared'), component: DspPage },
  settings: { ...page('settings', '设置', 'shared'), component: SettingsPage },
  [NOT_FOUND_ROUTE_ID]: {
    routeId: NOT_FOUND_ROUTE_ID,
    title: '页面未找到',
    domain: 'shared',
    kind: 'not-found',
    component: NotFoundPage,
  },
};

export function resolveRoute(routeId: string): RouteDefinition {
  return routeRegistry[routeId as RouteId] ?? routeRegistry[NOT_FOUND_ROUTE_ID];
}
