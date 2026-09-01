import { useEffect, useRef, useState } from "react";
import {
  Broadcast, CaretDown, CaretRight, CaretUp, Check, CloudArrowDown, Command, FolderOpen, Heart, Info,
  MagnifyingGlass, MusicNotes, Play, Queue, Scan, Sidebar, SlidersHorizontal, Trash, User, WifiHigh, ListPlus,
} from "@phosphor-icons/react";
import { fallbackCover } from "../artwork";
import { adaptTrack, bridge } from "../bridge";
import type { BackendCacheStatusDto, LibraryAlbumDto, LibraryArtistDto, LibraryFolderDto, LibraryPlaylistDto, LibraryRecentDto, NeteaseLoginStartDto, NeteaseLoginStateDto, PlaybackContextDto, TrackDto, UpdateCheckDto } from "../bridge/contracts";
import { Cover, Page, RemoteNotice, SectionTitle } from "../components/ui";
import { TrackTable } from "../components/TrackTable";
import { useRemote } from "../hooks/useRemote";
import { remoteFailure, remoteSuccess, type RemoteState } from "../remote";
import { useAppStore } from "../store";
import { SettingsView } from "./SettingsView";
import { DiscoverView } from "./DiscoverView";
import { MeterStrip, ResponseCurveSvg, SpectrumCanvas2D } from "../visualization/renderers";
import { useMainWindowTelemetry } from "../visualization/telemetry";

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

function DspWorkspaceView(): React.JSX.Element {
  const playback = useAppStore((state) => state.playback);
  const reduceMotion = useAppStore((state) => state.settings?.reduceMotion);
  const frame = useMainWindowTelemetry(() => bridge.createTelemetryTransport(), true, reduceMotion);

  const stages = [
    ["03", "立体声场", "M/S Width", "已迁入"],
    ["04", "参数均衡", "10-band Pre-EQ", "已迁入"],
    ["06", "动态压缩", "Linked Stereo", "已迁入"],
    ["14", "低频增强", "Virtual Bass", "已迁入"],
  ];
  return <Page title="音效工作台" subtitle="Rust 音频引擎是实际播放权威">
    <section className="dsp-console">
      <header><div><span className="eyebrow">ENGINE CHAIN</span><h2>{playback?.dsp.available ? "处理链在线" : "控制桥接中"}</h2><p>{playback?.dsp.available ? playback.dsp.label : "核心算法已迁入，界面参数将在完整 DspPort 接通后开放。"}</p></div><span className={`engine-indicator ${playback?.dsp.available ? "online" : ""}`}><i/>{playback?.dsp.available ? "LIVE" : "BYPASS"}</span></header>
      <div className="dsp-chain" aria-label="已迁入 DSP 阶段">{stages.map(([index, title, detail, status]) => <article key={index}><span>{index}</span><div><b>{title}</b><small>{detail}</small></div><em>{status}</em></article>)}</div>
      <div className="eq-preview" aria-label="参数均衡器只读预览"><div className="eq-axis"><span>+12</span><span>0 dB</span><span>-12</span></div><div className="eq-bands"><section style={{ gridColumn: "1 / -1", alignSelf: "stretch", display: "grid" }}><ResponseCurveSvg points={FLAT_DSP_RESPONSE} minGainDb={-12} maxGainDb={12} ariaLabel="固定 0 dB 参考响应"/><small>固定平直参考，不代表当前 DSP 配置</small></section></div></div>
      <section aria-label="实时音频遥测">{frame?.spectrum
        ? <SpectrumCanvas2D bins={frame.spectrum} ariaLabel="实时音频频谱"/>
        : <div aria-label="频谱暂无数据"/>}<MeterStrip meters={frame?.meters ?? null}/></section>
      <footer><div><b>默认参数保持直通</b><small>独立左右 EQ 状态 · 故障自动旁路 · Gapless 连续</small></div><button className="button secondary" disabled>参数控制尚未连接</button></footer>
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
