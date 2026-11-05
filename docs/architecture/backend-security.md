# 后端安全与配置隔离

## 本地后端结构

`local-server.mjs` — single-file Express backend（~11k 行, port 3211）。Extra route modules in `server/` are registered here（`hazard-api` / `location-api` / `bilibili-api` / `netease-native-explore`；工具模块 `byte-lru-cache` / `comment-api-utils` / `local-api-health` / `local-service-auth` / `qrc-decoder`）。

QQ cookie state must flow through the single `qqMusicCookie` source of truth。

## QQ cookie 单事实源规则

全局 `qqMusicCookie` 只在显式登录/设置接口（`/api/qq/cookie`、`/api/qq/user/setCookie`）更新；播放/读取路由一律用 `resolveRequestCookie(cookie)`（请求 cookie 仅本次使用，绝不回写全局），写操作按请求级 cookie 传递——并发播放/写操作不得互相冲掉登录态。

播放类路由（song/url、mv/url、mv/detail、comment、user/detail 等）用 `resolveRequestCookie(cookie)` 只读不写全局；写操作（like、playlist/tracks、subscribe、artist/subscribe）一律传请求级 cookie 并 `cookie || qqMusicCookie` 回退。改 cookie 逻辑时保持此单事实源约束。

## Electron 主进程

所有窗口（主窗口/桌面播放器/歌词窗/任务栏小窗）都挂 `guardAgainstExternalNavigation()`（will-navigate 拦截外部跳转）；QQ QMK 领取窗口是唯一被允许打开 `y.qq.com` 的窗口——不要为其他窗口放宽守卫。

## 代理与路径

- `/api/cover` and `/api/proxy-image` have an SSRF guard blocking private/loopback/link-local IPs and DNS names resolving to them. **The internal proxy chain `proxy-image → cover` is legitimate**: guard must keep allowing `localhost:3211` (the app's own origin) — inner `/api/cover` still validates the final CDN target, so blocking localhost:3211 would break comment/playlist avatars.
- `/api/wallpaper-engine/preview` & `/media` enforce path containment under the WE base dir (resolve + startsWith(base+sep)).

## Netease xeapi

`initNeteaseAPI()` in local-server.mjs calls the lib's `generateConfig()` at startup to register an anonymous token and fetch the xeapi public key (cached in `os.tmpdir()/xeapi_public_key`). If `/api/netease/song/url` starts returning `xeapi public key is missing`, the tmp cache was cleared — restart the server.

## 本地服务鉴权

`server/local-service-auth.mjs` 的 `LOCAL_SERVICE_HEADER`（`x-hyperplayer-local-token`）+ `isAuthorizedLocalRequest()` 对配置了 token 的本地服务做 constant-time 校验——新增内部接口时沿用同一约定。

## 配置隔离不变量（勿与 WaveForge / 其他 Electron 应用共用）

HyperPlayer 由 WaveForge 改名而来，**两者的配置、登录态、缓存、Chromium profile 必须完全独立**。以下是不变量：

- **userData 独占**：`desktop/user-data-profile.cjs` 的 `selectHyperPlayerUserData()` 是唯一解析入口——**打包版与开发版都固定用 `%APPDATA%/HyperPlayer`**（开发版仅认显式传入的绝对路径 `HYPERPLAYER_USER_DATA`）。
  - **禁止**回退到 Electron 的公共默认目录 `%APPDATA%/Electron`——那是**所有 Electron 应用共享**的位置（本机实测含 WaveForge 等项目的键），共用会导致配置/凭据/DRM 数据交叉。
  - 历史上曾靠「文件标记探测」认领该公共目录；随功能减配（`remote-settings.json` 所属的远程遥控已删除、不再创建）该判定对新环境恒为 false，不可靠，**已整体移除**。`test/user-data-profile.test.cjs` 有回归测试防止重新引入。
- **产品身份**：`package.json` 的 `build.appId` = `com.hyperplayer.desktop`（WaveForge 为 `com.waveforge.desktop`）；`app.setName('HyperPlayer')`；IndexedDB 库名 `HyperPlayerCache`；本地服务 token 环境变量 `HYPERPLAYER_LOCAL_TOKEN`。改名时这些标识**不要复用旧值**。
- **localStorage 键**：**新增** HyperPlayer 键一律用 `hyperplayer:` 前缀；各平台登录态用其平台前缀（`netease*` / `qq*`；B站登录有效期记录沿用历史键 `wf_login_expiry_bilibili`）。**不要新增 `waveforge:` 前缀键**。播放页快捷设置保留少量**历史裸键**（`coverPulseEnabled` / `coverPulseMode`（背景律动，`App.tsx` 与 `QuickSettings.tsx` 同键同事件）、`playerTheme`、`backgroundEffect` 等），歌词侧的对唱着色开关 `appleDuetColors` 同为历史裸键，**勿盲目改名**——改名会丢用户已保存的设置。
- **Chroma 残留清理**：`desktop/chroma-app-list-repair.cjs` 的 `STALE_APPS` **故意**列出 `WaveForge*` 旧注册名（用于清理旧版升级用户的残留），**不要把它当成共用配置而删掉**；但也要确保 `HyperPlayer` 不在该清单内（否则会误删自身注册）。
- 磁盘上遗留的 `%APPDATA%/Electron` / `%APPDATA%/WaveForge 澜音工坊` 目录**不主动删除**（可能被其他应用使用），代码只做「不再读取」。
