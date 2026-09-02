# HyperPlayer — Agent 指南

## 项目简介

HyperPlayer 是一款**现代化 Windows 桌面音乐播放器**（Tauri 2 + React/TypeScript + Rust 音频引擎）。技术选型、详细设计、依赖部署和网易云 TypeScript 行为 oracle 已完成；**现已进入全量实现阶段，DSP 按 HyperSoundEngine v1.5.1 的完整核心能力实施，Rust 为播放权威，HyperPlayer 使用自有 UI。**

## 硬性约束

- **现行技术栈是 Tauri 2（D21 / ADR-0005）**：D13 Electron 方案已作废；不得恢复 Electron、Node sidecar、napi-rs 或打包 Chromium，除非用户重新定调并新增 ADR
- 项目许可证 **Apache-2.0**：依赖仅接受 Apache-2.0/MIT/BSD/ISC/Zlib/Unicode/OFL 等经审核可兼容许可证；GPL/AGPL 组件不引入；LGPL/MPL 等弱 copyleft 仅限完成合规评估并记录后使用
- **只发 Windows**（Tauri 跨平台能力保留，未来可逆）；Windows 使用系统 WebView2
- 资源占用**不设未经实测的硬指标**；M1/M6 分别测空闲/播放内存、冷启动与安装体积
- **自研 DSP 是一等公民**：音频管线必须保留插入点；HSE v1.5.1 自带 Rust 核心是唯一实时播放 DSP 主实现，TypeScript 核心承担参数、预设、HSE2、预览、诊断和一致性验证，可在控制面/可视化不可用时提供功能降级，但不得接管实际音频输出；Rust DSP 故障仍进入零 DSP 安全旁路
- 官方内置网易云音源：模块隔离、可整体禁用，不与播放核心/引擎耦合（版权风险自担，用户知情决策）
- **音源模块 Cleanroom 开发（用户明令）**：参考代码位于 `temp/`（已 gitignore），流程为「读参考 → 提炼 `docs/音源-网易云-行为规范.md` → 只按规范独立实现」；参考代码永不入库、永不复制进实现
- 现有 `src/audio-source/netease/` TypeScript 代码是已联网验证的**行为 oracle**，不是 Tauri 终态运行时；网络、Cookie、设备会话和协议加密最终迁入 Rust。禁止用 Node sidecar 规避迁移
- **不提供音乐文件下载/导出**；播放缓存必须是应用私有缓存，不能暴露为 MP3/FLAC 文件
- **VIP 缓存权益门禁（D23）**：VIP 缓存绑定 `AccountEntitled(userId)`；只有当前登录同一网易账号且服务端实时确认 VIP/对应权益有效时才能播放。未登录、非 VIP、会员过期、切换账号或校验失败一律 fail closed，缓存文件存在不构成播放授权
- **专辑缓存晋升（D24）**：专辑上下文始终启用下一首预取；同一专辑完成 5 次有效专辑会话后晋升高频专辑，系统空闲时低优先级补齐整专缓存。有效会话须从专辑上下文发起，且完整播放至少一首或累计 5 分钟；同一专辑每日最多计一次
- 真正 gapless 不等于文件已缓存：必须由 Rust 引擎提前建立 standby decoder、处理编码 delay/padding、统一 PCM 并预填 ring buffer 后在采样边界切换
- 永久排除：UnblockNeteaseMusic、QQ/酷狗/酷我跨平台匹配、灰歌替代源、伪造会员状态、将其他平台同名歌曲伪装成网易资源

## 工作流程约束

