# AGENTS.md — HyperPlayer

Desktop music player (Windows/Electron)，共 **5 个音源**：网易云 / QQ / Apple Music / Spotify 四个音乐平台（`src/services/platforms.ts` 的 `MusicPlatform`）+ **B站看歌**（`BilibiliMvPlayer` / 歌词模式 `video`）。Frontend React 19 + TypeScript + Tailwind CSS 4 + Vite 6, backend Node/Express（`local-server.mjs`，端口 3001）；Python 只用于 **Apple Music 播放面 bridge**（`python-apple-bridge/apple_bridge.py`，端口 18790，依赖系统 Python + pywebview，无嵌入式运行时）。UI text and code comments are predominantly **Chinese** — keep new user-facing strings consistent with the existing language. 仓库含 **Apple 歌词/探索分支**（`src/components/Apple*`）——改桌面端时勿破坏。

**本仓库为减配版（slimdown）**：已移除 Android TV（`android/`、TV 键盘/媒体键桥、nodejs-mobile 构建）、Python 节拍/响度/频响补偿服务（端口 3002/3003/3004 全部不再使用，`resources/python-embed/` 嵌入式运行时已删）、汽水（Qishui/Soda）与酷狗音源、音效引擎 v1/v2（**只剩 HSE v3 一个引擎**）、Folia/多维 Diorama/摩登/光荣/壁纸歌词/律动背景等歌词模式（收敛为 4 种）、DG_LAB 插件、AirPlay / 分轨 Stem / 远程遥控 / 设备授权 / 代理管理 / 爱发电同步 / Smart AutoMix（只保留 Fixed Crossfade + gapless + 专辑无缝）。**旧文档中描述这些功能的段落一律失效，勿据此恢复。**

## Commands

```bash
npm run dev:electron     # Full dev: Vite (3000) + API server (3001) + Electron window
npm run dev              # Vite dev server only (port 3000; Weather Lab: http://127.0.0.1:3000/weather-debug.html)
npm run lint             # Typecheck: tsc --noEmit (covers src/ only; no ESLint in repo)
npm run test             # vitest 单测 (test/ + src/services/HyperSoundEngine-v1/，2026-09-10 实测：145 文件 = 144 过 + 1 跳过；1292 用例 = 1286 过 + 5 跳过 + 1 todo。跳过的 5 项是 v3 LGPL 可选依赖未装自动跳过)
npm run build:v3-worklet # 重生成 v3 AudioWorklet 单文件 -> public/v3-worklet.js（predev/predev:electron/prebuild 已自动执行）
npm run build            # vite build -> dist/（三入口：index.html / desktop-player.html / desktop-lyrics.html）
npm run build:electron   # 发布：build:electron:dir + 安装器美术 + electron-builder NSIS -> release/HyperPlayer-<version>-Setup.exe
npm run build:electron:dir      # build + electron-builder --win dir + EVS VMP 签名/校验/状态 -> release/win-unpacked
npm run build:electron:dir:unsigned  # 同上但跳过 VMP 签名（仅本地诊断，不可发布）
npm run build:apple-weather  # 重新生成 Apple 天气场景资源（scripts/build-apple-weather-scenes.mjs）
npm run test:chroma      # Razer Chroma 插件自测（scripts/test-chroma*.cjs）
npm run test:signalrgb   # SignalRGB 插件自测（scripts/test-signalrgb*.cjs）
npm run test:desktop     # node --test 桌面/安全相关用例（apple-url-policy / trusted-ipc / update-manager / vmp-status 等）
npm run test:installer   # 生成安装器 UI 资产 + 安装器测试
npm run gen:installer-art    # 生成 NSIS 安装器美术资产
npm run preview:setup    # 预览自定义安装器（scripts/setup-preview/preview.nsi）
npm run benchmark:mv     # B站 MV 相关基准脚本
npm run version:patch|minor|major|pre  # 版本号更迭 (scripts/bump-version.mjs, 自动 commit/tag/push)
npm run version:dry      # 预览版本更迭 (不落地)
npm run vmp:sign:release / vmp:verify:release / vmp:status:release  # castLabs EVS Widevine VMP 签名 / 校验 / 状态（另有 *:dev 版本作用于 node_modules/electron/dist）
npm run start            # electron .（直接起已构建产物）
```

