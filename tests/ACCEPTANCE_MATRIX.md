# CI 与契约测试验收矩阵

更新时间：2026-08-31

> 最近一次本地验证（2026-09-03，Stage 14 第二波收尾）：前端 223 项、crates workspace 26 个测试目标（engine lib 312 + gapless_backend 7 + gapless_continuity 15 + gapless_real_encoder 3 + DSP 集成等）、网易云 Rust 与 Tauri 165 项测试通过，crates/Tauri fmt、strict clippy（-D warnings）与锁文件均无漂移。此前基线（2026-08-31）：前端 53 项、engine 69 项、网易云 Rust 49 项、Tauri 85 项测试通过；IPC 清单 79 个 command / 12 个 event 匹配；三个 Rust manifest 的 Rust 1.98 fmt/clippy/test 与 `cargo deny --offline` advisories/licenses 均通过；网易云 TypeScript oracle、JavaScript 许可证和前端生产构建通过。最新完整 Tauri 构建已成功生成 x64 NSIS 与 MSI。真实 Tauri/WebView2 已确认播放器主窗口、匿名公共首页、播放列表空态、设置和 updater fail-closed；Discover、恢复队列连续水合、双域历史和缓存多质量聚合已有自动化覆盖，仍需继续做完整页面/硬件/账号外部验收。

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
| DSP | D29 已定调；Stage 09（DSP 控制面闭环）已完成，Stage 22 生产接线完成待实机验收 | 按 HSE v1.5.1 专项授权接入完整 22 阶段（1–22 全部生产接线，默认 disabled）Rust/TS 核心、参数、预设和一致性测试；Rust 为播放权威，不复用 HSE UI。DSP 配置已版本化持久化（`settings.json` `dsp` 段，启动恢复 + 迁移 fail-close）；重启恢复 revision；标准 BS.1770-5 为独立 `MeterMode`（默认 HSE v1.5.1 兼容；标准模式已通过解析向量认证 ±0.1 LU，未使用官方 EBU 测试文件，不宣称 EBU 认证）；Stage 19 LUFS/true-peak/limiter 动态字段已接入 HPTM v4 telemetry 与工作台。HRTF 资产：MIT KEMAR 已审计入库（引用义务履行，见 `provenance/hrtf-mit-kemar/`），spatial 实机验收（UI 多尺寸、真实设备听感、安装资源复审）通过前不得宣称产品完成 |
| D25 缓存策略 | D30 已定调，待实现 | 默认 10 GiB、最近 100 个不同远程曲目保护、Public 7 天离线证明、AccountEntitled 离线拒绝、整专补齐受 AC/非计费网络/磁盘保留条件约束 |
| VIP 缓存权益 | D23 硬门禁 | 离线测试必须覆盖未登录、非 VIP、过期、切号、服务端校验失败均拒绝；仅同一 `AccountEntitled(userId)` 且实时权益有效时放行 |
| 专辑缓存晋升 | D24 硬门禁 | 离线测试覆盖专辑上下文、完整一首或累计 5 分钟、每日最多计一次、5 次晋升、空闲低优先级补齐及权益门禁 |
| 网易云 Rust 迁移 | Stage 16 接线完成：crate 30 条新路由 + 行为差异修复（设备 Cookie 画像/xeapi 头/weapi 备用 golden/clientlog scrobble）+ Tauri 28 command + bridge 125 契约 + 230 前端测试；剩 7 条长尾路由与真实账号矩阵 | XEAPI 首次调用会执行并发安全、失败可重试的网络初始化；扫码登录返回本地 SVG data URL；官方图片通过主窗口专用 command 按域名、DNS、公网地址、MIME、体积和重定向校验。每个迁移端点仍须以行为规范和 TS oracle 的固定输入/输出 fixture 验证成功、错误码、退避、音质降级、付费内容拦截与歌词等价 |
| 本地解码/gapless（Stage 14） | 工程侧全部完成（增量解码、codec trim、preparation worker、真实编码器专辑、长时稳定性）；仅剩 Windows 实机录回/听感验收 | FLAC/MP3 增量 decoder（symphonia，raw 时间轴契约）+ codec trim（MP3 Xing/LAME、FLAC Vorbis Comment）+ 采样级 seek（帧内 skip）+ 流末 seek 边界；runtime 全链路 trim 证据（play_to_end 帧数精确 = raw − delay − padding）与 standby 预填证据（prime_standby 走 seek(delay)、trim 入 Primed、未 primed fail-closed）；欠载/慢 IO/EOF/seek 复位 fake backend 矩阵。第二波补齐：PreparationWorker 将 open/probe 移出 actor 控制路径（慢 open 300ms 期间 Snapshot <150ms 返回、失败回退同步切歌并保持 restore 语义均有测试）；flacenc（Apache-2.0）真实编码三轨连续专辑跨曲 promote 逐点等于权威参考，8 轮长时稳定性输出总量精确零漂移；symphonia-bundle-flac/common MPL-2.0 已记入 deny 例外。关闭切片仅须：Windows 实机录回/权威 PCM 对比与用户听感确认 |
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

- D29 已解除 DSP 规格阻塞；完整 HSE DSP 核心、HyperPlayer 原生工作台、22-stage 逐场景定制、标准 BS.1770-5 认证与 parity/性能/硬件验收仍待实施。
- D30 已确定缓存默认策略；schema v7、淘汰器、Windows 资源探针和整专补齐 worker 仍待实施。
- 登录/VIP、网易云写操作、Windows 音频/SMTC 与安装升级仍需要受控账号、Windows 实机或签名材料完成外部验收。
- UI 最终设计令牌仍需按定调文件在真实 Tauri 窗口中逐页确认。浏览器截图或浏览器 mock 不得作为通过依据。
