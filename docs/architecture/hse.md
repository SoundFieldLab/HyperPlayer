# HSE（HyperSoundEngine）细节

**音效引擎 = HyperSoundEngine（品牌名 HSE）——当前唯一引擎**：由作者 IceFire_Icer 在独立仓库开发后整体融入本项目，**不是 HyperPlayer 内部自研**。

## 许可证红线

模块目录自带 [LICENSE](../../src/services/HyperSoundEngine-v1/LICENSE)（**CC BY-NC-ND 4.0**）+ [授权补充说明.md](../../src/services/HyperSoundEngine-v1/授权补充说明.md)（IceFire_Icer 对 HyperPlayer 项目的专项授权：允许在本仓库范围内使用、集成、修改、分发，含 `public/hse-worklet.js` 打包产物；授权日 2026-08-18）。

**勿删改模块内的 LICENSE / 授权补充说明 / THIRD_PARTY_NOTICES / 版权声明**；第三方在 HyperPlayer 之外取用该代码仍受 CC BY-NC-ND（署名/非商业/禁止演绎）约束。

## 命名

**命名已强制统一为 HSE**（2026-10-04 用户拍板；2026-10-24 HSE 1.5 优化快照接入时对快照源全文执行同一映射）：

- 类名 `HyperSoundEngine` / `HyperSoundEngineHost`
- 文件 `attachHSE.ts` / `HSEAdapter.tsx` / `HSEMixingStudio.tsx`
- 类型 `HSEEngineParams` / `HSEUiBridge` 等
- 引擎 id 与存储值 `hse`（audioEngineVersion 读到旧值 v3 自动迁移回写）
- 存储键 `hyperplayer:hse-*`（旧键 `hyperplayer:v3-*` 在读取处一次性迁移后移除）
- worklet `public/hse-worklet.js` + 处理器名 `hyperplayer-hse-effects`

**勿再新建 V3 命名标识符**；模块目录 `HyperSoundEngine-v1` 保留（品牌+版本语义）；模块内 docs/架构书的历史称呼仅作资料。

**品牌 grep 门禁**：`grep -rniE "waveforge|EngineV3|V3Adapter|V3Ui|V3Mixing|V3Host|v3-worklet|v3Hearing" src/services/HyperSoundEngine-v1` 必须为 0 命中（合法保留仅两种：旧存储键迁移代码、GPLv3/homepageV3.1 等第三方字样）。

## 目录与处理链

`src/services/HyperSoundEngine-v1/` — **HSE 引擎**（纯 TS DSP 内核，零运行时 npm 依赖）：

- `src/`
  - `dsp/` 纯 DSP 模块（实时/离线共用；含 `wasmSimdKernel.ts` 运行时生成 WASM SIMD128 复数乘法内核 + `vectorKernel.ts` 门面，f32 阈值 256 样本 / f64 512，不可用静默回退纯 TS）
  - `engine/HyperSoundEngine.ts` 14 级主链 + 第 15 级空间音频
  - `engine/ScenePresets.ts` 11 场景
  - `engine/ShareCodec.ts` 分享串（含 float32/float64 精度自描述）
  - `engine/builtinSceneSeed.ts` 发布种子
  - `worklet/`、`analysis/`、`offline/`（Separator 等）
  - `integration/`（Host + ProcessingNode 可序列化扩展节点 + SpatialAudioSource）
  - `spatial/`（纯 TS 空间渲染后端 + `kemarData.ts` 内嵌 KEMAR 实测 HRIR）
- `ui/` — **HSE 调音室**：左侧导航 9 页（主页 / 音效场景 / 均衡器 / 空间音效 / 空间音频 / 动态调音 / 分析 / 调音器 / 关于）+ **亮色薄荷玻璃主题**（`hse-theme.ts` 新主题 + `hse-glass.css`/`hse-main-controls.css`，主色 #006A63；`theme.ts` 的 `HSELegacyTheme` 是旧弹窗主题接口，勿与新 `HSETheme` 混淆）+ IR 库 / SOFA 导入（`h5wasm` 惰性动态 import）/ 头部追踪输入（WebSocket/Serial/BLE/DeviceOrientation）/ 保存状态指示
- `test/` + `ui/**/*.test.{ts,tsx}` + `src/spatial/test/`
- `vendor/`（soundtouchjs LGPL 原包副本**未安装未链接**；kemar 数据出处 README + h5wasm LICENSE）
- `docs/`、`attachHSE.ts`（**HyperPlayer 融合层**）、`../examples/dc-blocker.ts`（扩展节点第三方示例，verify 脚本依赖）

**处理链（顺序固定）**：输入 → 响度归一化增益 → 3D 环绕(轻量立体声旋转) → M/S(width + voiceBalance) → Pre-EQ(用户 EQ) → Deesser → Compressor → NightMode → 混响(卷积/算法/off 三路) → BassEnhancer → LoudnessComp(等响度补偿) → IEQ(Post) → [LUFS 采样点] → Limiter → 空间音频(第 15 级) → 输出。

