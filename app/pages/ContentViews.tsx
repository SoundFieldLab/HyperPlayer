import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise, Broadcast, CalendarBlank, CaretDown, CaretRight, CaretUp, Check, CheckCircle, CloudArrowDown, Command, FolderOpen, Heart, Info,
  MagnifyingGlass, MusicNotes, Play, Queue, Scan, Sidebar, SlidersHorizontal, ThumbsUp, Trash, User, Users, WifiHigh, ListPlus, X,
} from "@phosphor-icons/react";
import { fallbackCover } from "../artwork";
import { adaptTrack, bridge } from "../bridge";
import type { BackendCacheStatusDto, BackendTrackDto, DspConfigurationDto, LibraryAlbumDto, LibraryArtistDto, LibraryFolderDto, LibraryPlaylistDto, LibraryRecentDto, NeteaseAlbumDto, NeteaseArtistSummaryDto, NeteaseCommentDto, NeteaseCommentResource, NeteaseListenPeriod, NeteaseLoginStartDto, NeteaseLoginStateDto, NeteaseMutationDto, NeteasePlaylistDto, NeteaseSearchKind, NeteaseSearchPageDto, NeteaseSearchSuggestionsDto, PlaybackContextDto, TrackDto, UpdateCheckDto } from "../bridge/contracts";
import { Cover, Page, RemoteNotice, SectionTitle } from "../components/ui";
import { TrackTable } from "../components/TrackTable";
import { CommentSection } from "../components/CommentSection";
import { useRemote } from "../hooks/useRemote";
import { remoteFailure, remoteSuccess, type RemoteState } from "../remote";
import { useAppStore } from "../store";
import { SettingsView } from "./SettingsView";
import { DspWorkbenchView } from "./DspWorkbench";
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
  const [banners] = useRemote(() => domain === "netease" ? bridge.neteaseBanner() : Promise.resolve([]), [domain], () => false);
  const [exploreBatch, setExploreBatch] = useState(0);
  const [exploreTracks, setExploreTracks] = useState<BackendTrackDto[]>([]);
  const [exploreLoading, setExploreLoading] = useState(false);
  async function loadExploreNext(): Promise<void> {
    if (exploreLoading) return;
    setExploreLoading(true);
    try {
      const exclude = exploreTracks.map((track) => Number(track.trackRef.id)).filter((id) => Number.isFinite(id));
      const page = await bridge.neteaseExploreNext(30, exploreBatch + 1, exclude);
      setExploreTracks((prev) => [...prev, ...page.songs]);
      setExploreBatch(page.batch);
    } catch { /* 探索失败不打断首页 */ }
    finally { setExploreLoading(false); }
  }
  useEffect(() => { if (domain === "netease") void loadExploreNext(); }, [domain]); // eslint-disable-line react-hooks/exhaustive-deps
  const tracks = domain === "local"
    ? localTracks.status === "ready" ? localTracks.data : []
    : home.status === "ready" ? home.data.recommendedTracks.map(adaptTrack) : [];
  const state = domain === "local" ? localTracks : home;
  return <Page title="我的喜欢" subtitle={domain === "local" ? "本地曲库中的常听曲目" : "来自网易云的实时推荐"} actions={<><button className="button primary" disabled={!tracks.length} onClick={() => tracks[0] && void useAppStore.getState().playTrack(tracks[0], { kind: "manual", id: null })}><Play weight="fill"/>播放全部</button><button className="button secondary" onClick={() => navigate(domain === "local" ? "folders" : "library")}><FolderOpen/>管理音乐</button></>}>
    {/* banner-strip/banner-card 无 CSS 定义（样式塌陷根因之一），复用 cover-grid/cover-card 卡片网格 */}
    {domain === "netease" && banners.status === "ready" && banners.data.length > 0 && <div className="cover-grid">{banners.data.filter((banner) => banner.targetUrl).map((banner) => <button className="cover-card" key={banner.id} onClick={() => banner.targetUrl && window.open(banner.targetUrl, "_blank")}><div className="cover-wrap"><Cover src={banner.imageUrl} alt={banner.title}/><span className="hover-play"><Play weight="fill"/></span></div><b>{banner.title}</b></button>)}</div>}
    {/* collection-summary/collection-art 无 CSS 定义导致首页塌陷，改用 styles.css 已有的 continue-main 英雄卡（42% 封面 + 文案 + round-play） */}
    <div className="continue-main" style={{ marginBottom: 22 }}><Cover src={tracks.length > 0 ? tracks[0].coverSeed : fallbackCover("hyperplayer-collection")} alt=""/><div><span className="eyebrow">COLLECTION</span><h2>{tracks.length ? `${tracks.length} 首歌曲` : "你的音乐收藏"}</h2><p>{domain === "local" ? "从本地曲库整理出的私人播放空间。" : "登录后可查看收藏歌单；当前列表来自推荐服务。"}</p><button className="round-play" aria-label="播放全部" disabled={!tracks.length} onClick={() => tracks[0] && void useAppStore.getState().playTrack(tracks[0], { kind: "manual", id: null })}><Play weight="fill"/></button></div></div>
    {/* collection-toolbar 无 CSS 定义，改用已有的 view-toolbar（标签 + 透明按钮行） */}
    <div className="view-toolbar"><span>{domain === "local" ? "本地曲目" : "推荐曲目"}</span><button type="button" onClick={() => navigate("search")}><MagnifyingGlass/>筛选音乐</button></div>
    <RemoteNotice state={state} empty="这里还没有可播放的音乐" emptyDetail={domain === "netease" ? "网易云每日推荐需登录后可见" : undefined} retry={domain === "local" ? reloadLocalTracks : reloadHome}/>
    {tracks.length > 0 && <AppTrackTable tracks={tracks} playbackContext={{ kind: "manual", id: null }} preserveOrder/>}
    {/* 网易云域把已随 neteaseHome 返回但一直未展示的推荐歌单补成卡片网格（cover-grid），凑齐「收藏/推荐卡片」形态 */}
    {domain === "netease" && home.status === "ready" && home.data.recommendedPlaylists.length > 0 && <><SectionTitle>推荐歌单</SectionTitle><div className="cover-grid">{home.data.recommendedPlaylists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("playlist", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.name}</b><small>{item.trackCount} 首</small></button>)}</div></>}
    {domain === "netease" && (exploreTracks.length > 0 || exploreLoading) && <><SectionTitle>探索发现</SectionTitle><RemoteNotice state={exploreLoading && exploreTracks.length === 0 ? { status: "loading" } : { status: "ready", data: null }} empty=""/>{exploreTracks.length > 0 && <AppTrackTable tracks={exploreTracks.map(adaptTrack)} playbackContext={{ kind: "manual", id: null }} preserveOrder/>}<button className="button secondary" onClick={() => void loadExploreNext()} disabled={exploreLoading}>{exploreLoading ? "加载中…" : "加载更多"}</button></>}
  </Page>;
}

