import type { ReactNode } from "react";
import { CaretRight, House, Info, SpinnerGap } from "@phosphor-icons/react";
import type { TrackDto } from "../bridge/contracts";
import type { RemoteState } from "../remote";

export type IconType = typeof House;

interface IconButtonProps {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}

export function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = "",
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "active" : ""} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function Cover({ src, alt, className = "" }: { src: string; alt: string; className?: string }): React.JSX.Element {
  return <img className={`cover ${className}`} src={src} alt={alt} draggable={false} />;
}

export function SourceMark({ source }: { source: TrackDto["source"] }): React.JSX.Element {
  return <span className={`source ${source}`}>{source === "netease" ? "云" : "本地"}</span>;
}

interface SegmentedProps {
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  label?: string;
}

export function Segmented({ value, options, onChange, label = "选项" }: SegmentedProps): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([optionValue, optionLabel]) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === optionValue}
          key={optionValue}
          className={value === optionValue ? "selected" : ""}
          onClick={() => onChange(optionValue)}
        >
          {optionLabel}
        </button>
      ))}
    </div>
  );
}

export function Brand(): React.JSX.Element {
  return <div className="brand"><span className="brand-mark"><i /><i /><i /></span><strong>HyperPlayer</strong></div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: string }): React.JSX.Element {
  return <div className="section-title"><h2>{children}</h2>{action && <button>{action}<CaretRight /></button>}</div>;
}

interface PageProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Page({ title, subtitle, actions, children }: PageProps): React.JSX.Element {
  return <div className="page"><div className="page-heading"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</div>{children}</div>;
}

interface RemoteNoticeProps {
  state: RemoteState<unknown>;
  empty?: string;
  retry?: () => void;
}

export function RemoteNotice({ state, empty = "暂无数据", retry }: RemoteNoticeProps): React.JSX.Element | null {
  if (state.status === "loading" || state.status === "idle") {
    return <div className="remote-state" role="status"><SpinnerGap className="spin" /><b>正在加载</b></div>;
  }
  if (state.status === "ready") return null;

  let title = "加载失败";
  if (state.status === "empty") title = empty;
  if (state.status === "unavailable") title = "此功能当前不可用";
  const message = "message" in state ? state.message : "后端返回了空结果";

  return (
    <div className={`remote-state ${state.status}`} role={state.status === "error" ? "alert" : "status"}>
      <Info />
      <b>{title}</b>
      <span>{message}</span>
      {retry && state.status !== "empty" && <button className="button secondary" onClick={retry}>重试</button>}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }): React.JSX.Element {
  return <button className={`toggle ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)} disabled={disabled}><i /></button>;
}

export function SettingRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }): React.JSX.Element {
  return <div className="setting-row"><span><b>{title}</b><small>{detail}</small></span>{children}</div>;
}
