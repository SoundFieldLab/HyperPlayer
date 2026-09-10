import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowClockwise, CloudArrowDown, ClockCounterClockwise, MagnifyingGlass, Play, QrCode } from '@phosphor-icons/react';
import { useServices } from '../../app/providers/ServicesProvider';
import type { SessionState } from '../../domains/netease/SessionService';
import type { QueueItem } from '../../domains/player/types';
import type { CloudPlaylist } from '../../services/CloudPlaylistSyncService';
import type { PlayHistoryEntry } from '../../services/PlayHistoryService';
import { useAppStore } from '../../stores/store';
import type { NavEntry } from '../../stores/slices/nav';
import { useSessionStore } from '../../stores/slices/session';
import './netease.css';

export interface NeteasePageProps { domain?: 'netease' | 'local'; entry: NavEntry; requestedRouteId?: string; }
type AsyncState<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; data: T; error?: string };
type JsonRecord = Record<string, unknown>;
type ListKind = 'song' | 'playlist' | 'album' | 'artist' | 'auto';
type SearchKind = Exclude<ListKind, 'auto'>;

const SEARCH_TYPES: Record<SearchKind, number> = { song: 1, album: 10, artist: 100, playlist: 1000 };
const SEARCH_PATHS: Record<SearchKind, string[][]> = {
  song: [['result', 'songs'], ['songs']],
  album: [['result', 'albums'], ['albums']],
  artist: [['result', 'artists'], ['artists']],
  playlist: [['result', 'playlists'], ['playlists']],
};

const segmentOf = (entry: NavEntry, fallback: string) => typeof entry.params?.segment === 'string' ? entry.params.segment : fallback;
const bodyOf = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object') return {};
  const record = value as JsonRecord;
  return record.body && typeof record.body === 'object' ? record.body as JsonRecord : record;
};
const recordsFrom = (value: unknown, ...paths: string[][]): JsonRecord[] => {
  const root = bodyOf(value);
  for (const path of paths) {
    let candidate: unknown = root;
    for (const key of path) candidate = candidate && typeof candidate === 'object' ? (candidate as JsonRecord)[key] : undefined;
    if (Array.isArray(candidate)) return candidate.filter((item): item is JsonRecord => !!item && typeof item === 'object');
  }
  return [];
};
const textOf = (value: unknown, fallback = '未知') => typeof value === 'string' && value.trim() ? value : fallback;
const nestedText = (value: unknown, key: string): unknown => value && typeof value === 'object' ? (value as JsonRecord)[key] : undefined;
const songRecordOf = (row: JsonRecord): JsonRecord => row.song && typeof row.song === 'object' ? { ...row, ...(row.song as JsonRecord) } : row;
const artistsOf = (row: JsonRecord): string => {
  const song = songRecordOf(row);
  const artists = song.ar ?? song.artists;
  if (Array.isArray(artists)) {
    const names = artists.map((artist) => textOf(nestedText(artist, 'name'), '')).filter(Boolean);
    if (names.length) return names.join(', ');
  }
  return textOf(song.artistName ?? nestedText(song.artist, 'name'), '未知艺术家');
};
const songToQueueItem = (row: JsonRecord, contextId: string): QueueItem | null => {
  const song = songRecordOf(row);
  if (typeof song.id !== 'number' && typeof song.id !== 'string') return null;
  const duration = typeof song.dt === 'number' ? song.dt / 1000 : typeof song.duration === 'number' ? song.duration / (song.duration > 10000 ? 1000 : 1) : undefined;
  return {
    id: String(song.id),
    title: textOf(song.name ?? song.title),
    artist: artistsOf(song),
    album: textOf(nestedText(song.al ?? song.album, 'name') ?? song.album, ''),
    duration,
    source: 'netease',
    entitlement: song.fee === 1 || song.fee === 4 ? 'vip' : 'free',
    cacheStatus: 'none',
    contextId,
  };
};