LUFS 采样点在 Limiter 之前；`process()` 稳态零分配、同输入同参数必同输出。

## 关键参数与契约

- **BassEnhancer 含低音下潜 `lowBoostDb`（-6..+12dB）**：低通提取的低频带按增益混回（lowshelf 语义，真实低频能量提升；谐波路径只提供心理声学感知），分享串编解码同步支持。
- **EQ**：简约 5 段 / 专业 10|20 段 + 级联 Q 补偿。
- **分析页**：实时频谱 32 条对数频率轴（20Hz-20kHz，FFT 幅度已归一化 dBFS）+ LUFS/GR/特征 + 听力测试，100ms 轮询 + EMA 平滑。
- **调音室音量滑块**：经 `loudnessNormalization.externalGainDb` 通道（0-100% → -60..0dB），**80ms 快平滑跟手**（自动响度归一化仍慢速防抽吸）；**音量独立于场景预设/组合**——`applyScene` 保留 loudnessNormalization 状态。
- **参数契约（2026-10-24 快照接入）**：`HyperSoundEngine.setParams` 为**引擎自有快照逐字段结构化同步**（无深拷贝/无 JSON.stringify 比较），**不要**依赖「引擎持有传入对象引用」，也不要直接改 `engine._params` 构造测试（会被正确判为无变化）；全链路 Float64 经 `setPrecision('float32'|'float64')`（默认 float32，切换重建并 reset 后端，prepared 负载带精度/采样率自描述校验）；`bitPerfectBypass` 内部逐位旁路；遥测 `EngineConfigWork`（`getConfigWork`）汇总到 Worklet `timing`（`paramsApplied`/`roomRebuilds`/`droppedRoomHrir` 等字段，勿当验收指标）。

## 宿主与接线

`attachHSE.ts` 管理 `HyperSoundEngineHost` 单例（mode 'auto'：worklet 优先、失败回退 script；`masterGain` 全断重连防双链并联）。

- 参数快照持久化 `hyperplayer:hse-params`（含 `__masterSnapshot` 旁路快照；旧键 `hyperplayer:v3-params` 读取时自动迁移；卷积 IR 数组不入库）。
- UI 桥唯一提交路径 = `createHSEUiBridge(engine, fs, { submit })`（`applyScene`/patch/replace 全走 submit：ReplayGain 注入 → 值相等短路 → 宿主+worklet 双下发 → 持久化 → SoundTouch 前置链同步 → `subscribeParams` 通知已打开的调音室）。
- 系统音量 → 等响度补偿；听力测试纯音（`hseHearingPlay`/`hseHearingStop` 事件）。
- 音频图 `masterGain → [SoundTouch 变速变调] → HSE 节点 → analyser`，波形取效果链后左右分析器（`useAudioPlayer` 产出的 `leftAnalyserNode/rightAnalyserNode`，经 `channelSplitterNode` 由宿主连接）。
- IR 去重按 **WeakMap 引用 token**（勿改回内容 hash 或「有/无 IR」）。

## ReplayGain 曲目生命周期

`HSEAdapter.setPlaybackSource(url, tags?)`（`IAudioEngineAdapter` 可选能力）由 App 在真实曲目提交（`applyLoudnessNormalization` 同点）与引擎热切换后调用。

已有标签直传，否则 `scanHSETrackReplayGain` 按头/尾有限区间扫描 ID3v2/FLAC 标签（每段 ≤1MiB，AbortController 切歌即取消，直播/无标签安全回退，复用正常播放 URL 不新增网络通道）；切歌/切走清增益，不跨重启持久化。

## 离线导出

`exportHSEMp3`（lamejs 128kbps，需 `ensureLameEncoder()` 全局挂载补丁）与 `exportHSEWav`（16-bit PCM，量化 `plain/tpdf/noiseShaped`，默认 TPDF）共用同一段 `renderHsePcm` 离线渲染链：

- 输入 ≤32 声道（mono 补双声道）
- 同步当前 SOFA HRTF 网格（`readActiveHrtf`）
- pitch 激活时仅前 L/R 走 Stretch（其余声道按拉伸长度对齐，近似路径）
- 1s 尾音冲刷

**导出容器仍是双声道**，勿宣称多声道文件输出。Electron 经 `saveHseRenderedAudio` IPC 直写桌面（重名自动 (2)，300 MiB 上限），网页退化为下载。

## 开发者模式（内置场景微调）

关于页开关（`hyperplayer:hse-dev-mode`）→ 音效场景页出现编辑入口，可实时试听修改内置 11 场景并保存为**参数覆盖层**（`ui/sceneStore.ts`，localStorage `hyperplayer:hse-scene-overrides`，旧键迁移；入库快照剥离音量通道 + IR）。

支持单场景还原出厂、场景库 JSON 导出/导入；桥接口对应 `updateBuiltinScene` / `resetBuiltinScene` / `exportSceneLibrary` / `importSceneLibrary`。

