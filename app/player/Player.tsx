import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDown, Check, CloudArrowDown, DotsThree, Heart, Pause, Play, Queue, Repeat,
  RepeatOnce, Shuffle, SkipBack, SkipForward, SlidersHorizontal, SpeakerHigh,
  SpeakerSlash, Stop, Waveform,
} from "@phosphor-icons/react";
import { bridge } from "../bridge";
import type { LyricsPayloadDto } from "../bridge/contracts";
import { Cover, formatTime, IconButton, RemoteNotice } from "../components/ui";
import { useRemote } from "../hooks/useRemote";
import { QueuePanel } from "../queue/QueuePanel";
import { useAppStore } from "../store";

export function PlayerDock(): React.JSX.Element | null {
  const { playback, togglePlayback, stop, next, previous, seek, setVolume, setRepeat, setExpanded, setOverlay, overlay } = useAppStore();
  const [modeMenu, setModeMenu] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const lastVolume = useRef(0.72);
  if (!playback?.current) return null;

  const track = playback.current;
  const playing = playback.status === "playing";
  const repeat = playback.repeat;
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

  return <footer className="player-dock"><button className="now-playing" onClick={() => setExpanded(true)}><Cover src={track.coverSeed} alt=""/><span><b>{track.title}</b><small>{track.artists.join(" / ")} · {track.source === "netease" ? "网易云" : "本地"}</small></span><Heart/></button><div className="transport"><div><div className="mode-control"><IconButton label={`${currentMode[1]}，单击切换，右键选择`} active={playback.repeat !== "sequence"} onClick={cycleMode} className="mode-button">{currentMode[2]}</IconButton><button className="mode-menu-hit" aria-label="选择播放模式" onClick={() => setModeMenu(!modeMenu)} onContextMenu={(event) => { event.preventDefault(); setModeMenu(true); }}/>{modeMenu && <div className="mode-menu" role="menu">{modes.map(([id, label, icon]) => <button key={id} role="menuitemradio" aria-checked={playback.repeat === id} onClick={() => { void setRepeat(id); setModeMenu(false); }}>{icon}<span>{label}</span>{playback.repeat === id && <Check/>}</button>)}</div>}</div><IconButton label="上一首" onClick={() => void previous()}><SkipBack weight="fill"/></IconButton><button className="main-play" aria-label={playing ? "暂停" : "播放"} onClick={() => void togglePlayback()}>{playing ? <Pause weight="fill"/> : <Play weight="fill"/>}</button><IconButton label="停止" onClick={() => void stop()}><Stop weight="fill"/></IconButton><IconButton label="下一首" onClick={() => void next()}><SkipForward weight="fill"/></IconButton><IconButton label="展开播放层" onClick={() => setExpanded(true)}><CaretDown className="flip"/></IconButton></div><div className="progress-row"><span>{formatTime(playback.positionMs)}</span><input aria-label="播放进度" type="range" min={0} max={track.durationMs} value={playback.positionMs} onChange={(event) => void seek(Number(event.target.value))}/><span>{formatTime(track.durationMs)}</span></div></div><div className="dock-tools"><span className="quality">{track.quality}</span><IconButton label="DSP 规格待接入" disabled><SlidersHorizontal/></IconButton><IconButton label="播放队列" active={overlay === "queue"} onClick={() => setOverlay(overlay === "queue" ? "none" : "queue")}><Queue/></IconButton><div className="volume-control" onWheel={(event) => { event.preventDefault(); changeVolume(playback.volume + (event.deltaY < 0 ? .04 : -.04)); }}><IconButton label={playback.volume === 0 ? "取消静音" : `静音，当前音量 ${Math.round(playback.volume * 100)}%`} onClick={() => { setVolumeOpen(true); changeVolume(playback.volume === 0 ? lastVolume.current : 0); }}>{playback.volume === 0 ? <SpeakerSlash/> : <SpeakerHigh/>}</IconButton><input aria-label={`音量 ${Math.round(playback.volume * 100)}%`} className="volume" type="range" min={0} max={1} step={0.01} value={playback.volume} onChange={(event) => changeVolume(Number(event.target.value))}/>{volumeOpen && <div className="volume-popover"><b>输出音量</b><input aria-label="紧凑音量" type="range" min={0} max={1} step={.01} value={playback.volume} onChange={(event) => changeVolume(Number(event.target.value))}/><span>{Math.round(playback.volume * 100)}%</span><button disabled>输出设备信息不可用</button></div>}</div></div></footer>;
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

function WaveformCanvas(): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#ff761c";
    context.lineWidth = 2;
    context.beginPath();
    for (let index = 0; index < 70; index += 1) {
      const x = index * canvas.width / 69;
      const amplitude = (Math.sin(index * .77) * .5 + .5) * 24 + 5;
      context.moveTo(x, canvas.height / 2 - amplitude);
      context.lineTo(x, canvas.height / 2 + amplitude);
    }
    context.stroke();
  }, []);
  return <div className="wave-pop"><canvas ref={ref} width={420} height={120}/><span>OUTPUT</span></div>;
}

export function ExpandedPlayer(): React.JSX.Element | null {
  const { playback, setExpanded, overlay, setOverlay } = useAppStore();
  const [wave, setWave] = useState(false);
  const [follow, setFollow] = useState(true);
  if (!playback?.current) return null;
  const track = playback.current;

  return <motion.div className="expanded-player" initial={{opacity:0,y:40}} animate={{opacity:1,y:0}} exit={{opacity:0,y:24}} transition={{duration:.38}} style={{"--cover":`url(${track.coverSeed})`} as React.CSSProperties}>
    <div className="atmosphere"/><header><IconButton label="收起播放层" onClick={() => setExpanded(false)}><CaretDown/></IconButton><span>正在播放 · {track.source === "netease" ? "网易云" : "本地"}</span><div><IconButton label="波形" active={wave} onClick={() => setWave(!wave)}><Waveform/></IconButton><IconButton label="队列" active={overlay === "queue"} onClick={() => setOverlay(overlay === "queue" ? "none" : "queue")}><Queue/></IconButton><IconButton label="更多"><DotsThree/></IconButton></div></header>
    <div className="player-stage"><section className="album-stage"><Cover src={track.coverSeed} alt={track.album}/><div className="stage-meta"><span className="eyebrow">{track.album} · {track.quality}</span><h1>{track.title}</h1><p>{track.artists.join(" / ")}</p><div><button><Heart/>喜欢</button><button><CloudArrowDown/>缓存</button></div></div>{wave && <WaveformCanvas/>}</section><section className="lyrics" onWheel={() => setFollow(false)}>{!follow && <button className="return-current" onClick={() => setFollow(true)}>回到当前歌词</button>}<LyricsContent follow={follow}/></section></div>
    <AnimatePresence>{overlay === "queue" && <><button aria-label="关闭队列" className="panel-scrim" onClick={() => setOverlay("none")}/><QueuePanel/></>}</AnimatePresence><PlayerDock/>
  </motion.div>;
}
