pub mod bootstrap;
pub mod cache;
pub mod compat;
pub mod dsp;
pub mod library;
pub mod lyrics;
pub mod netease;
pub mod playback;
pub mod queue;
pub mod settings;
pub mod telemetry;
pub mod updater;
pub mod weather;
pub mod window;

use crate::error::{AppError, CommandResult};

pub(crate) fn command<T>(result: Result<T, AppError>) -> CommandResult<T> {
    result.map_err(Into::into)
}
