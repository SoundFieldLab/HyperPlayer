use crate::{
    dto::{
        CloseBehaviorDto, CloseDecisionDto, CloseDecisionRequestDto, CloseWindowRequestDto,
        ShowWindowRequestDto, WindowFlagRequestDto, WindowKindDto,
    },
    error::{AppError, CommandResult},
    ports::AppState,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri::utils::config::WindowConfig;

/// 辅助窗口必须与主窗口使用同一组 WebView2 browser args：同一用户数据目录下的
/// WebView 共享一个浏览器进程，若后续窗口的 additional browser arguments 与已运行
/// 进程不一致，WebView2 环境创建会以 ERROR_INVALID_STATE 失败——原生窗口外壳照常
/// 创建，但 webview 永远挂不上去，表现为辅助窗口纯白、无 UI、无法交互（用户实测
/// 迷你播放器白屏的根因）。tauri.conf.json 中 main 窗口的 additionalBrowserArgs
/// 会整体替换 wry 默认参数，因此辅助窗口直接镜像该值。
fn auxiliary_browser_args<'a>(windows: &'a [WindowConfig]) -> Option<&'a str> {
    windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.as_deref())
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct AuxiliaryWindowSpec {
    label: &'static str,
    title: &'static str,
    route: &'static str,
    width: f64,
    height: f64,
    transparent: bool,
    always_on_top: bool,
}

fn auxiliary_window_spec(kind: WindowKindDto) -> Option<AuxiliaryWindowSpec> {
    match kind {
        WindowKindDto::Main => None,
        WindowKindDto::DesktopLyrics => Some(AuxiliaryWindowSpec {
            label: "desktop-lyrics",
            title: "HyperPlayer Lyrics",
            route: "index.html?window=desktop-lyrics",
            width: 900.0,
            height: 150.0,
            transparent: true,
            always_on_top: true,
        }),
    }
}

// async command：创建新 WebView 必须派发到主线程并等待结果；同步 command 本身
// 占着主线程 → build() 等主线程、主线程等本命令 → 死锁（实测桌面歌词/迷你播放器
// 点击后 invoke 永不返回、窗口壳都建不出来）。async 让命令跑在 worker 线程。
#[tauri::command]
pub async fn window_show(app: AppHandle, request: ShowWindowRequestDto) -> CommandResult<()> {
    if request.kind == WindowKindDto::Main {
        let window = app.get_webview_window("main").ok_or_else(|| {
            crate::error::ErrorDto::from(AppError::Window("main window is missing".into()))
        })?;
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| crate::error::ErrorDto::from(AppError::Window(error.to_string())))?;
        return Ok(());
    }

    let spec = auxiliary_window_spec(request.kind).expect("auxiliary window kind");
    if let Some(window) = app.get_webview_window(spec.label) {
        window
            .show()
            .and_then(|_| window.set_always_on_top(spec.always_on_top))
            .and_then(|_| window.set_focus())
            .map_err(|error| AppError::Window(error.to_string()).into())
    } else {
        // WebView2 共享浏览器进程的参数一致性要求（见 auxiliary_browser_args 注释）：
        // 辅助窗口镜像 tauri.conf.json 中 main 窗口声明的 additionalBrowserArgs。
        let mut builder = WebviewWindowBuilder::new(&app, spec.label, WebviewUrl::App(spec.route.into()))
            .title(spec.title)
            .inner_size(spec.width, spec.height)
            .decorations(false)
            .transparent(spec.transparent)
            .always_on_top(spec.always_on_top)
            .skip_taskbar(true)
            .resizable(true);
        if let Some(args) = auxiliary_browser_args(&app.config().app.windows) {
            builder = builder.additional_browser_args(args);
        }
        builder
            .build()
            .map(|_| ())
            .map_err(|error| AppError::Window(error.to_string()).into())
    }
}

#[tauri::command]
pub fn window_close(app: AppHandle, request: CloseWindowRequestDto) -> CommandResult<()> {
    if request.kind == WindowKindDto::Main {
        return Err(AppError::InvalidArgument(
            "main window close must use window_resolve_close".into(),
        )
        .into());
    }
    let label = window_label(request.kind);
    app.get_webview_window(label)
        .ok_or_else(|| {
            crate::error::ErrorDto::from(AppError::Window(format!("{label} window is missing")))
        })?
        .close()
        .map_err(|error| AppError::Window(error.to_string()).into())
}

#[tauri::command]
pub fn window_hide(app: AppHandle, request: CloseWindowRequestDto) -> CommandResult<()> {
    let label = window_label(request.kind);
    app.get_webview_window(label)
        .ok_or_else(|| {
            crate::error::ErrorDto::from(AppError::Window(format!("{label} window is missing")))
        })?
        .hide()
        .map_err(|error| AppError::Window(error.to_string()).into())
}

