# HyperPlayer 交接文档

> 给接手本项目的开发者或 AI 代理的交接说明。包含：项目当前状态、环境、端口、已知问题、性能优化、未决事项、历史决策摘要、常用操作速查。
> 面向"接下来要干活的人"，读完本文档 + `AGENTS.md` 即可上手。
>
> ⚠️ 本文档描述的是**减配版（slimdown 分支）**。历史上大量功能已移除，凡本文档未提及者即视为不存在——**不要**依据旧版本文档或 `git log` 里的旧提交去恢复功能。
> 📌 已按 **2026-09-13** 代码校正主要失效点（测试计数、律动背景、引擎切换胶囊、未决清单、netease 初始化位置等），剩余历史决策段落保留。
> 📌 **2026-09-13 又一批移除**：**Apple Music 与 Spotify 音源**（登录 / 目录 / 播放面 Python bridge（端口 18790）/ Apple 探索·电台·视频组件 / Spotify OAuth 窗）、**Widevine/VMP DRM 播放链**（castLabs EVS 脚本与状态卡、`desktop/vmp-status.cjs`、`apple-url-policy.cjs`、`build:electron:dir:unsigned` / `vmp:*` 脚本），Electron 已从 castLabs 分叉**回退为官方 stock `42.8.0`**。**Apple 风格歌词特性（逐词点亮 / 崭新弹簧滚动 / 对唱着色 / TTML）刻意保留**，勿当作音源残留删除。当前音源为 **3 个**：网易云 / QQ（`MusicPlatform` 只有这两个成员）+ B站看歌；端口只剩 3210 / 3211。
> 📌 文中出现的文件行号**随提交漂移**，定位代码时**优先按符号名 grep**（如 `grep -n "MediaPlayPause" desktop/main.cjs`），行号仅作粗略参考。

---

## 1. 项目状态（2026-09-13）

- **阶段**：减配（slimdown）已完成，处于维护/优化阶段；2026-09-13 又完成一批**音源与 DRM 收敛**（见 §2）。核心功能（三音源搜索/播放/歌词/无缝衔接/桌面模式/音效 HSE/空间音频）均已实现。
- **代码基线**：分支 `main`；`package.json` 版本 **1.0.0**（自 1.0.0 起重新编号，0.x 记录已废弃）。
- **稳定性（`npm run test` 实测 2026-09-13）**：**120 文件 = 119 过 + 1 跳过；1173 用例 = 1168 过 + 5 跳过 + 0 失败**（口径：`test/` vitest 收集的 `.ts`/`.tsx` + HSE `test/` + HSE `ui/` + spatial `test/`；另有 `.cjs`/`.mjs` 归 `npm run test:desktop`（7 文件 26 用例）与 `test:installer`（16 用例））。跳过的 5 项是 HSE 模块 LGPL 可选依赖未装（属设计行为）。Apple/Spotify 音源与 Widevine/VMP 链的测试已随功能整体删除。`test/chromaStyles.test.ts` 的 `keeps decay timing approximately frame-rate independent` 在满载并发时会 5s 超时，单独运行通过——属**已有偶发抖动**，不是减配引入的回归。
- **代码规模**：`src/` 约 540 个 `.ts`/`.tsx`；后端 `local-server.mjs` 单文件 **约 11.2k 行**（端口 3211）。**已无任何 Python 代码与 Python 运行时**（Apple bridge 随音源移除）。

## 2. 减配说明（2026-09-10 首轮；2026-09-13 追加音源/DRM 收敛）

本版本按"只保留可用且可维护的能力面"原则做了一次大规模删减。**被移除的功能域**：