**发布种子**：`src/services/HyperSoundEngine-v1/src/engine/builtinSceneSeed.ts`（随包分发的官方默认层）——场景页「写回发布种子」在开发模式经 IPC `hse-write-scene-seed`（preload `writeHseSceneSeed`，main.cjs 限 `!app.isPackaged`）直写该文件后 commit/push 即全员生效；revision 每次 +1，本机 rev 低于种子时个人旧微调自动让位官方新值。

## 构建与验证

- Worklet 处理器经 `npm run build:hse-worklet`（`scripts/build-hse-worklet.mjs`，esbuild 单文件，支持 `--force` 与 mtime 新鲜度跳过）打入 `public/hse-worklet.js`（**当前 ~507 KB**，接入后实测 507,014 bytes；消息协议含帧边界零分配 + 预准备房间/IR Transferable 缓存，Host 与 Worklet 必须同版）。
- 装载与 DSP 冒烟验证：`npm run verify:hse-worklet`（vm 装载 + 空间/多声道/IR 复用/帧边界 reset/扩展节点/5.1 折叠/第三方 `examples/dc-blocker.ts` 打包）。
- 改引擎算法前先跑 `npx vitest run src/services/HyperSoundEngine-v1`（基线：110 文件 / 1123 通过 + 16 跳过；跳过 = 5 项可选 LGPL SoundTouch 适配 + 11 项显式诊断微基准）。

## 空间音频（第 15 级，纯 TS 引擎内联）

`src/services/HyperSoundEngine-v1/src/spatial/` 为纯模块（无浏览器/工作线程依赖），由 `HyperSoundEngine` 以相对路径（`../spatial/...`）内联调用——**不是**独立 AudioWorklet 节点，也无 Rust 后端（矢量复数乘法走 `dsp/wasmSimdKernel.ts` 运行时生成 WASM，无外部 .wasm 文件/工具链）。

后端为 `TsConvolverBackend`（复用 `dsp/Convolver.ts` 分区 FFT 卷积；另有时域直接卷积 `TimeConvolver.ts`，两种模式干湿对齐一致）。能力：

- **内嵌 KEMAR 实测 HRIR**（`kemarData.ts` base64 内嵌 368 方向，`measuredHrtf.ts` 构造时解码+重采样）
- **通用 SOFA 导入**（`ui/sofaImport.ts` 惰性 `import('h5wasm')`，IndexedDB `hyperplayer:hse-ir-library`/`impulses` 存 IR、`hse-spatial-hrtf-v1` 存网格，混用精度/采样率的 prepared 负载被拒）
- 双插值模式（最近邻网格 / 实球谐 L=3 最小二乘拟合）
- 房间模拟（镜像声源法早期反射 + FDN 8 条质数延迟线晚期混响，7 种预设）
- Ambisonics 环境上混
- 多声道输入映射（binaural / stereo / multichannel，`processMulti`，离散输入容量 32，`channelCountMode='max'` + `discrete`，5.1/7.1 折叠；无有效 mask/标签不猜声道顺序）
- 多普勒 + 遮挡/衍射简化模型

UI 模式：一键空间化 / 头锁定环绕（5.1 / 5.1.4 / 7.1 / 7.1.4 / 自定义，环形编辑上限 16 只扬声器）/ 世界漫游 / 舞台影院（4 场景预设 + 座位）。头部追踪输入组件支持 WebSocket/Web Serial/BLE/DeviceOrientation（OSC 本机桥脚本未迁入，WebSocket 头追需自备桥）。音箱校准是几何估算 + IR 分析工具（无麦克风采集）。空间参数是 `HSEEngineParams.spatial` 的一部分，随 `hyperplayer:hse-params` 快照持久化。

## 引擎适配层

`src/services/audioEngineVersion.ts`（localStorage `hyperplayer:audio-engine-version`，默认 **hse**；读到旧值 v3 自动迁移回写）。

统一适配层 `src/services/audio-engine/`（`types.ts` 接口 + `HSEAdapter.tsx` + `engines/hse.ts` 清单 + `index.ts` 注册表 + 工厂 `getEngineAdapter`）：App.tsx 持有 `engineAdapterRef`，引擎操作收敛为 `engineAdapterRef.current.xxx()` 单一调用（attach/dispose/setSystemVolume/setPlaybackSource/applyLoudnessNormalization/exportMp3/exportWav/renderStudio），按 `adapter.capabilities` 判断能力而非写版本分支。

**注册表目前只有 hse 一项，调音室的引擎切换 UI 已随 v1/v2 删除**（切换机制仍在，但单引擎下不显示按钮）。`HSEAdapter` 为 `studioMode: 'custom'`（`renderStudio` 返回 HSE 调音室 `HSEMixingStudio.tsx`，注入 exportMp3/exportWav 闭包 + exporting 状态；导出状态经 `onExportingChange` 事件通知 App）。

**接入新引擎**：写 `XxxAdapter.ts` 实现 `IAudioEngineAdapter` + 加 `engines/xxx.ts` 清单 + 在 `index.ts` 注册表加一行，App.tsx 零改动（`types.ts` 中 generic 模式对应的 `GenericMixingStudio` 当前并不存在，属未来占位）。
