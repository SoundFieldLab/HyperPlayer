# HyperPlayer — Agent 指南

## 项目简介

HyperPlayer 是一款**现代化 Windows 桌面音乐播放器**（Electron + React/TS + Rust 音频引擎）。当前仓库处于**技术选型已定案、详细设计阶段，尚无任何代码**。

## 硬性约束

- 技术栈定案 **Electron**（D13）：立项时的「反 Electron / 禁打包 Chromium / 轻量化」前提已**正式作废**，`docs/` 里的三份调研报告降级为史料与功能清单参考
- 许可证 **MIT**：依赖只收 MIT/Apache/BSD；GPL 组件不引入；LGPL 仅限动态链接且需评估
- **只发 Windows**（Electron 跨平台能力保留，未来可逆）
- 内存**不设硬指标**（Electron 现实预期空闲 150~250MB），工程上做常规优化（懒加载、进程纪律）
- **自研 DSP 是一等公民**：音频管线必须保留其插入点；DSP 为 TS+Rust 双实现，Rust 为准
- 官方内置在线音源：模块隔离、可整体禁用，不与播放核心/引擎耦合（版权风险自担，用户知情决策）

## 工作流程约束（用户定调，2026-08-29）

- **定调已完成**（结论见 `docs/定调决策记录.md` 与 `docs/需求基线.md`）；在用户明确开口前仍**不写实现代码、不搭脚手架、不初始化构建体系**——当前阶段只做详细设计与规划
- **所有规划文件写入 `docs/`**：需求、决策记录、ADR、术语表等一律放 `docs/`（已被 gitignore，不入库）
- **约束同步**：每轮定调产生的新约束，同步更新本文件与持久记忆

## 目录结构

- `docs/` — 三份技术栈调研报告（按生成模型命名：DeepseekV4Flash / Doubao Turbo / Qwen3.8Max）+ 后续所有规划文档（需求基线、ADR 等），已被 gitignore。**改动技术栈决策前必读。**

## 技术栈（已定案 2026-08-29，D13 现行）

- **UI**：React + TypeScript（Vite，渲染进程）
- **壳**：Electron 主进程（Node/TS）——窗口/托盘/自动更新/系统集成，无业务逻辑
- **音频引擎**：自研 Rust 库 —— symphonia 解码 + 自研 DSP 管线 + cpal/miniaudio（WASAPI）输出，独立线程
- **桥**：渲染↔主进程走 Electron IPC（contextBridge/preload）；主进程↔引擎走 napi-rs
- **元数据/曲库**：lofty（Rust）+ SQLite
- 决策依据：`docs/定调决策记录.md`（D1~D13）、`docs/adr/0003-electron-react-rust.md`（取代 0002/0001 的壳与红线部分）；改栈前必读并新增 ADR
- 统一术语表：`docs/CONTEXT.md`

## 构建 / 测试

暂无构建体系、测试或 lint 命令。**不要凭空猜测或运行任何构建/测试命令。**技术栈定案后在此登记实际命令。

## 仓库注意事项

- `docs/` 已写入 `.gitignore`，调研文档不入库
- 文档与注释语言：中文
- 新增调研文档放 `docs/`，命名沿用 `调研报告<名称>.md`
