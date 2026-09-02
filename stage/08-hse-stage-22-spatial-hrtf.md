# Stage 08：HSE Stage 22 Spatial/HRTF

状态：进行中

## 当前基础与目标

vendored core 已有 renderer、world/head-locked/stage、room、stable slots、latency 和测试；HyperPlayer 无生产接线，也没有已确认可再分发的 SOFA/HRTF 产品资产。本切片在资产门禁通过后接入 Stage 22 和 HyperPlayer 自有空间场。

非目标：复制 HSE UI、用 Web Audio 接管播放、捆绑未审计数据。

## 阻塞门禁

必须先记录数据来源、版本、许可证、分发义务、hash 和 provenance。未找到兼容资产时状态为受阻，只能完善外部注入 API 和测试 fixture，不得宣称产品完成。

## 预计修改与任务

修改 HSE resource/state API、engine asset loader/adapter/latency、Tauri capability/DTO、空间场 UI、安装资源和许可证归档。

1. 完成资产审计与 manifest/hash 门禁。
2. 定义非实时加载、验证、缓存和失败回退。
3. 接 renderer、slot checkpoint、tail/latency 和旁路。
4. 接 source/room/head mode DTO、HSE2/scenes。
5. 实现可访问的 2D/2.5D 空间场与 Canvas/DOM fallback。

## 测试与验收

覆盖资源 hash/缺失/损坏、HRTF grid、移动连续性、slot 稳定、latency、checkpoint、零分配、故障旁路、UI 多尺寸及安装许可证复审。

## 完成后同步

更新第三方许可证、provenance、handover、验收矩阵和 supported stage 清单。

## 进展记录（2026-09-02，受阻中已完成受限范围）

- 已交付：`hyperplayer-hrtf-core` 外部资源注入 API（`resource.rs`/`sha256.rs`：descriptor + SHA-256 校验 + provenance 声明 + 失败回退，`HrtfResourceManager` 安装/卸载/不可用语义）与合成 HRIR 测试 fixture（`tests/resource_pipeline.rs` 8 项：hash 不匹配/缺失/损坏/采样率不支持/重载切换与回退/零分配）。

## 进展记录（2026-09-03，资产门禁解除 + 生产接线完成）

- **资产门禁解除**：MIT KEMAR 人工头 HRTF（SOFA SimpleFreeFieldHRIR 转换版，710 位置，44.1 kHz 原生）经许可证审计入库 `assets/hrtf/mit-kemar-normal-pinna.sofa`（SHA-256 `e7035994…`）；许可为「任意用途 + 引用作者」（MIT Media Lab 1994），引用义务落 `THIRD_PARTY_NOTICES.md`/`third_party_licenses/MIT-KEMAR-HRTF.txt`/`provenance/hrtf-mit-kemar/`；hrtf-core 解析器对真实资产验证通过（ignored 全网格测试）。
- **生产接线完成**：hse-core `SpatialStage` 公开 + `build_spatial_stage` 工厂；engine 新 `SpatialProcessor`（IDS 22 链尾，mode=off 默认逐位直通）——编译线程经 SHA-256+SOFA 校验加载 bundle 资源、失败显式旁路 + 诊断、latency/tail 如实上报、拓扑 checkpoint；Tauri 宿主注入资源路径（不持久化、不进 HSE2）、`UNSUPPORTED_STAGES` 清空；工作台 spatial 模块（typed 枚举/约束/校验 + 克制 2D SVG 空间场示意，无 GPU context）。
- 自动化门禁全绿（crates/src-tauri clippy+test、前端 vitest/tsc）。
- **剩余（进入「已完成」前必须完成）**：正式 Tauri/WebView2 实机验收——工作台空间场多尺寸截图与键盘可达性、真实音频设备双耳渲染听感确认、安装包资源/许可证复审（含 NSIS 打包后 SOFA 随行）。完成实机验收后状态改「已完成」。
