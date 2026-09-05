import { useEffect, useRef, useState } from "react";
import { Info, X } from "@phosphor-icons/react";
import { IconButton } from "../components/ui";
import { useAppStore } from "../store";

export function ToastRegion(): React.JSX.Element {
  const { toasts, dismissToast } = useAppStore();
  useEffect(() => {
    if (!toasts.length) return;
    const id = toasts[0].id;
    const timer = window.setTimeout(() => dismissToast(id), 5000);
    return () => window.clearTimeout(timer);
  }, [toasts, dismissToast]);
  return <div className="toast-region" aria-live="assertive">{toasts.map((toast) => <div className="error-toast" role="alert" key={toast.id}><Info/><span>{toast.message}</span><IconButton label="关闭提示" onClick={() => dismissToast(toast.id)}><X/></IconButton></div>)}</div>;
}

export function CloseConfirmDialog(): React.JSX.Element | null {
  const { closeRequest, resolveClose } = useAppStore();
  const [remember, setRemember] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (closeRequest && !dialog.open) dialog.showModal();
    if (!closeRequest && dialog.open) dialog.close();
  }, [closeRequest]);
  if (!closeRequest) return null;
  const detail = closeRequest.isPlaying || closeRequest.hasBackgroundTasks
    ? "播放或后台任务仍在进行。你可以最小化到托盘继续运行，或完全退出。"
    : "选择将 HyperPlayer 最小化到托盘，或完全退出。";
  return <dialog ref={dialogRef} className="close-dialog" style={{ position: "fixed", inset: 0, margin: "auto", height: "fit-content" }} aria-labelledby="close-title" aria-describedby="close-detail" onCancel={(event) => { event.preventDefault(); void resolveClose("cancel", false); }}>
    <form method="dialog"><h2 id="close-title">关闭 HyperPlayer？</h2><p id="close-detail">{detail}</p><label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)}/>记住我的选择</label><div><button type="button" className="button ghost" onClick={() => void resolveClose("cancel", false)}>取消</button><button type="button" className="button secondary" onClick={() => void resolveClose("minimizeToTray", remember)}>最小化到托盘</button><button type="button" className="button danger" onClick={() => void resolveClose("exit", remember)}>退出</button></div></form>
  </dialog>;
}
