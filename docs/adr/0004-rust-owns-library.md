# Rust 拥有曲库：扫描、元数据与 SQLite 全在引擎侧

---
status: accepted
date: 2026-08-29
---

详设 D14：Rust 引擎/领域库拥有「文件→数据库」整条链——目录扫描、lofty 元数据/封面解析、rusqlite 曲库存储，全部在 Rust 线程域内完成；桌面框架应用层只做 command 编排、系统集成和生命周期管理，不碰大文件 IO；React 纯 UI。理由：万级曲库的扫描与解析是最重的 IO/计算，同语言内闭环可做到零跨语言搬运、WebView 前端零阻塞；lofty 本就是 D9 钦点；曲库查询与扫描进度通过框架 command/event/channel 暴露。该边界在 ADR-0005 从 Electron 迁移到 Tauri 2 后保持不变。

## Considered Options

- **SQLite/扫描放 Node（better-sqlite3 + music-metadata）**：TS 代码量最大、出活最快；但大库扫描需 worker 防阻塞、文件 IO 跨两层、元数据解析性能弱于 lofty——被否
- **全 Node、Rust 最薄**：同上且明确接受性能妥协；万级曲库场景大概率返工——被否

## Consequences

- Rust 工作量增加（扫描器、DB schema、查询 API），不止 DSP
- Tauri command/event/channel 接口面需覆盖：曲库查询、扫描启动与进度、播放控制、引擎状态回推——接口协议是详细设计的重点产出物
- React/WebView 侧永远不做大文件 IO；Tauri 应用层只编排，防止曲库逻辑逐渐泄漏出 engine/domain crate
