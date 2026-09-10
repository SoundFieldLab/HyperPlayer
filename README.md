# WaveForge 澜音工坊

沉浸式桌面音乐播放器（Windows / Electron），共 **5 个音源**：**网易云音乐 / QQ音乐 / Apple Music / Spotify** 四个平台 + **B站看歌**。覆盖搜索、播放、歌词、可视化、无缝衔接、桌面模式与自定义壁纸。仓库同时含 **Apple 歌词/探索**分支。

> 本仓库为**减配版（slimdown）**：已移除 Android TV、Python 节拍/响度/补偿服务、汽水与酷狗音源、音效引擎 v1/v2、Folia/多维 Diorama 等歌词模式、DG_LAB 插件、AirPlay / 分轨 / 远程遥控 / 设备授权 / 爱发电 / Smart AutoMix 等模块。功能以本文档与源码为准。

## 快速开始

```bash
npm install                    # 安装依赖
npm run dev:electron           # 一键启动：Vite(3000) + API(3001) + Electron 窗口
```

- 后端为单文件 Express（`local-server.mjs`，端口 3001），由 `dev:electron` 自动拉起；也可直接 `node local-server.mjs` 单独启动（无 `dev:api` 脚本）。
- Apple Music 播放面需要**系统 Python + pywebview** 运行 `python-apple-bridge/apple_bridge.py`（端口 18790），由主进程自动探测并 spawn；仅 Apple 原生播放路径依赖它，其余音源与功能不受影响。

## 核心功能

- **多音源搜索与推荐**：网易云 / QQ / Apple Music / Spotify 实时搜索、每日推荐、榜单、猜你喜欢；平台可见性与顺序可自定义
- **B站看歌**：B站 MV / 视频作为歌词模式播放，含弹幕、互动面板、MV 背景
- **QQ 音乐 API Key 领取**：内置引导窗口直达 y.qq.com 领取 qmk API Key（独立隔离 session，每次打开清空登录态）
- **无缝衔接播放**：`Fixed Crossfade`（固定时长交叉淡化，默认）+ gapless 直接拼接 + 专辑无缝（albumGapless），双 deck 等功率淡入淡出
- **歌词系统**：LRC 解析、逐字歌词（QQ / Apple TTML）、实时滚动、点击跳转、翻译与罗马音；**4 种歌词模式**：现代 / 沉浸 / 看歌(B站) / PV
- **桌面歌词**：独立透明窗口（`desktop-lyrics.html`），字体、字号、配色可调，经 IPC 持久化
- **音效引擎 HSE（HyperSoundEngine）**：唯一引擎，14 级处理链 + 11 场景 + 分享串
- **空间音频**：合成解析 HRTF 双耳渲染四模式（一键空间化 / 头锁定环绕 / 世界漫游 / 舞台影院），详见下方
- **可视化**：实时频谱（对数频率轴）、波形、封面脉动、动态封面（Apple）
- **桌面模式与小组件**：桌面小组件区、自定义壁纸、天气系统、桌面播放器小窗、任务栏播控条
- **插件宿主**：App Store 式插件中心（卡片/详情/导入/卸载、开关持久化、使用须知门控），内置 **Razer Chroma** 与 **SignalRGB** 灯光联动插件——第三方插件开发见 [docs/plugin-development.md](./docs/plugin-development.md)
- **社交/个人中心**：QQ/网易云关注与粉丝、查看他人主页、评论、歌单管理、私人 FM
- **法律协议**：内置《法律声明与用户协议》弹窗（`src/components/legal/LegalAgreement.tsx`，简体中文单语，完整保留含免责条款在内的全部条款）
- **缓存系统**：IndexedDB（封面双缓冲、歌单缓存、免闪切换）

## 技术架构

```
前端:    React 19 + TypeScript + Tailwind CSS 4 + Vite 6
桌面:    Electron 42（主进程 CommonJS，preload 桥接）
后端:    Node.js + Express（local-server.mjs，单文件，端口 3001）
音频:    Web Audio API + HSE（纯 TS DSP 内核 + AudioWorklet 渲染线程）
音乐源:  qq-music-api + NeteaseCloudMusicApiEnhanced + Apple Music + Spotify + B站
可视化:  Canvas/Web Audio 频谱与封面动效；空间音频 3D 视图用 Three.js + React Three Fiber
多平台:  Apple 歌词/探索分支（src/components/Apple*，src/services/apple*）
```

