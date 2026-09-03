# HyperPlayer 当前交接

更新时间：2026-09-02

> 本文件记录当前事实状态。它覆盖产品、HSE/DSP、telemetry、UI、缓存、网易云、音频和测试证据；`handover-visualization.md` 保留可视化专项细节，其中部分"未完成"描述已被后续实现覆盖。

## 1. 一句话结论

HyperPlayer 已形成可运行的 Tauri 2 + React/TypeScript + Rust Windows 播放器主干，并完成本地播放/曲库/队列/歌词、部分网易云、D23/D24、部分缓存、真实 DSP runtime、HSE v1.5.1 核心 vendoring（含 source/destination/derivation hash gate）、14 个生产处理器、正式 DspPort、12 scenes、HSE2 投影、原生 DSP 工作台和 HPTM v2 端到端 telemetry 链路。

**项目仍未达到 v1 全功能完成。** 当前主要缺口包括：

- HSE 完整 22 阶段已全部进入 HyperPlayer 生产播放链（Stage 1–22 共 22 个处理器，默认全 disabled）；Stage 22 spatial 资产（MIT KEMAR）已审计入库并经 SHA-256 校验加载，剩实机验收；
- D30 已完成 schema v7、v6 备份、缓存策略/淘汰/离线证明、runtime worker、Windows 资源探针、album-fill worker 与 Settings UI（切片 01、10-13）；
- MP3/FLAC 增量解码与真实 codec trim 已完成（Stage 14 增量部分）；preparation worker、实机 gapless 验收、设备切换、独占模式和完整 Windows 集成未完成；
- 网易云仍有较多路由、UI 工作流和受控账号外部验收缺口；
- vGPU/WebGPU 尚未真正接入；
- DSP 配置已版本化持久化（`settings.json` 内 `dsp` 段，version=1 + revision + DTO），重启恢复 revision 与配置；标准 BS.1770-5 模式已通过解析向量认证 ±0.1 LU（未使用官方 EBU Tech 3341/3342 测试文件，不宣称 EBU 认证；默认保持 HSE v1.5.1 兼容）；Stage 19 LUFS/true-peak/limiter/FFT telemetry 已固化到 HPTM v4；
- DSP 22-stage 与 D30 shell 接线已分批提交；实机验收（spatial 听感/UI 多尺寸）待用户确认。

功能完成必须满足完整证据链：

```text
定调要求
→ Rust/TS 领域实现
→ Tauri IPC
→ frontend bridge
→ UI 工作流
→ 自动测试
→ 正式 Tauri/WebView2 / 公网 / 账号 / 硬件验收
```

测试数量、route catalog 数量和文件存在都不能单独证明端到端完成。

---

## 2. 当前 Git 与工作树状态

- 当前分支：`main`
- 当前 HEAD：`a4e5b32 docs: track splash screen launch spec`
- `main` 与 `origin/main` 在 `a4e5b32` 同步（ahead/behind `0/0`）。
- 当前工作树超过 100 个变更路径，属于本轮未提交实现：HSE TS 去重与 vector provenance、HPTM golden bytes、Stage 1/2/7 core 化与 direct façade 清理、DspPort/HSE2/presets/工作台、UI 双栏/双主题修复、D30 schema v7 核心与测试。
- 先前 handover 记录为“待提交”的 HPTM、standby safe-bypass 和 destination gate 已分别在 `64ecbba`、`8e4e48a`、`4d57efb` 提交；当前工作树没有重复保留那三批旧修改。
- `src-tauri/gen/`、`*.tmp`、`dist/`、`node_modules/` 和 Rust `target/` 继续按生成物/缓存忽略。

历史已合并基线：

1. `7137bea feat(netease): close runtime playback and image gaps`
2. `c9b239d feat(engine): persist playback history and entitlement locks`
3. `23ef617 feat(desktop): close playback context and desktop actions`
4. `39de988 feat: close library and anonymous discovery workflows`
5. `0be5403 Merge pull request #2 from SoundFieldLab/feat/p0-netease-runtime-closure`
6. `2fa069c docs: record vgpu visualization policy`

---

## 3. 权威定调与长期约束

后续继续实现前必须读取：

| 能力 | 权威输入 |
|---|---|
| 产品范围、里程碑、D21/D29/D30/D31 | `docs/需求基线.md`、`docs/定调决策记录.md` |
| Tauri / Rust / 曲库所有权 | `docs/adr/0004-rust-owns-library.md`、`docs/adr/0005-tauri2-react-rust.md` |
| UI 信息架构与视觉基线 | `docs/UI设计基线.md`、`docs/UI定调决策记录.md` |
| 启动页 Splash 定调 | `docs/启动页面定调文件.md` |
| 网易云 Cleanroom | `docs/音源-网易云-行为规范.md`、`src/audio-source/netease/` oracle |
| 自动化与外部验收 | `tests/ACCEPTANCE_MATRIX.md` |
| HSE 使用、修改、融合和分发 | `LICENSE-HSE-AUTHORIZATION.md` |
| Agent 硬约束 | `AGENTS.md` |
| telemetry/UI 专项 | `handover-visualization.md` |

硬约束摘要：

