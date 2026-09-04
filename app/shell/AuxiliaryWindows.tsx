import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, LockOpen, Minus, MusicNotes, Pause, Play, SkipBack, SkipForward, X } from "@phosphor-icons/react";
import { bridge } from "../bridge";
import { IconButton } from "../components/ui";
import { LyricsContent } from "../player/Player";
import { useAppStore } from "../store";

// 迷你播放器已按用户定调整体移除（2026-09-05）；辅助窗口仅剩桌面歌词。
// WebView2 args 镜像约束（auxiliary_browser_args）对桌面歌词窗口同样生效。

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
  // 锁按钮：先 windowShow（窗口不存在则创建），再关点击穿透——原顺序先调
  // desktop_lyrics_set_click_through，桌面歌词窗口不存在时该命令直接拒绝，
  // 表现为「点了没反应」。
  return <div className="utility-launcher"><IconButton label="桌面歌词" onClick={() => void bridge.windowShow("desktopLyrics").catch((error: unknown) => notifyError(error, "无法打开桌面歌词"))}><MusicNotes/></IconButton><IconButton label="打开桌面歌词并关闭点击穿透" onClick={() => void bridge.windowShow("desktopLyrics").then(() => bridge.desktopLyricsSetClickThrough(false)).catch((error: unknown) => notifyError(error, "无法关闭桌面歌词点击穿透"))}><LockOpen/></IconButton></div>;
}

export function AuxiliaryRoot({ kind }: { kind: "desktop-lyrics" }): React.JSX.Element {
  const state = useAppStore();
  const [slow, setSlow] = useState(false);
  useEffect(() => { void state.init(); return () => state.dispose(); }, []);
  // 连接看门狗：init 长时间未就绪（如主窗口命令链挂起）时切换为可操作的提示文案，
  // 避免辅助窗口静默停留在「正在连接」。
  useEffect(() => {
    if (state.ready || state.initStatus === "error") { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [state.ready, state.initStatus]);
  const closeSelf = () => void bridge.windowClose("desktopLyrics").catch(() => bridge.windowHide("desktopLyrics").catch(() => undefined));
  if (state.initStatus === "error") return <div className="aux-empty" role="alert"><b>播放器连接失败</b><small>{state.initError}</small><div className="home-actions"><button className="button secondary" onClick={() => void state.init()}>重试</button><button className="button secondary" onClick={() => void bridge.windowShow("main")}>打开主窗口</button><button className="button secondary" onClick={closeSelf}>关闭窗口</button></div></div>;
  if (!state.ready) return <div className="aux-empty" role="status"><b>{slow ? "连接播放器超时" : "正在连接播放器"}</b><small>{slow ? "主窗口可能未就绪，可重试或直接打开主窗口" : "正在从主窗口同步播放状态"}</small><div className="home-actions"><button className="button secondary" onClick={() => void state.init()}>重试</button><button className="button secondary" onClick={() => void bridge.windowShow("main")}>打开主窗口</button>{slow && <button className="button secondary" onClick={closeSelf}>关闭窗口</button>}</div></div>;
  return <DesktopLyrics standalone/>;
}
