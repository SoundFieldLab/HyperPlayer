use crate::{
    dto::{AppInfoDto, BootstrapDto},
    error::CommandResult,
    ports::AppState,
};
use tauri::State;

#[tauri::command]
pub fn bootstrap(state: State<'_, AppState>) -> CommandResult<BootstrapDto> {
    super::command((|| {
        Ok(BootstrapDto {
            app: AppInfoDto {
                app_name: "HyperPlayer".into(),
                app_version: env!("CARGO_PKG_VERSION").into(),
                platform: "windows".into(),
                initialized: true,
            },
            settings: state.services.settings.get()?,
        })
    })())
}
