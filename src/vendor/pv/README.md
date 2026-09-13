# src/vendor/pv — PV Tool 移植引擎（HyperPlayer「PV」歌词模式）

本目录为 [pv-tool](https://github.com/DanteAlighieri13210914/pv-tool) 浏览器视觉特效引擎的移植副本，
用于 HyperPlayer「PV」歌词模式（`lyricDisplayMode: 'pv'`）。

## 授权说明

原作者 **DanteAlighieri13210914** 已明确授权本项目（HyperPlayer）**任意使用、修改、分发**
该引擎的代码与资产（含特效/模板）。原始 [LICENSE](LICENSE)（Non-Commercial License）随包保留，
作为第三方在本仓库之外取用代码时的约束基准。勿在本仓库内删除该版权与许可声明。

## 目录结构

- `core/` — 引擎核心：`engine.ts`（PixiJS 渲染循环/模板/后期滤镜/媒体层）、`types.ts`（数据结构）、
  `beatProvider.ts`（节拍强度）、`colorExtractor.ts`（封面取色）、`glitchFilter.ts`（毛刺滤镜）、
  `mediaOutline.ts`（媒体轮廓）、`motionDetector.ts`（运动检测，HyperPlayer 默认关闭）、
  `ccl.ts`（裂字特效的字形连通域分析）、`lrc.ts` / `srtParser.ts`（歌词解析）、`uiHelpers.ts`（UI 辅助）、
  `effectCatalog.ts` / `templateStore.ts`（特效目录/模板持久化）。
- `effects/` — **78 个** PixiJS 特效（背景/几何/线条/文字/覆盖层五类），互不依赖，注册于 `index.ts`（`grep -c "^register(" src/vendor/pv/effects/index.ts` = 78）。
- `templates/` — **31 个** PV 模板（TemplateConfig：调色板 + 特效组合 + 后期参数）。

## HyperPlayer 扩展（相对原版增量，隔离于模块内部）

- `types.ts`：`LyricLine` 增加可选 `words`（逐字绝对秒时间戳）/`translation`/`roman`；
  `UpdateContext` 增加可选 `wordProgress`（逐字演唱进度 0~1）/`translation`/`roman`。
- `engine.ts`：移除原版 Now Playing WebSocket 依赖（`nowPlayingProvider`）；新增
  `setBeats()`（注入真实节拍时间点）、`addEffect()`（系统级 overlay 特效挂载）、
  `getWordProgress()`（逐字进度计算）。
- `beatProvider.ts`：新增真实拍点数组模式，`getIntensity()` 优先按最近拍点指数衰减（精确踩点），
  无拍点时回退原内部节拍器/音频分析。
- `effects/wfLyricOverlay.ts`：HyperPlayer 专属卡拉OK式逐字高亮叠加特效（可携翻译/罗马音副文本），
  不修改任何原模板或原特效。

## 使用边界

- 本目录只被 `src/components/pvLyrics/PvLyricsPage.tsx` 使用；其余现存歌词模式（**现代 modern /
  沉浸 immersive / 看歌 video**，见 `src/App.tsx` 的 `ALL_LYRIC_MODES`）与本目录完全隔离。
- 修改引擎核心前请先运行 `npm run lint`，并跑 `npx vitest run test/pvLyrics.test.ts` 回归
  （PV 歌词的测试在 `test/pvLyrics.test.ts`，`src/components/pvLyrics/` 目录内没有测试文件）。