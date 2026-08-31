pub mod bootstrap;
pub mod cache;
pub mod compat;
pub mod library;
pub mod lyrics;
pub mod netease;
pub mod playback;
pub mod queue;
pub mod settings;
pub mod updater;
pub mod window;

use crate::error::{AppError, CommandResult};

pub(crate) fn command<T>(result: Result<T, AppError>) -> CommandResult<T> {
    result.map_err(Into::into)
}
