# Stage 12：D30 album-fill worker

状态：已完成

## 当前基础与目标

engine 已有 durable item/coordinator、claim/yield、complete/fail/resume；普通 cache downloader 已实现官方 URL、大小限制、hash、CAS 和 DB 写入，但两端未连接。本切片实现单并发 album-fill worker 和完整下载生命周期。

非目标：前端直接调度后台任务、绕过网易云权益、下载/导出可见音乐文件。

## 前置门禁

依赖 Stage 01 和 11。必须满足 60 秒播放空闲、30 秒网络空闲、窗口隐藏 2 分钟、每 30 秒复查、AC、非计费网络、磁盘保留；未知探针 fail closed。AccountEntitled 仍需同账号实时权益，不能离线执行。

## 预计修改与任务

修改 cache runtime、album coordinator/repository、Tauri downloader adapters、网易云官方 URL bridge、生命周期和测试。

1. 将 claimed item 转成受控下载请求，不复刻 downloader。
2. 实现单并发、取消/yield、断点状态和退避重试。
3. 在每个门禁变化和周期点重新评估 eligibility。
4. 成功后原子提交 CAS/DB/item；失败保留可恢复状态。
5. 防止账号切换、权益过期、曲目不可用和 URL 过期继续下载。

## 测试与验收

覆盖 eligibility 全组合、账号切换、权益失败、URL 过期、hash/大小错误、取消、进程重启恢复、重复 item、磁盘不足、quota 竞争和单并发。使用受控服务器/fixture，不在单测访问真实服务。

不得宣称 VIP 离线播放；缓存文件仍不可导出。

## 完成后同步

更新 D24/D30 状态、handover、验收矩阵和本文件。
