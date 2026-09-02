# Stage 10：D30 quota runtime

状态：已完成

## 当前基础与目标

engine 已有 10 GiB 默认容量、清理至 90%、最近 100 首保护、lease/recent 保护和按 content hash 淘汰 planner；Tauri 没有周期执行器。本切片在 Stage 01 supervisor 上增加可配置、幂等的 quota tick 和实际删除/apply。

非目标：Windows 资源探针、album-fill 下载和 Settings UI。

## 前置门禁

依赖 Stage 01 的 executor、取消和状态快照；容量限制 2-100 GiB；所有删除仍受 CAS root 和 lease/recent 保护。

## 预计修改与任务

修改 `cache_runtime.rs`、engine cache policy/repository、Tauri settings storage/DTO（仅内部所需）和测试。

1. 定义启动后与周期 tick 触发策略，防止重入。
2. 读取 typed policy，生成 quota plan 并安全执行。
3. 删除至 target ratio，而非仅降到硬上限。
4. 暴露只读运行状态、最后结果和失败原因。
5. 处理容量变化、下载并发和取消。

## 测试与验收

覆盖上限边界、90% target、最近 100、active lease、相同 content hash、多次 tick、并发下载、IO 失败重跑和超大目录。验证不误删受保护内容。

不得据此宣称 Windows 条件门禁或 D30 UI 完成。

## 完成后同步

更新 handover、验收矩阵和本文件状态。
