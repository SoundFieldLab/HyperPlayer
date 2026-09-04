import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDown, Check, CloudArrowDown, DotsThree, Heart, Pause, Play, Queue, Repeat,
  RepeatOnce, Shuffle, SkipBack, SkipForward, SlidersHorizontal, SpeakerHigh,
  SpeakerSlash, Stop, MusicNotes, Waveform,
} from "@phosphor-icons/react";
import { bridge } from "../bridge";
import type { BackendCacheStatusDto, LyricsPayloadDto, TrackDto } from "../bridge/contracts";
import { Cover, formatTime, IconButton, RemoteNotice } from "../components/ui";
import { useRemote } from "../hooks/useRemote";
import { QueuePanel } from "../queue/QueuePanel";
import { useAppStore } from "../store";
import { useMainWindowTelemetry } from "../visualization/telemetry";
import { WaveformCanvas2D } from "../visualization/renderers";

export function PlayerDock(): React.JSX.Element | null {
  const { playback, togglePlayback, stop, next, previous, seek, setVolume, setRepeat, setExpanded, setOverlay, overlay } = useAppStore();
  const [modeMenu, setModeMenu] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const lastVolume = useRef(0.72);
  const track = playback?.current ?? null;
  const playing = playback?.status === "playing";
  const repeat = playback?.repeat ?? "sequence";
  const modes: Array<[typeof repeat, string, React.ReactNode]> = [
    ["sequence", "顺序播放", <Repeat/>], ["all", "列表循环", <Repeat weight="fill"/>],
    ["one", "单曲循环", <RepeatOnce/>], ["shuffle", "随机播放", <Shuffle/>],
  ];
  const currentMode = modes.find(([id]) => id === repeat) ?? modes[0];

  function cycleMode(): void {
    const index = modes.findIndex(([id]) => id === repeat);
    void setRepeat(modes[(index + 1) % modes.length][0]);
  }
  function changeVolume(value: number): void {
    const nextVolume = Math.max(0, Math.min(1, value));
    if (nextVolume > 0) lastVolume.current = nextVolume;
    void setVolume(nextVolume);
  }

  return <footer className={`player-dock ${track ? "" : "empty"}`}><button className="now-playing" onClick={() => track && setExpanded(true)} disabled={!track}>{track ? <Cover src={track.coverSeed} alt=""/> : <span className="empty-cover"><MusicNotes/></span>}<span><b>{track?.title ?? "选择一首歌曲"}</b><small>{track ? `${track.artists.join(" / ")} · ${track.source === "netease" ? "网易云" : "本地"}` : "播放控制将在载入曲目后启用"}</small></span><Heart/></button><div className="transport"><div><div className="mode-control"><IconButton label={`${currentMode[1]}，单击切换，右键选择`} active={repeat !== "sequence"} disabled={!track} onClick={cycleMode} className="mode-button">{currentMode[2]}</IconButton><button className="mode-menu-hit" aria-label="选择播放模式" disabled={!track} onClick={() => setModeMenu(!modeMenu)} onContextMenu={(event) => { event.preventDefault(); setModeMenu(true); }}/>{modeMenu && <div className="mode-menu" role="menu">{modes.map(([id, label, icon]) => <button key={id} role="menuitemradio" aria-checked={repeat === id} onClick={() => { void setRepeat(id); setModeMenu(false); }}>{icon}<span>{label}</span>{repeat === id && <Check/>}</button>)}</div>}</div><IconButton label="上一首" disabled={!track} onClick={() => void previous()}><SkipBack weight="fill"/></IconButton><button className="main-play" aria-label={playing ? "暂停" : "播放"} disabled={!track} onClick={() => void togglePlayback()}>{playing ? <Pause weight="fill"/> : <Play weight="fill"/>}</button><IconButton label="停止" disabled={!track} onClick={() => void stop()}><Stop weight="fill"/></IconButton><IconButton label="下一首" disabled={!track} onClick={() => void next()}><SkipForward weight="fill"/></IconButton></div><div className="progress-row"><span>{formatTime(playback?.positionMs ?? 0)}</span><input aria-label="播放进度" type="range" min={0} max={track?.durationMs ?? 1} value={playback?.positionMs ?? 0} disabled={!track} onChange={(event) => void seek(Number(event.target.value))}/><span>{formatTime(track?.durationMs ?? 0)}</span></div></div><div className="dock-tools"><span className="quality">{track?.quality ?? "LOSSLESS"}</span><IconButton label="音效工作台" onClick={() => useAppStore.getState().navigate("dsp")}><SlidersHorizontal/></IconButton><IconButton label="播放队列" active={overlay === "queue"} disabled={!track} onClick={() => setOverlay(overlay === "queue" ? "none" : "queue")}><Queue/></IconButton><div className="volume-control" onWheel={(event) => { if (!playback) return; event.preventDefault(); changeVolume(playback.volume + (event.deltaY < 0 ? .04 : -.04)); }}><IconButton label={!playback || playback.volume === 0 ? "取消静音" : `静音，当前音量 ${Math.round(playback.volume * 100)}%`} disabled={!playback} onClick={() => { if (!playback) return; setVolumeOpen(true); changeVolume(playback.volume === 0 ? lastVolume.current : 0); }}>{!playback || playback.volume === 0 ? <SpeakerSlash/> : <SpeakerHigh/>}</IconButton><input aria-label={`音量 ${Math.round((playback?.volume ?? 0) * 100)}%`} className="volume" type="range" min={0} max={1} step={0.01} value={playback?.volume ?? 0} disabled={!playback} onChange={(event) => changeVolume(Number(event.target.value))}/>{volumeOpen && playback && <div className="volume-popover"><b>输出音量</b><input aria-label="紧凑音量" type="range" min={0} max={1} step={.01} value={playback.volume} onChange={(event) => changeVolume(Number(event.target.value))}/><span>{Math.round(playback.volume * 100)}%</span><button disabled>输出设备信息不可用</button></div>}</div></div></footer>;
}

