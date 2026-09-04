import { Component, type ErrorInfo, type ReactNode } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// 基础样式必须先于 App 导入：ES 导入按序执行，App 引入的 styles/redesign.css 等
// 增强层依赖基础层先注入；顺序颠倒会让同级特异性下 styles.css 反超（曾导致
// 命令面板宽度被旧规则覆盖、右栏文字拆行）。
import "./styles.css";
import App from "./App";
import { installConsoleCapture } from "./weblog";

// 渲染树兜底：任何未捕获的渲染错误都以中文错误页呈现（而不是 React 卸载整树后的
// 白屏），并把 error + componentStack 打到 console.error——weblog 抓取后经 log_web
// 上报到后端日志文件，便于远程诊断辅助窗口/主窗口的崩溃。
class RenderErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[HyperPlayer] 界面渲染崩溃:", error, info.componentStack ?? "");
  }
  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // 内联样式：错误页不能依赖任何可能未加载/变量未定义的 CSS。
    return (
      <main role="alert" style={{ font: "15px system-ui", padding: "32px", maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 18 }}>HyperPlayer 界面出现异常</h1>
        <p style={{ color: "#666" }}>页面渲染出现问题，请点击重试；若持续出现，请通过托盘菜单退出后重新启动。</p>
        <pre style={{ whiteSpace: "pre-wrap", font: "12px 'Cascadia Mono',monospace", color: "#b3261e", background: "#f6f6f8", padding: 12, borderRadius: 8 }}>{error.message}</pre>
        <button onClick={() => this.setState({ error: null })} style={{ padding: "8px 20px", borderRadius: 8, border: "1px solid #ccc", background: "#3F55F9", color: "#fff", cursor: "pointer" }}>重试</button>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("HyperPlayer root element is missing");

if (!("__TAURI_INTERNALS__" in window)) {
  root.innerHTML = '<main style="font:16px system-ui;padding:32px">HyperPlayer 必须通过 Tauri 桌面应用启动。</main>';
  throw new Error("HyperPlayer requires the Tauri desktop runtime");
}

// console 抓取最先安装：入口报错/React 错误也能上报后端日志文件。
installConsoleCapture();

createRoot(root).render(
  <StrictMode>
    <RenderErrorBoundary>
      <App />
    </RenderErrorBoundary>
  </StrictMode>,
);