const SEARCH_TABS: Array<[NeteaseSearchKind, string]> = [["track", "歌曲"], ["album", "专辑"], ["artist", "艺术家"], ["playlist", "歌单"]];

function SearchResultGrid({ kind, page, navigate }: { kind: Exclude<NeteaseSearchKind, "track">; page: { albums: NeteaseAlbumDto[]; artists: NeteaseArtistSummaryDto[]; playlists: NeteasePlaylistDto[] }; navigate: (view: "album" | "artist" | "playlist", id: number) => void }): React.JSX.Element {
  if (kind === "album") return <div className="cover-grid">{page.albums.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("album", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.name}</b><small>专辑</small></button>)}</div>;
  if (kind === "artist") return <div className="cover-grid">{page.artists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("artist", item.id)}><div className="cover-wrap"><Cover src={item.imageUrl || fallbackCover(String(item.id))} alt="" className="artist-cover"/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.name}</b><small>{item.aliases.length ? item.aliases.join(" / ") : "网易云艺术家"}</small></button>)}</div>;
  return <div className="cover-grid">{page.playlists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("playlist", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.name}</b><small>{item.trackCount} 首{item.ownerName ? ` · ${item.ownerName}` : ""}</small></button>)}</div>;
}

function SearchView(): React.JSX.Element {
  const domain = useAppStore((state) => state.domain);
  const navigate = useAppStore((state) => state.navigate);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<NeteaseSearchKind>("track");
  const [results, setResults] = useState<RemoteState<NeteaseSearchPageDto>>({ status: "idle" });
  const [hotWords, reloadHotWords] = useRemote(() => domain === "netease" ? bridge.neteaseSearchHot() : Promise.resolve([]), [domain], () => false);
  const [suggestions, setSuggestions] = useState<RemoteState<NeteaseSearchSuggestionsDto>>({ status: "idle" });
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setResults({ status: "idle" }); setSuggestions({ status: "idle" }); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      setResults({ status: "loading" });
      const request = domain === "netease" ? bridge.neteaseSearch(trimmed, tab) : bridge.libraryQuery(trimmed).then((page) => ({ tracks: page.items, albums: [], artists: [], playlists: [], nextCursor: page.nextCursor }));
      void request.then((page) => {
        if (!active) return;
        const items = tab === "track" ? page.tracks : tab === "album" ? page.albums : tab === "artist" ? page.artists : page.playlists;
        setResults(remoteSuccess(page, items.length === 0));
      }).catch((error: unknown) => { if (active) setResults(remoteFailure(error)); });
      if (domain === "netease" && tab === "track") {
        void bridge.neteaseSearchSuggest(trimmed).then((value) => { if (active) setSuggestions(remoteSuccess(value, value.songs.length === 0)); }).catch((error: unknown) => { if (active) setSuggestions(remoteFailure(error)); });
      }
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [domain, query, tab]);
  const trackResults = results.status === "ready" ? results.data.tracks.map(adaptTrack) : [];
  const tabLabel: Record<NeteaseSearchKind, string> = { track: "歌曲", album: "专辑", artist: "艺术家", playlist: "歌单" };
  return <Page title="搜索" subtitle={`${domain === "netease" ? "网易云" : "本地曲库"}搜索结果`}><div className="search-page-input"><MagnifyingGlass/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="歌曲、专辑或艺术家"/></div>{!query.trim() ? <div className="search-empty"><Command/><h2>搜索音乐</h2><p>输入关键词后从当前内容域查询。</p>{domain === "netease" && hotWords.status === "ready" && hotWords.data.length > 0 && <div className="hot-words"><span>热搜</span>{hotWords.data.slice(0, 12).map((word) => <button key={word.word} onClick={() => setQuery(word.word)}>{word.word}</button>)}</div>}</div> : <>{domain === "netease" && <div className="filter-pills" role="tablist" aria-label="搜索结果类型">{SEARCH_TABS.map(([kind, label]) => <button key={kind} role="tab" aria-selected={tab === kind} className={tab === kind ? "active" : ""} onClick={() => setTab(kind)}>{label}</button>)}</div>}<SectionTitle>{tabLabel[tab]}</SectionTitle><RemoteNotice state={results} empty={`没有找到${tabLabel[tab]}`}/>{results.status === "ready" && (tab === "track" ? <AppTrackTable tracks={trackResults} playbackContext={{ kind: "search", id: null }}/> : <SearchResultGrid kind={tab} page={results.data} navigate={(view, id) => navigate(view, id)}/>)}{domain === "netease" && tab === "track" && suggestions.status === "ready" && suggestions.data.songs.length > 0 && <div className="suggest-block"><SectionTitle>搜索建议</SectionTitle><div className="suggest-list">{suggestions.data.songs.map((song: BackendTrackDto) => <button key={song.trackRef.id} onClick={() => setQuery(song.title)}><b>{song.title}</b><small>{song.artists.join(" / ")}</small></button>)}</div></div>}</>}</Page>;
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