- 现行栈固定为 Tauri 2 + React/TypeScript + Rust，Windows 使用系统 WebView2。
- 不恢复 Electron、Node sidecar、napi-rs 或打包 Chromium。
- Rust 是实际播放和 DSP 权威；TS 是独立 oracle、参数/预设/HSE2 兼容、预览和诊断实现。
- 网易云继续 Cleanroom；参考代码不入库、不复制进实现。
- 不提供音乐文件下载/导出。
- AccountEntitled 缓存继续 fail closed。
- 正式 UI 只在 Tauri/WebView2 中验收，不以浏览器 mock 作为产品验收。
- vGPU 只能承担可选渲染，不能成为 DSP/FFT/LUFS/HRTF 权威计算或播放必要条件。

---

## 4. HSE v1.5.1 vendoring 与完整性状态

### 4.1 固定来源

- checkout：`temp/hse-v1.5.1/`
- tag：`v1.5.1`
- tag object：`3602b86906e6a345baaf6e87fe559f80ed399cc4`
- commit：`f7017621b7d84005fbfed8a3c42a119487a17326`
- 项目专项授权：`LICENSE-HSE-AUTHORIZATION.md`

### 4.2 已复制到正式项目

Rust：

- `crates/hyperplayer-hse-core/`，版本 1.5.1
- `crates/hyperplayer-hrtf-core/`，版本 1.5.1
- 已注册到 `crates/Cargo.toml` workspace。
- `hyperplayer-engine` 已通过精确版本 path dependency 使用 `hyperplayer-hse-core`。

TypeScript：

- `shared/hse-ts-core/`
- 私有包名：`@hyperplayer/hse-ts-core`
- 包含 DSP、参数/default、12 场景、HSE2/ShareCodec、analysis 和 spatial 核心。
- `pnpm check:hse-ts` 可独立 strict typecheck。
- 已通过根项目本地 link dependency `@hyperplayer/hse-ts-core` 接入 parity/control-side 构建；不在 vendored 目录生成 `node_modules`，避免污染 destination gate。

来源与许可：

- `provenance/hse-v1.5.1/SOURCE-MANIFEST.json`
- 固定选择 84 个源文件；aggregate SHA-256：
  `06fa8e8df5524d855b91fbbcb018072587a517d056576b2017c7a6665a2f72c5`
- `pnpm check:hse-source` 会验证 clean checkout、tag、commit、文件选择和 hash。
- `NOTICE`、`THIRD_PARTY_NOTICES.md` 和 `third_party_licenses/V8-BSD-3-Clause.txt` 已补 HSE、V8/fdlibm、sofar/libmysofa/KD-tree 归属。
- Stage 22 数据许可已解除：MIT KEMAR HRTF（「任意用途 + 引用作者」，MIT Media Lab 1994）已审计入库 `assets/hrtf/mit-kemar-normal-pinna.sofa`；声明见 `third_party_licenses/MIT-KEMAR-HRTF.txt`，来源链/hash 见 `provenance/hrtf-mit-kemar/README.md`。

### 4.3 Destination manifest/hash gate（已完成）

- `provenance/hse-v1.5.1/DESTINATION-MANIFEST.json` 为 schema v2，覆盖三个 destination root：`crates/hyperplayer-hse-core`、`crates/hyperplayer-hrtf-core`、`shared/hse-ts-core`，共 92 个文件；aggregate SHA-256：
  `d21553c09d15e5cfd37c70b72a7f7e76eb84dc69c42d3862e2965cbac134f027`
- 每文件记录 source path/hash 与 destination hash，并标注 adaptation 分类；Stage 1/2/7 新抽取 core 还通过 `derivedFrom` 固定到 SOURCE-MANIFEST 中的 Rust/TS 来源路径与 SHA-256。
- 哈希统一对 CRLF→LF 规范化后的字节计算，不依赖 `core.autocrlf`；路径为仓库相对 `/` 分隔并稳定排序；vendored 根目录校验为真实目录且不逃逸仓库（symlink/junction 拒绝）。
- `pnpm check:hse-destination` 只读校验：缺失、未登记新增、hash 漂移、排序/重复/schema/source 映射漂移均失败；`pnpm update:hse-destination` 为显式重建。
- 门禁接线：`pnpm frontend:build` 与 CI quality workflow 均执行 `check:hse-destination`；`pnpm check:hse-vendor` 为 source+destination 联合审计（source 依赖 gitignored 的 clean checkout，不进入默认构建）。
- 故障注入自测通过：篡改、新增、删除受保护文件均被正确拒绝。

---

## 5. 当前 DSP 生产链

### 5.1 实际生产顺序

`prepare_dsp_chain` 当前构建 14 个 processor：

```text
1  Loudness Normalization
2  Surround3D
3  Mid/Side
4  Pre-EQ
5  De-esser
6  Compressor
7  Night Mode
8  Delay
9  Chorus
10 Flanger
11 Phaser
12 Tremolo
14 Bass Enhancer
19 LUFS tap
```

缺少生产 stage 编号：

```text
（无——Stage 1–22 全部 22 个编号均已进入生产链，默认 disabled）
```

生产链顺序：1–15、16/17（IEQ+Analysis 合并 adapter）、18、19 tap、20、21、22。

### 5.2 已直接委托 vendored HSE Rust core 的部分

