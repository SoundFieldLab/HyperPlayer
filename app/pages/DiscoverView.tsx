import { useEffect, useRef, useState } from "react";
import { Broadcast, CalendarBlank, ChartBar, Eye, Info, MusicNotes, Play, Queue, VideoCamera } from "@phosphor-icons/react";
import { fallbackCover } from "../artwork";
import { adaptTrack, bridge } from "../bridge";
import type { NeteaseDjProgramDto, NeteaseDjRadioDto, NeteaseMvDto, NeteaseMvPlaybackDto } from "../bridge/contracts";
import { TrackTable } from "../components/TrackTable";
import { Cover, Page, RemoteNotice, SectionTitle, formatTime } from "../components/ui";
import { useRemote } from "../hooks/useRemote";
import { remoteFailure, remoteSuccess, type RemoteState } from "../remote";
import { useAppStore } from "../store";

type CursorPage<T> = { items: T[]; nextCursor: string | null };

function useCursorPage<T>(load: (cursor: string | null) => Promise<CursorPage<T>>, key: string | number = "default") {
  const [state, setState] = useState<RemoteState<CursorPage<T>>>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const generation = useRef(0);

  function reload(): void {
    const current = ++generation.current;
    setState({ status: "loading" });
    setMoreError(null);
    void load(null)
      .then((page) => {
        if (current === generation.current) setState(remoteSuccess(page, page.items.length === 0));
      })
      .catch((error: unknown) => {
        if (current === generation.current) setState(remoteFailure(error));
      });
  }

  useEffect(() => {
    reload();
    return () => { generation.current += 1; };
  }, [key]);

  async function loadMore(): Promise<void> {
    if (state.status !== "ready" || !state.data.nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await load(state.data.nextCursor);
      if (current === generation.current) {
        setState(remoteSuccess({ items: [...state.data.items, ...page.items], nextCursor: page.nextCursor }));
      }
    } catch (error) {
      if (current === generation.current) {
        const failure = remoteFailure(error);
        setMoreError("message" in failure ? failure.message : "无法加载更多内容");
      }
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  }

  return { state, reload, loadMore, loadingMore, moreError };
}

function LoadMore({ cursor, loading, error, onClick }: { cursor: string | null; loading: boolean; error: string | null; onClick: () => void }): React.JSX.Element | null {
  if (!cursor && !error) return null;
  return <div className="discover-more">{error && <span role="alert">{error}</span>}<button className="button secondary" disabled={loading || !cursor} onClick={onClick}>{loading ? "正在加载" : "加载更多"}</button></div>;
}

function formatCount(value: number | null): string {
  return value === null ? "暂无统计" : value.toLocaleString();
}

/**
 * 发现页空态/错误态区分：empty 态不再走 RemoteNotice（其固定附带「后端返回了空结果」副文案），
 * 改为渲染友好的引导块 + 重新加载；loading/error/unavailable 仍交给 RemoteNotice（错误信息 + 重试按钮）。
 */
function DiscoverNotice<T>({ state, icon, empty, hint, retry }: { state: RemoteState<T>; icon: React.ReactNode; empty: string; hint: string; retry?: () => void }): React.JSX.Element | null {
  if (state.status === "empty") return <div className="remote-state empty">{icon}<b>{empty}</b><span>{hint}</span>{retry && <button className="button secondary" onClick={retry}>重新加载</button>}</div>;
  return <RemoteNotice state={state} retry={retry}/>;
}

export function DiscoverView(): React.JSX.Element {
  const navigate = useAppStore((state) => state.navigate);
  const playTrack = useAppStore((state) => state.playTrack);
  const enqueueTrack = useAppStore((state) => state.enqueueTrack);
  const [charts, reloadCharts] = useRemote(() => bridge.neteaseCharts(), [], (items) => items.length === 0);
  const [newSongs, reloadNewSongs] = useRemote(() => bridge.neteaseNewSongs(), [], (value) => value.tracks.length === 0);
  const mvs = useCursorPage((cursor) => bridge.neteaseMvs(cursor).then((page) => ({ items: page.items, nextCursor: page.nextCursor })));
  const radios = useCursorPage((cursor) => bridge.neteaseDjRadios(cursor).then((page) => ({ items: page.radios, nextCursor: page.nextCursor })));
  const [selectedRadio, setSelectedRadio] = useState<NeteaseDjRadioDto | null>(null);
  const [djTab, setDjTab] = useState<"radios" | "categories" | "recommend" | "toplist" | "sublist">("radios");
  const djCategories = useRemote(() => bridge.neteaseDjCategories(), [], (value) => value.categories.length === 0);
  const djRecommend = useRemote(() => bridge.neteaseDjRecommend(), [], (value) => value.radios.length === 0);
  const djToplist = useRemote(() => bridge.neteaseDjProgramToplist(), [], (value) => value.programs.length === 0);
  const djSublist = useRemote(() => bridge.neteaseDjSublist(), [], (value) => value.radios.length === 0);
  const programs = useCursorPage(
    (cursor) => selectedRadio
      ? bridge.neteaseDjPrograms(selectedRadio.id, cursor).then((page) => ({ items: page.programs, nextCursor: page.nextCursor }))
      : Promise.resolve({ items: [], nextCursor: null }),
    selectedRadio?.id ?? "none",
  );
  const [selectedMv, setSelectedMv] = useState<NeteaseMvDto | null>(null);
  const [mvDetail, setMvDetail] = useState<RemoteState<Awaited<ReturnType<typeof bridge.neteaseMvDetail>>>>({ status: "idle" });
  const [mvPlayback, setMvPlayback] = useState<RemoteState<NeteaseMvPlaybackDto>>({ status: "idle" });
  const mvGeneration = useRef(0);

  useEffect(() => () => { mvGeneration.current += 1; }, []);

  useEffect(() => {
    if (!selectedRadio && radios.state.status === "ready" && radios.state.data.items[0]) setSelectedRadio(radios.state.data.items[0]);
  }, [radios.state, selectedRadio]);

  function openMv(mv: NeteaseMvDto): void {
    const current = ++mvGeneration.current;
    setSelectedMv(mv);
    setMvDetail({ status: "loading" });
    setMvPlayback({ status: "idle" });
    void bridge.neteaseMvDetail(mv.id)
      .then((detail) => { if (current === mvGeneration.current) setMvDetail(remoteSuccess(detail)); })
      .catch((error: unknown) => { if (current === mvGeneration.current) setMvDetail(remoteFailure(error)); });
  }
  function playMv(): void {
    if (!selectedMv) return;
    const current = ++mvGeneration.current;
    setMvPlayback({ status: "loading" });
    void bridge.neteaseMvPlayback(selectedMv.id)
      .then((playback) => { if (current === mvGeneration.current) setMvPlayback(remoteSuccess(playback)); })
      .catch((error: unknown) => { if (current === mvGeneration.current) setMvPlayback(remoteFailure(error)); });
  }

  const songTracks = newSongs.status === "ready" ? newSongs.data.tracks.map(adaptTrack) : [];

  return <Page title="发现" subtitle="公开榜单、新歌、MV 与 DJ 电台，无需登录">
    <section className="discover-section" aria-label="榜单">
      <SectionTitle>榜单</SectionTitle>
      <DiscoverNotice state={charts} icon={<ChartBar/>} empty="暂无公开榜单" hint="网易云暂未返回榜单数据，可稍后重新加载。" retry={reloadCharts}/>
      {charts.status === "ready" && <div className="discover-chart-grid">{charts.data.map((chart) => <button key={chart.id} className="discover-chart" onClick={() => navigate("playlist", chart.id)}><Cover src={chart.coverUrl || fallbackCover(String(chart.id))} alt=""/><span><b>{chart.name}</b><small>{chart.updateFrequency || "公开榜单"}</small>{chart.previewTracks.slice(0, 3).map((track, index) => <em key={track.trackRef.id}>{index + 1}. {track.title}</em>)}</span><ChartBar/></button>)}</div>}
    </section>

    <section className="discover-section" aria-label="新歌">
      <SectionTitle>新歌</SectionTitle>
      <DiscoverNotice state={newSongs} icon={<MusicNotes/>} empty="暂无新歌" hint="新歌上架暂时没有返回数据，可稍后重新加载。" retry={reloadNewSongs}/>
      {songTracks.length > 0 && <TrackTable tracks={songTracks} compact playbackContext={{ kind: "search", id: null }}/>}
    </section>

    <section className="discover-section" aria-label="MV">
      <SectionTitle>MV</SectionTitle>
      <DiscoverNotice state={mvs.state} icon={<VideoCamera/>} empty="暂无 MV" hint="MV 库暂时没有可展示的内容，可稍后重新加载。" retry={mvs.reload}/>
      {mvs.state.status === "ready" && <div className="discover-mv-grid">{mvs.state.data.items.map((mv) => <button key={mv.id} className="discover-mv" onClick={() => openMv(mv)}><div><Cover src={mv.coverUrl || fallbackCover(String(mv.id))} alt=""/><span><Eye/>{formatCount(mv.playCount)}</span>{mv.durationMs !== null && <time>{formatTime(mv.durationMs)}</time>}</div><b>{mv.name}</b><small>{mv.artists.map((artist) => artist.name).join(" / ") || "未知艺人"}</small></button>)}</div>}
      {mvs.state.status === "ready" && <LoadMore cursor={mvs.state.data.nextCursor} loading={mvs.loadingMore} error={mvs.moreError} onClick={() => void mvs.loadMore()}/>}
      {selectedMv && <div className="discover-detail" role="region" aria-label={`${selectedMv.name} MV 详情`}><div><VideoCamera/><span><b>{selectedMv.name}</b><small>{selectedMv.artists.map((artist) => artist.name).join(" / ") || "未知艺人"}</small></span><button className="button secondary" onClick={() => { mvGeneration.current += 1; setSelectedMv(null); setMvDetail({ status: "idle" }); }}>关闭</button></div><RemoteNotice state={mvDetail} retry={() => openMv(selectedMv)}/>{mvDetail.status === "ready" && <dl><div><dt>分辨率</dt><dd>待播放地址下发</dd></div><div><dt>时长</dt><dd>{mvDetail.data.mv.durationMs !== null ? formatTime(mvDetail.data.mv.durationMs) : "未知"}</dd></div><div><dt>播放</dt><dd>{formatCount(mvDetail.data.mv.playCount)}</dd></div><div><dt>收录</dt><dd>{formatCount(mvDetail.data.favoriteCount)}</dd></div><div><dt>发布时间</dt><dd>{mvDetail.data.publishTime || "未知"}</dd></div><div><dt>评论</dt><dd>{formatCount(mvDetail.data.commentCount)}</dd></div>{mvDetail.data.description && <div className="wide"><dt>简介</dt><dd>{mvDetail.data.description}</dd></div>}</dl>}<div className="detail-actions"><button className="button primary" onClick={() => playMv()} disabled={mvPlayback.status === "loading"}><Play weight="fill"/>播放 MV</button></div>{mvPlayback.status === "ready" && mvPlayback.data.url && <video className="mv-player" controls autoPlay src={mvPlayback.data.url}/>}<RemoteNotice state={mvPlayback} retry={() => playMv()}/></div>}
    </section>

    <section className="discover-section" aria-label="DJ / 电台">
      <SectionTitle>DJ / 电台</SectionTitle>
      <div className="discover-dj-tabs" role="tablist" aria-label="电台内容类型">
        <button role="tab" aria-selected={djTab === "radios"} className={djTab === "radios" ? "active" : ""} onClick={() => setDjTab("radios")}>热门电台</button>
        <button role="tab" aria-selected={djTab === "categories"} className={djTab === "categories" ? "active" : ""} onClick={() => setDjTab("categories")}>电台分类</button>
        <button role="tab" aria-selected={djTab === "recommend"} className={djTab === "recommend" ? "active" : ""} onClick={() => setDjTab("recommend")}>推荐电台</button>
        <button role="tab" aria-selected={djTab === "toplist"} className={djTab === "toplist" ? "active" : ""} onClick={() => setDjTab("toplist")}>节目榜</button>
        <button role="tab" aria-selected={djTab === "sublist"} className={djTab === "sublist" ? "active" : ""} onClick={() => setDjTab("sublist")}>我的订阅</button>
      </div>
      {djTab === "categories" && <div className="discover-dj-categories"><DiscoverNotice state={djCategories[0]} icon={<Broadcast/>} empty="暂无电台分类" hint="电台分类暂时没有返回数据。" retry={djCategories[1]}/>{djCategories[0].status === "ready" && djCategories[0].data.categories.map((category) => <button key={category.id} className="dj-category-chip" onClick={() => setDjTab("radios")}>{category.name}</button>)}</div>}
      {djTab === "recommend" && <div className="discover-radio-strip">{djRecommend[0].status === "ready" && djRecommend[0].data.radios.map((radio) => <button key={radio.id} className={selectedRadio?.id === radio.id ? "selected" : ""} aria-pressed={selectedRadio?.id === radio.id} onClick={() => setSelectedRadio(radio)}><Cover src={radio.coverUrl || fallbackCover(String(radio.id))} alt=""/><span><b>{radio.name}</b><small>{radio.category || "推荐电台"}</small></span></button>)}<DiscoverNotice state={djRecommend[0]} icon={<Broadcast/>} empty="暂无推荐电台" hint="推荐电台暂时没有返回数据。" retry={djRecommend[1]}/></div>}
      {djTab === "toplist" && <div className="discover-programs"><DiscoverNotice state={djToplist[0]} icon={<CalendarBlank/>} empty="暂无节目榜" hint="节目榜暂时没有返回数据。" retry={djToplist[1]}/>{djToplist[0].status === "ready" && djToplist[0].data.programs.map((program: NeteaseDjProgramDto) => { const track = program.mainTrack ? adaptTrack(program.mainTrack) : null; return <div className="discover-program" key={program.id}><CalendarBlank/><span><b>{program.name}</b><small>{program.radio?.name || "节目榜"} · {formatCount(program.listenerCount)} 次收听</small></span><button className="icon-button" title="播放节目主曲目" aria-label={`播放 ${program.name}`} disabled={!track} onClick={() => track && void playTrack(track, { kind: "manual", id: null })}><Play weight="fill"/></button></div>; })}</div>}
      {djTab === "sublist" && <div className="discover-radio-strip"><DiscoverNotice state={djSublist[0]} icon={<Broadcast/>} empty="登录后查看订阅的电台" hint="「我的订阅」来自当前登录的网易云账号。" retry={djSublist[1]}/>{djSublist[0].status === "ready" && djSublist[0].data.radios.map((radio) => <button key={radio.id} className={selectedRadio?.id === radio.id ? "selected" : ""} aria-pressed={selectedRadio?.id === radio.id} onClick={() => setSelectedRadio(radio)}><Cover src={radio.coverUrl || fallbackCover(String(radio.id))} alt=""/><span><b>{radio.name}</b><small>{radio.category || `${formatCount(radio.programCount)} 期节目`}</small></span></button>)}</div>}
      <DiscoverNotice state={radios.state} icon={<Broadcast/>} empty="暂无电台" hint="热门电台暂时没有返回数据，可稍后重新加载。" retry={radios.reload}/>
      {radios.state.status === "ready" && <div className="discover-radio-strip">{radios.state.data.items.map((radio) => <button key={radio.id} className={selectedRadio?.id === radio.id ? "selected" : ""} aria-pressed={selectedRadio?.id === radio.id} onClick={() => setSelectedRadio(radio)}><Cover src={radio.coverUrl || fallbackCover(String(radio.id))} alt=""/><span><b>{radio.name}</b><small>{radio.category || `${formatCount(radio.programCount)} 期节目`}</small></span></button>)}</div>}
      {radios.state.status === "ready" && <LoadMore cursor={radios.state.data.nextCursor} loading={radios.loadingMore} error={radios.moreError} onClick={() => void radios.loadMore()}/>}
      {selectedRadio && <div className="discover-programs"><header><Broadcast/><span><b>{selectedRadio.name}</b><small>{selectedRadio.description || "最新节目"}</small></span></header><DiscoverNotice state={programs.state} icon={<CalendarBlank/>} empty="此电台暂无节目" hint="该电台暂时没有可展示的节目。" retry={programs.reload}/>{programs.state.status === "ready" && programs.state.data.items.map((program: NeteaseDjProgramDto) => { const track = program.mainTrack ? adaptTrack(program.mainTrack) : null; return <div className="discover-program" key={program.id}><CalendarBlank/><span><b>{program.name}</b><small>{program.createdAtMs ? new Date(program.createdAtMs).toLocaleDateString() : "日期未知"} · {formatCount(program.listenerCount)} 次收听</small></span><button className="icon-button" title="播放节目主曲目" aria-label={`播放 ${program.name}`} disabled={!track} onClick={() => track && void playTrack(track, { kind: "manual", id: null })}><Play weight="fill"/></button><button className="icon-button" title="下一首播放" aria-label={`将 ${program.name} 加入队列`} disabled={!track} onClick={() => track && void enqueueTrack(track, "playNext")}><Queue/></button></div>; })}<LoadMore cursor={programs.state.status === "ready" ? programs.state.data.nextCursor : null} loading={programs.loadingMore} error={programs.moreError} onClick={() => void programs.loadMore()}/></div>}
    </section>
  </Page>;
}