export function NeteaseFrame({ title, eyebrow, children, actions }: { title: string; eyebrow?: string; children: ReactNode; actions?: ReactNode }) {
  return <main className="netease-page"><header className="netease-page__header"><div><p className="netease-eyebrow">{eyebrow ?? 'NETEASE CLOUD MUSIC'}</p><h1>{title}</h1></div>{actions && <div className="netease-page__actions">{actions}</div>}</header>{children}</main>;
}
export function LoadingState() { return <div className="netease-state" role="status">正在加载…</div>; }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className="netease-state netease-state--error" role="alert"><strong>暂时无法加载</strong><span>{message}</span>{retry && <button className="netease-button" type="button" onClick={retry}><ArrowClockwise size={17} />重试</button>}</div>; }
export function EmptyState({ children = '暂无数据' }: { children?: ReactNode }) { return <div className="netease-state">{children}</div>; }
export function SegmentControl({ entry, options, fallback }: { entry: NavEntry; options: Array<{ id: string; label: string }>; fallback: string }) {
  const current = segmentOf(entry, fallback);
  const navigate = useAppStore((state) => state.navigate);
  return <div className="netease-segments" role="tablist">{options.map((option) => <button key={option.id} type="button" role="tab" aria-selected={current === option.id} className={current === option.id ? 'is-active' : ''} onClick={() => navigate({ ...entry, params: { ...entry.params, segment: option.id } }, option.id)}>{option.label}</button>)}</div>;
}
function useRemote<T>(load: () => Promise<T>, initial: T): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: initial });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setState((old) => ({ ...old, status: 'loading', error: undefined }));
    setNonce((value) => value + 1);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void load().then((data) => { if (!cancelled) setState({ status: 'ready', data }); }).catch((error: unknown) => {
      if (!cancelled) setState((old) => ({ ...old, status: 'error', error: error instanceof Error ? error.message : String(error) }));
    });
    return () => { cancelled = true; };
  }, [load, nonce]);
  return { ...state, reload };
}

function inferKind(row: JsonRecord, fallback: ListKind): Exclude<ListKind, 'auto'> {
  if (fallback !== 'auto') return fallback;
  if (typeof row.trackCount === 'number' || row.creator) return 'playlist';
  if (row.albumSize !== undefined || row.picId !== undefined) return 'artist';
  return 'song';
}
function DataList({ rows, kind = 'auto', contextId = 'netease:list', empty = '接口未返回可展示的数据' }: { rows: JsonRecord[]; kind?: ListKind; contextId?: string; empty?: string }) {
  const navigate = useAppStore((state) => state.navigate);
  const { player } = useServices();
  const queue = rows.map((row) => songToQueueItem(row, contextId)).filter((item): item is QueueItem => item !== null);
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  return <div className="netease-list">{rows.map((row, index) => {
    const song = songRecordOf(row);
    const title = textOf(song.name ?? song.title ?? nestedText(song.al, 'name'));
    const rowKind = inferKind(song, kind);
    const id = typeof song.id === 'number' || typeof song.id === 'string' ? String(song.id) : '';
    const item = songToQueueItem(song, contextId);
    const detail = rowKind === 'song' ? artistsOf(song) : textOf(nestedText(song.creator, 'nickname') ?? song.artistName ?? song.description, '');
    const action = rowKind === 'song' && item
      ? () => player.playNow(item, { context: queue })
      : id ? () => navigate({ routeId: `netease-${rowKind}`, entityId: id }) : null;
    return <article className="netease-list__item" key={String(row.id ?? row.name ?? index)}><div><strong>{title}</strong><span>{detail}</span></div><span className="netease-list__tail"><span className="netease-list__meta">{typeof row.trackCount === 'number' ? `${row.trackCount} 首` : ''}</span>{action && <button className="netease-row-action" type="button" aria-label={`${rowKind === 'song' ? '播放' : '打开'} ${title}`} onClick={() => void action()}>{rowKind === 'song' ? <Play size={15} weight="fill" /> : '打开'}</button>}</span></article>;
  })}</div>;
}

export function NeteaseHomePage({ entry }: NeteasePageProps) {
  const { netease } = useServices();
  const load = useCallback(() => netease.route('/netease/personalized/newsong', { limit: 12 }), [netease]);
  const state = useRemote(load, {});
  const rows = recordsFrom(state.data, ['result'], ['data'], ['songs']);
  return <NeteaseFrame title="首页" actions={<button className="netease-icon-button" title="刷新" aria-label="刷新" onClick={state.reload}><ArrowClockwise size={20} /></button>}><section className="netease-section"><h2>新歌速递</h2>{state.status === 'loading' ? <LoadingState /> : state.status === 'error' ? <ErrorState message={state.error ?? '请求失败'} retry={state.reload} /> : <DataList rows={rows} kind="song" contextId="netease:home" />}</section><p className="netease-muted">{segmentOf(entry, 'recommend') === 'recommend' ? '为你推荐' : '网易云音乐'}</p></NeteaseFrame>;
}

