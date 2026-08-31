# 第三方软件声明

HyperPlayer Rust 引擎自有代码采用 Apache-2.0 许可证。下列生产依赖保留其各自许可证与版权声明；完整许可证文本以对应发行包和上游仓库为准。

本清单由 `tests/check-js-licenses.mjs` 对 `pnpm licenses list --prod --json` 的结果执行名称覆盖校验。Rust 依赖由 `cargo-deny` 按 `deny.toml` 校验。

## Rust MPL-2.0 依赖

HyperPlayer 使用下列 MPL-2.0 包：

| 包 | 许可证 | 用途 |
|---|---|---|
| `cssparser` | MPL-2.0 | Tauri 内部 HTML/CSS 解析 |
| `cssparser-macros` | MPL-2.0 | `cssparser` 的过程宏 |
| `dtoa-short` | MPL-2.0 | `cssparser` 的浮点数格式化 |
| `option-ext` | MPL-2.0 | Tauri 目录解析依赖 |
| `selectors` | MPL-2.0 | Tauri 内部 CSS 选择器解析 |
| `symphonia` | MPL-2.0 | MP3 探测与解码入口 |
| `symphonia-bundle-mp3` | MPL-2.0 | MPEG Audio Layer III 格式读取与解码 |
| `symphonia-core` | MPL-2.0 | 媒体流、音频缓冲与解码接口 |
| `symphonia-metadata` | MPL-2.0 | Symphonia 探测所需元数据支持 |

MPL-2.0 是文件级弱 copyleft。分发包含这些包的二进制时，HyperPlayer 将保留相应版权与许可证声明，并按 MPL-2.0 提供这些 MPL 文件及对其所作修改的源代码和许可证文本。HyperPlayer 自有源文件是独立作品，继续按 Apache-2.0 授权；链接、组合或使用上述包不会把 HyperPlayer 自有代码改为 MPL-2.0。

## JavaScript 生产依赖

| 包 | 许可证 |
|---|---|
| `@phosphor-icons/react` | MIT |
| `@tanstack/query-core` | MIT |
| `@tanstack/react-query` | MIT |
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@types/react` | MIT |
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
