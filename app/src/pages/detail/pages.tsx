import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Play } from '@phosphor-icons/react';
import { useServices } from '../../app/providers/ServicesProvider';
import type { RouteContext } from '../../shell/routeRegistry';
import type { NavEntry } from '../../stores/slices/nav';
import type { QueueItem } from '../../domains/player/types';
import type { TrackRecord } from '../../domains/library/ScanMachine';
import { trackToQueueItem } from '../local/LocalPages';
import './detail.css';

export type DetailProps = RouteContext;
type RecordValue = Record<string, unknown>;
type AsyncState<T> = { status: 'loading' | 'ready' | 'error'; data: T; error?: string };

export const recordOf = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object') return {};
  const record = value as RecordValue;
  return record.body && typeof record.body === 'object' ? record.body as RecordValue : record;
};
export const recordsOf = (value: unknown, ...keys: string[]): RecordValue[] => {
  const body = recordOf(value);
  for (const key of keys) {
    const candidate = body[key];
    if (Array.isArray(candidate)) return candidate.filter((item): item is RecordValue => !!item && typeof item === 'object');
    if (candidate && typeof candidate === 'object') {
      for (const nested of Object.values(candidate)) if (Array.isArray(nested)) return nested.filter((item): item is RecordValue => !!item && typeof item === 'object');
    }
  }
  return [];
};
const text = (value: unknown, fallback = '未知') => typeof value === 'string' && value.trim() ? value : fallback;
const numberId = (entry: NavEntry): string => String(entry.entityId ?? entry.params?.id ?? '');
const firstText = (...values: unknown[]) => values.find((value) => typeof value === 'string' && value.trim()) as string | undefined;
const imageOf = (row: RecordValue) => firstText(row.picUrl, row.coverImgUrl, row.coverUrl, row.img1v1Url, row.cover) ?? '';
const artistOf = (row: RecordValue) => text(row.artistName ?? row.artist ?? (row.ar as RecordValue | undefined)?.name ?? (row.artists as RecordValue[] | undefined)?.map((artist) => text(artist.name, '')).filter(Boolean).join(', '), '未知艺术家');
const durationOf = (row: RecordValue) => typeof row.dt === 'number' ? row.dt / 1000 : typeof row.duration === 'number' ? row.duration / (row.duration > 10000 ? 1000 : 1) : undefined;

function useRemote<T>(load: () => Promise<T>, initial: T): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: initial });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) setState((old) => ({ ...old, status: 'loading', error: undefined }));
      void load().then((data) => { if (!cancelled) setState({ status: 'ready', data }); }).catch((reason: unknown) => { if (!cancelled) setState((old) => ({ ...old, status: 'error', error: reason instanceof Error ? reason.message : String(reason) })); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [load, nonce]);
  return { ...state, reload };
}

