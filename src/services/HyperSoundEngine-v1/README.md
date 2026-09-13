├── src/
│   ├── types.ts                        # 全部参数类型 + 默认值（v2 命名兼容）
│   ├── dsp/                            # 纯 DSP（零依赖，实时/离线共用）
│   │   ├── fft.ts biquad.ts EqChain.ts MidSide.ts
│   │   ├── Deesser.ts Compressor.ts Limiter.ts BassEnhancer.ts
│   │   ├── Convolver.ts ReverbSimple.ts LufsMeter.ts LoudnessComp.ts
│   │   ├── Resampler.ts Stretch.ts StretchLgplAdapter.ts PitchYin.ts features.ts
│   │   └── API_SPEC.md                 # 模块契约（子代理实现规范）
│   ├── engine/                         # 引擎总成
│   │   ├── EngineV3.ts ScenePresets.ts ShareCodec.ts builtinSceneSeed.ts
│   ├── spatial/                         # 第 15 级空间音频（纯 TS，EngineV3 内联调用，无 WASM/Rust）
│   │   ├── types.ts TsConvolverBackend.ts TimeConvolver.ts SpatialBackend.ts
│   │   ├── analyticHrtf.ts hrtfInterp.ts roomSim.ts ambisonics.ts
│   │   └── layouts.ts scenes.ts controller.ts keymap.ts ambienceMixer.ts + test/
│   ├── worklet/                        # AudioWorkletProcessor（融合时打包单文件）
│   ├── analysis/                       # 频谱分析、听力测试
│   └── offline/                        # 声源分离任务队列
├── ui/                                 # ★ HSE（HyperSoundEngine）风格调音室 UI
│   ├── V3MixingStudio.tsx              #   主面板：左侧导航 9 页（主页/音效场景/均衡器/空间音效/
│   │                                   #   空间音频/动态调音/分析/调音器/关于）+ 弹窗调度
│   ├── pages/                          #   9 个页面组件（含 SpatialAudioPage / AboutPage）
│   ├── hse-theme.ts                    #   深色琥珀金主题（useHSETheme + toLegacyTheme）
│   ├── components/                     #   Primitives + Badges（Hi-Res/DTS:X/Dolby Atmos）+ 空间页组件
│   ├── bridge.ts                       #   V3UiBridge（UI 与引擎的唯一接缝）
│   ├── hooks.ts / modalsSpatial / modalsDynamics / modalsLoudness
│   └── sharePanel.tsx / effectsPanel.tsx / eqCurveEditor.tsx
├── vendor/soundtouchjs/                # ★ LGPL-2.1 原包副本（含 LICENSE；未安装未链接）
├── test/ + ui/ + src/spatial/test/     # vitest 单测（45 文件 = 29 + 8 + 8）
│                                       # 全仓口径（2026-09-13 实测）：140 文件 = 139 过 + 1 跳过 /
│                                       # 1269 用例 = 1264 过 + 5 跳过 + 0 todo（LGPL 可选依赖未装时自动跳过）
└── docs/
    ├── FUSION_GUIDE.md                 # ★ 融合文档（已完成；操作记录）
    ├── UI_GUIDE.md                     # ★ 调音室 UI 指南（HSE 9 页导航现状）
    ├── FEATURES_VERIFICATION.md        # ★ 功能核验报告（27 项功能 / MIT·LGPL 统计 / 候选库调研）
    └── v2-analysis.md                  # v2 模块深读分析（子代理产出）

> 本模块**没有自己的 `package.json`**（已并入 HyperPlayer）：测试走仓库根 `npm run test`，
> worklet 打包走仓库根 `npm run build:v3-worklet`。
