# CI 与契约测试验收矩阵

更新时间：2026-08-31

> 最近一次本地验证：前端 16 项、engine 56 项、网易云 Rust 33 项、Tauri 49 项测试通过；IPC 清单 65 个 command / 12 个 event 匹配；`cargo deny` advisories/licenses 通过；`pnpm build` 成功生成 x64 NSIS 与 MSI。验证后已清除 `node_modules`、`dist` 和全部 Rust `target` 缓存，因此复验需先恢复依赖。

## 自动化门禁

| 范围 | 验收命令 / CI job | 当前门槛 | 通过标准 |
|---|---|---|---|
| 前端静态资产 | `pnpm install --frozen-lockfile`、`pnpm frontend:build` | 必须 | TypeScript project references 与 Vite production assets 均成功；该命令只供 Tauri 构建生命周期和 CI 使用，不是浏览器产品入口 |
| Tauri 桌面应用 | `pnpm build` | 必须 | 完整 Tauri 2 应用构建成功；开发、IPC、窗口、截图和交互验证均使用 `pnpm dev` 启动的真实 WebView2 窗口，不提供浏览器预览或运行时 mock bridge |
| 网易云 TypeScript oracle | `pnpm exec tsc -p tests/oracle-tsconfig.json --pretty false` | 必须 | `src/audio-source/netease/**/*.ts` 在独立严格配置下零错误；该 oracle 不进入 WebView 运行时 |
| Rust crates | 分别在 `crates/` 与 `crates/hyperplayer-source-netease/` 执行 `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`、`cargo test --workspace --all-targets --all-features --locked` | 必须 | 顶层 engine workspace 与独立网易云 source workspace 的格式、Clippy 和测试全部通过，且各自锁文件未漂移 |
| Tauri Rust | 在 `src-tauri/` 执行同等 fmt/clippy/test | 必须 | Tauri 应用 crate 的格式、Clippy 和测试全部通过，且锁文件未漂移 |
| Rust 许可证/来源/公告 | `cargo deny --all-features --target x86_64-pc-windows-msvc check` 分别检查 `crates/Cargo.toml`、`crates/hyperplayer-source-netease/Cargo.toml` 与 `src-tauri/Cargo.toml` | 必须 | 只审计唯一发布目标 Windows；仅允许 `deny.toml` 明列许可证和 crates.io 来源；安全公告、未知来源、通配依赖失败 |
| JavaScript 生产依赖许可证 | `node tests/check-js-licenses.mjs` | 必须 | SPDX 表达式只包含允许许可证，且所有生产包出现在 `THIRD_PARTY_NOTICES.md` |
| GitHub Actions 配置 | 解析 `.github/workflows/*.yml` | 必须 | YAML 可解析；工作目录、清单与仓库真实路径一致 |

## 领域契约门槛

| 领域 | 当前状态 | 合并/发布门槛 |
|---|---|---|
| DSP | 暂空，等待 D16 | 只验收稳定插入点、逐样本透明旁路和 UI 禁用入口；不得虚构算法、效果、参数或预设。D16 定稿后再增加 TS/Rust 对照向量、误差容限与性能测试 |
| D25 缓存策略 | 未决 | 缓存总容量、最近 100 首淘汰、断网行为和后台资源阈值必须通过显式策略接口隔离；定案前默认 fail closed，不得把临时数值固化为契约 |
| VIP 缓存权益 | D23 硬门禁 | 离线测试必须覆盖未登录、非 VIP、过期、切号、服务端校验失败均拒绝；仅同一 `AccountEntitled(userId)` 且实时权益有效时放行 |
| 专辑缓存晋升 | D24 硬门禁 | 离线测试覆盖专辑上下文、完整一首或累计 5 分钟、每日最多计一次、5 次晋升、空闲低优先级补齐及权益门禁 |
| 网易云 Rust 迁移 | 独立 workspace 已落地 | 每个迁移端点须以行为规范和 TS oracle 的固定输入/输出 fixture 验证成功、错误码、退避、音质降级、付费内容拦截与歌词等价；独立 workspace 必须通过 fmt/clippy/test 与许可证门禁 |
| Tauri DTO/capabilities | 已落地，契约覆盖持续补齐 | command/event/channel DTO 需序列化契约测试；capabilities 需最小权限检查，禁止通用网络代理、任意 URL、任意文件系统或 Cookie 读写接口 |

## 外部测试门槛

默认 CI 必须可重复、无凭据、无账号写操作且不依赖网易云在线可用性。以下测试不得混入普通 `push` / `pull_request` 必需检查：

| 类型 | 触发与环境 | 通过标准 |
|---|---|---|
| 匿名联网 smoke | 手动 `workflow_dispatch` 或受控定时任务；独立标记 `external`，设置超时与限速 | 公钥、匿名注册、搜索、歌词、播放地址最小链路通过；失败归类为协议回归、网络故障或上游限流，不以重试掩盖 |
| 登录/VIP 权益 | 仅受保护环境，使用专用测试账号和 GitHub Environment 审批；秘密不得写日志、fixture 或 artifact | 验证 D23 fail-closed 矩阵；不得伪造会员状态，不得保存可复用 Cookie/设备会话 |
| 写操作 | 默认禁用；仅手动审批、专用可清理账号 | 每个动作有显式确认、幂等/清理方案和审计记录；禁止在 fork PR、普通 CI 或开发者个人账号运行 |
| Windows 音频/系统集成 | Windows 实机或专用 runner | 验证 WASAPI、SMTC、媒体键、设备切换和安装包行为；云端 runner 的编译通过不能替代实机验收 |
| 性能与资源 | M1/M6 指定 Windows 基线机 | 记录空闲/播放内存、冷启动、安装体积和音频稳定性；在形成实测基线前不设拍脑袋硬阈值 |

## 当前已知阻断

- DSP 具体效果、参数和工作台继续受 D16 阻塞；当前只允许透明旁路与禁用入口。
- D25 尚未确定缓存总容量、最近 100 首淘汰、断网和后台资源阈值，因此整专后台补齐默认关闭。
- 登录/VIP、网易云写操作、Windows 音频/SMTC 与安装升级仍需要受控账号、Windows 实机或签名材料完成外部验收。
- UI 最终设计令牌仍需按定调文件在真实 Tauri 窗口中逐页确认。浏览器截图或浏览器 mock 不得作为通过依据。
