import { useEffect, useState } from 'react';
import { House, MagnifyingGlass, MusicNotes, Sparkle, ClockCounterClockwise, Gear, Waveform, UserCircle, ListChecks, Moon, Sun, List } from '@phosphor-icons/react';
import { useAppStore } from '../stores/store';
import { useSessionStore } from '../stores/slices/session';
import type { NavDomain, NavEntry } from '../stores/slices/nav';
import { useServices } from '../app/providers/ServicesProvider';
import { CapsuleDock } from './CapsuleDock';
import { CommandPanel, RouteView } from './RouteView';
import { PlayerLayer } from './PlayerLayer';
import { resolveRoute } from './routeRegistry';
import './shell.css';

const neteaseItems: Array<{ label: string; icon: typeof House; entry: NavEntry }> = [
  { label: '首页', icon: House, entry: { routeId: 'netease-home' } },
  { label: '搜索', icon: MagnifyingGlass, entry: { routeId: 'search' } },
  { label: '音乐库', icon: MusicNotes, entry: { routeId: 'netease-library', params: { segment: 'playlists' } } },
  { label: '发现', icon: Sparkle, entry: { routeId: 'discover', params: { segment: 'charts' } } },
  { label: '最近播放', icon: ClockCounterClockwise, entry: { routeId: 'recent' } },
];

const localItems: Array<{ label: string; icon: typeof House; entry: NavEntry }> = [
  { label: '概览', icon: House, entry: { routeId: 'local-home' } },
  { label: '歌曲', icon: MusicNotes, entry: { routeId: 'local-songs' } },
  { label: '专辑', icon: Waveform, entry: { routeId: 'local-albums' } },
  { label: '艺术家', icon: Sparkle, entry: { routeId: 'local-artists' } },
  { label: '文件夹', icon: Gear, entry: { routeId: 'local-folders' } },
  { label: '播放列表', icon: MusicNotes, entry: { routeId: 'local-playlists' } },
];

