use crate::{
    dto::{
        CloseBehaviorDto, CloseDecisionDto, CloseDecisionRequestDto, CloseWindowRequestDto,
        ShowWindowRequestDto, WindowFlagRequestDto, WindowKindDto,
    },
    error::{AppError, CommandResult},
    ports::AppState,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

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
        WindowKindDto::MiniPlayer => Some(AuxiliaryWindowSpec {
            label: "mini-player",
            title: "HyperPlayer Mini",
            route: "index.html?window=mini-player",
            width: 300.0,
            height: 340.0,
            transparent: false,
            always_on_top: true,
        }),
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

#[tauri::command]
pub fn window_show(app: AppHandle, request: ShowWindowRequestDto) -> CommandResult<()> {
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
        WebviewWindowBuilder::new(&app, spec.label, WebviewUrl::App(spec.route.into()))
            .title(spec.title)
            .inner_size(spec.width, spec.height)
            .decorations(false)
            .transparent(spec.transparent)
            .always_on_top(spec.always_on_top)
            .skip_taskbar(true)
            .resizable(true)
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
        WindowKindDto::MiniPlayer => "mini-player",
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
        let mini = auxiliary_window_spec(WindowKindDto::MiniPlayer).unwrap();
        let lyrics = auxiliary_window_spec(WindowKindDto::DesktopLyrics).unwrap();
        assert_ne!(mini.label, lyrics.label);
        assert_ne!(mini.route, lyrics.route);
        assert!(!mini.transparent);
        assert!(lyrics.transparent);
        assert!(mini.always_on_top && lyrics.always_on_top);
        assert!(auxiliary_window_spec(WindowKindDto::Main).is_none());
    }

    #[test]
    fn labels_match_frontend_window_contract() {
        assert_eq!(window_label(WindowKindDto::Main), "main");
        assert_eq!(window_label(WindowKindDto::MiniPlayer), "mini-player");
        assert_eq!(window_label(WindowKindDto::DesktopLyrics), "desktop-lyrics");
    }
}
