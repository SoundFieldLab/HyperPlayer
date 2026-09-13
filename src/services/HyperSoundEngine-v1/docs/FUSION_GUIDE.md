# FUSION_GUIDE —— 把 HyperSoundEngine-v1 融合进 HyperPlayer（手把手版）

> 本文件写给**执行融合的另一个 AI**：按步骤操作即可完成融合与验证。
> ✅ **融合已完成（2026-08-16/17）**：模块现位于 `HyperPlayer/src/services/HyperSoundEngine-v1/`，
> 经 `attachV3Engine.ts` 融合层 + 统一适配层（`src/services/audio-engine/V3Adapter.tsx`）接入，
> 调音室 UI 为 HSE 风格 9 页导航（2026-09-13 校正）。以下步骤保留作操作记录。
> 本模块是**为 HyperPlayer 设计的下一代音频引擎 v3**（非 HXAudio 原版引擎），独立开发、
> 已通过全量验证：模块内 45 个测试文件（`test/` 29 + `ui/` 8 + `src/spatial/test/` 8）；
> 全仓 vitest 口径 **140 文件 = 139 过 + 1 跳过 / 1269 用例 = 1264 过 + 5 跳过 + 0 todo**（2026-09-13 实测）、两轮深度审计（12 类问题已修复）。
> v2 与 v3 是完全独立的两个引擎：**不做 API 兼容层、不做字段级迁移**——切换只保证
> "音频能正常切到 v3 处理"（用现成的 `EngineV3Host` 接线模块）。

> 依据文档（融合前请通读）：
> - `docs/v2-analysis.md`（HyperPlayer v2 模块深读：API 面、链顺序、集成点）
> - `docs/FEATURES_VERIFICATION.md`（功能核验：27 项有效功能 / MIT·LGPL 统计）
> - `docs/audit/SUMMARY.md`（审计总结：修复的 12 类问题与确认正常的项）
> - `src/dsp/API_SPEC.md`（模块契约）；`docs/音频算法设计文档.md`、`docs/音频算法技术文档.md`（算法原理与设计）

---

## 0. 先决条件：先验货，再动手

**本模块已并入 HyperPlayer，没有独立 `package.json`**；下列命令均在**仓库根目录**执行：

```bash
npm run test         # 必须全绿（LGPL 可选依赖未安装时相关用例自动跳过）
npm run lint         # tsc --noEmit，必须 0 错误
```

预期口径（2026-09-13 实测）：全仓 vitest `Test Files 140（139 过 + 1 跳过）`、
`Tests 1269（1264 过 + 5 跳过 + 0 todo）`、`tsc` 0 错误。
若未全绿：**停止融合**，先修 v3 侧问题（或回退到本模块的上一提交），不要带病融合。

目录速览（融合只动 HyperPlayer 侧 4 处：见步骤 1-4）：

```
HyperSoundEngine-v1/
├── src/
│   ├── types.ts                  # 参数模型 V3EngineParams（含默认值 createDefaultParams）
│   ├── dsp/                      # 16 个纯 DSP 模块 + LGPL 适配层（零依赖）
│   ├── engine/EngineV3.ts        # 引擎总成（14 级主链 + 第 15 级空间音频内联，实时/离线共用）
│   ├── engine/ScenePresets.ts    # 11 组合场景（SCENE_PRESETS）
│   ├── engine/ShareCodec.ts      # 分享串（encodeShareCode/decodeShareCode）
│   ├── spatial/                  # ★ 第 15 级空间音频（纯 TS：TsConvolverBackend / TimeConvolver）
│   ├── integration/EngineV3Host.ts  # ★ 切换接线模块（见步骤 2）
│   ├── worklet/AudioEffectsProcessor.ts  # AudioWorklet 处理器（需打包，见步骤 3）
│   ├── analysis/ offline/ index.ts
├── attachV3Engine.ts             # ★ HyperPlayer 融合层
├── vendor/soundtouchjs/          # LGPL-2.1 原包副本（含 LICENSE；未安装未链接）
├── test/ + ui/ + src/spatial/test/    # 45 个测试文件（仓库根 npm run test 执行）
└── docs/                         # FUSION_GUIDE / FEATURES_VERIFICATION / v2-analysis / audit/
```

