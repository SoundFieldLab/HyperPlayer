# Stage 03：HSE Stage 15 Loudness Compensation

状态：已完成

## 当前基础与目标

vendored core 已有 auto/preset/custom 和 6-band 平滑处理；HyperPlayer 无 adapter、DTO、HSE2 投影和工作台。本切片接入完整生产路径并保留 HSE v1.5.1 行为。

非目标：把 loudness compensation 与 LUFS 标准合规混为一谈，或在前端处理音频。

## 前置门禁

默认 disabled；音量输入和参数更新语义必须明确；runtime state copy 不得分配或丢失平滑状态。

## 预计修改与任务

修改 HSE loudness typed state、engine DSP config/adapter、Tauri DSP DTO/HSE2/scenes、工作台模块和测试。

1. 暴露规范化参数、checkpoint/reset 和必要 telemetry。
2. 实现 adapter、链顺序、revision/standby 迁移。
3. 接通 auto/preset/custom DTO、严格范围校验和 HSE2 round-trip。
4. 实现模式、目标/强度和自定义 band 控件。
5. 证明 disabled 透明和异常安全旁路。

## 测试与验收

覆盖 HSE parity、不同 block size、音量变化平滑、checkpoint、极端 sample rate、零分配、Tauri/前端序列化及交互。不得据此宣称 BS.1770-5 meter 合规。

## 完成后同步

更新 supported stage 清单、handover、验收矩阵和本文件状态。

## 完成记录（2026-09-02）

- mode 裸 String 改为 `LoudnessCompMode` 枚举（serde 兼容旧字符串）；6-band 平滑状态完整进 RuntimeState，checkpoint fail-closed、跨代次（音量 revision 迁移）平滑连续收敛。
- adapter 入生产链（IDS 第 15 位）；块长调度是引擎契约的一部分（同调度逐位可复现）。
- 冻结向量 4 条；HSE `loudnessCompensation` 7 字段全量投影、无缺省还原项。
