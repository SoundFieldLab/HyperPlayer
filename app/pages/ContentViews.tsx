import { useEffect, useRef, useState } from "react";
import {
  Broadcast, CaretDown, CaretRight, CaretUp, Check, CloudArrowDown, Command, FolderOpen, Heart, Info,
  MagnifyingGlass, MusicNotes, Play, Queue, Scan, Sidebar, SlidersHorizontal, Trash, User, WifiHigh, ListPlus,
} from "@phosphor-icons/react";
import { fallbackCover } from "../artwork";
import { adaptTrack, bridge } from "../bridge";
import type { BackendCacheStatusDto, DspConfigurationDto, LibraryAlbumDto, LibraryArtistDto, LibraryFolderDto, LibraryPlaylistDto, LibraryRecentDto, NeteaseLoginStartDto, NeteaseLoginStateDto, PlaybackContextDto, TrackDto, UpdateCheckDto } from "../bridge/contracts";
import { Cover, Page, RemoteNotice, SectionTitle } from "../components/ui";
import { TrackTable } from "../components/TrackTable";
import { useRemote } from "../hooks/useRemote";
import { remoteFailure, remoteSuccess, type RemoteState } from "../remote";
import { useAppStore } from "../store";
import { SettingsView } from "./SettingsView";
import { DiscoverView } from "./DiscoverView";
import { MeterStrip, ResponseCurveSvg, SpectrumCanvas2D } from "../visualization/renderers";
import { useMainWindowTelemetry, type TelemetryFrame } from "../visualization/telemetry";

type GridItem = { id: string | number; title: string; sub: string; cover: string };

