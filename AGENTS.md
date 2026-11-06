# AGENTS.md — HyperPlayer

Desktop music player (Windows/Electron)，共 **3 个音源**：网易云 / QQ 两个音乐平台（`src/services/platforms.ts` 的 `MusicPlatform`，现为 `'netease' | 'qq'`）+ **B站看歌**（`BilibiliMvPlayer` / 歌词模式 `video`）。Frontend React 19 + TypeScript + Tailwind CSS 4 + Vite 6, backend Node/Express（`local-server.mjs`，端口 3211）；**前后端均无 Python 依赖**。UI 文案与代码注释以**中文**为主，新用户可见文案保持一致。**Apple Music / Spotify 音源已移除**，但 **Apple 风格歌词特性全部保留**（`src/services/appleLyricsStyle.ts`、`AppleCoverFx.tsx`、`QuickSettings` 的「逐词点亮」与「崭新」、`docs/歌词对比-LyricsBlossom.md`）——**勿当作音源残留删除**。

**本仓库为减配版（slimdown）**：已移除 Android TV、Python 节拍/响度/补偿服务（3002/3003/3004）、汽水与酷狗音源、Apple Music / Spotify 及其 Python bridge（18790）与 Widevine/VMP DRM 链、音效引擎 v1/v2（只剩 HSE v3）、Folia/多维 Diorama/摩登/光荣/壁纸歌词等模式（收敛为 4 种）、DG_LAB 插件、AirPlay / 分轨 Stem / 远程遥控 / 设备授权 / 代理管理 / 爱发电同步 / Smart AutoMix（只保留 Fixed Crossfade + gapless + 专辑无缝）。**旧文档中描述这些功能的段落一律失效，勿据此恢复。**

- ⚠️ **例外：播放页「封面模糊铺底 + 背景律动」已按用户要求恢复**（2026-09-13）。它是播放页的常驻兜底背景：`src/components/CrossfadeBackground.tsx` + `App.tsx` 的 `PulsingCrossfadeBackground` + `QuickSettings.tsx` 的「背景律动」开关与三档强度。**勿再当作减配残留删除。**

## 本机环境（先读这一条）

**shell 固定用 `powershell.exe`**：本会话默认的 bash 会落到 WSL，`$LASTEXITCODE` / `Select-Object` / `-ErrorAction` 之类会被拆解成语法错误，白烧一轮 tool call。所有 `exec_command` 都带 `shell: powershell.exe`。

- 不要假设有 `rg`（本机没有）：用 `Select-String` / `Get-ChildItem -Recurse -Include`。
- `git status` 显示整仓 `M` 但 `git diff` 为空时，先 `git update-index --refresh`。
- 启动后端/服务用 `Start-Process -WindowStyle Hidden`，不要弹可见窗口。
- **GitHub 需要代理**：`github.com` 的 DNS 会落到被墙 IP（如 `20.205.243.166`），`git push` 报 `Recv failure: Connection was reset` / `port 443 连不上`。系统代理通常是 `127.0.0.1:7890`，但 git 不读系统设置，需显式给：`$env:HTTPS_PROXY='http://127.0.0.1:7890'`（或 `git -c http.proxy=http://127.0.0.1:7890 push`）。SSH 走 `ssh.github.com:443` 可连，但本机 key 未注册到 GitHub，只能用 HTTPS。

## Commands

```bash
npm run dev:electron     # Full dev: Vite (3210) + API server (3211) + Electron window
npm run dev              # Vite dev server only (3210; Weather Lab: http://127.0.0.1:3210/weather-debug.html)
npm run lint             # Typecheck: tsc --noEmit (src/ only; no ESLint)
npm run test             # vitest（test/ + HSE；maxWorkers=2 防 HSE 时序测试偶发超时）
npm run test:wiring      # App 播放接线契约（modeIntegrationWiring + exploreModeWiring，秒级）
npm run test:equivalence # 迁移等价性：旧实现字面复刻 vs 新 module（秒级）
npm run test:desktop     # node --test 桌面/安全用例（hse / ipc / volume / download / health / trusted-ipc / update / profile）
npm run check:ports      # 端口一致性闸门（必须 3210/3211，已接入 CI）
npm run check:packaging  # 打包体积 / 依赖分区闸门（已接入 CI 与构建链）
npm run verify:hse-worklet # Worklet realm 装载 + 空间/多声道/IR/扩展节点冒烟
npm run build:hse-worklet  # 重生成 public/hse-worklet.js（predev/prebuild 自动执行）
npm run build            # vite build -> dist/（三入口）
npm run build:electron:dir # build + electron-builder --win dir + verify-asar -> release/win-unpacked
npm run build:electron   # 发布：build:electron:dir + 安装器美术 + NSIS -> release/HyperPlayer-<version>-Setup.exe
npm run build:apple-weather # 重新生成 Apple 天气场景资源（纯天气视觉）
npm run build:splash     # 重新生成启动页（desktop/splash.html + splash-baked.webm）
npm run test:chroma      # Razer Chroma 插件自测
npm run test:signalrgb   # SignalRGB 插件自测
npm run test:installer   # 安装器 UI 资产 + 测试
npm run gen:installer-art # 生成 NSIS 安装器美术资产
npm run preview:setup    # 预览自定义安装器
npm run benchmark:mv     # B站 MV 基准脚本
npm run version:patch|minor|major|pre  # 版本号更迭（自动 commit/tag/push）
npm run version:dry      # 预览版本更迭（不落地）
npm run start            # electron .（直接起已构建产物）
```

