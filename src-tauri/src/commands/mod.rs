pub mod bootstrap;
pub mod cache;
pub mod compat;
pub mod dsp;
pub mod library;
pub mod logging;
pub mod lyrics;
pub mod netease;
pub mod playback;
pub mod queue;
pub mod settings;
pub mod telemetry;
pub mod updater;
pub mod weather;
pub mod window;

use crate::app_log;
use crate::error::{AppError, CommandResult};

/// 统一 command 结果包装：错误自动落日志（命令名 + 错误码与消息），
/// 便于实机排查「点播放没反应」类问题（前端 toast 只显示一层消息）。
pub(crate) fn command<T>(result: Result<T, AppError>) -> CommandResult<T> {
    if let Err(error) = &result {
        app_log::error(format!("command failed: {error:?}"));
    }
    result.map_err(Into::into)
}
