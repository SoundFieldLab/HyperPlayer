# vendor/ — 第三方源码引入区

本目录存放**原样或定向适配**的第三方源码（不走 npm registry，随仓库分发）。
每个子目录一个来源，必须携带其原 LICENSE 文件并在根 `THIRD_PARTY_NOTICES.md`
登记，许可必须与 Apache-2.0 兼容（MIT/BSD/ISC/Zlib 等）。

## netease-cloudmusic-api

`@neteasecloudmusicapienhanced/api` **4.39.0**（registry tarball 原样展开，
仅删除 `public/` 文档网页）。NeteaseCloudMusicApi（Binaryify 原作者）的社区
维护分支，MIT。431 个端点模块 + `util/request.js` 传输层 + `generateConfig.js`
xeapi 密钥初始化。Tauri/WebView 适配（axios → tauri-plugin-http、fs 落盘 →
浏览器存储、移除 express 入口与 fs 模块自动发现）在接线阶段进行，改动以
`HyperPlayer adaptations` 注释标记，不回改上游。

## waveforge-lyrics

WaveForge 歌词体验的解析层与渲染层，经同一授权引入：

- `components/`：LyricsDisplay（主歌词页，逐字/翻译/音译）、GloriousLyrics、
  WallpaperLyrics、ModengPlayerPage、ProgressiveGlyphText、TranslationDisplay
- `utils/`：ttmlParser（TTML 逐字）、lyricWordTiming（逐字切分/时间归一）、
  lyricBoundaryParentheses（括号边界校正）、audio/playbackTimeStore、
  hooks/useAudioPulse

`musicApi.ts` 内嵌的 LRC/YRC 解析器与 getLyrics 多源聚合已随
`waveforge-netease/services/musicApi.ts` 引入。**未引入**（有意排除）：
`vendor/folia`（AGPL-3.0 不兼容，用户 2026-09-04 决定不接、删除）、
`vendor/pv`（PV 歌词引擎，授权对象为 WaveForge 本项目，未覆盖 HyperPlayer）、
FoliaLyricsPage/MultidimensionalLyrics/pvLyrics 全组组件、依赖
Folia 可读色的 `services/foliaReadableColor.ts`、Apple Music 歌词源
（appleMusic/appleAuth/appleApiBridge/appleWebService，不在本次引入范围）。

## waveforge-netease

WaveForge（https://github.com/SoundFieldLab/WaveForge ）项目中与网易云相关
的自有实现，经项目方授权引入（授权链见根 `THIRD_PARTY_NOTICES.md` 的
WaveForge 条目）。内容：

- `local-server.mjs`（10,760 行）：92 条 `/api/netease/*` 路由的自研业务逻辑
  ——重试/超时/缓存、`song/url` 音质降级候选循环、付费内容拦截、QR 登录
  透传。协议细节全部调用 vendored `netease-cloudmusic-api`。
- `services/`：浏览器侧前端服务（musicApi.ts 调用中枢、loginExpiry、
  audioQualitySettings、platforms、neteaseMusicJourney）。

**未引入**（有意排除）：`@unblockneteasemusic`（LGPL-3.0，产品红线禁用解灰/
跨平台匹配，连带 `song_url_match` 兜底路径一并废除）、`vendor/folia`
（AGPL-3.0，许可不兼容）、QQ/酷狗/汽水等其他平台代码。

WaveForge 与 HyperPlayer 均为 IceFireIcer 主导的项目；本次引入按用户
2026-09-04 指令执行，D15 Cleanroom 规则就此作废（WaveForge 代码直接入库）。
适配/接线在定调收口后统一进行。