| 域 | 移除内容 |
|---|---|
| Python 音频链 | `python-beat-service/`（beat_analyzer / loudness_server / compensation_server / 离线 wheels）、`resources/python-embed/`、`resources/beat-this/`、`desktop/workers/`、根 `requirements.txt`、`install-python-deps.bat`、`start-full.bat`、`test-python-service.bat`、`scripts/bundle-python.mjs`、`scripts/verify-beat-this.cjs`。**端口 3002/3003/3004 全部停用。** |
| 音源收敛（2026-09-13） | **Apple Music 与 Spotify 音源整体移除**：`src/services/apple*.ts`（14 个）、`src/services/spotifyService.ts`、`src/components/Apple*.tsx`（探索/登录/搜索浏览/电台 Now Playing/音乐视频）、`SpotifyLoginPanel`、`src/hooks/useAppleDynamicCover.ts`、Apple 相关的全局设置项（登录态、动态封面、Apple 质量档、Apple 歌词源）；后端 `/api/apple/*` 路由 + `server/apple-artwork-api.mjs`；Electron 主进程的 Apple 登录窗/代理/bridge/IPC 与 `desktop/apple-url-policy.cjs`；Spotify OAuth 授权窗。`MusicPlatform` 收敛为 `'netease' \| 'qq'`，**当前 3 个音源**：网易云 / QQ + B站看歌。 |
| Python Apple bridge | `python-apple-bridge/apple_bridge.py`（端口 **18790**，系统 Python + pywebview + WebView2）、`desktop/main.cjs` 里的 bridge spawn 与探测、`asarUnpack` 解包规则。**18790 端口已不存在的代码路径**。 |
| Widevine / VMP DRM 链 | `scripts/evs-vmp.cjs` / `evs-runner.cjs` / `ensure-dev-vmp.cjs` / `write-vmp-status.cjs` / `probe-*.cjs`（含 `probe-widevine-electron.cjs`）、`desktop/vmp-status.cjs` 与设置页「VMP 状态」卡、`package.json` 的 `vmp:*` 与 `build:electron:dir:unsigned`、CI 的 EVS secrets 与「production streaming VMP ≥30 天」门槛、`dev-electron.mjs` 的 VMP 预检。**Electron 从 castLabs 分叉 `v42.8.0+wvcus` 回退为官方 stock `electron@42.8.0`**（无 Widevine）。 |
| 音效引擎 v1/v2 | `src/services/audioEffects/`（v1）、`src/services/audio-effects-v2/`（v2）、`MixingStudio.tsx`、`MixingStudioV2.tsx`、`V1Adapter`/`V2Adapter`、`engines/v1.ts`、`engines/v2.ts`、`loudnessNormalization.ts`、`compensationService.ts`。**现在只有 HSE（v3）一个引擎。** |
| 其它音源 | 汽水音乐（Qishui/Soda）、酷狗（Kugou）。**当前 3 个音源**：网易云 / QQ + B站看歌。 |
| Android TV | `android/`、`android-server.mjs`、`tv-extensions.mjs`、`dev-tv-server.mjs`、`vite.android.config.ts`、`scripts/build-android-assets.mjs`、`scripts/fetch-nodejs-mobile.mjs`、`scripts/publish-release.mjs`、旧 release workflow。`src/tv/` 仅剩 `tvCore.ts`（空壳，`isTvMode()` 恒 false）与 `perfMode.ts`（固定普通档）。 |
| DG_LAB 插件 | `DGLabPlugin.ts` / `DGLabClient.ts` / `DGLab*` 组件 / `server/dglab-relay.cjs` / `useSystemAudioCapture.ts`。插件宿主 + Chroma / SignalRGB 保留。 |
| 歌词模式 | Folia、多维 Diorama、摩登、光荣、壁纸歌词。**从 9 种收敛为 4 种**：modern（现代）/ immersive（沉浸式）/ video（B站看歌）/ pv（PV）。（**律动背景**即播放页封面模糊铺底 + 背景律动，已于 2026-09-13 恢复并在用，见 `CrossfadeBackground.tsx` + App.tsx 的 `PulsingCrossfadeBackground`——它是播放页常驻兜底背景，勿当作减配残留删除） |
| 其它 | AirPlay、分轨 Stem、远程遥控（`desktop/remote-server.cjs`）、设备授权（`device-license.cjs`）、代理管理（`proxy-manager.cjs`）、爱发电赞助同步（`scripts/sync-afdian-sponsors.mjs` 保留为孤立脚本但已无任何调用方/说明文档）、Wallpaper Engine 联动（`wallpaperEngineRotation.ts`）、专注计时 UI（`desktopFocusTimer.ts` / `useDesktopFocusTimer.ts` 已无消费方）、OOBE 引导、多语言 i18n（**法律弹窗改中文单语后保留**）、Smart AutoMix / Beat Crossfade（**只保留 Fixed Crossfade + gapless + 专辑无缝**）、cuefield 死代码。 |

