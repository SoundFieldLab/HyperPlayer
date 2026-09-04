# ADR-0006：WebView 全链路播放与 TS 服务层（前端后端边界重定调）

---
status: accepted
date: 2026-09-04
supersedes: 0005-tauri2-react-rust.md 中的 NetEase Source 节、D29/D31/D33 的 DSP 边界、D15/D21 的网易云 Rust 迁移条款
---

定调 D34：HyperPlayer 的**播放、DSP、网易云协议、缓存治理全部移入 WebView 前端（TypeScript）**；Rust 退守本地曲库与桌面壳。此前「前端纯 UI、领域全在 Rust」的边界从未被正式定调，导致网易云与 HSE 形成 TS oracle + Rust 主实现的双轨平行维护，实际功能实现复杂度失控。本 ADR 一次性重定前后端边界。

## Why Now

- D21/ADR-0005 的「TS oracle 行为基准 → 最终迁入 Rust」路线已落地为约 1.5 万行网易云 Rust + 约 4.2 万行 HSE/DSP Rust，与 16k 行 TS 规范资产互为对拍，两套实现都需要维护——这是用户判定「实现成一坨狗屎」的结构性原因
- HSE v1.5.1 的 TS 实现自带 worklet（AudioWorklet 处理器）与 browser（Web Audio 宿主），本就是为浏览器实时链路设计；Rust 版反而是尚未融合播放器的独立实现，改造它去适配实时契约的成本高于直接用 TS 原生形态
- 网易云协议社区生态以 TS 为主；vendored `@neteasecloudmusicapienhanced/api`（MIT，4.39.0，431 端点）的加密层是纯 JS，浏览器可直接运行，只需传输与持久化两处适配
- 用户的维护能力与意愿集中在 TS（WaveForge 即 Electron+TS 项目）；Rust 领域面积越大，单人项目完工概率越低

## Architecture

### 前端（WebView2，运行时主体）

- **播放链（新）**：双源调度——本地完整数据（本地文件/整轨缓存）`decodeAudioData` + `AudioBufferSourceNode` 采样级调度（真 gapless）；流式在线播放 MediaElement + 预载快切（近似 gapless）。本地格式支持 = WebView2 原生格式集（MP3/FLAC/AAC/OGG/WAV），APE/DSF/DFF 明确不支持
- **DSP（新）**：`shared/hypersoundengine`（v1.5.1 完整 TS：core + worklet + browser + ui + specs），播放图内 AudioWorklet 实时处理。DSP 工作台 = HSE 自带 MixingStudio UI + HyperPlayer 皮肤（theme.ts 令牌统一、lucide→Phosphor），不大改 HSE UI 结构
- **网易云（新）**：`vendor/netease-cloudmusic-api`（协议核心，定向手术：axios→tauri-plugin-http、fs/os.tmpdir 落盘→浏览器存储、express 入口与 fs 模块自动发现→构建期静态枚举）+ `vendor/waveforge-netease`（路由业务逻辑与前端服务层模式）。Cookie/会话在浏览器侧；unblock 与跨平台匹配路径不引入
- **歌词**：`vendor/waveforge-lyrics`（LRC/YRC/TTML 解析 + 逐字时间轴 + 渲染组件成套接入）
- **产品规则（新）**：VIP fail-closed 门禁、专辑 5 会话晋升、缓存容量治理在 TS 服务层重写；强制力降档——JS 拦截可被绕过，威胁模型为「防误用不防故意」
- **分层**：`app/` UI 层（已按 UI 基线实现，原样保留）→ 分域 store（播放/曲库/网易云/DSP）→ 服务层（播放/网易云/DSP/缓存治理）→ vendored/shared 包

### Rust（约 1 万行）

- **`crates/hyperplayer-engine`**：仅本地曲库——repository（SQLite/rusqlite）、library、lofty 扫描、封面提取（ADR-0004 边界维持）
- **`src-tauri`**：壳层——窗口/托盘/SMTC/文件关联/生命周期/updater/打包/日志 + library commands 透传 + tauri-plugin-http 哑管道。command 面从约 160 剪到约 40
- **网络**：网易云请求经 `tauri-plugin-http`（fetch 形状，绕 CORS，Rust 侧无协议逻辑、无 Cookie 知识）

## Consequences

**收益**：
- 消灭双轨平行实现：网易云与 DSP 各只剩一份实现（vendored 包/完整 TS 拷贝）
- Rust 面积从约 9.5 万行缩到约 1 万行，单人可维护
- HSE/网易云回归其生态原生形态，蹭上游维护（协议包、HSE 演进）
- UI 基线与已验收壳层/曲库成果零损失

**代价（如实记录）**：
- 放弃 WASAPI 独占输出（走系统共享混音）
- 放弃 Rust ring buffer 采样级 gapless 的全场景覆盖（本地/整轨缓存场景用 AudioBuffer 调度拿回，纯流式场景为近似）
- 协议主权在 vendored 第三方代码里（MIT，notices 已登记；上游接口失效时需自行跟进）
- VIP 门禁等规则的强制力降档（JS 可绕过）
- Cookie/会话存浏览器侧，不再有 Rust DPAPI 保险库（按 D34.7 威胁模型接受）

## Cleanroom 与授权处置

- D15 Cleanroom 对网易云作废：WaveForge（https://github.com/SoundFieldLab/WaveForge ）代码经项目方授权直接入库，LICENSE/THIRD_PARTY_NOTICES 登记
- folia（AGPL-3.0）不接、删除；pv 歌词引擎（授权对象为 WaveForge）不搬；unblockneteasemusic（LGPL）及其跨平台匹配路径不引入
- HSE TS 拷贝沿用 `LICENSE-HSE-AUTHORIZATION.md` 专项授权（IceFireIcer 本人）；`provenance/hse-v1.5.1` Rust 双 manifest 校验体系随 Rust HSE 删除

## Relation to ADR-0005

壳（Tauri 2 + React/TS + WebView2）、曲库（ADR-0004）、拒 Node sidecar、打包更新方案不变。NetEase Source 节（TS oracle → Rust 终态迁移）与「引擎 crate 承担音频/DSP/WASAPI 输出」的边界被本 ADR 取代。
