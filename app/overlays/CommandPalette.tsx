import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Command, MagnifyingGlass } from "@phosphor-icons/react";
import { useAppStore } from "../store";

const commands = [
  ["打开网易云首页", function openNetease(): void { const state = useAppStore.getState(); state.setDomain("netease"); state.navigate("home"); }],
  ["切换到本地音乐", function openLocal(): void { useAppStore.getState().setDomain("local"); }],
  ["打开播放层", function openPlayer(): void { useAppStore.getState().setExpanded(true); }],
  ["打开播放队列", function openQueue(): void { useAppStore.getState().setOverlay("queue"); }],
  ["打开设置", function openSettings(): void { useAppStore.getState().navigate("settings"); }],
  ["查看状态中心", function openStatus(): void { useAppStore.getState().navigate("status"); }],
] as const;

export function CommandPalette(): React.JSX.Element {
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = commands.filter(([name]) => name.includes(query.replace(/^>/, "")));

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setSearchOpen(false);
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input,button:not([disabled])") ?? [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + direction + buttons.length) % buttons.length]?.focus();
    }
  }

  return <div className="modal-backdrop" onMouseDown={() => setSearchOpen(false)}><motion.div ref={dialogRef} role="dialog" aria-modal="true" aria-label="搜索与命令" className="command-palette" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleKeyDown} initial={{opacity:0,scale:.98,y:-8}} animate={{opacity:1,scale:1,y:0}}><div><MagnifyingGlass/><input ref={inputRef} aria-label="搜索音乐或命令" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索音乐，输入 > 查找命令"/><kbd>Esc</kbd></div><p>{query.startsWith(">") ? "命令" : "建议"}</p>{results.map(([name, action], index) => <button key={name} onClick={() => { action(); setSearchOpen(false); }} className={index === 0 ? "active" : ""}><Command/><span>{name}</span><kbd>Enter</kbd></button>)}</motion.div></div>;
}