**保留范围**：3 个音源；播放引擎（双 deck + Web Audio）；Fixed Crossfade + gapless + 专辑无缝；HSE(v3)（14 级主链 + 第 15 级空间音频、11 场景、EQ、WAV/MP3 导出、CC BY-NC-ND）；4 种歌词模式 + 桌面歌词独立窗；**Apple 风格歌词特性**（逐词点亮「apple」特效、崭新弹簧滚动、对唱着色 `appleDuetColors`、TTML 解析与 AMLL TTML DB 逐字源——**音源已去、渲染与数据源保留**）；播放页封面模糊铺底 + 背景律动（`CrossfadeBackground.tsx` + `PulsingCrossfadeBackground`）；频谱可视化 + 封面粒子特效（`AppleCoverFx.tsx` 保留、未接线）；桌面模式与小组件、自定义壁纸、天气系统（含 Apple 天气场景）、桌面播放器小窗、任务栏播控条；插件宿主 + Chroma/SignalRGB；B站看歌、MV、社交/评论/歌单；法律协议弹窗（中文单语）。

功能清单见 `docs/功能清单3.0.md`（12 个域 A–L，与源码冲突时以源码为准）；各模块边界与命令见 `AGENTS.md`。

## 3. 环境（重要）

| 组件 | 版本/说明 |
|---|---|
| Node/桌面 | **Electron 42（官方 stock `42.8.0`，无 Widevine）**、React 19、Vite 6、TypeScript 5.8、Tailwind CSS 4 |
| 后端 | Node + Express 单文件 `local-server.mjs`（端口 3211，127.0.0.1） |
| Python | **已无任何 Python 依赖**：Apple 播放面 bridge（`python-apple-bridge/`）与嵌入式运行时均已删除 |
| 平台 | Windows x64（NSIS 每用户安装，`perMachine: false`） |

> ⚠️ **端口占用坑（本机多项目共存，仍适用）**：本机还有 **WaveForge**（现役，其 Node 后端固定占用 **3001**，另见 3000/3002/30082）与 **ReWaveForge**（`E:\FolderForVibeCoding\dsh\ReWaveForge\backend-go\bin\waveforge-server.exe`，占用 **3001 / 3101**）。**HyperPlayer 自 2026-09-14 起把端口迁到 3210（Vite）/ 3211（Express 后端），与上述端口完全错开，可与两者同时运行**。若前端大面积"没有加载到内容"或后端日志报"端口已被占用"，先 `netstat -ano | grep :3211` 看是否被别的进程抢占（历史症状即 ReWaveForge 抢 3001 导致前端连到 Go 服务的空数据）。

**运行时升级历史**：2026-08-13 曾将嵌入式 Python 从 3.11.9 升到 3.13.15——该嵌入式运行时已随减配整体删除，此历史仅作留痕。

## 4. 端口

| 端口 | 服务 |
|---|---|
| 3210 | Vite dev / preview（后端 CORS 白名单仅放行此端口 + file:// + null） |
| 3211 | Express API（127.0.0.1） |

> 已停用：**18790**（Apple Music 播放面 Python bridge，随音源移除）、**3002**（旧 Python 节拍服务）、**3003**（旧 Python 响度测量）、**3004**（旧 Python 频响补偿设计）。历史文档中的 5001 同样是过时信息。

## 5. 已知问题 / 踩坑记录

