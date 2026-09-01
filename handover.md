# HyperPlayer 当前交接

更新时间：2026-09-01

> 本文件记录当前未提交工作树的事实状态。它覆盖产品、HSE/DSP、telemetry、UI、缓存、网易云、音频和测试证据；`handover-visualization.md` 保留可视化专项细节，但其中部分“未完成”描述已被后续实现覆盖。

## 1. 一句话结论

HyperPlayer 已形成可运行的 Tauri 2 + React/TypeScript + Rust Windows 播放器主干，并完成本地播放/曲库/队列/歌词、部分网易云、D23/D24、部分缓存、真实 DSP runtime、HSE v1.5.1 核心 vendoring、14 个生产处理器和 HPTM v2 可视化基础。

**项目仍未达到 v1 全功能完成。** 当前主要缺口包括：

- HSE 完整 22 阶段尚未全部进入 HyperPlayer 生产播放链；
- Tauri `DspPort`、完整 DSP 参数/预设/HSE2/工作台尚未接通；
- D30 缓存 schema/policy/worker/UI 基本未实施；
- MP3/FLAC 增量解码、真实 codec trim、设备切换、独占模式和完整 Windows 集成未完成；
- 网易云仍有较多路由、UI 工作流和受控账号外部验收缺口；
- 当前 UI 三列深色重排未经最终 WebView2 多尺寸/双主题验收，用户已明确认为当前排版退化；
- vGPU/WebGPU 尚未真正接入；
- 当前工作树很大且未提交，不能用旧 CI 结果代表当前状态。

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
- 当前 HEAD：`2fa069c5f76de0c708d4eab8500f0c7c335c2b99`
- 当前工作树不是一个小补丁：约 45 个 tracked 文件有修改，约 270 个 untracked 文件。
- 大量核心新增内容仍未跟踪/未提交，包括：
  - `crates/hyperplayer-hse-core/`
  - `crates/hyperplayer-hrtf-core/`
  - `shared/hse-ts-core/`
  - `provenance/hse-v1.5.1/`
  - `crates/hyperplayer-engine/src/dsp_algorithms/`
  - `crates/hyperplayer-engine/src/telemetry.rs`
  - `app/dsp/`
  - `app/visualization/`
  - `tests/fixtures/dsp/`
  - `third_party_licenses/`
  - `src-tauri/src/commands/telemetry.rs`
- `src-tauri/gen/` 是 Tauri 生成物，仍未跟踪，正式提交时必须排除。
- `vgpu-diagnostic.tmp` 仅含文本 `vgpu diagnostic`，不是一次真实 vGPU 诊断结果；正式提交前应按用户意图决定是否保留。
- `git diff --check` 当前无空白错误，仅有 Windows CRLF 转换提示。
- 不得整体恢复当前工作树；其中包含多轮尚未提交的真实功能实现。

历史已合并基线：

1. `7137bea feat(netease): close runtime playback and image gaps`
2. `c9b239d feat(engine): persist playback history and entitlement locks`
3. `23ef617 feat(desktop): close playback context and desktop actions`
4. `39de988 feat: close library and anonymous discovery workflows`
5. `0be5403 Merge pull request #2 from SoundFieldLab/feat/p0-netease-runtime-closure`
6. `2fa069c docs: record vgpu visualization policy`

旧 GitHub Quality/Licenses 绿灯只覆盖已提交基线，不覆盖当前未提交工作树。

---

## 3. 权威定调与长期约束

后续继续实现前必须读取：

| 能力 | 权威输入 |
|---|---|
| 产品范围、里程碑、D21/D29/D30/D31 | `docs/需求基线.md`、`docs/定调决策记录.md` |
| Tauri / Rust / 曲库所有权 | `docs/adr/0004-rust-owns-library.md`、`docs/adr/0005-tauri2-react-rust.md` |
| UI 信息架构与视觉基线 | `docs/UI设计基线.md`、`docs/UI定调决策记录.md` |
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

## 4. HSE v1.5.1 正式 vendoring 状态

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
- 当前还不是 pnpm workspace member，也没有被产品/现有 parity runner 使用。

来源与许可：

- `provenance/hse-v1.5.1/SOURCE-MANIFEST.json`
- 固定选择 84 个源文件；aggregate SHA-256：
  `06fa8e8df5524d855b91fbbcb018072587a517d056576b2017c7a6665a2f72c5`
