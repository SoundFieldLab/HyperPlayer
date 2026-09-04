//! WebView console 日志上报：前端抓取 console 后经此 command 落盘
//! （与后端日志同文件，source 前缀区分来源）。

use crate::app_log::{self, LogLevel};
use crate::error::{AppError, CommandResult};
use serde::Deserialize;
use tauri::State;

use crate::ports::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLogRequestDto {
    pub level: String,
    pub message: String,
}

/// 接收前端 console 上报。**限频**：前端已按条聚合，此处再做防御——单条
/// 消息截断到 4 KiB，超长错误栈截断（防日志爆炸）。失败静默（打点不阻塞 UI）。
#[tauri::command]
pub async fn log_web(_state: State<'_, AppState>, request: WebLogRequestDto) -> CommandResult<()> {
    let level = match request.level.as_str() {
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };
    let message: String = request.message.chars().take(4_096).collect();
    app_log::web(level, &message);
    Ok(())
}

// 占位避免 clippy 未使用告警（AppError 仅用于类型路径统一）。
#[allow(dead_code)]
fn _assert_error_type_in_scope(_: AppError) {}
