# Independent Debug Pages

This file is the registry for standalone developer-only pages in the HyperPlayer repository. AI agents and developers must check this file before building a new visual debugging surface.

## Weather Lab

| Field | Value |
|---|---|
| Page | `weather-debug.html` |
| Local URL | `http://127.0.0.1:3210/weather-debug.html` |
| Start command | `npm run dev` |
| Source entry | `src/weather-debug/main.tsx` |
| Scenario factory | `src/weather-debug/scenarios.ts` |
| Styles | `src/weather-debug/debug.css` |
| Test | `test/weatherDebugScenarios.test.ts` |
| Production status | Development-only. Do not add this HTML file to Vite `rollupOptions.input`. |

### Purpose

Use Weather Lab to compare Apple-derived weather visuals before changing production weather code. It provides these local, API-free previews:

- Nine WMO weather categories: clear, partly cloudy, cloudy, fog, drizzle, rain, heavy rain, thunder, and snow.
- Day and night variants for every category.
- One full-screen Apple weather scene preview.
- Desktop `full` and `simple` weather card previews using the compact Apple renderer.
- A button that opens the real `WeatherDetailsModal` using only local mock data.
- A reduced-motion/static-frame toggle.

### Feedback Format

Use the visible scenario identifier when reporting a visual issue:

```text
scene=thunder-night: reduce rain density and darken the cloud base
scene=clear-day: move the sun farther right
card=full: improve temperature contrast
card=simple: increase hourly forecast readability
```

### Safety Rules

- Do not import `DesktopWidgetZone` or `WeatherWidget` into this page. They perform real weather and hazard refreshes.
- Keep all data in `scenarios.ts`; do not call Open-Meteo, Nominatim, location services, or hazard APIs from the page.
- Reuse the existing Vite `3210` server and open `/weather-debug.html`; do not start a second dev server.
- Keep this page outside production build inputs. It is a visual validation tool, not a customer-facing route.
- When adding another independent debug page, add a separate section in this registry with its URL, command, scope, source files, production status, and API/network constraints.

## MV Decode Probe

| Field | Value |
|---|---|
| Page | `mv-decode-test.html` |
| Local URL | `http://127.0.0.1:3210/mv-decode-test.html` (paste an audio URL into the input, or pass `?url=<encoded>` to auto-run; add `?rate=22050` to reproduce the app's detection sample rate — the page default is `12000`) |
| Start command | `npm run dev` |
| Source entry | `public/mv-decode-test.html` (single self-contained HTML file; no `src/<feature>-debug/` folder) |
| Styles | inline `<style>` in the same file |
| Test | None (manual probe; no scenario factory) |
| Production status | ⚠️ Intended as development-only, but it is **not excluded from production output**: the file sits in `public/`, which Vite copies verbatim into `dist/`, and `dist/**/*` is inside the electron-builder `build.files` whitelist. Moving or renaming it changes the packaged app; if it must stop shipping, relocate it out of `public/` rather than only un-linking it. |

### Purpose

Use MV Decode Probe to inspect the Bilibili MV / audio **music-start detection** chain outside the app. It fetches an audio URL (Bilibili DASH `.m4s` / mp3 / flac / m4a), decodes it with `decodeAudioData`, downsamples to mono with the same box-filter averaging as the app's `toMonoDownsampled` (the file notes that plain decimation changes the RMS statistics and therefore the `detectMusicStart` threshold behaviour), then computes the `frameRms` + `onset` envelopes (hop = 20 ms, frame = `max(2*hop, 1024)`) and writes a base64 JSON summary (`duration` / `frameRate` / `frameCount` / `rmsB64` / `onsetB64`) to `window.__decodeResult`, so the envelope can be compared against the app-side one produced by `src/services/autoMixAnalysisService.ts` (`toMonoDownsampled` / `detectMusicStart` / onset detection) and consumed by `src/services/mvAlignment.ts` (MV-to-song music-start alignment). No in-repo caller — open it by hand when MV alignment offsets look wrong.

### Safety Rules

- The page fetches whatever URL you paste, with no proxy and no SSRF guard. Treat it as a developer tool only: never point it at private/internal addresses and never promote it to a user-facing route.
- No backend or third-party API dependency — fetching, decoding and envelope maths all run inside the page.
- Output stays in memory (`window.__decodeResult` + `console.log`); nothing is persisted to disk or uploaded.
- The in-page downsample/onset maths is a hand-maintained copy of the app's detection path. When `autoMixAnalysisService.ts` changes, update this page too — a diverged probe yields misleading thresholds.

## Spatial Debug（HSE 空间音频独立预览）

| Field | Value |
|---|---|
| Page | `spatial-debug.html` |
| Local URL | `http://127.0.0.1:3290/spatial-debug.html`（`--serve-build` 模式为 `http://127.0.0.1:3291`） |
| Start command | `npm run preview:spatial`（独立 Vite 实例，**不要**与 `npm run dev` 的 3210 混用） |
| Source entry | `src/spatial-debug/main.tsx` |
| Styles | HSE 模块 `ui/hse-glass.css` + Tailwind（经 `scripts/spatial-preview.mjs` 的 `@tailwindcss/vite` 插件） |
| Test | None（手动预览；HSE 模块自身的 `src/spatial/test/` 与 `ui/**/*.test.*` 才是回归闸门） |
| Production status | Development-only. **不在** `vite.config.ts` 生产入口白名单（三入口），Vite 会原样拷贝根目录 `spatial-debug.html` 吗？——不会：该页由 `npm run preview:spatial` 的独立 config（`configFile: false`）服务，主 `vite build` 以 `rollupOptions.input` 白名单为入口，根目录多余 html 不会被构建。 |

### Purpose

用**独立 Host**（不经 HyperPlayer 播放器音频图）驱动 HSE 调音室与空间音频页面：内置测试音源/波形、独立 `HyperSoundEngineHost` 实例、`createHSEUiBridge` + `useHSEParams` 完整参数路径。用于在不播放歌曲的情况下调空间参数、对比 HRTF/房间预设、验证调音室 UI（亮色薄荷玻璃）与空间工作台交互。改 HSE 空间代码后先在这里快速肉眼验证，再回主程序实测。

### Safety Rules

- 页面桥是**独立预览写法**（`Object.assign` 包装桥对象 + 自带 `subscribeParams`），只服务预览——**勿照抄**到正式融合层（正式路径是 `attachHSE.ts` 的 submit 钩子）。
- 本页 worklet URL 是 `/hse-worklet.js`（绝对路径，dev server 语义）；主程序融合层用 `./hse-worklet.js`（file:// 相对语义），两者勿混。
- 无网络请求、无后端依赖；所有音频在页面内合成。
- 端口 3290/3291 为本页专属（避开 3210/3211 与 WaveForge 段 3000–3002）；`npm run check:ports` 的 REQUIRED 锚点不含这两个端口，但不要把 3290/3291 写进主链路。

## Adding A New Debug Page

1. Create a root `*-debug.html` entry and a dedicated `src/<feature>-debug/` folder.
2. Reuse the existing Vite dev server unless a feature truly requires a separate backend process.
3. Keep all data local or explicitly document allowed test APIs.
4. Add a focused test for the scenario/data factory.
5. Register the page in this document and link it from `AGENTS.md`.
6. Do not add it to production Vite inputs unless the product specification explicitly promotes it to a shipped feature.
