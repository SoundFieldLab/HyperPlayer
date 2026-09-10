import { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useAppStore } from '../stores/store';
import { resolveRoute } from './routeRegistry';
import './shell.css';

const allCommands = [
  { id: 'search', label: '搜索音乐', action: () => useAppStore.getState().navigate('netease', { routeId: 'search' }) },
  { id: 'local', label: '切换到本地曲库', action: () => useAppStore.getState().switchDomain('local') },
  { id: 'netease', label: '切换到网易云', action: () => useAppStore.getState().switchDomain('netease') },
  { id: 'dsp', label: '打开音效工作台', action: () => useAppStore.getState().navigate({ routeId: 'dsp' }) },
  { id: 'settings', label: '打开设置', action: () => useAppStore.getState().navigate({ routeId: 'settings' }) },
];

export function CommandPanel() {
  const overlay = useAppStore((state) => state.overlay);
  const clearOverlay = useAppStore((state) => state.clearOverlay);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const open = overlay.kind === 'modal' && overlay.id === 'command-panel';
  const normalizedQuery = query.trim().replace(/^>/u, '').trim();
  const commands = useMemo(
    () => allCommands.filter((command) => command.label.includes(normalizedQuery)),
    [normalizedQuery],
  );

  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }, [open]);

  if (!open) return null;

  const runCommand = (index: number) => {
    const command = commands[index];
    if (!command) return;
    command.action();
    clearOverlay();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => commands.length ? (index + direction + commands.length) % commands.length : 0);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(activeIndex);
    }
  };

  return (
    <div className="overlay-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) clearOverlay(); }}>
      <section className="command-panel" role="dialog" aria-modal="true" aria-labelledby="command-panel-title">
        <div className="command-panel__header"><MagnifyingGlass size={20} /><h2 id="command-panel-title">搜索与命令</h2><button type="button" className="icon-button" aria-label="关闭命令面板" onClick={clearOverlay}><X size={18} /></button></div>
        <input ref={inputRef} className="command-panel__input" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={onKeyDown} placeholder="搜索或输入 > 执行命令" aria-label="搜索或输入命令" aria-activedescendant={commands[activeIndex] ? `command-${commands[activeIndex].id}` : undefined} />
        <div className="command-panel__results" role="listbox" aria-label="命令结果">
          {commands.map((command, index) => <button id={`command-${command.id}`} type="button" role="option" aria-selected={index === activeIndex} className={`command-item ${index === activeIndex ? 'is-active' : ''}`} key={command.id} onMouseEnter={() => setActiveIndex(index)} onClick={() => runCommand(index)}>{command.label}<span>Enter</span></button>)}
          {commands.length === 0 && <p className="state-message">没有匹配的命令</p>}
        </div>
      </section>
    </div>
  );
}

export function RouteView() {
  const domain = useAppStore((state) => state.activeDomain);
  const entry = useAppStore((state) => state.currentEntry) ?? { routeId: domain === 'local' ? 'local-home' : 'netease-home' };
  const definition = resolveRoute(entry.routeId);
  const Component = definition.component;
  return <Component domain={domain} entry={entry} requestedRouteId={definition.kind === 'not-found' ? entry.routeId : undefined} />;
}