export function SearchPage({ entry }: NeteasePageProps) {
  const { netease } = useServices();
  const [query, setQuery] = useState(typeof entry.params?.q === 'string' ? entry.params.q : '');
  const [submitted, setSubmitted] = useState(query);
  const kind = (segmentOf(entry, 'song') in SEARCH_TYPES ? segmentOf(entry, 'song') : 'song') as SearchKind;
  const load = useCallback(() => submitted.trim() ? netease.route('/netease/search', {
    keywords: submitted.trim(),
    limit: 30,
    type: SEARCH_TYPES[kind],
  }) : Promise.resolve({}), [kind, netease, submitted]);
  const state = useRemote(load, {});
  const rows = recordsFrom(state.data, ...SEARCH_PATHS[kind]);
  return <NeteaseFrame title="搜索"><form className="netease-search" onSubmit={(event) => { event.preventDefault(); setSubmitted(query); }}><MagnifyingGlass size={20} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌曲、专辑、歌手或歌单" aria-label="搜索关键词" /><button className="netease-button" type="submit">搜索</button></form><SegmentControl entry={entry} fallback="song" options={[{ id: 'song', label: '歌曲' }, { id: 'album', label: '专辑' }, { id: 'artist', label: '歌手' }, { id: 'playlist', label: '歌单' }]} />{submitted ? state.status === 'loading' ? <LoadingState /> : state.status === 'error' ? <ErrorState message={state.error ?? '搜索失败'} retry={state.reload} /> : <DataList rows={rows} kind={kind} contextId={`netease:search:${kind}:${submitted}`} /> : <EmptyState>输入关键词开始搜索</EmptyState>}</NeteaseFrame>;
}

async function loadLikedSongs(netease: ReturnType<typeof useServices>['netease'], session: ReturnType<typeof useServices>['session']): Promise<JsonRecord[]> {
  const uid = Number(session.getCookie()?.userId);
  if (!session.isLoggedIn || !Number.isFinite(uid) || uid <= 0) return [];
  const liked = await netease.route('/netease/likelist', { uid });
  const ids = recordsFrom(liked, ['ids']).map((row) => row.id);
  const rawIds = bodyOf(liked).ids;
  const normalizedIds = Array.isArray(rawIds) ? rawIds.map(String).filter(Boolean) : ids.map(String).filter(Boolean);
  if (!normalizedIds.length) return [];
  const detail = await netease.route('/netease/song/detail', { ids: normalizedIds.join(',') });
  return recordsFrom(detail, ['songs']);
}

export function NeteaseLibraryPage({ entry }: NeteasePageProps) {
  const { netease, cloudPlaylistSync, session } = useServices();
  const sessionState = useSessionStore((state) => state.sessionState);
  const segment = segmentOf(entry, 'playlists');
  const loggedIn = sessionState === 'loggedIn' && session.isLoggedIn && Number(session.getCookie()?.userId) > 0;
  const load = useCallback(() => segment === 'playlists' ? cloudPlaylistSync.listCached() : loggedIn ? loadLikedSongs(netease, session) : Promise.resolve([]), [cloudPlaylistSync, loggedIn, netease, segment, session]);
  const state = useRemote(load, [] as CloudPlaylist[] | JsonRecord[]);
  return <NeteaseFrame title="音乐库"><SegmentControl entry={entry} fallback="playlists" options={[{ id: 'playlists', label: '云歌单' }, { id: 'liked', label: '我喜欢的音乐' }]} />{segment === 'liked' && !loggedIn ? <EmptyState>登录网易云账号后才能查看我喜欢的音乐。</EmptyState> : state.status === 'loading' ? <LoadingState /> : state.status === 'error' ? <ErrorState message={state.error ?? '加载失败'} retry={state.reload} /> : segment === 'playlists' ? <CloudPlaylistList rows={state.data as CloudPlaylist[]} /> : <DataList rows={state.data as JsonRecord[]} kind="song" contextId="netease:liked" empty="还没有喜欢的音乐" />}</NeteaseFrame>;
}
function CloudPlaylistList({ rows }: { rows: CloudPlaylist[] }) {
  const navigate = useAppStore((state) => state.navigate);
  return rows.length ? <div className="netease-grid">{rows.map((row) => <article className="netease-card" key={row.id}><strong>{row.name}</strong><span>{row.trackCount} 首 · {row.creator ?? '未知创建者'}</span><button className="netease-card__action" type="button" aria-label={`打开 ${row.name}`} onClick={() => navigate({ routeId: 'netease-playlist', entityId: String(row.id), params: { name: row.name } })}>打开</button></article>)}</div> : <EmptyState>暂无云歌单缓存，请在账号页同步</EmptyState>;
}

