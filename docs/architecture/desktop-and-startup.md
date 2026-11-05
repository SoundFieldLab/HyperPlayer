# 桌面端与启动页

## TV 专属逻辑已彻底清除

原 `src/tv/tvCore.ts` 空壳（遥控器焦点环/BACK 栈/软键盘，全部具名导出恒返回空值）已删除——它此前被 56 个组件引用（48 处 `useTvBack`、21 处 `useTvMode`）却恒为 no-op，删后全仓零 `tvCore` 残留。

同批清理：60+ 处 `data-tv-*` 焦点标记属性、`PlaylistCarousel3D` 的 TV `compact` 紧凑特性、`src/platform.ts` 的 `isTv`/`isAndroid`/`isTvModeActive`/`applyTvScale`/`TV_SCALE_*` 等全部 TV 表面（`platform.ts` 现只剩 `detectPlatform`/`isDesktop`/`getPlatform`，仅区分 desktop/web 两态）。

**`perfMode.ts` 保留且是活代码**（性能模式 + 缓存上限，被设置面板消费），**不要**当作 TV 残留删除。**勿再往这里加 TV 专属逻辑。**

## 目录

`desktop/` — Electron main process，**CommonJS**：`main.cjs`, `preload.cjs`, `splash-preload.cjs`, `desktop-lyrics-preload.cjs`, `desktop-player-preload.cjs`, `taskbar-widget-preload.cjs`, `config-manager.cjs`, `window-state.cjs`, `user-data-profile.cjs`, `trusted-ipc.cjs`, `update-manager.cjs`, `update-applier.cjs`, `audio-download.cjs`, `chroma-*.cjs`, `signalrgb-*.cjs`, `razer-device-discovery.cjs`, `taskbar-widget-polling.cjs`, `splash.html`, `splash-baked.webm`, `taskbar-widget.html`。

`splash.html` 与 `splash-baked.webm` 都是**生成物**（由 `scripts/build-splash.mjs` 产出，勿手改）。Not covered by `tsc --noEmit`。

`src/desktop-lyrics/` + `src/desktop-player/` — standalone renderer entries for `desktop-lyrics.html` / `desktop-player.html`。

## 启动页（splash）流水线 —— 预渲染视频版

`new-splash/splash-webm.webm`（设计侧录制的 VP9/WebM，1400×900、103 帧）→ `npm run build:splash`（`scripts/build-splash.mjs`）→ **帧时基归一**（`scripts/retime-splash-webm.mjs`）→ `desktop/splash.html` + `desktop/splash-baked.webm`。

### 为什么用预渲染

启动页原本实时跑 18 层大半径模糊 + JS 流体/锁体动画，启动瞬间与主窗口加载抢 CPU，导致进场动画出帧滞后、观感发卡。预渲染把开销前移到构建期，运行时只解码（走 GPU，几乎不占 CPU）。

### 为什么是 WebM 而非 GIF / 动画 WebP

GIF 仅 256 色，这套多层柔和渐变会出现明显同心色带，且体积是 WebP 的 34 倍；动画 WebP 虽能解码，但浏览器内部自动播放、**拿不到「播完了」的事件**，而启动页必须靠该信号通知主进程切窗口。WebM 的 `<video>` 有 `ended` 事件与 `currentTime`，时序可精确控制。

### 帧时基归一（构建期，勿绕过）

录制侧把内容帧率与时间戳网格搞拧是常态——实测源为「103 帧内容（≈32.6fps）塞进 25fps 网格」，**24 对相邻帧共享同一时间戳**、最大间隔 80ms，且 25fps 与 60Hz 不整除。**这部分抖动是文件自带的，换何时播/换解码方式都治不好**。

故 `build:splash` 调用 `scripts/retime-splash-webm.mjs` 把帧重铺到 **30fps 均匀网格**（30 对 60/120Hz 都是整数倍）：只改 int16 时间戳与 `DefaultDuration`/`Duration`，**编码数据一字节不碰**（可用 cmp 验证：162 处差异字节全部落在时间戳字段内），画质零损失、文件长度不变（Cues/SeekHead 偏移仍有效）。代价是动画整体放慢 ~8.6%（3.16s → 3.43s），不可感知。

**源文件保持录制原件不动**，重录后重新构建即自动生效；脚本自带自校验（唯一性/递增/间隔/长度），不满足即构建失败。归一后实测：呈现 103/103 帧、解码掉帧 0、帧间隔中位数 33.4ms、最大 33.6ms。

### 时序契约（`desktop/main.cjs` 依赖，勿改）—— 两段式

1. **阶段一「假 splash」**：窗口 `show()` 后页面**只停在视频第 0 帧**（实测那帧是**纯背景、无 logo/文字**），零解码开销、天然不卡，用来兜住程序加载时段。
2. **阶段二「真 splash」**：主进程在「主窗口首帧 + 主窗口加载完成 + 本地后端就绪」三条件齐备（或 `SPLASH_START_MAX_WAIT_MS` 超时兜底）后才发 `splash:start` 放行，页面收到才 `play()`——起点即同一帧，切换零跳变，且入场动画不再和启动抢资源。
3. 视频 `ended`（或播放失败）时页面调 `window.splashBridge.entranceDone()`（桥在 `desktop/splash-preload.cjs`）→ 主进程 `showMainWindowWhenReady` 满足「启动页已显示 + 最短可见 + 动画播完」才切主窗口。

