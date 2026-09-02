# Stage 06：HSE Stage 20 Modulation / Master Targets

状态：已完成

## 当前基础与目标

vendored core 已有 LFO、envelope、routes、master gain 和 stereo width targets；HyperPlayer 只有可复用 M/S processor，缺跨 processor 控制信号和状态迁移。本切片建立受限、typed 的 modulation routing。

非目标：任意图编程、脚本调制，或让前端参与 sample-rate 控制。

## 前置门禁

目标参数白名单化；调制值规范化且有限幅；base value 与 modulation delta 所有权明确；默认 disabled。

## 预计修改与任务

修改 HSE routing/state、engine graph/config、Tauri DTO/HSE2/scenes、工作台 routing UI 和测试。

1. 固化 source、target、depth、polarity、smoothing schema。
2. 补 phase/envelope checkpoint。
3. 接受支持 targets，避免跨线程共享可变态。
4. 实现严格 DTO 校验和 routing 编辑器。
5. 验证 chain swap、旁路和非法 route fail closed。

## 测试与验收

覆盖 LFO/envelope parity、route 组合、限幅、块切分、checkpoint、非法 target、零分配、HSE2 round-trip 和键盘操作。支持目标矩阵必须显式列出。

## 完成后同步

更新目标矩阵、handover、验收矩阵和 supported stage 清单。

## 完成记录（2026-09-02）

- core 补 `ModulationMatrixRuntimeState`（LFO 相位/包络/路由平滑）checkpoint 四件套；adapter 入生产链（IDS 第 20 位，lufs 之后、limiter 之前）。
- 受限 typed routing：source 白名单 `lfo|envelope`、target 白名单 `masterGain|stereoWidth`（严格解析、枚举外拒绝，不复刻 TS fallback）；depth ∈ [0,16]、极性恰 ±1、路由 ≤ 8 条、fail closed；master targets 由本 processor 本位应用，不跨线程共享可变态。
- 支持目标矩阵：masterGain（线性乘，钳 [0,4]）、stereoWidth（M/S 逆变换，钳 [0,2]，恒等跳过）。冻结向量 4 条（stereoWidth 产物不入向量，应用路径由组合逐位测试覆盖）。
