import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { TrackRecord } from '../../domains/library/ScanMachine';
import type { PlaylistRow } from '../../domains/library/LibraryService';
import type { QueueItem } from '../../domains/player/types';
import { useServices } from '../../app/providers/ServicesProvider';
import { useAppStore } from '../../stores/store';
import { useLibraryStore } from '../../stores/slices/library';
import './local.css';

export function trackToQueueItem(track: TrackRecord, contextId?: string): QueueItem {
  return { id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration ?? undefined, source: 'local', entitlement: 'free', cacheStatus: 'none', localPath: track.path, contextId };
}

export function LocalState({ kind, message, onRetry }: { kind: 'loading' | 'empty' | 'error'; message: string; onRetry?: () => void }) {
  return <div className={`local-state local-state--${kind}`} role={kind === 'error' ? 'alert' : undefined}><span>{kind === 'loading' ? '正在读取本地内容' : message}</span>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>;
}

export function TrackTable({ tracks, contextId, onRemove }: { tracks: TrackRecord[]; contextId?: string; onRemove?: (track: TrackRecord) => void }) {
  const services = useServices();
  const play = async (track: TrackRecord) => { await services.player.playNow(trackToQueueItem(track, contextId), { context: tracks.map((item) => trackToQueueItem(item, contextId)) }); };
  return <div className="local-track-table" role="table" aria-label="歌曲列表">
    <div className="local-track-header" role="row"><span>#</span><span>歌曲</span><span>专辑</span><span>时长</span><span aria-hidden="true" /></div>
    {tracks.map((track, index) => <div className="local-track-row" role="row" key={track.id} onDoubleClick={() => void play(track)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') void play(track); }}>
      <span className="local-track-index">{index + 1}</span><span className="local-track-title"><strong>{track.title}</strong><small>{track.artist}</small></span><span className="local-track-album">{track.album}</span><span>{formatDuration(track.duration)}</span><span className="local-track-actions"><button type="button" onClick={() => void play(track)} aria-label={`播放 ${track.title}`}>播放</button>{onRemove && <button type="button" onClick={() => onRemove(track)} aria-label={`移除 ${track.title}`}>移除</button>}</span>
    </div>)}
  </div>;
}

function formatDuration(seconds: number | null): string { if (!seconds || seconds < 1) return '--:--'; const minutes = Math.floor(seconds / 60); return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }

function useTracks(query: Parameters<ReturnType<typeof useServices>['library']['queryTracks']>[0] = {}) {
  const services = useServices();
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const queryKey = JSON.stringify(query);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const nextQuery = JSON.parse(queryKey) as Parameters<ReturnType<typeof useServices>['library']['queryTracks']>[0];
      void services.library.queryTracks(nextQuery).then((nextTracks) => {
        if (!cancelled) setTracks(nextTracks);
      }).catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取本地曲库');
      }).finally(() => { if (!cancelled) setLoading(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [nonce, queryKey, services]);
  return { tracks, loading, error, reload };
}

function LocalFrame({ title, eyebrow, children, actions }: { title: string; eyebrow?: string; children: ReactNode; actions?: ReactNode }) { return <main className="local-page"><header className="local-page-header"><div><p className="local-eyebrow">{eyebrow ?? '本地内容'}</p><h1>{title}</h1></div>{actions}</header>{children}</main>; }

export function LocalHomePage() { const { tracks, loading, error, reload } = useTracks({ limit: 100 }); const scan = useLibraryStore((state) => state.scanState); const services = useServices(); const [recent, setRecent] = useState<TrackRecord[]>([]); useEffect(() => { let cancelled = false; void services.playHistory.listRecent(6).then(async (entries) => { const found = await Promise.all(entries.map((entry) => services.library.getTrack(entry.track_id))); if (!cancelled) setRecent(found.filter((track): track is TrackRecord => track !== null)); }).catch(() => { if (!cancelled) setRecent([]); }); return () => { cancelled = true; }; }, [services]); return <LocalFrame title="本地内容" eyebrow="LOCAL"><section className="local-overview"><div><span className="local-kicker">本地曲库</span><strong>{loading ? '读取中' : tracks.length}</strong><span>首歌曲</span></div><div><span className="local-kicker">扫描</span><strong>{scan.phase === 'scanning' ? '进行中' : scan.phase === 'done' ? '已完成' : '待扫描'}</strong><span>{scan.currentFolder ?? '目录由设置管理'}</span></div></section>{error ? <LocalState kind="error" message={error} onRetry={reload} /> : loading ? <LocalState kind="loading" message="" /> : tracks.length ? <TrackTable tracks={tracks.slice(0, 12)} /> : <LocalState kind="empty" message="曲库为空，请在设置中添加音乐文件夹后开始扫描。" />}{recent.length > 0 && <section className="local-recent"><h2>最近播放</h2><TrackTable tracks={recent} contextId="recent" /></section>}</LocalFrame>; }

export function LocalSongsPage() { const [search, setSearch] = useState(''); const { tracks, loading, error, reload } = useTracks(search ? { search } : {}); return <LocalFrame title="歌曲" actions={<input className="local-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索歌曲、艺术家或专辑" aria-label="搜索歌曲" />}>{error ? <LocalState kind="error" message={error} onRetry={reload} /> : loading ? <LocalState kind="loading" message="" /> : tracks.length ? <TrackTable tracks={tracks} /> : <LocalState kind="empty" message={search ? '没有匹配的歌曲。' : '曲库为空。'} />}</LocalFrame>; }

export function LocalAlbumsPage() { const services = useServices(); const navigate = useAppStore((state) => state.navigate); const [items, setItems] = useState<Array<{ album: string; artist: string; count: number }>>([]); const [error, setError] = useState<string | null>(null); useEffect(() => { let cancelled = false; void services.library.listAlbums().then((rows) => { if (!cancelled) setItems(rows); }).catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : '无法读取专辑'); }); return () => { cancelled = true; }; }, [services]); return <LocalFrame title="专辑"><AggregateList empty="暂无专辑" error={error} items={items.map((item) => ({ title: item.album, detail: `${item.artist} · ${item.count} 首`, onOpen: () => navigate('local', { routeId: 'local-album', entityId: item.album, params: { album: item.album } }) }))} /></LocalFrame>; }
export function LocalArtistsPage() { const services = useServices(); const navigate = useAppStore((state) => state.navigate); const [items, setItems] = useState<Array<{ artist: string; count: number }>>([]); const [error, setError] = useState<string | null>(null); useEffect(() => { let cancelled = false; void services.library.listArtists().then((rows) => { if (!cancelled) setItems(rows); }).catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : '无法读取艺术家'); }); return () => { cancelled = true; }; }, [services]); return <LocalFrame title="艺术家"><AggregateList empty="暂无艺术家" error={error} items={items.map((item) => ({ title: item.artist, detail: `${item.count} 首`, onOpen: () => navigate('local', { routeId: 'local-artist', entityId: item.artist, params: { artist: item.artist } }) }))} /></LocalFrame>; }
export function LocalFoldersPage() {
  const services = useServices();
  const scan = useLibraryStore((state) => state.scanState);
  const folders = useLibraryStore((state) => state.folders);
  const [items, setItems] = useState<string[]>(folders);
  const [error, setError] = useState<string | null>(null);
  const chooseAndScan = async () => {
    setError(null);
    try {
      const selected = await services.dialog.pickDirectory({ title: '选择音乐文件夹' });
      if (!selected) return;
      const configured = services.settings.snapshot.libraryFolders;
      const nextFolders = Array.from(new Set([...configured, selected]));
      await services.settings.update({ libraryFolders: nextFolders });
      useLibraryStore.getState().setFolders(nextFolders);
      setItems(nextFolders);
      await services.scanMachine.scan([selected]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法扫描文件夹');
    }
  };
  const scanConfigured = async () => {
    setError(null);
    try { await services.scanMachine.scan(services.settings.snapshot.libraryFolders); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法扫描文件夹'); }
  };
  useEffect(() => {
    let cancelled = false;
    void services.library.listFolders().then((rows) => { if (!cancelled) setItems(Array.from(new Set([...services.settings.snapshot.libraryFolders, ...rows]))); }).catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : '无法读取文件夹'); });
    return () => { cancelled = true; };
  }, [services]);
  const running = scan.phase === 'scanning' || scan.phase === 'summarizing';
  return <LocalFrame title="文件夹" actions={<div className="local-folder-actions"><button type="button" onClick={() => void chooseAndScan()} disabled={running}>添加并扫描文件夹</button>{items.length > 0 && <button type="button" onClick={() => void scanConfigured()} disabled={running}>扫描全部</button>}{running && <button type="button" onClick={() => services.scanMachine.pause()}>暂停</button>}{scan.phase === 'paused' && <button type="button" onClick={() => void services.scanMachine.resume()}>继续</button>}{(running || scan.phase === 'paused') && <button type="button" onClick={() => services.scanMachine.cancel()}>取消</button>}</div>}><AggregateList empty="尚未配置文件夹" error={error} items={items.map((item) => ({ title: item, detail: '音乐目录' }))} /></LocalFrame>;
}

