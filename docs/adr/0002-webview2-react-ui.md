# WebView2 + React UI，取代「全禁 WebView」（取代 ADR-0001）

---
status: superseded by ADR-0003
date: 2026-08-29
supersedes: 0001-flutter-ui-rust-audio-engine.md
---

> ⚠️ 本 ADR 的「WebView2 + C# 薄壳」已于同日被 **ADR-0003（D13，Electron）** 取代；**React + TS 的 UI 选型与「Rust 引擎保留」部分延续有效**。本文件保留为决策史。

定调 D12：**UI = React + TypeScript**，运行于系统自带 **WebView2**（Windows 10/11 内置，不打包 Chromium，安装包零增量），宿主为 **C# 薄壳**（窗口/托盘/SMTC/媒体键/文件关联原生实现，无业务逻辑）；**Rust 音频引擎保留**（symphonia + 自研 DSP + cpal/miniaudio，见 ADR-0001），经 P/Invoke（C ABI，cbindgen 生成）接入 C# 壳。内存目标回到 **≤ ~100MB**（预期 50~90MB）。

## Considered Options

- **Flutter（ADR-0001 原案）**：动画性能上限最高；但用户对 HTML/React 手感的偏好贯穿全程反复回弹，且内存反而更高（80~150MB）、UI 组件生态需自攒——当天定、当天推翻
- **CEF**：否——80~200MB 与 Electron 同级，C++ 壳/多进程/专有解码自编译三重硬伤；网易云原厂已弃 CEF 转 Electron，无现役大厂把 CEF 当主壳
- **Wails（Go 壳 + WebView2）**：架构等价，但 Go 壳多一门语言与一层 IPC、用户无 Go 背景，无增益
- **Electron / Tauri**：仍然禁止（打包 Chromium，违背立项初衷）

## Consequences

- 红线改写：由「全禁 WebView」收缩为「**禁打包 Chromium**（Electron/Tauri/CEF）；允许系统 WebView2」
- 双桥链路：React ↔（Host Objects/postMessage）C# 壳 ↔（P/Invoke）Rust 引擎——比 flutter_rust_bridge 链路长，接口协议要克制，业务数据不得绕过壳直达 UI
- 壳框架（WPF vs WinForms vs WinUI3）与桥接口协议留待详细设计
- 大厂参照：QQ NT = Electron（闲置 200MB+，专项优化后仍重）；微信 4.0 = C++/Qt 原生（需大团队）；网易云新版 = Electron（原 CEF）。本方案 = 它们的 Web 开发体验 + 系统内核零包体 + 远低于 QQ 的内存
- D2（MIT）不受影响：WebView2 运行时系统自带免费，React/壳/引擎均可 MIT