- 以下生产算法已不再由 HyperPlayer 自己维护重复的样本级算法主体；Stage 1 Loudness Normalization、Stage 2 Surround3D、Stage 3 Mid/Side、Stage 4 Pre-EQ、Stage 5 De-esser、Stage 6 Compressor、Stage 7 Night Mode、Stage 8–12 modulation、Stage 14 Bass Enhancer、Stage 19 LUFS meter 均委托 vendored HSE Rust core。
- Stage 1/2/7 已从 `EngineChainStage` 内联逻辑抽成公开 typed core stage，并删除 HyperPlayer 本地 gain/phase/shelf/sample-loop 数学。
- `mid_side.rs`、`eq_chain.rs` 纯重导出已删除；BassEnhancer/Compressor/De-esser façade 已收薄为 settings/default/DTO 映射，产品 processor 直接持有 core stage。
- Delay/Chorus/Flanger/Phaser/Tremolo 使用 core 返回的规范化参数、`tail_basis` 与 runtime-state API；Tremolo 不再 clone 整个 effect 作 checkpoint。
- HyperPlayer adapter 只保留 interleaved/planar PCM、enabled 门控、格式/有限值验证、revision、checkpoint、standby、latency/tail 产品策略、sidechain 路由、故障旁路和实时线程约束。

### 5.3 已上线阶段的 core 化与去重状态

当前 Stage 1、2、7 与其余已上线阶段均已将采样数学委托 vendored HSE Rust core；不再存在 Fully local 或 hybrid 的生产算法主体。

- Stage 1 Loudness Normalization：core stage 持有 gain/smoothing；HyperPlayer 只读取 `SharedLufsState` 并适配 PCM/revision/checkpoint。
- Stage 2 Surround3D：core stage 持有 phase 与旋转数学；disabled→enabled 按 HSE reset。
- Stage 7 Night Mode：core stage 组合 Compressor + 双 Biquad；HyperPlayer 不再维护 shelf 状态、系数设计或处理循环。
- Stage 3/4 的纯重导出文件已删除；Stage 5/6/14 的厚 façade 已收薄；Stage 8–12 的参数钳位、tail basis 与 runtime checkpoint 均由 core API 提供。

下一步去重只剩新增 stage 接入时的 adapter 设计，不再需要迁移现有 14 processor 的重复样本算法。

### 5.4 已 vendored 但未进入生产链

`hyperplayer-hse-core` 已包含：

- ReverbSimple / FDN Reverb / Convolver
- Loudness Compensation
- IEQ/post processing
- Analysis/FFT
- Dynamic EQ
- Modulation Matrix / master gain
- Limiter
- Spatial/HRTF
- 完整 22-stage `EngineChainStage`
- 完整参数模型
- 12 scenes
- HSE2/ShareCodec

但这些目前主要只在 vendored crate 测试中使用。HyperPlayer production 没有直接使用完整 `EngineChainStage`。

### 5.5 DSP runtime 已完成的重要契约

- requested → prepared/ready → applied → retired 生命周期。
- revision 严格单调；latest-wins pending。
- ready chain 只在非空 active PCM block boundary 应用。
- standby/speculative processing 不消费 pending revision。
- 旧链延迟到非实时路径析构。
- processor state migration 只迁移 runtime state，不覆盖新参数/系数。
- disabled→enabled 按 HSE reset。
- 预分配 checkpoint；嵌套 checkpoint 拒绝。
- restore 前全链 preflight，避免已知类型/shape 不兼容造成部分恢复。
- standby raw PCM 与 processed PCM 分离。
- promotion 可 commit speculative state；discard/invalidate/revision/fault 会 restore。
- process error 或 non-finite output：恢复整个输入 block，记录 processor/index/frame，进入 Rust safe bypass。
- safe bypass reset 后仍锁存；只有更高 revision 成功应用才恢复 configured chain。
- safe bypass 下有效 latency/tail 为 0。
- fault transition、重复 bypass、checkpoint、restore、revision recovery 均有零分配门禁。
- 非 gapless terminal drain 最大 12 秒；被截断长尾最后 2 秒淡出。
- **standby speculative fault 非致命降级（本轮完成）**：DSP 层新增原子 API `restore_speculative_processing_to_safe_bypass()`，回滚 speculative processor state 后重新锁存本次 fault/revision/stream frame 并保持 SafeBypass；runtime 使用 raw standby PCM 标记该 standby 已按当前 revision 准备并返回成功，下一曲照常在采样边界晋升；actor 发出 `DspExecutionChanged` + `DspProcessingFault`，播放不进入 `Failed`。已覆盖 ProcessorChain、runtime、actor 三层与零分配回归。

### 5.6 安全旁路跨层状态

已实现：

- Rust `DspExecutionSnapshot`
- 与 playback revision 独立的 DSP revision
- `safe_bypass_active`
- durable fault metadata 和 fault stream frame
- `DspExecutionChanged`
- Tauri DTO/adapter/event 映射
- frontend snapshot gate 独立合并 DSP revision
- Zustand `dspDiagnostic`
- bootstrap 可恢复已生效的 bypass diagnostic
- 更新健康 DSP revision 可清除旧 diagnostic
- standalone fault event 继续弹即时错误
- 不传 PCM

仍需进一步复审：

- public trait 理论上仍允许 processor 在 preflight 通过后于 restore 时返回 false，generic rollback 协议无法回滚已经恢复的前序 processor；当前 production processor 实现约束使该路径应不可达，但接口层仍可进一步收紧。

### 5.7 DspPort / availability / 工作台（本轮已接通）

已完成：

