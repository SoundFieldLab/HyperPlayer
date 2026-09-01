import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft, ArrowRight, ArrowsOut, Broadcast, ChartBar, CloudArrowDown, FolderOpen, Gear, Heart, ListBullets,
  MagnifyingGlass, Minus, MusicNotes, Playlist, Repeat, User, WifiHigh, X,
} from "@phosphor-icons/react";
import type { ContentDomain } from "../bridge/contracts";
import { useAppStore, type ViewId } from "../store";
import { Brand, IconButton, type IconType } from "../components/ui";

const copy = {
  home: "我的喜欢", search: "搜索", library: "音乐库", discover: "发现",
  recent: "最近播放", songs: "本地音乐", albums: "专辑", artists: "歌手",
  folders: "文件夹", playlists: "播放列表", account: "账号", messages: "消息",
  settings: "设置", cache: "缓存", status: "状态中心", dsp: "音效",
  album: "专辑详情", artist: "歌手详情", playlist: "歌单详情",
} as const;

type NavItem = [ViewId, string, IconType];

const libraryNav: NavItem[] = [
  ["home", "我的喜欢", Heart],
  ["songs", "本地音乐", MusicNotes],
  ["recent", "最近播放", Repeat],
];
const discoverNav: NavItem[] = [
  ["discover", "推荐", Broadcast],
  ["albums", "排行榜", ChartBar],
  ["artists", "歌手", User],
];
const playlistNav: NavItem[] = [
  ["playlists", "我的歌单", Playlist],
  ["folders", "本地文件夹", FolderOpen],
];

function NavGroup({ label, items, view, navigate }: { label: string; items: NavItem[]; view: ViewId; navigate: (view: ViewId) => void }): React.JSX.Element {
  return <section className="sidebar-group"><h2>{label}</h2>{items.map(([id, title, Icon]) => <button type="button" key={id} className={view === id ? "selected" : ""} onClick={() => navigate(id)} title={title}><Icon weight={view === id ? "fill" : "regular"}/><span>{title}</span></button>)}</section>;
}

export function SidebarNav(): React.JSX.Element {
  const { domain, view, setDomain, navigate } = useAppStore();
  return <aside className="sidebar">
    <div className="sidebar-profile"><span className="avatar"><User weight="fill"/></span><span><small>欢迎回来</small><b>USER</b></span></div>
    <NavGroup label="你的音乐" items={libraryNav} view={view} navigate={navigate}/>
    <NavGroup label="发现音乐" items={discoverNav} view={view} navigate={navigate}/>
    <NavGroup label="我的歌单" items={playlistNav} view={view} navigate={navigate}/>
    <div className="sidebar-spacer"/>
    <div className="sidebar-utility"><button type="button" title="缓存" onClick={() => navigate("cache")}><CloudArrowDown/><span>缓存</span></button><button type="button" title="状态中心" onClick={() => navigate("status")}><WifiHigh/><span>状态</span></button></div>
    <div className="source-switch" role="radiogroup" aria-label="音乐来源">
      <button role="radio" aria-checked={domain === "netease"} className={domain === "netease" ? "selected" : ""} onClick={() => setDomain("netease" as ContentDomain)}>云端</button>
      <button role="radio" aria-checked={domain === "local"} className={domain === "local" ? "selected" : ""} onClick={() => setDomain("local" as ContentDomain)}>本地</button>
    </div>
    <button className={`nav-special ${view === "dsp" ? "selected" : ""}`} onClick={() => navigate("dsp")}><MusicNotes/><span>音效工作台</span></button>
  </aside>;
}

export function Titlebar(): React.JSX.Element {
  const { domain, view, navigation, back, forward, navigate, searchOpen, setSearchOpen } = useAppStore();
  const activeHistory = navigation[domain];
  function runWindowAction(action: "minimize" | "maximize" | "close"): void {
    const currentWindow = getCurrentWindow();
    if (action === "minimize") void currentWindow.minimize();
    else if (action === "maximize") void currentWindow.toggleMaximize();
    else void currentWindow.close();
  }
  const tabs: Array<[ViewId, string]> = [["home", "音乐馆"], ["library", "我的音乐"], ["playlists", "歌单"], ["discover", "FM"]];
  return <header className="titlebar" data-tauri-drag-region>
    <div className="titlebar-brand"><Brand/><div className="history-controls"><IconButton label="返回" onClick={back} disabled={!activeHistory.back.length}><ArrowLeft/></IconButton><IconButton label="前进" onClick={forward} disabled={!activeHistory.forward.length}><ArrowRight/></IconButton></div></div>
    <button type="button" className="global-search" aria-haspopup="dialog" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><MagnifyingGlass/><span>搜索音乐、歌手、专辑或歌词</span><kbd>Ctrl K</kbd></button>
    <nav className="top-nav" aria-label="主导航">{tabs.map(([id, label]) => <button type="button" key={id} className={view === id ? "selected" : ""} onClick={() => navigate(id)}>{label}</button>)}</nav>
    <button type="button" className="settings-pill" onClick={() => navigate("settings")}><Gear weight="fill"/><span>设置</span></button>
    <div className="window-controls" aria-label="窗口控件"><IconButton label="最小化窗口" onClick={() => runWindowAction("minimize")}><Minus/></IconButton><IconButton label="最大化或还原窗口" onClick={() => runWindowAction("maximize")}><ArrowsOut/></IconButton><IconButton label="关闭窗口" className="close" onClick={() => runWindowAction("close")}><X/></IconButton></div>
  </header>;
}
