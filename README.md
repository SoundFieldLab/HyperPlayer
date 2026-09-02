# HyperPlayer

基于 Tauri 2、React/TypeScript 与 Rust 音频引擎的现代化 Windows 音乐播放器。

项目处于全量实现阶段。实际播放和实时 DSP 由 Rust 引擎负责；HyperSoundEngine v1.5.1 的 vendored Rust core 是唯一生产 DSP 算法主实现。`shared/hse-ts-core` 保留为参数、12 个场景、HSE2、预览、离线诊断和 parity 的控制面实现，不接管实际音频输出。

当前已经接通 14 个生产处理器、DspPort、12 个 HSE scenes、HSE2 的 14-stage 投影、原生 DSP 工作台和 HPTM v2 telemetry。Stage 13、15–18、20–22 尚未进入生产播放链。D30 已完成 schema v7 和核心策略层，runtime worker、资源探测及 Settings 策略 UI 仍待接线。详细事实状态见 [handover.md](./handover.md)。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 直接启动 Tauri 2 与系统 WebView2。项目不提供独立浏览器预览，也不包含运行时 mock bridge；界面、IPC 与桌面行为统一在真实 Tauri 窗口验证。

完整构建使用 `pnpm build`，会生成 Windows x64 NSIS 与 MSI 安装包。常用验证命令：

```bash
pnpm test
pnpm frontend:build
pnpm exec tsc -p tests/oracle-tsconfig.json --pretty false
pnpm check:hse-ts
pnpm check:hse-destination
```

Rust 的 fmt、Clippy、测试和许可证门禁见 [验收矩阵](./tests/ACCEPTANCE_MATRIX.md)。

## License

Copyright 2026 IceFireIcer。

HyperPlayer 使用 [Apache License 2.0](./LICENSE) 许可；HSE 专项授权见 [LICENSE-HSE-AUTHORIZATION.md](./LICENSE-HSE-AUTHORIZATION.md)，附加归属信息见 [NOTICE](./NOTICE)。
