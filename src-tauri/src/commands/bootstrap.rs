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
            playback: state.services.playback.state()?,
            queue: state.services.queue.snapshot()?,
            settings: state.services.settings.get()?,
            netease: state.services.netease.status()?,
            dsp: dsp_availability_value(),
        })
    })())
}

#[tauri::command]
pub fn dsp_availability() -> CommandResult<DspAvailabilityDto> {
    super::command(Err(crate::error::AppError::Unavailable(
        "DSP specification D16 is pending; the processing path remains bypassed".into(),
    )))
}

fn dsp_availability_value() -> DspAvailabilityDto {
    DspAvailabilityDto {
        available: false,
        reason: "DSP specification D16 is pending; the processing path remains bypassed".into(),
    }
}
