# Flutter UI + 自研 Rust 音频引擎，全禁 WebView

---
status: superseded by ADR-0002
date: 2026-08-29
---

> ⚠️ 本 ADR 的「全禁 WebView」与「UI = Flutter」已于同日被 **ADR-0002（D12）** 推翻；**自研 Rust 音频引擎部分仍然有效**。本文件保留为决策史。

HyperPlayer 是 MIT 开源的 Windows 轻量级音乐播放器，差异化核心是作者自研的 DSP（TS 可用、Rust 迁移收尾中，Rust 为准）。定调决定：**UI 采用 Flutter Desktop（Dart）；音频采用自研 Rust 引擎——symphonia 解码 + 自研 DSP 管线 + cpal/miniaudio（WASAPI）输出；两层经 flutter_rust_bridge 桥接；一切 WebView 架构（Electron/Tauri/Wails/WebView2/本地服务+浏览器）全禁**。禁的是架构本身，而非仅「打包 Chromium 太重」。

## Considered Options

- **Electron / Tauri / Wails / WebView2 嵌入**：全禁——用户明确反 WebView 架构本身，React+HTML UI 的诉求由此放弃（换来 Flutter 的声明式+热重载作补偿）
- **Rust + Slint**（调研报告首选）：Slint 为 GPL 双授权，与 D2 的 MIT 冲突，排除
- **media_kit（libmpv）**：解码能力最强，但 libmpv 拥有整条音频管线，自研 DSP 融入受限——DSP 一等公民原则否决之
- **just_audio**：Windows 后端不成熟、格式覆盖窄、无 gapless/EQ
- **纯 Rust 原生 GUI（iced/egui）**：内存最优，但 UI 表现力与开发体验不满足「界面好看优先」（D4）
- **C# WinUI3/Avalonia**：Windows-only 最稳，但用户技能在 TS/Rust，且同样不满足 D4

## Consequences

- 播放队列、gapless、标签解析等播放器胶水层需自建；元数据用 lofty（MIT）
- 内存目标由 20~100MB 上调至 ~150MB（用户知情接受）
- Dart 与 Rust 双语言、flutter_rust_bridge 生态依赖，是长期维护成本
- DSP 是管线一等公民：任何引擎重构不得破坏其插入点；WASAPI 独占/HiFi 输出有自然扩展位
- 官方内置音源（D10）与本项目 MIT/认真开源定位存在张力，风险自担；音源模块必须独立隔离、可整体禁用