- Rust DSP runtime availability 真实报告；`revision == 0` 的启动空链、有效 configured chain 和 `SafeBypass` 在 UI 分开展示。
- 正式 Tauri commands：`dsp_get_configuration`、`dsp_configure`、`dsp_list_presets`、`dsp_apply_preset`、`dsp_import_hse2`、`dsp_export_hse2`。
- 当前 22 processor 的显式 typed DTO、finite/range/枚举/EQ band 校验和严格单调 revision。
- 默认 `revision 1 / DspConfig::default()` 通过 actor 配置；mono source 仍使用 stereo F32 输出格式编译 DSP。
- 12 个 HSE scenes 接入（含 ieq/dynamicEq/modulation/limiter 逐场景定制，TS oracle 导出 fixture）；HSE2 导入导出为完整 22-stage 投影（scope `current22StageProjection`），仅少量 HyperPlayer-only 参数按缺省还原。
- HSE2 使用 vendored Rust ShareCodec；导入遵循 HSE codec sanitize/rehydrate，再验证当前投影。
- requested/applied 分离：pending 在 actor request 前登记，只在 matching `DspExecutionChanged` 后晋升；matching rejection 清除 pending；读取/导出只使用 applied config。
- 配置拒绝包含稳定 code、脱敏 reason、可选 stage；所有 DSP `u64` 在 IPC 使用十进制字符串，前端领域层使用 `bigint`。
- HyperPlayer 原生工作台覆盖全部 22 个模块（Stage 19 只读遥测、spatial 带克制 2D SVG 空间场示意）、EQ bandCount/frequency/gain/Q、预设和 HSE2；输入范围与 Rust DTO 一致并在提交前校验。

仍缺：

- DSP 配置已版本化持久化；重启经 `settings.json` 的 `dsp` 段恢复 revision 与配置（未知版本/损坏回落默认并诊断）。
- Stage 19 LUFS/true-peak/limiter 动态数据已固化到 HPTM v4 telemetry 与工作台展示；标准 BS.1770-5 模式为独立 `MeterMode`（默认 HSE v1.5.1 兼容，标准模式待向量认证）。

### 5.8 LUFS 兼容性说明

当前 vendored `LufsMeter` 与 HSE v1.5.1 TS oracle 一致，但**不能直接宣称严格符合 BS.1770/EBU**：

- 当前 HSE 兼容算法先合并左右声道幅度再平方，反相信号会相消；
- relative gate 使用 block loudness 的平均，而不是 block power 的平均；
- LRA 也不是完整 Tech 3342 语义。

后续应新增显式模式：

```text
HseV151       保持历史 HSE preset/share/vector 兼容
ItuBs1770_5   新 HyperPlayer 标准权威模式
```

不能直接修改 HSE 兼容路径，否则会破坏 preset/share/历史输出 parity。

---

## 6. DSP parity 与 TS 状态

当前 `tests/fixtures/dsp/`：

- 53 个 JSON metadata
- 53 个 `.f32` binary vector
- 覆盖 14 个 module；13 个 module 各 4 组，Loudness Normalization 1 组。

当前 parity 测试：

- Rust：1 个 53-vector suite + Biquad reset regression。
- TS：1 个 Phaser 边界测试 + 1 个 manifest 测试 + 53 个 vector test，共 55 项。

来源与去重状态（本轮完成）：

- 53/53 vector metadata 均带固定 `source { project, version, commit }`，Rust/TS harness 对全部向量强制校验。
- 为 Bass、Biquad、Compressor、De-esser、EQ、Loudness Normalization、Mid/Side、Surround3D 补齐固定 checkout generators；29/29 候选与现有 `.f32` 逐字节一致，二进制未改。
- `@hyperplayer/hse-ts-core` 已作为本地 link dependency 接入；`app/dsp/` 的 15 个手写 TypeScript 算法副本已删除，只保留直接调用 shared core 的 parity harness。
- Night Mode、Surround3D、Loudness Normalization 的 TS parity 通过中性化 `HyperSoundEngine` 整链隔离目标 stage，无额外 TS 算法副本。
- destination manifest 升级 schema v2；新增 Stage 1/2/7 Rust core 文件通过 `derivedFrom` 绑定 SOURCE-MANIFEST 中固定 Rust/TS 源路径与 SHA-256。

---

## 7. Telemetry / 可视化基础

### 7.1 Engine telemetry

已实现：

- `post_dsp_pre_output_gain` 固定 tap。
- 只分析 `AudioOutput::write` 实际接受的 active PCM 前缀。
- standby 预处理不产生 telemetry。
- 64-bin stereo waveform。
- sample peak。
- RMS。
- activity 0/2/15/30 Hz。
- 多 subscriber 取最高活动率。
- 双槽 atomic latest-frame overwrite。
- epoch 在 load/seek/stop/standby promotion 变化。
- ingest 路径无分配、无锁、无等待。

明确 unavailable：

- spectrum/FFT
- true peak
- limiter reduction
- LUFS telemetry

Engine 只设置 waveform/sample peak/RMS validity；spectrum 等固定区域为 0 且 validity 不启用。

### 7.2 HPTM v2（跨层已修复）

- 固定帧 780 bytes，小于 1 KiB。
- header 含 magic/version/validity、epoch、sequence、accepted sample frame、DSP revision、sample rate、bin count。
- waveform、spectrum 保留区和 7 个 meter scalar 使用固定布局。
- `u64` 在 Tauri control DTO 中使用十进制字符串，前端使用 `bigint`。

