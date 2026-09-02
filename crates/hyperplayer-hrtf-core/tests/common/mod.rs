//! 本 crate 集成测试共用的合成 SOFA fixture 入口。
//!
//! 实现已上移到 feature `test-fixtures` 门控的 [`hrtf_core::fixtures`]
//! （供 engine/Tauri 适配器测试复用，避免跨 crate 复制 HDF5 生成逻辑）；
//! 这里只做再导出，保持既有测试写法不变。

pub use hrtf_core::fixtures::{synthetic_hrir_sofa, temp_dir, write_synthetic_sofa};