function AggregateList({ items, empty, error }: { items: Array<{ title: string; detail: string; onOpen?: () => void }>; empty: string; error: string | null }) { if (error) return <LocalState kind="error" message={error} />; if (!items.length) return <LocalState kind="empty" message={empty} />; return <div className="local-aggregate-list">{items.map((item) => <div className="local-aggregate-row" key={item.title}><div><strong>{item.title}</strong><span>{item.detail}</span></div>{item.onOpen && <button type="button" aria-label={`打开 ${item.title}`} onClick={item.onOpen}>打开</button>}</div>)}</div>; }

export function LocalPlaylistsPage() { const services = useServices(); const navigate = useAppStore((state) => state.navigate); const [playlists, setPlaylists] = useState<PlaylistRow[]>([]); const [name, setName] = useState(''); const [error, setError] = useState<string | null>(null); const [nonce, setNonce] = useState(0); const reload = useCallback(() => { setError(null); setNonce((value) => value + 1); }, []); useEffect(() => { let cancelled = false; void services.library.listPlaylists().then((rows) => { if (!cancelled) setPlaylists(rows); }).catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : '无法读取播放列表'); }); return () => { cancelled = true; }; }, [nonce, services]); const create = async () => { const value = name.trim(); if (!value) return; await services.library.createPlaylist(value); setName(''); reload(); }; const remove = async (id: number) => { await services.library.deletePlaylist(id); reload(); }; return <LocalFrame title="播放列表" actions={<form className="local-create" onSubmit={(event) => { event.preventDefault(); void create(); }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="新建播放列表" aria-label="播放列表名称" /><button type="submit">新建</button></form>}>{error ? <LocalState kind="error" message={error} onRetry={reload} /> : !playlists.length ? <LocalState kind="empty" message="还没有本地播放列表。" /> : <div className="local-playlists">{playlists.map((playlist) => <div className="local-playlist-row" key={playlist.id}><button className="local-playlist-open" type="button" aria-label={`打开 ${playlist.name}`} onClick={() => navigate('local', { routeId: 'local-playlist', entityId: String(playlist.id), params: { name: playlist.name } })}><strong>{playlist.name}</strong><span>本地播放列表</span></button><button type="button" aria-label={`删除 ${playlist.name}`} onClick={() => void remove(playlist.id)}>删除</button></div>)}</div>}</LocalFrame>; }