本轮统一后的协议语义：

- Tauri 严格按固定 780-byte 布局校验，不再按 declared count 推导帧长；复用 Engine 侧常量。
- count 只表达对应区域 availability，并校验 validity/count 一致性。
- known validity mask 明确排除 LUFS bit（v2 布局未分配该字段）；设置未知位或保留区非零（header 46..48、reserved spectrum 560..752）的帧在 Tauri/TS 双端拒绝。
- activity 降为 0 Hz 时保留已发送帧的 ACK 窗口，迟到 ACK 不再导致 session 被误关闭；新增暂停→ACK→恢复回归。
- 跨层测试已存在：真实 `TelemetryFrame::encode()` → Tauri parse/session 原样转发 → 前端 strict decode（spectrum/true peak/limiter 保持 `null`）。

- Rust 编码器 → TS 解码器的受版本控制 golden bytes 已建立：3 个固定 780-byte 帧，共 2340 bytes；覆盖大 `u64`、waveform/meters、reserved 区和 0 Hz 会话语义。

### 7.3 Tauri telemetry session

已实现：

- `telemetry_subscribe`
- `telemetry_ack`
- `telemetry_set_activity`
- `telemetry_close`
- raw binary Tauri Channel，不用普通 JSON event 传 frame。
- 每 WebView 一个 session，全局最多两个。
- 每 session 一个 in-flight frame，pending 覆盖旧 frame。
- ACK 校验 epoch/sequence/DSP revision。
- 同窗口重挂载替换旧 session。
- window destroy 关闭 session/worker。

### 7.4 Frontend fallback

已实现：

- HPTM v2 strict decoder。
- `bigint` clocks。
- validity 驱动的 nullable data。
- component-scoped session 与 main-window shared lease。
- epoch rollback 拒绝、ACK rejection 关闭 session。
- visibility/focus/reduced-motion activity 控制。
- Canvas DPR 最大 2。
- Waveform Canvas2D。
- Spectrum Canvas2D 组件，但只有真实 spectrum validity 时允许显示。
- ResponseCurve SVG。
- MeterStrip；当前只应显示真实 sample peak/RMS。

页面组件已接线，真实 Engine frame 协议层已可端到端到达 WebView：

- Expanded Player：设计上只在用户打开 waveform 时申请 telemetry；无 frame 时显示基线，不伪造。
- DSP 页面：显示当前 14-stage 配置、12 scenes、HSE2 导入导出、revision/pending/rejection；Stage 19 明确为只读且 HPTM v2 当前不发布 LUFS。无 spectrum 时显示 unavailable，response curve 仍明确是固定 0 dB 参考线。
- 剩余为验收缺口：正式 Tauri/WebView2 中的实时 waveform/meter 多尺寸/双主题确认仍未执行。

### 7.5 vGPU 状态

**尚未接入。**

- `package.json` 无 vGPU dependency。
- 无 `navigator.gpu`、adapter/device、shader、pipeline、device lost 处理。
- 无 WebGPU pixel tests。
- 当前只有 Canvas2D/SVG/DOM fallback 基础。
- `vgpu-diagnostic.tmp` 不构成运行证据。

---

## 8. UI 当前状态与视觉验收

本轮已修复用户指出的三列深色排版退化：

- 默认骨架恢复为 `sidebar + workspace + 80px player dock` 双栏，不再常驻 300px 右侧 context rail。
- next-up 和上下文队列保留在按需 QueuePanel；不再使用 `playTrack(track)` 伪造 queue-item 播放。
- `redesign.css` 改为语义 token 驱动，raw hex 为 0；明亮默认和深石墨主题均由 `data-theme` 生效。
- 宽屏 left/right/bottom 队列 dock 参与布局并支持持久宽高；960px 以下退化 overlay；floating 与主面板互斥。
- DSP 工作台在窄屏单列、宽屏双列；EQ 子网格 auto-fit，参数提交前做合法性校验。
- QueuePanel、导航和浮窗补齐 aria 状态、焦点恢复、Escape、Tab 环与 tablist/tabpanel 键盘语义。

正式验收证据（2026-09-02）：

- 在 release Tauri/WebView2 主窗口执行 1440×900 明亮、960×640 明亮、1440×900 深色验收；Windows DPI 为 150%，使用 `GetDpiForWindow` 校正后的完整 `PrintWindow` 截图。
- 三张截图经 visual judge 全部 `pass`；宽/窄侧栏、播放坞、主题和 DSP 表单均无横向截断或重叠。
- 截图位于 gitignored 的 `temp/ui-acceptance/*-dpi.png`，只作本地验收证据；用户最终逐页确认仍属于外部验收。

---

## 9. 本地播放、曲库、歌词和队列

已实现：