#[tauri::command]
pub fn window_set_always_on_top(
    app: AppHandle,
    request: WindowFlagRequestDto,
) -> CommandResult<()> {
    let label = window_label(request.kind);
    app.get_webview_window(label)
        .ok_or_else(|| {
            crate::error::ErrorDto::from(AppError::Window(format!("{label} window is missing")))
        })?
        .set_always_on_top(request.enabled)
        .map_err(|error| AppError::Window(error.to_string()).into())
}

#[tauri::command]
pub fn desktop_lyrics_set_click_through(
    app: AppHandle,
    request: WindowFlagRequestDto,
) -> CommandResult<()> {
    if request.kind != WindowKindDto::DesktopLyrics {
        return Err(AppError::InvalidArgument(
            "click-through is restricted to the desktop lyrics window".into(),
        )
        .into());
    }
    app.get_webview_window("desktop-lyrics")
        .ok_or_else(|| {
            crate::error::ErrorDto::from(AppError::Window(
                "desktop-lyrics window is missing".into(),
            ))
        })?
        .set_ignore_cursor_events(request.enabled)
        .map_err(|error| AppError::Window(error.to_string()).into())
}

fn window_label(kind: WindowKindDto) -> &'static str {
    match kind {
        WindowKindDto::Main => "main",
        WindowKindDto::DesktopLyrics => "desktop-lyrics",
    }
}

#[tauri::command]
pub fn window_resolve_close(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CloseDecisionRequestDto,
) -> CommandResult<()> {
    if request.remember {
        let close_behavior = match request.action {
            CloseDecisionDto::Cancel => CloseBehaviorDto::Ask,
            CloseDecisionDto::MinimizeToTray => CloseBehaviorDto::MinimizeToTray,
            CloseDecisionDto::Exit => CloseBehaviorDto::Exit,
        };
        super::command(
            state
                .services
                .settings
                .update(crate::dto::UpdateSettingsRequestDto {
                    close_behavior: Some(close_behavior),
                    ..Default::default()
                }),
        )?;
    }

    match request.action {
        CloseDecisionDto::Cancel => Ok(()),
        CloseDecisionDto::MinimizeToTray => app
            .get_webview_window("main")
            .ok_or_else(|| {
                crate::error::ErrorDto::from(AppError::Window("main window is missing".into()))
            })?
            .hide()
            .map_err(|error| AppError::Window(error.to_string()).into()),
        CloseDecisionDto::Exit => {
            *state
                .exit_requested
                .lock()
                .map_err(|_| crate::error::ErrorDto::from(AppError::StateUnavailable))? = true;
            app.exit(0);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auxiliary_windows_have_distinct_routes_and_expected_defaults() {
        let lyrics = auxiliary_window_spec(WindowKindDto::DesktopLyrics).unwrap();
        assert_eq!(lyrics.label, "desktop-lyrics");
        assert!(lyrics.transparent && lyrics.always_on_top);
        assert!(auxiliary_window_spec(WindowKindDto::Main).is_none());
    }

    #[test]
    fn labels_match_frontend_window_contract() {
        assert_eq!(window_label(WindowKindDto::Main), "main");
        assert_eq!(window_label(WindowKindDto::DesktopLyrics), "desktop-lyrics");
    }

    #[test]
    fn auxiliary_windows_mirror_main_webview2_browser_args() {
        // 双路径交叉校验：raw JSON 直读 main 窗口的 additionalBrowserArgs，与 typed
        // Config 经 auxiliary_browser_args 镜像的结果必须一致——防止 tauri-utils
        // 字段重命名或配置结构变化后镜像静默失效（那会再次触发 WebView2 共享浏览器
        // 进程参数不一致 → 辅助窗口 ERROR_INVALID_STATE 纯白屏）。
        let raw: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("解析 tauri.conf.json");
        let declared = raw["app"]["windows"]
            .as_array()
            .and_then(|windows| windows.iter().find(|window| window["label"] == "main"))
            .and_then(|window| window["additionalBrowserArgs"].as_str());
        let config: tauri::utils::config::Config =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("解析 Config");
        assert_eq!(
            auxiliary_browser_args(&config.app.windows),
            declared,
            "辅助窗口必须镜像 main 窗口的 additionalBrowserArgs（WebView2 参数一致性，否则辅助窗口白屏）"
        );
    }

    #[test]
    fn auxiliary_browser_args_fall_back_to_wry_default_without_main_config() {
        // main 未声明 additionalBrowserArgs（或配置里没有 main）时返回 None：辅助窗口
        // 沿用 wry 默认参数，与最先创建的 main 窗口（同样走默认）保持参数一致。
        let mut main = WindowConfig::default();
        main.label = "main".into();
        assert_eq!(auxiliary_browser_args(&[main.clone()]), None);
        main.additional_browser_args = Some("--example".into());
        assert_eq!(auxiliary_browser_args(&[main]), Some("--example"));
        assert_eq!(auxiliary_browser_args(&[WindowConfig::default()]), None);
    }
}