- `pnpm check:hse-source` 会验证 clean checkout、tag、commit、文件选择和 hash。
- `NOTICE`、`THIRD_PARTY_NOTICES.md` 和 `third_party_licenses/V8-BSD-3-Clause.txt` 已补 HSE、V8/fdlibm、sofar/libmysofa/KD-tree 归属。
- 没有复制 SOFA/HRTF 数据集；Stage 22 数据许可仍是外部阻塞。

### 4.3 重要来源/完整性缺口

当前 SOURCE-MANIFEST 主要验证固定上游 checkout。vendored Rust 目标端已经增加大量 HyperPlayer 所需的状态 snapshot/copy/restore API 和测试，但目标端改动尚没有完整 destination hash manifest 或可复现 patch series。

后续必须增加：

- 每个 vendored 文件的 source hash 与 destination hash；
- 变更分类：relocation、license notice、lint policy、runtime checkpoint API、test-only、algorithm change；
- 校验脚本必须对未登记的目标端 drift 失败。

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
13, 15, 16, 17, 18, 20, 21, 22
```

因此不是“还剩 10 个阶段”，而是**8 个 stage 编号尚未进入当前 HyperPlayer 生产链**。

### 5.2 已直接委托 vendored HSE Rust core 的部分

以下生产算法已不再由 HyperPlayer 自己维护重复的样本级算法主体：

- Stage 3 Mid/Side → `hse_core::mid_side::MidSideStage`
- Stage 4 Pre-EQ → `hse_core::eq_chain::EqChainStage`
- Stage 5 De-esser → `hse_core::deesser::DeesserStage`
- Stage 6 Compressor → `hse_core::compressor::CompressorStage`
- Stage 8 Delay → `hse_core::mod_effects::DelayEffect`
- Stage 9 Chorus → `hse_core::mod_effects::ChorusEffect`
- Stage 10 Flanger → `hse_core::mod_effects::FlangerEffect`
- Stage 11 Phaser → `hse_core::mod_effects::PhaserEffect`
- Stage 12 Tremolo → `hse_core::mod_effects::TremoloEffect`
- Stage 14 Bass Enhancer → `hse_core::bass_enhancer::BassEnhancerStage`
- Stage 19 LUFS meter → `hse_core::lufs_meter::LufsMeter`
- Biquad 设计和 EQ 基础也来自 vendored core。

HyperPlayer adapter 仍负责：

- interleaved/planar PCM 适配；
- enabled 门控；
- 有限值与格式校验；
- revision 状态迁移；
- checkpoint；
- false→true reset；
- latency/tail 产品策略；
- sidechain 路由策略；
- 实时零分配约束。

### 5.3 仍为本地或 hybrid 的已上线阶段

- Stage 1 Loudness Normalization：归一化 gain/smoothing 控制逻辑仍在 HyperPlayer；读 vendored LUFS meter 发布状态。
- Stage 2 Surround3D：仍是 HyperPlayer 本地授权移植，没有调用 vendored独立 core 类型。
- Stage 7 Night Mode：hybrid；压缩器和 biquad 设计来自 vendored core，但 high-shelf 状态与组合逻辑仍在 HyperPlayer。

后续迁移这三项时，应该从 vendored `EngineChainStage` 抽取可复用 core，而不是再按 TS 重写。

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
- speculative standby DSP fault 的降级语义需要端到端复核：历史审查指出它可能恢复 checkpoint 后返回 `AudioBackend` 并让 actor 将播放置为 failed，而不是继续 safe bypass；必须以当前代码重新测试后才能宣称已解决。

### 5.7 DSP availability / UI bridge 仍然错误

尽管生产 DSP 已运行，以下接口仍声明 DSP unavailable/bypassed：

- `src-tauri/src/commands/bootstrap.rs::dsp_availability()`
- `dsp_availability_value()`
- frontend `adaptPlayback()` 中的 `dsp: { available: false, bypassed: true, label: "规格待接入" }`

因此 UI 的 DSP availability 文案与 Rust 实际能力不一致。

同时仍缺：

- 正式 `DspPort`
- DSP configure Tauri command/DTO
- 12 presets 产品桥
- HSE2 导入导出产品桥
- HyperPlayer 原生工作台参数编辑
- 参数 revision/失败原因在 UI 的完整展示
- configuration rejection 的稳定错误码、脱敏 reason、可选 stage 名

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

来源缺口：

- 只有 24/53 vector metadata 带结构化 `source { project, version, commit }`。
- 29 组缺少 machine-checked provenance：Bass、Biquad、Compressor、De-esser、EQ、Loudness Normalization、Mid/Side、Surround3D。
- 现有 Rust/TS harness 只强制 Night Mode 和五个 modulation effect 的来源。
- 后续需为所有 HSE-derived vectors 提供固定 checkout generator 和 source metadata。

TS 重复实现缺口：

- `shared/hse-ts-core` 是正式 vendored TS core，但当前 parity 仍 import `app/dsp/*` 的第二套手工实现。
- 这形成三套行为面：vendored TS、vendored Rust、`app/dsp` TS。
- 应改为 parity 直接使用 `shared/hse-ts-core`，只保留 HyperPlayer 必要 adapter/driver，然后删除 `app/dsp` 重复算法主体。

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

### 7.2 HPTM v2

- 固定帧 780 bytes，小于 1 KiB。
- header 含 magic/version/validity、epoch、sequence、accepted sample frame、DSP revision、sample rate、bin count。
- waveform、spectrum 保留区和 7 个 meter scalar 使用固定布局。
- `u64` 在 Tauri control DTO 中使用十进制字符串，前端使用 `bigint`。

当前专项测试已通过，但只证明各层局部行为：

- Engine telemetry 10 项。
- Runtime accepted-prefix telemetry 1 项。
- Tauri producer→command 单项转发测试通过，但其 fixture 不是 Engine `TelemetryFrame::encode()` 在 spectrum unavailable 情况下产生的真实 header/count 组合。

**当前真实跨层协议存在确定缺陷：**

- Engine 在 spectrum unavailable 时写 `spectrum_count=0`，但仍编码固定 780 bytes；
- Tauri `parse_identity()` 按 declared bin count 重算 payload 长度，得到 588 bytes，并拒绝实际 780-byte frame；
- 因此当前 Engine 真实 frame 会在 Tauri 边界被丢弃，无法送达 WebView2；现有各层单测没有覆盖这一真实组合。

必须先统一 fixed-frame 与 declared-count 语义，并增加“Engine `TelemetryFrame::encode()` → Tauri `parse_identity`/forward → frontend decode”的跨层测试。在修复前，只能说 producer、session 和 renderer 组件分别存在，不能说实时可视化链路端到端可用。

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

页面组件已接线，但受上述 Tauri wire 缺陷影响，当前真实 Engine frame 尚不能端到端到达：

- Expanded Player：设计上只在用户打开 waveform 时申请 telemetry；无 frame 时显示基线，不伪造。
- DSP 页面：设计上显示 meter；无 spectrum 时显示 unavailable；response curve 只是固定 0 dB 参考线；参数控件仍禁用。
- 当前只能确认 UI fallback 行为和局部测试，不能确认实时 waveform/meter 在正式 WebView2 中可用。

### 7.5 vGPU 状态

**尚未接入。**

- `package.json` 无 vGPU dependency。
- 无 `navigator.gpu`、adapter/device、shader、pipeline、device lost 处理。
- 无 WebGPU pixel tests。
- 当前只有 Canvas2D/SVG/DOM fallback 基础。
- `vgpu-diagnostic.tmp` 不构成运行证据。

---

## 8. UI 当前状态与已知视觉问题

用户已明确反馈：最近另一会话加入的 UI 排版“变得很差，不如以前”。本轮已启动 UI 修复代理，但代理被停止，**没有完成 UI 修复**。

当前主要风险：

- `app/styles/redesign.css` 最后加载，重写整个 shell。
- shell 被改成约 `248px + main + 300px` 三列，增加永久 right context rail。
- 1180px 以下隐藏 context rail，960px 以下折叠 sidebar；Tauri 最小宽度正好约 960px，边界排版未验收。
- redesign.css 大量硬编码深色背景/文字，不完全尊重 `data-theme`；默认亮色/完整双主题定调可能被破坏。
- 当前右侧 next-up row 使用 `playTrack(track)`，可能重新发起播放而不是选择现有 queue item，交互语义需确认。
- 没有当前三列 redesign 的正式 WebView2 多尺寸截图和用户逐页确认。
- 早期视觉验收不能覆盖当前 UI，因为 shell、telemetry 和 DSP 页面已发生大改。

后续 UI 修复必须：

- 先对比当前 App/Navigation/Content/Player 与 `docs/UI设计基线.md`；
- 保留功能，不通过删栏/删状态/删 telemetry 简化布局；
- 恢复明亮默认和完整深石墨主题；
- 处理 960×640、1440×900、1920×1080；
- 正式在 Tauri/WebView2 验收，不用浏览器预览代替。

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
- mono→stereo F32 适配和 sample-rate conversion。
- CPAL default device、stereo F32 format negotiation、lock-free frame queue。
- 本地 scanner、SQLite、missing reconciliation、cancel safety、封面内容寻址。
- LRC/YRC/TTML sidecar、embedded lyrics、timeline。
- playlist create/rename/delete/add/remove/reorder/query 和 UI。
- 双内容域导航历史。

未完成/不可夸大：

- FLAC/MP3 当前仍整体 decode 到 `Vec<f32>`，不是增量解码。
- Production FLAC/MP3 codec trim 当前为 0，真实 gapless delay/padding 未完成。
- decoder open/whole decode/standby prepare 仍可能阻塞 engine actor；缺独立 preparation worker。
- 无 MP3/FLAC 跨曲真实 gapless fixture。
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

上述“存在”不等于完整分页、mutation、typed bridge、UI 和外部验收均完成。

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

D30 尚未完成：

- repository schema 仍是 v6，不是 v7。
- 10 GiB default、2–100 GiB config、trim to 90%。
- LRU、recent-100 protection、acquisition class eviction order。
- partial 24h cleanup、startup DB/object reconciliation、migration backup。
- Public 7-day offline proof。
- durable album-fill item queue、resume、single concurrency、preemption。
- AC/metered/disk reserve/power probes。
- Settings 容量/策略 UI。

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

### 13.1 本会话当前工作树的通过证据

以下命令于 2026-09-01、`main` HEAD `2fa069c5f76de0c708d4eab8500f0c7c335c2b99` 加当前未提交工作树上执行。结果文件位于本地 ZCode session exec 输出中，提交后应由 CI 重新建立可公开复现的证据。

Rust crates workspace，使用：

```text
cargo test --manifest-path crates/Cargo.toml --workspace --all-targets --all-features --locked
cargo clippy --manifest-path crates/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
```

当前通过：

- HyperPlayer engine lib：226 passed
- Rust DSP parity：2 passed，其中主 suite 覆盖 53 vectors
- DSP realtime invariants：7 passed
- HRTF core：33 passed，1 ignored（需要用户提供 SOFA asset）
- HRTF realtime allocation：5 passed
- HRTF renderer features：10 passed
- HSE core：315 passed，1 ignored（不可达 3π/2 精确边界）
- HSE parameter scan：1 passed
- HSE realtime allocation：5 passed
- strict Clippy：通过

Tauri：

```text
cargo test --manifest-path src-tauri/Cargo.toml --workspace --all-targets --all-features --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
```

当前通过：

- Tauri lib：112 passed
- Tauri main：0 tests
- strict Clippy：通过

Frontend 当前明确证据：

```text
pnpm test -- --maxWorkers=1
```

- 15 test files passed
- 165 tests passed
- serial/single-worker baseline 通过

其他当前通过证据：

- NetEase Rust 独立 workspace：49 passed；strict Clippy 通过。
- NetEase TypeScript oracle：当前 strict typecheck 通过。
- `pnpm check:hse-source`：通过，84 files / aggregate SHA-256 固定。
- `pnpm check:hse-ts`：通过。
- JavaScript production license audit：15 records accepted。
- `cargo deny`：advisories/licenses/bans/sources 通过，仅 duplicate/unmatched allow warnings。
- IPC verifier 最近显示 84 frontend-declared commands / 14 events matched；该 verifier 是单向覆盖检查，Rust 实际注册 command 更多，不能视为所有 Rust command 都有 typed frontend bridge。
- 静态 DSP vector 文件数：53 JSON + 53 `.f32`。

### 13.2 当前未通过或未完成的验证

`pnpm frontend:build` 最近失败，原因是 3 个测试 fixture 没有补新必填字段 `PlaybackSnapshotDto.dspExecution`：

- `app/overlays/CommandPalette.test.tsx`
- `app/pages/ContentViews.test.tsx`
- `app/player/Player.test.tsx`

注意：Vitest 转译不做完整 TypeScript typecheck，因此 165 tests 通过不等于 `tsc -b` 通过。

需要修复 fixture 后重新运行：

```text
pnpm frontend:build
pnpm exec tsc -p tests/oracle-tsconfig.json --pretty false
pnpm check:hse-ts
pnpm check:hse-source
```

尚未对当前最终工作树运行：

- 完整 `pnpm build` / Tauri release bundle
- 当前 NSIS/MSI 最终重建
- 当前 Tauri/WebView2 多尺寸截图验收
- vGPU/WebGPU/device-loss/pixel tests（因为 vGPU 尚未接入）
- 当前工作树 GitHub CI

前端并发稳定性：

- single-worker 165 项通过。
- 默认并行历史上 `navigation.test.ts` 可能超过 15 秒并出现 overlapping `act()`，虽然近期一次 focused run 曾 165 全过；不能宣称完全稳定。
- 不应为该问题修改导航业务逻辑；应优化 test cleanup/async lifecycle 或配置 file parallelism/timeout。

---

## 14. 当前高优先级未修复问题

### P0 / 高风险

1. **speculative standby DSP fault 当前会中断播放**
   - 当前 `runtime.rs` 在检测到 standby speculative DSP fault 后恢复 checkpoint 和 raw PCM，但随后明确返回 `AudioBackend("standby DSP processing failed")`。
   - actor 的 audio tick 错误路径会 stop runtime 并将 playback 置为 error；restore 还可能抹掉 structured fault，最终只剩通用播放失败。
   - 必须改成可观察的 Rust safe-bypass transition 并继续 promotion，且增加 active EOF → standby fault → raw/bypass promotion → 播放连续 → fault diagnostic 的端到端测试。

2. **目标端 provenance 不完整**
   - 当前 manifest 验证上游 source selection，不完整验证 vendored destination 修改。
   - 需要 destination manifest / patch series / destination hashes。

3. **前端 build 当前失败**
   - 3 个 `PlaybackSnapshotDto` fixture 缺 `dspExecution`。
   - 必须修复后重新建立 build baseline。

### P1 / 中风险

4. **TS 核心重复**
   - `shared/hse-ts-core` 已 vendored，但 parity 仍使用 `app/dsp` 手工副本。
   - 应将 parity 和 preview 改用 shared core，删除重复 algorithm bodies。

5. **vector provenance 不完整**
   - 29/53 缺 structured source。

6. **HSE core constructor 直接 API 边界**
   - Delay/Chorus/Flanger core constructor 在未 set_params 前不完全复现 TS default。
   - 极大 finite sample rate 可能造成 pathological allocation/overflow。
   - HyperPlayer façade 当前受保护，但 core public API 应修正或收窄。

7. **LUFS 标准模式缺失**
   - 当前只应标记为 HSE v1.5.1 compatibility；需要新增标准模式。

8. **DSP availability 假状态**
   - bootstrap/frontend 仍写 unavailable/BYPASS。

9. **配置拒绝缺原因**
   - `DspConfigurationRejected` 仅含 revision；应增加稳定错误码、脱敏 reason、可选 stage。

10. **HPTM fixed-frame/count 不一致导致真实 telemetry 被 Tauri 丢弃**
    - Engine 在 spectrum unavailable 时生成固定 780-byte frame，并声明 `spectrum_count=0`。
    - Tauri `parse_identity()` 按 count 推导 588-byte expected size，因此拒绝真实 frame。
    - 必须统一 wire schema，并增加真实 Engine encoded frame 的跨层 parse/forward/decode 测试。

11. **BSD 分发文本需再审计**
    - 已有 attribution 和 V8 license；libmysofa/KD-tree 的完整 BSD 条款是否随 installer 分发仍需确认。

### P2 / 已知但非阻塞

12. 默认并行前端测试偶发 timeout/act 污染。
13. UI light theme 被 redesign.css 深色硬编码破坏。
14. 当前三列 shell 未做正式 WebView2 视觉验收。
15. 右侧 next-up row 的队列行为需确认。
16. HSE 完整 22-stage library 已有但 production 只接 14 processors。
17. HSE core/TS/provenance/new vectors 大量仍 untracked。

---

## 15. 尚未完成的产品能力

### DSP / D29

- Stage 13、15–18、20–22 生产融合。
- Stage 1/2/7 进一步 core 化。
- 完整参数模型接 HyperPlayer DTO。
- 12 scenes/presets 产品接入。
- HSE2 import/export。
- DspPort + Tauri configure command/events。
- 原生 DSP 工作台参数编辑。
- 标准 BS.1770 模式。
- 完整 Stage 19 telemetry schema：LUFS/true peak/limiter reduction/FFT。
- Stage 22 HRTF 数据来源与许可证。

### D30

- schema v7、quota/LRU/reconciliation/offline proof/album worker/probes/UI。

### 音频与设备

- MP3/FLAC incremental decode。
- real codec trim。
- decoder preparation worker。
- cross-codec gapless fixture。
- device enum/switch/recovery/exclusive。

### 网易云

- 剩余 domain/workflow/bridge/UI。
- MV player。
- 受控账号/VIP/write acceptance。

### UI / 可视化

- 修复当前排版退化。
- 双主题恢复。
- DSP availability 与工作台真实状态。
- vGPU/WebGPU 接入及 fallback parity。
- 正式 WebView2 多尺寸、DPI、forced colors、text scale、aux windows 和用户逐页确认。

### Windows / 发布

- SMTC metadata/timeline。
- file associations。
- updater feed/signing/Authenticode。
- installer upgrade acceptance。

---

## 16. 恢复执行顺序

下个会话建议严格按以下顺序：

1. 先为当前两个确定的 P0 写失败回归并修复：HPTM fixed-frame/count 跨层拒绝、speculative standby DSP fault fatal playback。
2. 修复 3 个缺 `dspExecution` 的 TS fixtures，恢复 `pnpm frontend:build`。
3. 建立 vendored destination manifest/hash gate。
4. 将 parity 从 `app/dsp` 切到 `shared/hse-ts-core`，删除重复 TS 算法。
5. 为全部 53 vectors 补 structured provenance 和生成器。
6. 修复 DSP availability 假状态，并设计正式 DspPort。
7. 继续 Stage 1/2/7 core 化，再接 Stage 13、15–18、20–22。
8. 单独处理 UI 排版修复并做 Tauri/WebView2 多尺寸验收。
9. 当前跨层工作形成可审查提交后，再推进 D30、decoder/device、网易云剩余能力。

提交前必须逐项执行并记录：

```text
cd crates
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-targets --all-features --locked

cd ../crates/hyperplayer-source-netease
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-targets --all-features --locked

cd ../../src-tauri
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-targets --all-features --locked

cd ..
pnpm test -- --maxWorkers=1
pnpm frontend:build
pnpm exec tsc -p tests/oracle-tsconfig.json --pretty false
pnpm check:hse-source
pnpm check:hse-ts
node tests/check-js-licenses.mjs
cargo deny --manifest-path crates/Cargo.toml --config deny.toml check advisories licenses bans sources
pnpm build
```

还必须：

- 排除 `src-tauri/gen/`。
- 核对 `vgpu-diagnostic.tmp` 是否属于用户要求的正式文件。
- 对当前工作树重新运行 CI；旧 main 绿灯不算当前证据。
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

缺少外部资源时，只能标记“代码完成、外部验收阻塞”，不能标记“功能完成”。

---

## 18. 子代理与热点文件规则

- 子代理必须有严格文件白名单。
- `actor.rs`、`runtime.rs`、`dsp.rs`、`repository.rs`、`adapters.rs`、DTO、bridge、store、Cargo、`lib.rs` 等热点文件必须单 owner。
- 不并发修改同一热点。
- 代理完成以实际 diff、主线程复审和命令结果为准，不能用文字声明替代。
- 每次阶段迁移顺序固定：vendored core API → adapter → vector/parity → revision/checkpoint/standby → zero allocation → full gates → delete duplicate body。
- 网易云继续 Cleanroom。