- **2026-08-30 用户已解除正式代码禁令并要求全量实现**：可创建 Tauri 2 应用、React UI、commands/capabilities、Rust 引擎/曲库和网易云 Rust Cleanroom 实现
- **DSP 全量接入（2026-08-31 用户定调）**：以 HyperSoundEngine v1.5.1（commit `f7017621b7d84005fbfed8a3c42a119487a17326`）为完整 DSP 核心输入，迁入 22 阶段 Rust/TS 能力、参数、预设、配置编码和一致性测试；Rust 为实际播放权威，不复用 HSE UI/browser host/service/WASAPI。HSE 自带 Rust 核心是已按 TS 参照编写并验证、但尚未实际融合播放器的代码；后续以该 Rust 核心为算法迁移首要来源，TS 作为独立行为 oracle，优先原样迁移/裁剪已有 Rust 算法，只增加 HyperPlayer 的 `PcmProcessor`、revision、checkpoint、tail 和实时线程适配层，不重复手写已有内核。权利人 IceFireIcer 已授予 HyperPlayer 专项修改、融合及 Apache-2.0 分发授权，见 `LICENSE-HSE-AUTHORIZATION.md`；第三方 IR、素材和 SOFA/HRTF 数据仍须单独审计
- **HSE 主备与去重（2026-09-01 用户定调 / D33）**：继续适配 HSE 自带 Rust 核心作为生产主链；`shared/hse-ts-core` 作为控制面能力的备选/降级实现，覆盖参数校验、12 场景、HSE2、曲线预览、离线诊断和 parity，不允许通过 Web Audio、AudioWorklet 或 WebView 脚本接管实际播放。原先按 TS 另行手写的 Rust 算法必须按「vendored core API → HyperPlayer adapter → parity/vector → revision/checkpoint/standby → 零分配 → 全门禁」顺序逐阶段替换并删除；只保留 PCM 布局、门控、revision、checkpoint、standby、latency/tail、sidechain、故障旁路与实时线程适配，不允许长期维护重复算法主体。当前已上线的 14 个 processor 已完成该去重：Stage 1/2/7 已抽成独立 HSE Rust core stage，Stage 3/4 纯重导出和 Stage 5/6/14 厚 façade 已删除/收薄，Stage 8–12 已改用 core 规范化参数、tail basis 与 runtime-state API
- **D25 保守默认（2026-08-31 用户授权工程定调）**：默认容量 10 GiB（可配置 2–100 GiB），到上限清理至 90%，保护最近 100 个不同远程曲目；Public 离线证明最长 7 天，AccountEntitled 离线永远 fail closed；整专补齐默认 standard、单并发、AC/非计费网络/磁盘保留条件满足时运行
- **D30 当前实现边界（2026-09-02）**：repository schema v7、v6 一致性备份、typed cache governance metadata、按 content hash 淘汰 planner、recent/lease 保护、Public 7 天离线证明、AccountEntitled 离线拒绝、安全 reconciliation plan、durable album-fill items 和 `AlbumFillCoordinator` 已实现并通过测试。Tauri runtime supervisor、实际 reconciliation/quota IO、Windows AC/计费网络/磁盘探测、album-fill 下载生命周期和 Settings 容量/策略 UI 尚未接线；在这些完成前不得宣称 D30 产品闭环
- 仍按现行定调与 ADR 实施；所有新增依赖须满足许可证约束，网易云实现继续严格遵守 Cleanroom 与模块隔离
- 所有规划文件写入 `docs/`（已 gitignore）：需求、决策记录、ADR、术语表和协议规范
- 每轮定调产生的新约束同步更新本文件与持久记忆

## 目录结构

- `docs/` — 调研、需求基线、决策记录、ADR、术语表和网易云行为规范，已 gitignore
- `crates/hyperplayer-engine/` — 框架无关的 Rust 引擎/领域 crate：音频解码与 CPAL 输出、透明 DSP 管线、队列、歌词、曲库、SQLite 和受控缓存
- `src/audio-source/netease/` — 网易云 TypeScript Cleanroom oracle（115 个函数，已联网 PoC）
- `src/audio-source/lyrics/` — LRC/YRC/TTML 与时间轴纯 TypeScript 实现
- `temp/` — 第三方参考、PoC 和依赖探针，已 gitignore，永不入库

## 技术栈（D21 现行）

