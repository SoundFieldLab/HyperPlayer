# HyperPlayer 可视化基础交接

更新时间：2026-09-01

> 本文件是本轮 UI/vGPU 审计与 telemetry 实施的专项交接，不替代仓库原有 `handover.md`。

## 1. 本轮目标

本轮依据 `docs/UI设计基线.md`、`docs/UI定调决策记录.md`、D31/UI-D80 和现有代码，完成两部分工作：

1. 审计 UI 定调在当前产品中的实际落实程度。
2. 建设 vGPU 之前必须具备的可视化基础：Rust bounded telemetry、Tauri 二进制会话、前端 decoder/session 和 Canvas2D/SVG/DOM fallback。

本轮明确未引入 vGPU/WebGPU，也未改造网易云、曲库、缓存等业务流程。

## 2. UI 实现审计结论

按以下四层判断功能是否完成：

1. 页面或组件存在；
2. 已连接真实 Rust/Tauri 数据和命令；
3. 错误、空状态、权限、键盘和完整交互闭环；
4. 正式 Tauri/WebView2 多尺寸、辅助功能和用户视觉验收完成。

估算结果：

- 页面与产品结构：约 65–75%。
- 真实功能闭环：约 45–55%。
- 完整 UI 定调要求：约 30–40%。
- 正式视觉和辅助功能验收：低于 20%。
- 本轮开始前的 vGPU 运行时完成度：约 0–5%。

以上是审计区间，不是自动测试覆盖率。

### 2.1 已有真实链路

- Rust 权威播放、队列、恢复和 gapless 基础。
- 本地文件夹选择、扫描、索引、曲库查询和歌单 CRUD。
- 部分网易云公开发现、搜索、详情、账号、歌词和缓存流程。
- 播放坞、展开播放层和队列面板。
- LRC/YRC/TTML、逐词歌词、翻译和跟随滚动。
- 迷你播放器、桌面歌词、托盘和关闭确认。

### 2.2 主要部分实现或 scaffold

- 双内容域和独立导航历史存在，但 scroll/filter/selection 快照未完成。
- 导航仍不可由用户排序、隐藏、固定和恢复默认。
- 部分网易云侧导航仍落到本地视图。
- 顶栏 FM 仍指向 Discover，不是完整个人 FM 页面。
- “播放全部”部分场景仍只启动第一首，没有构造完整上下文。
- 本地首页未按定调完成。
- 全局搜索仍是命令启动器和有限搜索，不是完整跨实体搜索。
- 输出设备、独占模式、完整 SMTC 启用链路未完成。
- DSP 引擎已有实际能力，但正式 `DspPort`、参数编辑、预设和工作台控制桥仍未接通。
- 多尺寸、DPI、forced-colors、文本缩放和逐页视觉验收未完成。

## 3. vGPU 使用边界

### 3.1 允许使用的主窗口 surface

1. 展开播放页 B 材质封面氛围。
2. 用户按需打开的微型 waveform/spectrum。
3. DSP 工作台 response curve、FFT 和 meters。
4. DSP Spatial/HRTF 的 2D 或克制 2.5D 场景。
5. 本地/网易云首页真正完成后的单个 continue-listening hero，可选低频动态背景。

### 3.2 禁止使用

- 迷你播放器和桌面歌词不得创建独立 GPU context。
- 不使用 vGPU 计算权威 FFT、LUFS、true peak、limiter 或 HRTF。
- 不将 raw PCM 传给 WebView。
- 高频 telemetry 不进入 Zustand 或通用 Tauri events。
- 不将普通导航、表格、搜索、账号、缓存、设置和队列 GPU 化。
- 不制作常驻全屏频谱、粒子、频谱环或纯装饰音频背景。
- WebGPU 不得成为播放、DSP 编辑、缓存、权益或启动的必要条件。

正确实施顺序：

```text
Rust telemetry
→ Canvas2D/SVG/DOM fallback
→ vGPU renderer
→ Tauri/WebView2 device-loss 和像素验收
```

## 4. 本轮已实现的 telemetry 基础

### 4.1 Engine producer

新增：

- `crates/hyperplayer-engine/src/telemetry.rs`

并接入：

- `crates/hyperplayer-engine/src/runtime.rs`
- `crates/hyperplayer-engine/src/actor.rs`
- `crates/hyperplayer-engine/src/lib.rs`

当前能力：

- 固定 tap：`post_dsp_pre_output_gain`。
- 只分析 active PCM 中 `AudioOutput::write` 实际接受的前缀。
- standby DSP 预处理不产生 telemetry。
- 64-bin stereo waveform。
- 真实 sample peak 和 RMS。
- 0/2/15/30 Hz activity demand。
- 多 subscriber 取最高活动率。
- 双槽原子 latest-frame overwrite。
- `EngineHandle::subscribe_telemetry()`，不经过高频 `EngineEvent`。
- load、seek、stop、standby promotion 建立新 epoch。
- ingest 路径无分配、无锁、无等待。

