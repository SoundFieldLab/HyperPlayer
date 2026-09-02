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
- **BS.1770-5 解析向量认证（2026-09-02 补做）**：`ItuBs1770_5` 从占位标签升级为真实标准路径——块功率按标准通道功率和 Σ G_i·z_i（2.0 声道 G_L = G_R = 1.0）累积，取代兼容路径的波形和 z = yL+yR（同相内容下波形和比功率和高 10·log10(2) ≈ 3.010 LU，反相内容会被波形和错误归零）；绝对门 -70 LUFS、相对门（gated mean -10 LU）、400ms 块 75% 重叠、momentary 400ms / short-term 3s、true peak 4× 过采样与兼容路径一致（本就是标准规定）。新增 `crates/hyperplayer-hse-core/tests/bs1770_vectors.rs` 九条解析向量测试（电平锚点 0/-20/-23 dBFS 与 44.1 kHz 精确系数路径、dual-mono 与单声道馈入 ±3.0103 LU 语义、绝对门剔除、相对门剔除与纳入对照、400ms/3s 块时域收敛、采样间真峰值、两模式分离性、跨模式状态复制拒绝），全部命中解析期望（认证容差 ±0.1 LU，锚点收紧至 0.02）。HseV151 默认路径与全部既有 golden 数值保持逐位不变（365 项 hse-core 单元测试 + engine 295 项 --lib + telemetry_golden 全绿）。

## 遗留边界（显式不做/待办）

- ~~**scenes 逐场景定制未做**~~：**已完成（2026-09-02）**——TS `ScenePresets.ts` 与 Rust `scenes.rs` 逐字段镜像 12 场景对 ieq/dynamicEq/modulation/limiter 的显式取值（classical/vocal-stage 轻度 ieq、dance/heavy-bass 低频带 dynamicEq、dts/night-bass/heavy-bass 差异化 limiter、modulation 全场景显式关闭），`scripts/export-scenes-fixture.mjs` 从 TS oracle 重生成 `scenes.48000.json`，provenance 如实标注 `1.5.1-hyperplayer-scenes-ext`（不再是纯上游 v1.5.1 导出）。
- ~~**BS.1770-5/EBU 认证未做**~~：**解析向量认证已完成（2026-09-02）**——`ItuBs1770_5` 已实现标准通道功率和路径并通过 **BS.1770-5 解析向量认证（±0.1 LU）**（见 `crates/hyperplayer-hse-core/tests/bs1770_vectors.rs` 与上方完成记录）。**未使用、未分发官方 EBU Tech 3341/3342 测试文件（有版权限制），官方测试集验证仍开放**；不得宣称「已通过 EBU 认证」或「BS.1770-5/EBU 官方合规」。另注：共享 4× 真峰值多相核为 TS oracle 冻结行为，有效截止 ≈ fs/8（6 kHz @48 kHz，golden 锁死不可改），高于该截止的采样间峰值本实现不可检出，已记入 V5 向量注释。
- **HSE2 有损缺省还原项（保留现状）**：reverb `fdnLines/partitionSize/shortRegionMs`、dynamicEq `kneeDb/blockSize/带内频率`、modulation route 的 `depth/polarity` 分离——这些是 HyperPlayer-only 参数，不在 HSE 分享 schema 白名单；强行无损化需改 hse-core share_codec 并破坏冻结 TS-parity，故按缺省还原并在导入文案标注。