---

## 1. 安全边界（融合时必须遵守）

1. **不要读**：`decompiled/`、`business-code/`、`apktool-out/`、`docs/`（逆向分析产物，另一对话的工作区）。
2. **v1 引擎**（`HyperPlayer/src/services/audioEffects/`）与 **v2 引擎**（`HyperPlayer/src/services/audio-effects-v2/`）
   在 v3 验证通过前**保持原样**；切换走现有 `src/services/audioEngineVersion.ts` 机制加 'v3' 分支。
3. **HyperPlayer/src/services/audio-effects-v3/** 是另一个对话正在进行的旧 v3 实现——
   融合前先与该对话协调：**并存 → 验证 → 替换**（推荐），或确认后直接替换。
4. v3 内部算法**不要改动**（如需修改先跑仓库根 `npm run test` + `npm run lint`）；融合只做接线。
5. **v2 与 v3 相互独立**：不做兼容层、不做字段迁移；v3 用自有 `V3EngineParams` 模型。

---

## 2. 融合步骤

### 步骤 1：落位源码

**方案 A（并存，推荐）**：把 `HyperSoundEngine-v1/src` 与 `vendor` 整体复制为
`HyperPlayer/src/services/HyperSoundEngine-v1/`：

```bash
# 在 HyperPlayer 仓库根目录执行
mkdir -p src/services/HyperSoundEngine-v1
cp -r <v3路径>/src/* src/services/HyperSoundEngine-v1/
cp -r <v3路径>/vendor src/services/HyperSoundEngine-v1/
```

测试迁入（二选一，避免与 HyperPlayer 既有测试重名）：
- 把 `test/` 复制为 `HyperPlayer/test/v3/`（vitest include 已含 test/ 时直接生效），或
- 在 `HyperPlayer/vite.config.ts` 的 test.include 追加 `test/v3/**/*.test.ts`。

**方案 B（替换）**：与另一对话确认后，用本模块替换 `HyperPlayer/src/services/audio-effects-v3/`。

### 步骤 2：引擎切换接线（核心，只改 HyperPlayer 侧 2 个文件）

**2a. `HyperPlayer/src/services/audioEngineVersion.ts`** —— 加 'v3' 分支：

```ts
// 改动点：版本联合类型加 'v3'；默认值保持 'v1'（验证通过后再考虑默认切 v3）
export type AudioEngineVersion = 'v1' | 'v2' | 'v3'
// getAudioEngineVersion()/setAudioEngineVersion() 的读写逻辑不变
// （localStorage 'hyperplayer:audio-engine-version'，默认 'v1'）
```

**2b. 新建 `HyperPlayer/src/services/HyperSoundEngine-v1/attachV3Engine.ts`** —— 直接使用现成接线模块：

```ts
/**
 * v3 引擎接线：切换流程与 HyperPlayer 现有 v1→v2 热切换同款
 * （暂停 → dispose 旧 → attach 新 → 恢复播放）。
 * EngineV3Host 已内置：masterGain 全断重连（防双链并联）、worklet/script 双模式与自动回退、
 * 幂等、异步注册期间被 dispose 的竞态防护、dispose 恢复 masterGain→analyser 直连。
 */
import { EngineV3Host, createDefaultParams } from './index'
import type { V3EngineParams } from './index'

export interface AudioGraphHandleLike {
  audioContext: { sampleRate: number; audioWorklet?: { addModule(url: string): Promise<void> }; createScriptProcessor?(b: number, i: number, o: number): unknown }
  masterGain: { connect(n: unknown): unknown; disconnect(): unknown }
  analyser: { connect(n: unknown): unknown }
}

/** 模块级单例（与 v2 的 engineRef 模式一致） */
let host: EngineV3Host | null = null

/** 音频图就绪回调：把 v3 接入 masterGain → v3节点 → analyser */
export async function attachV3Engine(handle: AudioGraphHandleLike, settingsToV3Params: () => V3EngineParams): Promise<void> {
  if (!host) host = new EngineV3Host({ mode: 'auto', workletUrl: '/v3-worklet.js' })
  await host.attach(handle as never)            // handle 符合 V3HostHandle 鸭子类型
  host.setParams(settingsToV3Params())          // 由 HyperPlayer 设置对象构造 V3EngineParams（见步骤 4 映射）
}

