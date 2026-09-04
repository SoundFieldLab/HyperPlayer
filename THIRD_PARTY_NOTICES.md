# 第三方软件声明

HyperPlayer Rust 引擎自有代码采用 Apache-2.0 许可证。下列生产依赖保留其各自许可证与版权声明；完整许可证文本以对应发行包和上游仓库为准。

本清单由 `tests/check-js-licenses.mjs` 对 `pnpm licenses list --prod --json` 的结果执行名称覆盖校验。Rust 依赖由 `cargo-deny` 按 `deny.toml` 校验。

## Vendored 源码

### @neteasecloudmusicapienhanced/api 4.39.0（vendor/netease-cloudmusic-api）

网易云音乐协议客户端 vendored 源码：431 个端点模块、`util/request.js` 传输层、weapi/eapi/xeapi 加密实现。来源为 npm registry tarball（上游 https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced ，原作者 Binaryify/NeteaseCloudMusicApi），**MIT License**（完整文本见 `vendor/netease-cloudmusic-api/LICENSE`）。HyperPlayer 对其做定向适配（传输层改 tauri-plugin-http、fs 持久化改浏览器存储、移除 Node 服务器入口），适配处以注释标记，不回改上游。

### WaveForge（vendor/waveforge-netease、vendor/waveforge-lyrics）

网易云业务层（路由重试/缓存/音质降级/付费拦截逻辑与前端服务调用层）及歌词解析/渲染层（TTML 逐字解析、逐字时间归一、主歌词页及多模式歌词组件）源自 WaveForge 项目（https://github.com/SoundFieldLab/WaveForge ），经项目方授权引入 HyperPlayer 使用与分发。授权范围以 WaveForge 项目方书面授权为准；`src/vendor/folia`（AGPL-3.0）、`src/vendor/pv`（授权对象为 WaveForge 本项目）、`@unblockneteasemusic`（LGPL-3.0）及跨平台音源匹配路径未随本引入进入 HyperPlayer。

## HyperSoundEngine 专项授权

HyperPlayer 使用并修改 HyperSoundEngine v1.5.1（commit `f7017621b7d84005fbfed8a3c42a119487a17326`）中由 IceFireIcer 拥有权利的 DSP 核心、参数模型、预设、配置编码、规范和测试向量。该内容依据仓库根目录 `LICENSE-HSE-AUTHORIZATION.md` 的项目专项授权纳入 HyperPlayer，并随 HyperPlayer 以 Apache-2.0 分发。

> Portions derived from HyperSoundEngine v1.5.1, Copyright IceFireIcer, used under a project-specific authorization.

第三方素材、脉冲响应和 SOFA/HRTF 数据不包含在该专项授权内，只有在各自许可证完成审核后才可随应用分发。

## 图片素材

- `app/assets/shenzhen-skyline-night.jpg`：**“Shenzhen Skyline At Night”**，作者 Andreas Bunen，依据 [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/) 授权。原图来自 [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Shenzhen_Skyline_At_Night_(214551663).jpeg)。HyperPlayer 在天气卡中以 CSS 裁切并叠加暗色遮罩；图片本身不按 Apache-2.0 授权。

## Rust MIT / Apache-2.0 依赖

| 包 | 许可证 | 用途 |
|---|---|---|
| `crossbeam-utils` | MIT OR Apache-2.0 | Tauri 运行时（muda 菜单/托盘）传递依赖，并发原语 |

## Rust MPL-2.0 依赖

HyperPlayer 使用下列 MPL-2.0 包：

| 包 | 许可证 | 用途 |
|---|---|---|
| `cssparser` | MPL-2.0 | Tauri 内部 HTML/CSS 解析 |
| `cssparser-macros` | MPL-2.0 | `cssparser` 的过程宏 |
| `dtoa-short` | MPL-2.0 | `cssparser` 的浮点数格式化 |
| `option-ext` | MPL-2.0 | Tauri 目录解析依赖 |
| `selectors` | MPL-2.0 | Tauri 内部 CSS 选择器解析 |

MPL-2.0 是文件级弱 copyleft。分发包含这些包的二进制时，HyperPlayer 将保留相应版权与许可证声明，并按 MPL-2.0 提供这些 MPL 文件及对其所作修改的源代码和许可证文本。HyperPlayer 自有源文件是独立作品，继续按 Apache-2.0 授权；链接、组合或使用上述包不会把 HyperPlayer 自有代码改为 MPL-2.0。

## JavaScript 生产依赖

| 包 | 许可证 |
|---|---|
| `@phosphor-icons/react` | MIT |
| `@tanstack/query-core` | MIT |
| `@tanstack/react-query` | MIT |
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@types/react` | MIT |
| `animejs` | MIT（Julian Garnier，https://github.com/juliangarnier/anime ；用户 2026-09-04 定调引入，前端动画库补充） |
| `csstype` | MIT |
| `framer-motion` | MIT |
| `motion` | MIT |
| `motion-dom` | MIT |
| `motion-utils` | MIT |
| `react` | MIT |
| `react-dom` | MIT |
| `scheduler` | MIT |
| `tslib` | 0BSD |
| `zustand` | MIT |
