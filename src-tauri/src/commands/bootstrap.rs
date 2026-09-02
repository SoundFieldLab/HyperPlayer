use crate::{
    dto::{AppInfoDto, BootstrapDto, DspAvailabilityDto},
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
            engine: state.services.playback.engine_snapshot()?,
            settings: state.services.settings.get()?,
            netease: state.services.netease.status()?,
            dsp: dsp_availability_value(),
        })
    })())
}

#[tauri::command]
pub fn dsp_availability() -> CommandResult<DspAvailabilityDto> {
    Ok(dsp_availability_value())
}

pub(super) fn dsp_availability_value() -> DspAvailabilityDto {
    DspAvailabilityDto {
        available: true,
        reason: "Rust DSP runtime and six configuration commands are available through DspPort"
            .into(),
    }
}