/** 切走/关闭：恢复 masterGain→analyser 直连 */
export function detachV3Engine(): void {
  host?.dispose()
}

/** 参数变更（调音室操作时调用） */
export function updateV3Params(p: V3EngineParams): void {
  host?.setParams(p)
}
```

**2c. 热切换接入点**（与现有 v1→v2 切换同构，参考 `src/App.tsx` 的 `switchAudioEngine`）：
暂停播放 → `detachV3Engine()`（旧）→ `await attachV3Engine(handle, ...)`（新）→ 恢复播放。
音频图未就绪（handle=null）时仅保存版本配置，下次启动生效（与冷切换语义一致）。

### 步骤 3：AudioWorklet 打包（worklet 路径需要；script 兜底可跳过）

```bash
cd HyperPlayer
npm run build:v3-worklet     # = node scripts/build-v3-worklet.mjs（等价于下方 esbuild 命令）
# 手工等价命令：
npx esbuild src/services/HyperSoundEngine-v1/worklet/AudioEffectsProcessor.ts \
  --bundle --format=iife --outfile=public/v3-worklet.js
```

- 产物 `public/v3-worklet.js`（含全部 DSP，约几十 KB）；处理器注册名 `hyperplayer-v3-effects`。
  `predev` / `predev:electron` / `prebuild` 钩子已自动执行该打包，无需手动跑。
- `EngineV3Host` 的 `mode: 'auto'` 会**优先 worklet、失败自动回退 script**（无需打包也能出声，便于先联调后打包）。
- 注意：worklet 内 `sampleRate` 为全局变量；参数经 `port.postMessage({type:'params'})` 下发。
- **空间音频没有独立 worklet**：它是 HyperSoundEngine 内联第 15 级，**不存在** `public/spatial-worklet.js`
  与 `build:spatial-worklet` 脚本（见 §6）。

### 步骤 4：参数对接（v3 自有模型，不做 v2 字段迁移）

- HyperPlayer 侧构造 `V3EngineParams`（`src/services/HyperSoundEngine-v1/types.ts`），
  推荐从 `createDefaultParams(ctx.sampleRate)` 派生，按 UI 设置覆盖字段；
  11 个场景直接用 `SCENE_PRESETS`（含完整参数快照）。
- 分享串：`encodeShareCode/decodeShareCode`（版本+校验+白名单，防注入）。
- v2→v3 语义对照（字段不同、语义近似）：

| 主题 | v2 | v3 |
|---|---|---|
| 引擎形态 | Web Audio 节点图 | 纯 TS DSP 内核 + EngineV3Host 接线 |
| 参数模型 | AudioEffectsSettings | V3EngineParams（自有快照） |
| 响度归一化 | 3003 服务整曲测量 + 静态增益（-14 LUFS） | 引擎内实时 BS.1770（targetLufs 可配置 -14/-16/-23） |
| 频响补偿 | 3004 服务 + BiquadFilterNode 链 | 内置 LoudnessComp（v2 同款公式） |
| 变速/变调 | SoundTouch worklet（LGPL） | 三选一：自研相位声码器（默认）/ soundtouchjs 链接 / signalsmith(MIT) |
| 混响 | 程序化随机 IR 卷积 | 确定性分区卷积（可导入 IR）+ 算法混响 |
| 限幅 | DynamicsCompressorNode（-6dB） | 前瞻+真峰值（-1dB 可配） |
| 场景 | 内置 7 场景（effects+eq） | 11 组合场景（全参数快照） |
| 新增 | — | 20 段 EQ+Q 补偿、de-esser、虚拟低频、IEQ、音量自适应补偿（LoudnessComp）、听力分析、分享串、分离队列、YIN、重采样、频谱特征 |

### 步骤 5：离线导出（MP3）

v3 双路径共用同一内核：解码后 PCM → `EngineV3.process` 分块处理 → 1s 静音冲刷卷积/限幅尾部
→ Float32→Int16 → lamejs 128kbps MP3 下载。当前实现为 `attachV3Engine.ts` 的 **`exportV3Mp3`**
（调音室经适配层 `V3Adapter` 调用；**`exportToWav` 已不存在**，`saveWav` 仅剩 `src/electron.d.ts` 的类型声明）。

### 步骤 6：UI

调音室（MixingStudioV2 或新面板）按 `types.ts` 字段绑定：EQ(10/20 段+Q 补偿)、齿音、压缩、
夜间、卷积/算法混响（IR 导入+去周期化）、虚拟低频、等响度（含按音量自适应补偿）、智能 EQ、听力分析、分离队列。

---

## 3. 验证清单（融合后逐项勾选）

| # | 验证项 | 方法与预期 |
|---|---|---|
| 1 | v3 单测迁移 | 仓库根 `npm run test` → 全绿（全仓 140 文件 = 139 过 + 1 跳过 / 1269 用例 = 1264 过 + 5 跳过；5 项跳过来自 LGPL 可选依赖未安装） |
| 2 | HyperPlayer 回归 | 仓库根 `npm run lint` 0 错误；`npm run test` 既有用例不回归 |
| 3 | 切换冒烟 | 切 v3 → 播放 → 无爆音/无声；v1↔v2↔v3 反复热切换无双链并联 |
| 4 | 逐效果开关 | EQ/齿音/压缩/夜间/混响/低音/补偿/IEQ/限幅 逐一开启关闭，听感变化符合预期 |
| 5 | 场景切换 | 11 场景 A→B→A，无 NaN、无爆音（v3 测试已覆盖逻辑，融合后人工复核） |
| 6 | 分享串 | 编码→解码往返一致；非法串被拒绝 |
| 7 | 一致性 | 实时链与离线导出 WAV 逐样本误差 <1e-6（同参数同输入） |
| 8 | 性能 | 48kHz 128 帧量子处理 <2ms；低端设备混响切算法、EQ 20→10 段 |
| 9 | 合规 | THIRD_PARTY_NOTICES.md 随分发物；LGPL 依赖按"不修改+链接"方式（随附 LICENSE） |
| 10 | 响度 | 响度计数值合理（1kHz 满刻度 ≈-3 LUFS）；限幅器削波灯正常 |

---

## 4. 常见问题排查

| 症状 | 原因与处理 |
|---|---|
| 切 v3 后无声 | ① 检查 masterGain 接线（v3 节点须在 masterGain 与 analyser 之间）；② worklet 未打包时确认走了 script 兜底（无 `createScriptProcessor` 的宿主需先打包）；③ dispose 后应恢复 masterGain→analyser 直连 |
| `v3-worklet.js` 404 | 打包输出路径与 `workletUrl` 不一致；或未先 build（开发模式用 `public/` 静态目录） |
| 切换爆音/双击声 | 热切换必须"暂停 → dispose 旧 → attach 新 → 恢复"（不能两个引擎同时挂 masterGain） |
| 输出 NaN | 极低概率：参数含 NaN（分享串解码已防注入）；若复现，检查输入 PCM 是否合法 |
| LGPL 合规疑问 | soundtouchjs 为"不修改+动态链接"（vendor 原包随附 LICENSE）；@soundtouchjs/audio-worklet 若保留同理 |
| 需要调响度目标 | `loudnessNormalization.targetLufs`：-14（流媒体）/ -16（Apple）/ -23（EBU 广播） |

---

## 5. 完成标准

- [x] 步骤 0 预检全绿（仓库根 `npm run test` + `npm run lint`；LGPL 用例自动跳过）
- [x] v3 落位 `HyperPlayer/src/services/HyperSoundEngine-v1/`（含 vendor/）
- [x] `audioEngineVersion.ts` 支持 'v3'；attachV3Engine.ts 接线完成
- [x] worklet 打包（或确认 script 兜底可用）
- [x] 验证清单 10 项全部通过
- [x] THIRD_PARTY_NOTICES.md / vendor/README.md 随分发物

---

## 6. 空间音频（Spatial Audio）——现状：HyperSoundEngine 第 15 级内联

> **2026-09-13 校正（本节按当前代码重写）**：空间音频**不是**独立的 AudioWorklet 节点，
> 也**没有** WASM / Rust 后端。它由 `EngineV3.ts` 以相对路径 `import '../spatial/...'` **内联调用**，
> 作为 **14 级主链之后的第 15 级**（Limiter 之后、写输出之前）；参数是 `V3EngineParams.spatial`
> 的一部分，随 localStorage `hyperplayer:v3-params` 快照持久化。
> 历史版本（`WasmHrtfBackend` + `rust/hrtf-core` + `public/spatial-worklet.js` +
> 独立 `hyperplayer:spatial-params` + `SpatialProcessor/SpatialNode`）**已随减配整体移除**；
> 下文凡提到这些名字的地方均为历史设计，现实现为**纯 TS**（`TsConvolverBackend` / `TimeConvolver`）。

### 6.1 拓扑与接线（空间在引擎内，无 UI 侧接线）

```
masterGain → [SoundTouch 变速变调（pitch 活跃时）] → v3 节点（内含第 15 级空间音频） → analyser
```

- 空间化在 `EngineV3.process()` 内完成：`mode='off'` 或缺省 `spatial` 时整级旁路（逐位回归）；
  刚从 off→on 切换时后端 `reset()` 流式状态，配置签名变化才 `setConfig`（避免非空间参数变更清状态）。
- **无需**任何融合层接线：`attachV3Engine.ts` 中**没有** `syncSpatialChain` / `unwireSpatial` /
  `createExportBackend`（这些名字属历史设计）——空间参数随 `setParams` 的整包快照下发。
- **后端（纯 TS）**：`TsConvolverBackend`（分区 FFT，复用 `dsp/Convolver.ts`）为默认路径；
  `convolution='time'` 时走 `TimeConvolver` 时域直接卷积，两种模式干湿对齐一致。
- **离线 MP3 导出**（`exportV3Mp3`）：解码源 PCM → pitch 前置（`Stretch`，pitch 活跃时）
  → `EngineV3.process` 分块（**空间级自动包含**，无需独立后端包裹）→ 1s 静音冲刷卷积/限幅尾
  → Float32→Int16 → `lamejs.Mp3Encoder(2, sampleRate, 128)` → `.mp3` 保存/下载。

### 6.2 文件地图

`src/spatial/`（相对 `src/services/HyperSoundEngine-v1/`；**13 个 TS 文件 + 8 个测试文件**，2026-09-13 实测）：

| 文件 | 职责 |
|---|---|
| `src/spatial/types.ts` | **参数模型事实源**：SpatialParams / 各模式设置 / HrtfGrid / SpatialRenderConfig / 默认值 `createDefaultSpatialParams` |
| `src/spatial/SpatialBackend.ts` | 后端接口（接口先行、实现可替换）；热路径约束：稳态零分配、每块一次、outL/outR 完整写入 |
| `src/spatial/TsConvolverBackend.ts` | **默认（且唯一）TS 后端**：复用 `dsp/Convolver.ts` 分区 FFT 卷积，内联房间模拟 / 插值 / 多普勒 / 遮挡 |
| `src/spatial/TimeConvolver.ts` | 时域直接卷积（`convolution='time'`；与分区模式同块调度同放行，干湿对齐一致） |
| `src/spatial/roomSim.ts` | 房间模拟（镜像声源法早期反射 + FDN 8 条质数延迟线晚期混响；7 预设 studio/hall/stage/church/outdoor/bathroom/corridor） |
| `src/spatial/hrtfInterp.ts` | 双插值模式：最近邻网格查表（nearest）/ 实球谐 L=3 最小二乘拟合（spherical） |
| `src/spatial/analyticHrtf.ts` | 当前 HRTF 数据源：合成解析网格（简化球头模型，Woodworth ITD + 球头阴影 ILD，全确定性） |
| `src/spatial/ambisonics.ts` | Ambisonics FOA（一阶实 SH）编解码 + 环境上混（`AMBIENCE_SPEAKERS` 45/135/225/315° 四方向扩散扬声器） |
| `src/spatial/ambienceMixer.ts` | 环境声上混与主渲染的混合 |
| `src/spatial/controller.ts` | 模式 C 纯函数：听者→声源相对方向（`computeRelativeDirection`）、移动/旋转（`moveListener`/`rotateListener`）、轨迹插值（`computeTrajectoryPosition`） |
| `src/spatial/layouts.ts` | 模式 B 布局预设**单事实源**（stereo/51/514/71/714 表 + `createLayoutSpeakers`/`headLockedSpeakers` 解析） |
| `src/spatial/scenes.ts` | 模式 D 场景预设**单事实源**（stage/cinema/piano/nature 表 + `stageSpeakers`/`stageRoom`，座位/房间缩放） |
| `src/spatial/keymap.ts` | 世界漫游键盘控制键位映射 |
| `src/spatial/test/` | **8 个测试文件**：analyticHrtf / hrtfInterp / ambisonics / layouts / scenes / controller / tsBackend / boomFix |
| `src/engine/EngineV3.ts` | 第 15 级内联实现：`TsConvolverBackend` 装载 + `spatialConfigFromSettings()`（历史 `fusion.spatialConfigFromParams` 的纯函数移植）+ off/on 旁路与后端重配 |
| `src/types.ts` | `V3EngineParams.spatial?: SpatialSettings`（SpatialParams 的精简投影，去 UI/全局字段；perfMode → `hrtfInterp`） |
| `ui/pages/SpatialAudioPage.tsx` | **空间音频页**（调音室第 5 页）：四模式面板 + 标准/专业视图 |
| `ui/pages/SpatialPage.tsx` | **空间音效页**（调音室第 4 页）：混响/3D 环绕/低音增强弹窗入口（与空间音频页不同） |
| `ui/components/Spatial*` 等 | `SpatialRingEditor` / `SpatialSphereEditor` / `SpatialWorldView`（3D 世界视图）/ `WorldPanel` / `StagePanel` / `SpatialSettingsModal` / `SpatialStudioLayout` / `SpatialModeVisual` / `playheadSync` / `worldControl` / `sphereMath` / `spatialConstants` |

> 历史设计（**已删除，勿再引用**）：`src/spatial/fusion.ts`、`persistence.ts`、`hrtfStore.ts`、
> `gridSource.ts`、`room.ts`、`SpatialProcessor.ts`、`SpatialNode.ts`、`WasmHrtfBackend.ts`、
> `backendIndex.generated.ts`、`data/grid.ts`、`data/datasets.ts`、`rust/hrtf-core/`、`hrtf-data/`、
> `scripts/build-spatial-worklet.mjs`、`public/spatial-worklet.js`。

### 6.3 参数模型（`V3EngineParams.spatial`，投影自 `src/spatial/types.ts`）

引擎侧事实源是 **`src/types.ts` 的 `SpatialSettings`**（`spatial?: SpatialSettings`，可选字段；
缺省即旁路），它是 `src/spatial/types.ts` 的 **`SpatialParams` 精简投影**（去掉
`output` / `perfMode` / `sinkId` / `keymap` / `multichannelChannels` 等 UI/全局字段；
`perfMode` 由 `hrtfInterp` 表达）。默认值由 `createDefaultSpatialSettings()` →
`createDefaultSpatialParams()` 单事实源投影（`mode='off'`）。

| 字段（`SpatialSettings`） | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `'off' \| 'instant' \| 'headLocked' \| 'world' \| 'stage'` | `'off'` | 空间模式开关；`'off'` = 第 15 级逐位旁路 |
| `masterGain` | number | `0.9` | 双耳输出主增益（0.5..1，防削波预留） |
| `convolution` | `'partitioned' \| 'time'` | `'partitioned'` | 分区 FFT 卷积 / 时域直接卷积（`TimeConvolver`） |
| `hrtfInterp` | `'nearest' \| 'spherical'` | `'nearest'` | 最近邻网格查表 / 实球谐 L=3 最小二乘插值 |
| `distanceModel` | `'inverse' \| 'linear' \| 'exponential'` | `'inverse'` | 距离衰减模型（全局渲染参数） |
| `refDistance` / `maxDistance` | number | `1` / `50` | 参考距离（内不衰减）/ 最大距离（linear 衰减到 0） |
| `instant` | `InstantSpatialSettings` | 见下 | 模式 A |
| `headLocked` | `HeadLockedSettings` | 见下 | 模式 B |
| `world` | `WorldSettings` | 见下 | 模式 C |
| `stage` | `StageSettings` | 见下 | 模式 D |
| `ambience` | `AmbienceSettings` | `{ enabled: false, amount: 0.3 }` | 环境声 Ambisonics 上混叠加 |

各模式子设置（`src/spatial/types.ts` 同名接口，UI 与 HyperSoundEngine 共用）：

- **instant（模式 A）**：`spreadDeg`（20..120，虚拟扬声器 ±spreadDeg/2）、`amount`（0..1 干湿混合）、
  `room`（`RoomPreset`：off/studio/hall/stage/church/outdoor/bathroom/corridor）、`roomAmount`（0..1 房间混响叠加量）、`multichannelAuto`（多声道输入自动映射开关，默认 false）。
- **headLocked（模式 B）**：`layout`（`'stereo' | '51' | '514' | '71' | '714' | 'custom'`）、
  `speakers`（`VirtualSpeakerCfg[]`：azimuthDeg/elevationDeg/distance/gain/size，custom 时生效）、
  `heightLayer` / `bottomLayer`（顶置/底层开关）、`routes`（`SpeakerRoute[]` 与 speakers 等长：
  `'l' | 'r' | 'both'` 逐扬声器声源路由；空/长度不足回退按方位角就近）。
- **world（模式 C）**：`moveSpeed`（0.5..5 m/s）、`listener`（`ListenerState`：position + yaw/pitch/roll）、
  `sources`（`AudioObject[]`，默认演示源）、`playhead`（秒）、`trajectories`（`TrajectoryKeyframes[]`：
  sourceId + t/position 关键帧，按 playhead 线性插值）、`occlusion`（0..1 遮挡/衍射量）。
- **stage（模式 D）**：`preset`（`'stage' | 'cinema' | 'piano' | 'nature'`）、
  `seat`（`'front' | 'middle' | 'back'`）、`roomSize`（0.5..2）、`reverbAmount`（0..1）、`customSources`。

**持久化**（只有主键，**无独立空间键、无 IndexedDB 数据集**）：

| 键 | 内容 | 说明 |
|---|---|---|
| `hyperplayer:v3-params` | 完整 `V3EngineParams` 快照（**含 `spatial`**） | `attachV3Engine.ts` 的 `PARAMS_KEY`；卷积 IR 数组不入库 |
| `hyperplayer:v3-scene-overrides` | 内置场景微调覆盖层 | 开发者模式用（与空间无关） |

> `hyperplayer:spatial-params` / `hyperplayer:hrtf-active-dataset` / IndexedDB `hyperplayer-hrtf`
> 均为**历史键位，代码中已不存在**；注意 `src/spatial/types.ts` 的若干注释仍是旧设计残留
> （如「独立于 V3EngineParams」「fusion.spatialConfigFromParams」「SpatialNode 重建」
> 「fusion.setOutputDevice」），**以本文与实际代码为准**。

### 6.4 读写接口（无空间专属 API，一律走参数快照）

空间参数没有独立的 getter/setter（历史 `getSpatialParams` / `setSpatialParams` /
`subscribeSpatialParams` / `getSpatialStats` / `isSpatialActive` 均已移除），UI 经通用参数通道读写：

```ts
// 调音室侧（ui/pages/SpatialAudioPage.tsx）
const { params, patch, replace } = useV3Params(bridge)   // V3ParamsController
const patchSpatial = (p) => patch({ spatial: { ...params.spatial, ...p } })  // 深合并 + customized=true