export function DiscoverPage({ entry }: NeteasePageProps) {
  const { netease } = useServices();
  const segment = segmentOf(entry, 'charts');
  const route = segment === 'recommend' ? '/netease/recommend/resource' : '/netease/toplist/detail';
  const load = useCallback(() => netease.route(route, { limit: 30 }), [netease, route]);
  const state = useRemote(load, {});
  const rows = recordsFrom(state.data, ['list'], ['playlists'], ['result']);
  return <NeteaseFrame title="发现"><SegmentControl entry={entry} fallback="charts" options={[{ id: 'charts', label: '排行榜' }, { id: 'recommend', label: '歌单推荐' }]} />{state.status === 'loading' ? <LoadingState /> : state.status === 'error' ? <ErrorState message={state.error ?? '加载失败'} retry={state.reload} /> : <DataList rows={rows} kind="playlist" />}</NeteaseFrame>;
}

export function RecentPage(_: NeteasePageProps) {
  const { playHistory } = useServices();
  const load = useCallback(() => playHistory.listRecent(100), [playHistory]);
  const state = useRemote(load, [] as PlayHistoryEntry[]);
  return <NeteaseFrame title="最近播放" eyebrow="PLAY HISTORY"><div className="netease-heading-icon"><ClockCounterClockwise size={24} />本地播放记录</div>{state.status === 'loading' ? <LoadingState /> : state.status === 'error' ? <ErrorState message={state.error ?? '加载失败'} retry={state.reload} /> : state.data.length ? <div className="netease-list">{state.data.map((row) => <article className="netease-list__item" key={row.track_id}><strong>{row.track_id}</strong><span>{row.source} · 播放 {row.play_count} 次</span><time>{new Date(row.played_at).toLocaleString()}</time></article>)}</div> : <EmptyState>还没有本地播放记录</EmptyState>}</NeteaseFrame>;
}

export function AccountPage(_: NeteasePageProps) {
  const { session, cloudPlaylistSync } = useServices();
  const sessionState = useSessionStore((state) => state.sessionState);
  const [qr, setQr] = useState<{ qrimg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  useEffect(() => () => session.stopQrPolling(), [session]);
  const start = async () => { setError(null); try { const result = await session.startQrLogin(); setQr(result); void session.startQrPolling(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const sync = async () => { setSyncMessage(null); try { const result = await cloudPlaylistSync.syncAll(); setSyncMessage(`已同步 ${result.playlists} 个歌单，${result.tracks} 首歌曲`); } catch (reason) { setSyncMessage(reason instanceof Error ? reason.message : String(reason)); } };
  return <NeteaseFrame title="账号"><div className="netease-account"><div className="netease-account__status"><QrCode size={30} /><div><strong>{sessionLabel(sessionState)}</strong><span>{sessionState === 'loggedIn' ? '可同步云歌单与访问账号内容' : '登录后可使用个性化内容'}</span></div></div>{sessionState === 'loggedIn' ? <button className="netease-button" type="button" onClick={() => void session.logout()}>退出登录</button> : <button className="netease-button" type="button" onClick={() => void start()}><QrCode size={17} />扫码登录</button>}{qr && sessionState !== 'loggedIn' && <img className="netease-qr" src={qr.qrimg} alt="网易云登录二维码" />}{error && <p className="netease-error">{error}</p>}{sessionState === 'loggedIn' && <button className="netease-button netease-button--secondary" type="button" onClick={() => void sync()}><CloudArrowDown size={17} />同步云歌单</button>}{syncMessage && <p className="netease-muted">{syncMessage}</p>}</div></NeteaseFrame>;
}
function sessionLabel(state: SessionState) { return ({ anonymous: '未登录', qrWaiting: '等待扫码', qrScanned: '已扫码，等待确认', loggedIn: '已登录' })[state]; }
export function CloudPlaylistsPage({ entry }: NeteasePageProps) { return <NeteaseLibraryPage entry={{ ...entry, params: { ...entry.params, segment: 'playlists' } }} />; }