注意：`prebuild` / `predev` / `predev:electron` 只做一件事——运行 `build:hse-worklet`。

**本地构建约定**：本地默认只跑 `npm run build:electron:dir`，便携版就是 `release/win-unpacked/`（双击 `HyperPlayer.exe`），**不打包 zip、不构建 NSIS**。只有用户明确说要安装包时才跑 `npm run build:electron`。electron-builder 被中断会把 `release/win-unpacked/` 留成空目录，需重跑。CI 只发 NSIS。

**端口**：只有 **3210**（Vite）与 **3211**（Express，仅 127.0.0.1）。**不要改回 3000/3001/3002**（本机 WaveForge / ReWaveForge 常驻占用）。端口分散在 `vite.config.ts` / `package.json` / `local-server.mjs` / `desktop/main.cjs` / `scripts/dev-electron*.mjs` / `src/services/apiConfig.ts`；`node scripts/check-ports.mjs` 是闸门。

## Independent debug pages

Before creating or using a standalone debug webpage, read [`DEBUG_PAGES.md`](./DEBUG_PAGES.md). It registers developer-only visual tools, launch command, local URL, data/network constraints, and production-build status. `weather-debug.html` 与 `mv-decode-test.html` 已在册；`vite.config.ts` 的 `rollupOptions.input` 只允许三个生产入口。

## Packaging rules

`build.files` 白名单 = `desktop/**/*`、`dist/**/*`、`server/**/*`、`shared/**/*`、`local-server.mjs`、`package.json`、`logo.png`、`build/**/*`，外加四条**体积排除规则**（勿删）：`!build/ui/**`、`!build/ui-clone/**`（NSIS 位图，仅安装器编译期读取）、`!**/*.map`（sourcemap，曾占 120 MB）、`!node_modules/@neteasecloudmusicapienhanced/api/public/**`（库自带文档页，约 13 MB）。**已无 `asarUnpack`**。

**依赖分区**：electron-builder 只打包 `dependencies`。纯前端库（react / three / pixi / hls / framer-motion / leaflet 等）必须放 `devDependencies`（Vite 已打进 `dist/`），否则 asar 会重复存两份（曾膨胀到 411 MB）。`dependencies` 只放运行期真正 require 的 10 项：`@jixun/qmweb-sign`、`@neteasecloudmusicapienhanced/api`、`adm-zip`、`axios`、`compression`、`dotenv`、`express`、`qq-music-api`、`qrcode`、`ws`。**判定不能只看入口 import**：netease 动态加载 `qrcode` / `dotenv`，`axios` 由 `local-server.mjs` 直接 import，`ws` 由 `scripts/lib/head-tracking-osc.cjs` 使用。闸门 `npm run check:packaging` 会扫运行期闭包并核对 asar（预算 130 MB）。

**构建运行期间不要编辑任何会被打包的文件**——electron-builder 先按 stat 尺寸写头部、后拷贝内容，中途改文件会静默产出 **Node 能读、Electron 拒载**的坏包。`scripts/verify-asar.cjs` 与 `check-packaging` 已接入 `build:electron:dir` 前后。

**打包三大约束（破坏任一条会黑屏/缺资源）**：

