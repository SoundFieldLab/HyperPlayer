import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft, ArrowRight, ArrowsOut, Bell, Broadcast, CaretRight, FolderOpen, Gear,
  House, ListBullets, MagnifyingGlass, Minus, MusicNotes, Playlist, Repeat,
  SlidersHorizontal, User, Users, WifiHigh, X,
} from "@phosphor-icons/react";
import type { ContentDomain } from "../bridge/contracts";
import { useAppStore, type ViewId } from "../store";
import { Brand, IconButton, type IconType, Segmented } from "../components/ui";

const copy = {
  netease: "网易云", local: "本地", home: "首页", search: "搜索", library: "音乐库", discover: "发现", recent: "最近播放",
  songs: "歌曲", albums: "专辑", artists: "艺术家", folders: "文件夹", playlists: "播放列表", account: "网易云账号",
  messages: "消息", settings: "设置", cache: "缓存", status: "状态中心", dsp: "音效", album: "专辑详情", artist: "艺术家详情", playlist: "歌单详情",
} as const;

type NavItem = [ViewId, string, IconType];

const neteaseNav: NavItem[] = [
  ["home", copy.home, House],
  ["search", copy.search, MagnifyingGlass],
  ["library", copy.library, MusicNotes],
  ["discover", copy.discover, Broadcast],
  ["recent", copy.recent, Repeat],
];
const localNav: NavItem[] = [
  ["home", "概览", House],
  ["songs", copy.songs, MusicNotes],
  ["albums", copy.albums, Playlist],
  ["artists", copy.artists, Users],
  ["folders", copy.folders, FolderOpen],
  ["playlists", copy.playlists, ListBullets],
];

export function SidebarNav(): React.JSX.Element {
  const { domain, view, tasks, setDomain, navigate } = useAppStore();
  const nav = domain === "netease" ? neteaseNav : localNav;
  const activeTasks = tasks.filter((task) => task.state !== "complete").length;
  return <aside className="sidebar">
    <Brand/>
    <Segmented value={domain} options={[["netease", "网易云"], ["local", "本地"]]} onChange={(value) => setDomain(value as ContentDomain)}/>
    <nav className="main-nav" aria-label="内容导航">{nav.map(([id, label, Icon]) => <button type="button" key={id} className={view === id ? "selected" : ""} aria-current={view === id ? "page" : undefined} aria-label={label} onClick={() => navigate(id)} title={label}><Icon weight={view === id ? "fill" : "regular"}/><span>{label}</span></button>)}</nav>
    <div className="nav-divider"/>
    <button type="button" className={`nav-special ${view === "dsp" ? "selected" : ""}`} aria-current={view === "dsp" ? "page" : undefined} aria-label="音效" title="音效" onClick={() => navigate("dsp")}><SlidersHorizontal/><span>音效</span></button>
    <div className="sidebar-spacer"/>
    <button type="button" className={`nav-special ${view === "messages" ? "selected" : ""}`} aria-current={view === "messages" ? "page" : undefined} aria-label="消息" title="消息" onClick={() => navigate("messages")}><Bell/><span>消息</span></button>
    <button type="button" className={`nav-special ${view === "status" ? "selected" : ""}`} aria-current={view === "status" ? "page" : undefined} onClick={() => navigate("status")} aria-label={activeTasks ? `状态中心，${activeTasks} 个进行中任务` : "状态中心"} title="状态中心"><WifiHigh/><span>状态中心</span>{activeTasks > 0 && <span className="task-count" aria-hidden="true">{activeTasks}</span>}</button>
    <button type="button" className={`account-mini ${view === "account" ? "selected" : ""}`} aria-current={view === "account" ? "page" : undefined} aria-label="网易云账号" title="网易云账号" onClick={() => navigate("account")}><span className="avatar"><User weight="fill"/></span><span><b>网易云账号</b><small>查看真实登录状态</small></span><CaretRight/></button>
    <button type="button" className={`nav-special ${view === "settings" ? "selected" : ""}`} aria-current={view === "settings" ? "page" : undefined} aria-label="设置" title="设置" onClick={() => navigate("settings")}><Gear/><span>设置</span></button>
  </aside>;
}

export function Titlebar(): React.JSX.Element {
  const { domain, view, navigation, back, forward, searchOpen, setSearchOpen } = useAppStore();
  const activeHistory = navigation[domain];
  function runWindowAction(action: "minimize" | "maximize" | "close"): void {
    const currentWindow = getCurrentWindow();
    if (action === "minimize") void currentWindow.minimize();
    else if (action === "maximize") void currentWindow.toggleMaximize();
    else void currentWindow.close();
  }
  return <header className="titlebar" data-tauri-drag-region>
    <div className="history-controls"><IconButton label="返回" onClick={back} disabled={!activeHistory.back.length}><ArrowLeft/></IconButton><IconButton label="前进" onClick={forward} disabled={!activeHistory.forward.length}><ArrowRight/></IconButton></div>
    <span className="page-context">{copy[view]}</span>
    <button type="button" className="global-search" aria-haspopup="dialog" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><MagnifyingGlass/><span>搜索音乐或输入命令</span><kbd>Ctrl K</kbd></button>
    <div className="window-controls" aria-label="窗口控件"><IconButton label="最小化窗口" onClick={() => runWindowAction("minimize")}><Minus/></IconButton><IconButton label="最大化或还原窗口" onClick={() => runWindowAction("maximize")}><ArrowsOut/></IconButton><IconButton label="关闭窗口" className="close" onClick={() => runWindowAction("close")}><X/></IconButton></div>
  </header>;
}
