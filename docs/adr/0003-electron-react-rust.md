# Electron 全面改案：React UI + Node 壳 + Rust 引擎（取代 ADR-0002）

---
status: superseded by ADR-0005
date: 2026-08-29
supersedes: 0002-webview2-react-ui.md
---

> ⚠️ 本 ADR 的 Electron 主进程、napi-rs 桥和打包方案已于 2026-08-30 被 **ADR-0005（D21，Tauri 2）** 取代。React + TypeScript UI 与 Rust 引擎方向延续有效；本文保留为决策史。

定调 D13：**推翻立项的「反 Electron / 轻量化」前提**。技术栈定为 **Electron + React/TypeScript**——渲染进程（UI）与主进程（壳）同为 TS，用户单语言全栈；**Rust 音频引擎保留**（symphonia + 自研 DSP + cpal/miniaudio，ADR-0001 确立），经 **napi-rs**（Node↔Rust FFI）接入主进程。产品定位由「轻量级播放器」改为「**现代化 Windows 音乐播放器，差异化 = 自研 DSP**」；≤100MB 内存指标作废（现实预期空闲 150~250MB、播放 200~400MB，参照 QQ NT 优化后闲置 ~200MB）。

## Considered Options

- **WebView2 + C# 薄壳（ADR-0002）**：内存最优（50~90MB）且守住轻量定位；但用户需学 C#、双桥链路复杂、打包/更新/崩溃上报轮子自造——单人项目完工概率优先级更高
- **Flutter（ADR-0001）**：动画上限最高，但非 HTML/React，与用户贯穿全程的偏好不符（当日定、当日推翻的教训）
- **Tauri**：Rust 壳与用户 Rust 技能匹配且轻量，但 IPC/插件生态摩擦大于 Electron；用户在知悉 QQ NT/网易云案例后主动选择 Electron 生态——记录在案
- **CEF**：否——比 Electron 更重更难（C++ 壳/多进程/专有解码自编译），网易云原厂也已弃 CEF 转 Electron

## Consequences

- 三份调研报告降级为史料与功能清单参考，不再约束选型；「轻量级」从产品定位中移除
- Electron 现实代价知情接受：安装包 70~150MB、空闲 150~250MB；不设内存硬指标，做常规优化（懒加载、进程纪律）
- 桥接两段：渲染进程 ↔（Electron IPC，contextBridge/preload）主进程 ↔（napi-rs）Rust 引擎；主进程是唯一翻译层
- 自动更新/打包/崩溃上报走 electron-builder 生态；SMTC/媒体键需调研原生模块（详细设计）
- D1/D2/D3/D6~D11 不受影响；D5 全废；D12 的 React UI 与引擎保留部分延续
