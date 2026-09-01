# hyperplayer-hse-core

本 crate 是 HyperPlayer 对 HyperSoundEngine DSP 核心的授权派生版本。

- 精确来源：HyperSoundEngine commit `f7017621b7d84005fbfed8a3c42a119487a17326`
- 来源路径：`HyperSoundEngineRust/crates/hse-core`
- 版本：`1.5.1`
- 许可：依据仓库根目录 `LICENSE-HSE-AUTHORIZATION.md` 的项目专项授权，以 Apache-2.0 条款用于 HyperPlayer

维护时应保留原模块结构、算法行为与测试；HyperPlayer 所需修改必须作为可审查的授权 fork 变更，不得混入上游 host、UI、service、WASAPI、N-API 或 WASM 代码。第三方素材、IR 与 SOFA/HRTF 数据集不在专项授权自动覆盖范围内，未经单独审计不得加入。

Portions derived from HyperSoundEngine v1.5.1, Copyright IceFireIcer, used under a project-specific authorization.