```
WaveForge/
├── src/                        # React 前端
│   ├── components/            # 组件（App.tsx 懒加载；Apple* 为 Apple 分支）
│   ├── services/              # API 客户端、缓存、无缝衔接、apple* 服务
│   │   ├── audio-engine/      # 引擎适配层（V3Adapter + 注册表）
│   │   ├── gapless/           # 无缝衔接（私有模块）
│   │   └── waveforge-engine-v3/   # HSE 音效引擎（DSP + UI + 空间音频）
│   ├── audio/                 # 播放引擎（队列/过渡计划/渲染器）
│   ├── hooks/  api/  utils/  types/  vendor/pv/
├── desktop/                   # Electron 主进程 + preload（.cjs）+ splash/任务栏小窗
├── server/                    # 后端附加路由（hazard/location/bilibili/apple-artwork）
├── local-server.mjs           # Express 后端（约 11k 行，单文件，端口 3001）
├── python-apple-bridge/       # Apple Music 播放面 bridge（Python，端口 18790）
├── build/                     # 打包资源 + 自定义 NSIS 安装器 UI 资产
└── scripts/                   # dev/build/打包/发布/测试脚本
```

## 开发命令

```bash
npm run dev:electron    # 完整开发（前端+后端+Electron）
npm run dev             # 仅 Vite（3000）
npm run lint            # TypeScript 类型检查（tsc --noEmit）
npm run test            # vitest 单测（145 文件 = 144 过 + 1 跳过；1292 用例 = 1286 过 + 5 跳过 + 1 todo，含 HSE v3 引擎与空间音频）
npm run build           # 仅构建前端 -> dist/（三入口，不生成 EXE）
npm run build:electron  # 发布：目录构建 → EVS production VMP → NSIS 安装包
npm run build:electron:dir           # 发布目录包：构建 + EVS production VMP
npm run build:electron:dir:unsigned  # 仅本地诊断，不能发布
npm run build:v3-worklet   # 重生成 HSE 的 AudioWorklet 单文件（predev/prebuild 自动执行）
npm run build:apple-weather # 重新生成 Apple 天气场景资源
npm run test:chroma     # Razer Chroma 插件自测
npm run test:signalrgb  # SignalRGB 插件自测
npm run test:desktop    # 桌面/安全相关 node --test 用例
npm run test:installer  # 生成安装器 UI 资产 + 安装器测试
npm run preview:setup   # 预览自定义安装器
npm run version:patch|minor|major|pre  # 版本号更迭（自动 commit/tag/push）
```

`npm run dev:electron` 启动前会快速验证开发 ECS 的 production streaming VMP；签名仍有效时不会重签。只有首次配置、重装或升级 Electron 后才会请求一次 EVS 签名，前端热更新与普通 `npm run build` 不生成 EXE、也不触发签名。开启应用级开发者模式后，可在"开发者选项"查看 VMP 剩余有效天数；剩余不超过 180 天时界面会提示安排续签。

## 发布（GitHub Releases）

