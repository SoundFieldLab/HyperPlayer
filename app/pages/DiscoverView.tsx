import { useEffect, useRef, useState } from "react";
import { Broadcast, CalendarBlank, ChartBar, Eye, Info, Play, Queue, VideoCamera } from "@phosphor-icons/react";
import { fallbackCover } from "../artwork";
import { adaptTrack, bridge } from "../bridge";
import type { NeteaseDjProgramDto, NeteaseDjRadioDto, NeteaseMvDto } from "../bridge/contracts";
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

export function DiscoverView(): React.JSX.Element {
  const navigate = useAppStore((state) => state.navigate);
  const playTrack = useAppStore((state) => state.playTrack);
  const enqueueTrack = useAppStore((state) => state.enqueueTrack);
  const [charts, reloadCharts] = useRemote(() => bridge.neteaseCharts(), [], (items) => items.length === 0);
  const [newSongs, reloadNewSongs] = useRemote(() => bridge.neteaseNewSongs(), [], (value) => value.tracks.length === 0);
  const mvs = useCursorPage((cursor) => bridge.neteaseMvs(cursor).then((page) => ({ items: page.items, nextCursor: page.nextCursor })));
  const radios = useCursorPage((cursor) => bridge.neteaseDjRadios(cursor).then((page) => ({ items: page.radios, nextCursor: page.nextCursor })));
  const [selectedRadio, setSelectedRadio] = useState<NeteaseDjRadioDto | null>(null);
  const programs = useCursorPage(
    (cursor) => selectedRadio
      ? bridge.neteaseDjPrograms(selectedRadio.id, cursor).then((page) => ({ items: page.programs, nextCursor: page.nextCursor }))
      : Promise.resolve({ items: [], nextCursor: null }),
    selectedRadio?.id ?? "none",
  );
  const [selectedMv, setSelectedMv] = useState<NeteaseMvDto | null>(null);
  const [mvDetail, setMvDetail] = useState<RemoteState<Awaited<ReturnType<typeof bridge.neteaseMvDetail>>>>({ status: "idle" });
  const mvGeneration = useRef(0);

  useEffect(() => () => { mvGeneration.current += 1; }, []);

  useEffect(() => {
    if (!selectedRadio && radios.state.status === "ready" && radios.state.data.items[0]) setSelectedRadio(radios.state.data.items[0]);
  }, [radios.state, selectedRadio]);

  function openMv(mv: NeteaseMvDto): void {
    const current = ++mvGeneration.current;
    setSelectedMv(mv);
    setMvDetail({ status: "loading" });
    void bridge.neteaseMvDetail(mv.id)
      .then((detail) => { if (current === mvGeneration.current) setMvDetail(remoteSuccess(detail)); })
      .catch((error: unknown) => { if (current === mvGeneration.current) setMvDetail(remoteFailure(error)); });
  }

  const songTracks = newSongs.status === "ready" ? newSongs.data.tracks.map(adaptTrack) : [];

  return <Page title="发现" subtitle="公开榜单、新歌、MV 与 DJ 电台，无需登录">
    <section className="discover-section" aria-label="榜单">
      <SectionTitle>榜单</SectionTitle>
      <RemoteNotice state={charts} empty="暂无榜单" retry={reloadCharts}/>
      {charts.status === "ready" && <div className="discover-chart-grid">{charts.data.map((chart) => <button key={chart.id} className="discover-chart" onClick={() => navigate("playlist", chart.id)}><Cover src={chart.coverUrl || fallbackCover(String(chart.id))} alt=""/><span><b>{chart.name}</b><small>{chart.updateFrequency || "公开榜单"}</small>{chart.previewTracks.slice(0, 3).map((track, index) => <em key={track.trackRef.id}>{index + 1}. {track.title}</em>)}</span><ChartBar/></button>)}</div>}
    </section>

    <section className="discover-section" aria-label="新歌">
      <SectionTitle>新歌</SectionTitle>
      <RemoteNotice state={newSongs} empty="暂无新歌" retry={reloadNewSongs}/>
      {songTracks.length > 0 && <TrackTable tracks={songTracks} compact playbackContext={{ kind: "search", id: null }}/>}
    </section>

    <section className="discover-section" aria-label="MV">
      <SectionTitle>MV</SectionTitle>
      <RemoteNotice state={mvs.state} empty="暂无 MV" retry={mvs.reload}/>
      {mvs.state.status === "ready" && <div className="discover-mv-grid">{mvs.state.data.items.map((mv) => <button key={mv.id} className="discover-mv" onClick={() => openMv(mv)}><div><Cover src={mv.coverUrl || fallbackCover(String(mv.id))} alt=""/><span><Eye/>{formatCount(mv.playCount)}</span>{mv.durationMs !== null && <time>{formatTime(mv.durationMs)}</time>}</div><b>{mv.name}</b><small>{mv.artists.map((artist) => artist.name).join(" / ") || "未知艺人"}</small></button>)}</div>}
      {mvs.state.status === "ready" && <LoadMore cursor={mvs.state.data.nextCursor} loading={mvs.loadingMore} error={mvs.moreError} onClick={() => void mvs.loadMore()}/>}
      {selectedMv && <div className="discover-detail" role="region" aria-label={`${selectedMv.name} MV 详情`}><div><VideoCamera/><span><b>{selectedMv.name}</b><small>{selectedMv.artists.map((artist) => artist.name).join(" / ") || "未知艺人"}</small></span><button className="button secondary" onClick={() => { mvGeneration.current += 1; setSelectedMv(null); setMvDetail({ status: "idle" }); }}>关闭</button></div><RemoteNotice state={mvDetail} retry={() => openMv(selectedMv)}/>{mvDetail.status === "ready" && <dl><div><dt>发布时间</dt><dd>{mvDetail.data.publishTime || "未知"}</dd></div><div><dt>收藏</dt><dd>{formatCount(mvDetail.data.favoriteCount)}</dd></div><div><dt>评论</dt><dd>{formatCount(mvDetail.data.commentCount)}</dd></div>{mvDetail.data.description && <div className="wide"><dt>简介</dt><dd>{mvDetail.data.description}</dd></div>}</dl>}<p><Info/>当前后端尚未提供 MV 播放地址，此处仅展示真实元数据。</p></div>}
    </section>

    <section className="discover-section" aria-label="DJ / 电台">
      <SectionTitle>DJ / 电台</SectionTitle>
      <RemoteNotice state={radios.state} empty="暂无电台" retry={radios.reload}/>
      {radios.state.status === "ready" && <div className="discover-radio-strip">{radios.state.data.items.map((radio) => <button key={radio.id} className={selectedRadio?.id === radio.id ? "selected" : ""} aria-pressed={selectedRadio?.id === radio.id} onClick={() => setSelectedRadio(radio)}><Cover src={radio.coverUrl || fallbackCover(String(radio.id))} alt=""/><span><b>{radio.name}</b><small>{radio.category || `${formatCount(radio.programCount)} 期节目`}</small></span></button>)}</div>}
      {radios.state.status === "ready" && <LoadMore cursor={radios.state.data.nextCursor} loading={radios.loadingMore} error={radios.moreError} onClick={() => void radios.loadMore()}/>}
      {selectedRadio && <div className="discover-programs"><header><Broadcast/><span><b>{selectedRadio.name}</b><small>{selectedRadio.description || "最新节目"}</small></span></header><RemoteNotice state={programs.state} empty="此电台暂无节目" retry={programs.reload}/>{programs.state.status === "ready" && programs.state.data.items.map((program: NeteaseDjProgramDto) => { const track = program.mainTrack ? adaptTrack(program.mainTrack) : null; return <div className="discover-program" key={program.id}><CalendarBlank/><span><b>{program.name}</b><small>{program.createdAtMs ? new Date(program.createdAtMs).toLocaleDateString() : "日期未知"} · {formatCount(program.listenerCount)} 次收听</small></span><button className="icon-button" title="播放节目主曲目" aria-label={`播放 ${program.name}`} disabled={!track} onClick={() => track && void playTrack(track, { kind: "manual", id: null })}><Play weight="fill"/></button><button className="icon-button" title="下一首播放" aria-label={`将 ${program.name} 加入队列`} disabled={!track} onClick={() => track && void enqueueTrack(track, "playNext")}><Queue/></button></div>; })}<LoadMore cursor={programs.state.status === "ready" ? programs.state.data.nextCursor : null} loading={programs.loadingMore} error={programs.moreError} onClick={() => void programs.loadMore()}/></div>}
    </section>
  </Page>;
}