async function loadAllLibraryTracks(): Promise<TrackDto[]> {
  const tracks: TrackDto[] = [];
  let cursor: string | null = null;
  do {
    const page = await bridge.libraryQuery(undefined, cursor);
    tracks.push(...page.items.map(adaptTrack));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return tracks;
}

async function loadAllEntityTracks(kind: "album" | "artist" | "folder" | "playlist", id: string): Promise<TrackDto[]> {
  const tracks: TrackDto[] = [];
  let cursor: string | null = null;
  do {
    const page = await bridge.libraryEntityTracks(kind, id, cursor);
    tracks.push(...page.items.map(adaptTrack));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return tracks;
}

function AppTrackTable({ tracks, compact = false, playbackContext, preserveOrder = false }: { tracks: TrackDto[]; compact?: boolean; playbackContext?: PlaybackContextDto; preserveOrder?: boolean }): React.JSX.Element {
  return <TrackTable tracks={tracks} compact={compact} playbackContext={playbackContext} preserveOrder={preserveOrder}/>;
}

function AlbumGrid({ items, artist = false, onSelect }: { items: GridItem[]; artist?: boolean; onSelect: (item: GridItem) => void }): React.JSX.Element {
  return <div className="cover-grid">{items.map((item) => <button className="cover-card" key={item.id} onClick={() => onSelect(item)}><div className="cover-wrap"><Cover src={item.cover} alt="" className={artist ? "artist-cover" : ""}/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.title}</b><small>{item.sub}</small></button>)}</div>;
}

function HomeView(): React.JSX.Element {
  const domain = useAppStore((state) => state.domain);
  const navigate = useAppStore((state) => state.navigate);
  const [localTracks, reloadLocalTracks] = useRemote(
    () => domain === "local" ? bridge.libraryQuery().then((page) => page.items.map(adaptTrack)) : Promise.resolve([]),
    [domain],
    (items) => domain === "local" && items.length === 0,
  );
  const [home, reloadHome] = useRemote(() => domain === "netease" ? bridge.neteaseHome() : Promise.resolve({ recommendedTracks: [], recommendedPlaylists: [], anonymous: true, unavailableSections: [] }), [domain], (value) => domain === "netease" && value.recommendedTracks.length === 0 && value.recommendedPlaylists.length === 0);
  const tracks = domain === "local"
    ? localTracks.status === "ready" ? localTracks.data : []
    : home.status === "ready" ? home.data.recommendedTracks.map(adaptTrack) : [];
  const state = domain === "local" ? localTracks : home;
  return <Page title="我的喜欢" subtitle={domain === "local" ? "本地曲库中的常听曲目" : "来自网易云的实时推荐"} actions={<><button className="button primary" disabled={!tracks.length} onClick={() => tracks[0] && void useAppStore.getState().playTrack(tracks[0], { kind: "manual", id: null })}><Play weight="fill"/>播放全部</button><button className="button secondary" onClick={() => navigate(domain === "local" ? "folders" : "library")}><FolderOpen/>管理音乐</button></>}>
    <div className="collection-summary"><div className="collection-art" aria-hidden="true"><Heart weight="fill"/></div><div><span className="eyebrow">COLLECTION</span><h2>{tracks.length ? `${tracks.length} 首歌曲` : "你的音乐收藏"}</h2><p>{domain === "local" ? "从本地曲库整理出的私人播放空间。" : "登录后可查看收藏歌单；当前列表来自推荐服务。"}</p></div><button className="round-play" aria-label="播放全部" disabled={!tracks.length} onClick={() => tracks[0] && void useAppStore.getState().playTrack(tracks[0], { kind: "manual", id: null })}><Play weight="fill"/></button></div>
    <div className="collection-toolbar"><span>{domain === "local" ? "本地曲目" : "推荐曲目"}</span><button type="button" onClick={() => navigate("search")}><MagnifyingGlass/>筛选音乐</button></div>
    <RemoteNotice state={state} empty="这里还没有可播放的音乐" retry={domain === "local" ? reloadLocalTracks : reloadHome}/>
    {tracks.length > 0 && <AppTrackTable tracks={tracks} playbackContext={{ kind: "manual", id: null }} preserveOrder/>}
  </Page>;
}

function SearchView(): React.JSX.Element {
  const domain = useAppStore((state) => state.domain);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RemoteState<TrackDto[]>>({ status: "idle" });
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setResults({ status: "idle" }); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      setResults({ status: "loading" });
      const request = domain === "netease" ? bridge.neteaseSearch(trimmed).then((page) => page.tracks) : bridge.libraryQuery(trimmed).then((page) => page.items);
      void request.then((items) => { if (active) setResults(remoteSuccess(items.map(adaptTrack), items.length === 0)); }).catch((error: unknown) => { if (active) setResults(remoteFailure(error)); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [domain, query]);
  return <Page title="搜索" subtitle={`${domain === "netease" ? "网易云" : "本地曲库"}搜索结果`}><div className="search-page-input"><MagnifyingGlass/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="歌曲、专辑或艺术家"/></div>{!query.trim() ? <div className="search-empty"><Command/><h2>搜索音乐</h2><p>输入关键词后从当前内容域查询。</p></div> : <><SectionTitle>歌曲</SectionTitle><RemoteNotice state={results} empty="没有找到歌曲"/>{results.status === "ready" && <AppTrackTable tracks={results.data} playbackContext={{ kind: "search", id: null }}/>}</>}</Page>;
}

function LibraryView(): React.JSX.Element {
  const domain = useAppStore((state) => state.domain);
  const navigate = useAppStore((state) => state.navigate);
  const [overview, reloadOverview] = useRemote(() => bridge.libraryOverview(), [], () => false);
  const [tracks, reloadTracks] = useRemote(() => bridge.libraryQuery().then((page) => page.items.map(adaptTrack)), [], (items) => items.length === 0);
  const [scan, setScan] = useState<RemoteState<{ taskId: string }>>({ status: "idle" });
  async function startScan(): Promise<void> {
    setScan({ status: "loading" });
    try {
      const selection = await bridge.libraryPickLocation();
      if (!selection.selected || !selection.selectionTicket) {
        setScan({ status: "idle" });
        return;
      }
      const location = await bridge.libraryRegisterLocation(selection.selectionTicket);
      const accepted = await bridge.libraryStartScan([location.id]);
      setScan(remoteSuccess({ taskId: accepted.taskId }));
    } catch (error) { setScan(remoteFailure(error)); }
  }
  async function cancelScan(): Promise<void> {
    if (scan.status !== "ready") return;
    try { await bridge.libraryCancelScan(scan.data.taskId); setScan({ status: "empty", data: scan.data }); reloadOverview(); reloadTracks(); }
    catch (error) { setScan(remoteFailure(error)); }
  }
  if (domain === "netease") return <NeteaseLibraryView/>;
  const subtitle = overview.status === "ready" ? `${overview.data.trackCount.toLocaleString()} 首歌曲 · ${overview.data.albumCount.toLocaleString()} 张专辑 · ${overview.data.artistCount.toLocaleString()} 位艺术家` : "读取本地曲库";
  return <Page title="本地曲库" subtitle={subtitle} actions={<button className="button secondary" onClick={() => navigate("cache")}><CloudArrowDown/>缓存管理</button>}><div className="scan-controls"><button className="button primary" onClick={() => void startScan()} disabled={scan.status === "loading"}><FolderOpen/>选择文件夹并扫描</button>{scan.status === "ready" && <button className="button secondary" onClick={() => void cancelScan()}>取消扫描</button>}</div>{scan.status !== "idle" && scan.status !== "ready" && <RemoteNotice state={scan} empty="扫描已取消"/>}<RemoteNotice state={overview} retry={reloadOverview}/><RemoteNotice state={tracks} empty="曲库中还没有歌曲" retry={reloadTracks}/>{tracks.status === "ready" && <AppTrackTable tracks={tracks.data}/>}</Page>;
}

function NeteaseLibraryView(): React.JSX.Element {
  const [favorites, reloadFavorites] = useRemote(() => bridge.neteaseFavorites(), [], (value) => value.playlists.length === 0 && value.likedTrackIds.length === 0);
  const [account, reloadAccount] = useRemote(() => bridge.neteaseAccount(), [], () => false);
  const [cloud, reloadCloud] = useRemote(() => bridge.neteaseCloud(), [], (value) => value.songs.length === 0);
  const follows = useRemote(() => account.status === "ready" ? bridge.neteaseFollows(account.data.user.userId) : Promise.resolve({ users: [], nextCursor: null }), [account.status === "ready" ? account.data.user.userId : null], (value) => value.users.length === 0);
  const navigate = useAppStore((state) => state.navigate);
  return <Page title="网易云音乐库" subtitle="收藏、关注与云盘来自当前登录账号">
    <SectionTitle>收藏歌单</SectionTitle><RemoteNotice state={favorites} empty="暂无收藏" retry={reloadFavorites}/>{favorites.status === "ready" && <div className="cover-grid">{favorites.data.playlists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("playlist", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/></div><b>{item.name}</b><small>{item.trackCount} 首</small></button>)}</div>}
    <SectionTitle>关注</SectionTitle><RemoteNotice state={follows[0]} empty="暂无关注用户" retry={follows[1]}/>{follows[0].status === "ready" && <div className="user-strip">{follows[0].data.users.map((user) => <span key={user.userId}>{user.avatarUrl ? <Cover src={user.avatarUrl} alt="" className="avatar-image"/> : <User/>}<b>{user.nickname}</b></span>)}</div>}
    <SectionTitle>音乐云盘</SectionTitle><RemoteNotice state={cloud} empty="云盘暂无歌曲" retry={reloadCloud}/>{cloud.status === "ready" && <AppTrackTable tracks={cloud.data.songs.map((song) => adaptTrack(song.track))}/>} 
    {(account.status === "error" || account.status === "unavailable") && <RemoteNotice state={account} retry={reloadAccount}/>} 
  </Page>;
}

function LocalBrowseView({ kind }: { kind: "albums" | "artists" | "playlists" | "recent" | "folders" }): React.JSX.Element {
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [addingTracks, setAddingTracks] = useState(false);
  const [libraryChoices, setLibraryChoices] = useState<TrackDto[]>([]);
  const [query, reload] = useRemote(async () => {
    if (kind === "albums") return { kind, page: await bridge.libraryQueryAlbums() } as const;
    if (kind === "artists") return { kind, page: await bridge.libraryQueryArtists() } as const;
    if (kind === "folders") return { kind, page: await bridge.libraryQueryFolders() } as const;
    if (kind === "playlists") return { kind, page: await bridge.libraryQueryPlaylists() } as const;
    return { kind, page: await bridge.libraryQueryRecent() } as const;
  }, [kind], (value) => value.page.items.length === 0);
  const entityKind = kind === "albums" ? "album" : kind === "artists" ? "artist" : kind === "folders" ? "folder" : "playlist";
  const { detailId, detailKind, navigate, notifyError, replaceNavigation, selectedTrackIds } = useAppStore();
  const items: GridItem[] = query.status === "ready" && query.data.kind === "albums"
    ? (query.data.page.items as LibraryAlbumDto[]).map((item) => ({ id: item.id, title: item.title, sub: `${item.artists.join(" / ")} · ${item.trackCount} 首`, cover: fallbackCover(item.artworkHash ?? item.id) }))
    : query.status === "ready" && query.data.kind === "artists"
      ? (query.data.page.items as LibraryArtistDto[]).map((item) => ({ id: item.id, title: item.name, sub: `${item.albumCount} 张专辑 · ${item.trackCount} 首`, cover: fallbackCover(item.artworkHash ?? item.id) }))
      : query.status === "ready" && query.data.kind === "folders"
        ? (query.data.page.items as LibraryFolderDto[]).map((item) => ({ id: item.id, title: item.name, sub: `${item.trackCount} 首`, cover: fallbackCover(item.id) }))
        : query.status === "ready" && query.data.kind === "playlists"
          ? (query.data.page.items as LibraryPlaylistDto[]).map((item) => ({ id: item.id, title: item.name, sub: `${item.trackCount} 首`, cover: fallbackCover(item.id) }))
          : [];
  const selectedId = detailKind === entityKind && typeof detailId === "string" ? detailId : null;
  const selected = selectedId === null ? null : items.find((item) => String(item.id) === selectedId) ?? null;
  useEffect(() => {
    if (query.status === "ready" && selectedId !== null && selected === null) replaceNavigation(kind);
  }, [kind, query.status, replaceNavigation, selected, selectedId]);
  const [tracks, reloadTracks] = useRemote(
    () => selected ? loadAllEntityTracks(entityKind, String(selected.id)) : Promise.resolve([]),
    [selected?.id, entityKind],
    (items) => selected !== null && items.length === 0,
  );
  async function createPlaylist(): Promise<void> {
    const name = window.prompt("播放列表名称")?.trim();
    if (!name) return;
    setPlaylistBusy(true);
    try { await bridge.libraryCreatePlaylist(name); await reload(); }
    catch (error) { notifyError(error, "无法创建播放列表"); }
    finally { setPlaylistBusy(false); }
  }
  async function renamePlaylist(): Promise<void> {
    if (kind !== "playlists" || !selected) return;
    const name = window.prompt("重命名播放列表", selected.title)?.trim();
    if (!name || name === selected.title) return;
    setPlaylistBusy(true);
    try { await bridge.libraryRenamePlaylist(String(selected.id), name); await reload(); }
    catch (error) { notifyError(error, "无法重命名播放列表"); }
    finally { setPlaylistBusy(false); }
  }
  async function deletePlaylist(): Promise<void> {
    if (kind !== "playlists" || !selected || !window.confirm(`删除播放列表“${selected.title}”？`)) return;
    setPlaylistBusy(true);
    try { await bridge.libraryDeletePlaylist(String(selected.id)); navigate(kind); await reload(); }
    catch (error) { notifyError(error, "无法删除播放列表"); }
    finally { setPlaylistBusy(false); }
  }
  async function openAddTracks(): Promise<void> {
    setPlaylistBusy(true);
    try {
      const page = await loadAllLibraryTracks();
      setLibraryChoices(page);
      setAddingTracks(true);
    } catch (error) { notifyError(error, "无法读取本地曲库"); }
    finally { setPlaylistBusy(false); }
  }
  async function addTrack(track: TrackDto): Promise<void> {
    if (!selected) return;
    setPlaylistBusy(true);
    try { await bridge.libraryAddPlaylistTrack(String(selected.id), track.id); setAddingTracks(false); reloadTracks(); await reload(); }
    catch (error) { notifyError(error, `无法添加 ${track.title}`); }
    finally { setPlaylistBusy(false); }
  }
  async function removeSelectedTracks(): Promise<void> {
    if (!selected || tracks.status !== "ready") return;
    const targets = tracks.data.filter((track) => selectedTrackIds.includes(track.id));
    if (!targets.length) return;
    setPlaylistBusy(true);
    const results = await Promise.allSettled(targets.map((track) => bridge.libraryRemovePlaylistTrack(String(selected.id), track.id)));
    useAppStore.setState({ selectedTrackIds: [] });
    reloadTracks();
    await reload();
    setPlaylistBusy(false);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) notifyError(new Error(`${failed} 首歌曲移除失败`), "播放列表仅完成部分修改");
  }
  async function moveSelectedTrack(delta: -1 | 1): Promise<void> {
    if (!selected || tracks.status !== "ready" || selectedTrackIds.length !== 1) return;
    const current = tracks.data.findIndex((track) => track.id === selectedTrackIds[0]);
    const target = current + delta;
    if (current < 0 || target < 0 || target >= tracks.data.length) return;
    setPlaylistBusy(true);
    try { await bridge.libraryReorderPlaylistTrack(String(selected.id), selectedTrackIds[0], target); reloadTracks(); }
    catch (error) { notifyError(error, "无法调整播放列表顺序"); }
    finally { setPlaylistBusy(false); }
  }
  const selectedPlaylistTracks = tracks.status === "ready" ? tracks.data.filter((track) => selectedTrackIds.includes(track.id)) : [];
  const selectedPlaylistIndex = tracks.status === "ready" && selectedPlaylistTracks.length === 1 ? tracks.data.findIndex((track) => track.id === selectedPlaylistTracks[0].id) : -1;
  const playlistActions = kind === "playlists" && !selected ? <button className="button primary" disabled={playlistBusy} onClick={() => void createPlaylist()}><ListPlus/>新建播放列表</button> : selected && kind === "playlists" ? <><button className="button primary" disabled={playlistBusy} onClick={() => void openAddTracks()}><ListPlus/>添加歌曲</button><button className="button secondary" disabled={playlistBusy} onClick={() => void renamePlaylist()}>重命名</button><button className="button danger" disabled={playlistBusy} onClick={() => void deletePlaylist()}>删除</button></> : undefined;
  const title = { albums: "专辑", artists: "艺术家", playlists: "播放列表", recent: "最近播放", folders: "文件夹" }[kind];
  if (query.status !== "ready") {
    if (kind === "playlists" && query.status === "empty") return <Page title={title} subtitle="0 项" actions={playlistActions}><RemoteNotice state={query} empty="暂无播放列表" retry={reload}/></Page>;
    return <Page title={title} subtitle="读取本地曲库"><RemoteNotice state={query} empty={`暂无${title}`} retry={reload}/></Page>;
  }
  if (query.data.kind === "recent") return <Page title={title} subtitle={`${query.data.page.total} 条最近播放`}><AppTrackTable tracks={(query.data.page.items as LibraryRecentDto[]).map((item) => adaptTrack(item.track))}/></Page>;
  return <Page title={selected?.title ?? title} subtitle={selected ? `来自${title}` : `${query.data.page.total} 项`} actions={<>{playlistActions}{selected && <button className="button secondary" onClick={() => navigate(kind)}>返回{title}</button>}</>}>
    {selected ? <>{kind === "playlists" && selectedPlaylistTracks.length > 0 && <div className="playlist-track-actions" role="toolbar" aria-label="播放列表曲目操作"><b>已选择 {selectedPlaylistTracks.length} 首</b><button className="button secondary" disabled={playlistBusy || selectedPlaylistTracks.length !== 1 || selectedPlaylistIndex <= 0} onClick={() => void moveSelectedTrack(-1)}><CaretUp/>上移</button><button className="button secondary" disabled={playlistBusy || selectedPlaylistTracks.length !== 1 || tracks.status !== "ready" || selectedPlaylistIndex >= tracks.data.length - 1} onClick={() => void moveSelectedTrack(1)}><CaretDown/>下移</button><button className="button danger" disabled={playlistBusy} onClick={() => void removeSelectedTracks()}><Trash/>从列表移除</button></div>}<RemoteNotice state={tracks} empty="此项目暂无歌曲" retry={reloadTracks}/>{tracks.status === "ready" && <AppTrackTable tracks={tracks.data} preserveOrder={kind === "playlists"}/>}</> : <><div className="view-toolbar"><span>按名称排序</span><button><Sidebar/>调整视图</button></div><AlbumGrid items={items} artist={query.data.kind === "artists"} onSelect={(item) => navigate(kind, String(item.id), entityKind)}/></>}
    {addingTracks && <div className="modal-backdrop"><div className="playlist-picker" role="dialog" aria-modal="true" aria-labelledby="playlist-picker-title"><header><div><h2 id="playlist-picker-title">添加到 {selected?.title}</h2><p>从本地曲库选择一首歌曲</p></div><button className="icon-button" aria-label="关闭" onClick={() => setAddingTracks(false)}>×</button></header><div>{libraryChoices.length ? libraryChoices.map((track) => <button key={track.id} disabled={playlistBusy || (tracks.status === "ready" && tracks.data.some((item) => item.id === track.id))} onClick={() => void addTrack(track)}><Cover src={track.coverSeed} alt=""/><span><b>{track.title}</b><small>{track.artists.join(" / ")}</small></span><ListPlus/></button>) : <div className="remote-state empty"><MusicNotes/><b>本地曲库没有歌曲</b><span>先扫描本地音乐文件夹。</span></div>}</div></div></div>}
  </Page>;
}

function BrowseView({ kind }: { kind: "albums" | "artists" | "playlists" | "discover" | "recent" | "folders" | "songs" }): React.JSX.Element {
  if (kind === "songs") return <LibraryView/>;
  if (kind === "discover") return <DiscoverView/>;
  return <LocalBrowseView kind={kind}/>;
}

function DetailView({ type }: { type: "album" | "artist" | "playlist" }): React.JSX.Element {
  const detailId = useAppStore((state) => state.detailId);
  async function load() {
    if (typeof detailId !== "number") throw { code: "unavailable", message: "未选择可加载的网易云资源" };
    if (type === "album") { const value = await bridge.neteaseAlbumDetail(detailId); return { title: value.album.name, subtitle: value.artist?.name || "网易云专辑", description: value.description, cover: value.album.coverUrl, tracks: value.tracks.map(adaptTrack) }; }
    if (type === "artist") { const value = await bridge.neteaseArtistDetail(detailId); return { title: value.artist.name, subtitle: value.fansCount === null ? "网易云艺术家" : `${value.fansCount.toLocaleString()} 位粉丝`, description: value.introduction || value.artist.briefDescription, cover: value.artist.imageUrl, tracks: value.hotTracks.map(adaptTrack) }; }
    const value = await bridge.neteasePlaylistDetail(detailId); return { title: value.playlist.name, subtitle: `${value.playlist.trackCount} 首 · ${value.playlist.ownerName || "网易云歌单"}`, description: value.playlist.description, cover: value.playlist.coverUrl, tracks: value.tracks.map(adaptTrack) };
  }
  const [detail, reload] = useRemote(load, [type, detailId], (value) => value.tracks.length === 0);
  const [comments, reloadComments] = useRemote(() => typeof detailId === "number" && type !== "artist" ? bridge.neteaseComments(type, detailId) : Promise.resolve({ comments: [], totalCount: 0, hasMore: false, nextCursor: null }), [type, detailId], (value) => value.comments.length === 0);
  const { playTrack, enqueueTrack } = useAppStore();
  if (detail.status !== "ready") return <Page title={{ album: "专辑详情", artist: "艺术家详情", playlist: "歌单详情" }[type]} subtitle="读取网易云详情"><RemoteNotice state={detail} empty="详情中暂无曲目" retry={reload}/></Page>;
  const item = detail.data;
  const cover = item.cover || fallbackCover(String(detailId));
  const playbackContext: PlaybackContextDto = type === "album"
    ? { kind: "album", id: String(detailId) }
    : type === "playlist"
      ? { kind: "playlist", id: String(detailId) }
      : { kind: "manual", id: null };
  return <div className="page detail-page"><section className="detail-hero"><Cover src={cover} alt={item.title} className={type === "artist" ? "artist-cover" : ""}/><div><span className="eyebrow">{type === "artist" ? "艺术家" : type === "playlist" ? "歌单" : "专辑"}</span><h1>{item.title}</h1><p>{item.subtitle}</p>{item.description && <p className="detail-copy">{item.description}</p>}<div className="detail-actions"><button className="button primary" disabled={!item.tracks.length} onClick={() => item.tracks[0] && void playTrack(item.tracks[0], playbackContext)}><Play weight="fill"/>播放</button><button className="button secondary" disabled={!item.tracks.length} onClick={() => item.tracks.forEach((track) => void enqueueTrack(track))}><Queue/>加入队列</button></div></div></section><SectionTitle>{type === "artist" ? "热门歌曲" : "曲目"}</SectionTitle><AppTrackTable tracks={item.tracks} playbackContext={playbackContext}/>{type !== "artist" && <><SectionTitle>评论</SectionTitle><RemoteNotice state={comments} empty="暂无评论" retry={reloadComments}/>{comments.status === "ready" && <div className="comment-list">{comments.data.comments.map((comment) => <div key={comment.id}><User/><span><b>{comment.user?.nickname || "网易云用户"}</b><p>{comment.content}</p><small>{comment.timeText || `${comment.likedCount} 次赞`}</small></span></div>)}</div>}</>}</div>;
}

function AccountView(): React.JSX.Element {
  const [status, reloadStatus] = useRemote(() => bridge.neteaseStatus(), [], () => false);
  const [account, reloadAccount] = useRemote(() => bridge.neteaseAccount(), [], () => false);
  const [login, setLogin] = useState<RemoteState<NeteaseLoginStartDto>>({ status: "idle" });
  const [poll, setPoll] = useState<RemoteState<NeteaseLoginStateDto>>({ status: "idle" });
  const pollGeneration = useRef(0);
  async function startLogin(): Promise<void> {
    pollGeneration.current += 1;
    setLogin({ status: "loading" }); setPoll({ status: "idle" });
    try { setLogin(remoteSuccess(await bridge.neteaseStartQrLogin())); }
    catch (error) { setLogin(remoteFailure(error)); }
  }
  useEffect(() => {
    if (login.status !== "ready") return;
    const generation = ++pollGeneration.current;
    let timer = 0;
    async function run(): Promise<void> {
      try {
        if (login.status !== "ready") return;
        const value = await bridge.neteasePollQrLogin(login.data.loginId);
        if (generation !== pollGeneration.current) return;
        setPoll(remoteSuccess(value));
        if (value.phase === "waiting" || value.phase === "scanned") timer = window.setTimeout(run, 1800);
        if (value.phase === "confirmed") { reloadStatus(); reloadAccount(); }
      } catch (error) { if (generation === pollGeneration.current) setPoll(remoteFailure(error)); }
    }
    void run();
    return () => { pollGeneration.current += 1; window.clearTimeout(timer); };
  }, [login.status === "ready" ? login.data.loginId : null]);
  async function logout(): Promise<void> { try { await bridge.neteaseLogout(); reloadStatus(); } catch (error) { setPoll(remoteFailure(error)); } }
  const actual = status.status === "ready" ? status.data : null;
  const profile = account.status === "ready" ? account.data : null;
  const phaseText = poll.status === "ready" ? ({ waiting: "等待扫码", scanned: "已扫码，请在手机上确认", confirmed: "登录成功", expired: "二维码已过期", failed: "登录失败" }[poll.data.phase]) : "二维码由网易云登录 command 实时生成";
  return <Page title="网易云账号" subtitle="凭据仅由 Rust 后端管理"><RemoteNotice state={status} retry={reloadStatus}/>{actual && !actual.enabled && <div className="remote-state unavailable"><Info/><b>网易云内容域已禁用</b><span>可在设置中重新启用。</span></div>}{actual?.authenticated ? <div className="account-signed-in">{profile?.user.avatarUrl ? <Cover src={profile.user.avatarUrl} alt="" className="avatar-image"/> : <User/>}<div><h2>{profile?.user.nickname || actual.displayName || "已登录网易云"}</h2><p>{profile ? `${profile.vip.active ? `VIP${profile.vip.level ?? ""}` : "普通账号"} · 权益校验 ${new Date(profile.vip.verifiedAtMs).toLocaleString()}` : actual.userId ? `账号 ${actual.userId}` : "正在读取账号权益"}</p></div><button className="button secondary" onClick={() => void logout()}>退出登录</button></div> : actual?.enabled && <div className="account-layout"><section className="login-pane">{login.status === "ready" ? <img className="qr-image" src={login.data.qrImageDataUrl} alt="网易云登录二维码"/> : login.status === "idle" ? <div className="remote-state empty"><Info/><b>尚未生成二维码</b><span>点击下方按钮向后端请求二维码。</span></div> : <RemoteNotice state={login} retry={() => void startLogin()}/>}<h2>使用网易云音乐扫码</h2><p>{phaseText}</p><button className="button primary" onClick={() => void startLogin()} disabled={login.status === "loading"}>{login.status === "ready" ? "刷新二维码" : "获取二维码"}</button>{poll.status === "error" || poll.status === "unavailable" ? <RemoteNotice state={poll}/> : null}</section><section className="account-benefits"><h2>账号能力</h2><div><Heart/><span><b>喜欢与收藏</b><small>以服务端实际返回为准</small></span></div><div><CloudArrowDown/><span><b>权益缓存</b><small>同账号实时权益校验，失败时拒绝播放</small></span></div><div className="privacy-note"><Info/>原始 Cookie 不进入界面。</div></section></div>}</Page>;
}

function MessagesView(): React.JSX.Element { return <Page title="消息" subtitle="尚无消息 command"><div className="remote-state unavailable"><Info/><b>此功能当前不可用</b><span>正式模式不会显示虚构未读消息。</span></div></Page>; }

function CacheView(): React.JSX.Element {
  const playback = useAppStore((state) => state.playback);
  const [stats, reloadStats] = useRemote(() => bridge.cacheStats(), [], () => false);
  const track = playback?.current;
  const [trackStatus, setTrackStatus] = useState<RemoteState<BackendCacheStatusDto>>({ status: "idle" });
  function loadTrackStatus(): void {
    if (!track) { setTrackStatus({ status: "empty", data: null as never }); return; }
    setTrackStatus({ status: "loading" });
    void bridge.cacheStatus({ id: track.id, source: track.source }).then((data) => setTrackStatus(remoteSuccess(data))).catch((error: unknown) => setTrackStatus(remoteFailure(error)));
  }
  useEffect(loadTrackStatus, [track?.id, track?.source]);
  async function run(action: "cache" | "remove" | "clear"): Promise<void> {
    setTrackStatus({ status: "loading" });
    try {
      if (action === "clear") await bridge.cacheClear();
      else if (track) action === "cache" ? await bridge.cacheTrack({ id: track.id, source: track.source }, track.quality) : await bridge.cacheRemove({ id: track.id, source: track.source });
      reloadStats(); loadTrackStatus();
    } catch (error) { setTrackStatus(remoteFailure(error)); }
  }
  function formatBytes(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(2)} GB`; }
  return <Page title="缓存" subtitle="应用私有缓存，不提供文件导出" actions={<button className="button secondary" onClick={() => void run("clear")}>清空缓存</button>}><RemoteNotice state={stats} retry={reloadStats}/>{stats.status === "ready" && <div className="stats-strip"><span><b>{formatBytes(stats.data.bytesUsed)}</b><small>缓存占用</small></span><span><b>{stats.data.entryCount}</b><small>缓存条目</small></span><span><b>{stats.data.activeTasks}</b><small>活动任务</small></span><span><b>{stats.data.lockedEntries}</b><small>权益锁定</small></span></div>}<SectionTitle>当前曲目</SectionTitle>{!track ? <div className="remote-state empty"><Info/><b>没有当前曲目</b><span>开始播放后可查看或管理该曲目的缓存。</span></div> : <div className="cache-track"><Cover src={track.coverSeed} alt=""/><span><b>{track.title}</b><small>{track.artists.join(" / ")}</small></span>{trackStatus.status === "ready" && <em>{trackStatus.data.status}</em>}<button className="button secondary" onClick={() => void run("cache")}>缓存</button><button className="button secondary" onClick={() => void run("remove")}>移除</button></div>} {(trackStatus.status === "error" || trackStatus.status === "unavailable") && <RemoteNotice state={trackStatus} retry={loadTrackStatus}/>}<div className="notice"><Info/>VIP 缓存仅在当前登录同一账号且服务端实时确认权益有效时播放；校验失败将保持锁定。</div></Page>;
}

function StatusView(): React.JSX.Element {
  const tasks = useAppStore((state) => state.tasks);
  const [updater, reloadUpdater] = useRemote(() => bridge.updaterStatus(), [], () => false);
  const [check, setCheck] = useState<RemoteState<UpdateCheckDto>>({ status: "idle" });
  async function checkUpdate(): Promise<void> { setCheck({ status: "loading" }); try { setCheck(remoteSuccess(await bridge.updaterCheck())); } catch (error) { setCheck(remoteFailure(error)); } }
  const [installing, setInstalling] = useState(false);
  async function installUpdate(): Promise<void> {
    setInstalling(true);
    try {
      if (check.status !== "ready" || !check.data.version) return;
      const installed = await bridge.updaterUpdate(check.data.version);
      if (!installed && check.status === "ready") {
        setCheck(remoteSuccess({ ...check.data, available: false, version: null, notes: null }));
      }
    } catch (error) { setCheck(remoteFailure(error)); } finally { setInstalling(false); }
  }
  return <Page title="状态中心" subtitle="扫描、缓存、同步与更新"><SectionTitle>正在进行</SectionTitle>{tasks.length ? <div className="task-list">{tasks.map((task) => <div key={task.id}><span className={`task-icon ${task.state}`}>{task.kind === "scan" ? <Scan/> : task.kind === "cache" ? <CloudArrowDown/> : <WifiHigh/>}</span><span><b>{task.title}</b><small>{task.detail}</small>{task.progress !== null && <i className="progress"><i style={{width:`${task.progress * 100}%`}}/></i>}</span></div>)}</div> : <div className="remote-state empty"><Check/><b>没有后台任务</b><span>仅显示本次运行中由后端事件报告的任务。</span></div>}<SectionTitle>应用更新</SectionTitle><RemoteNotice state={updater} retry={reloadUpdater}/>{updater.status === "ready" && <div className="updater-row"><span><b>{updater.data.enabled ? "更新检查可用" : "更新器不可用"}</b><small>{updater.data.reason || "可检查新版本"}</small></span><button className="button secondary" disabled={!updater.data.enabled || check.status === "loading" || installing} onClick={() => void checkUpdate()}>检查更新</button></div>}{check.status === "ready" && <div className="notice"><Info/>{check.data.available ? <><span>发现版本 {check.data.version}</span><button className="button primary" disabled={installing} onClick={() => void installUpdate()}>{installing ? "安装中" : "下载并安装"}</button></> : `当前已是最新版本 ${check.data.currentVersion}`}</div>}{(check.status === "error" || check.status === "unavailable") && <RemoteNotice state={check}/>}</Page>;
}

const FLAT_DSP_RESPONSE = [
  { frequencyHz: 20, gainDb: 0 },
  { frequencyHz: 20_000, gainDb: 0 },
] as const;

type DspSectionKey = Exclude<keyof DspConfigurationDto, "revision" | "midSide">;
const DSP_MODULES: Array<[string, string, DspSectionKey | "midSide" | "lufsTap"]> = [
  ["01", "响度归一化", "loudnessNormalization"], ["02", "环绕运动", "surround3d"],
  ["03", "M/S 声场", "midSide"], ["04", "参数均衡", "preEq"],
  ["05", "齿音控制", "deesser"], ["06", "动态压缩", "compressor"],
  ["07", "夜间模式", "nightMode"], ["08", "延迟", "delay"], ["09", "合唱", "chorus"],
  ["10", "镶边", "flanger"], ["11", "移相", "phaser"], ["12", "颤音", "tremolo"],
  ["13", "混响", "reverb"], ["14", "低频增强", "bassEnhancer"],
  ["15", "等响度补偿", "loudnessComp"], ["16/17", "智能均衡 + 频谱分析", "ieq"],
  ["18", "动态均衡", "dynamicEq"], ["19", "LUFS 测量", "lufsTap"],
  ["20", "参数调制", "modulation"], ["21", "限制器", "limiter"],
  ["22", "空间音频", "spatial"],
];
const LABELS: Record<string, string> = { targetLufs: "目标 LUFS", maxGainDb: "最大增益 dB", minGainDb: "最小增益 dB", useRealtimeMeter: "实时测量", externalGainDb: "外部增益 dB", distance: "距离", speed: "速度", angle: "角度", direction: "方向", stereoWidth: "宽度", voiceBalance: "人声平衡", bandCount: "频段数", qCompensation: "Q 补偿", stereoMode: "立体声模式", centerHz: "中心频率 Hz", q: "Q", thresholdDb: "阈值 dB", ratio: "压缩比", attackMs: "启动 ms", releaseMs: "释放 ms", splitBand: "分频处理", mix: "混合", kneeDb: "拐点 dB", makeupDb: "补偿 dB", outputGain: "输出增益", amount: "强度", delayMs: "延迟 ms", feedback: "反馈", rateHz: "速率 Hz", depthMs: "深度 ms", depth: "深度", stages: "级数", cutoffHz: "截止频率 Hz", harmonicType: "谐波类型", harmonicGain: "谐波增益", levelDb: "电平 dB", lowBoostDb: "低频提升 dB", mode: "模式", reverbType: "混响类型", roomSize: "房间大小", damping: "阻尼", wet: "湿声增益", dry: "干声增益", preDelayMs: "预延迟 ms", width: "声场宽度", fdnLines: "FDN 线数", partitionSize: "最短分区（样本）", shortRegionMs: "短区段时长 ms", preset: "场景预设", volumePercent: "音量百分比", smoothingSeconds: "平滑时间 s", blockSize: "分析块长（样本）", strength: "处理强度", truePeak: "真峰值检测", targetGainDb: "目标增益 dB", frequency: "频率 Hz", gain: "增益 dB", targetCurve: "目标曲线", timeConstantSec: "平滑时间 s", lfoShape: "LFO 波形", lfoRateHz: "LFO 速率 Hz", lfoDepth: "LFO 深度", envelopeAttackMs: "包络启动 ms", envelopeReleaseMs: "包络释放 ms", envelopeAmount: "包络输出量", polarity: "极性", smoothingMs: "路由平滑 ms", masterGain: "主增益", instantAmount: "干湿量", instantSpreadDeg: "展开角 度", instantRoom: "房间预设", instantRoomAmount: "房间混合", distanceModel: "距离模型", refDistance: "参考距离 m", maxDistance: "最大距离 m", convolution: "卷积实现", hrtfInterp: "HRTF 插值", stagePreset: "舞台布局", seat: "座位", stageRoomSize: "房间缩放", stageReverbAmount: "混响量", worldOcclusion: "遮挡量", ambienceEnabled: "环境声层", ambienceAmount: "环境声强度" };
type DspNumberConstraint = { min: number; max: number; step: number; integer?: boolean };
const DSP_CONSTRAINTS: Record<string, Record<string, DspNumberConstraint>> = {
  loudnessNormalization: {
    targetLufs: { min: -40, max: 0, step: 0.1 }, maxGainDb: { min: 0, max: 24, step: 0.1 }, minGainDb: { min: -24, max: 0, step: 0.1 }, externalGainDb: { min: -24, max: 24, step: 0.1 },
  },
  surround3d: { distance: { min: 0, max: 10, step: 0.01 }, speed: { min: 0, max: 10, step: 0.1 }, angle: { min: -360, max: 360, step: 1 } },
  midSide: { stereoWidth: { min: 0, max: 2, step: 0.01 }, voiceBalance: { min: -1, max: 1, step: 0.01 } },
  preEq: { bandCount: { min: 1, max: 20, step: 1, integer: true }, frequency: { min: 20, max: 20_000, step: 1 }, gain: { min: -20, max: 20, step: 0.1 }, q: { min: 0.1, max: 10, step: 0.1 } },
  deesser: { centerHz: { min: 100, max: 16_000, step: 1 }, q: { min: 0.1, max: 10, step: 0.1 }, thresholdDb: { min: -60, max: 0, step: 0.1 }, ratio: { min: 1, max: 50, step: 0.1 }, attackMs: { min: 0, max: 100, step: 0.1 }, releaseMs: { min: 0, max: 2_000, step: 1 }, mix: { min: 0, max: 1, step: 0.01 } },
  compressor: { thresholdDb: { min: -60, max: 0, step: 0.1 }, ratio: { min: 1, max: 50, step: 0.1 }, kneeDb: { min: 0, max: 24, step: 0.1 }, attackMs: { min: 0, max: 500, step: 0.1 }, releaseMs: { min: 0, max: 3_000, step: 1 }, makeupDb: { min: -24, max: 24, step: 0.1 }, outputGain: { min: 0, max: 2, step: 0.01 } },
  nightMode: { amount: { min: 0, max: 10, step: 0.01 } },
  delay: { delayMs: { min: 0, max: 2_000, step: 1 }, feedback: { min: 0, max: 0.98, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 } },
  chorus: { rateHz: { min: 0.01, max: 20, step: 0.01 }, depthMs: { min: 0, max: 50, step: 0.1 }, mix: { min: 0, max: 1, step: 0.01 } },
  flanger: { rateHz: { min: 0.01, max: 20, step: 0.01 }, depthMs: { min: 0, max: 50, step: 0.1 }, feedback: { min: 0, max: 0.98, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 } },
  phaser: { rateHz: { min: 0.01, max: 20, step: 0.01 }, depth: { min: 0, max: 1, step: 0.01 }, feedback: { min: 0, max: 0.98, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 }, stages: { min: 2, max: 8, step: 1, integer: true } },
  tremolo: { rateHz: { min: 0.01, max: 30, step: 0.01 }, depth: { min: 0, max: 1, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 } },
  reverb: { roomSize: { min: 0, max: 1, step: 0.01 }, damping: { min: 0, max: 1, step: 0.01 }, wet: { min: 0, max: 4, step: 0.01 }, dry: { min: 0, max: 4, step: 0.01 }, preDelayMs: { min: 0, max: 1000, step: 1 }, width: { min: 0, max: 2, step: 0.01 }, fdnLines: { min: 2, max: 16, step: 1, integer: true }, mix: { min: 0, max: 1, step: 0.01 }, partitionSize: { min: 32, max: 8192, step: 1, integer: true }, shortRegionMs: { min: 0, max: 5000, step: 10 } },
  bassEnhancer: { cutoffHz: { min: 20, max: 500, step: 1 }, q: { min: 0.1, max: 10, step: 0.1 }, harmonicGain: { min: 0, max: 1, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 }, levelDb: { min: -6, max: 6, step: 0.1 }, lowBoostDb: { min: -6, max: 12, step: 0.1 } },
  loudnessComp: { volumePercent: { min: 0, max: 100, step: 1 }, maxBoostDb: { min: 0, max: 24, step: 0.1 }, smoothingSeconds: { min: 0.01, max: 10, step: 0.01 }, frequency: { min: 20, max: 20_000, step: 1 }, gain: { min: -24, max: 24, step: 0.1 } },
  ieq: { strength: { min: 0, max: 1, step: 0.01 }, timeConstantSec: { min: 0.1, max: 10, step: 0.01 } },
  dynamicEq: { strength: { min: 0, max: 1, step: 0.01 }, thresholdDb: { min: -80, max: 0, step: 0.1 }, ratio: { min: 1, max: 100, step: 0.1 }, kneeDb: { min: 0, max: 40, step: 0.1 }, attackMs: { min: 0, max: 1000, step: 0.1 }, releaseMs: { min: 0, max: 5000, step: 1 }, blockSize: { min: 16, max: 2048, step: 1, integer: true }, frequency: { min: 30, max: 20_000, step: 1 }, targetGainDb: { min: -12, max: 12, step: 0.1 } },
  modulation: { lfoRateHz: { min: 0, max: 1000, step: 0.1 }, lfoDepth: { min: 0, max: 1, step: 0.01 }, envelopeAttackMs: { min: 0.05, max: 5000, step: 0.1 }, envelopeReleaseMs: { min: 0.05, max: 5000, step: 1 }, envelopeAmount: { min: 0, max: 1, step: 0.01 } },
  limiter: { thresholdDb: { min: -60, max: 0, step: 0.1 }, lookaheadMs: { min: 0, max: 20, step: 0.1 }, attackMs: { min: 0, max: 100, step: 0.1 }, releaseMs: { min: 0, max: 1000, step: 1 } },
  spatial: { masterGain: { min: 0.5, max: 1, step: 0.01 }, instantAmount: { min: 0, max: 1, step: 0.01 }, instantSpreadDeg: { min: 20, max: 120, step: 1 }, instantRoomAmount: { min: 0, max: 1, step: 0.01 }, refDistance: { min: 0.1, max: 100, step: 0.1 }, maxDistance: { min: 0.2, max: 1000, step: 1 }, stageRoomSize: { min: 0.5, max: 2, step: 0.01 }, stageReverbAmount: { min: 0, max: 1, step: 0.01 }, worldOcclusion: { min: 0, max: 1, step: 0.01 }, ambienceAmount: { min: 0, max: 1, step: 0.01 } },
};

function validateNumber(value: unknown, constraint: DspNumberConstraint, label: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${label}不能为空且必须是有限数值`;
  if (value < constraint.min || value > constraint.max) return `${label}必须在 ${constraint.min} 到 ${constraint.max} 之间`;
  if (constraint.integer && !Number.isInteger(value)) return `${label}必须是整数`;
  return null;
}

function validateDspDraft(draft: DspConfigurationDto | null): string[] {
  if (!draft) return ["DSP 配置尚未加载"];
  const errors: string[] = [];
  if (!Number.isSafeInteger(Number(draft.revision)) || Number(draft.revision) <= 0) errors.push("配置 revision 必须是正整数");
  // bands 专属约束键不作为标量校验（与 preEq 同理，另行逐带校验）。
  const bandOnlyFields = new Set(["frequency", "gain", "targetGainDb"]);
  for (const [sectionKey, constraints] of Object.entries(DSP_CONSTRAINTS)) {
    if (sectionKey === "preEq") continue;
    const section = draft[sectionKey as keyof DspConfigurationDto] as unknown as Record<string, unknown>;
    for (const [field, constraint] of Object.entries(constraints)) {
      if (bandOnlyFields.has(field) && "bands" in section) continue;
      if (sectionKey === "bassEnhancer" && field === "lowBoostDb" && section[field] === null) continue;
      const error = validateNumber(section[field], constraint, `${LABELS[field] ?? field}`);
      if (error) errors.push(error);
    }
  }
  const countError = validateNumber(draft.preEq.bandCount, DSP_CONSTRAINTS.preEq.bandCount, "频段数");
  if (countError) errors.push(countError);
  if (draft.preEq.bands.length !== draft.preEq.bandCount) errors.push("频段数必须与均衡器频段数量一致");
  draft.preEq.bands.forEach((band, index) => {
    for (const field of ["frequency", "gain", "q"] as const) {
      const error = validateNumber(band[field], DSP_CONSTRAINTS.preEq[field], `频段 ${index + 1} ${field === "frequency" ? "频率" : field === "gain" ? "增益" : "Q"}`);
      if (error) errors.push(error);
    }
  });
  if (![-1, 1].includes(draft.surround3d.direction)) errors.push("方向必须为逆向或正向");
  if (!["independent", "hseShared"].includes(draft.preEq.stereoMode)) errors.push("立体声模式无效");
  if (!["odd", "even", "atan", "soft"].includes(draft.bassEnhancer.harmonicType)) errors.push("谐波类型无效");
  if (!["algorithmic", "fdn", "convolution"].includes(draft.reverb.mode)) errors.push("混响模式无效");
  if (!["hall", "room", "plate", "spring", "stage"].includes(draft.reverb.reverbType)) errors.push("混响类型无效");
  if (![2, 4, 8, 16].includes(draft.reverb.fdnLines)) errors.push("FDN 线数必须为 2、4、8 或 16");
  if (!["auto", "preset", "custom"].includes(draft.loudnessComp.mode)) errors.push("等响度模式无效");
  if (!["flat", "bass", "vocal", "warm", "bright", "night"].includes(draft.loudnessComp.preset)) errors.push("等响度场景预设无效");
  draft.loudnessComp.bands.forEach((band, index) => {
    const frequencyError = validateNumber(band.frequency, DSP_CONSTRAINTS.loudnessComp.frequency, `等响度频点 ${index + 1} 频率`);
    if (frequencyError) errors.push(frequencyError);
    const gainError = validateNumber(band.gain, DSP_CONSTRAINTS.loudnessComp.gain, `等响度频点 ${index + 1} 增益`);
    if (gainError) errors.push(gainError);
  });
  if (draft.dynamicEq.bands.length !== 5) errors.push("动态均衡必须固定 5 个频段");
  draft.dynamicEq.bands.forEach((band, index) => {
    // 末带（第 5 带）交叉频率被引擎忽略，仅要求有限值。
    if (index < 4) {
      const frequencyError = validateNumber(band.frequency, DSP_CONSTRAINTS.dynamicEq.frequency, `动态均衡频段 ${index + 1} 频率`);
      if (frequencyError) errors.push(frequencyError);
    } else if (!Number.isFinite(band.frequency)) {
      errors.push(`动态均衡频段 5 频率不能为空且必须是有限数值`);
    }
    const gainError = validateNumber(band.targetGainDb, DSP_CONSTRAINTS.dynamicEq.targetGainDb, `动态均衡频段 ${index + 1} 目标增益`);
    if (gainError) errors.push(gainError);
  });
  if (!["flat", "warm", "bright", "vocal"].includes(draft.ieq.targetCurve)) errors.push("智能均衡目标曲线无效");
  if (!["sine", "triangle", "square", "saw"].includes(draft.modulation.lfoShape)) errors.push("LFO 波形无效");
  if (draft.modulation.routes.length > 8) errors.push("调制路由最多 8 条");
  draft.modulation.routes.forEach((route, index) => {
    if (!["lfo", "envelope"].includes(route.source)) errors.push(`路由 ${index + 1} 源无效`);
    if (!["masterGain", "stereoWidth"].includes(route.target)) errors.push(`路由 ${index + 1} 目标无效`);
    if (route.polarity !== 1 && route.polarity !== -1) errors.push(`路由 ${index + 1} 极性必须为 +1 或 -1`);
  });
  if (!["off", "instant", "headLocked", "world", "stage"].includes(draft.spatial.mode)) errors.push("空间模式无效");
  if (!["off", "studio", "hall", "stage", "church", "outdoor", "bathroom", "corridor"].includes(draft.spatial.instantRoom)) errors.push("空间房间预设无效");
  if (!["inverse", "linear", "exponential"].includes(draft.spatial.distanceModel)) errors.push("距离模型无效");
  if (!["time", "partitioned"].includes(draft.spatial.convolution)) errors.push("空间卷积实现无效");
  if (!["nearest", "spherical"].includes(draft.spatial.hrtfInterp)) errors.push("HRTF 插值无效");
  if (!["stage", "cinema", "piano", "nature"].includes(draft.spatial.stagePreset)) errors.push("舞台布局无效");
  if (!["front", "middle", "back"].includes(draft.spatial.seat)) errors.push("座位无效");
  if (draft.spatial.maxDistance <= draft.spatial.refDistance + 0.1) errors.push("最大距离必须大于参考距离 + 0.1");
  return errors;
}

function DspField({ label, value, constraint, onChange }: { label: string; value: unknown; constraint?: DspNumberConstraint; onChange(value: unknown): void }): React.JSX.Element {
  if (typeof value === "boolean") return <label className="dsp-toggle-field"><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)}/><span>{LABELS[label] ?? label}</span></label>;
  if (label === "harmonicType") return <label><span>{LABELS[label]}</span><select value={String(value)} onChange={(event) => onChange(event.target.value)}><option value="odd">Odd</option><option value="even">Even</option><option value="atan">Atan</option><option value="soft">Soft</option></select></label>;
  if (label === "stereoMode") return <label><span>{LABELS[label]}</span><select value={String(value)} onChange={(event) => onChange(event.target.value)}><option value="independent">独立声道</option><option value="hseShared">HSE 共享</option></select></label>;
  if (label === "direction") return <label><span>{LABELS[label]}</span><select value={String(value)} onChange={(event) => onChange(Number(event.target.value))}><option value="-1">逆向</option><option value="1">正向</option></select></label>;
  return <label><span>{LABELS[label] ?? label}</span><input aria-label={LABELS[label] ?? label} type="number" min={constraint?.min} max={constraint?.max} step={constraint?.step} value={value === null ? "" : String(value)} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}/></label>;
}