1. **网易云 xeapi 公钥**：`/api/netease/song/url` 报 `xeapi public key is missing` 时，说明 `os.tmpdir()/xeapi_public_key` 被系统清理了 —— 重启后端即可（`initNeteaseAPI()` 启动时自动 `generateConfig()` 重新拉取，见 `local-server.mjs` 约 1670-1690 行：`generateConfig()` 调用约 1673 行、`initNeteaseAPI()` 顶层调用约 1689 行）。
2. **SSRF 守卫与内部代理链**：`proxy-image → cover`（`localhost:3211`）是本应用合法内部代理链，SSRF 守卫必须放行本服务自身端口 3211，否则评论区/歌单封面裂。**不要在守卫中一刀切封 localhost**。见 `local-server.mjs` 中 `isBlockedFetchUrl`（约 1372 行）内的放行分支。
3. **wallpaper-engine 路径穿越防护**：`/api/wallpaper-engine/preview|media` 用 `resolve + startsWith(base+sep)` 校验（`local-server.mjs` 约 8976 / 9024 行），改动时保持。
4. **Electron will-navigate 守卫**：主窗口 / 桌面播放器 / 歌词窗 / 任务栏小窗均已挂 `guardAgainstExternalNavigation()`（dev: localhost:3210/127.0.0.1:3210；prod: file:// 入口）。**QQ 音乐 QMK API Key 领取窗口是唯一被允许打开 `y.qq.com` 的窗口**（`QMK_SESSION_PARTITION = 'hyperplayer-qq-skill-key'`，独立 session 且每次打开前清空避免复用登录态）——不要为其他窗口放宽守卫。
5. **热路径日志**：播放/动画热路径必须用 `debugLog()`（`src/utils/debugLog.ts`），裸 console.log 会造成内存增长。开关：`localStorage['hyperplayer:verbose-log']='1'`（gapless 方案提示 `GaplessModeToast` 与过渡调试面板共用此开关）。
6. **Electron 为官方 stock 构建，不含 Widevine**：castLabs `+wvcus` 分叉、EVS/VMP 签名链与 Apple 原生 CENC 播放已整体移除，DMCA/DRM 相关脚本与状态卡不复存在。**若要做 Electron 性能改造**：把自编译产物整个目录替换到 `node_modules/electron/dist` 即可，electron-builder 的 `electronDist` 就指向该目录（打包链无需改动）；替换后跑 `npm run build:electron:dir` 验证，并避免让 `npm install/ci` 把目录重装回官方版。
7. **过渡策略只有 Fixed Crossfade**：`src/audio/transitionPlanner.ts` 的 `planTransition` / `planTransitionV2` 只产出 `fixed-crossfade`（`smart-rendered` / `smart-rendered-v2` / `beat-crossfade` 生成分支已整体移除）。节拍/结构分析能力（`autoMixAnalysisService.ts`）**保留**，但只服务 MV 对齐、PV 歌词等消费者，不再用于智能混音。别再从 `git log` 里恢复 Smart AutoMix。
8. **单一音效引擎**：`src/services/audio-engine/` 注册表只有 `v3Manifest` 一项（HSE）。`V3MixingStudio.tsx` 的引擎切换胶囊**仅在注册表注册了多个引擎时渲染**（渲染条件 `onSwitchEngine && availableEngines && availableEngines.length > 1`）；当前只有 HSE 一个，故界面不显示。接入新引擎只需新增 `engines/xxx.ts` + 注册表加一行。
9. **回滚注意**：本仓库有 git 历史，可用 `git log` / `git blame`；但**减配提交之后的 `git reset` 到旧提交会连带恢复已删功能**，不要为"修一个问题"而回退整个分支。
10. **回归修复记录（2026-08-16 审计，commit `d1b5e5f`）**——仍有效的三条：
    - 无限推荐队列裁剪：`setCurrentIndex` 原在 `setTimeout(0)` 里、与 `setPlaylist` 不同步 → 中间帧 `currentIndex` 越界导致播放页闪回首页 → 已改为同批次同步提交。
    - `loadAndPlay` 的 `NotAllowedError` 被静默吞掉（浏览器/手势策略拒绝 play 是真实失败）→ 已恢复走失败重试路径，仅 `AbortError` 静默。
    - QQ cookie 请求级传递：`/api/qq/mv/url`、`/api/qq/artist/subscribe` 等原依赖全局 cookie → 改 `resolveRequestCookie(cookie) || qqMusicCookie`。

