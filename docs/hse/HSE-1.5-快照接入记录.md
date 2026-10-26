# HSE 1.5 优化快照接入记录（2026-10-24）

记录 `temp/hse-optimise`（HSE 独立优化快照，作者在 WaveForge 语境下完成 round-1/round-2 优化）整体接入 HyperPlayer 主程序的事实：来源、映射约定、接线点、验证结果与回滚单位。快照原始交接文档（`MAIN_APP_INTEGRATION_HANDOVER.md` / `UPDATE_3.5.md` 等）留在 `temp/` 作历史资料，**未原文入库**（满是 WaveForge-v3 语境，品牌统一见下）。

## 1. 接入范围与规模

- 快照模块 272 文件 → 目标 `src/services/HyperSoundEngine-v1/`（原 155 文件被快照版整体覆盖；4 个改名分叉文件 `attachHSE.ts` / `src/engine/HyperSoundEngine.ts` / `src/integration/HyperSoundEngineHost.ts` / `ui/HSEMixingStudio.tsx` 由快照对应文件经品牌映射取代）。
- 快照相对旧版主要新增：WASM SIMD128 复数乘法内核（运行时生成，无工具链/无外部 .wasm）、全链路 Float64（`setPrecision`）、bit-perfect 内部旁路、Worklet 帧边界零分配、`setParams` 结构化同步 + `EngineConfigWork` 遥测、IR 库 / SOFA 导入（h5wasm）/ 头部追踪输入组件、32 声道离散输入容量、MP3+WAV 双导出（TPDF 量化）、ReplayGain 标签解析/扫描、`createHSEUiBridge(engine, fs, {submit})` 统一提交路径、保存状态指示、调音室亮色薄荷玻璃主题。
- **不迁入**：快照根 `integration/V3AdapterSnapshot.tsx(+test)`（接线参考类，行为已并入正式 `HSEAdapter`）、`rust/`（空目录）、`.verification/`、`node_modules/`、快照 `public/v3-worklet.js`（产物，重建）、性能探针/benchmark 脚本（用户已拍板不再做性能优化）、OSC 头追桥脚本（`head-tracking-bridge.cjs` 等，连带省掉 `ws` 依赖——WebSocket 头追模式暂不可用，Serial/BLE/陀螺仪不受影响）。
- **迁入的外围**：`examples/dc-blocker.ts`（扩展节点第三方示例，`verify:hse-worklet` 依赖）、`spatial-debug.html` + `src/spatial-debug/`（调试页）、`scripts/generate-kemar-hrtf.py`（数据再生成工具）、`vendor/kemar/`（README + compact.zip 出处存档）、`vendor/h5wasm/LICENSE.txt`。

## 2. 品牌映射（对快照源全文执行）

用户拍板的品牌决策（2026-10-04 V3→HSE 统一 + 本次延续）对每个迁入文件全文应用，先长 token 后短 token，**绝不做裸 `v3` 替换**；独立 `v3/V3` token 用 lookaround 正则（排除集 `[A-Za-z0-9_./+=]`——必须含 base64 字符 `+/=`，否则内嵌数据块会被误改）。

| 快照侧 | HyperPlayer 侧 |
|---|---|
| `attachV3Engine.ts` / `EngineV3.ts` / `EngineV3Host.ts` / `V3MixingStudio.tsx` | `attachHSE.ts` / `HyperSoundEngine.ts` / `HyperSoundEngineHost.ts` / `HSEMixingStudio.tsx`（文件名+标识符） |
| `createV3UiBridge` / `useV3Params` / `V3UiBridge` / `V3EngineParams` / `V3Theme` | `createHSEUiBridge` / `useHSEParams` / `HSEUiBridge` / `HSEEngineParams` / `HSELegacyTheme`（theme.ts 旧弹窗主题接口，与新 `hse-theme.ts` 的 `HSETheme` 并存防撞名） |
| `waveforge:v3-params` / `v3-my-scenes` / `v3-scene-overrides` / `hse-dev-mode` / `hse-ir-library` | `hyperplayer:hse-params` / `hse-my-scenes` / `hse-scene-overrides` / `hse-dev-mode` / `hse-ir-library` |
| `waveforge-v3-effects` / `v3-worklet.js` | `hyperplayer-hse-effects` / `hse-worklet.js` |
| `v3HearingPlay/Stop` / `WaveForge` 文案 | `hseHearingPlay/Stop` / `HyperPlayer` 文案 |