function resizeEqBands(draft: DspConfigurationDto, requestedCount: number): DspConfigurationDto {
  const bandCount = Math.max(1, Math.min(20, Math.trunc(requestedCount)));
  const bands = draft.preEq.bands.slice(0, bandCount);
  while (bands.length < bandCount) {
    const previous = bands.at(-1) ?? { frequency: 1000, gain: 0, q: 1 };
    const frequency = previous.frequency >= 20_000 ? 20_000 : Math.min(20_000, Math.round(previous.frequency + (20_000 - previous.frequency) / 2));
    bands.push({ frequency, gain: previous.gain, q: previous.q });
  }
  return { ...draft, preEq: { ...draft.preEq, bandCount, bands } };
}

// 枚举型字段（mode/reverbType/preset/fdnLines）以下拉选择渲染，不进入数字输入。
const DSP_ENUM_FIELDS: Record<string, Record<string, Array<[string, string]>>> = {
  reverb: {
    mode: [["algorithmic", "算法混响"], ["fdn", "FDN 混响"], ["convolution", "卷积混响"]],
    reverbType: [["hall", "音乐厅"], ["room", "房间"], ["plate", "金属板"], ["spring", "弹簧"], ["stage", "舞台"]],
    fdnLines: [["2", "2 线"], ["4", "4 线"], ["8", "8 线"], ["16", "16 线"]],
  },
  loudnessComp: {
    mode: [["auto", "自动"], ["preset", "预设"], ["custom", "自定义"]],
    preset: [["flat", "平直"], ["bass", "低频"], ["vocal", "人声"], ["warm", "温暖"], ["bright", "明亮"], ["night", "夜间"]],
  },
  spatial: {
    mode: [["off", "关闭"], ["instant", "即时展开"], ["headLocked", "头锁定"], ["world", "世界模式"], ["stage", "舞台模式"]],
    instantRoom: [["off", "无"], ["studio", "录音室"], ["hall", "音乐厅"], ["stage", "舞台"], ["church", "教堂"], ["outdoor", "户外"], ["bathroom", "浴室"], ["corridor", "走廊"]],
    distanceModel: [["inverse", "反比"], ["linear", "线性"], ["exponential", "指数"]],
    convolution: [["partitioned", "分区卷积"], ["time", "时域卷积"]],
    hrtfInterp: [["nearest", "最近邻"], ["spherical", "球面插值"]],
    stagePreset: [["stage", "舞台"], ["cinema", "影院"], ["piano", "钢琴"], ["nature", "自然"]],
    seat: [["front", "前排"], ["middle", "中排"], ["back", "后排"]],
  },
};