**两个兜底锚点别搞混**：`SPLASH_ENTRANCE_FALLBACK_MS` 锚定**起播时刻**（不是窗口显示时刻——放行已推迟，锚错会把正常播放的视频拦腰切断），`SPLASH_MIN_VISIBLE_MS` 仍锚显示时刻。

### 代价（2026-09-13 实测，勿误当 bug）

本地后端就绪约 **3.6～3.9s**（sweepBackendOrphans 的 PowerShell 端口探测 + utilityProcess 载入 11k 行模块），故**总启动时长变为约 7.4s**（原 ~4.0s）= 等后端 ~3.6s + 完整播完 3.43s。这是「等程序就绪再播 + 播完整段」两个选择的必然结果；嫌久就调 `SPLASH_START_MAX_WAIT_MS`，或改回「只等主窗口首帧」（约可省 3s）。

### 帧节拍探针

页面用 `requestVideoFrameCallback` + `getVideoPlaybackQuality()` 统计实际呈现帧数/最大帧间隔/解码掉帧，经 `splashBridge.mark()` → `splash:mark` 写入启动日志，形如 `[splash] 视频 3433ms / 呈现 103 帧 / 最大帧间隔 34ms / 解码掉帧 0/103 (ended) @页面内+Nms`。**判断"动画卡不卡"看这一行，别靠肉眼猜**。

### 舞台几何

视频按**自身比例（1400×900，非 16:9）以 cover 铺满窗口**——窗口比例与视频一致（默认 1400×900）时 1:1 原样呈现，其它比例只裁掉边缘抽象渐变，logo 组位于画面中部永不被裁。**勿把舞台写死 16:9**：写死会在非 16:9 窗口（用户窗口尺寸有记忆）上把视频放大 1.3 倍并四边裁切，构图明显失真（2026-09-13 用户实测发现）。

### 启动窗口位置（2026-09-13 起恒居中）

启动页与主窗口共用 `resolveTargetBounds()` 的同一份 bounds（切换不跳动）；**位置恒为该显示器工作区几何中心**（`window-state.cjs` 的 `centerBoundsInWorkArea`），**不恢复记忆里的 x/y**——记忆位置可能来自最大化/全屏/kiosk 等瞬态（实测存出过贴顶的 y=7，用户观感「不在屏幕正中」）。尺寸、最大化状态、所在显示器仍按 `window-state.json` 记忆恢复；**勿改回「照搬记忆位置」**。

初始阶段曾把设计稿（`new-splash/hyperplayer-splash/` 与 `new-splash/new-splash/`，二者均为 pen.dev 导出 + `build.py` 生成实时动画版 `index.html`）直接适配为实时动画页；现保留作**设计源与参考**（改速度/幅度改各自 `build.py`），但不再接入启动页。`new-splash/new-splash/build.py` 会把运动幅度按 1400/1920 等比缩放，改画布尺寸时勿忘同步。

## 安装器美术

`build/` 打包资源 — 不止 icon：**自定义 NSIS 安装器 UI 资产**（`installer.nsh` + `installerHeader/Sidebar.bmp` 等主题图 + `ui/`、`ui-clone/` 中文按钮/页面 bmp），由 `scripts/generate-installer-art.mjs` / `generate-installer-ui.mjs` / `generate-installer-clone.mjs` 生成；预览用 `node scripts/preview-setup.mjs`（独立 NSI 在 `scripts/setup-preview/preview.nsi`）。改安装器视觉先跑生成脚本再构建。

## QQ 音乐 QMK API Key 窗口

`desktop/main.cjs` 含 **QQ音乐 QMK API Key 领取窗口**（`QMK_OFFICIAL_KEY_URL` y.qq.com；独立 session partition `hyperplayer-qq-skill-key`，每次打开前清空避免复用登录态）——编辑时保留隔离分区与导航守卫逻辑。

## 脚本清单

`scripts/` — dev 启动器（`dev-electron.mjs`、`start-api.mjs`、debug/hidden VBS）、`build-hse-worklet.mjs`（HSE worklet 打包）、`build-apple-weather-scenes.mjs`（仅天气场景视觉，与 Apple Music 音源无关）、安装器美术/预览脚本、`bump-version.mjs`、`assert-release-not-running.cjs`、`verify-asar.cjs`、`build-hot-update.mjs`、`test-chroma*.cjs` / `test-signalrgb*.cjs` / `test-razer-device-discovery.cjs`、`bilibili-mv-benchmark*.mjs`、`split-city-data.mjs`、`retime-splash-webm.mjs`。

**EVS/VMP 签名脚本与 Apple 诊断脚本（`diagnose-apple-api.cjs` / `probe-apple-*.cjs` / `probe-widevine-electron.cjs`）已随 DRM 链移除。**