## 6. 性能优化记录（2026-08-16 多轮并行，commit `1c8ef0c`~`6acf49c`）

> **改动时勿回退这些基线**。以下条目均已核对在当前源码中仍然成立。

1. **渲染降频**：三视图（HomeView/ExploreView/DesktopView）memo + `viewCallbacks` 稳定回调；弹窗（SettingsPanel/SongDetailModal/SimilarSongsPanel/UserProfileModal/UserProfileView/ProfileView/AlbumDetailModal/PlaylistPanel/PlaylistDetailPanel）全部 memo + `stableDialogCallbacks`；过渡进度 rAF 30fps 节流（结束帧强制 emit）；歌词 30fps 平滑时钟门控；频谱/脉冲 rAF 双门控（消费者计数 + visibility）；Banner 轮播抽离 memo 组件。
2. **列表虚拟化**：`CommentModal`（扁平行数组 + 变高行）、`ArtistDetailModal` 全部歌曲（定高 64px）、`PlaylistPanel` 用 react-window / `@tanstack/react-virtual`；ProfileView 高成本列表抽 memo 行组件 + latest-ref 回调。
3. **内存治理**：`SearchPanel` 搜索结果缓存 LRU 上限；封面 IndexedDB 写幂等 + `enforceLimit` 60s 节流；无限推荐队列裁剪（保留当前曲前 100 首）；HSE 引擎 dispose 清空节点引用。
4. **传输**：`/api/cover`、`/api/proxy-image` 流式转发（`streamProxyImage()`，不再整读超大图进内存）；后端 gzip（compression 中间件，filter 排除 image/video/audio 保流式）；axios keepAlive Agent。
5. **首屏/启动**：leaflet 懒加载（WeatherDetailsModal 拆 `weatherVisualTheme.tsx`）；vite `manualChunks`（vendor-react / framer-motion / leaflet 等）+ opencc-js `cn2t` 子路径（主入口体积显著下降）；`locationHierarchy` 8.8MB 单 chunk → 按国家拆分 + 动态 import（`vite.config.ts` 的 `split-city-data` 插件 + `scripts/split-city-data.mjs`，单 chunk 控 3MB 内）。
6. **cookie 单事实源**（1c8ef0c）：全局 `qqMusicCookie` 只在登录/设置接口更新；播放/读取路由用 `resolveRequestCookie` 只读；写操作按请求级 cookie 传递——修并发播放/写操作互相冲掉登录态。

> 已作废条目（随减配移除）：Python 服务缓存清理节流 / 向量化 / 磁盘缓存；v1/v2 引擎 dispose 清引用；遥控器增量广播。

## 7. 未决事项（可选做）

- [ ] **`scripts/sync-afdian-sponsors.mjs` 为孤立脚本**：无 `package.json` script、无 `prebuild` 钩子、无任何代码引用，配套文档 `AFDIAN_SPONSORS.md` 也不存在。可删（但删除前确认无人手动调用）。
- [ ] **专注计时残留**：`src/services/desktopFocusTimer.ts` + `src/hooks/useDesktopFocusTimer.ts` 无任何消费方（UI 已移除）。可清理；`desktopCustomization.ts` 里仍保留 `focusTimer → datetime` 的历史迁移映射（需一并判断）。**交叉引用**：`docs/功能清单3.0.md` 域 J 仍把它列为现役（该表 `src/services/desktopFocusTimer.ts:1-105` 一行），应加注「组件层已无消费方」。
- [x] ~~cuefield 后端残留~~：已确认清理完毕——`grep -c cuefield local-server.mjs` = 0，前后端均无 `/api/cuefield/*` 路由与调用方。
- [x] ~~HSE 单引擎下的引擎切换 UI~~：已由代码自动解决——`V3MixingStudio.tsx` 的切换胶囊仅在注册多个引擎时渲染，单引擎下自动隐藏（见 §5.8）。
- [x] ~~TransitionRenderer 缓存 key~~：已修复——`plan.id` 加入实际策略/起止时长/`RENDERER_VERSION`。
- [x] ~~CHUNK 体积警告~~：已优化（见 §6.5）。

