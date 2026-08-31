import { useEffect, useRef, useState } from "react";
import {
  Broadcast, CaretRight, Check, CloudArrowDown, Command, FolderOpen, Heart, Info,
  MagnifyingGlass, MusicNotes, Play, Queue, Scan, Sidebar, SlidersHorizontal, User, WifiHigh,
} from "@phosphor-icons/react";
import { fallbackCover } from "../artwork";
import { adaptTrack, bridge } from "../bridge";
import type { BackendCacheStatusDto, LibraryAlbumDto, LibraryArtistDto, LibraryFolderDto, LibraryPlaylistDto, LibraryRecentDto, NeteaseLoginStartDto, NeteaseLoginStateDto, TrackDto, UpdateCheckDto } from "../bridge/contracts";
import { Cover, Page, RemoteNotice, SectionTitle } from "../components/ui";
import { TrackTable } from "../components/TrackTable";
import { useRemote } from "../hooks/useRemote";
import { remoteFailure, remoteSuccess, type RemoteState } from "../remote";
import { useAppStore } from "../store";
import { SettingsView } from "./SettingsView";

type GridItem = { id: string | number; title: string; sub: string; cover: string };

function AppTrackTable({ tracks, compact = false }: { tracks: TrackDto[]; compact?: boolean }): React.JSX.Element {
  return <TrackTable tracks={tracks} compact={compact}/>;
}

function AlbumGrid({ items, artist = false, onSelect }: { items: GridItem[]; artist?: boolean; onSelect: (item: GridItem) => void }): React.JSX.Element {
  return <div className="cover-grid">{items.map((item) => <button className="cover-card" key={item.id} onClick={() => onSelect(item)}><div className="cover-wrap"><Cover src={item.cover} alt="" className={artist ? "artist-cover" : ""}/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.title}</b><small>{item.sub}</small></button>)}</div>;
}

