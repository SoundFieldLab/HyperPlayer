# Stage 05：HSE Stage 21 Limiter

状态：已完成

## 当前基础与目标

vendored core 已有 lookahead、true peak、reduction 和 latency；HyperPlayer 无 adapter、checkpoint/drain、DTO 或 reduction telemetry。本切片完整处理 latency、尾部 drain、standby 和读数。

非目标：默认开启 limiter，或改变透明默认链。

## 前置门禁

默认 disabled；delay queue/history 必须可迁移；设备/曲目切换的 latency compensation 语义可测试。

## 预计修改与任务

修改 HSE limiter state API、engine chain/latency/tail、Tauri config/telemetry DTO、工作台 meter 和测试。

1. 补 delay/history checkpoint 和 drain API。
2. 接入 adapter，并纳入统一 latency 计算。
3. 接通 ceiling/lookahead/release 参数与 HSE2/scenes。
4. 发布 true peak 和 gain reduction telemetry。
5. 实现控件、meter 和 bypass 对比。

## 测试与验收

覆盖超限 impulse、intersample peak、lookahead、drain、切链、checkpoint、不同 sample rate/block size、零分配和 telemetry golden bytes。默认 disabled 满足现行透明契约。

不得把 compatibility true peak 表述成未验证的标准认证结果。

## 完成后同步

更新 latency/tail 文档、handover、验收矩阵和 supported stage 清单。

## 完成记录（2026-09-02）

- `LimiterRuntimeState`（delay queue/gain history/peak state）checkpoint 四件套 + `drain()` 排空 API；adapter 入生产链（链尾，lufs tap 之后），lookahead latency 如实上报并汇入链级计算。
- reduction/true-peak 读数口已接 HPTM v4 有效位；对外文案仅「兼容性真峰值检测」，不宣称标准认证。
- 冻结向量 4 条；超限 impulse、intersample peak、drain、切链、零分配测试通过。