- Rust 权威播放状态与队列。
- queue revision 与 playback revision 原子快照。
- 恢复队列后保持暂停，播放时重新解析媒体。
- 当前/下一/后续 standby 水合。
- manual next/previous、automatic EOF、shuffle、repeat-all、tray、SMTC 输入路径。
- WAV incremental decode。
- FLAC/MP3 内容探测和播放。
- FLAC/MP3 真增量解码（2026-09-03，Stage 14）：symphonia（flac feature 新增、claxon 移除），open 只做 probe/建解码器/读头元数据，read_pcm 逐 packet 增量拉取到单帧缓冲，不整曲驻留内存。
- codec trim raw 契约（Stage 14）：三 codec 统一「total_frames/read_pcm 为 raw 时间轴，trim 只上报」，runtime 以 total − delay − padding 统一裁剪；MP3 读 Xing/Info LAME enc_delay/enc_padding（显式 gapless(false) 规避 symphonia 包级双重裁剪），FLAC 读 Vorbis Comment ENCODER_DELAY/PADDING；seek 经 demuxer 精确定位 + 帧内逐样本 skip 补齐，流末 seek 短路 eof。
- runtime 全链路 trim 与 standby 证据测试：Xing MP3 play_to_end 帧数精确 = raw − delay − padding；prime_standby 走 seek(delay) 且 trim 进入 Primed 状态；欠载/慢 IO/EOF/seek 复位 fake backend 矩阵（tests/gapless_backend.rs、tests/gapless_continuity.rs、tests/common）。
- mono→stereo F32 适配和 sample-rate conversion。
- CPAL default device、stereo F32 format negotiation、lock-free frame queue。
- 本地 scanner、SQLite、missing reconciliation、cancel safety、封面内容寻址。
- LRC/YRC/TTML sidecar、embedded lyrics、timeline。
- playlist create/rename/delete/add/remove/reorder/query 和 UI。
- 双内容域导航历史。

未完成/不可夸大：

- decoder open/prepare 仍在 engine actor 控制路径上同步执行；缺独立 preparation worker（Stage 14 剩余）。
- standby 失败/慢 IO 的 actor 级回退语义未专项测试（decoder/runtime 级已有）。
- 无真实编码器产出的跨曲 gapless fixture（现有证据来自合成正弦/斜坡/最小 FLAC/Xing MP3 fixture）。
- Windows 实机（真实 WASAPI 输出）录回/权威 PCM 对比验证 gapless 未做。
- 无输出设备枚举、选择持久化、live switch、default-device recovery、exclusive WASAPI。
- SMTC 主要是 transport input；metadata/artwork/timeline/state 同步不完整。
- 文件关联未完成。

---

## 10. 网易云状态

已完成或实质存在的 endpoint/基础链路：

- Cleanroom Rust transport。
- EAPI/XEAPI、device/session、QR login。
- official playback URL、质量 fallback、trial 拒绝。
- lyrics、secure image fetching。
- anonymous public explore/search/charts/new songs，以及 playlist/artist 的部分 listing/detail 基础。
- 部分 account/favorite/comments/follows/cloud/listening reports/events/notices/DJ/mutation commands。
- D23 entitled cache gate 和 logout/account switch locking。
- D24 album context/session tracking 基础。
- `mv_play_url`、similar MV、top MV source API 已存在。

上述"存在"不等于完整分页、mutation、typed bridge、UI 和外部验收均完成。

未完成：

- 115 route catalog 不是 115 个端到端实现。
- hot/suggest、完整 playlist/artist/DJ、similar、banner/wiki/blog、热评/楼层、journey/explore-next、scrobble/history 等仍缺或部分实现。
- MV URL 未接 Tauri/video player。
- 多个 Rust/Tauri command 尚未进入 typed frontend bridge/UI。
- 登录/VIP/写操作没有受控真实账号外部验收。
- `fee == 4` 购买权益解释仍需真实账号确认。

---

## 11. 缓存与 D30

已有：

- 私有 content-addressed storage。
- partial hash verification。
- D23 account/fresh proof/official full playback/expiry/revision/logout locking/lease revoke。
- explicit cache、status、remove all qualities、clear、playback reuse、next-track leases。
- album session/task 基础持久化。
- UI 能显示 missing/queued/caching/ready/locked/failed 等状态。

D30 第一阶段已完成：

- repository schema 已升级 v7；v6 迁移前通过 SQLite `VACUUM INTO` 建立并校验一致性备份，再原子替换固定 `.v6.backup`，v7 DDL 与 `user_version` 单事务提交。
- v7 已记录 logical size、last access、typed acquisition class、Public proof、partial 创建时间和 integrity verification；旧 v6 entry 按 `content_hash` 从 object size 回填。
- `CachePolicy` 已实现 10 GiB 默认、2–100 GiB、90% trim、recent 100、partial 24h、Public 7d 和磁盘保留/恢复阈值。
- eviction planner 按 `content_hash` 聚合共享对象，保护 leases/recent，有效执行权威淘汰顺序；过期 partial/orphan 不受 recent 保护。
- reconciliation planner 要求绝对 cache root 和安全 root-relative 路径，同时核对 hash/path，只生成计划不执行删除。
- Public offline proof 和 AccountEntitled offline fail-closed 已实现并测试。
- durable `album_fill_items` 支持 enqueue/claim/complete/fail/resume；前台工作可事务式 yield running item；`AlbumFillCoordinator` 已提供资源门禁、claim/yield 核心。

D30 第二阶段仍未完成：

- engine 已新增 eviction/object snapshots、事务式 apply eviction/missing、cache access touch、CAS root-relative scan/safe delete 和 album aggregate transaction API；但尚未由 Tauri runtime supervisor 调用。
- Tauri worker 生命周期、定时 reconciliation/quota 执行、Windows AC/计费网络/磁盘探测和 album-fill 实际下载调度。
- 容量/策略持久化、runtime status command/events 和 Settings 容量/策略 UI。