function HomeView(): React.JSX.Element {
  const domain = useAppStore((state) => state.domain);
  const navigate = useAppStore((state) => state.navigate);
  const [home, reloadHome] = useRemote(() => domain === "netease" ? bridge.neteaseHome() : Promise.resolve({ recommendedTracks: [], recommendedPlaylists: [] }), [domain], (value) => value.recommendedTracks.length === 0 && value.recommendedPlaylists.length === 0);
  const [fm, reloadFm] = useRemote(() => domain === "netease" ? bridge.neteasePersonalFm() : Promise.resolve({ tracks: [] }), [domain], (value) => value.tracks.length === 0);
  if (domain === "local") {
    return <Page title="本地音乐" subtitle="数据来自已连接的本地曲库"><div className="home-actions"><button className="button primary" onClick={() => navigate("library")}><MusicNotes/>打开本地曲库</button><button className="button secondary" onClick={() => navigate("recent")}><Heart/>最近播放</button><button className="button secondary" onClick={() => navigate("status")}><WifiHigh/>查看状态</button></div></Page>;
  }
  const tracks = home.status === "ready" ? home.data.recommendedTracks.map(adaptTrack) : [];
  const fmTracks = fm.status === "ready" ? fm.data.tracks.map(adaptTrack) : [];
  return <Page title="网易云" subtitle="推荐与私人 FM 均来自已连接服务">
    <div className="feature-row"><button onClick={() => fmTracks[0] && void useAppStore.getState().playTrack(fmTracks[0])} disabled={!fmTracks.length}><span className="fm-tile"><Broadcast weight="fill"/></span><span><b>私人 FM</b><small>{fmTracks.length ? `${fmTracks.length} 首待播` : "暂无可播放内容"}</small></span></button><button onClick={() => navigate("library")}><span className="date-tile"><Heart/></span><span><b>我的收藏</b><small>歌单、关注与云盘</small></span></button><button onClick={() => navigate("search")}><span className="new-tile"><MagnifyingGlass/></span><span><b>搜索网易云</b><small>歌曲、专辑与艺术家</small></span></button></div>
    <SectionTitle>推荐歌曲</SectionTitle><RemoteNotice state={home} empty="暂无推荐内容" retry={reloadHome}/>{tracks.length > 0 && <AppTrackTable tracks={tracks}/>} 
    <SectionTitle>私人 FM</SectionTitle><RemoteNotice state={fm} empty="私人 FM 暂无歌曲" retry={reloadFm}/>{fmTracks.length > 0 && <AppTrackTable tracks={fmTracks} compact/>}
    {home.status === "ready" && home.data.recommendedPlaylists.length > 0 && <><SectionTitle>推荐歌单</SectionTitle><div className="cover-grid">{home.data.recommendedPlaylists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("playlist", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.name}</b><small>{item.ownerName || `${item.trackCount} 首`}</small></button>)}</div></>}
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
  return <Page title="搜索" subtitle={`${domain === "netease" ? "网易云" : "本地曲库"}搜索结果`}><div className="search-page-input"><MagnifyingGlass/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="歌曲、专辑或艺术家"/></div>{!query.trim() ? <div className="search-empty"><Command/><h2>搜索音乐</h2><p>输入关键词后从当前内容域查询。</p></div> : <><SectionTitle>歌曲</SectionTitle><RemoteNotice state={results} empty="没有找到歌曲"/>{results.status === "ready" && <AppTrackTable tracks={results.data}/>}</>}</Page>;
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
  const [selected, setSelected] = useState<GridItem | null>(null);
  const [query, reload] = useRemote(async () => {
    if (kind === "albums") return { kind, page: await bridge.libraryQueryAlbums() } as const;
    if (kind === "artists") return { kind, page: await bridge.libraryQueryArtists() } as const;
    if (kind === "folders") return { kind, page: await bridge.libraryQueryFolders() } as const;
    if (kind === "playlists") return { kind, page: await bridge.libraryQueryPlaylists() } as const;
    return { kind, page: await bridge.libraryQueryRecent() } as const;
  }, [kind], (value) => value.page.items.length === 0);
  const entityKind = kind === "albums" ? "album" : kind === "artists" ? "artist" : kind === "folders" ? "folder" : "playlist";
  const [tracks, reloadTracks] = useRemote(
    () => selected ? bridge.libraryEntityTracks(entityKind, String(selected.id)).then((page) => page.items.map(adaptTrack)) : Promise.resolve([]),
    [selected?.id, entityKind],
    (items) => selected !== null && items.length === 0,
  );
  const title = { albums: "专辑", artists: "艺术家", playlists: "播放列表", recent: "最近播放", folders: "文件夹" }[kind];
  if (query.status !== "ready") return <Page title={title} subtitle="读取本地曲库"><RemoteNotice state={query} empty={`暂无${title}`} retry={reload}/></Page>;
  if (query.data.kind === "recent") return <Page title={title} subtitle={`${query.data.page.total} 条最近播放`}><AppTrackTable tracks={(query.data.page.items as LibraryRecentDto[]).map((item) => adaptTrack(item.track))}/></Page>;
  const items: GridItem[] = query.data.kind === "albums"
    ? (query.data.page.items as LibraryAlbumDto[]).map((item) => ({ id: item.id, title: item.title, sub: `${item.artists.join(" / ")} · ${item.trackCount} 首`, cover: fallbackCover(item.artworkHash ?? item.id) }))
    : query.data.kind === "artists"
      ? (query.data.page.items as LibraryArtistDto[]).map((item) => ({ id: item.id, title: item.name, sub: `${item.albumCount} 张专辑 · ${item.trackCount} 首`, cover: fallbackCover(item.artworkHash ?? item.id) }))
      : query.data.kind === "folders"
        ? (query.data.page.items as LibraryFolderDto[]).map((item) => ({ id: item.id, title: item.name, sub: `${item.trackCount} 首`, cover: fallbackCover(item.id) }))
        : (query.data.page.items as LibraryPlaylistDto[]).map((item) => ({ id: item.id, title: item.name, sub: `${item.trackCount} 首`, cover: fallbackCover(item.id) }));
  return <Page title={selected?.title ?? title} subtitle={selected ? `来自${title}` : `${query.data.page.total} 项`} actions={selected ? <button className="button secondary" onClick={() => setSelected(null)}>返回{title}</button> : undefined}>
    {selected ? <><RemoteNotice state={tracks} empty="此项目暂无歌曲" retry={reloadTracks}/>{tracks.status === "ready" && <AppTrackTable tracks={tracks.data}/>}</> : <><div className="view-toolbar"><span>按名称排序</span><button><Sidebar/>调整视图</button></div><AlbumGrid items={items} artist={query.data.kind === "artists"} onSelect={setSelected}/></>}
  </Page>;
}

function BrowseView({ kind }: { kind: "albums" | "artists" | "playlists" | "discover" | "recent" | "folders" | "songs" }): React.JSX.Element {
  if (kind === "songs") return <LibraryView/>;
  if (kind === "discover") return <Page title="发现" subtitle="榜单、新歌、MV 与电台"><div className="remote-state unavailable"><Info/><b>发现内容正在接入</b><span>当前版本不会展示虚构在线内容。</span></div></Page>;
  return <LocalBrowseView kind={kind}/>;
}

