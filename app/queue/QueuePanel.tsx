import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, CaretUp, CloudArrowDown, DotsSixVertical, Queue, Sidebar, SpinnerGap, X } from "@phosphor-icons/react";
import type { QueueItemDto } from "../bridge/contracts";
import { useAppStore } from "../store";
import { Cover, IconButton, SourceMark } from "../components/ui";

type DockPlacement = "left" | "right" | "bottom";
type QueuePlacement = DockPlacement | "floating";

const QUEUE_PLACEMENT_KEY = "hyperplayer.queue-placement";
const QUEUE_WIDTH_KEY = "hyperplayer.queue-width";
const QUEUE_HEIGHT_KEY = "hyperplayer.queue-height";
const DEFAULT_QUEUE_WIDTH = 400;
const DEFAULT_QUEUE_HEIGHT = 320;

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function storedPlacement(): DockPlacement {
  const value = localStorage.getItem(QUEUE_PLACEMENT_KEY);
  return value === "left" || value === "bottom" ? value : "right";
}

interface QueueItemProps {
  item: QueueItemDto;
  active?: boolean;
  removable?: boolean;
  draggable?: boolean;
  dragging?: boolean;
  dropPosition?: "before" | "after";
  position?: number;
  setSize?: number;
  onRemove?: (id: string) => Promise<void>;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}

function QueueItem({ item, active = false, removable = true, draggable = false, dragging = false, dropPosition, position, setSize, onRemove, onMoveUp, onMoveDown, onDragStart, onDragEnd, onDragOver, onDrop }: QueueItemProps): React.JSX.Element {
  const track = item.track;
  const dropShadow = dropPosition === "before" ? "inset 0 2px 0 var(--blue)" : dropPosition === "after" ? "inset 0 -2px 0 var(--blue)" : undefined;
  return <div role="listitem" aria-posinset={position} aria-setsize={setSize} className={`queue-item ${active ? "active" : ""}`} style={{ opacity: dragging ? 0.48 : 1, boxShadow: dropShadow, transition: "opacity 120ms ease, box-shadow 120ms ease" }} onDragOver={onDragOver} onDrop={onDrop}>
    <Cover src={track.coverSeed} alt=""/>
    <span className="queue-item-copy"><b>{track.title}</b><small>{track.artists.join(" / ")}</small><span className="queue-item-status"><SourceMark source={track.source}/><em>{track.quality}</em>{track.entitlement !== "free" && <em className={`entitlement ${track.entitlement}`}>{track.entitlement === "vip" ? "VIP" : track.entitlement === "trial" ? "试听" : "不可用"}</em>}{track.cache === "ready" && <CloudArrowDown aria-label="已缓存"/>}{track.cache === "prefetching" && <SpinnerGap className="spin" aria-label="缓存中"/>}{track.cache === "entitlement-locked" && <em>缓存锁定</em>}{track.cache === "failed" && <em>缓存失败</em>}</span></span>
    <div className="queue-item-actions">{draggable && <button type="button" className="icon-button" draggable aria-label={`拖动 ${track.title} 调整顺序`} title="拖动调整顺序" onDragStart={onDragStart} onDragEnd={onDragEnd} style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}><DotsSixVertical aria-hidden="true"/></button>}{removable && <><IconButton label={`上移 ${track.title}`} disabled={!onMoveUp} onClick={onMoveUp}><CaretUp/></IconButton><IconButton label={`下移 ${track.title}`} disabled={!onMoveDown} onClick={onMoveDown}><CaretDown/></IconButton>{onRemove && <IconButton label={`从队列移除 ${track.title}`} onClick={() => void onRemove(item.queueItemId)}><X/></IconButton>}</>}</div>
  </div>;
}