## 8. 历史决策速览

> 历史记录。**不含**已随减配移除的功能决策（音效 v1/v2 双版本、Python 三服务与三入口、Diorama/多维歌词、Android TV 热更新与 APK、远程遥控、设备授权门控、爱发电名单、Smart AutoMix 三方案分流、AirPlay、分轨 Stem、**Apple Music / Spotify 音源与 Apple 播放面 bridge、Widevine/VMP 签名链与 castLabs 分叉**等——这些条目已整体删除，勿据此恢复）。`PROJECT_HISTORY.md` 从来不存在于本仓库，勿引用。

- 2026-07-10/07-13：两次项目合并（同学版本 + Wave-Forge 桌面版）。
- 2026-08-13：代码安全修复（SSRF / 路径穿越 / IPC 启动通道 / will-navigate）→ 全链路回归 → 文档整理。
- 2026-08-13：合并朋友优化版（HyperPlayer(4)）—— 安全加固 + 音频/渲染修复 + **QQ 音乐 QMK API Key 领取功能** + 打包修复。
- 2026-08-14：**Gapless 业务代码模块化** —— 从 `useAudioPlayer.ts` 抽离到 `src/services/gapless/`（`gaplessConstants.ts` / `seamlessJoinController.ts` / `gaplessTransition.ts`），hook 只剩调用接口。**后续改无缝逻辑优先改此处**。
- 2026-08-14：**UpNext 弹窗修复** —— gapless 启用时「即将播放下一首」通知不显示（`transitionStartTime` null 无 fallback），改为回退 `duration` 倒计时；**EPIPE 防护**（stdout/stderr 管道关闭时主进程不再崩溃）；**版本号更迭机制**（`npm run version:*`）。
- 2026-08-14：**遥控器 / SongDetail / 模式切换重构 / QQ 音乐修复** —— ⚠️ 遥控器部分**已随减配移除**；其余保留：`SongDetailModal` 与右键/径向菜单入口、`applyMode()` 模式切换重构、QQ 收藏歌单 POST 化 + AI 歌单补封面、PlaylistDetailPanel「收藏」按钮。
- 2026-08-14：**完整浅色模式** —— 播放页/简约首页/探索模式全表面浅色落地（桌面模式不生效）；设置-个性化深浅色开关（`localStorage.playerTheme` + `<html data-wf-theme>`）。
- 2026-08-16：**歌词逐字渲染修复**（词唱完瞬间灰闪/敲击感的根因修复、延音门槛收紧）+ **Apple 逐字模式**（`WordByWordEffectMode` 含 clear/soft/apple）；逆向对比见 `docs/歌词对比-LyricsBlossom.md`。
- 2026-08-16：**QQ/网易云 API 全面补齐 + 社交/个人中心重构** —— QQ MV 直接调 `GetMvUrls`；QQ 关注歌手 `cgi_concern_user_v2`（opertype 1 关注 / 0 取关，**必须用最新登录的 qm_keyst**）；关注/粉丝列表；ProfileView viewStack 导航栈；网易云热评 / 搜索联想 / 歌单搜索 / 私人 FM；探索页 Banner 轮播 / 电台 / 热门歌手 / 新碟 / MV 榜等（后端路由见 `server/` 与 `local-server.mjs`）。
- 2026-08-16：**自动切歌封面不更新——真正根因（`appleCoverUrl` 残留）** —— `displayCoverUrl = appleCoverUrl || currentTrack.coverUrl`，gapless 自动切歌（`commitPreparedSong`）与 albumGapless handoff（`handlePlayAt`）漏清 → 自动切歌后恒显旧封面。修复：两处路径补齐 `setAppleCoverUrl(null)` + `resolveAppleCover()`。（⚠️ 该变量与函数已随 Apple 音源于 2026-09-13 删除，本条仅作历史留痕，勿据 grep 恢复。）
- 2026-08-17：**音频引擎统一适配层重构** —— `src/services/audio-engine/`（`types.ts` 接口 `IAudioEngineAdapter` + `V3Adapter` + `engines/v3.ts` + `index.ts` 工厂注册表）。App.tsx 消掉 7 处版本分支，收敛为 `engineAdapterRef.current.xxx()` 单一调用，按 `capabilities` 判断能力。**接入新引擎**：写 `XxxAdapter.ts` + `engines/xxx.ts` + 注册表加一行，App.tsx 零改动。
- 2026-08-18：**HSE 调音室 UI 重设计** —— 左侧导航 **9 页**（主页 / 音效场景 / 均衡器 / 空间音效 / 空间音频 / 动态调音 / 分析 / 调音器 / 关于）+ 深色琥珀金主题（`hse-theme.ts`）+ 真实品牌徽章 + framer-motion 动效。**UI 重设计 = 覆盖旧组件，勿保留旧实现作并行选项**。
- 2026-08-18：**HSE 分析页修复 + 低音下潜 + 音量跟手 + 音量独立于场景** —— ①FFT 幅度归一化 dBFS；②线性频率轴 → 20Hz-20kHz 对数轴；③300ms 轮询 → 100ms + EMA 平滑；④`BassEnhancer.lowBoostDb`（-6..+12dB）真实低频下潜；⑤音量滑块经 `loudnessNormalization.externalGainDb` 80ms 快平滑（自动响度归一化仍慢速防抽吸）；⑥`applyScene` 保留音量通道，场景预设不覆盖用户音量。
- 2026-08-18：**融合同步 + `FusionEntitlements` 类型修复** —— 共享仓库不做强推改写；已知平台必填 + 开放索引签名。
- 2026-08-27：**PV 歌词模式** —— 详见 §10。