注意：`prebuild` / `predev` / `predev:electron` 钩子只做一件事——运行 `build:v3-worklet` 重打包 HSE 的 AudioWorklet 单文件到 `public/v3-worklet.js`。

**端口**：只有 3000（Vite dev/preview）、3001（Express 后端）、18790（Apple Music 播放面 Python bridge）。旧文档里的 3002/3003/3004（Python 节拍/响度/补偿）已全部停用。

## Independent debug pages

Before creating or using a standalone debug webpage, read [`DEBUG_PAGES.md`](./DEBUG_PAGES.md). It registers developer-only visual tools, their launch command, local URL, data/network constraints, and production-build status.

- **Weather Lab**: run the existing `npm run dev`, then open `http://127.0.0.1:3000/weather-debug.html`. Use it to compare all Apple weather scenes and desktop `full`/`simple` cards with local mock data. Do not add `weather-debug.html` to production Vite inputs（`vite.config.ts` 的 `rollupOptions.input` 已显式白名单为三个入口）。

**打包规则（electron-builder）**：`build.files` 白名单 = `desktop/**/*`、`dist/**/*`、`server/**/*`、`shared/**/*`、`python-apple-bridge/**/*`、`local-server.mjs`、`package.json`、`logo.png`、`build/**/*`（清单里还列了 `THIRD_PARTY_NOTICES.md`，但该文件当前不存在于仓库根，属悬空条目）。`build.asarUnpack` 解包 `python-apple-bridge/**/*.py`（Python 脚本不能从 asar 内执行）。已无 Python 节拍服务与离线 wheels，无需任何排除规则。

