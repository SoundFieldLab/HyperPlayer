# Stage 16：网易云产品闭环

状态：待选择

## 当前基础与目标

TS Cleanroom oracle 已覆盖 94 路由/115 函数；Rust 已有会话、部分 bridge、官方 URL 和受控缓存基础。剩余 Rust 网络/加密迁移、UI/MV、写操作与真实账号权益验收尚未完成。本切片在模块隔离前提下完成官方网易云产品能力。

非目标：Node sidecar、Unblock、灰歌替代源、跨平台匹配、伪造会员、音频下载/导出。

## 前置门禁

严格遵守 `docs/音源-网易云-行为规范.md`；参考代码只用于提炼规范，永不复制入实现；Cookie/设备会话/协议密钥不进入前端；模块可整体禁用。

## 预计修改与任务

修改独立网易云 Rust workspace/adapter、Tauri commands/events/capabilities、账号与内容 UI、缓存权益桥、MV 播放边界和测试。

1. 盘点 oracle 与 Rust endpoint 差距，按行为规范迁移。
2. 完成登录、会话刷新、账号切换和 DPAPI 生命周期。
3. 接搜索、首页、歌单/专辑/艺人、收藏/写操作和错误语义。
4. 接官方播放 URL、Public/AccountEntitled 缓存授权和 fail closed。
5. 实现 MV 的受控播放，不提供下载。
6. 普通/VIP/过期/风控账号按受控矩阵验收。

## 测试与验收

Rust contract/fixture、oracle parity、敏感信息日志审计、账号切换、权益过期、网络失败、限流/风控、模块禁用和 UI 状态。真实账号测试凭据不入库、不写日志。

只有普通/VIP/过期三类关键路径实测后，才能声明对应账号能力完成。

## 完成后同步

更新行为规范、handover、验收矩阵和账号验收记录（不含敏感数据）。
