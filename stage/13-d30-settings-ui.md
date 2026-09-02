# Stage 13：D30 Settings UI

状态：已完成

## 当前基础与目标

Settings 已显示 cache bytes/entries/tasks 并支持 clear；`SettingsDto` 没有容量和 album-fill 策略。本切片接通 typed policy、原子持久化、runtime 状态和正式设置界面。

非目标：让 UI 成为调度权威，或暴露缓存文件路径/导出能力。

## 前置门禁

依赖 Stage 10-12 的 runtime/state 稳定；容量限制 2-100 GiB，默认 10 GiB；所有更改后端校验，前端不能绕过。

## 预计修改与任务

修改 Tauri settings DTO/storage/commands、cache runtime state、TS API/store、`SettingsView.tsx`、UI 组件和测试。

1. 定义版本化 cache policy DTO 和原子迁移。
2. 接容量、清理目标、album-fill 开关/质量等已定调项。
3. 显示运行状态、占用、任务、暂停/失败原因和资源门禁。
4. 危险 clear 操作保留确认和 lease/播放保护。
5. 确保键盘、屏幕阅读器、明暗主题和最小窗口布局。

## 测试与验收

覆盖 DTO 校验、持久化迁移、非法值、runtime 热更新、clear 确认、loading/error/empty 状态和 Tauri 正式窗口多尺寸验收。

完成 Stage 10-13 且真实运行验证后，才可宣称 D30 runtime + UI 闭环。

## 完成后同步

更新 handover、验收矩阵、需求基线和本文件状态。
