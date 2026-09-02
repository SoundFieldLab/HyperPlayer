# Stage 09：DSP 控制面闭环

状态：已完成

## 当前基础与目标

现有 14-stage 有 strict revision、12 scenes、HSE2、工作台和 HPTM v2；配置重启恢复 revision 1，LUFS 是 compatibility 语义，最终 telemetry 未闭环。本切片在 22-stage 接入后完成持久化、迁移、revision 恢复、完整 round-trip、标准/兼容计量和最终 telemetry。

非目标：改变 HSE 算法来伪造 parity。

## 前置门禁

依赖 Stage 02-08 schema 稳定；持久化原子写；未知字段策略明确；播放线程不参与磁盘写入。

## 预计修改与任务

修改 engine config/version、Tauri storage/commands、TS DTO/store、HSE2/scenes、HPTM、工作台计量 UI 和迁移测试。

1. 定义版本化持久配置和迁移。
2. 恢复 revision monotonicity，处理损坏/回退/并发更新。
3. 完成全 stage scene/HSE2 round-trip。
4. 增加独立 `ITU BS.1770-5` 模式，保留标注清楚的 compatibility 模式。
5. 固化 LUFS、true peak、reduction、FFT telemetry 和 UI。

## 测试与验收

覆盖跨版本迁移、原子写失败、损坏配置、重启恢复、latest-wins、HSE2 golden files、标准 vectors、backpressure、全链旁路和 Tauri 实机恢复。

标准 vectors 和误差范围通过前不得宣称 BS.1770-5/EBU 合规。

## 完成后同步

更新 HSE2/HPTM 规范、handover、验收矩阵和需求基线中的实测状态。

## 完成记录（2026-09-02）

- 版本化持久配置：settings.json `dsp` 段（`PersistedDspConfig{version, revision, configuration}`），缺失/未知版本/损坏一律 fail-close 回落 default；apply 成功路径原子写回，播放线程不参与磁盘写入。
- revision 跨重启恢复：启动以持久化 revision 为 newest 起点并向引擎 apply；失败回落 default 并输出诊断。
- HPTM v4：856 字节，新增 integrated/momentary/short-term LUFS + `TELEMETRY_VALID_LUFS`；v2 固定区与 v3 dynamic-eq 块逐字节保留；前端严格解码 + 金样更新，Stage 19 工作台改读真实 LUFS/true-peak/limiter 读数。
- 计量双模式：`MeterMode::{HseV151(默认，兼容路径不变), ItuBs1770_5}`，贯穿 DspConfig/DTO/前端；FFT 复用既有 spectrum bins，未新增独立 FFT 字段。

## 遗留边界（显式不做/待办）

- **scenes 逐场景定制未做**：`scenes.rs` 12 场景未对 ieq/dynamicEq/modulation/limiter 做逐场景参数定制，保留 default 骨架；需扩展 `build_scene` 并重生成 fixture。
- **BS.1770-5/EBU 认证未做**：`ItuBs1770_5` 模式已实现并默认关闭，但标准 vectors 与误差范围未通过，不得宣称 BS.1770-5/EBU 合规。
- **HSE2 有损缺省还原项（保留现状）**：reverb `fdnLines/partitionSize/shortRegionMs`、dynamicEq `kneeDb/blockSize/带内频率`、modulation route 的 `depth/polarity` 分离——这些是 HyperPlayer-only 参数，不在 HSE 分享 schema 白名单；强行无损化需改 hse-core share_codec 并破坏冻结 TS-parity，故按缺省还原并在导入文案标注。
