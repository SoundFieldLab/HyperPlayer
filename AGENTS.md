# HyperPlayer — Agent 指南

## 项目简介

HyperPlayer 是一款**现代化 Windows 桌面音乐播放器**（Tauri 2 + React/TypeScript + Rust）。UI 定调（UI-D1~80）、**前后端边界定调（D34 / ADR-0006，2026-09-04）**与**接缝定调（D35）**已完成；**D36（2026-09-05）修订网易云协议层为 Node sidecar 原生接入**。现状：播放/DSP/缓存治理在 WebView 前端（TypeScript），Rust 留本地曲库与桌面壳，网易云协议由 vendored 包以自带 express 服务跑本地 Node sidecar（`server/netease-sidecar.mjs`），前端经 sidecar HTTP 调用；浏览器化 shims/适配层已删除。处于实现接线阶段：主链路已接（壳/网易云/播放/DSP），实机 bug 修复与波次收尾进行中。

## 硬性约束

- **现行技术栈是 Tauri 2（D21 / ADR-0005 + ADR-0006 / D34，D36 修订）**：D13 Electron 方案已作废；不得恢复 Electron、napi-rs 或打包 Chromium。**D36 允许网易云协议层使用本地 Node sidecar**（vendored 包原生运行）；播放/DSP/壳层仍零 Node。
- **播放链在 WebView（D34）**：Web Audio + HSE AudioWorklet；双源调度——本地完整数据（本地文件/整轨缓存）走 decodeAudioData + AudioBufferSource 采样级调度（真 gapless），流式在线播放走 MediaElement 近似 gapless（预载+快切）；本地格式支持 = WebView2 原生格式集（MP3/FLAC/AAC/OGG/WAV），APE/DSF/DFF 明确不支持；放弃 WASAPI 独占（走系统共享混音）
- **DSP 权威 = HSE TS（D34，推翻 D29/D31/D33）**：`shared/hypersoundengine`（HSE v1.5.1 完整 TS：core + worklet + browser + ui + specs）是唯一 DSP 实现；DSP 工作台 = HSE 自带 MixingStudio UI + HyperPlayer 视觉统一（theme.ts 令牌、lucide→Phosphor），**不大改 HSE UI 结构**；授权链 `LICENSE-HSE-AUTHORIZATION.md`（IceFireIcer 专项授权）覆盖 TS 拷贝，保留
- 项目许可证 **Apache-2.0**：依赖仅接受 Apache-2.0/MIT/BSD/ISC/Zlib/Unicode/OFL 等经审核可兼容许可证；GPL/AGPL 组件不引入（**folia 不接、删除**）；LGPL/MPL 等弱 copyleft 仅限完成合规评估并记录后使用（**unblockneteasemusic 永不引入**）
- **只发 Windows**（Tauri 跨平台能力保留，未来可逆）；Windows 使用系统 WebView2
- 资源占用**不设未经实测的硬指标**；M1/M6 分别测空闲/播放内存、冷启动与安装体积
- **本地曲库归 Rust（D14 / ADR-0004，D34 维持）**：`crates/hyperplayer-engine` 仅保留 repository/library/lofty/SQLite 曲库；src-tauri 仅壳层（窗口/托盘/SMTC/文件关联/更新/日志）+ library commands 透传；command 面从约 160 剪到约 46 个，全部无领域知识
- **前后端接缝（D35，2026-09-04）**：SMTC = WebView 权威 + Rust 纯桥（上行 3 个 smtc_update command、下行 media_button_pressed 事件）；本地文件走 `asset:` 协议（曲库目录进 scope）；缓存介质 = OPFS（用户不可见、数据钉在应用数据目录随程序走）；配置/DSP 预设 = Rust app-data JSON 哑 KV（`settings_get/set`，schema 归 TS）；Cookie = Rust DPAPI 保险库哑存取（`credential_vault.rs` 保留，防数据目录拷贝盗号）；多窗口 = 主窗口权威 + Tauri event 广播（进度 1Hz、歌词按行）；tauri-plugin-http 放开 HTTPS 任意域（音源禁用改由前端模块边界承担，非传输层 enforcement——已记录的偏差）；天气 = 保留、TS 重做完整功能（weather.rs 删除）；compat.rs 删除
- 官方内置网易云音源：模块隔离、可整体禁用，不与播放核心/壳层耦合（版权风险自担，用户知情决策）
- **网易云实现（D36，2026-09-05，修订 D34「三处手术」）**：协议核心 = `vendor/netease-cloudmusic-api`（`@neteasecloudmusicapienhanced/api` 4.39.0，MIT，431 端点）**以标准 Node 包原生运行**——pnpm workspace 成员、安装自身依赖、经 `server/netease-sidecar.mjs` 调 `serveNcmApi` 起 express（dev 端口 14321，`ENABLE_GENERAL_UNBLOCK` 不设置）；前端 `neteaseService.call()` 走 sidecar HTTP（POST JSON + `cookie` 随 body 传，响应 `{status,body,cookie}`），会话主权在前端（MUSIC_U 存 DPAPI 保险库，sidecar 不持久化登录态）。浏览器 shims/generated/build-netease-vendor **已删除、不得复活**。WaveForge 业务层（音质阶梯降级/付费拦截/重试）保留在 TS 服务层；WaveForge（https://github.com/SoundFieldLab/WaveForge ）经项目方授权直接入库，LICENSE/THIRD_PARTY_NOTICES 登记；`docs/音源-网易云-行为规范.md` 保留作协议行为参考。sidecar 打包形态（node.exe 捆绑 + Rust 进程托管）M6 定稿
- **歌词（D34）**：`vendor/waveforge-lyrics`（LRC/YRC/TTML 解析 + 逐字时间轴 + LyricsDisplay 等渲染组件成套接入）；folia/pv/FoliaLyricsPage/MultidimensionalLyrics 不引入
- **不提供音乐文件下载/导出**；播放缓存必须是应用私有缓存，不能暴露为 MP3/FLAC 文件
- **VIP 缓存权益门禁（D23，D34 改 TS 执行）**：VIP 缓存绑定 `AccountEntitled(userId)`；只有当前登录同一网易账号且服务端实时确认 VIP/对应权益有效时才能播放。未登录、非 VIP、会员过期、切换账号或校验失败一律 fail closed，缓存文件存在不构成播放授权。规则在 TS 服务层执行，强制力降档（JS 拦截可被绕过，威胁模型 = 防误用不防故意）
- **专辑缓存晋升（D24，D34 改 TS 执行）**：专辑上下文始终启用下一首预取；同一专辑完成 5 次有效专辑会话后晋升高频专辑，系统空闲时低优先级补齐整专缓存。有效会话须从专辑上下文发起，且完整播放至少一首或累计 5 分钟；同一专辑每日最多计一次
- **缓存治理（D30 规则，D34 改 TS 执行）**：默认容量 10 GiB（可配置 2–100 GiB），到上限清理至 90%，保护最近 100 个不同远程曲目；Public 离线证明最长 7 天，AccountEntitled 离线永远 fail closed
- 永久排除：UnblockNeteaseMusic、QQ/酷狗/酷我跨平台匹配（含 `song_url_match` 兜底路径）、灰歌替代源、伪造会员状态、将其他平台同名歌曲伪装成网易资源

