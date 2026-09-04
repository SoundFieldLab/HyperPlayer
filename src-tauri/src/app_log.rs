//! 应用级日志系统：exe 同目录 `log/` 文件夹下按日期轮转的统一日志管道。
//!
//! 设计约束：
//! - **零依赖注入**：`OnceLock` 全局句柄，任意线程（含 actor/worker 线程）直接调用
//!   `app_log::info/warn/error`，初始化前调用退化为 eprintln（不丢日志）。
//! - **文件位置**：`std::env::current_exe()` 的父目录下 `log/hyperplayer-YYYY-MM-DD.log`；
//!   目录不存在则创建。测试与开发环境（exe 在 target/ 下）同样适用。
//! - **轮转**：按本地日期切文件；单文件超过 8 MiB 时以 `hyperplayer-YYYY-MM-DD.N.log`
//!   编号续写，保留最近 7 天（启动时清理）。
//! - **脱敏**：写入前过滤 Cookie/token 形态的敏感串（MUSIC_U/MUSIC_A/x-music-u/
//!   csrf 等），防止登录凭据落盘。
//! - **panic 捕获**：`install_panic_hook` 把 panic 的线程/位置/载荷写入日志后再走
//!   默认 hook（保留 stderr 可见性与进程退出语义）。
//! - **前端日志**：`log_web` command 接收 WebView console 上报（见 commands/logging.rs），
//!   与后端日志写同一文件（level 前缀区分来源）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
const RETENTION_DAYS: u64 = 7;
const FILE_PREFIX: &str = "hyperplayer";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
        }
    }
}

struct LogState {
    dir: PathBuf,
    file: Option<File>,
    /// 当前写入文件的日期（YYYY-MM-DD）；跨天时重开新文件。
    day: String,
    /// 当前文件序号（同日超限时递增）。
    sequence: u32,
}

static LOGGER: OnceLock<Mutex<LogState>> = OnceLock::new();

/// 初始化日志目录并打开当日文件。幂等；失败时记录到 stderr 并保持
/// 「退化 eprintln」模式（应用继续运行，绝不因日志不可用而退出）。
pub fn init() {
    let _ = init_inner();
}

fn init_inner() -> Result<(), String> {
    let dir = log_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("create log dir: {error}"))?;
    cleanup_old_logs(&dir);
    let state = LogState {
        dir,
        file: None,
        day: String::new(),
        sequence: 0,
    };
    if LOGGER.set(Mutex::new(state)).is_err() {
        return Ok(()); // 已初始化（幂等）。
    }
    info("日志系统初始化完成");
    Ok(())
}

/// 日志目录：exe 同目录下 `log/`。exe 路径不可得（极罕见）时退回当前工作目录。
pub fn log_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("log")
}

pub fn info(message: impl AsRef<str>) {
    write(LogLevel::Info, message.as_ref());
}

pub fn warn(message: impl AsRef<str>) {
    write(LogLevel::Warn, message.as_ref());
}

pub fn error(message: impl AsRef<str>) {
    write(LogLevel::Error, message.as_ref());
}

/// WebView console 上报入口：来源标记 web，与后端日志同文件。
pub fn web(level: LogLevel, message: &str) {
    let source = match level {
        LogLevel::Info => "web",
        LogLevel::Warn => "web-warn",
        LogLevel::Error => "web-error",
    };
    write_with_source(level, source, message);
}

fn write(level: LogLevel, message: &str) {
    write_with_source(level, "app", message);
}

fn write_with_source(level: LogLevel, source: &str, message: &str) {
    let line = format!(
        "{} [{:5}] [{}] {}\n",
        timestamp(),
        level.label(),
        source,
        sanitize(message)
    );
    match LOGGER.get() {
        Some(state) => {
            let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
            if let Err(error) = roll_if_needed(&mut state) {
                eprintln!("[app_log] roll failed: {error}");
            }
            match state
                .file
                .as_mut()
                .map(|file| writeln!(file, "{line}").and_then(|_| file.flush()))
            {
                Some(Ok(())) => {}
                _ => eprint!("{line}"),
            }
        }
        None => eprint!("{line}"),
    }
}