function DetailView({ type }: { type: "album" | "artist" | "playlist" }): React.JSX.Element {
  const detailId = useAppStore((state) => state.detailId);
  async function load() {
    if (detailId === null) throw { code: "unavailable", message: "未选择可加载的网易云资源" };
    if (type === "album") { const value = await bridge.neteaseAlbumDetail(detailId); return { title: value.album.name, subtitle: value.artist?.name || "网易云专辑", description: value.description, cover: value.album.coverUrl, tracks: value.tracks.map(adaptTrack) }; }
    if (type === "artist") { const value = await bridge.neteaseArtistDetail(detailId); return { title: value.artist.name, subtitle: value.fansCount === null ? "网易云艺术家" : `${value.fansCount.toLocaleString()} 位粉丝`, description: value.introduction || value.artist.briefDescription, cover: value.artist.imageUrl, tracks: value.hotTracks.map(adaptTrack) }; }
    const value = await bridge.neteasePlaylistDetail(detailId); return { title: value.playlist.name, subtitle: `${value.playlist.trackCount} 首 · ${value.playlist.ownerName || "网易云歌单"}`, description: value.playlist.description, cover: value.playlist.coverUrl, tracks: value.tracks.map(adaptTrack) };
  }
  const [detail, reload] = useRemote(load, [type, detailId], (value) => value.tracks.length === 0);
  const [comments, reloadComments] = useRemote(() => detailId !== null && type !== "artist" ? bridge.neteaseComments(type, detailId) : Promise.resolve({ comments: [], totalCount: 0, hasMore: false, nextCursor: null }), [type, detailId], (value) => value.comments.length === 0);
  const { playTrack, enqueueTrack } = useAppStore();
  if (detail.status !== "ready") return <Page title={{ album: "专辑详情", artist: "艺术家详情", playlist: "歌单详情" }[type]} subtitle="读取网易云详情"><RemoteNotice state={detail} empty="详情中暂无曲目" retry={reload}/></Page>;
  const item = detail.data;
  const cover = item.cover || fallbackCover(String(detailId));
  return <div className="page detail-page"><section className="detail-hero"><Cover src={cover} alt={item.title} className={type === "artist" ? "artist-cover" : ""}/><div><span className="eyebrow">{type === "artist" ? "艺术家" : type === "playlist" ? "歌单" : "专辑"}</span><h1>{item.title}</h1><p>{item.subtitle}</p>{item.description && <p className="detail-copy">{item.description}</p>}<div className="detail-actions"><button className="button primary" disabled={!item.tracks.length} onClick={() => item.tracks[0] && void playTrack(item.tracks[0])}><Play weight="fill"/>播放</button><button className="button secondary" disabled={!item.tracks.length} onClick={() => item.tracks.forEach((track) => void enqueueTrack(track))}><Queue/>加入队列</button></div></div></section><SectionTitle>{type === "artist" ? "热门歌曲" : "曲目"}</SectionTitle><AppTrackTable tracks={item.tracks}/>{type !== "artist" && <><SectionTitle>评论</SectionTitle><RemoteNotice state={comments} empty="暂无评论" retry={reloadComments}/>{comments.status === "ready" && <div className="comment-list">{comments.data.comments.map((comment) => <div key={comment.id}><User/><span><b>{comment.user?.nickname || "网易云用户"}</b><p>{comment.content}</p><small>{comment.timeText || `${comment.likedCount} 次赞`}</small></span></div>)}</div>}</>}</div>;
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
  return <Page title="状态中心" subtitle="扫描、缓存、同步与更新"><SectionTitle>正在进行</SectionTitle>{tasks.length ? <div className="task-list">{tasks.map((task) => <div key={task.id}><span className={`task-icon ${task.state}`}>{task.kind === "scan" ? <Scan/> : task.kind === "cache" ? <CloudArrowDown/> : <WifiHigh/>}</span><span><b>{task.title}</b><small>{task.detail}</small>{task.progress !== null && <i className="progress"><i style={{width:`${task.progress * 100}%`}}/></i>}</span></div>)}</div> : <div className="remote-state empty"><Check/><b>没有后台任务</b><span>仅显示本次运行中由后端事件报告的任务。</span></div>}<SectionTitle>应用更新</SectionTitle><RemoteNotice state={updater} retry={reloadUpdater}/>{updater.status === "ready" && <div className="updater-row"><span><b>{updater.data.enabled ? "更新检查可用" : "更新器不可用"}</b><small>{updater.data.reason || "可检查新版本"}</small></span><button className="button secondary" disabled={!updater.data.enabled || check.status === "loading"} onClick={() => void checkUpdate()}>检查更新</button></div>}{check.status === "ready" && <div className="notice"><Info/>{check.data.available ? `发现版本 ${check.data.version}` : `当前已是最新版本 ${check.data.currentVersion}`}</div>}{(check.status === "error" || check.status === "unavailable") && <RemoteNotice state={check}/>}</Page>;
}

function DspView(): React.JSX.Element { return <Page title="音效" subtitle="全局 DSP 工作台"><div className="dsp-empty"><SlidersHorizontal/><h2>音效工作台尚未开放</h2><p>真实 DSP 效果、参数模型与链路规格尚未确定。当前音频保持稳定旁路，不提供假均衡器或预设。</p><span><Check/>音频管线插入点已保留</span><span><Check/>旁路状态跨内容域共享</span><button className="button primary" disabled>规格待接入</button></div></Page>; }

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
    case "dsp": return <DspView/>;
    default: return <HomeView/>;
  }
}