---

## 12. Windows、Updater 与系统集成

已实现：

- Tauri window/tray lifecycle。
- tray show/play-pause/previous/next/exit。
- close-to-tray / close confirm 基础。
- Windows recycle bin `IFileOperation`，无永久删除 fallback。
- updater HTTPS/public DNS-IP/manual redirect/no proxy/body limit/deadline/semver/expected-version/Minisign/sanitized errors。
- updater Settings/Status Center 基础接线。

未完成或外部阻塞：

- updater endpoint/public key 未配置。
- 无 release workflow、hosted metadata/package、生产 Minisign key 管理。
- 无 Authenticode、真实升级/回滚/restart 验收。
- 无 installer file association。
- 无完整 SMTC metadata/artwork/timeline。
- 无真实设备/媒体键/长时间播放验收。

---

## 13. 当前测试与构建证据

### 13.1 本轮工作树的通过证据（2026-09-02）

Rust crates（`+1.98.0`）：

- `cargo fmt --check`、workspace/all-targets/all-features strict Clippy、完整 tests 全部通过。
- Engine lib：224 passed；DSP parity：2 passed（53 vectors）；DSP realtime invariants：9 passed；telemetry golden：1 passed。
- HRTF core：33 passed、1 ignored；allocation：5 passed；renderer features：10 passed。
- HSE core：333 passed、1 ignored；parameter scan：1 passed；realtime allocation：6 passed。

Tauri：

- fmt、workspace/all-targets/all-features strict Clippy 全部通过。
- Tauri lib：124 passed；main：0 tests。

Frontend / IPC / license：

- `TZ=UTC pnpm test`：17 files / 189 tests passed。
- IPC contract：90 commands / 14 events matched。
- `pnpm frontend:build`、TypeScript project build、Vite production build、NetEase oracle strict typecheck、`pnpm check:hse-ts` 全部通过。
- `pnpm check:hse-destination`：schema v2、92 files、aggregate SHA-256 `d21553c09d15e5cfd37c70b72a7f7e76eb84dc69c42d3862e2965cbac134f027`。
- JavaScript production license audit：15 records accepted。
- `cargo deny` advisories/licenses/bans/sources 通过，仅保留既有 duplicate/unmatched allow warnings。

Build / UI：

- `pnpm build` 完整 Tauri release build 在 UI/DspPort 检查点通过，并生成 `HyperPlayer_0.1.0_x64-setup.exe` 与 `HyperPlayer_0.1.0_x64_en-US.msi`；之后追加的 façade 清理与 D30 engine API 已通过各自 Rust/前端门禁，但当前最终工作树仍需在提交前再执行一次完整 `pnpm build`。
- 本轮 UI/DspPort release 检查点在真实 Tauri/WebView2 中完成 1440×900 明亮、960×640 明亮、1440×900 深色截图；DPI 校正图经 visual judge 三页全部通过。其后只追加了 DSP 输入上限、布局预设导航和 rejection `bigint` 收口，均通过前端测试/build，但提交前仍应以最终工作树再做一次截图抽查。
- Vite 仍有单 chunk 约 647 kB 的既有警告。

### 13.2 尚未完成的验证

- 本轮尚未提交，因此没有提交后的 GitHub Actions 结果。
- vGPU/WebGPU/device-loss/pixel tests 未执行，因为 vGPU 尚未接入。
- 实时 waveform/meter 需要加载真实正在播放的音频后再做动态视觉确认；本轮窗口验收覆盖布局、主题、工作台和空闲 meter 状态。
- 用户逐页最终视觉确认、真实音频硬件、长期播放、受控网易云账号和 updater 外部验收仍待执行。

---

## 14. 当前高优先级未修复问题

### P1 / 中风险

1. **HSE core constructor 直接 API 边界**
   - Delay/Chorus/Flanger core constructor 在未 `set_params` 前不完全复现 TS default。
   - 极大 finite sample rate 可能造成 pathological allocation/overflow。
   - HyperPlayer façade 当前受保护，但 core public API 应修正或收窄。

2. **LUFS 标准模式缺失**
   - 当前只应标记为 HSE v1.5.1 compatibility；需要新增标准模式。

3. **BSD 分发文本需再审计**
   - 已有 attribution 和 V8 license；libmysofa/KD-tree 的完整 BSD 条款是否随 installer 分发仍需确认。

4. **Stage 22 实机验收未做**
   - 生产接线与自动化门禁已完成；正式 Tauri/WebView2 下的空间场 UI 多尺寸、真实设备双耳听感与安装包资源/许可证复审待用户确认。

### P2 / 已知但非阻塞

5. 默认并行前端测试历史上出现过 timeout/act 污染，本轮 222 项未复现。
6. DSP 配置已版本化持久化（`settings.json` `dsp` 段，version=1/revision/DTO），重启恢复 revision；未知版本/损坏回落默认并诊断。
7. HPTM 已升级到 v4（856B），Stage 19 LUFS/true-peak/limiter 动态字段已分配给工作台展示；标准 BS.1770-5 已通过解析向量认证 ±0.1 LU（官方 EBU 测试集验证仍开放）。
8. 全部 22 processor 的 direct façade、参数钳位、tail 派生与 Tremolo clone checkpoint 已完成去重。

