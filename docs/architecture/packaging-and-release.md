# 打包、发布与更新

## 打包规则（electron-builder）

`build.files` 白名单 = `desktop/**/*`、`dist/**/*`、`server/**/*`、`shared/**/*`、`local-server.mjs`、`package.json`、`logo.png`、`build/**/*`，外加四条**体积排除规则**（2026-09-14 加入，勿删）：

- `!build/ui/**`
- `!build/ui-clone/**`
- `!**/*.map`
- `!node_modules/@neteasecloudmusicapienhanced/api/public/**`

`build/ui/**` 与 `build/ui-clone/**` 是 NSIS 安装器位图，仅安装器编译期读取——`installer.nsh` 里的 `File "${BUILD_RESOURCES_DIR}\ui\*.bmp"` 从**仓库源目录**取，运行期不读。`!**/*.map` 是 sourcemap（生产包无用，曾占 120 MB）。`@neteasecloudmusicapienhanced/api/public/**` 是该库自带的 HTML 文档页与截图（约 13 MB）；其 `server.js` 里的 `express.static(public)` 只在 `constructServer()` 内，而本项目的 Express 应用从不调用它。

清单里还列了 `THIRD_PARTY_NOTICES.md`，但该文件当前不存在于仓库根，属悬空条目。

**已无 `asarUnpack`**——原先唯一的解包项是 Apple bridge 的 `.py`（Python 脚本不能从 asar 内执行），随音源移除后整块删除；现已无 Python 服务与离线 wheels。

`scripts/verify-asar.cjs` 已接入 dir 构建链（`build:electron:dir`：electron-builder 之后）：校验 asar 结构自洽（头部/条目越界/package.json 可解析）。

`build:electron:dir` 还会在打包前跑 `check-packaging --config-only`、打包后跑完整 `check-packaging`（见下方「依赖分区约束」的拦截表）。

**构建运行期间不要编辑任何会被打包的文件**——electron-builder 先按 stat 尺寸写头部、后拷贝内容，中途文件被改（哪怕只改注释）会静默产出 **Node 能读、Electron 拒载**的坏包（症状：启动停在 Electron 默认页/帮助文案），闸门就是拦这个的。

## 依赖分区约束（`dependencies` vs `devDependencies`）

electron-builder **只打包生产依赖**（`dependencies`），**不打包 `devDependencies`**。因此：

- **纯前端库必须放 `devDependencies`**：`react` / `react-dom` / `three` / `@react-three/*` / `pixi.js` / `hls.js` / `lucide-react` / `framer-motion` / `leaflet` / `react-window` / `@tanstack/react-virtual` / `country-state-city` / `china-area-data` / `@svg-maps/world` / `qrcode.react` / `opencc-js` / `lamejs` / `@soundtouchjs/audio-worklet` 等。它们**已经被 Vite 打进 `dist/`**（渲染进程加载的是 dist，不是 node_modules），留在 `dependencies` 只会让同一份代码在安装包里存两遍——这正是 asar 曾膨胀到 **411 MB** 的根因（19 个前端库 + 110 个传递依赖 = 264 MB）。
  - 实例：`three-stdlib` / `@mediapipe/tasks-vision` / `stats-gl` / `@dimforge/rapier3d-compat` 等 110 个包并不直接被引用，只是上述前端库的传递依赖，随之一并消失。
- **`dependencies` 只放「运行期模块树里真正被 require 到」的包**：当前 10 项 = `@jixun/qmweb-sign`、`@neteasecloudmusicapienhanced/api`、`adm-zip`、`axios`、`compression`、`dotenv`、`express`、`qq-music-api`、`qrcode`、`ws`。
- **判定不能只看入口的直接 import**：netease API 用 `readdirSync` **动态加载** `module/*.js`，其中 `login_qr_create.js` 需要 `qrcode`、`song_url_v1.js` 需要 `dotenv`——静态看入口看不到，但它们**确实是运行期依赖**，误移到 devDependencies 会让扫码登录 / 取歌链在打包版里挂掉。`axios` 同理（`local-server.mjs` 直接 import，原先竟未在 `dependencies` 声明，只靠 hoisting 侥幸可用——已补齐显式声明）；`ws` 由 `scripts/lib/head-tracking-osc.cjs` 使用。
- **闸门**：`npm run check:packaging`（`scripts/check-packaging.mjs`）——从运行期入口（`local-server.mjs` + `desktop/*.cjs` + `server/` + `shared/` + `scripts/lib/`）算出可达闭包，扫闭包内**所有**文件确认每个 `dependencies` 条目真的被 require（因此能看到 netease 的动态加载），并校验四条排除规则仍在；若 `release/win-unpacked/resources/app.asar` 存在，还校验其体积（预算 130 MB）与内容（不得含前端库 / `.map` / 安装器位图，且 `package.json`、`local-server.mjs`、`logo.png`、`build/icon.ico`、`desktop/main.cjs`、`dist/index.html` 必须在）。`--config-only` 只查前两项（依赖分区 + 排除规则，1~2 秒），供构建前置使用。
- **减负是「配置持久 + 多重拦截」，改依赖/打包配置前先看这张表**：体积约束的**真正事实源是 `package.json`**（依赖分区 + `build.files` 排除规则），它对本机、CI、任何机器都生效；闸门只是防回归。四个拦截点：

