# 第三方软件声明

HyperPlayer 自有代码采用 Apache-2.0 许可证。下列生产依赖保留其各自许可证与版权声明；完整许可证文本以对应发行包和上游仓库为准。

本清单由许可证门禁脚本（M0 重建，对包管理器依赖清单执行名称覆盖校验）维护。除下列 Vendored 源码外，npm 生产依赖清单与 Tauri 壳的 Rust 依赖清单在 M0 重建后重新盘点并回填本文件。

## Vendored 源码

### HyperSoundEngine v1.5.1（vendor/HyperSoundEngine-v1.5.1-local）

HyperSoundEngine 纯 TS 完整包（引擎核心、浏览器宿主、规格与冻结向量、可选 React 工作台），来源 https://github.com/IceFireIcer/HyperSoundEngine ，IceFireIcer 自有项目，经仓库根 `LICENSE-HSE-AUTHORIZATION.md` 项目专项授权引入并随 HyperPlayer 以 Apache-2.0 分发。2026-09-05 引入时删除了 Rust 支线（`HyperSoundEngineRust/`），HyperPlayer 仅以纯 TS 接入。

> Portions derived from HyperSoundEngine v1.5.1, Copyright IceFireIcer, used under a project-specific authorization.

第三方素材、脉冲响应和 SOFA/HRTF 数据不包含在该专项授权内，只有在各自许可证完成审核后才可随应用分发。

### @neteasecloudmusicapienhanced/api 4.39.0（vendor/netease-cloudmusic-api）

网易云音乐协议客户端 vendored 源码：431 个端点模块、`util/request.js` 传输层、weapi/eapi/xeapi 加密实现。来源为 npm registry tarball（上游 https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced ，原作者 Binaryify/NeteaseCloudMusicApi），**MIT License**（完整文本见 `vendor/netease-cloudmusic-api/LICENSE`）。HyperPlayer 对其做定向适配（传输层改 tauri-plugin-http、fs 持久化改浏览器存储/stronghold、移除 Node 服务器入口），适配处以 `HyperPlayer adaptations` 注释标记，不回改上游。

### WaveForge（vendor/waveforge-netease、vendor/waveforge-lyrics）

网易云业务层（92 条路由的重试/缓存/音质降级/付费拦截逻辑与前端服务调用层）及歌词解析/渲染层（TTML 逐字解析、逐字时间归一、主歌词页及多模式歌词组件）源自 WaveForge 项目（https://github.com/SoundFieldLab/WaveForge ），经项目方授权引入 HyperPlayer 使用与分发。授权范围以 WaveForge 项目方书面授权为准；`src/vendor/folia`（AGPL-3.0）、`src/vendor/pv`（授权对象为 WaveForge 本项目）、`@unblockneteasemusic`（LGPL-3.0）及跨平台音源匹配路径未随本引入进入 HyperPlayer，也不得后续引入。`temp/netease-lyrics-code` 中的 folia 快照仅作只读参考，严禁拷入仓库。

## 红线

- 不引入 AGPL-3.0 组件（含 folia 及其派生代码）。
- 不引入 LGPL-3.0 的解灰/跨平台音源匹配（`@unblockneteasemusic`、`song_url_match` 路径）。
- 新增 vendored 来源必须先登记本文件并随包携带原 LICENSE。