**发布策略（releases）**：**GitHub Releases 只发 NSIS 安装版**（`npm run build:electron` → `release/HyperPlayer-<version>-Setup.exe`），**不发便携版**（`release/win-unpacked/` 是本地调试产物，不随 releases 分发）。发布时：打 `v<version>` tag → push tag → `gh release create v<version> release/HyperPlayer-<version>-Setup.exe`（附 changelog）。安装版为每用户安装（`nsis.perMachine: false`），**不携带任何用户数据/配置**——用户配置生成于各机 `%APPDATA%\HyperPlayer\`，安装后自动适配当前用户。CI 见 `.github/workflows/ci.yml`（类型/单测/构建 + tag 出包）与 `nightly.yml`（每日 nightly）；两者都要求 EVS secrets，正式构建需 production streaming VMP 剩余 ≥30 天。

**发布形式一律为 Pre-release**：本仓库处于测试阶段，版本化发版（`pre-release.yml`，打 `v*` tag）与每日构建（`nightly.yml`）**全部以 GitHub Pre-release 形式发布**，不占用正式 latest。`nightly.yml` 每次构建生成唯一 tag `nightly-<YYYYMMDD>` 并创建**独立** Pre-release（历史全部保留；当天重复构建覆盖当天同名 tag/release）；只有 `pre-release.yml` 在 tag 为**纯语义版本号**（如 `1.0.0`）时才额外生成并提交 `update.json`，用作「设置 → 检查更新」的推送通道。nightly 不写 update.json。

**版本号更迭机制**：版本号唯一事实来源是 `package.json` 的 `version`（设置→关于页显示 `v{version} 预览版`，"检查新版本"功能对比 GitHub tag 与本地 version）。**版本号起点为 `1.0.0`**——本仓库自 1.0.0 起重新编号（减配 + 改名后的首个版本），此前的 0.x 记录已不再保留。使用 `scripts/bump-version.mjs` 自动更迭：

```bash
npm run version:patch   # 1.0.0 -> 1.0.1（修复）
npm run version:minor   # 1.0.0 -> 1.1.0（新功能）
npm run version:major   # 1.0.0 -> 2.0.0（破坏性）
npm run version:pre     # 1.0.0 -> 1.0.1-beta.0（预发布）
npm run version:dry     # 预览将要执行的操作（不落地）
```

脚本默认流程：更新 `package.json` + `package-lock.json`（顶层 `version` 与 `packages[""].version` **两处都改**，漏改会导致 `npm ci` 校验失败）→ commit `chore: bump version to vX.Y.Z` → 打 `vX.Y.Z` tag → push 分支与 tag。选项：`--no-commit` / `--no-tag` / `--no-push` / `--force`（工作区有未提交改动时默认拒绝，避免污染版本提交）。bump 后走发布流程：`npm run build:electron` → `gh release create`。

**版本标识唯一事实源**：`src/services/versionInfo.ts` 的 `VERSION_CHANNEL_LABEL`（当前为「预览版」）与 `getVersionLabel()`——关于页与文档都引用它，勿在别处写死标识文案。1.0 起代号统一为「澜 おおなみ」（`getVersionCodename`，`major >= 1`）。

**打包三大约束（破坏任一条便携版就会黑屏/缺资源）**：
1. `vite.config.ts` 的 **`base` 必须保持 `'./'`**（顶层配置，不要移进 `build` 子对象）——打包版用 `loadFile()`（file://）加载 `dist/index.html`，若 base 是 `'/'`，资源以 `/assets/...` 绝对路径引用全部 404，React 不挂载 → 整窗黑屏（症状：启动日志 `Renderer resources: 0`）。
2. `package.json` `build.files` 必须包含 **`logo.png` 与 `build/**/*`**——`desktop/splash.html` 引用 `../logo.png`，主窗口/登录窗口 icon 用 `../build/icon.ico`，漏打包则启动 logo 丢失。
3. `package.json` `build.electronDist` 保持 `node_modules/electron/dist`——本机网络无法下载 electron zip，electron-builder 离线构建全靠这个本地副本。

## ⚠️ 设置镜像机制（往设置里加功能前必读）

HyperPlayer 共 **4 个界面模式**（简约 minimal / 传统 traditional / 探索 explore / 桌面 desktop，后续可能更多）。**简约模式的设置（`src/components/SettingsPanel.tsx`）是整软件的"总设置"**，其中的全局功能性设置通过设置注册表自动镜像到其他模式：

- `src/services/globalSettingsRegistry.ts` — 声明式设置注册表。每条 `read/write` 与 SettingsPanel **同 localStorage 键、同自定义事件**，任意一端改动全软件同步；`components/MirroredGlobalSettings.tsx` 按各模式自己的设计语言渲染这张表（classic=传统模式 QQ 式布局 / panel=探索抽屉+桌面弹窗卡片式）。
- **在简约模式设置里新增功能开关时（播放/歌词/性能/桌面集成/网络等全局生效的设置）**：除了写 SettingsPanel 的简约 UI，**必须同步在 globalSettingsRegistry.ts 登记一条**，否则传统/探索/桌面模式的用户永远看不到该功能。自定义控件（如字体选择器 `components/FontPicker.tsx`）在 MirroredGlobalSettings.tsx 为新的 `control.kind` 加渲染分支。
- **简约模式专属的自定义/外观设置**（只影响简约模式自身，如"自定义首页显示内容"）不需要登记。
- 桌面集成类设置用 `available: hasXxxBridge` 门控（非 Electron 环境无桥时自动隐藏对应条目与标签页）。
- 桌面歌词是**独立透明窗口**（`desktop-lyrics.html` 入口 + `desktop/main.cjs` IPC 持久化），设置经 `window.electron.desktopLyrics.updateSettings` 下发，**纯 Web 页面测不了**（无桥接），需 `npm run dev:electron` 实测。

## Layout & boundaries

- `src/` — React frontend. `components/` (App.tsx lazy-loads nearly everything), `services/` (API clients, cache, gapless 逻辑, apple* 服务), `audio/` (playback engine: `PlaybackQueue.ts`, `transitionPlanner.ts`, `TransitionRenderer.ts`, `playbackTimeStore.ts`), `hooks/`, `api/`, `utils/`, `features/`(neteaseExplore/qqExplore), `vendor/pv`(PV 歌词渲染)。
- `src/services/gapless/` — **无缝衔接独立模块**（从 `useAudioPlayer.ts` 抽离）：`gaplessConstants.ts`（设置/常量）、`seamlessJoinController.ts`（首选拼接控制器：预热缓存/静音预启动/ended 拼接/边界调度/兜底，依赖注入）、`gaplessTransition.ts`（60ms 等功率双 deck 淡入淡出）。`useAudioPlayer.ts` 只保留调用接口（注入依赖 + 事件接线），改动无缝逻辑优先改此处。目录含 `LICENSE.private`（私有模块许可，见根 `PRIVATE-LICENSE.md`）。
- **过渡计划层已收敛**：`src/audio/transitionPlanner.ts` 保留 `planTransition` / `planTransitionV2` 导出，但 **只产出 `fixed-crossfade`**（smart-rendered / smart-rendered-v2 / beat-crossfade 生成分支已整体移除）；`transitionPlanner.ts` / `TransitionRenderer.ts` / `autoMixAnalysisService.ts` 仍保留节拍分析能力（供 MV 对齐、PV 歌词等消费），但不再用于智能混音。切歌时右上角弹 gapless 方案提示（`GaplessModeToast.tsx`：直接拼接 / 60ms 淡入淡出 / albumGapless 交叉淡化，`App.tsx` 按 transitionCommit.strategy + 专辑归属判定）。
- **音效引擎 = HyperSoundEngine（品牌名 HSE，即 v3）——当前唯一引擎**：由作者 IceFire_Icer 在独立仓库开发后整体融入本项目，**不是 HyperPlayer 内部自研**。许可证有特殊约束——模块目录自带 [LICENSE](src/services/HyperSoundEngine-v1/LICENSE)（**CC BY-NC-ND 4.0**）+ [授权补充说明.md](src/services/HyperSoundEngine-v1/授权补充说明.md)（IceFire_Icer 对 HyperPlayer 项目的专项授权：允许在本仓库范围内使用、集成、修改、分发，含 `public/v3-worklet.js` 打包产物；授权日 2026-08-18）。**红线**：勿删改模块内的 LICENSE / 授权补充说明 / THIRD_PARTY_NOTICES / 版权声明；第三方在 HyperPlayer 之外取用该代码仍受 CC BY-NC-ND（署名/非商业/禁止演绎）约束。**命名**：文档/UI/用户可见文案一律叫 **HSE**；但代码标识符保持不动（目录 `HyperSoundEngine-v1`、类名 `EngineV3`/`EngineV3Host`、localStorage `hyperplayer:v3-params`、脚本 `build:v3-worklet`），勿做全局重命名。
- `src/services/HyperSoundEngine-v1/` — **HSE 引擎**（纯 TS DSP 内核，零运行时依赖）：`src/`（`dsp/` 纯 DSP 模块（实时/离线共用）+ `engine/EngineV3.ts` 14 级主链 + 第 15 级空间音频 + `engine/ScenePresets.ts` 11 场景 + `engine/ShareCodec.ts` 分享串 + `engine/builtinSceneSeed.ts` 发布种子 + `worklet/` + `analysis/` + `offline/` + `spatial/`（纯 TS 空间渲染后端））、`ui/`（**HSE 调音室**——左侧导航 9 页（主页 / 音效场景 / 均衡器 / 空间音效 / 空间音频 / 动态调音 / 分析 / 调音器 / 关于）+ 深色琥珀金主题 + framer-motion 动效）、`test/` + `ui/**/*.test.tsx`、`vendor/soundtouchjs`（LGPL 原包副本，**未安装未链接**，适配层无调用方）、`docs/`（FUSION_GUIDE / UI_GUIDE / FEATURES_VERIFICATION 等）、`attachV3Engine.ts`（**HyperPlayer 融合层**）。
  - **处理链**（顺序固定）：输入 → 响度归一化增益 → 3D 环绕(轻量立体声旋转) → M/S(width + voiceBalance) → Pre-EQ(用户 EQ) → Deesser → Compressor → NightMode → 混响(卷积/算法/off 三路) → BassEnhancer → LoudnessComp(等响度补偿) → IEQ(Post) → [LUFS 采样点] → Limiter → 空间音频(第 15 级) → 输出。LUFS 采样点在 Limiter 之前；`process()` 稳态零分配、同输入同参数必同输出。
  - **BassEnhancer 含低音下潜 `lowBoostDb`（-6..+12dB）**：低通提取的低频带按增益混回（lowshelf 语义，真实低频能量提升；谐波路径只提供心理声学感知），分享串编解码同步支持。**EQ**：简约 5 段 / 专业 10|20 段 + 级联 Q 补偿。**分析页**：实时频谱 32 条对数频率轴（20Hz-20kHz，FFT 幅度已归一化 dBFS）+ LUFS/GR/特征 + 听力测试，100ms 轮询 + EMA 平滑。
  - **调音室音量滑块**：经 `loudnessNormalization.externalGainDb` 通道（0-100% → -60..0dB），**80ms 快平滑跟手**（自动响度归一化仍慢速防抽吸）；**音量独立于场景预设/组合**——`applyScene` 保留 loudnessNormalization 状态。
  - **宿主与接线**：`attachV3Engine.ts` 管理 `EngineV3Host` 单例（mode 'auto'：worklet 优先、失败回退 script；`masterGain` 全断重连防双链并联），参数快照持久化 `hyperplayer:v3-params`（卷积 IR 数组不入库），UI 桥在 worklet 模式参数双下发 + 统计回传，系统音量 → 等响度补偿，听力测试纯音（`v3HearingPlay` 事件），音频图 `masterGain → [SoundTouch 变速变调] → v3 节点 → analyser`。**导出 MP3**（`exportV3Mp3`，解码 PCM → `EngineV3.process` 分块 → lamejs 128kbps 下载；lamejs 需 `ensureLameEncoder()` 的全局挂载补丁）。
  - **开发者模式（内置场景微调）**：关于页开关（`hyperplayer:hse-dev-mode`）→ 音效场景页出现编辑入口，可实时试听修改内置 11 场景并保存为**参数覆盖层**（`ui/sceneStore.ts`，localStorage `hyperplayer:v3-scene-overrides`；入库快照剥离音量通道 + IR）；支持单场景还原出厂、场景库 JSON 导出/导入；桥接口对应 `updateBuiltinScene` / `resetBuiltinScene` / `exportSceneLibrary` / `importSceneLibrary`。**发布种子**：`src/services/HyperSoundEngine-v1/src/engine/builtinSceneSeed.ts`（随包分发的官方默认层）——场景页「写回发布种子」在开发模式经 IPC `hse-write-scene-seed`（preload `writeHseSceneSeed`，main.cjs 限 `!app.isPackaged`）直写该文件后 commit/push 即全员生效；revision 每次 +1，本机 rev 低于种子时个人旧微调自动让位官方新值。
  - Worklet 处理器经 `npm run build:v3-worklet`（`scripts/build-v3-worklet.mjs`，esbuild 单文件）打入 `public/v3-worklet.js`。改引擎算法前先跑 `npx vitest run src/services/HyperSoundEngine-v1`。
- **引擎适配层**：`src/services/audioEngineVersion.ts`（localStorage `hyperplayer:audio-engine-version`，默认 **v3**）。统一适配层 `src/services/audio-engine/`（`types.ts` 接口 + `V3Adapter.tsx` + `engines/v3.ts` 清单 + `index.ts` 注册表 + 工厂 `getEngineAdapter`）：App.tsx 持有 `engineAdapterRef`，引擎操作收敛为 `engineAdapterRef.current.xxx()` 单一调用（attach/dispose/setSystemVolume/applyLoudnessNormalization/exportMp3/renderStudio），按 `adapter.capabilities` 判断能力而非写版本分支。**注册表目前只有 v3 一项，调音室的引擎切换 UI 已随 v1/v2 删除**（切换机制仍在，但单引擎下不显示按钮）。`V3Adapter` 为 `studioMode: 'custom'`（`renderStudio` 返回 HSE 调音室 `V3MixingStudio.tsx`）。**接入新引擎**：写 `XxxAdapter.ts` 实现 `IAudioEngineAdapter` + 加 `engines/xxx.ts` 清单 + 在 `index.ts` 注册表加一行，App.tsx 零改动（`types.ts` 中 generic 模式对应的 `GenericMixingStudio` 当前并不存在，属未来占位）。
- **空间音频（HSE 第 15 级，纯 TS 引擎内联）**：`src/spatial/` 为纯模块（无浏览器/工作线程依赖），由 `EngineV3` 内联调用——**不是**独立 AudioWorklet 节点，也无 WASM/Rust 后端。后端为 `TsConvolverBackend`（复用 `dsp/Convolver.ts` 分区 FFT 卷积；另有时域直接卷积 `TimeConvolver.ts`，两种模式干湿对齐一致）。能力：合成解析 HRTF（`analyticHrtf.ts`）+ 双插值模式（最近邻网格 / 实球谐 L=3 最小二乘拟合，`hrtfInterp.ts`）；房间模拟（镜像声源法早期反射 + FDN 8 条质数延迟线晚期混响，7 种预设 studio/hall/stage/church/outdoor/bathroom/corridor）；Ambisonics 环境上混（`ambisonics.ts`）；多声道输入映射与输出模式（binaural / stereo / multichannel，`processMulti`）；多普勒 + 遮挡/衍射简化模型（增益衰减 + 高频低通）。UI 模式：一键空间化 / 头锁定环绕（5.1 / 5.1.4 / 7.1 / 7.1.4 / 自定义，环形编辑上限 16 只扬声器）/ 世界漫游 / 舞台影院（4 场景预设 + 座位）。空间参数是 `V3EngineParams.spatial` 的一部分，随 `hyperplayer:v3-params` 快照持久化。
- `src/tv/` — **TV 形态已剥离**：只剩 `tvCore.ts`（桌面空壳，全部具名导出保留、函数体空实现，`isTvMode()` 恒 false）与 `perfMode.ts`（性能模式固定普通档）。勿再往这里加 TV 专属逻辑。
- `desktop/` — Electron main process, **CommonJS**（`main.cjs`, `preload.cjs`, `desktop-lyrics-preload.cjs`, `desktop-player-preload.cjs`, `taskbar-widget-preload.cjs`, `config-manager.cjs`, `window-state.cjs`, `user-data-profile.cjs`, `trusted-ipc.cjs`, `update-manager.cjs`, `update-applier.cjs`, `vmp-status.cjs`, `audio-download.cjs`, `apple-url-policy.cjs`, `chroma-*.cjs`, `signalrgb-*.cjs`, `razer-device-discovery.cjs`, `taskbar-widget-polling.cjs`, `splash.html`, `taskbar-widget.html`）。Not covered by `tsc --noEmit`。
- `src/desktop-lyrics/` + `src/desktop-player/` — standalone renderer entries for `desktop-lyrics.html` / `desktop-player.html`。
- `local-server.mjs` — single-file Express backend（~11k 行, port 3001）。Extra route modules in `server/` are registered here（`hazard-api` / `location-api` / `bilibili-api` / `apple-artwork-api` / `netease-native-explore`；工具模块 `byte-lru-cache` / `comment-api-utils` / `local-api-health` / `local-service-auth` / `qrc-decoder`）。QQ cookie state must flow through the single `qqMusicCookie` source of truth. **cookie 单事实源规则**：全局 `qqMusicCookie` 只在显式登录/设置接口（`/api/qq/cookie`、`/api/qq/user/setCookie`）更新；播放/读取路由一律用 `resolveRequestCookie(cookie)`（请求 cookie 仅本次使用，绝不回写全局），写操作按请求级 cookie 传递——并发播放/写操作不得互相冲掉登录态。
- `python-apple-bridge/apple_bridge.py` — Apple Music 播放面 bridge（端口 **18790**；由 `main.cjs` 用系统 Python（需 pywebview）spawn，`asarUnpack` 保证脚本可执行；前端 `src/services/appleWebViewBridge.ts` 同端口）。**无嵌入式 Python 运行时**。
- `src/components/Apple*` — **Apple 歌词/探索分支**：`AppleCoverFx.tsx`（Apple 逐字歌词特效）、`AppleExplorePanel.tsx`、`AppleLoginPanel.tsx`、`AppleSearchBrowse.tsx`、`AppleRadioNowPlayingPage.tsx`、`AppleVideoModal.tsx`；配套服务 `src/services/apple*`（auth/catalog/music/playback/hlsPlayer/webViewBridge/dynamicCover 等）、`src/hooks/useAppleDynamicCover.ts`、`src/utils/ttmlParser.ts`。与桌面歌词模式严格隔离，改桌面端勿破坏。
- `build/` 打包资源 — 不止 icon：**自定义 NSIS 安装器 UI 资产**（`installer.nsh` + `installerHeader/Sidebar.bmp` 等主题图 + `ui/`、`ui-clone/` 中文按钮/页面 bmp），由 `scripts/generate-installer-art.mjs` / `generate-installer-ui.mjs` / `generate-installer-clone.mjs` 生成；预览用 `node scripts/preview-setup.mjs`（独立 NSI 在 `scripts/setup-preview/preview.nsi`）。改安装器视觉先跑生成脚本再构建。
- `desktop/main.cjs` 含 **QQ音乐 QMK API Key 领取窗口**（`QMK_OFFICIAL_KEY_URL` y.qq.com；独立 session partition `hyperplayer-qq-skill-key`，每次打开前清空避免复用登录态）——编辑时保留隔离分区与导航守卫逻辑。
- `scripts/` — dev 启动器（`dev-electron.mjs`、`start-api.mjs`、debug/hidden VBS）、`build-v3-worklet.mjs`（HSE worklet 打包）、`build-apple-weather-scenes.mjs`、安装器美术/预览脚本、`bump-version.mjs`、`assert-release-not-running.cjs`、EVS/VMP 脚本（`evs-vmp.cjs` / `evs-runner.cjs` / `ensure-dev-vmp.cjs` / `write-vmp-status.cjs`）、`test-chroma*.cjs` / `test-signalrgb*.cjs` / `test-razer-device-discovery.cjs`、`bilibili-mv-benchmark*.mjs`、`split-city-data.mjs`、Apple 诊断脚本（`diagnose-apple-api.cjs` / `probe-apple-*.cjs` / `probe-widevine-electron.cjs`）。
- **Git repo** (has history — use `git log`/`git blame`; rollback via `git reset`). `data/`, `cache/`, `logs/`, `dist/`, `release/` are ignored runtime artifacts。

## Conventions

- **Relative imports everywhere** — `@/` alias is configured but unused; match the `./`/`../` style.
- **No ESLint** — `npm run lint` is typecheck only. Strict TS in `src/`.
- **Use `debugLog()` (src/utils/debugLog.ts) instead of `console.log` in hot paths** — gated behind `localStorage['hyperplayer:verbose-log']` to avoid console memory growth.
- **Files must be UTF-8** — Windows encoding issues previously broke Chinese UI text（曾出现 GBK 误读乱码，含正则字符类损坏）。
- **性能基线（已完成的优化，勿回退）**：三视图/弹窗/列表行组件 memo + latest-ref 稳定回调（`viewCallbacks`/`stableDialogCallbacks`）；过渡进度 30fps 节流；评论/艺人列表 react-window 虚拟化；封面代理流式转发；`/api/cover`、`/api/proxy-image` 经 `streamProxyImage()` 流式（不整读进内存）；后端 gzip（compression 中间件，filter 排除 image/video/audio）；axios keepAlive；vite `manualChunks` 拆 vendor（react / framer-motion / leaflet）。
- Ports: **3000** Vite / **3001** backend (127.0.0.1, CORS allows only localhost:3000, file://, null origins) / **18790** Apple Music Python bridge。

## Backend security invariants (do not break when editing)

- **Electron 主进程**：所有窗口（主窗口/桌面播放器/歌词窗/任务栏小窗）都挂 `guardAgainstExternalNavigation()`（will-navigate 拦截外部跳转）；QQ QMK 领取窗口是唯一被允许打开 `y.qq.com` 的窗口——不要为其他窗口放宽守卫。
- `/api/cover` and `/api/proxy-image` have an SSRF guard blocking private/loopback/link-local IPs and DNS names resolving to them. **The internal proxy chain `proxy-image → cover` is legitimate**: guard must keep allowing `localhost:3001` (the app's own origin) — inner `/api/cover` still validates the final CDN target, so blocking localhost:3001 would break comment/playlist avatars.
- `/api/wallpaper-engine/preview` & `/media` enforce path containment under the WE base dir (resolve + startsWith(base+sep)).
- **Netease xeapi**: `initNeteaseAPI()` in local-server.mjs calls the lib's `generateConfig()` at startup to register an anonymous token and fetch the xeapi public key (cached in `os.tmpdir()/xeapi_public_key`). If `/api/netease/song/url` starts returning `xeapi public key is missing`, the tmp cache was cleared — restart the server.
- **QQ 播放/写操作 cookie**：播放类路由（song/url、mv/url、mv/detail、comment、user/detail 等）用 `resolveRequestCookie(cookie)` 只读不写全局；写操作（like、playlist/tracks、subscribe、artist/subscribe）一律传请求级 cookie 并 `cookie || qqMusicCookie` 回退。改 cookie 逻辑时保持此单事实源约束。
- **本地服务鉴权**：`server/local-service-auth.mjs` 的 `LOCAL_SERVICE_HEADER`（`x-hyperplayer-local-token`）+ `isAuthorizedLocalRequest()` 对配置了 token 的本地服务做 constant-time 校验——新增内部接口时沿用同一约定。

## Read before touching

- `README.md` — feature map（音源 / 无缝衔接 / 歌词模式 / 音效 HSE / 空间音频 / 桌面模式）。
- `HANDOVER.md` — 交接文档（⚠️ 内容早于减配，涉及已删功能/端口的段落已失效，以本文件与源码为准）。
- `CONTEXT.md` — 音效域词汇表（效果/场景方案/自定义状态/频响补偿等术语定义；引擎相关词条已按 HSE 单引擎现状更新）。
- `PRIVATE-LICENSE.md` — 私有模块许可（⚠️ 适用范围表仍列出已删模块，以实际存在文件为准）。
- `DEBUG_PAGES.md` — 独立调试页注册表（新增独立调试页前必读）。
- `docs/adr/` — 架构决策记录（历史决策，部分针对已移除的 v1/v2 引擎）。
- `docs/plugin-development.md` — 插件开发文档（插件宿主与导入规范仍适用；文内 DG_LAB 示例对应的内置插件已移除）。
- `docs/歌词对比-LyricsBlossom.md` — Apple Music 歌词逆向对比分析（Apple 逐字模式参考）。
- `src/services/HyperSoundEngine-v1/docs/` — HSE 融合/UI/算法文档（`FUSION_GUIDE.md` / `UI_GUIDE.md` / `音频算法技术文档.md` / `音频算法设计文档.md` / `FEATURES_VERIFICATION.md`）；`架构书.md` 位于模块根目录。
- `docs/功能清单3.0.md` — 功能清单（12 个功能域 A–L，按代码实测，含统计、红线文件、已知限制、文档索引；与源码冲突时以源码为准）。