## 9. 常用操作速查

> 命令以 `package.json` 的 `scripts` 为唯一事实来源（下表已逐条核对存在）。

```bash
# 开发
npm run dev:electron          # 完整开发环境：Vite(3210) + Express(3211) + Electron 窗口
npm run dev                   # 仅 Vite dev (3210)；天气调试页 http://127.0.0.1:3210/weather-debug.html

# 验证
npm run lint                  # 类型检查 tsc --noEmit（仅覆盖 src/，仓库无 ESLint）
npm run test                  # vitest 单测（2026-09-13 实测：120 文件 = 119 过 + 1 跳过；1173 用例 = 1168 过 + 5 跳过 + 0 失败）
npm run test:desktop          # node --test 桌面/安全用例（audio-download / local-api-health / taskbar-widget-polling / trusted-ipc / update-manager-security / user-data-profile 等）
npm run test:chroma           # Razer Chroma 插件自测
npm run test:signalrgb        # SignalRGB 插件自测
npm run test:installer        # 生成安装器 UI 资产 + 安装器测试
npx vitest run src/services/HyperSoundEngine-v1   # 改 HSE 算法前必跑

# 构建
npm run build                 # vite build -> dist/（三入口：index.html / desktop-player.html / desktop-lyrics.html）
npm run build:electron        # 发布安装版：build:electron:dir + 安装器美术 + electron-builder NSIS -> release/HyperPlayer-<version>-Setup.exe
npm run build:electron:dir    # build + electron-builder --win dir + verify-asar 校验 -> release/win-unpacked
npm run build:v3-worklet      # 重生成 HSE AudioWorklet 单文件 -> public/v3-worklet.js（predev/predev:electron/prebuild 自动执行）
npm run build:apple-weather   # 重新生成 Apple 天气场景资源（纯天气视觉，与 Apple Music 音源无关）
npm run preview               # vite preview
npm run start                 # electron .（直接起已构建产物）

# 安装器（签名链已移除：无 EVS / VMP / Widevine 步骤）
npm run gen:installer-art / preview:setup / test:installer

# 基准
npm run benchmark:mv          # B站 MV 相关基准

# 版本更迭
npm run version:patch         # 1.0.0 -> 1.0.1（自动 commit/tag/push）
npm run version:dry           # 预览更迭（不落地）

# 发布（⚠️ Releases 只发 NSIS 安装版，不发便携版 win-unpacked/）
git tag v<version> && git push origin v<version>
gh release create v<version> release/HyperPlayer-<version>-Setup.exe --title "v<version>" --notes "changelog"
# 安装版每用户安装、不携带用户数据；用户配置生成于各机 %APPDATA%\HyperPlayer\

# 回滚
git log --oneline             # 查看历史
# ⚠️ git reset --hard <sha> 回退到减配前提交会连带恢复已删功能，勿为单点修复而整体回退
```

