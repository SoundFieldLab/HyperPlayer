import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowClockwise,
  Bell,
  Cloud,
  Command,
  Gear,
  ListBullets,
  MagnifyingGlass,
  MapPin,
  MusicNote,
  Pause,
  Play,
  Queue as QueueIcon,
  SkipBack,
  SkipForward,
  Sun,
} from "@phosphor-icons/react";
import { bridge } from "../bridge";
import type { ShenzhenWeatherDto } from "../bridge/contracts";
import { Cover } from "../components/ui";
import { useAppStore } from "../store";

interface CommandItem {
  name: string;
  hint: string;
  action(): void;
  icon: React.ComponentType<{ weight?: "regular"; "aria-hidden"?: boolean }>;
}

const commandItems: CommandItem[] = [
  { name: "打开网易云首页", hint: "Mainpage", icon: MusicNote, action() { const state = useAppStore.getState(); state.setDomain("netease"); state.navigate("home"); } },
  { name: "切换到本地音乐", hint: "本地曲库", icon: MusicNote, action() { useAppStore.getState().setDomain("local"); } },
  { name: "打开播放层", hint: "当前播放", icon: Play, action() { useAppStore.getState().setExpanded(true); } },
  { name: "打开播放队列", hint: "接下来播放", icon: QueueIcon, action() { useAppStore.getState().setOverlay("queue"); } },
  { name: "打开设置", hint: "应用设置", icon: Gear, action() { useAppStore.getState().navigate("settings"); } },
  { name: "查看状态中心", hint: "任务与服务", icon: ListBullets, action() { useAppStore.getState().navigate("status"); } },
  { name: "查看通知", hint: "消息中心", icon: Bell, action() { useAppStore.getState().navigate("messages"); } },
];

function formatClock(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(now);
}

function formatDate(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Shanghai" }).format(now);
}

function playbackLabel(status: string): string {
  if (status === "playing") return "正在播放";
  if (status === "buffering") return "正在缓冲";
  if (status === "paused") return "已暂停";
  return "等待播放";
}

function WeatherIcon({ weather }: { weather: ShenzhenWeatherDto }): React.JSX.Element {
  const rainy = weather.weatherCode >= 51 && weather.weatherCode <= 99;
  return rainy ? <Cloud weight="regular" aria-hidden/> : <Sun weight="regular" aria-hidden/>;
}

const loadShenzhenWeather = (): Promise<ShenzhenWeatherDto> => bridge.shenzhenWeather();
const currentTime = (): Date => new Date();

interface CommandPaletteProps {
  loadWeather?: () => Promise<ShenzhenWeatherDto>;
  now?: () => Date;
}

