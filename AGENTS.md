# HyperPlayer — Agent 指南

## 项目简介

HyperPlayer 是一款**现代化 Windows 桌面音乐播放器**（Tauri 2 + React/TypeScript + Rust 音频引擎）。当前仓库已完成技术选型、详细设计、依赖部署和网易云 TypeScript 行为 oracle；**尚未创建 Tauri 应用源码或 UI**。

## 硬性约束

- **现行技术栈是 Tauri 2（D21 / ADR-0005）**：D13 Electron 方案已作废；不得恢复 Electron、Node sidecar、napi-rs 或打包 Chromium，除非用户重新定调并新增 ADR
- 许可证 **MIT**：依赖只收 MIT/Apache/BSD；GPL 组件不引入；LGPL 仅限合规评估通过后使用
- **只发 Windows**（Tauri 跨平台能力保留，未来可逆）；Windows 使用系统 WebView2
- 资源占用**不设未经实测的硬指标**；M1/M6 分别测空闲/播放内存、冷启动与安装体积
- **自研 DSP 是一等公民**：音频管线必须保留插入点；DSP 为 TS+Rust 双实现，Rust 为准
- 官方内置网易云音源：模块隔离、可整体禁用，不与播放核心/引擎耦合（版权风险自担，用户知情决策）
- **音源模块 Cleanroom 开发（用户明令）**：参考代码位于 `temp/`（已 gitignore），流程为「读参考 → 提炼 `docs/音源-网易云-行为规范.md` → 只按规范独立实现」；参考代码永不入库、永不复制进实现
- 现有 `src/audio-source/netease/` TypeScript 代码是已联网验证的**行为 oracle**，不是 Tauri 终态运行时；网络、Cookie、设备会话和协议加密最终迁入 Rust。禁止用 Node sidecar 规避迁移
- **不提供音乐文件下载/导出**；播放缓存必须是应用私有缓存，不能暴露为 MP3/FLAC 文件
- **VIP 缓存权益门禁（D23）**：VIP 缓存绑定 `AccountEntitled(userId)`；只有当前登录同一网易账号且服务端实时确认 VIP/对应权益有效时才能播放。未登录、非 VIP、会员过期、切换账号或校验失败一律 fail closed，缓存文件存在不构成播放授权
- **专辑缓存晋升（D24）**：专辑上下文始终启用下一首预取；同一专辑完成 5 次有效专辑会话后晋升高频专辑，系统空闲时低优先级补齐整专缓存。有效会话须从专辑上下文发起，且完整播放至少一首或累计 5 分钟；同一专辑每日最多计一次
- 真正 gapless 不等于文件已缓存：必须由 Rust 引擎提前建立 standby decoder、处理编码 delay/padding、统一 PCM 并预填 ring buffer 后在采样边界切换
- 永久排除：UnblockNeteaseMusic、QQ/酷狗/酷我跨平台匹配、灰歌替代源、伪造会员状态、将其他平台同名歌曲伪装成网易资源

## 工作流程约束

- 当前只允许**详细设计、环境部署和依赖清单维护**；在用户明确解除前，不运行 `tauri init/create`，不创建 `src-tauri`、Tauri commands、capabilities、React UI 或网易云 Rust 实现
- 所有规划文件写入 `docs/`（已 gitignore）：需求、决策记录、ADR、术语表和协议规范
- 每轮定调产生的新约束同步更新本文件与持久记忆

## 目录结构

- `docs/` — 调研、需求基线、决策记录、ADR、术语表和网易云行为规范，已 gitignore
- `crates/hyperplayer-engine/` — 框架无关的 Rust 引擎/领域 crate 占位；未来拥有音频、DSP、曲库、SQLite
- `src/audio-source/netease/` — 网易云 TypeScript Cleanroom oracle（115 个函数，已联网 PoC）
- `src/audio-source/lyrics/` — LRC/YRC/TTML 与时间轴纯 TypeScript 实现
- `temp/` — 第三方参考、PoC 和依赖探针，已 gitignore，永不入库

## 技术栈（D21 现行）

- **Web 前端**：React + TypeScript + Vite，运行在系统 WebView2
- **桌面壳**：Tauri 2 Rust 应用层 —— 窗口、托盘、生命周期、capabilities、更新和 Windows 集成；无领域逻辑
- **音频/曲库核心**：`hyperplayer-engine` Rust crate —— symphonia 解码 + DSP 管线 + cpal/miniaudio（WASAPI）输出 + lofty + rusqlite；独立线程，框架无关
- **桥**：短请求/响应用 Tauri commands；播放状态、扫描进度等连续数据用 events/channel；显式 serde DTO
- **UI 体系**：Tailwind CSS + shadcn/ui（D17 默认，可推翻）；zustand + TanStack Query
- **系统集成**：优先 Tauri 2 官方/维护良好的插件，SMTC 等长尾能力用 Rust `windows-rs`
- **打包更新**：Tauri bundler + updater plugin + GitHub Releases；签名方案待 M6 定稿
- 决策依据：`docs/定调决策记录.md`（D21）、`docs/adr/0005-tauri2-react-rust.md`；Rust 曲库边界见 ADR-0004

## 构建 / 测试

暂无应用构建脚本（尚未创建 Tauri app crate）。不要猜测 `tauri dev/build` 命令；M0 创建实际配置后再登记。

当前可验证命令：

- Rust engine 占位 crate：在 `crates/` 运行 `cargo build`
- 网易云 TypeScript oracle：运行严格 `tsc --noEmit`（具体参数见最近验证记录；M0 后纳入正式 tsconfig/script）
- Tauri CLI 环境：`pnpm exec tauri --version`

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