**合法保留**（grep 门禁白名单）：① 旧存储键迁移代码（`hyperplayer:v3-params` 等 3 处 LEGACY 常量——迁移逻辑必须引用旧键名）；② `GPLv3`（许可证名）等第三方自有字样。门禁：`grep -rniE "waveforge|EngineV3|V3Adapter|V3Ui|V3Mixing|V3Host|v3-worklet|v3Hearing" src/services/HyperSoundEngine-v1` = 0 命中。

## 3. HyperPlayer 专属回填（快照没有、接入时补齐）

1. `attachHSE.ts`：restoreParams 读 `hyperplayer:v3-params` 旧键一次性迁移后移除（+LEGACY_PARAMS_KEY）。
2. `ui/bridge.ts`：loadMyScenes 同款旧键迁移（+LEGACY_MY_SCENES_KEY）。
3. `ui/sceneStore.ts`：readStoredBundle 同款旧键迁移（+LEGACY_SCENE_OVERRIDES_KEY）。
4. `ui/pages/ScenesPage.tsx`：`writeHseSceneSeed` IPC 写回块**快照已自带**，无需回填。

## 4. 接线（快照能力 → 主程序）

| 能力 | 接线点 |
|---|---|
| WAV 导出 | `HSEAdapter.exportWav` → `exportHSEWav`；`renderStudio` 注入 `exportMp3`/`exportWav` 闭包（共用 exporting 状态 + 错误 toast） |
| ReplayGain 曲目生命周期 | `types.ts` 增可选 `setPlaybackSource(url, tags?)`；`HSEAdapter` 持 sourceUrl + AbortController（切歌即取消旧扫描、切走清增益）；App.tsx 在真实曲目提交点（`applyLoudnessNormalization` 同点）与引擎热切换补挂点调用 |
| subscribeParams | `attachHSE.ts` ensureBridge 实现（listener 集合，submit 成功后通知；系统音量/ReplayGain 注入经同一路径天然覆盖；订阅者只读不重提交） |
| 左右波形 | `useAudioPlayer.ts` 音频图新增 `channelSplitterNode` + 左右 AnalyserNode（fftSize 2048，纯探针不接 destination）；`AudioGraphHandle` 类型扩展；`attachHSE.getWaveform` 从效果链后左右分析器取数 |

**暂缓**（有意不做，非遗漏）：多声道文件源与 `SpatialAudioSource` 重排接入——HyperPlayer 三音源（网易云/QQ/B站）都是立体声流，收益极低；引擎/宿主已具备 32 声道容量，未来需要时再接。

## 5. 构建 / 测试配置

- `scripts/build-hse-worklet.mjs`：快照版（`--force` + mtime 新鲜度跳过），入口/产物/横幅全部 HSE 化。
- `scripts/verify-hse-worklet.mjs`：新增（快照 verify-worklet 的 HSE 版，处理器名断言 `hyperplayer-hse-effects`；含「显式复制子树」修正版测试语义——不许直接改 `engine._params` 构造参数）。`npm run verify:hse-worklet`。
- `scripts/spatial-preview.mjs`：端口 3290/3291（避开 WaveForge 段与 3210/3211），fs.allow 指向本仓根。`npm run preview:spatial`。
- `h5wasm@^0.10.3` → **devDependencies**（前端库分区铁律；SOFA 导入时惰性 `import('h5wasm')`，Vite 分包为懒加载 chunk，不进首包）。
- `vitest.config.ts`：include 增 `HyperSoundEngine-v1/ui/**/*.test.ts`（非 tsx，如 headTrackingInput）；**`maxWorkers: 2`**（快照同款限流——HSE 持久化/时序测试 1200ms 级用例对 CPU 负载敏感，不限流全量并行会偶发超时）。
- `tsconfig.json`：exclude 模块三处测试目录（`test/**`、`src/spatial/test/**`、`ui/**/*.test.*`）——快照约定测试只跑 vitest（esbuild 无类型检查），其测试写法从未按 strict 检查；生产代码（src/ui/attachHSE）仍全覆盖。
- `examples/dc-blocker.ts`：`verify-hse-worklet` 第 203 行的第三方模块打包验证入口，缺失会让 verify 在 esbuild 处报错。