export function DetailFrame({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) { return <main className="detail-page"><header className="detail-page__header"><p>{eyebrow}</p><h1>{title}</h1></header>{children}</main>; }
export function DetailState({ state, retry }: { state: AsyncState<unknown>; retry: () => void }) { if (state.status === 'loading') return <div className="detail-state" role="status">正在加载详情…</div>; if (state.status === 'error') return <div className="detail-state detail-state--error" role="alert"><strong>详情加载失败</strong><span>{state.error ?? '接口未返回可用数据'}</span><button type="button" onClick={retry}>重试</button></div>; return null; }

function queueItem(row: RecordValue, contextId: string): QueueItem | null {
  const id = row.id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const album = row.album && typeof row.album === 'object' ? (row.album as RecordValue).name : row.album;
  const ar = row.al && typeof row.al === 'object' ? (row.al as RecordValue).name : undefined;
  return { id: String(id), title: text(row.name ?? row.title), artist: artistOf(row), album: text(ar ?? album, ''), duration: durationOf(row), source: 'netease', entitlement: row.fee === 1 || row.fee === 4 ? 'vip' : 'free', cacheStatus: 'none', contextId };
}
export function NeteaseTracks({ rows, contextId }: { rows: RecordValue[]; contextId: string }) {
  const { player } = useServices();
  const playable = rows.map((row) => queueItem(row, contextId)).filter((item): item is QueueItem => item !== null);
  if (!playable.length) return <div className="detail-empty">接口未返回可播放曲目。</div>;
  return <div className="detail-tracks" role="list" aria-label="曲目列表">{playable.map((item, index) => <div className="detail-track" role="listitem" key={`${item.id}-${index}`}><span className="detail-track__index">{index + 1}</span><div><strong>{item.title}</strong><span>{item.artist}{item.album ? ` · ${item.album}` : ''}</span></div><button type="button" aria-label={`播放 ${item.title}`} onClick={() => void player.playNow(item, { context: playable })}><Play size={15} weight="fill" /></button></div>)}</div>;
}
export function LocalTracks({ tracks, contextId }: { tracks: TrackRecord[]; contextId: string }) { const { player } = useServices(); if (!tracks.length) return <div className="detail-empty">本地曲库未找到匹配曲目。</div>; const queue = tracks.map((track) => trackToQueueItem(track, contextId)); return <div className="detail-tracks" role="list" aria-label="本地曲目列表">{tracks.map((track, index) => <div className="detail-track" role="listitem" key={track.id}><span className="detail-track__index">{index + 1}</span><div><strong>{track.title}</strong><span>{track.artist} · {track.album}</span></div><button type="button" aria-label={`播放 ${track.title}`} onClick={() => void player.playNow(queue[index]!, { context: queue })}><Play size={15} weight="fill" /></button></div>)}</div>; }

export function EntityHero({ title, subtitle, cover, detail }: { title: string; subtitle: string; cover?: string; detail?: string }) { return <section className="detail-hero"><div className="detail-cover">{cover ? <img src={cover} alt={`${title} 封面`} /> : <span aria-hidden="true">♪</span>}</div><div className="detail-hero__copy"><p>{subtitle}</p><h2>{title}</h2>{detail && <span>{detail}</span>}</div></section>; }
export function idFrom(entry: NavEntry, label: string): string { const id = numberId(entry); if (!id) throw new Error(`缺少${label} ID，无法请求详情`); return id; }

export function AlbumDetailPage({ entry }: DetailProps) { const { netease } = useServices(); const id = numberId(entry); const load = useCallback(() => netease.route('/netease/album', { id }), [id, netease]); const state = useRemote(load, {}); const body = recordOf(state.data); const album = (body.album as RecordValue | undefined) ?? body; const tracks = recordsOf(state.data, 'songs', 'songs'); return <DetailFrame title={text(album.name, id ? '专辑详情' : '专辑详情')} eyebrow="NETEASE / ALBUM"><DetailState state={state} retry={state.reload} />{state.status === 'ready' && <><EntityHero title={text(album.name, '未命名专辑')} subtitle={artistOf(album)} cover={imageOf(album)} detail={text(album.description ?? album.publishTime, '')} /><NeteaseTracks rows={tracks} contextId={`album:${id}`} /></>}</DetailFrame>; }

export function PlaylistDetailPage({ entry }: DetailProps) { const { netease } = useServices(); const id = numberId(entry); const load = useCallback(async () => { const detail = await netease.route('/netease/playlist/detail', { id }); const body = recordOf(detail); const playlist = (body.playlist as RecordValue | undefined) ?? body; const tracks = Array.isArray(playlist.tracks) ? playlist.tracks.filter((item): item is RecordValue => !!item && typeof item === 'object') : []; if (tracks.length) return { detail, tracks }; const trackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds.map((item) => item && typeof item === 'object' ? (item as RecordValue).id : item).filter((trackId): trackId is string | number => typeof trackId === 'string' || typeof trackId === 'number') : []; if (!trackIds.length) return { detail, tracks: [] }; const songs = await netease.route('/netease/song/detail', { ids: trackIds.join(',') }); return { detail, tracks: recordsOf(songs, 'songs') }; }, [id, netease]); const state = useRemote(load, { detail: {}, tracks: [] as RecordValue[] }); const detail = recordOf(state.data.detail); const playlist = (detail.playlist as RecordValue | undefined) ?? detail; return <DetailFrame title={text(playlist.name, '歌单详情')} eyebrow="NETEASE / PLAYLIST"><DetailState state={state} retry={state.reload} />{state.status === 'ready' && <><EntityHero title={text(playlist.name, '未命名歌单')} subtitle={text((playlist.creator as RecordValue | undefined)?.nickname, '网易云歌单')} cover={imageOf(playlist)} detail={typeof playlist.trackCount === 'number' ? `${playlist.trackCount} 首` : undefined} /><NeteaseTracks rows={state.data.tracks} contextId={`playlist:${id}`} /></>}</DetailFrame>; }

export function ArtistDetailPage({ entry }: DetailProps) { const { netease } = useServices(); const id = numberId(entry); const load = useCallback(async () => { const [detail, songs] = await Promise.all([netease.route('/netease/artist', { id }), netease.route('/netease/artist/songs', { id, limit: 100 })]); return { detail, songs }; }, [id, netease]); const state = useRemote(load, { detail: {}, songs: {} }); const detail = recordOf(state.data.detail); const artist = (detail.data as RecordValue | undefined) ?? detail.artist as RecordValue | undefined ?? detail; const tracks = recordsOf(state.data.songs, 'songs', 'hotSongs'); return <DetailFrame title={text(artist.name, '艺术家详情')} eyebrow="NETEASE / ARTIST"><DetailState state={state} retry={state.reload} />{state.status === 'ready' && <><EntityHero title={text(artist.name, '未命名艺术家')} subtitle="网易云音乐艺术家" cover={imageOf(artist)} detail={text(artist.briefDesc ?? artist.description, '')} /><NeteaseTracks rows={tracks} contextId={`artist:${id}`} /></>}</DetailFrame>; }

export function LocalDetailPage({ entry }: DetailProps) { const { library } = useServices(); const kind = entry.routeId; const id = numberId(entry); const load = useCallback(() => kind === 'local-playlist' ? library.getPlaylistTracks(Number(id)) : library.queryTracks(kind === 'local-album' ? { album: String(entry.params?.album ?? entry.entityId ?? '') } : { artist: String(entry.params?.artist ?? entry.entityId ?? '') }), [entry.entityId, entry.params, id, kind, library]); const state = useRemote(load, [] as TrackRecord[]); const first = state.data[0]; const title = kind === 'local-playlist' ? String(entry.params?.name ?? '本地播放列表') : kind === 'local-album' ? String(entry.params?.album ?? first?.album ?? '本地专辑') : String(entry.params?.artist ?? first?.artist ?? '本地艺术家'); return <DetailFrame title={title} eyebrow={`LOCAL / ${kind.replace('local-', '').toUpperCase()}`}><DetailState state={state} retry={state.reload} />{state.status === 'ready' && <><EntityHero title={title} subtitle={`${state.data.length} 首本地曲目`} /><LocalTracks tracks={state.data} contextId={`${kind}:${id}`} /></>}</DetailFrame>; }

export function MvPage({ entry }: DetailProps) { const { netease } = useServices(); const id = numberId(entry); const load = useCallback(async () => { const [detail, url] = await Promise.all([netease.route('/netease/mv/detail', { mvid: id, id }), netease.route('/netease/mv/url', { id, mvid: id, r: 1080 })]); return { detail, url }; }, [id, netease]); const state = useRemote(load, { detail: {}, url: {} }); const detail = recordOf(state.data.detail); const mv = (detail.data as RecordValue | undefined) ?? detail.mv as RecordValue | undefined ?? detail; const urlBody = recordOf(state.data.url); const candidate = urlBody.url ?? (urlBody.data as RecordValue | undefined)?.url ?? (urlBody.data as RecordValue[] | undefined)?.[0]?.url; const videoUrl = typeof candidate === 'string' && candidate.trim() ? candidate : ''; return <DetailFrame title={text(mv.name, 'MV 播放')} eyebrow="NETEASE / MV"><DetailState state={state} retry={state.reload} />{state.status === 'ready' && <><EntityHero title={text(mv.name, '未命名 MV')} subtitle={artistOf(mv)} cover={imageOf(mv)} detail={text(mv.desc ?? mv.description, '')} />{videoUrl ? <video className="detail-video" controls poster={imageOf(mv) || undefined} src={videoUrl} aria-label={`${text(mv.name, 'MV')} 视频`} /> : <div className="detail-state detail-state--error" role="alert">接口未返回 MV 视频地址，无法播放。</div>}</>}</DetailFrame>; }
