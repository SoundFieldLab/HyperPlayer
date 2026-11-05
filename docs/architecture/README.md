# 架构与运维细节

`AGENTS.md` 只保留每轮都要用到的规则与导航指针；本目录存放**按需读取**的细节。改动对应区域前先读对应文档，不要凭记忆恢复已删除的功能。

| 何时读 | 文档 |
|---|---|
| 改设置读写 / 账号会话 / 插件启停 / IPC 注册 / 过渡设置 / 歌词模式 | [`modules.md`](./modules.md) |
| 动 HSE 引擎、DSP、Worklet、调音室 UI | [`hse.md`](./hse.md) |
| 动 Electron 主进程、启动页、窗口、安装器美术 | [`desktop-and-startup.md`](./desktop-and-startup.md) |
| 改打包白名单、依赖分区、发布流程、更新清单、版本号 | [`packaging-and-release.md`](./packaging-and-release.md) |
| 改 `local-server.mjs`、鉴权、SSRF、cookie、配置隔离 | [`backend-security.md`](./backend-security.md) |
| 选择下一个架构候选 / 核对候选编号 | [`backlog.md`](./backlog.md) |

## 约定

- 这些文档是 `AGENTS.md` 的**披露层**：触发条件写在 `AGENTS.md` 的指针里，细节留在这里。
- 移动内容时保持**单一事实源**：同一规则只放在一处，另一处用指针。
- 文档与源码冲突时以源码为准，并顺手修正文档。