### 4.2 HPTM v2 wire schema

当前固定帧大小为 780 字节，低于 1 KiB：

```text
0..4    magic = HPTM
4..6    version = 2
6..8    validity flags
8..16   epoch u64
16..24  sequence u64
24..32  accepted sample frame u64
32..40  DSP revision u64
40..44  sample rate u32
44      waveform bin count
45      spectrum bin count
46..48  reserved
48..560 waveform arrays: Lmin/Rmin/Lmax/Rmax, i16
560..752 reserved spectrum area, u16[96]
752..780 meter scalar area, f32[7]
```

当前只声明以下 validity：

- waveform
- sample peak
- RMS

以下能力尚未有权威生产者，因此必须保持 unavailable：

- spectrum/FFT
- true peak
- limiter reduction
- LUFS telemetry

已移除实时线程中的伪频谱计算；固定 spectrum 区域暂时写零，且 validity 不启用。前端不得显示为真实频谱。

### 4.3 Tauri binary session

新增：

- `src-tauri/src/commands/telemetry.rs`

并修改：

- `src-tauri/src/ports.rs`
- `src-tauri/src/adapters.rs`
- `src-tauri/src/dto.rs`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/lifecycle.rs`

当前能力：

- `telemetry_subscribe`
- `telemetry_ack`
- `telemetry_set_activity`
- `telemetry_close`
- Tauri raw binary `Channel`，不使用通用 JSON event 传帧。
- 每个 WebView 一个 session，全局最多两个。
- 每 session 一个 in-flight frame，积压覆盖旧帧。
- ACK 精确校验 Engine epoch、sequence 和 DSP revision。
- 排序按 `(epoch, sequence)`，不是 DSP revision。
- 动态活动率 0/2/15/30 Hz，可从低速恢复到 30 Hz。
- 同窗口 StrictMode 重挂载原子替换旧 session。
- 窗口销毁时关闭 session 和 polling worker。
- 所有 IPC `u64` 字段使用十进制字符串，避免 JavaScript 精度丢失。
- Tauri 将 Engine 生成的 HPTM 帧原样转发，不添加第二层 wire header。

### 4.4 Frontend telemetry 和 fallback

新增目录：

- `app/visualization/telemetry/`
- `app/visualization/renderers/`

当前能力：

- HPTM v2 严格 decoder。
- `bigint` epoch、sequence、sampleFrame 和 revision。
- validity flags，缺失数据保持 `null`。
- 独立于 Zustand 的 component-scoped session client。
- 共享、引用计数的 main-window telemetry client。
- StrictMode 延迟关闭和重挂载复用。
- epoch 单调检查，拒绝 rollback。
- ACK rejection 会关闭/报告，不会静默卡住 session。
- 0/2/15/30 Hz activity controller。
- Canvas DPR 上限 2。
- `WaveformCanvas2D`。
- `SpectrumCanvas2D`，但只有 spectrum validity 有效时才可使用。
- `ResponseCurveSvg`。
- `MeterStrip`，当前只显示真实 sample peak 和 RMS。

### 4.5 页面最小接线

#### 展开播放层

`app/player/Player.tsx`：

- 原合成正弦 waveform 已删除。
- 只在用户打开 waveform 时订阅。
- 使用真实 telemetry waveform。
- 无帧或不可用时显示静态基线，不伪造数据。
- 监听 visibility、focus 和 reduced motion。
- 高频帧不进入 store。
- Stop 按钮已恢复。

#### DSP scaffold

`app/pages/ContentViews.tsx`：

- 使用共享 telemetry session。
- 接入 `MeterStrip`。
- spectrum 无权威数据时不显示伪频谱。
- 使用固定 0 dB `ResponseCurveSvg`，并明确标记为参考线，不代表当前 DSP 配置。
- 参数控制继续禁用，仍明确 `DspPort` 未连接。

## 5. 独立复审发现及处理

独立复审曾发现：

1. 将时域能量冒充 FFT、sample peak 冒充 true peak。
2. 低速打开 session 后不能恢复 30 Hz。
3. epoch rollback 可污染当前 stream。
4. Player StrictMode 会与同窗口 session ownership 冲突。
5. ACK rejection 被忽略，session 会永久停住。
6. `u64` 转 JSON number 会丢精度。
7. 窗口销毁可能泄漏 session 和 polling worker。
8. Canvas DPR 未限制到 2。
9. telemetry 改动误删 Stop 按钮。
10. power-save 字段没有可信系统来源。

除第 10 项外均已修复。Power-save 当前保持模型字段但固定 false；在接入可信 Windows power API 前不伪造状态。

## 6. 已通过的测试记录

在不同中间节点已通过：

- Engine 完整 workspace：HyperPlayer engine、HSE core、HRTF core、DSP parity、实时零分配和参数扫描全部通过。
- Tauri telemetry 修复后：111 tests passed。
- 前端 telemetry 修复后：163 tests passed（串行）。
- 较早的完整前端基线：154 tests passed。
- Engine 和 Tauri strict Clippy 曾通过。
- IPC contract：84 commands / 14 events。
- frontend build 与 NetEase TypeScript oracle 曾通过。
- 初版 telemetry 上完成过完整 `pnpm build`，生成 NSIS/MSI。

这些结果不是最终状态的完整绿灯，因为随后发生了 HSE/LUFS 和 DSP execution 状态的并发迁移。

## 7. 当前未收口阻塞

### 7.1 HSE/LUFS coherent snapshot

并发 HSE 融合一度将 `SharedLufsState` 留在半迁移状态。修复代理已完成：

- generation + 多槽 coherent snapshot；
- 固定次数读取与 fallback；
- realtime integrated/momentary fast path；
- `fault_stream_frame` 测试字段补齐。

代理专项结果：

- LUFS 8/8
- Loudness normalization 4/4
- DSP parity 2/2
- realtime invariants 7/7

但在 telemetry validity 最终修正后，尚需重新执行一次完整 Engine workspace 测试和 Clippy。

### 7.2 DSP execution 状态跨层缺失

当前 Rust `PlaybackSnapshot` 已含独立 `dsp_execution` 状态，但以下边界仍未完整映射：

- Tauri `EngineSnapshotDto`
- `adapters.rs::engine_dto()`
- 前端 `BackendEngineSnapshotDto`
- 前端 `PlaybackSnapshotDto`
- `adaptPlayback()`
- `createEngineSnapshotGate()`
- store `dspDiagnostic`

需要实现规则：

- playback revision 与 DSP revision 独立合并。
- 更新 DSP revision 覆盖旧状态。
- 同 DSP revision 的 safe-bypass/fault escalation 可生效。
- 同 revision 的 healthy 状态不能清除已记录 fault。
- 更新 DSP revision 的 healthy 状态可以清除 fault。
- bootstrap 能恢复已经生效的 safe-bypass diagnostic，但不重复弹旧 toast。
- standalone DSP fault event 继续产生即时 toast。

负责此修复的代理被停止，尚未完成。

### 7.3 前端并行测试竞态

`navigation.test.ts`：

- 单独运行通过。
- 全量 `--maxWorkers=1` 时通过。
- 默认并行时慢测试可能超过 15 秒并污染后续 React `act()` 生命周期。

不要为此修改导航业务逻辑。完成 deterministic DSP execution failures 后，应先用单 worker 建立最终基线，再决定是否调整 Vitest file parallelism 或单个测试 timeout。

### 7.4 jsdom canvas 输出噪声

测试通过，但 jsdom 会打印：

```text
Not implemented: HTMLCanvasElement's getContext()
```

应在 `Player.test.tsx` 和 `ContentViews.test.tsx` 增加测试级最小 `getContext` mock，不安装 `canvas` 包。

## 8. 当前运行状态

- Tauri dev 已停止。
- 初版 telemetry 的 release/NSIS/MSI 构建成功。
- 最终 HPTM v2、lifecycle 和 LUFS 修复后尚未重新执行完整 `pnpm build`。
- 尚未完成最终真实 Tauri/WebView2 页面验收。
- 没有提交或推送。

## 9. 恢复执行顺序

1. 完成 DSP execution 状态从 Rust → Tauri DTO → frontend gate → store 的映射。
2. 重新运行 Engine workspace 全目标测试和 strict Clippy。
3. 重新运行 Tauri 111+ tests 和 strict Clippy。
4. 运行前端：
   - deterministic 相关 suites；
   - `pnpm test -- --maxWorkers=1`；
   - TypeScript/IPC/frontend build；
   - NetEase oracle。
5. 为 jsdom canvas 增加测试级 mock，清除控制台噪声。
6. 运行最终 `pnpm build`，重新生成 NSIS/MSI。
7. 启动 `pnpm dev`，使用 Computer Use 在正式 WebView2 验收：
   - DSP 页面 flat reference 和真实 sample peak/RMS fallback；
   - spectrum 在无权威数据时不冒充显示；
   - 有播放曲目时打开/关闭 waveform；
   - focus/visibility/reduced-motion activity；
   - StrictMode/session 无泄漏；
   - 无 telemetry 时播放不受影响。
8. 最终独立复审。
9. 更新原 `handover.md` 和 D31/UI-D80 实施状态。

## 10. 重要约束

- 本轮没有安装 vGPU，也没有实现 WebGPU/shader/device-loss。
- 不得在最终验证前把当前 fallback 描述成 vGPU 已接入。
- 不得显示没有权威生产者的数据。
- 不得将 raw PCM、身份、路径、账号、URL、缓存或数据集信息传入 WebView telemetry。
- 不得将高频帧放入 Zustand 或普通 Tauri events。
- `src-tauri/gen/` 是生成物，不纳入正式提交。
