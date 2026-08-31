# HyperPlayer

基于 Tauri 2、React/TypeScript 与 Rust 音频引擎的现代化 Windows 音乐播放器。

项目现已进入全量实现阶段。DSP 暂只保留管线插入点、透明旁路契约和禁用入口，具体效果与参数等待产品规格。

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
```

Rust 的 fmt、Clippy、测试和许可证门禁见 [验收矩阵](./tests/ACCEPTANCE_MATRIX.md)。

## License

Copyright 2026 IceFireIcer。

HyperPlayer 使用 [Apache License 2.0](./LICENSE) 许可；附加归属信息见 [NOTICE](./NOTICE)。