| 路径 | 拦截方式 |
|---|---|
| `npm run build:electron:dir` | 打包**前** `check-packaging --config-only`（早失败，不必等两分钟）+ 打包**后**完整 `check-packaging`（核对真实产物） |
| `npm run build:electron`（NSIS） | 首步即 `build:electron:dir` → 由上一条覆盖 |
| 手工 `npx electron-builder --win dir` | `build.beforePack` = `scripts/before-pack-check-packaging.cjs`（electron-builder 自身事件，与调用方式无关；抛错即中止打包） |
| CI | `ci.yml` checks 作业 + package-verify 作业、`nightly.yml`、`pre-release.yml` 各跑一次 |

**已知边界**：`--prepackaged` 时 `app-builder-lib` 的 `doPack()` 会提前 return，`beforePack` **不触发**——这是合理的，该路径打包的是**已经过闸门的** `release/win-unpacked`，不重新解析 node_modules，故无需重复校验。

**依赖分区不影响构建前提**：把前端库移到 `devDependencies` **不会**要求「生产安装」——`vite` / `electron` / `electron-builder` 本来就在 `devDependencies`，任何构建早已需要完整安装（工作流里也没有 `--omit=dev` / `NODE_ENV=production`，`npm ci` 默认装全套）。

## 打包体积基线（2026-09-14 实测）

asar **411 MB → 80 MB**（载荷 387 MB → 74.7 MB，文件条目 20540 → 7457），其中 `dist/` 37.4 MB（前端产物，必须）+ 运行期 node_modules 约 32 MB + `desktop/` 2.2 MB + `build/` 仅 682 KB（只剩 `icon.ico` / `installer.nsh` / 几张安装器头图）。

**安装版与便携版内容完全一致**——两者都由同一份 `release/win-unpacked/` 决定（NSIS 是 `--prepackaged release/win-unpacked` 打的），所以本次减重同时惠及两种分发形式。

## 打包三大约束（破坏任一条打包产物就会黑屏/缺资源）

1. `vite.config.ts` 的 **`base` 必须保持 `'./'`**（顶层配置，不要移进 `build` 子对象）——打包版用 `loadFile()`（file://）加载 `dist/index.html`，若 base 是 `'/'`，资源以 `/assets/...` 绝对路径引用全部 404，React 不挂载 → 整窗黑屏。
   - **注意 `Renderer resources: 0` 不是可靠判据**（2026-09-14 实测）：该日志在 `did-finish-load` 瞬间取 `performance.getEntriesByType('resource')`，此时条目常尚未填充，正常包也会打 0；判断黑屏请看**后续实时查询**（正常包 +20s 报 40 个资源、`readyState: complete`）与画面本身，勿仅凭这一行误判 base 配置错误。