## 6. 验证结果（2026-10-24/25 实测）

| 门禁 | 结果 |
|---|---|
| `node scripts/build-hse-worklet.mjs --force` | ✅ 产物 507,014 bytes（快照基线 507,004，差 10 字节为横幅品牌化） |
| `node scripts/verify-hse-worklet.mjs` | ✅ 装载/空间房间/多声道 HRTF 路由/IR 复用/帧边界 reset/组合节点/5.1 折叠/第三方模块全部通过 |
| `npm run lint` | ✅ 0 error |
| `npx vitest run src/services/HyperSoundEngine-v1` | ✅ 110 文件（107 过 + 3 跳过）/ 1139 用例（1123 过 + 16 跳过 + 0 失败）≥ 快照基线 109 文件/1134 过/16 跳过 |
| `npm run test` 全量 | ✅ 183 文件全过 / 1789 用例（1773 过 + 16 跳过 + 0 失败） |
| `npm run check:ports` | ✅ 3210/3211 未被触碰 |
| `npm run check:packaging --config-only` | ✅ 依赖分区 + 排除规则（h5wasm 在 devDependencies） |
| `npm run build` | ✅ 17.2s；`dist/hse-worklet.js` 507,014 bytes；hdf5 chunk 4.78MB 为 h5wasm 懒加载分包 |
| 品牌 grep 清零 | ✅ 0 命中（白名单外） |

**未验证（留给实机）**：真实 Electron 试听（调音室九页、空间音频听感、ReplayGain 注入效果、WAV 导出文件可播、SOFA 导入在打包版 CSP 下工作——主窗口无 CSP meta，WASM 预期可用）、双引擎热切换听感。方法：`npm run dev:electron`。

## 7. WaveForge 后续微调并入（2026-10-25 第二轮）

用户提示：WaveForge 在同一份独立快照并入主程序后（`de7c8815`，2026-10-20）继续微调了一大批（至 `12274cd4`，2026-10-21），HyperPlayer 首轮接入用的是 10-20 快照副本、不含这些微调。本轮从 WaveForge `master`（`967c6b83`）tarball 系统对比后整体并入：