## 工作流程约束

- **D34 前后端边界重定调 + D35 接缝定调（2026-09-04 用户定调）**：12+8 问定案记录见 `docs/定调决策记录.md` D34/D35；架构 ADR-0006；需求基线已按 D34/D35 重写。**删除清单已用户确认但尚未执行**（约 7.5 万行 Rust + 1.6 万行 TS + 13 个 stage 文档 + 配套脚本；D35 修正：credential_vault.rs 摘出保留、weather.rs 删除改 TS 重做、compat.rs 删除）：执行前现状 = vendor/shared 四块新资产已落位未接线，旧 Rust 链仍在
- **保 UI 层、换服务层（D34 Q10）**：`app/` 页面/组件/视觉体系原样保留，只动 bridge 之下的服务层与 store；store 从单一 store 切分域 store（播放/曲库/网易云/DSP）
- **消灭平行实现（D34 主题）**：网易云与 DSP 各只允许一份实现（vendored 包 / HSE 完整 TS）；`src/audio-source/`、`shared/hse-ts-core/`、Rust HSE/网易云/播放链全部在删除清单内，不得复活或新造第二实现
- `vendor/` 与 `shared/hypersoundengine` 是唯一真相源：对 vendored 包的适配改动以注释标记、不回改上游；HSE UI 只做视觉统一不大改结构
- **Rust 壳零领域知识（D34+D35）**：Rust 侧允许存在的只有——曲库（ADR-0004）、哑存储（settings KV / DPAPI 保险库）、纯转发（SMTC 桥 / tauri-plugin-http）、系统集成；任何新 command 出现协议/DSP/播放/Cookie 语义即违规
- 所有新增依赖须满足许可证约束；新增 vendored 源码必须带原 LICENSE + 在 `THIRD_PARTY_NOTICES.md` 登记（现成范例见 `vendor/README.md`）；前端生产依赖由 `tests/check-js-licenses.mjs` 校验覆盖
- **animejs 4.5.0（2026-09-04 用户定调引入）**：前端动画补充库（MIT，Julian Garnier），根依赖已装、notices 已登记；用于复杂/编排式动画（歌词逐字动效、封面氛围、交互动效精细编排），产品过渡与短反馈仍以 Motion + CSS 为主；**GSAP 仍永久排除**（D27）
- 所有规划文件写入 `docs/`（已 gitignore）：需求、决策记录、ADR、术语表和协议规范
- 每轮定调产生的新约束同步更新本文件与持久记忆
- 宣称「按 D34 架构可用」前必须：删除清单执行完毕 + 播放/DSP/网易云三链在 Tauri/WebView2 实测通过

