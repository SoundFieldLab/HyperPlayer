# Stage 02：HSE Stage 13 Reverb

状态：已完成

## 当前基础与目标

vendored HSE core 已有算法/FDN/卷积模式、IR、prepare/reset、latency 和 tail；其他生产层未接。本切片完成 typed 参数、`PcmProcessor` adapter、revision/checkpoint/standby、tail/drain、scene/HSE2 和 HyperPlayer 自有工作台。

非目标：重写混响算法、复用 HSE UI、引入未审计 IR。

## 前置门禁

仅使用许可证和 hash 已审计的 IR；IR 解码/构建在非实时线程完成；默认 disabled，实时线程零分配、无锁等待。

## 预计修改

HSE core typed state API、engine DSP config/adapter、Tauri DSP DTO/commands、TS store/API、DSP 工作台及跨层测试。

## 实施任务

1. 补 core checkpoint、tail、latency、IR identity/state copy API。
2. 新增 adapter 并确定 production chain 顺序。
3. 扩展 config/DTO 校验、scene/HSE2 round-trip 和 unsupported 清单。
4. 实现模式、时间、阻尼、wet/dry 等控件。
5. 验证 latest-wins、standby 迁移、drain 和故障零 DSP 旁路。

## 测试与验收

覆盖 parity vectors、块切分、impulse/tail、latency、checkpoint、参数极值、零分配、故障旁路和前端/command round-trip。默认 disabled 输出必须保持现行透明契约。

不得宣称第三方 IR 已合规。建议 core API、engine/IPC、UI 分 2-3 个提交，统一验收后才完成。

## 完成后同步

更新 supported stage 清单、handover、验收矩阵和 DSP 文档。

## 完成记录（2026-09-02）

- 三模式（algorithmic/fdn/convolution）统一 `ReverbProcessor` 已入生产链（IDS 第 13 位，tremolo 与 bass-enhancer 之间）；core 三模块补齐 RuntimeState 四件套、tail/latency、IR 指纹身份 API。
- IR 仅确定性配方（Delta/ExpNoise），无第三方 IR 文件解码；卷积拓扑/IR 更换 = checkpoint 重建语义。
- 冻结向量 11 条入 `tests/fixtures/dsp/`（convolver/fdn-reverb/reverb-simple）；默认 disabled 逐位透明，实时零分配门禁通过。
