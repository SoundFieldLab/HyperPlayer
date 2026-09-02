# Stage 08：HSE Stage 22 Spatial/HRTF

状态：受阻

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

- 已交付：`hyperplayer-hrtf-core` 外部资源注入 API（`resource.rs`/`sha256.rs`：descriptor + SHA-256 校验 + provenance 声明 + 失败回退，`HrtfResourceManager` 安装/卸载/不可用语义）与合成 HRIR 测试 fixture（`tests/resource_pipeline.rs` 8 项：hash 不匹配/缺失/损坏/采样率不支持/重载回退/零分配）。
- 仍受阻：仓库内无可再分发合规 SOFA/HRTF 产品资产；资产来源/版本/许可证/分发义务/hash/provenance 记录完成前不接生产链、不做 DTO/空间场 UI、不宣称产品完成。资产到位后另开一轮完成剩余任务 2-5。
