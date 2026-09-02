# HyperPlayer 后续实施切片

> 更新日期：2026-09-02  
> 状态：01、02-07、09、10-13 已完成；08 受阻；其余待选择  
> 性质：实施切片索引，不取代正式需求、ADR 或定调记录

## 使用规则

- 冲突优先级：`AGENTS.md` > 最新 D/UI-D 决策 > 有效 ADR > 需求/UI 基线 > 本目录。
- 每次先选择一个切片；实施前重新核对代码和依赖，完成测试后再更新状态。
- 状态只使用：`待选择`、`进行中`、`受阻`、`已完成`。
- “已完成”必须同时满足代码、测试、文档和实际运行门禁，不能以模型或接口存在代替产品闭环。
- 默认在 `main` 上按既定流程推进；不提前记录未经测试的完成结论。

## 当前真实位置

2026-09-02：基于 HEAD `954a261` 的工作树（DSP 全量改动**尚未提交**）已完成 DSP 切片 `02-07、09`。生产链现接入 Stage `1-15、16/17、18-21` 共 21 个处理器（vendored HSE Rust 实时执行，默认全 disabled）；仅 Stage 22 spatial 因合规 HRTF 资产缺失保持受阻（受限外部注入 API 与测试 fixture 已交付，见切片 08）。

DSP 控制面已闭环（切片 09）：版本化持久配置 + fail-close 迁移、revision 跨重启恢复、HSE2/scenes 21-stage round-trip（少量 HyperPlayer-only 参数按缺省还原，清单见切片 09 遗留边界）、HPTM v4（spectrum / dynamic-eq / limiter / LUFS 字段）与 `MeterMode::{HseV151 默认, ItuBs1770_5}` 双模式（标准模式待向量认证，不得宣称合规）。

D30 切片 `01、10-13` 已完成（schema v7、quota runtime、Windows 资源探针、album-fill worker、Settings UI）。剩余主线：`14` gapless/增量解码 → `15` Windows 集成 → `16` 网易云 → `17` vGPU → `18` 发布。`handover.md` 中"工作树待提交"仍成立：本轮 DSP 改动等待用户审阅后按切片分批提交。

## 切片地图

| 编号 | 切片 | 直接依赖 | 规模 | 主要风险 | 状态 |
|---|---|---|---|---|---|
| 01 | [D30 启动 reconciliation runtime](01-d30-startup-reconciliation-runtime.md) | 无 | 中 | 文件系统/数据库崩溃一致性 | 已完成 |
| 02 | [HSE Stage 13 Reverb](02-hse-stage-13-reverb.md) | 无 | 大 | IR 生命周期、tail、latency | 已完成 |
| 03 | [HSE Stage 15 Loudness Compensation](03-hse-stage-15-loudness-compensation.md) | 无 | 中 | 参数平滑、checkpoint | 已完成 |
| 04 | [HSE Stage 18 Dynamic EQ](04-hse-stage-18-dynamic-eq.md) | 无 | 大 | 多 band 状态迁移、telemetry | 已完成 |
| 05 | [HSE Stage 21 Limiter](05-hse-stage-21-limiter.md) | 无 | 大 | lookahead、true peak、drain | 已完成 |
| 06 | [HSE Stage 20 Modulation](06-hse-stage-20-modulation.md) | 目标接口稳定 | 大 | 跨 Stage 控制信号 | 已完成 |
| 07 | [HSE Stage 16/17 IEQ + Analysis](07-hse-stage-16-17-ieq-analysis.md) | telemetry 设计 | 大 | FFT 高频数据、联合状态 | 已完成 |
| 08 | [HSE Stage 22 Spatial/HRTF](08-hse-stage-22-spatial-hrtf.md) | 合规 HRTF 资产 | 特大 | 许可证、资源、latency | 受阻 |
| 09 | [DSP 控制面闭环](09-dsp-control-plane-closure.md) | 02-08 | 大 | 配置迁移、计量语义 | 已完成 |
| 10 | [D30 quota runtime](10-d30-quota-runtime.md) | 01 | 中 | 淘汰正确性、lease 保护 | 已完成 |
| 11 | [D30 Windows 资源探针](11-d30-windows-resource-probes.md) | 01 | 中 | 系统 API 与未知状态 | 已完成 |
| 12 | [D30 album-fill worker](12-d30-album-fill-worker.md) | 01、11 | 大 | 权益、下载恢复、资源门禁 | 已完成 |
| 13 | [D30 Settings UI](13-d30-settings-ui.md) | 10-12 | 中 | DTO/持久化一致性 | 已完成 |
| 14 | [增量解码与真正 gapless](14-playback-gapless-and-incremental-decode.md) | 无 | 特大 | codec trim、实时切换 | 待选择 |
| 15 | [Windows 音频与壳集成](15-windows-audio-and-shell-integration.md) | 14 部分能力 | 大 | 设备恢复、实机验收 | 待选择 |
| 16 | [网易云产品闭环](16-netease-product-closure.md) | D30 权益链 | 特大 | Cleanroom、真实账号 | 待选择 |
| 17 | [vGPU 可视化](17-vgpu-visualization.md) | 07/09 telemetry | 大 | WebGPU 降级、device loss | 待选择 |
| 18 | [发布与分发闭环](18-release-and-distribution.md) | 产品功能稳定 | 大 | 签名密钥、升级、许可证 | 待选择 |

## 推荐顺序

D30 `01 → 10 → 11 → 12 → 13` 与 DSP `02 → 03 → 04 → 05 → 06 → 07 → 09` 已于 2026-09-02 完成（门禁全绿、待提交）；Stage 08 保持受阻，必须等待合规 HRTF 资产。播放正确性在平台和发布前完成：`14 → 15`。网易云、可视化和发布分别在依赖成熟后进入 `16 → 17 → 18`。

若优先播放核心正确性，选 14；若优先可视化，选 17（其依赖的 07/09 telemetry 已就绪）；不要把解码、网易云和发布三条高风险线混入同一提交。

## 统一完成门禁

每份切片完成后执行适用的前端 Vitest/build、engine/Tauri Rust fmt、strict Clippy、workspace tests、网易云 oracle 和许可证门禁。涉及 UI、音频设备、账号、WebGPU 或安装器时，自动测试不能替代正式 Tauri/WebView2、真实硬件/账号或 Windows 安装升级验收。

完成后同步 `handover.md`、`tests/ACCEPTANCE_MATRIX.md`，并只把已经实测的状态回写 `docs/需求基线.md` 或相关定调记录。
