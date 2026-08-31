# Tauri 2 + React UI + Rust 应用层与引擎（取代 ADR-0003）

---
status: accepted
date: 2026-08-30
supersedes: 0003-electron-react-rust.md
---

定调 D21：HyperPlayer 的桌面壳从 Electron 改为 **Tauri 2**。UI 保持 React + TypeScript + Vite，在 Windows 系统 WebView2 中运行；Tauri Rust 应用层负责窗口、托盘、生命周期、权限、更新和系统集成，并直接依赖框架无关的 `hyperplayer-engine` crate。前端请求/响应经 Tauri commands，播放状态、扫描进度等连续数据经 events/channel 推送；删除 Node 主进程与 napi-rs 边界。

## Why Now

ADR-0003 当时选择 Electron，核心理由是 TS 全栈、插件生态成熟、单人项目完工概率高。但后续详细设计把音频/DSP、曲库扫描、lofty 元数据、rusqlite 存储、SMTC 乃至网易云协议终态全部归入 Rust。Node 主进程只剩编排层，继续保留 Electron 会制造 `React → Electron IPC → Node → napi-rs → Rust` 两段边界。Tauri 2 将其收敛为 `React → command/event/channel → Rust 应用层 → engine crate`，与现有 Rust-heavy 架构更一致，同时减少 Chromium 打包、安装体积和基础内存开销。

## Architecture

- **Web 前端**：React + TypeScript + Vite；只负责 UI、交互状态和数据展示
- **Tauri 应用层**：窗口、托盘、生命周期、权限、系统集成、更新和 command 编排；不承载音频/曲库领域逻辑
- **引擎 crate**：音频解码、DSP、WASAPI 输出、曲库扫描、lofty、rusqlite；保持框架无关
- **通信**：短请求/响应使用 commands；播放状态、扫描进度和长期任务使用 events/channel
- **Windows**：使用系统 WebView2；只发布 Windows，但平台适配边界保留

## NetEase Source

现有 `src/audio-source/netease/` TypeScript 实现已完成 Cleanroom 全量开发与联网 PoC，继续作为**行为基准和等价测试基准**，不直接放进 WebView。网络、Cookie、设备会话和 weapi/eapi/xeapi 加密最终迁入 Rust 后端；`src/audio-source/lyrics/` 中不依赖 Node 的纯歌词解析逻辑可保留在 TypeScript，或按性能/复用需要迁入 Rust。拒绝 Node sidecar：它会引入 WebView2 + Rust + Node 三运行时，并抵消 Tauri 的主要收益。

## Security Model

- Tauri capabilities/permissions 采用最小授权
- 不向前端暴露任意文件系统、shell 或通用网络代理能力
- commands 使用显式 DTO，校验路径、ID、分页与写操作参数
- 登录 Cookie、协议密钥、设备会话和更新公钥不得进入前端 bundle

## Packaging And Updates

- 使用 Tauri bundler 打 Windows 安装包；具体 NSIS/MSI 组合留到发布设计
- 使用 Tauri updater plugin + GitHub Releases
- 更新签名、公钥托管和 Windows 代码签名在 M6 前定稿
- 不预先承诺安装包、启动时间或 `≤100MB`；M1/M6 分别实测空闲/播放内存、冷启动和安装体积

## Considered Options

- **继续 Electron**：保留现有 TS 网易云实现最省事、生态成熟；但 Node+napi-rs 变成无业务价值的长期边界，且携带完整 Chromium
- **Tauri + Node sidecar**：最大化保留网易云 TS；但三运行时、进程通信、打包和生命周期复杂度更高——否
- **WebView2 + C# 薄壳**：资源占用可控，但引入用户不愿长期维护的第三种语言，并保留双桥——否

## Consequences

- 删除 Electron、@napi-rs/cli、napi/napi-derive；Tauri 应用 crate 在权限与 command 设计完成后再创建
- 保留 React/Vite/Tailwind/zustand/TanStack Query 与 Rust engine 依赖
- 网易云协议层 TS→Rust 是明确迁移工作；现有 TS 实现不废弃，作为规格、PoC 和等价测试 oracle
- Tauri 插件生态比 Electron 小，Windows 长尾集成优先使用 Rust/windows-rs 自研
- Tauri updater 的签名与 capabilities 配置比 electron-updater 更严格，但边界更清楚
- 产品定位保持“现代化 Windows 音乐播放器，差异化 = 自研 DSP”；不恢复内存硬指标