// 桥接口（ui/bridge.ts 的 V3UiBridge）
bridge.getParams(): V3EngineParams            // 读（含 spatial）
bridge.setParams(p: V3EngineParams): void     // 写整包快照 → EngineV3.setParams
```

引擎内部（`EngineV3.ts`）：`spatialConfigFromSettings(s)`（配置推导，历史
`fusion.spatialConfigFromParams` 的移植）、`TsConvolverBackend.loadHrtf(generateAnalyticHrtfGrid(fs))`、
`setConfig` / `reset` 的按签名重配逻辑，以及 off/on 分支。

UI 侧可用的纯函数/表（直接 import `src/spatial/*`，不经引擎）：
`headLockedSpeakers` / `createLayoutSpeakers`（`layouts.ts`）、`stageSpeakers` / `stageRoom`（`scenes.ts`）、
`moveListener` / `rotateListener` / `computeRelativeDirection` / `computeTrajectoryPosition`（`controller.ts`）、
`createDefaultSpatialParams`（`types.ts`）。

### 6.5 扩展指南

- **加新模式**：① `src/spatial/types.ts` 加 `SpatialMode` 值 + `XxxSettings` 接口 + 默认值；
  ② `src/types.ts` 的 `SpatialSettings` / `createDefaultSpatialSettings()` 同步投影；
  ③ `EngineV3.ts` 的 `spatialConfigFromSettings()` 加扬声器/房间推导分支；
  ④ `ui/pages/SpatialAudioPage.tsx` 加模式按钮与面板（标准/专业视图共用面板组件）。
- **加后端能力**：实现进 `TsConvolverBackend` / `TimeConvolver`（`SpatialBackend.ts` 接口：
  `loadHrtf / setConfig / setListener / processStereo / processMulti? / getLatencySamples / reset`），
  遵守热路径约束（稳态零分配、每块一次、outL/outR 完整写入），并保持 **`mode='off'` 与
  「特性关闭」路径逐位回归**（`boomFix` 等测试覆盖）。
- **换 HRTF 数据源**：当前只有 `analyticHrtf.ts` 的合成解析网格（**无外部 KEMAR/SOFA 数据集、
  无 IndexedDB 持久化**）。若要引入外部数据集，需自行实现解析、采样率适配、持久化与 UI 入口。
- **约束提醒**：`ROOM_PRESETS`（`roomSim.ts`）与布局/场景表是**单事实源**，改一处即全链路生效；
  `spatial` 不是场景预设字段（`SCENE_PRESETS` 无空间内容），也不单独持久化——
  跟随 `hyperplayer:v3-params` 整包快照。

> 历史 §6.5「WASM 契约（`rust/hrtf-core` 的 16 个 `spatial_*` 函数）」与 §6.6「双后端对拍 / 构建流程」
> 已按现状删除（对应代码不存在）；概要见上方 §6.6 历史设计备忘。

### 6.6 历史设计备忘（WASM/Rust 后端，已整体移除）

以下内容仅作背景，**代码中已不存在，勿据此实现或引用**：

- 曾有计划把 HRTF 渲染热点下沉到 Rust → wasm32-unknown-unknown（`rust/hrtf-core/`，16 个
  `spatial_*` C ABI 函数：`spatial_load_hrtf` / `spatial_set_config` / `spatial_set_room[_preset]` /
  `spatial_set_hrtf_interp_mode` / `spatial_set_doppler` / `spatial_set_convolution_mode` /
  `spatial_set_occlusion` / `spatial_render_objects` / `spatial_render_multi` /
  `spatial_get_latency_samples` / `spatial_reset` / `spatial_alloc` / `spatial_free` /
  `spatial_set_distance_model` / `spatial_get_hrir`），并由 `WasmHrtfBackend.ts` 做 TS/WASM 逐位对拍。
- 构建管线（`scripts/build-spatial-worklet.mjs`：cargo → 网格 base64 内嵌 → 后端索引 →
  esbuild 打包 `public/spatial-worklet.js`）与 `WASM_BASE64` 内嵌（`backendIndex.generated.ts`）、
  `hrtf-data/grid.bin` KEMAR 网格、`data/grid.ts` / `data/datasets.ts`、`hrtfStore.ts`（IndexedDB 数据集）
  一并移除。
- **现状**：仅 `TsConvolverBackend`（分区 FFT）+ `TimeConvolver`（时域）两条纯 TS 路径，
  由 `HyperSoundEngine` 第 15 级内联调用；`npm run build:v3-worklet` 只打包 `v3-worklet.js`。