---

## 15. 尚未完成的产品能力

### DSP / D29

- Stage 22 实机验收（UI 多尺寸、真实设备听感、安装资源复审）。
- 标准 BS.1770-5 官方 EBU Tech 3341/3342 测试集验证（解析向量认证已通过，±0.1 LU）。
- 完整 Stage 19 telemetry schema：LUFS（integrated/momentary/short-term）与 true peak/limiter reduction 已固化到 HPTM v4 并接入工作台；FFT 复用既有 spectrum。
- DSP 配置持久化与完整 22-stage 工作台已完成。

### D30

- Tauri runtime supervisor、定时 reconciliation/quota IO、Windows AC/计费网络/磁盘探测、album-fill 实际下载调度和 Settings 容量/策略 UI。

### 音频与设备

- ~~MP3/FLAC incremental decode~~（已完成，2026-09-03）。
- ~~real codec trim~~（已完成，2026-09-03）。
- decoder preparation worker（open/probe/prepare 移出 actor 控制路径）。
- actor 级 standby 失败/慢 IO 回退语义。
- 真实编码器产出的 cross-codec gapless fixture 与 Windows 实机录回验收。
- device enum/switch/recovery/exclusive。

### 网易云

- 剩余 domain/workflow/bridge/UI。
- MV player。
- 受控账号/VIP/write acceptance。

### UI / 可视化

- vGPU/WebGPU 接入及 fallback parity。
- 实时播放状态下 waveform/meter 动态验收。
- forced colors、text scale、aux windows 和用户逐页最终确认。

### Windows / 发布

- SMTC metadata/timeline。
- file associations。
- updater feed/signing/Authenticode。
- installer upgrade acceptance。

---

## 16. 恢复执行顺序

下个会话建议严格按以下顺序：

1. 先复审并提交当前工作树；按 parity/provenance、HSE core migration、DspPort、UI、telemetry golden、docs 拆分审查提交，避免继续扩大未提交面。
2. 按 `13 → 15 → 18 → 21 → 20 → 16+17 → 22` 接入缺失阶段；每阶段先补 vendored typed state/checkpoint/tail API，再接 HyperPlayer adapter。
3. DSP 配置持久化（Stage 09，已完成：`settings.json` `dsp` 版本化段 + 启动恢复 + 迁移 fail-close）与标准 BS.1770-5 模式（`MeterMode` 独立模式，标准模式待向量认证）；HSE v1.5.1 compatibility 路径保持不变。
4. 接入 D30 Tauri runtime supervisor、实际 reconciliation/quota IO、Windows 资源 probes、album-fill 下载调度和 Settings UI。
5. 再推进 decoder preparation/incremental codec/device、网易云剩余能力、vGPU 和 Windows 发布能力。

提交前必须逐项执行并记录：

```text
cd crates
cargo +1.98.0 fmt --all -- --check
cargo +1.98.0 clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo +1.98.0 test --workspace --all-targets --all-features --locked

cd ../crates/hyperplayer-source-netease
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-targets --all-features --locked

cd ../../src-tauri
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-targets --all-features --locked

cd ..
TZ=UTC pnpm test
pnpm frontend:build
pnpm check:hse-destination
pnpm exec tsc -p tests/oracle-tsconfig.json --pretty false
pnpm check:hse-ts
node tests/check-js-licenses.mjs
cargo deny --manifest-path crates/Cargo.toml --config deny.toml check advisories licenses bans sources
pnpm build
```

还必须：

- 继续排除 `src-tauri/gen/` 与本地 `.tmp` 诊断文件。
- 每轮提交后运行对应 CI 等价命令；远端 workflow 结果与本地证据分开记录。
- 不把测试、计划或 vendored library 存在误报为产品全功能完成。

---

## 17. 外部验收阻塞

- 网易云匿名公网 smoke：需要真实公网环境验证公开首页、搜索、播放 URL、图片和分区降级；当前自动 fixture 不能替代。
- 网易云登录/VIP/写操作：需要受控账号，凭据不得进入日志/fixture/artifact。
- Windows 音频设备、exclusive、SMTC、媒体键、长期播放：需要真实硬件。
- updater：需要托管 feed、Minisign key、Authenticode 和 disposable Windows 安装环境。
- HRTF：需要可再分发 SOFA 数据及来源/版本/hash/署名。
- UI：需要当前最终代码的正式 Tauri/WebView2 明暗主题、多尺寸和辅助窗口逐页确认。
- 性能/资源基线：需要按定调在 M1/M6 实测空闲/播放内存、冷启动、安装体积和长期播放稳定性；不设拍脑袋硬指标，但不能跳过测量。

缺少外部资源时，只能标记"代码完成、外部验收阻塞"，不能标记"功能完成"。

---

## 18. 子代理与热点文件规则

- 子代理必须有严格文件白名单。
- `actor.rs`、`runtime.rs`、`dsp.rs`、`repository.rs`、`adapters.rs`、DTO、bridge、store、Cargo、`lib.rs` 等热点文件必须单 owner。
- 不并发修改同一热点。
- 代理完成以实际 diff、主线程复审和命令结果为准，不能用文字声明替代。
- 每次阶段迁移顺序固定：vendored core API → adapter → vector/parity → revision/checkpoint/standby → zero allocation → full gates → delete duplicate body。
- 网易云继续 Cleanroom。