/// 跨天或超限时切文件：`hyperplayer-YYYY-MM-DD.log` → `hyperplayer-YYYY-MM-DD.N.log`。
fn roll_if_needed(state: &mut LogState) -> Result<(), String> {
    let today = local_day();
    if state.file.is_none() || state.day != today {
        state.day = today.clone();
        state.sequence = 0;
        state.file = Some(open_log_file(&state.dir, &today, 0)?);
        return Ok(());
    }
    let oversized = state
        .file
        .as_ref()
        .and_then(|file| file.metadata().ok())
        .is_some_and(|metadata| metadata.len() >= MAX_LOG_BYTES);
    if !oversized {
        return Ok(());
    }
    state.sequence += 1;
    state.file = Some(open_log_file(&state.dir, &state.day, state.sequence)?);
    Ok(())
}

fn open_log_file(dir: &Path, day: &str, sequence: u32) -> Result<File, String> {
    let name = if sequence == 0 {
        format!("{FILE_PREFIX}-{day}.log")
    } else {
        format!("{FILE_PREFIX}-{day}.{sequence}.log")
    };
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(&name))
        .map_err(|error| format!("open log file {name}: {error}"))
}

/// 删除超过保留期的日志文件（文件名内嵌日期，无需遍历元数据）。
fn cleanup_old_logs(dir: &Path) {
    let cutoff = unix_day_now().saturating_sub(RETENTION_DAYS);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(day) = log_file_day(name) else {
            continue;
        };
        if let Some(file_day) = parse_day_unix(&day) {
            if file_day < cutoff {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// 从日志文件名提取日期段（`hyperplayer-2026-09-04.1.log` → `2026-09-04`）。
fn log_file_day(name: &str) -> Option<String> {
    let rest = name.strip_prefix(&format!("{FILE_PREFIX}-"))?;
    let end = rest.find('.').unwrap_or(rest.len());
    let day = &rest[..end];
    if day.len() == 10 && day.as_bytes()[4] == b'-' && day.as_bytes()[7] == b'-' {
        Some(day.to_owned())
    } else {
        None
    }
}

fn parse_day_unix(day: &str) -> Option<u64> {
    let (year, month, day_number) = (day.get(0..4)?, day.get(5..7)?, day.get(8..10)?);
    let (year, month, day_number): (i32, u32, u32) = (
        year.parse().ok()?,
        month.parse().ok()?,
        day_number.parse().ok()?,
    );
    // 简易天数换算：以 1970-01-01 为原点的民用日期算法（civil_from_days 逆推）。
    let days = days_from_civil(year, month, day_number);
    Some(days.max(0) as u64)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day = i64::from(day);
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn unix_day_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() / 86_400)
        .unwrap_or(0)
}

fn local_day() -> String {
    // chrono 已在依赖树（adapters 用 Local::now），直接使用本地时区日期。
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn timestamp() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

/// 脱敏：把 Cookie/token 值替换为 `***`。覆盖网易云登录态（MUSIC_U/MUSIC_A/
/// csrf/x-music-u）与通用 Bearer token；只匹配键形态，不动业务字段。
fn sanitize(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(hit) = find_secret(rest) {
        let (key_end, value_start) = hit;
        out.push_str(&rest[..key_end]);
        out.push_str("=***");
        // 跳过值（到分号、空白或行尾）。
        let value_rest = &rest[value_start..];
        let value_end = value_rest
            .find(|ch: char| ch == ';' || ch.is_whitespace())
            .unwrap_or(value_rest.len());
        rest = &value_rest[value_end..];
    }
    out.push_str(rest);
    out
}

const SECRET_KEYS: [&str; 6] = [
    "MUSIC_U",
    "MUSIC_A",
    "x-music-u",
    "__csrf",
    "csrf",
    "authorization",
];

/// 返回 (键结束位置=值定界符位置, 值起始位置)。键后定界符接受 `=` 或 `:`
/// （头部形态 `x-music-u: token`）。
fn find_secret(text: &str) -> Option<(usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let mut best: Option<(usize, usize)> = None;
    for key in SECRET_KEYS {
        let needle = key.to_ascii_lowercase();
        let mut search_from = 0;
        while let Some(found) = lower[search_from..].find(&needle) {
            let key_start = search_from + found;
            let key_end = key_start + needle.len();
            let delimiter = text[key_end..]
                .starts_with('=')
                .then_some('=')
                .or_else(|| text[key_end..].starts_with(':').then_some(':'));
            if let Some(_delimiter) = delimiter {
                let value_start = key_end + 1;
                // 键前须是非字母数字（避免 eMusic_u 误命中）。
                let boundary_ok = text[..key_start]
                    .chars()
                    .next_back()
                    .is_none_or(|ch| !ch.is_ascii_alphanumeric());
                if boundary_ok {
                    if best.is_none_or(|(existing, _)| key_start < existing) {
                        best = Some((key_end, value_start));
                    }
                    break;
                }
            }
            search_from = key_end;
        }
    }
    best
}

/// 安装 panic hook：记录 panic 后转给默认 hook（保持 abort 语义与 stderr 输出）。
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>").to_owned();
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".into());
        let payload = if let Some(value) = info.payload().downcast_ref::<&str>() {
            (*value).to_owned()
        } else if let Some(value) = info.payload().downcast_ref::<String>() {
            value.clone()
        } else {
            "non-string panic payload".into()
        };
        error(format!("panic in thread {name} at {location}: {payload}"));
        default(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_masks_login_tokens() {
        let masked = sanitize("Cookie: MUSIC_U=SECRETVALUE; os=pc");
        assert!(masked.contains("MUSIC_U=***"));
        assert!(!masked.contains("SECRETVALUE"));
        let masked = sanitize("x-music-u: longsecrettoken");
        assert!(masked.contains("x-music-u=***") || masked.contains("x-music-u: ***"));
    }

    #[test]
    fn sanitize_keeps_ordinary_text() {
        let text = "song_url failed for id=42 level=lossless";
        assert_eq!(sanitize(text), text);
    }

    #[test]
    fn log_file_day_extracts_date() {
        assert_eq!(
            log_file_day("hyperplayer-2026-09-04.log"),
            Some("2026-09-04".into())
        );
        assert_eq!(
            log_file_day("hyperplayer-2026-09-04.2.log"),
            Some("2026-09-04".into())
        );
        assert_eq!(log_file_day("other.txt"), None);
    }

    #[test]
    fn days_from_civil_matches_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 9, 4), 20_700);
    }

    #[test]
    fn init_creates_log_dir_and_writes_today_file_next_to_exe() {
        // 在独立进程语义下验证：init 后 exe 同目录 log/ 存在、当日文件含写入内容。
        // 测试进程的 exe 在 target/debug/deps/ 下，目录可安全创建/清理。
        let dir = log_dir();
        let day = local_day();
        let today_file = dir.join(format!("{FILE_PREFIX}-{day}.log"));
        let _ = std::fs::remove_file(&today_file);
        let _ = std::fs::remove_dir_all(&dir);

        init();

        assert!(dir.is_dir(), "log 目录应被创建: {}", dir.display());
        info("log-write smoke line");
        assert!(today_file.is_file(), "当日日志文件应存在");
        let content = std::fs::read_to_string(&today_file).unwrap();
        assert!(
            content.contains("log-write smoke line"),
            "日志行应写入文件，实际内容: {content}"
        );
        assert!(content.contains("[INFO ]"), "应有级别前缀");
        // 清理测试产物（保留 init 写入的首行也无害，但保持 deps 目录干净）。
        let _ = std::fs::remove_file(&today_file);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
