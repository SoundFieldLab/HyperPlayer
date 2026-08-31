import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CaretUp, Check, LockOpen, Minus, Monitor, MusicNotes, Pause, Play, SkipBack, SkipForward, SpeakerHigh, X } from "@phosphor-icons/react";
import { bridge } from "../bridge";
import { Cover, IconButton } from "../components/ui";
import { LyricsContent } from "../player/Player";
import { useAppStore } from "../store";

export function MiniPlayer({ standalone = false }: { standalone?: boolean }): React.JSX.Element {
  const { playback, togglePlayback, next, previous, setMiniOpen, setExpanded } = useAppStore();
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  if (!playback?.current) return <div className="aux-empty">当前没有播放曲目</div>;
  const track = playback.current;
  function close(): void { standalone ? void bridge.windowClose("miniPlayer") : setMiniOpen(false); }
  return <motion.div drag={!standalone} dragMomentum={false} className={`mini-player ${standalone ? "standalone" : ""}`} initial={{opacity:0,scale:.94}} animate={{opacity:1,scale:1}}><div className="mini-top"><span>迷你播放器</span><div>{standalone && <IconButton label="隐藏" onClick={() => void bridge.windowHide("miniPlayer")}><Minus/></IconButton>}<IconButton label={alwaysOnTop ? "取消置顶" : "保持置顶"} active={alwaysOnTop} onClick={() => { const nextValue = !alwaysOnTop; setAlwaysOnTop(nextValue); void bridge.windowSetAlwaysOnTop("miniPlayer", nextValue); }}><CaretUp/></IconButton><IconButton label="关闭" onClick={close}><X/></IconButton></div></div><button className="mini-cover" onClick={() => { if (standalone) void bridge.windowShow("main"); else { setMiniOpen(false); setExpanded(true); } }}><Cover src={track.coverSeed} alt={track.album}/></button><div className="mini-info"><b>{track.title}</b><small>{track.artists.join(" / ")}</small></div><div className="mini-progress"><i style={{width:`${track.durationMs ? playback.positionMs / track.durationMs * 100 : 0}%`}}/></div><div className="mini-controls"><IconButton label="上一首" onClick={() => void previous()}><SkipBack/></IconButton><button className="main-play" onClick={() => void togglePlayback()}>{playback.status === "playing" ? <Pause weight="fill"/> : <Play weight="fill"/>}</button><IconButton label="下一首" onClick={() => void next()}><SkipForward/></IconButton><SpeakerHigh/></div></motion.div>;
}

export function DesktopLyrics({ standalone = false }: { standalone?: boolean }): React.JSX.Element {
  const { playback, setDesktopLyricsOpen, togglePlayback, next, previous, notifyError } = useAppStore();
  const [locked, setLocked] = useState(false);
  if (!playback) return <div className="aux-empty">当前没有播放状态</div>;
  function toggleLock(): void {
    const nextLocked = !locked;
    setLocked(nextLocked);
    if (standalone) void bridge.desktopLyricsSetClickThrough(nextLocked).catch((error: unknown) => notifyError(error, "无法切换歌词点击穿透"));
  }
  function close(): void {
    if (standalone) void bridge.windowClose("desktopLyrics").catch((error: unknown) => notifyError(error, "无法关闭桌面歌词"));
    else setDesktopLyricsOpen(false);
  }
  return <motion.div drag={!locked && !standalone} dragMomentum={false} className={`desktop-lyrics ${locked ? "locked" : ""} ${standalone ? "standalone" : ""}`} initial={{opacity:0,y:20}} animate={{opacity:1,y:0}}><div className="desktop-tools"><IconButton label={locked ? "解除点击穿透" : "启用点击穿透"} onClick={toggleLock}>{locked ? <LockOpen/> : <Check/>}</IconButton><IconButton label="上一首" onClick={() => void previous()}><SkipBack/></IconButton><IconButton label="播放暂停" onClick={() => void togglePlayback()}>{playback.status === "playing" ? <Pause/> : <Play/>}</IconButton><IconButton label="下一首" onClick={() => void next()}><SkipForward/></IconButton>{standalone && <IconButton label="隐藏" onClick={() => void bridge.windowHide("desktopLyrics").catch((error: unknown) => notifyError(error, "无法隐藏桌面歌词"))}><Minus/></IconButton>}<IconButton label="关闭" onClick={close}><X/></IconButton></div><LyricsContent compact follow/></motion.div>;
}

export function UtilityLauncher(): React.JSX.Element {
  const notifyError = useAppStore((state) => state.notifyError);
  return <div className="utility-launcher"><IconButton label="迷你播放器" onClick={() => void bridge.windowShow("miniPlayer").catch((error: unknown) => notifyError(error, "无法打开迷你播放器"))}><Monitor/></IconButton><IconButton label="桌面歌词" onClick={() => void bridge.windowShow("desktopLyrics").catch((error: unknown) => notifyError(error, "无法打开桌面歌词"))}><MusicNotes/></IconButton><IconButton label="关闭桌面歌词点击穿透" onClick={() => void bridge.desktopLyricsSetClickThrough(false).then(() => bridge.windowShow("desktopLyrics")).catch((error: unknown) => notifyError(error, "无法关闭桌面歌词点击穿透"))}><LockOpen/></IconButton></div>;
}

export function AuxiliaryRoot({ kind }: { kind: "mini-player" | "desktop-lyrics" }): React.JSX.Element {
  const state = useAppStore();
  useEffect(() => { void state.init(); return () => state.dispose(); }, []);
  if (state.initStatus === "error") return <div className="aux-empty" role="alert">{state.initError}</div>;
  if (!state.ready) return <div className="aux-empty" role="status">正在连接播放器</div>;
  if (kind === "mini-player" && !state.playback?.current) return <div className="aux-empty"><b>当前没有播放曲目</b><div className="home-actions"><button className="button secondary" onClick={() => void bridge.windowShow("main")}>打开主窗口</button><button className="button secondary" onClick={() => void bridge.windowHide("miniPlayer")}>隐藏</button><button className="button secondary" onClick={() => void bridge.windowClose("miniPlayer")}>关闭</button></div></div>;
  return kind === "mini-player" ? <MiniPlayer standalone/> : <DesktopLyrics standalone/>;
}
