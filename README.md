# HyperPlayer

基于 Tauri 2 壳 + 全 TypeScript 的现代化 Windows 桌面音乐播放器。

项目处于**从 0 重建阶段**（2026-09-05 推倒重来）。工程事实源与里程碑见 [docs/架构基线.md](./docs/架构基线.md)；模块/状态机/保险机制细化见 [docs/播放器架构.md](./docs/播放器架构.md)；设计语言见 [docs/设计语言-apple.md](./docs/设计语言-apple.md)；统一语言见 [docs/CONTEXT.md](./docs/CONTEXT.md)；UI 决策记录（含 UI-D81+ 修订条目）见 [docs/UI定调决策记录.md](./docs/UI定调决策记录.md)。

## 核心形态

- **Tauri 2 壳，零自定义 Rust**：仅官方/社区插件与配置（dialog/fs/http/store/sql/stronghold 等）
- **全 TS 应用层**：React 19 + Vite + Tailwind 4 + shadcn/Radix + Motion + zustand 域切片
- **音频/DSP**：HyperSoundEngine v1.5.1 纯 TS（vendored，Rust 支线已删除），经浏览器宿主 AudioWorklet 接入；14+ 处理器、12 场景、空间音频
- **双内容域**：网易云（默认）+ 本地曲库；播放队列跨域共享
- **音频流落盘缓存 v1 即做**：公共播放缓存 + 账号权益缓存（SQLite 索引 + 容量淘汰）
- **vendored**：netease-cloudmusic-api 4.39.0（MIT）、waveforge-netease / waveforge-lyrics（授权引入）、HyperSoundEngine（专项授权）
- **设计语言**：Apple 人格——内容穿底半透明 chrome、流体弹簧动效、8/18/pill 圆角语法、Apple 中性板；Hyper Blue / Pulse Orange 双色与 LOGO 不变

## 里程碑

M0 行走骨架 → M1 本地曲库 → M2 播放层 → M3 网易云 → M4 DSP 工作台 → M5 队列/停靠/设置 → M6 发布（SMTC/更新/安装包）。

每个里程碑在真实 Tauri 窗口可运行、可验收后再进入下一步。开发命令随 M0 落地补充。

## License

Copyright 2026 IceFireIcer。

HyperPlayer 使用 [Apache License 2.0](./LICENSE) 许可；HSE 专项授权见 [LICENSE-HSE-AUTHORIZATION.md](./LICENSE-HSE-AUTHORIZATION.md)，第三方归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [NOTICE](./NOTICE)。