function formatMinutes(minutes: number): string {
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
  }
  return `${minutes} 分钟`;
}

const LISTEN_PERIODS: Array<[NeteaseListenPeriod, string]> = [["week", "最近一周"], ["month", "最近一月"], ["year", "最近一年"]];

function ListenSummary(): React.JSX.Element {
  const [period, setPeriod] = useState<NeteaseListenPeriod>("week");
  const [total, reloadTotal] = useRemote(() => bridge.neteaseListenTotal(), [], (value) => value.totalPlays === 0);
  const [report, reloadReport] = useRemote(() => bridge.neteaseListenReport(period), [period], (value) => value.stats.totalPlays === 0);
  const [rank, reloadRank] = useRemote(() => bridge.neteaseListenSongRank(period), [period], (value) => value.tracks.length === 0);
  return <>
    <div className="listen-tabs" role="tablist" aria-label="听歌统计周期">{LISTEN_PERIODS.map(([value, label]) => <button key={value} role="tab" aria-selected={period === value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{label}</button>)}</div>
    <div className="stats-strip">
      <span><b>{total.status === "ready" ? formatMinutes(total.data.totalMinutes) : "—"}</b><small>累计收听时长</small></span>
      <span><b>{total.status === "ready" ? total.data.totalPlays.toLocaleString() : "—"}</b><small>累计播放次数</small></span>
      <span><b>{report.status === "ready" ? formatMinutes(report.data.stats.totalMinutes) : "—"}</b><small>{period === "week" ? "本周" : period === "month" ? "本月" : "本年"}收听</small></span>
      <span><b>{report.status === "ready" ? report.data.stats.totalPlays.toLocaleString() : "—"}</b><small>{period === "week" ? "本周" : period === "month" ? "本月" : "本年"}播放</small></span>
    </div>
    <div className="stats-note"><Info/>统计来自网易云账号自身记录的听歌行为，只读展示。</div>
    {(total.status === "error" || total.status === "unavailable") && <RemoteNotice state={total} retry={reloadTotal}/>}
    {(report.status === "error" || report.status === "unavailable") && <RemoteNotice state={report} retry={reloadReport}/>}
    <SectionTitle>常听歌曲</SectionTitle>
    <RemoteNotice state={rank} empty="该周期暂无收听记录" retry={reloadRank}/>
    {rank.status === "ready" && <AppTrackTable tracks={rank.data.tracks.map(adaptTrack)} compact playbackContext={{ kind: "search", id: null }}/>}
  </>;
}

function NeteaseLibraryView(): React.JSX.Element {
  const navigate = useAppStore((state) => state.navigate);
  // 登录态以 neteaseStatus 为准（store 目前没有暴露网易云登录字段，见报告）；未登录时整页引导，避免收藏区块露出「后端返回了空结果」。
  const [status, reloadStatus] = useRemote(() => bridge.neteaseStatus(), [], () => false);
  const [favorites, reloadFavorites] = useRemote(() => bridge.neteaseFavorites(), [], (value) => value.playlists.length === 0 && value.likedTrackIds.length === 0);
  const [account, reloadAccount] = useRemote(() => bridge.neteaseAccount(), [], () => false);
  const [cloud, reloadCloud] = useRemote(() => bridge.neteaseCloud(), [], (value) => value.songs.length === 0);
  const follows = useRemote(() => account.status === "ready" ? bridge.neteaseFollows(account.data.user.userId) : Promise.resolve({ users: [], nextCursor: null }), [account.status === "ready" ? account.data.user.userId : null], (value) => value.users.length === 0);
  const artistSublist = useRemote(() => bridge.neteaseArtistSublist(), [], (value) => value.artists.length === 0);
  const albumSublist = useRemote(() => bridge.neteaseAlbumSublist(), [], (value) => value.albums.length === 0);
  const mvSublist = useRemote(() => bridge.neteaseMvSublist(), [], (value) => value.mvs.length === 0);
  if (status.status !== "ready") return <Page title="网易云音乐库" subtitle="收藏、关注、云盘与听歌数据来自当前登录账号"><RemoteNotice state={status} retry={reloadStatus}/></Page>;
  if (!status.data.authenticated) return <Page title="网易云音乐库" subtitle="收藏、关注、云盘与听歌数据来自当前登录账号"><div className="remote-state empty"><Info/><b>登录后查看收藏</b><span>收藏歌单、收藏艺人、收藏专辑、关注与音乐云盘来自当前登录的网易云账号；当前未登录或会话已失效。</span><button className="button secondary" onClick={() => navigate("account")}><User/>前往网易云账号</button></div></Page>;
  return <Page title="网易云音乐库" subtitle="收藏、关注、云盘与听歌数据来自当前登录账号">
    <SectionTitle>收藏歌单</SectionTitle><RemoteNotice state={favorites} empty="暂无收藏" retry={reloadFavorites}/>{favorites.status === "ready" && <div className="cover-grid">{favorites.data.playlists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("playlist", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/></div><b>{item.name}</b><small>{item.trackCount} 首</small></button>)}</div>}
    <SectionTitle>收藏艺人</SectionTitle><RemoteNotice state={artistSublist[0]} empty="暂无收藏艺人" retry={artistSublist[1]}/>{artistSublist[0].status === "ready" && <div className="cover-grid">{artistSublist[0].data.artists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("artist", item.id)}><div className="cover-wrap"><Cover src={item.imageUrl || fallbackCover(String(item.id))} alt="" className="artist-cover"/></div><b>{item.name}</b><small>艺人</small></button>)}</div>}
    <SectionTitle>收藏专辑</SectionTitle><RemoteNotice state={albumSublist[0]} empty="暂无收藏专辑" retry={albumSublist[1]}/>{albumSublist[0].status === "ready" && <div className="cover-grid">{albumSublist[0].data.albums.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("album", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/></div><b>{item.name}</b><small>专辑</small></button>)}</div>}
    <SectionTitle>收藏 MV</SectionTitle><RemoteNotice state={mvSublist[0]} empty="暂无收藏 MV" retry={mvSublist[1]}/>{mvSublist[0].status === "ready" && <div className="cover-grid">{mvSublist[0].data.mvs.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("discover")}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/><span className="hover-play"><Play weight="fill"/></span></div><b>{item.name}</b><small>{item.artists.map((artist) => artist.name).join(" / ")}</small></button>)}</div>}
    <SectionTitle>关注</SectionTitle><RemoteNotice state={follows[0]} empty="暂无关注用户" retry={follows[1]}/>{follows[0].status === "ready" && <div className="user-strip">{follows[0].data.users.map((user) => <span key={user.userId}>{user.avatarUrl ? <Cover src={user.avatarUrl} alt="" className="avatar-image"/> : <User/>}<b>{user.nickname}</b></span>)}</div>}
    <SectionTitle>音乐云盘</SectionTitle><RemoteNotice state={cloud} empty="云盘暂无歌曲" retry={reloadCloud}/>{cloud.status === "ready" && <AppTrackTable tracks={cloud.data.songs.map((song) => adaptTrack(song))}/>} 
    <SectionTitle>我的听歌</SectionTitle><RemoteNotice state={account} retry={reloadAccount}/>{account.status === "ready" && <ListenSummary/>}
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
  const domain = useAppStore((state) => state.domain);
  if (kind === "songs") return <LibraryView/>;
  if (kind === "discover") return <DiscoverView/>;
  // 网易云域的「最近播放」= 听歌记录（ListenSummary），不能再落本地曲库 recent——
  // 那会在网易云域渲染 Rust 曲库内容，造成切页后内容突变（用户实测页面错乱根因）。
  if (kind === "recent" && domain === "netease") return <NeteaseRecentView/>;
  return <LocalBrowseView kind={kind}/>;
}

