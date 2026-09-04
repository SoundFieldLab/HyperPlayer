/**
 * WebView console 抓取：包装 console.log/info/warn/error，把输出批量上报到
 * 后端 `log_web` 命令（与后端日志写同一文件，见 src-tauri/src/app_log.rs）。
 *
 * 设计约束：
 * - **不丢原始行为**：包装后仍调用原 console 方法（DevTools 照常可见）。
 * - **批量 + 限频**：缓冲 20 条或 1.5s 触发一次 flush，单条截断 4 KiB；
 *   上报失败静默丢弃该批（日志管道绝不能反过来拖垮 UI）。
 * - **脱敏前置**：上报前移除 Cookie/token 形态的敏感串（后端还有一层 sanitize）。
 * - **测试可用**：`installConsoleCapture` 接受自定义上报函数；`__TAURI_INTERNALS__`
 *   缺失（纯浏览器）时默认不安装。
 */

type ConsoleLevel = "log" | "info" | "warn" | "error";

interface CaptureOptions {
  /** 上报函数（默认走 Tauri invoke；测试注入假实现）。 */
  send?: (level: string, message: string) => void;
}

interface QueuedEntry {
  level: ConsoleLevel;
  message: string;
}

const MAX_ENTRY_CHARS = 4_096;
const MAX_QUEUE = 20;
const FLUSH_INTERVAL_MS = 1_500;

const queue: QueuedEntry[] = [];
let flushTimer = 0;
let installed = false;

/** 把任意 console 参数序列化为单行文本（对象 JSON 化，失败退 toString）。 */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .slice(0, MAX_ENTRY_CHARS);
}

/** 脱敏：登录态 token 值替换为 ***（与后端 app_log::sanitize 同口径）。 */
function sanitizeWeb(message: string): string {
  return message
    .replace(/\b(MUSIC_U|MUSIC_A|x-music-u|__csrf|csrf|authorization)\s*[=:]\s*[^\s;]+/gi, "$1=***");
}

function enqueue(level: ConsoleLevel, args: unknown[]): void {
  queue.push({ level, message: sanitizeWeb(formatArgs(args)) });
  if (queue.length >= MAX_QUEUE) {
    flush();
    return;
  }
  if (flushTimer === 0) {
    flushTimer = window.setTimeout(() => {
      flushTimer = 0;
      flush();
    }, FLUSH_INTERVAL_MS);
  }
}

function flush(): void {
  if (flushTimer !== 0) {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
  }
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  for (const entry of batch) {
    try {
      sender(entry.level === "log" || entry.level === "info" ? "info" : entry.level, entry.message);
    } catch {
      /* 上报失败静默：日志管道不阻塞 UI。 */
    }
  }
}

let sender: (level: string, message: string) => void = () => undefined;

export function installConsoleCapture(options: CaptureOptions = {}): void {
  if (installed) return;
  installed = true;
  sender = options.send ?? defaultSend;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        enqueue(level, args);
      } catch {
        /* 抓取失败不影响原始输出。 */
      }
      original(...args);
    };
  }
}

async function defaultSend(level: string, message: string): Promise<void> {
  // 动态引入避免浏览器态/测试态把 Tauri API 拖进模块图；命令名经 bridge
  // manifest 常量引用，由 verify-contract 统一校验注册一致性。
  const [{ invoke }, { TAURI_COMMANDS }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("./bridge/index"),
  ]);
  await invoke(TAURI_COMMANDS.logWeb, { request: { level, message } });
}

/** 仅测试用：重置模块级状态（不还原 console——vi.restoreAllMocks 处理）。 */
export function resetConsoleCaptureForTests(): void {
  queue.length = 0;
  if (flushTimer !== 0) {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
  }
  installed = false;
  sender = () => undefined;
}