2. `package.json` `build.files` 必须包含 **`logo.png` 与 `build/**/*`**——主窗口/登录窗口 icon 用 `../build/icon.ico`，`logo.png` 仍被主进程（`nativeImage` 窗口图标）使用；漏打包会导致窗口图标丢失。（启动页 `desktop/splash.html` 现已把 logo 内联为 data URI，不再依赖外部 `logo.png`。）
3. `package.json` `build.electronDist` 保持 `node_modules/electron/dist`——electron-builder 离线构建全靠这个本地副本。**该运行时现为官方 stock `electron@44.5.0`**（2026-10-04 从 42.8.0 升级：Chromium 152 / V8 15.2 / Node 24.18.1；castLabs `+wvcus` 分叉与 Widevine/VMP 链早已移除；44 官方自带 Node startup snapshot + preload/V8 code cache，无需自编译）。
   - **升级 Electron 二进制**：`npm install --save-dev electron@<版本>` 换 spec 后本机 postinstall 不生效，需 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 手动下载（直连 npmmirror 可用）；**同步更新 `vite.config.ts` 的 `build.target: 'chrome<主版本>'`**，否则新语法会发给旧内核。
   - **若要对 Electron 做源码级魔改（自编译 / 手改）**：做法就是**把自编译产物整个目录替换到 `node_modules/electron/dist`**——打包链与配置**无需任何改动**（`electronDist` 是打包时运行时的唯一来源）；替换后先跑一次 `npm run build:electron:dir` 验证，并注意别让 `npm install` / `npm ci` 把该目录重装回官方版。

## 发布策略

正式版（stable，打 `v*` tag）的 release 资产 = NSIS 安装包（`npm run build:electron` → `release/HyperPlayer-<version>-Setup.exe`）+ 热更新包 `hyperplayer-hot-<version>.zip`（app.asar + app.asar.unpacked，由 `node scripts/build-hot-update.mjs` 产出；非 npm script）。

nightly 渠道同样只发 NSIS 安装包（2026-09-14 起不再发便携版 zip）。`release/win-unpacked/` 本身仍不入库、不随 releases 分发（仅本地调试产物）。

发布时：打 `v<version>` tag → push tag → `gh release create v<version> release/HyperPlayer-<version>-Setup.exe release/hyperplayer-hot-<version>.zip`（附 changelog；CI 里是 `artifacts/*` 全量上传）。

**手动发版首选 Actions 页的「Release 发版」（`release.yml`，2026-10-04 加入）**：workflow_dispatch 填 `version`（必填，可带预发布后缀）+ `notes`（可选版本说明，textarea 多行），自动 bump 版本（`scripts/bump-version.mjs`，含 lock 两处）→ 提交推送 main → 构建 NSIS+热更包 → 构建成功后打 tag → 创建 Pre-release → 纯语义版本号回写 `update.json`；tag 由 github.token 推送，**不会级联触发 pre-release.yml**（无双发布）。