## 目录结构

- `docs/` — 调研、需求基线、决策记录、ADR、术语表和网易云行为规范，已 gitignore
- `server/netease-sidecar.mjs` — 网易云协议 Node sidecar（D36）：起 vendored 包自带 serveNcmApi（express，dev 端口 14321）；`scripts/dev.mjs` 编排 sidecar + tauri dev
- `vendor/netease-cloudmusic-api/` — vendored 网易云协议核心（4.39.0，MIT，431 端点；D36 起为 pnpm workspace 成员，原生 Node 依赖）
- `vendor/waveforge-netease/` — WaveForge 网易云业务层（local-server.mjs 路由逻辑 + services 前端服务）
- `vendor/waveforge-lyrics/` — WaveForge 歌词解析+渲染层
- `shared/hypersoundengine/` — HSE v1.5.1 完整 TS（DSP core/worklet/browser + MixingStudio UI + specs）
- `crates/hyperplayer-engine/` — Rust 曲库 crate（D34 后仅 repository/library/model/error）
- `app/` — React 前端（UI 层 + 待新建服务层/分域 store）
- `src-tauri/` — Tauri 2 壳层（窗口/托盘/SMTC/更新/日志 + library commands）
- `temp/` — 第三方参考、PoC 和依赖探针，已 gitignore，永不入库（WaveForge 快照/HSE tarball 的存档仍在 temp，作为引入源头凭证）

## 技术栈（D34 现行，D36 修订）