export function CommandPalette({ loadWeather = loadShenzhenWeather, now = currentTime }: CommandPaletteProps): React.JSX.Element {
  const { playback, tasks, setSearchOpen, togglePlayback, previous, next } = useAppStore();
  const [query, setQuery] = useState("");
  const [clock, setClock] = useState(now);
  const [weather, setWeather] = useState<ShenzhenWeatherDto | null>(null);
  const [weatherState, setWeatherState] = useState<"loading" | "ready" | "error">("loading");
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const timer = window.setInterval(() => setClock(now()), 30_000);
    return () => window.clearInterval(timer);
  }, [now]);

  async function refreshWeather(): Promise<void> {
    setWeatherState("loading");
    try {
      setWeather(await loadWeather());
      setWeatherState("ready");
    } catch {
      setWeather(null);
      setWeatherState("error");
    }
  }

  useEffect(() => {
    let active = true;
    setWeatherState("loading");
    void loadWeather().then((value) => {
      if (!active) return;
      setWeather(value);
      setWeatherState("ready");
    }).catch(() => {
      if (!active) return;
      setWeatherState("error");
    });
    return () => { active = false; };
  }, [loadWeather]);

  const normalizedQuery = query.replace(/^>/, "").trim();
  const results = useMemo(
    () => commandItems.filter(({ name, hint }) => `${name} ${hint}`.includes(normalizedQuery)),
    [normalizedQuery],
  );
  const searching = query.length > 0;
  const current = playback?.current;
  const activeTasks = tasks.filter((task) => task.state !== "complete");

  function runCommand(action: () => void): void {
    action();
    setSearchOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setSearchOpen(false);
      return;
    }
    if (event.key === "Enter" && document.activeElement === inputRef.current && results[0]) {
      event.preventDefault();
      runCommand(results[0].action);
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
      const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + direction + buttons.length) % buttons.length]?.focus();
    }
  }

  return <div className="modal-backdrop command-center-backdrop" onMouseDown={() => setSearchOpen(false)}>
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="HyperPlayer 命令中心"
      className="command-palette command-center"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
      initial={{ opacity: 0, scale: 0.985, y: -10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
    >
      <div className="command-search">
        <MagnifyingGlass aria-hidden/>
        <input ref={inputRef} aria-label="搜索命令" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索命令或快捷入口"/>
        <kbd>Esc</kbd>
      </div>

      {!searching && <div className="command-dashboard">
        <section className="command-moment" aria-label="时间与深圳天气">
          <div className="command-time"><time>{formatClock(clock)}</time><span>{formatDate(clock)}</span></div>
          <div className={`weather-scene ${weather?.isDay ? "day" : "night"}`}>
            <div className="weather-place"><MapPin aria-hidden/><span>深圳</span></div>
            {weatherState === "loading" && <p role="status">正在获取天气</p>}
            {weatherState === "error" && <div className="weather-error"><span>天气暂不可用</span><button type="button" onClick={() => void refreshWeather()} aria-label="重试深圳天气"><ArrowClockwise aria-hidden/></button></div>}
            {weatherState === "ready" && weather && <>
              <WeatherIcon weather={weather}/>
              <strong>{Math.round(weather.temperatureC)}°</strong>
              <span>{weather.condition} · 体感 {Math.round(weather.apparentTemperatureC)}°</span>
              <small>湿度 {weather.relativeHumidityPercent}% · 风速 {Math.round(weather.windSpeedKmh)} km/h</small>
            </>}
          </div>
        </section>

        <section className="command-now" aria-label="当前播放">
          <header><span>当前播放</span><small>{playbackLabel(playback?.status ?? "unavailable")}</small></header>
          <div className="command-track">
            {current ? <Cover src={current.coverSeed} alt=""/> : <div className="command-cover-empty"><MusicNote aria-hidden/></div>}
            <span><b>{current?.title ?? "尚未选择歌曲"}</b><small>{current?.artists.join(" / ") || "从曲库中选择音乐"}</small></span>
          </div>
          <div className="command-transport">
            <button type="button" onClick={() => void previous()} disabled={!current} aria-label="上一首"><SkipBack weight="fill"/></button>
            <button type="button" className="primary" onClick={() => void togglePlayback()} disabled={!current} aria-label={playback?.status === "playing" ? "暂停" : "播放"}>{playback?.status === "playing" ? <Pause weight="fill"/> : <Play weight="fill"/>}</button>
            <button type="button" onClick={() => void next()} disabled={!current} aria-label="下一首"><SkipForward weight="fill"/></button>
          </div>
          {/* 摘要行文字禁止拆行（main.tsx 的 CSS 导入顺序使 .command-palette 620px 宽度生效，右栏放不下整行）：空间不足时让按钮整体换行而非把文字拆开 */}
          <div className="command-task-summary" style={{ flexWrap: "wrap" }}><span style={{ whiteSpace: "nowrap" }}>{activeTasks.length ? `${activeTasks.length} 个后台任务进行中` : "没有进行中的后台任务"}</span><button type="button" style={{ whiteSpace: "nowrap" }} onClick={() => runCommand(() => useAppStore.getState().navigate("status"))}>状态中心</button></div>
        </section>
      </div>}

      <section className="command-actions" aria-label={searching ? "搜索结果" : "常用快捷入口"}>
        <p>{searching ? "搜索结果" : "常用快捷入口"}</p>
        <div>{results.map(({ name, hint, icon: Icon, action }, index) => <button key={name} type="button" onClick={() => runCommand(action)} className={searching && index === 0 ? "active" : ""}><Icon weight="regular" aria-hidden/><span><b>{name}</b><small>{hint}</small></span><Command aria-hidden/></button>)}</div>
        {!results.length && <div className="command-empty">没有匹配的命令</div>}
      </section>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></footer>
    </motion.div>
  </div>;
}
