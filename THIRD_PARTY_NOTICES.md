# 第三方软件声明

HyperPlayer Rust 引擎自有代码采用 Apache-2.0 许可证。下列生产依赖保留其各自许可证与版权声明；完整许可证文本以对应发行包和上游仓库为准。

本清单由 `tests/check-js-licenses.mjs` 对 `pnpm licenses list --prod --json` 的结果执行名称覆盖校验。Rust 依赖由 `cargo-deny` 按 `deny.toml` 校验。

## HyperSoundEngine 专项授权

HyperPlayer 使用并修改 HyperSoundEngine v1.5.1（commit `f7017621b7d84005fbfed8a3c42a119487a17326`）中由 IceFireIcer 拥有权利的 DSP 核心、参数模型、预设、配置编码、规范和测试向量。该内容依据仓库根目录 `LICENSE-HSE-AUTHORIZATION.md` 的项目专项授权纳入 HyperPlayer，并随 HyperPlayer 以 Apache-2.0 分发。

> Portions derived from HyperSoundEngine v1.5.1, Copyright IceFireIcer, used under a project-specific authorization.

第三方素材、脉冲响应和 SOFA/HRTF 数据不包含在该专项授权内，只有在各自许可证完成审核后才可随应用分发。

## 图片素材

- `app/assets/shenzhen-skyline-night.jpg`：**“Shenzhen Skyline At Night”**，作者 Andreas Bunen，依据 [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/) 授权。原图来自 [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Shenzhen_Skyline_At_Night_(214551663).jpeg)。HyperPlayer 在天气卡中以 CSS 裁切并叠加暗色遮罩；图片本身不按 Apache-2.0 授权。

## HRTF 数据资产

- `assets/hrtf/mit-kemar-normal-pinna.sofa`：**MIT KEMAR 人工头 HRTF 数据集**（SOFA SimpleFreeFieldHRIR 转换版，710 空间位置，44.1 kHz 原生）。原始数据 **Copyright 1994 MIT Media Laboratory**，条款为 "provided free with no restrictions on use, provided the authors are cited"——允许任意用途与再分发，义务为引用作者。强制引用：Gardner, B., & Martin, K. (1994). *HRTF measurements of a KEMAR dummy-head microphone*. MIT Media Lab Perceptual Computing Technical Report #280。完整许可声明见 `third_party_licenses/MIT-KEMAR-HRTF.txt`，来源链与 hash 见 `provenance/hrtf-mit-kemar/README.md`。数据本身不按 Apache-2.0 授权，随应用分发时保留上述声明。

## DSP 算法参考

| 项目 | 许可证 | 用途 |
|---|---|---|
| DSPFilters（Vinnie Falco） | MIT | 双二阶滤波器 TDF2 状态机思路；HyperPlayer 实现按公开 RBJ 公式独立编写，未复制第三方源码 |

参考地址：https://github.com/vinniefalco/DSPFilters 。原项目的 MIT 许可与版权声明继续有效。

## Rust MIT / Apache-2.0 依赖

| 包 | 许可证 | 用途 |
|---|---|---|
| `crossbeam-queue` | MIT OR Apache-2.0 | CPAL 输出回调使用的预分配无锁有界帧队列 |
| `crossbeam-utils` | MIT OR Apache-2.0 | `crossbeam-queue` 的并发原语依赖 |
| `rustfft` 6.4.1 | MIT OR Apache-2.0 | HRTF 分区卷积 FFT |
| `primal-check` 0.3.4 | MIT OR Apache-2.0 | `rustfft` 传递依赖 |
| `strength_reduce` 0.2.4 | MIT OR Apache-2.0 | `rustfft` 传递依赖 |
| `transpose` 0.2.3 | MIT OR Apache-2.0 | `rustfft` 传递依赖 |
| `sofar` 0.3.0 | MIT OR Apache-2.0 | SOFA/HRTF 解析；默认 DSP 与重采样特性关闭 |
| `arrayvec` 0.7.8 | MIT OR Apache-2.0 | `sofar` 传递依赖 |
| `miniz_oxide` 0.8.9 | MIT OR Zlib OR Apache-2.0 | `sofar` HDF5 压缩支持 |
| `winnow` 0.7.15 | MIT | `sofar` 解析依赖 |

### sofar / libmysofa / KD-tree

`sofar` 0.3.0 is a Rust port of libmysofa. Its upstream NOTICE is reproduced below:

This software contains code derived from the libmysofa project.

libmysofa
---------
Copyright (c) 2016-2017, Symonics GmbH, Christian Hoene
Licensed under the BSD 3-Clause License
https://github.com/hoene/libmysofa

The following components are derived from libmysofa:

- HDF5 file format parser (`src/hdf/`)
- SOFA/HRTF algorithms (`src/sofa/`): spatial lookup, interpolation, coordinate conversion, loudness normalization, validation

The KD-tree implementation is based on work by:

Copyright (C) 2007-2011 John Tsiombikas <nuclear@member.fsf.org>
Licensed under BSD 3-Clause License

### V8 / fdlibm 三角函数实现

`crates/hyperplayer-hse-core/src/fft.rs` 中的 `ts_trig` 来自 V8 `14.1.146` 的 `src/base/ieee754.cc`，用于逐位复刻 JavaScript `Math.sin` / `Math.cos`。该实现包含 fdlibm 衍生代码与 Google/V8 修改，适用 V8 BSD 3-Clause 许可；完整许可与 fdlibm 声明见 `third_party_licenses/V8-BSD-3-Clause.txt`。

Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
Copyright 2016 the V8 project authors. All rights reserved.

V8 许可文本中的版权声明为：

Copyright 2006-2011, the V8 project authors. All rights reserved.

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
