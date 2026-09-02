# Stage 11：D30 Windows 资源探针

状态：已完成

## 当前基础与目标

当前 Windows 平台模块有回收站、SMTC、文件关联基础，没有 AC/电源、计费网络和磁盘保留量探针。本切片提供 typed、可测试的资源快照，供 album-fill 等低优先级任务 fail closed 使用。

非目标：直接执行 album-fill、改变普通用户主动播放/缓存请求。

## 前置门禁

新增 Windows API feature/dependency 必须通过 Apache-2.0 兼容与最小 capability 复审；未知、错误或权限不足统一 fail closed。

## 预计修改与任务

修改 `src-tauri/src/platform/windows`、Cargo features、`cache_runtime.rs`/ports、typed DTO/内部状态和测试。

1. 定义 `PowerState`、`NetworkCostState`、`DiskReserveState` 和采样时间。
2. 接 Windows 电源/AC API，明确桌面机、UPS、电池和 unknown。
3. 接网络成本 API，区分 unmetered/metered/unknown。
4. 查询目标 cache volume 可用空间并执行保留量判断。
5. 加入节流采样、变更唤醒或合理轮询，不阻塞 UI/播放线程。

## 测试与验收

使用 trait/fake 覆盖所有状态组合、API 错误、cache volume 变化和 stale snapshot；在 Windows 实机验证 AC/拔电、计费网络可用场景和磁盘阈值。未知状态必须阻止 album-fill eligibility。

## 完成后同步

记录实际使用的 Windows API/feature，更新 handover、验收矩阵和许可证清单。