export function QueuePanel({ floating = false }: { floating?: boolean }): React.JSX.Element | null {
  const { playback, view, setOverlay, setQueueFloating, removeQueueItem, reorderQueueItem, clearQueue } = useAppStore();
  const [placement, setPlacementState] = useState<DockPlacement>(storedPlacement);
  const [dockWidth, setDockWidth] = useState(() => storedNumber(QUEUE_WIDTH_KEY, DEFAULT_QUEUE_WIDTH, 320, 560));
  const [dockHeight, setDockHeight] = useState(() => storedNumber(QUEUE_HEIGHT_KEY, DEFAULT_QUEUE_HEIGHT, 220, 520));
  const [tab, setTab] = useState<"queue" | "layout">("queue");
  const [draggedQueueItemId, setDraggedQueueItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ queueItemId: string; position: "before" | "after" } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const tabsId = useId();
  const effectivePlacement: QueuePlacement = floating ? "floating" : placement;

  function closePanel(): void {
    if (floating) setQueueFloating(false);
    else setOverlay("none");
  }

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => previousFocus.current?.focus();
  }, []);

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePanel();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  });

  if (!playback) return null;

  const queue = playback.queue;
  function setPlacement(next: QueuePlacement): void {
    if (next === "floating") {
      setOverlay("none");
      setQueueFloating(true);
      return;
    }
    localStorage.setItem(QUEUE_PLACEMENT_KEY, next);
    setPlacementState(next);
    setQueueFloating(false);
    setOverlay("queue");
  }
  function updateDockWidth(value: number): void {
    const next = Math.max(320, Math.min(560, Math.round(value)));
    setDockWidth(next);
    localStorage.setItem(QUEUE_WIDTH_KEY, String(next));
  }
  function updateDockHeight(value: number): void {
    const next = Math.max(220, Math.min(520, Math.round(value)));
    setDockHeight(next);
    localStorage.setItem(QUEUE_HEIGHT_KEY, String(next));
  }
  function restoreLayout(): void {
    localStorage.removeItem(QUEUE_PLACEMENT_KEY);
    localStorage.removeItem(QUEUE_WIDTH_KEY);
    localStorage.removeItem(QUEUE_HEIGHT_KEY);
    setPlacementState("right");
    setDockWidth(DEFAULT_QUEUE_WIDTH);
    setDockHeight(DEFAULT_QUEUE_HEIGHT);
    setQueueFloating(false);
    setOverlay("queue");
  }
  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "queue" ? "layout" : "queue";
    setTab(next);
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`#${tabsId}-${next}-tab`)?.focus());
  }
  function handlePanelKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (!floating || event.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  function clearDragState(): void {
    setDraggedQueueItemId(null);
    setDropTarget(null);
  }
  function handleDragStart(event: DragEvent<HTMLButtonElement>, queueItemId: string): void {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", queueItemId);
    setDraggedQueueItemId(queueItemId);
  }
  function handleDragOver(event: DragEvent<HTMLDivElement>, queueItemId: string): void {
    if (!draggedQueueItemId || draggedQueueItemId === queueItemId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDropTarget((current) => current?.queueItemId === queueItemId && current.position === position ? current : { queueItemId, position });
  }
  function handleDrop(event: DragEvent<HTMLDivElement>, queueItemId: string): void {
    event.preventDefault();
    const sourceId = draggedQueueItemId || event.dataTransfer.getData("text/plain");
    const sourceIndex = queue.findIndex((item) => item.queueItemId === sourceId);
    const targetIndex = queue.findIndex((item) => item.queueItemId === queueItemId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      clearDragState();
      return;
    }
    const insertionIndex = targetIndex + (dropTarget?.queueItemId === queueItemId && dropTarget.position === "after" ? 1 : 0);
    const finalIndex = insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex;
    clearDragState();
    if (finalIndex !== sourceIndex) void reorderQueueItem(sourceId, finalIndex);
  }
  const currentItem = playback.current ? { queueItemId: playback.currentQueueItemId ?? "current", track: playback.current } : null;

  const panelStyle = floating ? undefined : { "--queue-dock-width": `${dockWidth}px`, "--queue-dock-height": `${dockHeight}px` } as React.CSSProperties;
  const listeningPreset = effectivePlacement === "right" && view !== "dsp";
  const libraryPreset = effectivePlacement === "bottom" && view !== "dsp";
  const dspPreset = effectivePlacement === "right" && view === "dsp";

  return <motion.aside ref={panelRef} role="dialog" aria-modal={floating ? "true" : undefined} aria-label="播放队列" className={`queue-panel dock-${effectivePlacement}`} style={panelStyle} initial={{opacity:0,x:effectivePlacement === "left" ? -24 : 24}} animate={{opacity:1,x:0}} exit={{opacity:0,x:20}} drag={floating} dragMomentum={false} onKeyDown={handlePanelKeyDown}>
    <header><div><h3>播放队列</h3><span>{playback.queue.length + playback.nextUp.length} 首 · 混合来源</span></div><button type="button" className="queue-clear" onClick={() => void clearQueue("all")} disabled={!playback.queue.length && !playback.nextUp.length}>清空</button><IconButton label="队列布局" active={tab === "layout"} onClick={() => setTab(tab === "layout" ? "queue" : "layout")}><Sidebar/></IconButton><IconButton label="关闭队列" onClick={closePanel}><X/></IconButton></header>
    <div className="panel-tabs" role="tablist" aria-label="队列面板视图" onKeyDown={handleTabKeyDown}><button id={`${tabsId}-queue-tab`} type="button" role="tab" aria-selected={tab === "queue"} aria-controls={`${tabsId}-queue-panel`} tabIndex={tab === "queue" ? 0 : -1} onClick={() => setTab("queue")}>队列</button><button id={`${tabsId}-layout-tab`} type="button" role="tab" aria-selected={tab === "layout"} aria-controls={`${tabsId}-layout-panel`} tabIndex={tab === "layout" ? 0 : -1} onClick={() => setTab("layout")}>布局</button></div>
    {tab === "layout" ? <section id={`${tabsId}-layout-panel`} role="tabpanel" aria-labelledby={`${tabsId}-layout-tab`} className="layout-panel"><h4>停靠位置</h4><div className="dock-choices" role="radiogroup" aria-label="队列停靠位置"><button role="radio" aria-checked={effectivePlacement === "left"} onClick={() => setPlacement("left")} className={effectivePlacement === "left" ? "active" : ""}>左侧</button><button role="radio" aria-checked={effectivePlacement === "right"} onClick={() => setPlacement("right")} className={effectivePlacement === "right" ? "active" : ""}>右侧</button><button role="radio" aria-checked={effectivePlacement === "bottom"} onClick={() => setPlacement("bottom")} className={effectivePlacement === "bottom" ? "active" : ""}>底部</button><button role="radio" aria-checked={effectivePlacement === "floating"} onClick={() => setPlacement("floating")} className={effectivePlacement === "floating" ? "active" : ""}>浮动</button></div><h4>停靠尺寸</h4><div className="dock-size-controls"><label><span>左右宽度</span><input aria-label="队列停靠宽度" type="number" min="320" max="560" step="10" value={dockWidth} onChange={(event) => updateDockWidth(Number(event.target.value))}/><small>px</small></label><label><span>底部高度</span><input aria-label="队列停靠高度" type="number" min="220" max="520" step="10" value={dockHeight} onChange={(event) => updateDockHeight(Number(event.target.value))}/><small>px</small></label></div><h4>布局预设</h4><button className={`layout-preset ${listeningPreset ? "active" : ""}`} aria-pressed={listeningPreset} onClick={() => { setPlacement("right"); useAppStore.getState().navigate("home"); }}><b>聆听</b><span>首页，队列停靠右侧</span></button><button className={`layout-preset ${libraryPreset ? "active" : ""}`} aria-pressed={libraryPreset} onClick={() => { setPlacement("bottom"); useAppStore.getState().navigate("library"); }}><b>曲库管理</b><span>音乐库，队列停靠底部</span></button><button className={`layout-preset ${dspPreset ? "active" : ""}`} aria-pressed={dspPreset} onClick={() => { setPlacement("right"); useAppStore.getState().navigate("dsp"); }}><b>DSP 调音</b><span>打开工作台，队列停靠右侧</span></button><button className="button secondary restore-layout" onClick={restoreLayout}>恢复默认布局</button><p>面板位置与停靠尺寸会在此设备上保留。960 px 及以下使用覆盖面板。使用 Alt+Q 打开或关闭队列。</p></section> : <section id={`${tabsId}-queue-panel`} role="tabpanel" aria-labelledby={`${tabsId}-queue-tab`}>{currentItem ? <><h4>当前播放</h4><QueueItem item={currentItem} active removable={false}/></> : <div className="queue-empty"><Queue/><b>当前没有播放曲目</b><span>从真实曲库选择曲目后会显示在这里</span></div>}
      <div className="queue-section-heading"><h4 id="queue-next-heading">接下来播放</h4>{playback.nextUp.length > 0 && <button type="button" onClick={() => void clearQueue("playNext")}>清空</button>}</div><div role="list" aria-labelledby="queue-next-heading">{playback.nextUp.map((item) => <QueueItem key={item.queueItemId} item={item} onRemove={removeQueueItem}/>)}</div>
      <h4 id="queue-context-heading">当前上下文</h4><div role="list" aria-labelledby="queue-context-heading" onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}>{playback.queue.map((item, index) => <QueueItem key={item.queueItemId} item={item} draggable dragging={draggedQueueItemId === item.queueItemId} dropPosition={dropTarget?.queueItemId === item.queueItemId ? dropTarget.position : undefined} position={index + 1} setSize={playback.queue.length} onRemove={removeQueueItem} onMoveUp={index > 0 ? () => void reorderQueueItem(item.queueItemId, index - 1) : undefined} onMoveDown={index < playback.queue.length - 1 ? () => void reorderQueueItem(item.queueItemId, index + 1) : undefined} onDragStart={(event) => handleDragStart(event, item.queueItemId)} onDragEnd={clearDragState} onDragOver={(event) => handleDragOver(event, item.queueItemId)} onDrop={(event) => handleDrop(event, item.queueItemId)}/>)}</div>
      {!playback.queue.length && !playback.nextUp.length && <p className="queue-none">队列为空</p>}
    </section>}
  </motion.aside>;
}

export function QueueOverlay(): React.JSX.Element {
  const { overlay, setOverlay } = useAppStore();
  return <AnimatePresence>{overlay === "queue" && <><button aria-label="关闭队列" className="panel-scrim" onClick={() => setOverlay("none")}/><QueuePanel/></>}</AnimatePresence>;
}