**只发 NSIS 安装版**（`release/WaveForge-<version>-Setup.exe`），**不发便携版**（`release/win-unpacked/` 仅本地调试）。安装版为每用户安装、**不携带任何用户数据/配置**——首次运行在该机 `%APPDATA%\WaveForge 澜音工坊\` 自动生成全新配置并适配当前用户。

```bash
npm run build:electron          # 构建安装版（强制 EVS production VMP）
git tag v<version> && git push origin v<version>
gh release create v<version> release/WaveForge-<version>-Setup.exe --title "v<version>" --notes "..."
```

Windows 发布机/CI 必须配置 `EVS_ACCOUNT_NAME`、`EVS_PASSWD` 并安装 `castlabs-evs`。签名发生在构建机，正式构建要求 production streaming VMP 至少剩余 30 天，并将无敏感信息的有效期元数据写入安装包；低于门槛或签名无效会直接阻断发布。最终用户安装后**不需要 EVS、签名工具或任何手动签名步骤**；Apple Music 用户只需在应用内登录具有有效订阅的账号。CI：`.github/workflows/ci.yml`（类型/单测/构建 + tag 出包）、`nightly.yml`（每日 nightly 预发布）。

## 端口一览

| 端口 | 服务 | 说明 |
|---|---|---|
| 3000 | Vite / 生产 preview | 前端（后端 CORS 白名单） |
| 3001 | Express API | 后端（绑定 127.0.0.1，仅放行 localhost:3000 / file:// / null） |
| 18790 | Apple Music Python bridge | 播放面 bridge（需系统 Python + pywebview） |

> 历史上的 3002 / 3003 / 3004（Python 节拍 / 响度 / 频响补偿服务）已随减配移除，不再使用。

## 音效引擎 HSE（HyperSoundEngine）

当前唯一音效引擎（代码标识符仍为 v3：`src/services/waveforge-engine-v3/`）。纯 TypeScript DSP 内核，与引擎适配层 `src/services/audio-engine/` 配合，`V3Adapter` 以 `studioMode: 'custom'` 渲染 HSE 调音室。

- **处理链（14 级固定顺序）**：响度归一化增益 → 3D 环绕（轻量立体声旋转） → M/S（立体声宽度 + 人声比例） → Pre-EQ（用户 EQ） → Deesser → Compressor → NightMode（压缩增强 + 6kHz 高频衰减） → 混响（卷积/算法/off 三路） → BassEnhancer → LoudnessComp（等响度补偿） → IEQ（Post 智能均衡） → LUFS 采样点 → Limiter → 输出；**第 15 级为空间音频**（见下节）。LUFS 采样点严格位于 Limiter 之前。
- **11 个内置场景**：pop / enhanced / jazz / dance / classical / livehouse / studio / warm / dts / vocal-stage / night-bass（快照式，一键整体应用；音量独立于场景，不被覆盖）
- **均衡器**：简约 5 段 / 专业 10 或 20 段 + 级联 Q 补偿
- **低音增强含「低音下潜」**：`lowBoostDb` -6..+12dB 真实低频能量提升（lowshelf 语义），谐波路径另提供心理声学感知
- **分享串**：版本 + 校验 + 白名单防注入，编解码覆盖含低音下潜在内的全部参数
- **分析页**：对数频率轴实时频谱（32 条，20Hz-20kHz，FFT 幅度按 dBFS 归一化）+ LUFS / 增益缩减 / 频谱特征 + 听力测试；100ms 轮询 + EMA 平滑
- **调音室音量**：走 `loudnessNormalization.externalGainDb` 通道（0-100% → -60..0dB），80ms 快平滑跟手
- **响度归一化与频响补偿在引擎内实时实现**（`LufsMeter` / `LoudnessComp` DSP 模块），不依赖任何外部服务
- **导出**：离线 MP3 导出（解码 PCM → `EngineV3.process` 分块 → lamejs 128kbps）
- **渲染线程**：`EngineV3Host` 模式 `auto` —— AudioWorklet 优先（`public/v3-worklet.js`，`npm run build:v3-worklet` 生成），失败回退 ScriptProcessor；参数在 worklet 模式下双下发，统计优先取 worklet 周期回传值
- **开发者模式**：关于页开关开启后，「音效场景」页可实时微调内置场景并保存为参数覆盖层，支持还原出厂、场景库 JSON 导出/导入；「写回发布种子」经 IPC 写入 `src/services/waveforge-engine-v3/src/engine/builtinSceneSeed.ts`，commit/push 后全员生效
- **调音室 UI**：左侧导航 9 页（主页 / 音效场景 / 均衡器 / 空间音效 / 空间音频 / 动态调音 / 分析 / 调音器 / 关于）+ 深色琥珀金主题

**许可红线**：HSE 模块自带 [LICENSE](./src/services/waveforge-engine-v3/LICENSE)（CC BY-NC-ND 4.0）、[授权补充说明.md](./src/services/waveforge-engine-v3/授权补充说明.md) 与 `THIRD_PARTY_NOTICES.md`，勿删改。

## 空间音频（Spatial Audio）

空间音频是 **EngineV3 的第 15 级处理**（纯 TypeScript，内联调用 `src/spatial/*` 纯模块），不是独立 AudioWorklet 节点，也无 WASM/Rust 后端；`mode='off'` 时完全旁路、逐位不触碰 L/R。参数属于 `V3EngineParams.spatial`，随 `waveforge:v3-params` 快照持久化。四种模式：

- **A 一键空间化**：立体声展开为 ±30°（20..120° 可调）虚拟扬声器，干湿混合强度 / 房间模拟预设 / 房间混响可调
- **B 头锁定环绕**：5.1 / 5.1.4 / 7.1 / 7.1.4 / 自定义布局预设 + 环形拖拽编辑器（上限 16 只扬声器）+ 逐扬声器声源路由（L / R / both），声场固定于头部朝向（耳机听感）
- **C 世界漫游**：3D 视图 + 键盘移动、鼠标拖拽转头，支持多普勒、声源轨迹关键帧（按播放时钟线性插值）、遮挡/衍射简化模型（增益衰减 + 高频低通）
- **D 舞台/影院**：4 场景预设（音乐舞台 / 电影院 / 钢琴独奏 / 自然场景）+ 座位选择 + 房间大小 / 氛围混响调节

**核心能力**：

- **合成解析 HRTF** 双耳渲染（`analyticHrtf.ts`），无需外部数据文件
- **双 HRTF 插值模式**：最近邻网格查表 与 实球谐插值（L=3 实球谐基 + 最小二乘拟合，`hrtfInterp.ts`）
- **完整房间模拟**：镜像声源法早期反射（1-3 阶）+ FDN 晚期混响（8 条质数延迟线 + Hadamard 8×8 反馈矩阵），7 种预设（录音棚/音乐厅/舞台/教堂/户外/浴室/走廊）
- **Ambisonics 环境上混**（FOA 一阶实球谐编解码，`ambisonics.ts`）
- **多声道输入自动映射**（`processMulti`）与**输出模式**（binaural / stereo / multichannel）
- **分区 FFT 卷积 与 时域直接卷积 双模式**（`TsConvolverBackend` / `TimeConvolver`，两者干湿对齐一致、脉冲位置一致）
- **三道爆音防护**：湿总线能量归一化、IR 重装载淡变、标量增益一阶平滑

## 已知限制

1. 部分歌曲因版权/VIP 无法播放（未登录可播免费曲）
2. 歌词第三方源（lrclib / amll-ttml-db）部分歌曲无词，属正常
3. 首次播放网易云高音质需后端启动时联网拉取 xeapi 公钥（已自动化）
4. Apple Music 原生播放依赖 18790 Python bridge（需系统 Python + pywebview）；不可用时走 Web 回退路径
5. QQ 他人歌单/我喜欢歌曲/评论回复/听歌排行受平台限制；QQ 关注/粉丝接口必须用最新登录的 `qm_keyst`
6. 过渡策略恒为 Fixed Crossfade（智能节拍混音已随减配移除），节拍分析能力仅用于 MV 对齐等场景

## 文档

- [AGENTS.md](./AGENTS.md) — 给 AI 代理的项目指令（必读）
- [docs/功能清单2.0.md](./docs/功能清单2.0.md) — 减配后功能清单（按代码实测，含证据与红线）
- [HANDOVER.md](./HANDOVER.md) — 交接文档（环境 / 端口 / 已知问题 / 历史决策）
- [CONTEXT.md](./CONTEXT.md) — 音效域词汇表（术语定义，已按 HSE 单引擎现状更新）
- [docs/adr/](./docs/adr/) — 架构决策记录
- [PRIVATE-LICENSE.md](./PRIVATE-LICENSE.md) — 私有模块许可（无缝衔接 / 看歌MV / 桌面模式 / 探索模式 / Apple 接入）
- [DEBUG_PAGES.md](./DEBUG_PAGES.md) — 独立调试页注册表（Weather Lab 等）
- [docs/plugin-development.md](./docs/plugin-development.md) — 插件开发文档（公开，供开发者与 AI 编写 WaveForge 插件）
- [docs/歌词对比-LyricsBlossom.md](./docs/歌词对比-LyricsBlossom.md) — Apple Music 歌词逆向对比（Apple 逐字模式）
- [src/services/waveforge-engine-v3/docs/](./src/services/waveforge-engine-v3/docs/) — HSE 融合/UI/算法文档

## 许可证

MIT。

**私有模块**：无缝衔接（Gapless）、看歌 / MV 背景（Bilibili）、桌面模式、探索模式、Apple Music
接入等模块以 **WaveForge 私有模块许可**提供（非 MIT），适用范围与使用限制详见
[PRIVATE-LICENSE.md](./PRIVATE-LICENSE.md)（受保护文件头部 / 目录 `LICENSE.private` 亦标注）。
HSE 音效引擎模块另受 CC BY-NC-ND 4.0 约束，见 [src/services/waveforge-engine-v3/LICENSE](./src/services/waveforge-engine-v3/LICENSE)。