function formatLufs(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)} LUFS` : "—";
}

function formatPeak(left: number | null, right: number | null): string {
  if (left === null || right === null) return "—";
  return `${Math.max(left, right).toFixed(2)} dBFS`;
}

function SpatialFieldSvg({ mode, spreadDeg }: { mode: DspConfigurationDto["spatial"]["mode"]; spreadDeg: number }): React.JSX.Element | null {
  // 克制的 2D 顶视示意（DOM/SVG，无 GPU context，UI-D80 边界）：中心听者 +
  // 按模式示意扬声器/音源布局；仅静态示意，不代表实际 HRTF 采样位置。
  if (mode === "off") return null;
  const heading = <text x="44" y="52" textAnchor="middle" fontSize="9" fill="currentColor">前</text>;
  const listener = <g><circle cx="44" cy="30" r="5" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="44" y1="25" x2="44" y2="21" stroke="currentColor" strokeWidth="1.2"/></g>;
  const speaker = (angleDeg: number, radius: number) => {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return <circle key={`${angleDeg}-${radius}`} cx={44 + radius * Math.cos(rad)} cy={30 - radius * Math.sin(rad)} r="2.4" fill="currentColor"/>;
  };
  const points: React.JSX.Element[] = [];
  if (mode === "instant") {
    const half = Math.max(10, Math.min(60, spreadDeg / 2));
    points.push(speaker(-half, 22), speaker(half, 22));
  } else if (mode === "headLocked") {
    points.push(speaker(-90, 10), speaker(90, 10));
  } else if (mode === "world") {
    for (const angle of [-30, 30, -110, 110, 180]) points.push(speaker(angle, 22));
  } else if (mode === "stage") {
    points.push(speaker(-25, 20), speaker(0, 22), speaker(25, 20), speaker(-110, 18), speaker(110, 18));
  }
  return <svg className="spatial-field" role="img" aria-label={`空间场示意（${mode} 模式）`} viewBox="0 0 88 60" width="88" height="60">
    {heading}
    {mode === "stage" && <rect x="16" y="10" width="56" height="40" rx="3" fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.5"/>}
    {listener}
    {points}
  </svg>;
}

function DspModule({ index, title, sectionKey, draft, setDraft, frame }: { index: string; title: string; sectionKey: DspSectionKey | "midSide" | "lufsTap"; draft: DspConfigurationDto; setDraft(next: DspConfigurationDto): void; frame?: TelemetryFrame | null }): React.JSX.Element {
  if (sectionKey === "lufsTap") {
    if (!frame?.lufs) {
      return <article className="dsp-module dsp-readonly"><span>{index}</span><div className="dsp-module-body"><b>{title}</b><small>LUFS tap 已接；等待实时读数（需播放中）。</small></div><em>READ ONLY</em></article>;
    }
    const { lufs, meters } = frame;
    return <article className="dsp-module dsp-readonly"><span>{index}</span><div className="dsp-module-body"><b>{title}</b><div className="dsp-lufs"><dl><dt>Integrated LUFS</dt><dd>{formatLufs(lufs.integrated)}</dd><dt>Momentary LUFS</dt><dd>{formatLufs(lufs.momentary)}</dd><dt>Short-term LUFS</dt><dd>{formatLufs(lufs.shortTerm)}</dd><dt>True Peak dBFS</dt><dd>{formatPeak(meters.truePeakLeft, meters.truePeakRight)}</dd><dt>Limiter Reduction dB</dt><dd>{meters.limiterReduction !== null ? `${meters.limiterReduction.toFixed(2)}` : "—"}</dd></dl></div></div><em>LIVE</em></article>;
  }
  if (sectionKey === "midSide") {
    return <article className="dsp-module"><span>{index}</span><div className="dsp-module-body"><b>{title}</b><div className="dsp-fields"><DspField label="stereoWidth" value={draft.midSide.stereoWidth} constraint={DSP_CONSTRAINTS.midSide.stereoWidth} onChange={(value) => setDraft({ ...draft, midSide: { ...draft.midSide, stereoWidth: value as number } })}/><DspField label="voiceBalance" value={draft.midSide.voiceBalance} constraint={DSP_CONSTRAINTS.midSide.voiceBalance} onChange={(value) => setDraft({ ...draft, midSide: { ...draft.midSide, voiceBalance: value as number } })}/></div></div><input aria-label={`${title}启用`} type="checkbox" checked={draft.midSide.enabled} onChange={(event) => setDraft({ ...draft, midSide: { ...draft.midSide, enabled: event.target.checked } })}/></article>;
  }
  if (sectionKey === "spatial") {
    const spatialUpdate = (field: string, value: unknown) => setDraft({ ...draft, spatial: { ...draft.spatial, [field]: value } });
    const spatialFields = Object.entries(draft.spatial).filter(([field]) => field !== "mode");
    const enumFields = DSP_ENUM_FIELDS.spatial;
    return <article className="dsp-module"><span>{index}</span><div className="dsp-module-body"><b>{title}</b>
      <SpatialFieldSvg mode={draft.spatial.mode} spreadDeg={draft.spatial.instantSpreadDeg}/>
      <div className="dsp-fields">
        <label><span>{LABELS.mode ?? "模式"}</span><select aria-label={LABELS.mode ?? "模式"} value={draft.spatial.mode} onChange={(event) => spatialUpdate("mode", event.target.value)}>{enumFields.mode.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>
        {spatialFields.map(([field, value]) => field in enumFields
          ? <label key={field}><span>{LABELS[field] ?? field}</span><select aria-label={LABELS[field] ?? field} value={String(value)} onChange={(event) => spatialUpdate(field, event.target.value)}>{(enumFields[field] ?? []).map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>
          : <DspField key={field} label={field} value={value} constraint={DSP_CONSTRAINTS.spatial[field]} onChange={(next) => spatialUpdate(field, next)}/>)}
      </div>
    </div><em>{draft.spatial.mode === "off" ? "OFF" : "ACTIVE"}</em></article>;
  }
  const section = draft[sectionKey] as Record<string, unknown>;
  const update = (field: string, value: unknown) => setDraft({ ...draft, [sectionKey]: { ...section, [field]: value } } as DspConfigurationDto);
  const enumFields = DSP_ENUM_FIELDS[sectionKey] ?? {};
  const fields = Object.entries(section).filter(([field]) => !["enabled", "bands", "bandCount"].includes(field));
  const updateBand = (bands: unknown[], bandIndex: number, patch: Record<string, unknown>) => setDraft({ ...draft, [sectionKey]: { ...section, bands: bands.map((band, current) => current === bandIndex ? { ...(band as Record<string, unknown>), ...patch } : band) } } as DspConfigurationDto);
  return <article className="dsp-module"><span>{index}</span><div className="dsp-module-body"><b>{title}</b>{sectionKey === "preEq" && <div className="dsp-band-count"><DspField label="bandCount" value={draft.preEq.bandCount} constraint={DSP_CONSTRAINTS.preEq.bandCount} onChange={(value) => { if (typeof value === "number" && Number.isFinite(value)) setDraft(resizeEqBands(draft, value)); }}/></div>}<div className="dsp-fields">{fields.map(([field, value]) => field in enumFields
    ? <label key={field}><span>{LABELS[field] ?? field}</span><select aria-label={LABELS[field] ?? field} value={String(value)} onChange={(event) => update(field, field === "fdnLines" ? Number(event.target.value) : event.target.value)}>{enumFields[field].map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>
    : <DspField key={field} label={field} value={value} constraint={DSP_CONSTRAINTS[sectionKey][field]} onChange={(next) => update(field, next)}/>)}</div>{sectionKey === "preEq" && <div className="dsp-eq-bands">{draft.preEq.bands.map((band, bandIndex) => <fieldset key={bandIndex}><legend>频段 {bandIndex + 1}</legend><DspField label="频率 Hz" value={band.frequency} constraint={DSP_CONSTRAINTS.preEq.frequency} onChange={(value) => { const bands = draft.preEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, frequency: value as number } : item); setDraft({ ...draft, preEq: { ...draft.preEq, bands } }); }}/><DspField label="增益 dB" value={band.gain} constraint={DSP_CONSTRAINTS.preEq.gain} onChange={(value) => { const bands = draft.preEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, gain: value as number } : item); setDraft({ ...draft, preEq: { ...draft.preEq, bands } }); }}/><DspField label="Q" value={band.q} constraint={DSP_CONSTRAINTS.preEq.q} onChange={(value) => { const bands = draft.preEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, q: value as number } : item); setDraft({ ...draft, preEq: { ...draft.preEq, bands } }); }}/></fieldset>)}</div>}{sectionKey === "loudnessComp" && <div className="dsp-eq-bands">{draft.loudnessComp.bands.map((band, bandIndex) => <fieldset key={bandIndex}><legend>频点 {bandIndex + 1}</legend><DspField label="frequency" value={band.frequency} constraint={DSP_CONSTRAINTS.loudnessComp.frequency} onChange={(value) => updateBand(draft.loudnessComp.bands, bandIndex, { frequency: value })}/><DspField label="gain" value={band.gain} constraint={DSP_CONSTRAINTS.loudnessComp.gain} onChange={(value) => updateBand(draft.loudnessComp.bands, bandIndex, { gain: value })}/><button type="button" onClick={() => update("bands", draft.loudnessComp.bands.filter((_, current) => current !== bandIndex))}>移除频点</button></fieldset>)}<button type="button" onClick={() => update("bands", [...draft.loudnessComp.bands, { frequency: 1_000, gain: 0 }])}>添加频点</button></div>}{sectionKey === "dynamicEq" && <div className="dsp-eq-bands">{draft.dynamicEq.bands.map((band, bandIndex) => <fieldset key={bandIndex}><legend>频段 {bandIndex + 1}</legend><label className="dsp-toggle-field"><input type="checkbox" checked={band.enabled} onChange={(event) => updateBand(draft.dynamicEq.bands, bandIndex, { enabled: event.target.checked })}/><span>启用</span></label><DspField label="frequency" value={band.frequency} constraint={DSP_CONSTRAINTS.dynamicEq.frequency} onChange={(value) => updateBand(draft.dynamicEq.bands, bandIndex, { frequency: value })}/><DspField label="targetGainDb" value={band.targetGainDb} constraint={DSP_CONSTRAINTS.dynamicEq.targetGainDb} onChange={(value) => updateBand(draft.dynamicEq.bands, bandIndex, { targetGainDb: value })}/></fieldset>)}</div>}</div><input aria-label={`${title}启用`} type="checkbox" checked={Boolean(section.enabled)} onChange={(event) => update("enabled", event.target.checked)}/></article>;
}

function DspWorkspaceView(): React.JSX.Element {
  const playback = useAppStore((state) => state.playback);
  const reduceMotion = useAppStore((state) => state.settings?.reduceMotion);
  const configuration = useAppStore((state) => state.dspConfiguration);
  const presets = useAppStore((state) => state.dspPresets);
  const partial = useAppStore((state) => state.dspPartial);
  const unsupported = useAppStore((state) => state.dspUnsupportedStages);
  const rejection = useAppStore((state) => state.dspRejection);
  const busy = useAppStore((state) => state.dspBusy);
  const load = useAppStore((state) => state.loadDspWorkspace);
  const configure = useAppStore((state) => state.configureDsp);
  const applyPreset = useAppStore((state) => state.applyDspPreset);
  const importHse2 = useAppStore((state) => state.importDspHse2);
  const exportHse2 = useAppStore((state) => state.exportDspHse2);
  const [draft, setDraft] = useState<DspConfigurationDto | null>(null);
  const [shareCode, setShareCode] = useState("");
  const frame = useMainWindowTelemetry(() => bridge.createTelemetryTransport(), true, reduceMotion);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (configuration) setDraft(configuration); }, [configuration]);
  const draftErrors = validateDspDraft(draft);
  const safeBypass = playback?.dspExecution.safeBypassActive ?? false;
  const bypassed = playback?.dsp.bypassed ?? true;
  return <Page title="音效工作台" subtitle="Rust 音频引擎是实际播放权威">
    <section className="dsp-console">
      <header><div><span className="eyebrow">ENGINE CHAIN</span><h2>{safeBypass ? "Rust 安全旁路" : bypassed ? "Rust 配置编译中" : "Rust 处理链在线"}</h2><p>Stage 1–15、16/17、18–22 共 22 个处理器由 vendored HSE Rust 实时执行（spatial 资源经 SHA-256 校验加载）；配置 revision {configuration?.revision ?? "-"}。</p></div><span className={`engine-indicator ${bypassed ? "" : "online"}`}><i/>{bypassed ? "BYPASS" : "LIVE"}</span></header>
      <div className="dsp-toolbar"><select aria-label="DSP 预设" defaultValue="" disabled={busy} onChange={(event) => { if (event.target.value) void applyPreset(event.target.value); }}><option value="">选择 HSE 场景</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button className="button primary" aria-describedby={draftErrors.length ? "dsp-validation-errors" : undefined} disabled={!draft || busy || draftErrors.length > 0} onClick={() => { if (draft && validateDspDraft(draft).length === 0) void configure(draft); }}>{busy ? "编译中" : "应用参数"}</button></div>
      {draft && draftErrors.length > 0 && <div id="dsp-validation-errors" className="notice dsp-validation-errors" role="alert"><Info/><span><b>参数尚未通过校验</b>{draftErrors.map((error) => <small key={error}>{error}</small>)}</span></div>}
      {busy && <div className="notice"><Info/><span>配置已提交，正在等待 Rust 处理链应用。</span></div>}{partial && <div className="notice"><Info/><span>HSE2 导入遵循 HSE codec 清洗与缺省值还原；当前仅应用 22 阶段投影。未应用：{unsupported.join("、")}</span></div>}{rejection && <div className="notice"><Info/><span>{rejection}</span></div>}
      {draft ? <div className="dsp-chain" aria-label="DSP 参数模块">{DSP_MODULES.map(([index, title, key]) => <DspModule key={key} index={index} title={title} sectionKey={key} draft={draft} setDraft={setDraft} frame={frame}/>)}</div> : <div className="remote-state empty"><span>{busy ? "正在读取 DSP 配置" : "DSP 配置不可用"}</span></div>}
      <div className="eq-preview" aria-label="参数均衡器只读预览"><div className="eq-axis"><span>+12</span><span>0 dB</span><span>-12</span></div><div className="eq-bands"><section className="eq-reference"><ResponseCurveSvg points={FLAT_DSP_RESPONSE} minGainDb={-12} maxGainDb={12} ariaLabel="固定 0 dB 参考响应"/><small>固定平直参考，不代表当前 DSP 配置</small></section></div></div>
      <section className="dsp-telemetry" aria-label="实时 RMS 和峰值遥测"><h3>RMS / Peak</h3>{frame?.spectrum ? <SpectrumCanvas2D bins={frame.spectrum} ariaLabel="实时音频频谱"/> : <div aria-label="频谱暂无数据"/>}<MeterStrip meters={frame?.meters ?? null}/></section>
      <section className="dsp-share"><SectionTitle>HSE2 分享码</SectionTitle><textarea aria-label="HSE2 分享码" rows={4} value={shareCode} onChange={(event) => setShareCode(event.target.value)} placeholder="粘贴 HSE2 分享码"/><div className="dsp-share-actions"><button className="button secondary" disabled={!shareCode.trim() || busy} onClick={() => void importHse2(shareCode)}>导入 22 阶段投影</button><button className="button secondary" disabled={busy} onClick={() => void exportHse2().then(setShareCode)}>导出当前配置</button></div></section>
      <footer><div><b>配置由 actor 后台编译</b><small>严格 revision · 故障自动旁路 · 进程内配置权威</small></div></footer>
    </section>
  </Page>;
}

export function CurrentView(): React.JSX.Element {
  const view = useAppStore((state) => state.view);
  switch (view) {
    case "home": return <HomeView/>;
    case "search": return <SearchView/>;
    case "library": return <LibraryView/>;
    case "discover": case "recent": case "songs": case "albums": case "artists": case "folders": case "playlists": return <BrowseView kind={view}/>;
    case "album": case "artist": case "playlist": return <DetailView type={view}/>;
    case "account": return <AccountView/>;
    case "messages": return <MessagesView/>;
    case "settings": return <SettingsView/>;
    case "cache": return <CacheView/>;
    case "status": return <StatusView/>;
    case "dsp": return <DspWorkspaceView/>;
    default: return <HomeView/>;
  }
}