- **Web 前端**：React + TypeScript + Vite，运行在系统 WebView2
- **桌面壳**：Tauri 2 Rust 应用层 —— 窗口、托盘、生命周期、capabilities、更新和 Windows 集成；无领域逻辑
- **音频/曲库核心**：`hyperplayer-engine` Rust crate —— symphonia 解码 + DSP 管线 + cpal/miniaudio（WASAPI）输出 + lofty + rusqlite；独立线程，框架无关
- **桥**：短请求/响应用 Tauri commands；播放状态、扫描进度等连续数据用 events/channel；显式 serde DTO
- **UI 设计基线已完成（UI-D1~UI-D79）**：现行规则见 `docs/UI设计基线.md`，决策过程见 `docs/UI定调决策记录.md`；不得回退成默认 shadcn、移动端底部 Tab、营销页布局或遍地玻璃卡片
- **UI 体系**：Tailwind CSS 4 + 深度定制 shadcn/ui（Radix）+ Phosphor Regular/Fill；zustand + TanStack Query；Motion 管产品过渡，CSS 管短反馈；主窗口的封面氛围、按需波形/频谱、DSP 曲线/仪表和 2D/2.5D 空间场可选用 vGPU 0.3.1，必须运行时检测 WebGPU 并保留 Canvas2D/SVG/DOM 降级；不引入 GSAP
- **视觉方向**：明亮柔和消费产品 + 克制 Apple/Liquid Glass 近似；默认明亮、完整深石墨主题；`#3F55F9` 管交互、`#FF761C` 管播放；得意黑展示、思源黑体内容/歌词、Cascadia Mono 数据
- **核心结构**：双内容域默认网易云、完全自绘标题栏、可展开三段式播放坞、42/58 封面+歌词播放层、有限槽位停靠/浮动窗口、完整桌面键盘与上下文菜单
- **UI 验收要求**：A 明亮纯净 / B 封面氛围共用同一产品结构，所有页面与交互只在正式 Tauri/WebView2 窗口中验收。Computer Use + 多尺寸截图 + 设计 skills 通过后，最后由用户逐页确认；DSP 工作台按 HSE 核心能力使用 HyperPlayer 自有 UI 实现
- **正式 UI 与验证仅运行在 Tauri/WebView2**：不提供浏览器预览或运行时 mock bridge；`pnpm dev` 启动 `tauri dev`，`pnpm build` 执行完整 Tauri 构建。Vite 内部脚本仅供 Tauri 生命周期调用，不作为独立产品入口
- **vGPU 可视化边界（D31 / UI-D80）**：`vgpu` 只承担 WebView2 主窗口的可选 GPU 渲染，不承担权威 DSP/FFT/LUFS/HRTF 计算。适用范围：B 材质封面氛围、用户按需打开的微型波形/频谱、DSP 响应曲线/仪表、2D/克制 2.5D 空间场；迷你播放器和桌面歌词不创建独立 GPU context。高频数据使用独立有界 telemetry channel，不进入 Zustand/通用 events，不传原始 PCM；缺少 WebGPU、设备丢失、窗口隐藏或减少动效时退化到 Canvas2D/SVG/DOM，绝不影响播放
- **系统集成**：优先 Tauri 2 官方/维护良好的插件，SMTC 等长尾能力用 Rust `windows-rs`
- **打包更新**：Tauri bundler + updater plugin + GitHub Releases；签名方案待 M6 定稿
- 决策依据：`docs/定调决策记录.md`（D21）、`docs/adr/0005-tauri2-react-rust.md`；Rust 曲库边界见 ADR-0004

## 构建 / 测试

正式应用已经建立，开发和验证以仓库脚本为准：

- 安装依赖：`pnpm install --frozen-lockfile`
- 开发运行：`pnpm dev`（启动 Tauri 2 + WebView2；不提供浏览器预览）
- 完整构建：`pnpm build`
- 仅供 Tauri 内部调用的前端构建：`pnpm frontend:build`
- 前端单元测试：`pnpm test`
- Rust engine：在 `crates/` 运行 `cargo test --workspace --all-targets --all-features --locked`
- 网易云 TypeScript oracle：`pnpm exec tsc -p tests/oracle-tsconfig.json --pretty false`
- Tauri Rust：在 `src-tauri/` 运行 `cargo test --workspace --all-targets --all-features --locked`

## 环境备忘（2026-08-30 实测）

- Node 25.4 / pnpm 11.21 / Rust 1.95（`x86_64-pc-windows-msvc`）
- MSVC Build Tools 2022 + Windows 11 SDK 已安装
- WebView2 Runtime `151.0.4129.107` 已安装
- `@tauri-apps/cli` 与 `@tauri-apps/api` 2.x 已安装
- Tauri 2、tauri-build、serde、serde_json 的 Rust crates 已通过 `temp/tauri-env-probe/` 执行 `cargo fetch` 下载到 Cargo 缓存
- crates.io 直连正常；Electron 镜像说明已失效，不再保留

## 仓库注意事项

- `docs/`、`temp/`、`node_modules/`、Rust target 和构建输出均已 gitignore
- 文档与注释语言：中文
- 新增调研文档放 `docs/`，命名沿用 `调研报告<名称>.md`