function KaraokeLine({ line, position }: { line: LyricsPayloadDto["document"]["lines"][number]; position: number }): React.JSX.Element {
  if (!line.words.length) return <>{line.text}</>;
  return <>{line.words.map((word, index) => {
    const duration = Math.max(1, word.endMs - word.startMs);
    const progress = Math.max(0, Math.min(1, (position - word.startMs) / duration));
    return <span className="lyric-word" key={`${word.startMs}-${index}`} style={{ "--word-progress": `${progress * 100}%` } as React.CSSProperties}>{word.text}</span>;
  })}</>;
}

export function LyricsContent({ compact = false, follow = false }: { compact?: boolean; follow?: boolean }): React.JSX.Element {
  const playback = useAppStore((state) => state.playback);
  const track = playback?.current;
  const activeRef = useRef<HTMLDivElement>(null);
  const [lyrics, reload] = useRemote<LyricsPayloadDto>(async () => {
    if (!track) throw { code: "unavailable", message: "当前没有播放曲目" };
    return bridge.lyricsGet({ id: track.id, source: track.source });
  }, [track?.id, track?.source], (value) => value.document.lines.length === 0);
  const position = playback?.positionMs ?? 0;
  const lines = lyrics.status === "ready" ? lyrics.data.document.lines : [];
  let active = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startMs <= position) { active = index; break; }
  }
  useEffect(() => {
    if (follow && activeRef.current) activeRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, follow, track?.id]);
  if (lyrics.status !== "ready") return <RemoteNotice state={lyrics} empty="这首歌曲没有可显示的歌词" retry={reload}/>;
  if (compact) {
    const line = lines[active];
    const next = lines[active + 1];
    return <><p><KaraokeLine line={line} position={position}/></p><small>{line?.translation || next?.text || ""}</small></>;
  }
  return <>{lines.map((line, index) => <div ref={index === active ? activeRef : undefined} key={`${line.startMs}-${index}`} className={index === active ? "current" : Math.abs(index - active) === 1 ? "near" : ""}><p><KaraokeLine line={line} position={position}/></p>{line.translation && <small>{line.translation}</small>}</div>)}</>;
}

function useWaveformTelemetry() {
  const reduceMotion = useAppStore((state) => state.settings?.reduceMotion);
  return useMainWindowTelemetry(() => bridge.createTelemetryTransport(), true, reduceMotion);
}

function WaveformCanvas(): React.JSX.Element {
  const frame = useWaveformTelemetry();
  return <div className="wave-pop">{frame?.waveform
    ? <WaveformCanvas2D bins={frame.waveform} ariaLabel="实时立体声波形" />
    : <div aria-label="波形暂无数据" style={{ height: 54, display: "grid", alignItems: "center" }}><span aria-hidden="true" style={{ display: "block", width: "100%", borderTop: "1px solid rgba(255, 255, 255, 0.22)" }} /></div>}<span>OUTPUT</span></div>;
}

function cacheErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return error instanceof Error ? error.message : fallback;
}

