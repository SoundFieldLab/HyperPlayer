# Stage 15：Windows 音频与壳集成

状态：待选择

## 当前基础与目标

Tauri/Windows 壳和基础 CPAL 输出已存在，设备枚举/切换/recovery/exclusive、完整 SMTC/媒体键及文件关联仍需产品验收。本切片完成 Windows 用户可见的音频与系统集成。

非目标：把系统集成逻辑放入 React，或因设备故障绕过 Rust 播放状态机。

## 前置门禁

播放/队列权威留在 engine；系统事件通过 typed port 进入；设备切换必须与 Stage 14 preparation/latency 语义兼容；exclusive 仅在可靠支持时暴露。

## 预计修改与任务

修改 engine output/device abstraction、Tauri Windows platform、SMTC/events/commands、Settings/output UI、capabilities 和测试。

1. 枚举设备、默认设备变化和 stable identity。
2. 实现显式切换、断开 recovery、格式协商和失败回退。
3. 评估并实现 exclusive mode，准确显示支持状态。
4. 完成 SMTC metadata/state/position、媒体键和系统音量语义。
5. 完成文件关联、单实例打开、路径安全和启动路由。

## 测试与验收

覆盖 fake backend 状态机；实机验证多设备、拔插、蓝牙、休眠恢复、默认设备变化、媒体键、SMTC、DPI/Snap 和文件双击。记录硬件/驱动矩阵。

不得以单台设备通过宣称所有 WASAPI/exclusive 环境可靠。

## 完成后同步

更新 handover、验收矩阵、Windows 能力说明和已测设备矩阵。