export function AppShell() {
  const services = useServices();
  const windowControl = services.trayWindow;
  const activeDomain = useAppStore((state) => state.activeDomain);
  const currentEntry = useAppStore((state) => state.currentEntry);
  const navigate = useAppStore((state) => state.navigate);
  const switchDomain = useAppStore((state) => state.switchDomain);
  const back = useAppStore((state) => state.back);
  const forward = useAppStore((state) => state.forward);
  const setOverlay = useAppStore((state) => state.setOverlay);
  const clearOverlay = useAppStore((state) => state.clearOverlay);
  const overlay = useAppStore((state) => state.overlay);
  const theme = useAppStore((state) => state.settings.theme);
  const notice = useSessionStore((state) => state.notice);
  const setSessionNotice = useSessionStore((state) => state.setSessionNotice);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false);

  const items = activeDomain === 'netease' ? neteaseItems : localItems;
  const currentTitle = resolveRoute(currentEntry?.routeId ?? (activeDomain === 'netease' ? 'netease-home' : 'local-home')).title;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || target?.isContentEditable;
      if (event.key === 'Escape' && overlay.kind !== 'none') {
        event.preventDefault();
        clearOverlay();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay({ kind: 'modal', id: 'command-panel' });
        return;
      }
      if (isEditing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        switchDomain(event.key === 'ArrowLeft' ? 'netease' : 'local');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [clearOverlay, overlay.kind, setOverlay, switchDomain]);

  useEffect(() => {
    const requestConfirmation = () => setOverlay({ kind: 'modal', id: 'close-confirmation' });
    window.addEventListener('hyperplayer:request-close-confirmation', requestConfirmation);
    return () => window.removeEventListener('hyperplayer:request-close-confirmation', requestConfirmation);
  }, [setOverlay]);

  const go = (domain: NavDomain, entry: NavEntry) => navigate(domain, entry, typeof entry.params?.segment === 'string' ? entry.params.segment : undefined);
  const canBack = useAppStore((state) => state.histories[state.activeDomain].currentIndex > 0);
  const canForward = useAppStore((state) => {
    const history = state.histories[state.activeDomain];
    return history.currentIndex >= 0 && history.currentIndex < history.entries.length - 1;
  });
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    void services.settings.update({ theme: next });
  };

  const chooseCloseBehavior = async (behavior: 'minimize' | 'quit') => {
    if (rememberCloseChoice) await services.settings.update({ closeBehavior: behavior });
    clearOverlay();
    setRememberCloseChoice(false);
    if (behavior === 'minimize') await windowControl.hide();
    else await windowControl.destroy();
  };

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar__history" aria-label="导航历史">
          <button type="button" className="icon-button" aria-label="后退" onClick={() => back()} disabled={!canBack}>‹</button>
          <button type="button" className="icon-button" aria-label="前进" onClick={() => forward()} disabled={!canForward}>›</button>
        </div>
        <div className="titlebar__title" data-tauri-drag-region aria-live="polite">{currentTitle}</div>
        <button type="button" className="titlebar__search" aria-label="打开命令面板" onClick={() => setOverlay({ kind: 'modal', id: 'command-panel' })}><MagnifyingGlass size={18} /> <span>搜索</span><kbd>Ctrl K</kbd></button>
        <button type="button" className="icon-button" aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        <button type="button" className="icon-button" aria-label="打开播放队列" onClick={() => setOverlay({ kind: 'modal', id: 'player-layer' })}><List size={18} /></button>
        <div className="titlebar__window-actions" aria-label="窗口控制">
          <button type="button" className="window-button" aria-label="最小化" onClick={() => void windowControl.minimize()}>−</button>
          <button type="button" className="window-button" aria-label="最大化或还原" onClick={() => void windowControl.toggleMaximize()}>□</button>
          <button type="button" className="window-button window-button--close" aria-label="关闭窗口" onClick={() => void windowControl.close()}>×</button>
        </div>
      </header>

      <aside className="sidebar" aria-label="主导航">
        <div className="domain-switcher" role="group" aria-label="内容域">
          <button type="button" className={activeDomain === 'netease' ? 'is-active' : ''} onClick={() => { switchDomain('netease'); if (!currentEntry && neteaseItems[0]) go('netease', neteaseItems[0].entry); }}>网易云</button>
          <button type="button" className={activeDomain === 'local' ? 'is-active' : ''} onClick={() => { switchDomain('local'); if (!currentEntry && localItems[0]) go('local', localItems[0].entry); }}>本地</button>
        </div>
        <nav className="sidebar__nav">
          {items.map(({ label, icon: Icon, entry }) => {
            const active = currentEntry?.routeId === entry.routeId;
            return <button type="button" className={`nav-item ${active ? 'is-active' : ''}`} key={entry.routeId} onClick={() => go(activeDomain, entry)}><Icon size={19} weight={active ? 'fill' : 'regular'} /><span>{label}</span></button>;
          })}
        </nav>
        <div className="sidebar__footer">
          <button type="button" className="nav-item" onClick={() => go(activeDomain, { routeId: 'dsp' })}><Waveform size={19} /><span>音效</span></button>
          <button type="button" className="nav-item" onClick={() => go(activeDomain, { routeId: 'status-center' })}><ListChecks size={19} /><span>状态中心</span></button>
          <button type="button" className="nav-item" onClick={() => go('netease', { routeId: 'account' })}><UserCircle size={19} /><span>账号</span></button>
          <button type="button" className="nav-item" onClick={() => go(activeDomain, { routeId: 'settings' })}><Gear size={19} /><span>设置</span></button>
        </div>
      </aside>

      <main className="content" tabIndex={-1}>
        <div className="content__inner">
          <section className="route-content" aria-label="页面内容">
            <RouteView />
          </section>
        </div>
      </main>
      {notice && <div className="session-notice" role="status"><span>{notice}</span><button type="button" className="icon-button" aria-label="清除通知" onClick={() => setSessionNotice(null)}>×</button></div>}
      <CapsuleDock services={services} onOpenPlayer={() => setOverlay({ kind: 'modal', id: 'player-layer' })} />
      <CommandPanel />
      <PlayerLayer />
      {overlay.kind === 'modal' && overlay.id === 'close-confirmation' && (
        <div className="overlay-backdrop overlay-backdrop--center" role="presentation">
          <section className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-confirmation-title">
            <h2 id="close-confirmation-title">关闭 HyperPlayer</h2>
            <p>你希望最小化到托盘，还是完全退出应用？</p>
            <label className="close-confirmation__remember"><input type="checkbox" checked={rememberCloseChoice} onChange={(event) => setRememberCloseChoice(event.target.checked)} />记住我的选择</label>
            <div className="close-confirmation__actions"><button type="button" className="hp-button" onClick={() => void chooseCloseBehavior('minimize')}>最小化到托盘</button><button type="button" className="hp-button hp-button--danger" onClick={() => void chooseCloseBehavior('quit')}>完全退出</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

export function LimitedShell() {
  return <main className="limited-shell" aria-label="HyperPlayer 受限模式"><h1 className="hp-title">HyperPlayer</h1><p className="hp-body">服务尚未完成初始化，当前仅显示基础界面。</p></main>;
}