/** 网易云域最近播放：听歌排行 + 累计（数据来自当前登录账号；未登录给出引导） */
function NeteaseRecentView(): React.JSX.Element {
  const [status] = useRemote(() => bridge.neteaseStatus(), [], () => false);
  if (status.status === "ready" && !status.data.authenticated) {
    return <Page title="最近播放" subtitle="网易云听歌记录来自当前登录账号"><div className="remote-state empty"><Info/><b>登录后查看听歌记录</b><span>最近播放与听歌排行来自网易云账号；当前未登录或会话已失效。</span></div></Page>;
  }
  return <Page title="最近播放" subtitle="网易云听歌记录与排行"><ListenSummary/></Page>;
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
  const [related, reloadRelated] = useRemote(
    () => type === "playlist" && typeof detailId === "number" ? bridge.neteaseRelatedPlaylists(detailId) : Promise.resolve({ playlists: [], nextCursor: null }),
    [type, detailId],
    () => false,
  );
  // 相似艺人（oracle /api/discovery/simiArtist）：艺术家详情页的发现延伸。
  const [similarArtists] = useRemote(
    () => type === "artist" && typeof detailId === "number" ? bridge.neteaseSimilarArtists(detailId) : Promise.resolve({ artists: [], nextCursor: null }),
    [type, detailId],
    (value) => value.artists.length === 0,
  );
  // 心动模式（oracle /api/playmode/intelligence/list）：歌单曲目 + 当前歌单 id 生成心动队列。
  const [heartMode, setHeartMode] = useState<RemoteState<{ tracks: TrackDto[] }>>({ status: "idle" });
  async function startHeartMode(): Promise<void> {
    if (type !== "playlist" || typeof detailId !== "number" || !item0?.tracks.length) return;
    setHeartMode({ status: "loading" });
    try {
      const seed = item0.tracks[0];
      const value = await bridge.neteasePlaymodeIntelligenceList(Number(seed.id), detailId);
      const tracks = value.tracks.map(adaptTrack);
      if (!tracks.length) { setHeartMode(remoteSuccess({ tracks }, true)); return; }
      setHeartMode(remoteSuccess({ tracks }));
      await playTrack(tracks[0], { kind: "playlist", id: String(detailId) });
      tracks.slice(1).forEach((track) => void enqueueTrack(track));
    } catch (error) { setHeartMode(remoteFailure(error)); }
  }
  const item0 = detail.status === "ready" ? detail.data : null;
  const { playTrack, enqueueTrack, navigate, notifyError } = useAppStore();
  const [coverBusy, setCoverBusy] = useState(false);
  // 更新歌单封面（oracle：NOS token alloc → 裸传 → cover/update）。选本地图片文件上传。
  async function updatePlaylistCover(): Promise<void> {
    if (type !== "playlist" || typeof detailId !== "number" || coverBusy) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    const picked = await new Promise<File | null>((resolve) => {
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
    if (!picked) return;
    setCoverBusy(true);
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      let binary = "";
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      const imageBase64 = window.btoa(binary);
      await bridge.neteaseUpdatePlaylistCover(detailId, imageBase64, picked.type || undefined);
      await reload();
    } catch (error) { notifyError(error, "无法更新歌单封面"); }
    finally { setCoverBusy(false); }
  }
  if (detail.status !== "ready") return <Page title={{ album: "专辑详情", artist: "艺术家详情", playlist: "歌单详情" }[type]} subtitle="读取网易云详情"><RemoteNotice state={detail} empty="详情中暂无曲目" retry={reload}/></Page>;
  const item = detail.data;
  const cover = item.cover || fallbackCover(String(detailId));
  const playbackContext: PlaybackContextDto = type === "album"
    ? { kind: "album", id: String(detailId) }
    : type === "playlist"
      ? { kind: "playlist", id: String(detailId) }
      : { kind: "manual", id: null };
  return <div className="page detail-page"><section className="detail-hero"><Cover src={cover} alt={item.title} className={type === "artist" ? "artist-cover" : ""}/><div><span className="eyebrow">{type === "artist" ? "艺术家" : type === "playlist" ? "歌单" : "专辑"}</span><h1>{item.title}</h1><p>{item.subtitle}</p>{item.description && <p className="detail-copy">{item.description}</p>}<div className="detail-actions"><button className="button primary" disabled={!item.tracks.length} onClick={() => item.tracks[0] && void playTrack(item.tracks[0], playbackContext)}><Play weight="fill"/>播放</button>{type === "playlist" && <button className="button secondary" disabled={!item.tracks.length || heartMode.status === "loading"} onClick={() => void startHeartMode()}>{heartMode.status === "loading" ? "生成心动模式…" : "心动模式"}</button>}<button className="button secondary" disabled={!item.tracks.length} onClick={() => item.tracks.forEach((track) => void enqueueTrack(track))}><Queue/>加入队列</button>{type === "playlist" && <button className="button secondary" disabled={coverBusy} onClick={() => void updatePlaylistCover()}>{coverBusy ? "上传中…" : "更换封面"}</button>}</div></div></section><SectionTitle>{type === "artist" ? "热门歌曲" : "曲目"}</SectionTitle><AppTrackTable tracks={item.tracks} playbackContext={playbackContext}/>{heartMode.status === "error" && <RemoteNotice state={heartMode} retry={() => void startHeartMode()}/>}{heartMode.status === "empty" && <p className="detail-copy">心动模式暂无推荐（需登录且歌单可生成）。</p>}{type === "artist" && similarArtists.status === "ready" && similarArtists.data.artists.length > 0 && <><SectionTitle>相似艺人</SectionTitle><div className="cover-grid">{similarArtists.data.artists.map((artist) => <button className="cover-card" key={artist.id} onClick={() => navigate("artist", artist.id)}><div className="cover-wrap"><Cover src={artist.imageUrl || fallbackCover(String(artist.id))} alt="" className="artist-cover"/><span className="hover-play"><Play weight="fill"/></span></div><b>{artist.name}</b><small>{artist.aliases.length ? artist.aliases.join(" / ") : "相似艺人"}</small></button>)}</div></>}{type === "playlist" && related.status === "ready" && related.data.playlists.length > 0 && <><SectionTitle>相关歌单</SectionTitle><div className="cover-grid">{related.data.playlists.map((item) => <button className="cover-card" key={item.id} onClick={() => navigate("playlist", item.id)}><div className="cover-wrap"><Cover src={item.coverUrl || fallbackCover(String(item.id))} alt=""/></div><b>{item.name}</b><small>{item.trackCount} 首</small></button>)}</div></>}{type !== "artist" && typeof detailId === "number" && <CommentSection resource={type} resourceId={detailId}/>}</div>;
}

function AccountView(): React.JSX.Element {
  const notifyError = useAppStore((state) => state.notifyError);
  const [status, reloadStatus] = useRemote(() => bridge.neteaseStatus(), [], () => false);
  const [account, reloadAccount] = useRemote(() => bridge.neteaseAccount(), [], () => false);
  const neteaseAuthenticated = useAppStore((state) => state.neteaseAuthenticated);
  // 登录状态机在 store 全局自驱动（切页/卸载不中断轮询），页面只渲染
  const login = useAppStore((state) => state.neteaseLogin);
  // confirmed（全局态翻转）时刷新账号页本地数据：立即 + 1.5s 兜底（profile 异步）
  const confirmed = login.phase === "confirmed";
  useEffect(() => {
    if (!confirmed) return;
    reloadStatus();
    reloadAccount();
    const timer = window.setTimeout(() => { reloadStatus(); reloadAccount(); }, 1500);
    return () => window.clearTimeout(timer);
  }, [confirmed]);
  async function logout(): Promise<void> {
    try { await bridge.neteaseLogout(); } catch (error) { notifyError(error, "登出失败"); }
    useAppStore.getState().neteaseResetLogin();
    useAppStore.getState().setNeteaseAuthenticated(false);
    reloadStatus();
  }
  const actual = status.status === "ready" ? status.data : null;
  const profile = account.status === "ready" ? account.data : null;
  const phaseText = login.phase ? ({ waiting: "等待扫码", scanned: "已扫码，请在手机上确认", confirmed: "登录成功", expired: "二维码已过期，正在重新获取…", failed: "登录失败" }[login.phase]) : "二维码由网易云登录 command 实时生成";
  async function startLogin(): Promise<void> { await useAppStore.getState().neteaseStartLogin(); }
  return <Page title="网易云账号" subtitle="凭据仅由 Rust 后端管理"><RemoteNotice state={status} retry={reloadStatus}/>{actual && !actual.enabled && <div className="remote-state unavailable"><Info/><b>网易云内容域已禁用</b><span>可在设置中重新启用。</span></div>}{actual?.authenticated || neteaseAuthenticated ? <div className="account-signed-in">{profile?.user.avatarUrl ? <Cover src={profile.user.avatarUrl} alt="" className="avatar-image"/> : <User/>}<div><h2>{profile?.user.nickname || actual?.displayName || "已登录网易云"}</h2><p>{profile ? `${profile.vip.active ? `VIP${profile.vip.level ?? ""}` : "普通账号"} · 权益校验 ${new Date(profile.vip.verifiedAtMs).toLocaleString()}` : actual?.userId ? `账号 ${actual.userId}` : "正在读取账号权益"}</p></div><button className="button secondary" onClick={() => void logout()}>退出登录</button></div> : actual?.enabled && <div className="account-layout"><section className="login-pane">{login.status === "ready" ? <img className="qr-image" src={login.qrImageDataUrl} alt="网易云登录二维码"/> : login.status === "idle" ? <div className="remote-state empty"><Info/><b>尚未生成二维码</b><span>点击下方按钮向后端请求二维码。</span></div> : login.status === "error" ? <div className="remote-state error" role="alert"><Info/><b>二维码获取失败</b><span>{login.error}</span><button className="button secondary" onClick={() => void startLogin()}>重试</button></div> : null}<h2>使用网易云音乐扫码</h2><p>{phaseText}</p><div className="privacy-note"><Info/>请使用网易云音乐 APP 右上角「扫一扫」扫码并在 APP 内确认；微信/相机扫码无效。</div><button className="button primary" onClick={() => void startLogin()} disabled={login.status === "loading"}>{login.status === "ready" ? "刷新二维码" : "获取二维码"}</button></section><section className="account-benefits"><h2>账号能力</h2><div><Heart/><span><b>喜欢与收藏</b><small>以服务端实际返回为准</small></span></div><div><CloudArrowDown/><span><b>权益缓存</b><small>同账号实时权益校验，失败时拒绝播放</small></span></div><div className="privacy-note"><Info/>原始 Cookie 不进入界面。</div></section></div>}</Page>;
}

function formatMessageTime(occurredAtMs: number | null): string {
  if (occurredAtMs === null) return "时间未知";
  return new Date(occurredAtMs).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function MessagesView(): React.JSX.Element {
  const navigate = useAppStore((state) => state.navigate);
  const [status, reloadStatus] = useRemote(() => bridge.neteaseStatus(), [], () => false);
  const [notices, reloadNotices] = useRemote(() => bridge.neteaseNotices(), [], (page) => page.items.length === 0);
  const [events, reloadEvents] = useRemote(() => bridge.neteaseFollowedEvents(), [], (page) => page.items.length === 0);
  const authenticated = status.status === "ready" && status.data.authenticated;
  return <Page title="消息" subtitle="系统通知与关注动态来自当前登录账号，保持只读">
    <RemoteNotice state={status} retry={reloadStatus}/>
    {status.status === "ready" && !authenticated && <div className="remote-state empty"><Info/><b>登录后查看消息</b><span>通知与关注动态来自网易云账号；当前未登录或会话已失效。</span><button className="button secondary" onClick={() => navigate("account")}><User/>前往网易云账号</button></div>}
    {authenticated && <><SectionTitle>通知</SectionTitle>
    <RemoteNotice state={notices} empty="暂无通知" retry={reloadNotices}/>
    {notices.status === "ready" && <div className="message-list">{notices.data.items.map((item) => <div key={item.id}><span aria-hidden="true"/>{item.user?.avatarUrl ? <Cover src={item.user.avatarUrl} alt="" className="avatar-image"/> : <User/>}<span><b>{item.title || item.user?.nickname || "网易云通知"}</b>{item.title && item.user && <small>{item.user.nickname}</small>}<small>{item.text}</small></span><time>{formatMessageTime(item.occurredAtMs)}</time></div>)}</div>}</>}
    {authenticated && <><SectionTitle>关注动态</SectionTitle>
    <RemoteNotice state={events} empty="暂无关注动态" retry={reloadEvents}/>
    {events.status === "ready" && <div className="message-list">{events.data.items.map((item) => <div key={item.id}><span aria-hidden="true"/>{item.user?.avatarUrl ? <Cover src={item.user.avatarUrl} alt="" className="avatar-image"/> : <User/>}<span><b>{item.user?.nickname || "网易云用户"}</b>{item.text && <small>{item.text}</small>}{item.track && <small>歌曲：{item.track.title} · {item.track.artists.join(" / ")}</small>}{!item.text && !item.track && item.eventType && <small>{item.eventType}</small>}</span><time>{formatMessageTime(item.occurredAtMs)}</time></div>)}</div>}</>}
  </Page>;
}

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
    case "dsp": return <DspWorkbenchView/>;
    default: return <HomeView/>;
  }
}
