# Stage 04：HSE Stage 18 Dynamic EQ

状态：已完成

## 当前基础与目标

vendored core 已有 5-band crossover、分析、增益状态与读数；缺少适合 standby/checkpoint 的完整 runtime-state API，其他层未接。本切片完成 adapter、参数/状态、scene/HSE2、工作台和有界 telemetry。

非目标：重写 dynamic EQ，或把 band telemetry 放入 Zustand 高频更新。

## 前置门禁

先补 core runtime state；默认 disabled；telemetry 定频、有界、可丢帧且不影响播放。

## 预计修改与任务

修改 `dynamic_eq.rs` typed state、engine config/adapter、HPTM/telemetry、Tauri DTO、工作台和测试。

1. 定义参数态与运行态边界，补 snapshot/copy/reset。
2. 接入 processor、revision/standby 和故障旁路。
3. 接通 threshold/ratio/attack/release/range DTO 与 HSE2。
4. 发布节流后的每 band reduction/level telemetry。
5. 实现可访问的 band 编辑和读数 UI。

## 测试与验收

覆盖 parity、crossover 连续性、块切分、attack/release、checkpoint、backpressure、零分配、协议 golden bytes 和前端交互。不得宣称 Stage 16/17 已完成。

## 完成后同步

更新 telemetry 说明、handover、验收矩阵和 supported stage 清单。

## 完成记录（2026-09-02）

- 参数态/运行态边界明确，`DynamicEqRuntimeState`（crossover 系数、band 分析/增益平滑、reduction 读数）snapshot/copy/reset 完整；adapter 入生产链（IDS 第 18 位）。
- `band_readings()` 无锁代际 slot 读数口已接 HPTM v4 dynamic-eq 块（generation + 5-band gain/level/reduction）。
- 冻结向量 4 条（按向量顶层 blockSize 回放）；crossover 连续性、attack/release、零分配、disabled 透明测试通过。