> 已删除、**不要再用**的脚本：`dev:api`、`build:full`、`build:android`、`fetch:nodejs-mobile`、`publish:release`、`bundle-python`、`test:license`、`sync:sponsors`、`verify:beat-this`、`test:stems:node`、`test:stems:python`、`postinstall`、**`vmp:sign:release` / `vmp:verify:release` / `vmp:status:release`（及 `*:dev`）、`build:electron:dir:unsigned`**。

## 10. PV 歌词模式（2026-08-27 新增，4 种歌词模式之一 · pv-tool 引擎 + 凝彩式逐字动画 · 全自动）

`lyricDisplayMode: 'pv'`（模式面板显示名「PV」）。**pv-tool 引擎 + 凝彩式逐字动画内核**：保留 pv-tool 模板/特效/节拍体系（不引入 folia tempera），把凝彩的「逐字编排动画」机制做进歌词层，全自动无设置。

**实现**
- `src/components/pvLyrics/PvLyricsPage.tsx`：pv-tool 引擎桥接 + 60fps 编排执行（时钟 seek/暂停精确；ResizeObserver；MV 激活→引擎透明露出 BilibiliMvBackground，无 MV→封面取色铺底）
- 段落编排 `pvDirector.ts`：行间隙中位数×2.5 切段 + sections 定性（intro/breath/passage/chorus/outro），段落级自动换模板（推荐池 + 段落族风格池，相邻不重复）；`engine.fadeToTemplate` 淡出→重载→淡入平滑切换，切换瞬间 glitch/shake 爆发（剪辑切镜）；能量→参数曲线（节拍响应/动画速度/后期滤镜）每帧平滑 + 镜头慢呼吸 + 间奏 bridge 演出
- 凝彩式逐字动画 `effects/wfLyricOverlay.ts`：词级独立对象 + 7 种确定性入场（left/right/above/below/swing/stamp/fade，词内容 seed 派生）+ elastic 弹入（入场窗随句长伸缩）+ 已唱高亮/辉光 + 唱完字距外扩 release + 节拍加成；**无逐字时间戳的歌词用 Intl.Segmenter 分词 + 行时长按字重等分自动合成词级时间戳**，不再退化为整行静态——任何歌都有逐词动画
- 引擎扩展：ctx 暴露 `words/lineStart/lineDuration`（真实时间驱动）；`onTemplateReload` 回调保证 overlay 在每次模板重载后自动重挂

**演进记录**：v1 手动模板+设置 → v2 全自动推荐+设置移除 → v3 曾直接以 tempera 为内核（用户明确否：要求保留 pv-tool 引擎改造成凝彩式逐字，非替换）→ v4（现状）pv-tool 引擎 + 凝彩式逐字合成。tempera 内核版本已回退；`src/vendor/pv` 全程保留。

**隔离边界**：只新增 `pvLyrics/` 目录 + App.tsx 模式接入；未改动任何既有歌词页组件。Apple Music 音源与 `Apple*` 探索/播放组件已于 2026-09-13 移除，但 **Apple 风格歌词侧实现（`LyricsDisplay.tsx` 的逐词点亮、`appleLyricsStyle.ts` 的对唱着色等）与 pvLyrics 无耦合，互不影响**。
