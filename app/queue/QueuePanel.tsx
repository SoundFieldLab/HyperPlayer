import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, CaretUp, Check, Queue, Sidebar, X } from "@phosphor-icons/react";
import type { QueueItemDto } from "../bridge/contracts";
import { useAppStore } from "../store";
import { Cover, IconButton, SourceMark } from "../components/ui";

type QueuePlacement = "left" | "right" | "bottom" | "floating";

interface QueueItemProps {
  item: QueueItemDto;
  active?: boolean;
  removable?: boolean;
  onRemove?: (id: string) => Promise<void>;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function QueueItem({ item, active = false, removable = true, onRemove, onMoveUp, onMoveDown }: QueueItemProps): React.JSX.Element {
  const track = item.track;
  return <div className={`queue-item ${active ? "active" : ""}`}><Cover src={track.coverSeed} alt=""/><span><b>{track.title}</b><small>{track.artists.join(" / ")}</small></span><SourceMark source={track.source}/><div className="queue-item-actions">{removable && <><IconButton label={`上移 ${track.title}`} disabled={!onMoveUp} onClick={onMoveUp}><CaretUp/></IconButton><IconButton label={`下移 ${track.title}`} disabled={!onMoveDown} onClick={onMoveDown}><CaretDown/></IconButton>{onRemove && <IconButton label={`从队列移除 ${track.title}`} onClick={() => void onRemove(item.queueItemId)}><X/></IconButton>}</>}</div></div>;
}

export function QueuePanel({ floating = false }: { floating?: boolean }): React.JSX.Element | null {
  const { playback, setOverlay, setQueueFloating, removeQueueItem, reorderQueueItem, clearQueue } = useAppStore();
  const [placement, setPlacementState] = useState<QueuePlacement>(() => floating ? "floating" : (localStorage.getItem("hyperplayer.queue-placement") as QueuePlacement) || "right");
  const [tab, setTab] = useState<"queue" | "layout">("queue");
  if (!playback) return null;

  const effectivePlacement = floating ? "floating" : placement;
  function setPlacement(next: QueuePlacement): void {
    localStorage.setItem("hyperplayer.queue-placement", next);
    setPlacementState(next);
    if (next === "floating") setQueueFloating(true);
  }
  function restoreLayout(): void {
    localStorage.removeItem("hyperplayer.queue-placement");
    setPlacementState("right");
    setQueueFloating(false);
  }
  const currentItem = playback.current ? { queueItemId: playback.currentQueueItemId ?? "current", track: playback.current } : null;

  return <motion.aside role="dialog" aria-modal={effectivePlacement === "floating"} aria-label="播放队列" className={`queue-panel dock-${effectivePlacement}`} initial={{opacity:0,x:effectivePlacement === "left" ? -24 : 24}} animate={{opacity:1,x:0}} exit={{opacity:0,x:20}} drag={effectivePlacement === "floating"} dragMomentum={false}>
    <header><div><h3>播放队列</h3><span>{playback.queue.length + playback.nextUp.length} 首 · 混合来源</span></div><button type="button" className="queue-clear" onClick={() => void clearQueue("all")} disabled={!playback.queue.length && !playback.nextUp.length}>清空</button><IconButton label="队列布局" active={tab === "layout"} onClick={() => setTab(tab === "layout" ? "queue" : "layout")}><Sidebar/></IconButton><IconButton label="关闭队列" onClick={() => effectivePlacement === "floating" ? setQueueFloating(false) : setOverlay("none")}><X/></IconButton></header>
    <div className="panel-tabs" role="tablist"><button role="tab" aria-selected={tab === "queue"} onClick={() => setTab("queue")}>队列</button><button role="tab" aria-selected={tab === "layout"} onClick={() => setTab("layout")}>布局</button></div>
    {tab === "layout" ? <section className="layout-panel"><h4>停靠位置</h4><div className="dock-choices"><button onClick={() => setPlacement("left")} className={effectivePlacement === "left" ? "active" : ""}>左侧</button><button onClick={() => setPlacement("right")} className={effectivePlacement === "right" ? "active" : ""}>右侧</button><button onClick={() => setPlacement("bottom")} className={effectivePlacement === "bottom" ? "active" : ""}>底部</button><button onClick={() => setPlacement("floating")} className={effectivePlacement === "floating" ? "active" : ""}>浮动</button></div><h4>布局预设</h4><button className="layout-preset active" onClick={() => setPlacement("right")}><b>聆听</b><span>队列停靠右侧</span></button><button className="layout-preset" onClick={() => setPlacement("bottom")}><b>曲库管理</b><span>队列停靠底部</span></button><button className="layout-preset disabled" disabled><b>DSP 调音</b><span>真实 DSP 规格接入后开放</span></button><button className="button secondary restore-layout" onClick={restoreLayout}>恢复默认布局</button><p>面板位置与尺寸会在此设备上保留。使用 Alt+Q 打开或关闭队列。</p></section> : <section>{currentItem ? <><h4>当前播放</h4><QueueItem item={currentItem} active removable={false}/></> : <div className="queue-empty"><Queue/><b>当前没有播放曲目</b><span>从真实曲库选择曲目后会显示在这里</span></div>}
      <div className="queue-section-heading"><h4>接下来播放</h4>{playback.nextUp.length > 0 && <button type="button" onClick={() => void clearQueue("playNext")}>清空</button>}</div>{playback.nextUp.map((item) => <QueueItem key={item.queueItemId} item={item} onRemove={removeQueueItem}/>)}
      <h4>当前上下文</h4>{playback.queue.map((item, index) => <QueueItem key={item.queueItemId} item={item} onRemove={removeQueueItem} onMoveUp={index > 0 ? () => void reorderQueueItem(item.queueItemId, index - 1) : undefined} onMoveDown={index < playback.queue.length - 1 ? () => void reorderQueueItem(item.queueItemId, index + 1) : undefined}/>)}
      {!playback.queue.length && !playback.nextUp.length && <p className="queue-none">队列为空</p>}
    </section>}
    {effectivePlacement !== "floating" && <div className="panel-resizer" aria-hidden="true"/>}
  </motion.aside>;
}

export function QueueOverlay(): React.JSX.Element {
  const { overlay, setOverlay } = useAppStore();
  return <AnimatePresence>{overlay === "queue" && <><button aria-label="关闭队列" className="panel-scrim" onClick={() => setOverlay("none")}/><QueuePanel/></>}</AnimatePresence>;
}