- **Web 前端（运行时主体）**：React + TypeScript + Vite，运行在系统 WebView2；播放链（Web Audio + HSE AudioWorklet）、DSP 宿主、缓存治理、网易云业务服务层（会话/音质阶梯/门禁）全部在前端
- **网易云协议 sidecar（D36）**：本地 Node 进程跑 vendored express 服务，前端经 tauri-plugin-http 调 `http://127.0.0.1:14321`（scope 含回环 http；cookie 每请求注入，sidecar 无登录态持久化）
- **桌面壳**：Tauri 2 Rust 应用层 —— 窗口、托盘、SMTC、生命周期、capabilities、更新和 Windows 集成；`tauri-plugin-http` 作哑传输管道
- **Rust 曲库**：`hyperplayer-engine` crate —— lofty + rusqlite；框架无关，ADR-0004 边界维持
- **桥**：曲库/窗口/系统走 Tauri commands（约 40 个）+ events（扫描进度等）；网易云协议走本地 sidecar HTTP、封面/CDN/天气走 tauri-plugin-http（绕 CORS）；播放/DSP 数据不过 IPC
- **UI 设计基线已完成（UI-D1~UI-D80）**：现行规则见 `docs/UI设计基线.md`，决策过程见 `docs/UI定调决策记录.md`；不得回退成默认 shadcn、移动端底部 Tab、营销页布局或遍地玻璃卡片；DSP 工作台条款按 D34 修订为「HSE 自带 UI + HyperPlayer 皮肤」
- **UI 体系**：Tailwind CSS 4 + 深度定制 shadcn/ui（Radix）+ Phosphor Regular/Fill；zustand（分域 store）+ TanStack Query；Motion 管产品过渡，CSS 管短反馈；复杂/编排式动画可用 animejs 4.5.0 补充（2026-09-04 用户定调）；主窗口的封面氛围、按需波形/频谱、DSP 曲线/仪表和 2D/2.5D 空间场可选用 vGPU 0.3.1，必须运行时检测 WebGPU 并保留 Canvas2D/SVG/DOM 降级；不引入 GSAP
- **视觉方向**：明亮柔和消费产品 + 克制 Apple/Liquid Glass 近似；默认明亮、完整深石墨主题；`#3F55F9` 管交互、`#FF761C` 管播放；得意黑展示、思源黑体内容/歌词、Cascadia Mono 数据
- **核心结构**：双内容域默认网易云、完全自绘标题栏、可展开三段式播放坞、42/58 封面+歌词播放层、有限槽位停靠/浮动窗口、完整桌面键盘与上下文菜单
- **UI 验收要求**：所有页面与交互只在正式 Tauri/WebView2 窗口中验收。Computer Use + 多尺寸截图 + 设计 skills 通过后，最后由用户逐页确认
- **正式 UI 与验证仅运行在 Tauri/WebView2**：不提供浏览器预览或运行时 mock bridge；`pnpm dev` 启动 `tauri dev`，`pnpm build` 执行完整 Tauri 构建。Vite 内部脚本仅供 Tauri 生命周期调用，不作为独立产品入口
- **vGPU 可视化边界（D31 / UI-D80，D34 修订）**：`vgpu` 只承担主窗口可选 GPU 渲染；权威 DSP/FFT/LUFS/HRTF = HSE TS（不再是 Rust）；高频数据使用独立有界 telemetry，不进入 Zustand/通用 events，不传原始 PCM；降级 Canvas2D/SVG/DOM，绝不影响播放
- **系统集成**：优先 Tauri 2 官方/维护良好的插件，SMTC 等长尾能力用 Rust `windows-rs`
- **打包更新**：Tauri bundler + updater plugin + GitHub Releases；签名方案待 M6 定稿
- 决策依据：`docs/定调决策记录.md`（D21/D34）、`docs/adr/0005-tauri2-react-rust.md`、`docs/adr/0006-webview-playback-ts-services.md`；Rust 曲库边界见 ADR-0004

## 构建 / 测试

正式应用已经建立，开发和验证以仓库脚本为准（D34 删除执行后部分脚本将移除，见 D34 清单）：

- 安装依赖：`pnpm install --frozen-lockfile`
- 开发运行：`pnpm dev`（Node 编排器并行启动网易云 sidecar + Tauri 2 + WebView2；不提供浏览器预览）
- 单独起协议 sidecar：`pnpm sidecar`（端口 14321；`ENABLE_GENERAL_UNBLOCK` 永不设置）
- 完整构建：`pnpm build`
- 仅供 Tauri 内部调用的前端构建：`pnpm frontend:build`
- 前端单元测试：`pnpm test`
- Rust engine：在 `crates/` 运行 `cargo test --workspace --all-targets --all-features --locked`
- Tauri Rust：在 `src-tauri/` 运行 `cargo test --workspace --all-targets --all-features --locked`
- HSE TS 自验：`shared/hypersoundengine` 自带 vitest/specs（接线阶段接入仓库测试面）

## 环境备忘（2026-08-30 实测）

- Node 25.4 / pnpm 11.21 / Rust 1.98.0（`x86_64-pc-windows-msvc`；由仓库根 rust-toolchain.toml 钉定，与 CI quality.yml 一致）
- MSVC Build Tools 2022 + Windows 11 SDK 已安装
- WebView2 Runtime `151.0.4129.107` 已安装
- `@tauri-apps/cli` 与 `@tauri-apps/api` 2.x 已安装
- crates.io 直连正常；registry.npmmirror.com 可达（vendored 包即从此下载）

## 仓库注意事项

- `docs/`、`temp/`、`node_modules/`、Rust target 和构建输出均已 gitignore
- 文档与注释语言：中文
- 新增调研文档放 `docs/`，命名沿用 `调研报告<名称>.md`
- `vendor/` 永不 gitignore；vendored 源码改动须标注、不回改上游