type CacheControlState =
  | { phase: "loading" }
  | { phase: "ready"; data: BackendCacheStatusDto }
  | { phase: "error"; message: string; retryAction: "cache" | "remove" | null };

function ExpandedCacheControl({ track }: { track: TrackDto }): React.JSX.Element {
  const generation = useRef(0);
  const [state, setState] = useState<CacheControlState>({ phase: "loading" });

  function loadStatus(): void {
    const request = ++generation.current;
    const trackRef = { id: track.id, source: track.source };
    setState({ phase: "loading" });
    void bridge.cacheStatus(trackRef).then((data) => {
      if (request === generation.current) setState({ phase: "ready", data });
    }).catch((error: unknown) => {
      if (request === generation.current) setState({ phase: "error", message: cacheErrorMessage(error, "缓存状态查询失败"), retryAction: null });
    });
  }

  useEffect(() => {
    loadStatus();
    return () => { generation.current += 1; };
  }, [track.id, track.source]);

  async function runAction(action: "cache" | "remove"): Promise<void> {
    const request = ++generation.current;
    const trackRef = { id: track.id, source: track.source };
    setState({ phase: "loading" });
    try {
      if (action === "remove") await bridge.cacheRemove(trackRef);
      else await bridge.cacheTrack(trackRef, track.quality);
      if (request !== generation.current) return;
      loadStatus();
    } catch (error) {
      if (request === generation.current) setState({ phase: "error", message: cacheErrorMessage(error, action === "remove" ? "移除缓存失败" : "缓存任务启动失败"), retryAction: action });
    }
  }

  if (state.phase === "loading") return <button disabled><CloudArrowDown/>正在查询缓存</button>;
  if (state.phase === "error") {
    const retryAction = state.retryAction;
    return <><button onClick={retryAction ? () => void runAction(retryAction) : loadStatus}><CloudArrowDown/>{retryAction ? "重试缓存" : "重试查询"}</button><span role="alert">{state.message}</span></>;
  }

  switch (state.data.status) {
    case "none": return <button onClick={() => void runAction("cache")}><CloudArrowDown/>缓存</button>;
    case "failed": return <button onClick={() => void runAction("cache")}><CloudArrowDown/>重试缓存</button>;
    case "prefetching": return <button disabled><CloudArrowDown/>正在缓存</button>;
    case "ready": return <button onClick={() => void runAction("remove")}><CloudArrowDown/>移除缓存</button>;
    case "entitlement-locked": return <><button disabled><CloudArrowDown/>权益缓存已锁定</button><span role="status">当前绑定账号的服务端权益验证通过后才能使用</span></>;
  }
}

export function ExpandedPlayer(): React.JSX.Element | null {
  const { playback, setExpanded, overlay, setOverlay } = useAppStore();
  const [wave, setWave] = useState(false);
  const [follow, setFollow] = useState(true);
  if (!playback?.current) return null;
  const track = playback.current;

  return <motion.div className="expanded-player" initial={{opacity:0,y:40}} animate={{opacity:1,y:0}} exit={{opacity:0,y:24}} transition={{duration:.38}} style={{"--cover":`url(${track.coverSeed})`} as React.CSSProperties}>
    <div className="atmosphere"/><header><IconButton label="收起播放层" onClick={() => setExpanded(false)}><CaretDown/></IconButton><span>正在播放 · {track.source === "netease" ? "网易云" : "本地"}</span><div><IconButton label="波形" active={wave} onClick={() => setWave(!wave)}><Waveform/></IconButton><IconButton label="队列" active={overlay === "queue"} onClick={() => setOverlay(overlay === "queue" ? "none" : "queue")}><Queue/></IconButton><IconButton label="更多" disabled><DotsThree/></IconButton></div></header>
    <div className="player-stage"><section className="album-stage"><Cover src={track.coverSeed} alt={track.album}/><div className="stage-meta"><span className="eyebrow">{track.album} · {track.quality}</span><h1>{track.title}</h1><p>{track.artists.join(" / ")}</p><div><button disabled><Heart/>喜欢</button><ExpandedCacheControl track={track}/></div></div>{wave && <WaveformCanvas/>}</section><section className="lyrics" onWheel={() => setFollow(false)}>{!follow && <button className="return-current" onClick={() => setFollow(true)}>回到当前歌词</button>}<LyricsContent follow={follow}/></section></div>
    <AnimatePresence>{overlay === "queue" && <><button aria-label="关闭队列" className="panel-scrim" onClick={() => setOverlay("none")}/><QueuePanel/></>}</AnimatePresence><PlayerDock/>
  </motion.div>;
}
