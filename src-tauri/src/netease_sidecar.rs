//! 网易云协议 sidecar 托管（D36，2026-09-05）。
//!
//! 完整版把 node.exe（externalBin `binaries/node`）与协议资源（`netease-sidecar/`
//! 下的 server 脚本 + vendored 包 + node_modules）打进安装包；应用启动时拉起
//! `node netease-sidecar.mjs`（端口 14321），退出时清理。
//!
//! 边界：本模块只做进程生命周期管理（系统集成），零协议知识——脚本路径、
//! 端口、清理时机之外不了解网易云任何语义。开发期（`tauri dev`）前端由
//! `scripts/dev.mjs` 编排独立 sidecar，本模块检测 dev 环境跳过（避免双实例）。
//!
//! 稳定性：node 输出落盘 sidecar-out/err.log（崩溃可诊断）；`CREATE_NO_WINDOW`
//! 抑制控制台闪窗；看门狗线程检测子进程退出后自动重拉（网易卐间歇失联自愈），
//! 连续失败超过阈值停止并告警。

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};

use crate::app_log;

/// Windows：CREATE_NO_WINDOW——后台 node.exe 不得闪控制台窗口（用户实测 CMD 闪窗）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 看门狗连续重拉上限：超过视为环境性问题（端口占用/脚本损坏），停止自愈。
const MAX_RESPAWN: u32 = 5;

/// sidecar 运行根：exe 自身所在目录（裸 release = target/release；安装版 =
/// 安装目录）。externalBin 的 node.exe 与 resources 的 sidecar-dist/ 都在 exe 旁，
/// 用 current_exe 定位比 resource_dir 更直接（resource_dir 在无 bundle 上下文的
/// 裸跑形态会退化为盘符根，导致脚本定位失败——实测 EISDIR 'E:'）。
fn sidecar_root() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf().into();
    Some(dir)
}

/// sidecar 脚本定位：安装包形态 resources 物化为 `<exe 目录>/netease-sidecar/`，
/// 裸 release 为 `<exe 目录>/sidecar-dist/`。
fn sidecar_script() -> Option<std::path::PathBuf> {
    let dir = sidecar_root()?;
    for layout in ["netease-sidecar/netease-sidecar.mjs", "sidecar-dist/netease-sidecar.mjs"] {
        let script = dir.join(layout);
        if script.exists() {
            return Some(script);
        }
    }
    None
}

/// node.exe 定位：externalBin 与 main exe 同目录。
fn node_path() -> std::path::PathBuf {
    sidecar_root()
        .map(|dir| dir.join("node.exe"))
        .filter(|path| path.exists())
        .unwrap_or_else(|| std::path::PathBuf::from("node.exe"))
}

/// node 输出落盘（exe 旁 log/）：sidecar 崩溃原因可诊断——之前 Stdio::null
/// 掩盖了「脚本路径解析失败即退」的问题。
fn spawn_sidecar() -> Option<Child> {
    let script = sidecar_script()?;
    let log_dir = sidecar_root().unwrap_or_else(|| std::path::PathBuf::from(".")).join("log");
    let _ = std::fs::create_dir_all(&log_dir);
    let out = std::fs::OpenOptions::new().create(true).append(true).open(log_dir.join("sidecar-out.log")).ok();
    let err = std::fs::OpenOptions::new().create(true).append(true).open(log_dir.join("sidecar-err.log")).ok();

    let mut command = Command::new(node_path());
    command
        .arg(&script)
        .env("HYPERPLAYER_NETEASE_PORT", "14321")
        // pidfile：sidecar 启动成功后写自身 PID；壳（重拉/新实例）按它接管孤儿
        .env("HYPERPLAYER_SIDECAR_PIDFILE", log_dir.join("sidecar.pid"))
        .stdin(Stdio::null());
    match (out, err) {
        (Some(out), Some(err)) => {
            command.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        _ => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().ok()
}

/// 接管孤儿：读 pidfile，若该 node 进程仍存活则强杀（实例崩溃未走清理时，
/// 孤儿占着 14321，新实例的 sidecar 会 EADDRINUSE 反复崩溃——用户实测
/// 「间歇性什么都没有」的根因）。
fn kill_orphan(log_dir: &std::path::Path) {
    let pid_file = log_dir.join("sidecar.pid");
    let Ok(pid) = std::fs::read_to_string(&pid_file).map(|s| s.trim().to_string()) else { return };
    if pid.is_empty() { return; }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        app_log::warn(&format!("netease sidecar 孤儿进程 {pid} 已接管清理"));
    }
    let _ = std::fs::remove_file(&pid_file);
}

pub fn spawn(app: &AppHandle) {
    // dev（tauri dev）下资源目录不含 sidecar——由 scripts/dev.mjs 编排器管理，
    // 壳跳过拉起避免双实例；完整版两种布局（安装包 netease-sidecar/ 或裸
    // release 的 sidecar-dist/）都能定位脚本。
    if sidecar_script().is_none() {
        app_log::info("netease sidecar 由开发编排器管理，壳跳过拉起");
        return;
    }
    let log_dir = sidecar_root().unwrap_or_else(|| std::path::PathBuf::from(".")).join("log");
    kill_orphan(&log_dir);
    if spawn_sidecar().is_some() {
        app_log::info("netease sidecar 已启动（端口 14321）");
        app.manage(SidecarChild(std::sync::Mutex::new(None)));
    } else {
        app_log::error("netease sidecar 启动失败（详见 log/sidecar-err.log）");
        return;
    }

    // 看门狗：子进程退出即重拉（网易云间歇失联自愈）；句柄经 AppState 换新。
    let handle = app.clone();
    let respawns = AtomicU32::new(0);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        let Some(state) = handle.try_state::<SidecarChild>() else { return };
        let Ok(mut guard) = state.0.lock() else { return };
        let exited = match guard.as_mut() {
            Some(proc) => proc.try_wait().map(|status| status.is_some()).unwrap_or(false),
            None => false, // 已停止自愈或异常态：不再重拉
        };
        if !exited { continue; }
        let count = respawns.fetch_add(1, Ordering::Relaxed) + 1;
        if count > MAX_RESPAWN {
            app_log::error("netease sidecar 连续退出超过上限，停止自愈（见 log/sidecar-err.log）");
            *guard = None;
            continue;
        }
        app_log::warn(&format!("netease sidecar 退出，看门狗第 {count} 次重拉"));
        *guard = spawn_sidecar();
        if guard.is_some() {
            app_log::info("netease sidecar 重拉完成");
        }
    });
}

/// 进程句柄随 AppState 托管；应用退出（RunEvent::Exit）时由 `cleanup` kill。
struct SidecarChild(std::sync::Mutex<Option<Child>>);

pub fn cleanup(app: &AppHandle) {
    if let Some(child) = app.try_state::<SidecarChild>() {
        if let Ok(mut guard) = child.0.lock() {
            if let Some(mut proc) = guard.take() {
                let _ = proc.kill();
                app_log::info("netease sidecar 已随应用退出清理");
            }
        }
    }
}

/// 在 tauri 事件循环上挂退出钩子（lib.rs 的 `.build().run()` 形态配合）。
pub fn on_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::Exit = event {
        cleanup(app);
    }
}