1. `vite.config.ts` 的 **`base` 必须保持 `'./'`**（顶层配置）。打包版用 `loadFile()` 加载 `dist/index.html`；`base: '/'` 会让资源全部 404 → 整窗黑屏。`Renderer resources: 0` 不是可靠判据（`did-finish-load` 时条目常未填充）。
2. `build.files` 必须包含 **`logo.png` 与 `build/**/*`**——窗口 icon 用 `../build/icon.ico`，`logo.png` 仍被主进程 `nativeImage` 使用。
3. `build.electronDist` 保持 `node_modules/electron/dist`。当前为官方 stock `electron@44.5.0`（Chromium 152 / V8 15.2 / Node 24.18.1）。升级时用 `npm install --save-dev electron@<版本>` + `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 手动下载，并同步 `vite.config.ts` 的 `build.target`。源码级魔改 = 替换整个 `node_modules/electron/dist`，打包配置无需改。

详细白名单说明、依赖分区拦截表、体积基线：见 [`docs/architecture/packaging-and-release.md`](./docs/architecture/packaging-and-release.md)。

## Release & updates

- 发布一律 **Pre-release**；stable 资产 = NSIS 安装包 + `hyperplayer-hot-<version>.zip`，nightly 只发 NSIS。
- 更新清单唯一实现 `scripts/lib/update-manifest.mjs`；清单文件名唯一事实源 `shared/update-manifest-files.json`；**不要在 workflow 里内嵌 Node heredoc**。
- 版本号唯一来源是 `package.json`；版本标识唯一来源是 `src/services/versionInfo.ts`；bump 走 `npm run version:*`（会同时改 lock 两处）。
- 详细发布/更新/版本规则：见 [`docs/architecture/packaging-and-release.md`](./docs/architecture/packaging-and-release.md)。

## ⚠️ 设置镜像机制（往设置里加功能前必读）

HyperPlayer 共 **4 个界面模式**（简约 minimal / 传统 traditional / 探索 explore / 桌面 desktop）。**简约模式的 `src/components/SettingsPanel.tsx` 是整软件的「总设置」**，其中的全局功能性设置通过设置注册表自动镜像到其他模式：

- `src/services/globalSettingsRegistry.ts` 是声明式注册表。每条 `read/write` 与 SettingsPanel **同 localStorage 键、同自定义事件**；`components/MirroredGlobalSettings.tsx` 按各模式设计语言渲染。
- **在简约设置里新增全局功能开关时**，除了写 SettingsPanel 的 UI，**必须同步在 `globalSettingsRegistry.ts` 登记一条**，否则传统/探索/桌面模式永远看不到。自定义控件（如 `FontPicker.tsx`）在 `MirroredGlobalSettings.tsx` 为新 `control.kind` 加渲染分支。
- 简约模式专属的自定义/外观设置（只影响简约模式自身）不需要登记。
- 桌面集成类设置用 `available: hasXxxBridge` 门控（非 Electron 环境无桥时自动隐藏）。
- 桌面歌词是独立透明窗口（`desktop-lyrics.html` + `desktop/main.cjs` IPC 持久化），设置经 `window.electron.desktopLyrics.updateSettings` 下发，**纯 Web 页面测不了**，需 `npm run dev:electron` 实测。

## Layout & boundaries

- `src/` — React frontend：`components/`（App.tsx lazy-loads nearly everything）、`services/`（API / cache / gapless / Apple 歌词工具）、`audio/`（`PlaybackQueue.ts` / `transitionPlanner.ts` / `TransitionRenderer.ts` / `playbackTimeStore.ts`）、`hooks/`、`api/`、`utils/`、`features/`、`vendor/pv`。
- `src/services/gapless/` — 无缝衔接独立模块（`gaplessConstants.ts` / `seamlessJoinController.ts` / `gaplessTransition.ts`）。`useAudioPlayer.ts` 只保留调用接口与事件接线；改无缝逻辑优先改此处。目录含 `LICENSE.private`。
- **设置 / 账号 / 插件 / IPC 深模块**：过渡设置只走 `transitionSettings.ts` + `useTransitionSettings`；歌词模式只走 `lyricModeSettings.ts` + `useLyricModeSettings`；登录退出走 `accountSession.ts`；插件启停走 `pluginActivation.ts`；所有 `ipcMain.handle` 走 `desktop/ipc-registry.cjs`。**不要在组件里裸读 localStorage、手写同义事件或绕过 registry。** 细节与回归测试见 [`docs/architecture/modules.md`](./docs/architecture/modules.md)。
- **过渡计划层已收敛**：`transitionPlanner.ts` 只产出 `fixed-crossfade`；节拍分析仍保留给 MV 对齐 / PV 歌词，但不再用于智能混音。切歌提示见 `GaplessModeToast.tsx`。
- **音效引擎 = HSE（HyperSoundEngine）——当前唯一引擎**：模块在 `src/services/HyperSoundEngine-v1/`，许可证为 **CC BY-NC-ND 4.0** + 项目专项授权；**勿删改模块内 LICENSE / 授权补充说明 / THIRD_PARTY_NOTICES / 版权声明**。命名统一为 HSE（勿新建 V3 标识符）。细节、DSP 链、空间音频、导出、构建验证见 [`docs/architecture/hse.md`](./docs/architecture/hse.md)。
- `desktop/` — Electron main process（CommonJS，不被 `tsc` 覆盖）。启动页 `splash.html` / `splash-baked.webm` 是 `npm run build:splash` 生成物，勿手改；时序契约、舞台几何、窗口居中、安装器美术、QQ QMK 窗口见 [`docs/architecture/desktop-and-startup.md`](./docs/architecture/desktop-and-startup.md)。
- `src/desktop-lyrics/` + `src/desktop-player/` — `desktop-lyrics.html` / `desktop-player.html` 的独立 renderer。
- `src/tv/perfMode.ts` — **保留且是活代码**（性能模式 + 缓存上限，被设置面板消费），**勿当 TV 残留删除**；TV 其余逻辑已彻底清除，见 [`docs/architecture/desktop-and-startup.md`](./docs/architecture/desktop-and-startup.md)。
- `local-server.mjs` — 单文件 Express 后端（~11k 行, 3211）。`server/` 里有 `hazard-api` / `location-api` / `bilibili-api` / `netease-native-explore` 等路由模块。**QQ cookie 单事实源**与安全约束见 [`docs/architecture/backend-security.md`](./docs/architecture/backend-security.md)。
- **Apple 风格歌词能力（音源移除后刻意保留）**：`appleLyricsStyle.ts`（TTML 对唱着色）、`utils/ttmlParser.ts`、`AppleCoverFx.tsx`（当前未接线）。逐字歌词数据源 = 平台官方 + AMLL TTML DB；播放页「现代」的 clear/soft/apple 逐词点亮与「崭新」弹簧滚动也属保留范围。**勿当 Apple 音源残留删除。**
- `build/` — 打包资源（icon + NSIS 安装器 UI 资产）；`scripts/` — dev 启动器、HSE worklet 打包、安装器美术、版本号、asar 校验、热更包、灯效测试、MV 基准、启动页重定时。脚本清单见桌面文档。
- **Git repo**（有历史，用 `git log` / `git blame`；回滚用 `git reset`）。`data/`、`cache/`、`logs/`、`dist/`、`release/` 是忽略的运行期产物。

## Conventions

- **Relative imports everywhere** — `@/` alias 已配置但未使用；保持 `./` / `../` 风格。
- **No ESLint** — `npm run lint` 只是 `tsc --noEmit`；`src/` 是严格 TS。
- 热路径用 `debugLog()`（`src/utils/debugLog.ts`）而不是 `console.log`；它由 `localStorage['hyperplayer:verbose-log']` 门控。
- **Files must be UTF-8** — Windows 编码问题曾破坏中文 UI 文案（GBK 误读、正则字符类损坏）。
- **提交前闸门（`.githooks/pre-commit`，由 `npm run prepare` 装 `core.hooksPath`）**：只跑 `lint` + `test:wiring` + `test:equivalence`（约 22 秒）。全量 `npm run test` 留给 CI 与 push 前。**迁移类改动必须先补 `test/migrationEquivalence.test.ts`**：把旧实现字面复刻成 `legacy*`，与新 module 在同一组 case 上对比——本轮双审抓到的回归几乎全属这一类。

- **性能基线（已完成，勿回退）**：三视图/弹窗/列表行 memo + latest-ref 稳定回调；过渡进度 30fps 节流；评论/艺人列表 react-window 虚拟化；封面代理流式转发；后端 gzip；axios keepAlive；vite `manualChunks` 拆 vendor。
- Ports: **3210** Vite / **3211** backend（127.0.0.1；CORS 仅 localhost:3210 / file:// / null origins）。

## Backend security invariants

- 所有窗口挂 `guardAgainstExternalNavigation()`；只有 QQ QMK 领取窗口允许打开 `y.qq.com`。
- `/api/cover` 与 `/api/proxy-image` 有 SSRF 守卫（阻断私有/回环/链路本地地址），但**内部 `proxy-image → cover` 链必须放行 `localhost:3211`**；内层 `/api/cover` 仍会校验最终 CDN。
- `/api/wallpaper-engine/preview` 与 `/media` 强制路径 containment（resolve + `startsWith(base+sep)`）。
- **QQ cookie 单事实源**：全局 `qqMusicCookie` 只在显式登录/设置接口更新；播放/读取用 `resolveRequestCookie(cookie)`，写操作传请求级 cookie。并发操作不得互冲登录态。
- **本地服务鉴权**：`server/local-service-auth.mjs` 的 `x-hyperplayer-local-token` + `isAuthorizedLocalRequest()`（constant-time）；新增内部接口沿用。
- Netease xeapi 的 public key 缓存于 `os.tmpdir()/xeapi_public_key`；`/api/netease/song/url` 报 `xeapi public key is missing` 时重启服务。

细节见 [`docs/architecture/backend-security.md`](./docs/architecture/backend-security.md)。

## 配置隔离不变量（勿与 WaveForge / 其他 Electron 应用共用）

- **userData 独占**：`desktop/user-data-profile.cjs` 的 `selectHyperPlayerUserData()` 是唯一入口——打包版与开发版都固定用 `%APPDATA%/HyperPlayer`（开发版仅认显式 `HYPERPLAYER_USER_DATA` 绝对路径）。**禁止**回退到公共 `%APPDATA%/Electron`。
- **产品身份**：`build.appId = com.hyperplayer.desktop`、`app.setName('HyperPlayer')`、IndexedDB `HyperPlayerCache`、token 环境变量 `HYPERPLAYER_LOCAL_TOKEN`；改名时不要复用旧值。
- **localStorage 键**：新增 HyperPlayer 键一律 `hyperplayer:` 前缀；平台登录态用 `netease*` / `qq*`（B站有效期沿用 `wf_login_expiry_bilibili`）。**不要新增 `waveforge:` 键**。历史裸键（`coverPulseEnabled` / `coverPulseMode` / `playerTheme` / `backgroundEffect` / `appleDuetColors`）**勿改名**——会丢用户设置。
- **Chroma 清理**：`desktop/chroma-app-list-repair.cjs` 的 `STALE_APPS` 故意列 `WaveForge*` 旧注册名（清理升级残留），但 `HyperPlayer` 不能在该清单内。
- 遗留的 `%APPDATA%/Electron` / `%APPDATA%/WaveForge 澜音工坊` 目录不主动删除，代码只做「不再读取」。

## Read before touching

- [`docs/architecture/README.md`](./docs/architecture/README.md) — 架构细节索引（模块 / HSE / 桌面启动 / 打包发布 / 后端安全 / 候选 backlog）。
- [`docs/architecture/backlog.md`](./docs/architecture/backlog.md) — 架构候选编号与状态；`/implement 0X` 前先核对，编号不存在时停下来问。
- `README.md` — feature map（音源 / 无缝衔接 / 歌词模式 / HSE / 空间音频 / 桌面模式）。
- `HANDOVER.md` — 交接文档（⚠️ 早于减配，涉及已删功能/端口的段落失效，以 AGENTS、架构文档与源码为准）。
- `GLOSSARY.md` — 音效域词汇表（效果 / 场景方案 / 自定义状态 / 频响补偿等）。
- `PRIVATE-LICENSE.md` — 私有模块许可（适用范围表已按现状核对；「AutoMix」是历史模块名，相关文件仍在但用途已收敛为节拍分析 / 过渡编排）。
- `DEBUG_PAGES.md` — 独立调试页注册表（新增前必读）。
- `docs/adr/` — 架构决策记录（部分针对已移除的 v1/v2 引擎）。
- `docs/plugin-development.md` — 插件开发文档（DG_LAB 示例对应的内置插件已移除）。
- `docs/歌词对比-LyricsBlossom.md` — Apple Music 歌词逆向对比（逐字动画设计参考）。
- `src/services/HyperSoundEngine-v1/docs/` — HSE 融合/UI/算法文档；`架构书.md` 位于模块根。
- `docs/hse/HSE-1.5-快照接入记录.md` — HSE 1.5 接入记录（动 HSE 或其接线前先读）。
- `docs/功能清单3.0.md` — 功能清单（12 个功能域，按代码实测；与源码冲突时以源码为准）。
- `docs/性能优化计划.md` — 性能优化计划（已达标 / 可优化 / 不采纳 + 性能红线；做性能改动前先读）。
- `docs/性能优化计划2.0.md` — Electron 44 升级 + 启动优化合并报告（内核版本以文首勘误块为准）。

## Agent skills

### Issue tracker

GitHub Issues in `SoundFieldLab/HyperPlayer`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five canonical triage roles with their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

