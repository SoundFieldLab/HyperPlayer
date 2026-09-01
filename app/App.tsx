import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Clock, Queue as QueueIcon, Waveform } from "@phosphor-icons/react";
import { bridge } from "./bridge";
import { Brand, Cover } from "./components/ui";
import { CommandPalette } from "./overlays/CommandPalette";
import { CloseConfirmDialog, ToastRegion } from "./overlays/SystemOverlays";
import { CurrentView } from "./pages/ContentViews";
import { ExpandedPlayer, PlayerDock } from "./player/Player";
import { QueuePanel } from "./queue/QueuePanel";
import { AuxiliaryRoot, DesktopLyrics, MiniPlayer, UtilityLauncher } from "./shell/AuxiliaryWindows";
import { SidebarNav, Titlebar } from "./shell/Navigation";
import { Onboarding } from "./shell/Onboarding";
import { useAppStore } from "./store";
import { windowRoot } from "./window-root";
import "./styles/interactions.css";
import "./styles/bridge.css";
import "./styles/redesign.css";

function useSystemTheme(enabled: boolean): boolean {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    if (!enabled) return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    function update(event: MediaQueryListEvent): void { setDark(event.matches); }
    setDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [enabled]);
  return dark;
}

function ContextRail(): React.JSX.Element {
  const { playback, tasks, playTrack, setOverlay } = useAppStore();
  const queue = playback?.nextUp.length ? playback.nextUp : playback?.queue.filter((item) => item.queueItemId !== playback.currentQueueItemId) ?? [];
  return <aside className="context-rail" aria-label="播放信息">
    <section><header><span><QueueIcon/><b>接下来播放</b></span><button type="button" onClick={() => setOverlay("queue")}>查看队列</button></header>{queue.length ? <div className="rail-track-list">{queue.slice(0, 4).map(({ queueItemId, track }) => <button type="button" key={queueItemId} onClick={() => void playTrack(track)}><Cover src={track.coverSeed} alt=""/><span><b>{track.title}</b><small>{track.artists.join(" / ")}</small></span></button>)}</div> : <div className="rail-empty"><Waveform/><span>队列暂无曲目</span></div>}</section>
    <section><header><span><Clock/><b>后台状态</b></span></header>{tasks.length ? <div className="rail-task-list">{tasks.slice(0, 3).map((task) => <div key={task.id}><span className={`task-dot ${task.state}`}/><span><b>{task.title}</b><small>{task.detail}</small></span></div>)}</div> : <div className="rail-empty"><span>当前没有进行中的任务</span></div>}</section>
  </aside>;
}

function MainApp(): React.JSX.Element {
  const state = useAppStore();
  const paletteTrigger = useRef<HTMLElement | null>(null);
  const previousSearchOpen = useRef(false);
  useEffect(() => { void state.init(); return () => state.dispose(); }, []);
  useEffect(() => {
    if (state.searchOpen && !previousSearchOpen.current) paletteTrigger.current = document.activeElement as HTMLElement;
    if (!state.searchOpen && previousSearchOpen.current) requestAnimationFrame(() => paletteTrigger.current?.focus());
    previousSearchOpen.current = state.searchOpen;
  }, [state.searchOpen]);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); state.setSearchOpen(true); }
      if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); state.back(); }
      if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); state.forward(); }
      if (event.altKey && event.key.toLowerCase() === "q") { event.preventDefault(); state.setOverlay(state.overlay === "queue" ? "none" : "queue"); }
      if (event.key === "Escape") {
        if (state.searchOpen) state.setSearchOpen(false);
        else if (state.overlay !== "none") state.setOverlay("none");
        else if (state.expandedPlayer) state.setExpanded(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.searchOpen, state.overlay, state.expandedPlayer, state.back, state.forward]);
  const systemDark = useSystemTheme(state.settings?.theme === "system");
  const theme = state.settings?.theme === "system" ? (systemDark ? "dark" : "light") : state.settings?.theme ?? "light";
  if (state.initStatus === "error") return <div className="boot boot-error" role="alert"><Brand/><h1>初始化失败</h1><p>{state.initError}</p><button className="button primary" onClick={() => void state.init()}>重试</button></div>;
  if (!state.ready) return <div className="boot" role="status" aria-live="polite"><Brand/><span>正在准备音乐空间</span></div>;
  if (state.onboarding) return <div data-theme={theme}><Onboarding/><CloseConfirmDialog/></div>;
  return <div className={`app-shell material-${state.settings?.material} ${state.settings?.reduceTransparency ? "reduce-transparency" : ""} ${state.settings?.reduceMotion ? "reduce-motion" : ""}`} data-theme={theme}><Titlebar/><SidebarNav/><div className="workspace"><main className="content" tabIndex={-1}><CurrentView/></main></div><ContextRail/><PlayerDock/><AnimatePresence>{state.expandedPlayer && <ExpandedPlayer/>}{state.searchOpen && <CommandPalette/>}{state.overlay === "queue" && !state.expandedPlayer && <QueuePanel/>}{state.queueFloating && <QueuePanel floating/>}{state.miniOpen && <MiniPlayer/>}{state.desktopLyricsOpen && <DesktopLyrics/>}</AnimatePresence><UtilityLauncher/><ToastRegion/><CloseConfirmDialog/></div>;
}

export default function App(): React.JSX.Element {
  const root = windowRoot(window.location.search);
  return root === "main" ? <MainApp/> : <AuxiliaryRoot kind={root}/>;
}
