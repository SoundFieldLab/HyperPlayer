import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretUp, CloudArrowDown, DotsThree, ListPlus, Play, Queue, SpinnerGap, Trash, Waveform, X } from "@phosphor-icons/react";
import { bridge } from "../bridge";
import type { PlaybackContextDto, TrackDto } from "../bridge/contracts";
import { useAppStore } from "../store";
import { formatTime, SourceMark } from "./ui";

type SortKey = "title" | "artist" | "album" | "duration";
type MenuState = { x: number; y: number; track: TrackDto } | null;
const columnLabels = { title: "标题", artist: "歌手", album: "专辑", duration: "时长" } as const;

export function TrackTable({ tracks, compact = false, playbackContext }: { tracks: TrackDto[]; compact?: boolean; playbackContext?: PlaybackContextDto }) {
  const { selectedTrackIds, playback, playTrack, enqueueTrack } = useAppStore();
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: "title", direction: 1 });
  const [widths, setWidths] = useState(() => { try { return JSON.parse(localStorage.getItem("hyperplayer.track-columns") ?? "null") ?? { title: 260, artist: 160, album: 170 }; } catch { return { title: 260, artist: 160, album: 170 }; } });
  const [hidden, setHidden] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirm, setConfirm] = useState<TrackDto[] | null>(null);
  const [undo, setUndo] = useState<{ ids: string[]; label: string } | null>(null);
  const anchor = useRef<string | null>(null);
  useEffect(() => { localStorage.setItem("hyperplayer.track-columns", JSON.stringify(widths)); }, [widths]);

  const visibleTracks = useMemo(() => tracks.filter((track) => !hidden.includes(track.id)), [hidden, tracks]);
  const ordered = useMemo(() => [...visibleTracks].sort((a, b) => {
    const value = sort.key === "artist" ? a.artists.join(" ") : sort.key === "duration" ? a.durationMs : a[sort.key];
    const other = sort.key === "artist" ? b.artists.join(" ") : sort.key === "duration" ? b.durationMs : b[sort.key];
    return (typeof value === "number" ? value - (other as number) : value.localeCompare(other as string, "zh-CN")) * sort.direction;
  }), [sort, visibleTracks]);
  const selected = ordered.filter((track) => selectedTrackIds.includes(track.id));

  const select = (track: TrackDto, event: Pick<React.MouseEvent | React.KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">) => {
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && anchor.current) {
      const from = ordered.findIndex((item) => item.id === anchor.current);
      const to = ordered.findIndex((item) => item.id === track.id);
      const ids = ordered.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.id);
      useAppStore.setState((state) => ({ selectedTrackIds: additive ? [...new Set([...state.selectedTrackIds, ...ids])] : ids }));
    } else {
      useAppStore.getState().selectTrack(track.id, additive);
      anchor.current = track.id;
    }
  };
  const sortBy = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 1 ? -1 : 1 } : { key, direction: 1 });
  const resize = (key: "title" | "artist" | "album", event: React.PointerEvent) => {
    event.preventDefault();
    const start = event.clientX;
    const initial = widths[key];
    const move = (next: PointerEvent) => setWidths((current: typeof widths) => ({ ...current, [key]: Math.max(100, initial + next.clientX - start) }));
    const done = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", done); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done, { once: true });
  };
  const resetColumns = () => { const value = { title: 260, artist: 160, album: 170 }; setWidths(value); localStorage.setItem("hyperplayer.track-columns", JSON.stringify(value)); };
  const removeWithUndo = (items: TrackDto[]) => {
    const ids = items.map((item) => item.id);
    setHidden((current) => [...new Set([...current, ...ids])]);
    useAppStore.setState({ selectedTrackIds: [] });
    setMenu(null);
    setUndo({ ids, label: `已从当前列表移除 ${ids.length} 首歌曲` });
  };
  async function moveToRecycleBin(items: TrackDto[]): Promise<void> {
    const removed: TrackDto[] = [];
    for (const item of items) {
      try {
        const result = await bridge.libraryMoveToRecycleBin(item.id);
        if (result.movedToRecycleBin && result.removedFromLibrary) removed.push(item);
      } catch (error) {
        useAppStore.getState().notifyError(error, `无法将 ${item.title} 移到回收站`);
      }
    }
    if (removed.length > 0) {
      setHidden((current) => [...new Set([...current, ...removed.map((item) => item.id)])]);
      useAppStore.setState({ selectedTrackIds: [] });
      setMenu(null);
      setUndo({ ids: [], label: `已将 ${removed.length} 个文件移到 Windows 回收站` });
    }
    setConfirm(null);
  }
  const selectedOr = (track: TrackDto) => selectedTrackIds.includes(track.id) && selected.length ? selected : [track];
  const commands = (track: TrackDto) => {
    const targets = selectedOr(track);
    return [
      { id: "play", label: targets.length === 1 ? "播放" : `播放所选 ${targets.length} 首`, icon: Play, run: () => void playTrack(targets[0], playbackContext) },
      { id: "next", label: "下一首播放", icon: Queue, run: () => targets.forEach((item) => void enqueueTrack(item, "playNext")) },
      { id: "queue", label: "加入队列", icon: ListPlus, run: () => targets.forEach((item) => void enqueueTrack(item)) },
      { id: "remove", label: "在此视图隐藏", icon: X, run: () => removeWithUndo(targets) },
      targets.every((item) => item.source === "local") && { id: "trash", label: `将 ${targets.length} 个本地文件移到回收站...`, icon: Trash, danger: true, run: () => { setConfirm(targets); setMenu(null); } },
    ].filter(Boolean) as Array<{ id: string; label: string; icon: typeof Play; danger?: boolean; run: () => void }>;
  };

  const template = `38px minmax(180px,${widths.title}px) minmax(110px,${widths.artist}px) minmax(110px,${widths.album}px) 120px 58px 40px`;
  return <div className={`advanced-track-wrap ${compact ? "compact" : ""}`}>
    {!compact && <div className="table-options"><button onClick={resetColumns}>恢复默认列宽</button></div>}
    {selected.length > 1 && <div className="batch-bar" role="toolbar" aria-label={`已选择 ${selected.length} 首歌曲`}><b>已选择 {selected.length} 首</b><button onClick={() => selected.forEach((track) => void enqueueTrack(track, "playNext"))}><Queue />下一首播放</button><button onClick={() => selected.forEach((track) => void enqueueTrack(track))}><ListPlus />加入队列</button><button onClick={() => removeWithUndo(selected)}><X />移除</button></div>}
    <div className="track-table" role="grid" aria-label="曲目列表" onKeyDown={(event) => {
      if (event.shiftKey && event.key === "F10" && selected[0]) { event.preventDefault(); setMenu({ x: 120, y: 160, track: selected[0] }); }
      const focused = document.activeElement?.getAttribute("data-track-id");
      const index = ordered.findIndex((item) => item.id === focused);
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && index >= 0) {
        event.preventDefault();
        const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
        document.querySelector<HTMLElement>(`[data-track-id="${next.id}"]`)?.focus();
        select(next, event);
      }
    }}>
      {!compact && <div className="track-header" role="row" style={{ gridTemplateColumns: template }}><span>#</span>{(["title", "artist", "album"] as const).map((key) => <button className="sortable-column" role="columnheader" key={key} onClick={() => sortBy(key)}>{columnLabels[key]}{sort.key === key && (sort.direction === 1 ? <CaretUp /> : <CaretDown />)}<i role="separator" aria-label={`调整${columnLabels[key]}列宽`} onPointerDown={(event) => resize(key, event)} /></button>)}<span>状态</span><button className="sortable-column" role="columnheader" onClick={() => sortBy("duration")}>时长{sort.key === "duration" && (sort.direction === 1 ? <CaretUp /> : <CaretDown />)}</button><span /></div>}
      {ordered.map((track, index) => {
        const current = playback?.current?.id === track.id;
        return <div role="row" data-track-id={track.id} aria-selected={selectedTrackIds.includes(track.id)} tabIndex={0} key={track.id} className={`track-row ${selectedTrackIds.includes(track.id) ? "selected" : ""} ${current ? "current" : ""}`} style={{ gridTemplateColumns: template }} onClick={(event) => select(track, event)} onDoubleClick={() => void playTrack(track, playbackContext)} onContextMenu={(event) => { event.preventDefault(); if (!selectedTrackIds.includes(track.id)) select(track, event); setMenu({ x: event.clientX, y: event.clientY, track }); }} onKeyDown={(event) => { if (event.key === "Enter") void playTrack(track, playbackContext); }}>
          <span className="track-index">{current ? <Waveform weight="bold" /> : String(index + 1).padStart(2, "0")}</span><span className="track-title"><img className="cover" src={track.coverSeed} alt="" draggable={false}/><span><b>{track.title}</b><small>{track.quality}</small></span></span><span>{track.artists.join(" / ")}</span><span>{track.album}</span><span className="status-cell"><SourceMark source={track.source}/>{track.entitlement === "vip" && <em>VIP</em>}{track.cache === "ready" && <CloudArrowDown aria-label="已缓存"/>}{track.cache === "prefetching" && <SpinnerGap className="spin"/>}</span><span className="mono">{formatTime(track.durationMs)}</span><button className="icon-button" aria-label={`打开 ${track.title} 菜单`} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right - 220, y: rect.bottom + 4, track }); }}><DotsThree /></button>
        </div>;
      })}
    </div>
    {menu && <><button className="menu-scrim" aria-label="关闭菜单" onClick={() => setMenu(null)} /><div className="context-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 236), top: Math.min(menu.y, window.innerHeight - 310) }} onKeyDown={(event) => { const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if (event.key === "Escape") setMenu(null); if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length]?.focus(); if (event.key === "ArrowUp") buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); }} ref={(node) => node?.querySelector<HTMLButtonElement>("button")?.focus()}>{commands(menu.track).map(({ id, label, icon: Icon, danger, run }) => <button key={id} role="menuitem" className={danger ? "danger" : ""} onClick={run}><Icon />{label}</button>)}</div></>}
    {undo && <div className="undo-toast" role="status"><span>{undo.label}</span><button onClick={() => { setHidden((current) => current.filter((id) => !undo.ids.includes(id))); setUndo(null); }}>撤销</button><button aria-label="关闭" onClick={() => setUndo(null)}><X /></button></div>}
    {confirm && <div className="modal-backdrop"><div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">将 {confirm.length} 个文件移到回收站</h2><p>{confirm.slice(0, 3).map((item) => item.title).join("、")}{confirm.length > 3 ? ` 等 ${confirm.length} 首` : ""}。文件将离开曲库，可从 Windows 回收站恢复。</p><div><button autoFocus className="button secondary" onClick={() => setConfirm(null)}>取消</button><button className="button danger" onClick={() => void moveToRecycleBin(confirm)}>移到回收站</button></div></div></div>}
  </div>;
}
