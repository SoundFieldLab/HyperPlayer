# Stage 07：HSE Stage 16 IEQ + Stage 17 Analysis/FFT

状态：已完成

## 当前基础与目标

vendored core 已有 2048 FFT、ring/Hann/magnitude、目标曲线和 10-band IEQ。前端有 Canvas2D spectrum 外壳但无真实数据。本切片联合接入分析数据和 IEQ，避免临时 FFT 协议返工。

非目标：由 vGPU 计算 FFT、传原始 PCM，或把高频数组存进 Zustand。

## 前置门禁

先确定 bounded telemetry 的 bins、频率映射、帧率、有效位和丢帧策略；窗口隐藏/减少动效时停发或降频。

## 预计修改与任务

修改 HSE analysis/IEQ state API、engine DSP/telemetry、HPTM 协议、Tauri channel、Canvas2D fallback、工作台和测试。

1. 分离权威分析运行态、显示快照和 IEQ 参数态。
2. 接 Stage 17 publisher，再接 Stage 16 target/processor。
3. 扩展版本化 telemetry，保持有界、无阻塞、可丢帧。
4. 接 typed DTO、HSE2/scenes 和 unsupported 清单。
5. 实现真实 spectrum、目标/实测曲线与 IEQ 控件。

## 测试与验收

覆盖 FFT 单频/多频 vectors、bin 映射、窗口函数、IEQ parity、块切分、backpressure、隐藏降频、协议 golden bytes、Canvas 非空和多尺寸。不得宣称 vGPU 已接入。

## 完成后同步

更新 HPTM 规范、handover、验收矩阵和 supported stage 清单。

## 完成记录（2026-09-02）

- core 组件化：`SpectrumAnalyzer`（权威分析运行态，typed snapshot/save/restore/copy，restore 零分配）+ `IeqController`（参数态/平滑运行态分离 + `IeqRuntimeState` 四件套）+ `IeqProcessor` adapter 入生产链（IDS 第 16/17 位，loudness-comp 与 dynamic-eq 之间）。
- HPTM 升级：v3 投产 spectrum（96 bins u16 dB，对数频率映射）+ dynamic-eq 5-band + limiter 读数；v4（切片 09）追加 integrated/momentary/short-term LUFS。
- 前端：telemetry schema 严格解码、金样更新、SpectrumCanvas2D 接真实数据、隐藏/减少动效降频；IEQ 控件与 DTO 随中央集成接线。未宣称 vGPU 已接入。