安装版为每用户安装（`nsis.perMachine: false`），**不携带任何用户数据/配置**——用户配置生成于各机 `%APPDATA%\HyperPlayer\`，安装后自动适配当前用户。

CI 见 `.github/workflows/release.yml`（手动发版）、`pre-release.yml`（人工推 `v*` tag 触发的发布链）与 `nightly.yml`（每日 nightly）；**CI 已无 EVS secrets、也无 production streaming VMP 剩余天数门槛**——Electron 为官方 stock 构建，Widevine/VMP 签名链整体移除。

## 发布形式一律为 Pre-release

本仓库处于测试阶段，版本化发版（`release.yml` 手动触发 / `pre-release.yml` 打 `v*` tag 触发）与每日构建（`nightly.yml`）**全部以 GitHub Pre-release 形式发布**，不占用正式 latest。

`nightly.yml` 每次构建生成唯一 tag `nightly-<YYYYMMDD>` 并创建**独立** Pre-release（当天重复构建覆盖当天同名 tag/release）。**无真实代码变更时 nightly 取消本次运行**（2026-10-26 起）：prepare 判定为「无代码变更」后不再构建/发版，而是写一条跳过摘要并 `gh run cancel "$GITHUB_RUN_ID"` **取消整次运行**（运行记录显示 cancelled，而不是「success 但 build/release 全跳过」的假构建）——因此 workflow 的 `permissions` 除 `contents: write` 外还需 `actions: write`；changelog 上传步骤加了 `has_changes == true` 门控。

判定用与上次 nightly tag 的树 diff 并**排除机器人回写的 update-nightly.json / update.json**——此前每日清单回写提交让判定永远失真，曾连发 21 次空转 nightly 并在 main 上留下 21 条机器人提交（这些提交已于 2026-10-04 从 main 历史剔除、清单内容压成一条保留；**旧 nightly tag/release 也已同日清理，仅保留最新的 `nightly-20261004`**——即 update-nightly.json 指向的目标，nightly 渠道「检查更新」不受影响）。

## 更新渠道（两条，清单由 CI 产出）

`src/services/updateConstants.ts` 是渠道标识 / 展示名 / 客户端读取规则的唯一事实源；清单文件名由 `shared/update-manifest-files.json` 与 CI 脚本共用。

| 渠道 | 清单文件 | 产出方 | 规则 |
|---|---|---|---|
| 正式版 stable | `update.json` | `pre-release.yml` | 仅当 tag 为**纯语义版本号**（如 `1.0.0`）时生成并提交，推向全体用户 |
| 每日构建 nightly | `update-nightly.json` | `nightly.yml` | 每次构建都生成并提交，仅被主动切到 nightly 渠道的用户拉取 |

- **更新清单生成唯一实现在 `scripts/lib/update-manifest.mjs`**：`scripts/build-update-manifest.mjs` 是 CLI，`release.yml` / `pre-release.yml` / `nightly.yml` 只传 channel / version / tag / repo / notes-file / artifacts / output，**不要再在 workflow 里内嵌 Node heredoc**。清单文件名唯一事实源是 `shared/update-manifest-files.json`（`updateConstants.ts` 与脚本共同读取）。stable 默认带 `win-x64-hot`（存在热更包时），nightly 只带 `win-x64` 安装包。回归测试：`test/updateManifest.test.ts`（模块 + CLI，含 stable/nightly 与缺安装包退出码）。
- 两个清单都是**版本无关的固定地址**（`raw.githubusercontent.com/.../main/<文件>`，代理优先 + 直连兜底），各自指向对应 release 的产物（正式 tag / `nightly-<日期>` pre-release）。清单内带 `channel` 字段。
- **Nightly 版本号 = 正式版 patch + 1 再挂日期**（`1.0.0` → `1.0.1-nightly.<YYYYMMDD>`）：按 semver 高于当前正式版，保证正式版用户切到 nightly 能立即检测到；`package.json` 的正式版本号不因此改动。
- `compareVersions` 遵循 semver **预发布规则**（`1.0.1-nightly.x < 1.0.1`，数字标识 < 字母标识）。**勿改回「按 `.` 切分取前 3 段」的旧实现**——那会把预发布后缀丢掉，导致 nightly 永远检测不到。
- 渠道选择持久化于 `localStorage['hyperplayer:update-channel']`（默认 `stable`）。**设置页已无切换入口**（`SettingsPanel.tsx:462` 只读不写，注册表里也没有 `updateChannel` 条目）——旧文档声称「四种模式都能切换并互相同步」与代码不符，勿据此恢复控件。恢复切换属于产品决定，需同时改设置 UI、注册表与 README 说明。

## 版本号更迭机制

版本号唯一事实来源是 `package.json` 的 `version`（设置→关于页显示 `versionInfo.ts` `getVersionLabel()` 的结果，形如 `1.0.0「澜 おおなみ」 · 预览版`；"检查新版本"功能对比 GitHub tag 与本地 version）。

**版本号起点为 `1.0.0`**——本仓库自 1.0.0 起重新编号（减配 + 改名后的首个版本），此前的 0.x 记录已不再保留。使用 `scripts/bump-version.mjs` 自动更迭：

```bash
npm run version:patch   # 1.0.0 -> 1.0.1（修复）
npm run version:minor   # 1.0.0 -> 1.1.0（新功能）
npm run version:major   # 1.0.0 -> 2.0.0（破坏性）
npm run version:pre     # 1.0.0 -> 1.0.1-beta.0（预发布）
npm run version:dry     # 预览将要执行的操作（不落地）
```

脚本默认流程：更新 `package.json` + `package-lock.json`（顶层 `version` 与 `packages[""].version` **两处都改**，漏改会导致 `npm ci` 校验失败）→ commit `chore: bump version to vX.Y.Z` → 打 `vX.Y.Z` tag → push 分支与 tag。选项：`--no-commit` / `--no-tag` / `--no-push` / `--force`（工作区有未提交改动时默认拒绝，避免污染版本提交）。bump 后走发布流程：`npm run build:electron` → `gh release create`。

**版本标识唯一事实源**：`src/services/versionInfo.ts` 的 `VERSION_CHANNEL_LABEL`（当前为「预览版」）与 `getVersionLabel()`——关于页与文档都引用它，勿在别处写死标识文案。1.0 起代号统一为「澜 おおなみ」（`getVersionCodename`，`major >= 1`）。