- **模块 11 个新文件**：`src/engine/EqCurve64.ts`（64 段 EQ 引擎侧）、`src/spatial/StereoDecorrelator.ts`（环绕去相关）、`ui/spatialPresetStore.ts`（我的空间方案本机预设）、`ui/components/HeadTrackingBridgeControls.tsx`（头追桥控制 UI）、`version.ts`（HSE 1.5 版本标签）等 + 对应测试（eq64-presets / spatial-mute / spatial-virtual-speakers / EqPage / HeadTrackingBridgeControls）。
- **43 个真实差异文件**并入（7.1/7.1.4 侧后声道映射修复、去相关热路径零分配、沉浸预设 HRTF 频谱早反射、空间早期反射阶数可调、虚拟扬声器 5.1/7.1.4、内置 EQ 预设重设计、页脚 LED 状态等）——全部过同一品牌映射表。
- **多声道播放链**：`src/audio/spatialPlaybackInput.ts`（双 deck SpatialPlaybackInput：WAV 多声道解码→受控 PCM 接管、元素静音时钟支路、非 WAV 安全回落）+ `useAudioPlayer` 增量（mediaSourcesRef 防 GC、configureDiscreteInput 离散声道开关、预载/加载/gapless 三处 prepare + 竞态防护、`getPlaybackSource`）+ `PreloadTrack.replayGainTags`。
- **适配层对齐 WF V3Adapter 语义**：`setPlaybackSource(EnginePlaybackSource | null)`（trackKey+url 判重、先清旧增益、直播跳过、tags 直传否则扫描）、导出并发守卫 + 无源校验；`IAudioEngineAdapter.setPlaybackSource` 签名同步。`useAudioPlayer` 新增 `onPlaybackSourceChange` 推送（过渡提交/接管/loadAndPlay 三处 notify），App 改为回调转发 + 热切换 `getPlaybackSource()` 重注入。
- **头部追踪宿主**：`desktop/hse-head-tracking.cjs`（可信窗口/会话级设备授权控制器）+ `scripts/head-tracking-bridge.cjs` + `scripts/lib/head-tracking-osc.cjs`（本机 OSC 桥，`ws` 进 **dependencies**）+ main.cjs 三 IPC + preload `hseHeadTracking` + electron.d.ts 类型 + serial 权限白名单（仅主窗主 frame）。
- **index.html**：首次引入 CSP（WF 同款最窄例外：`script-src 'wasm-unsafe-eval'`（HSE SIMD 内核 + h5wasm）、`connect-src * data:`）。
- **desktop/main.cjs**：`hse-save-rendered-audio` 增强（WAV 支持、wx 防并发覆盖、扩展名白名单、文件名清洗加强）。
- **闸门增强**：`check-packaging.mjs` 运行期入口补 `scripts/lib/`（否则头追桥的 `require('ws')` 不可见、误报 dependencies 分区违规）；`build.files` 白名单补 LICENSE 三件 + vendor 两件 + 头追桥两脚本；`test:desktop` 补 `test/hse-desktop.test.cjs`；vitest 新增 `test/spatialPlaybackInput.test.ts`。
- **不迁**（WF 专有）：`hyperplayer-media` 自定义协议（WF `waveforge-media`，服务其 AI 混音 stem 与下载音频映射，HyperPlayer 无此设施）、`test/v3AdapterLifecycle.test.tsx` / `modeIntegrationWiring.test.ts` / `hseSpatialInputLifecycle.test.ts`（断言 WF 特有结构与 TV 面）。
- **验证**：worklet 重建 514,949 bytes + verify 全过；模块+新增测试 115 文件 / 1174 用例 0 失败；全量 1840 用例 0 失败；test:desktop 全过；lint 0 error；品牌 grep 清零；ports / packaging / build 全过。

## 8. 评审后续项（2026-10-25 code review 结论）

- **`sanitizeForStorage` 三份副本待去重**（有意不在本次接入中动快照结构）：`attachHSE.ts` 版带 `p.reverb ?` 守卫 + 清 replayGainDb；`ui/bridge.ts` / `ui/sceneStore.ts` 版无守卫（其调用方保证 params 完整，不抛错）。未来提取共享 helper 时以带守卫版为基准，注意保留各调用方语义差异（场景覆盖层还要还原音量通道）。
- **快照性能测试文件保留**：`src/spatial/test/*Performance.test.ts` 等 3 个文件是 vitest 诊断微基准（默认跳过，属 16 项跳过的一部分），非运行时探针；保留即维持快照测试基线，删除会丢诊断能力。

## 8. 回滚单位

单 commit 回滚应覆盖：`src/services/HyperSoundEngine-v1/**`（整树）、`examples/`、`spatial-debug.html`、`src/spatial-debug/`、`scripts/build-hse-worklet.mjs`、`scripts/verify-hse-worklet.mjs`、`scripts/spatial-preview.mjs`、`scripts/generate-kemar-hrtf.py`、`package.json` + `package-lock.json`（h5wasm + scripts）、`vitest.config.ts`、`tsconfig.json`、`src/App.tsx`、`src/hooks/useAudioPlayer.ts`、`src/services/audio-engine/types.ts`、`src/services/audio-engine/HSEAdapter.tsx`、`public/hse-worklet.js`（重建回旧版）、`AGENTS.md` / `DEBUG_PAGES.md` / 本文档。
