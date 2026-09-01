# @hyperplayer/hse-ts-core

HyperSoundEngine v1.5.1 的纯 TypeScript DSP 核心副本，来源为：

- 源路径：`temp/hse-v1.5.1/`
- 源提交：`f7017621b7d84005fbfed8a3c42a119487a17326`

本包保留 DSP 算法、参数类型与默认值、场景预设、HSE2/旧版分享编码解码、空间音频算法及内部纯函数，用于 HyperPlayer 的行为 oracle、参数预览和诊断。

本包不是实时播放或 WASAPI 的权威实现。HyperPlayer 的实际播放与 DSP 权威归 Rust 音频引擎所有。

未包含 UI、浏览器宿主、Web Audio/AudioWorklet、WASM/service、离线分离、文件 I/O、宿主测试、Node sidecar、构建输出、包管理器缓存或第三方数据。

在 HyperPlayer 专项授权下按 Apache-2.0 使用。Portions derived from HyperSoundEngine v1.5.1, Copyright IceFireIcer, used under a project-specific authorization.
