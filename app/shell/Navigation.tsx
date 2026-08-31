import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft, ArrowRight, ArrowsOut, Bell, Broadcast, CaretRight, FolderOpen, Gear,
  Heart, House, ListBullets, MagnifyingGlass, Minus, MusicNotes, Playlist, Repeat,
  Sidebar, SlidersHorizontal, User, Users, WifiHigh, X,
} from "@phosphor-icons/react";
import type { ContentDomain } from "../bridge/contracts";
import { useAppStore, type ViewId } from "../store";
import { Brand, IconButton, type IconType, Segmented } from "../components/ui";

const copy = {
  netease: "网易云", local: "本地", home: "首页", search: "搜索", library: "音乐库", discover: "发现", recent: "最近播放",
  songs: "歌曲", albums: "专辑", artists: "艺术家", folders: "文件夹", playlists: "播放列表", account: "网易云账号",
  messages: "消息", settings: "设置", cache: "缓存", status: "状态中心", dsp: "音效", album: "专辑详情", artist: "艺术家详情", playlist: "歌单详情",
} as const;
const neteaseNav: Array<[ViewId, string, IconType]> = [["home", copy.home, House], ["search", copy.search, MagnifyingGlass], ["library", copy.library, MusicNotes], ["discover", copy.discover, Broadcast], ["recent", copy.recent, Repeat]];
const localNav: Array<[ViewId, string, IconType]> = [["home", "概览", House], ["songs", copy.songs, MusicNotes], ["albums", copy.albums, Playlist], ["artists", copy.artists, Users], ["folders", copy.folders, FolderOpen], ["playlists", copy.playlists, ListBullets]];

export function SidebarNav(): React.JSX.Element {
  const { domain, view, setDomain, navigate } = useAppStore();
  const nav = domain === "netease" ? neteaseNav : localNav;
  return <aside className="sidebar">
    <Brand/>
    <Segmented value={domain} options={[["netease", "网易云"], ["local", "本地"]]} onChange={(value) => setDomain(value as ContentDomain)}/>
    <nav className="main-nav">{nav.map(([id, label, Icon]) => <button key={id} className={view === id ? "selected" : ""} onClick={() => navigate(id)} title={label}><Icon weight={view === id ? "fill" : "regular"}/><span>{label}</span></button>)}</nav>
    <div className="nav-divider"/>
    <button className={`nav-special ${view === "dsp" ? "selected" : ""}`} onClick={() => navigate("dsp")}><SlidersHorizontal/><span>音效</span><small>待接入</small></button>
    <div className="sidebar-spacer"/>
    <button className={`nav-special ${view === "messages" ? "selected" : ""}`} onClick={() => navigate("messages")}><Bell/><span>消息</span></button>
    <button className={`nav-special ${view === "status" ? "selected" : ""}`} onClick={() => navigate("status")}><WifiHigh/><span>状态中心</span></button>
    <button className={`account-mini ${view === "account" ? "selected" : ""}`} onClick={() => navigate("account")}><span className="avatar">H</span><span><b>网易云账号</b><small>查看真实登录状态</small></span><CaretRight/></button>
    <button className={`nav-special ${view === "settings" ? "selected" : ""}`} onClick={() => navigate("settings")}><Gear/><span>设置</span></button>
  </aside>;
}

export function Titlebar(): React.JSX.Element {
  const { view, history, back, searchOpen, setSearchOpen } = useAppStore();
  function runWindowAction(action: "minimize" | "maximize" | "close"): void {
    const currentWindow = getCurrentWindow();
    if (action === "minimize") void currentWindow.minimize();
    else if (action === "maximize") void currentWindow.toggleMaximize();
    else void currentWindow.close();
  }
  return <header className="titlebar" data-tauri-drag-region>
    <div className="history-controls"><IconButton label="返回" onClick={back} disabled={!history.length}><ArrowLeft/></IconButton><IconButton label="前进" disabled><ArrowRight/></IconButton></div>
    <span className="page-context">{copy[view]}</span>
    <button type="button" className="global-search" aria-haspopup="dialog" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><MagnifyingGlass/><span>搜索音乐或输入命令</span><kbd>Ctrl K</kbd></button>
    <div className="window-controls" aria-label="窗口控件"><IconButton label="最小化窗口" onClick={() => runWindowAction("minimize")}><Minus/></IconButton><IconButton label="最大化或还原窗口" onClick={() => runWindowAction("maximize")}><ArrowsOut/></IconButton><IconButton label="关闭窗口" className="close" onClick={() => runWindowAction("close")}><X/></IconButton></div>
  </header>;
}
