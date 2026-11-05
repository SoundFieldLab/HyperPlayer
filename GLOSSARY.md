# HyperPlayer 音效域

播放器"调音室"（Mixing Studio）中所有作用于音频信号的听感处理：效果器、场景方案、动态处理与响度补偿。核心问题域是"用户想把声音听成什么样"。当前唯一音效引擎是 **HSE（HyperSoundEngine，即 v3）**，其调音室 UI 位于 `src/services/HyperSoundEngine-v1/ui/`。

## Language

**音效（Effect）**:
对音频信号的一种可独立开关、可叠加的处理。HSE 提供的音效（见 `ui/effectsPanel.tsx` 的 `EFFECT_META`）：混响、3D 环绕、低音增强、动态压缩、夜间模式、齿音抑制、智能均衡（IEQ）、限幅器、变速变调、立体声宽度（含人声比例）、音量自适应补偿（等响度）、响度归一化。
_Avoid_: 效果器模式、插件

**场景方案（Scene Preset）**:
一组完整音效参数的快照（EQ 各段增益 + 各效果开关与参数），用户点击一次即整体应用。应用方式是"快照式"：把参数写入当前设置，之后可继续手动微调。HSE 内置 **11** 个场景（`src/engine/ScenePresets.ts` 的 `SCENE_IDS` / `SCENE_PRESETS`：流行 / 增强 / 爵士 / 舞曲 / 古典 / 现场 / 录音棚 / 温暖 / 浩渺 / 悠扬舞台 / 深夜低音），另有用户自建"我的场景"（上限 20，`ui/bridge.ts` 的 `MAX_MY_SCENES`）。场景快照**不含**系统音量通道。
_Avoid_: 音效预设、主题、配置文件

**自定义状态（Customized）**:
用户手动修改过任何音效参数、当前听感不再等于任一场景方案快照的状态（`params.customized`）。系统以"是否处于自定义状态"决定点击场景方案时是否提示覆盖/保存，并在场景页把当前场景名显示为「自定义（已调整）」。
_Avoid_: 脏状态、未保存状态

**当前场景（Active Scene）**:
最近一次通过场景方案卡片应用的那张方案的标识（`params.sceneId`）；用户手动调整参数后 `customized` 置真、当前场景显示为「自定义」。
_Avoid_: 选中场景、场景高亮

**频响补偿（Loudness Compensation）**:
按系统音量动态提升低频/高频的等响度补偿（低音量时人耳对低频/高频不敏感，等响度模型仅做提升不衰减、中频保持 0dB）+ 场景预设（flat/bass/vocal/warm/bright/night，低频 shelf + 温和中频 peaking + 高频 shelf）+ 自定义频段（5 段 peaking ±8dB）。**由 HSE 引擎内实时实现（`LoudnessCompSettings`，auto/preset/custom 三模式），不依赖任何外部服务**。与均衡器互斥（两者都是全频段整形）、与响度归一化互斥（避免补偿与逐曲增益叠加造成双重整形）。
_Avoid_: 响度补偿、等响度

**响度归一化（Loudness Normalization）**:
逐曲目测量实际响度（LUFS），播放时施加每首独立的增益使其对齐到统一目标响度（默认 -14 LUFS）。**由 HSE 引擎内实时 BS.1770 测量实现（`LoudnessNormSettings.useRealtimeMeter`），不依赖任何外部服务**；调音室音量滑块也走该模块的 `externalGainDb` 通道。
_Avoid_: 音量归一化、自动增益

**夜间模式（Night Mode）**:
深夜低音量听感的温和处理：动态压缩压平响度起伏 + 高频衰减（约 6kHz）收敛刺耳高频，无谐波失真。强度（`amount`，0-10 级）越高压缩越深、高频衰减越多。
_Avoid_: 夜间均衡、安静模式

**衔接方案提示（Gapless Mode Toast）**:
切到下一首时右上角弹出的小提示（`GaplessModeToast.tsx`），告知本次无缝衔接用的方案：直接拼接（专辑同曲目）/ 60ms 淡入淡出 / albumGapless 交叉淡化 / 交叉淡化。显示与淡出由 `App.tsx` 驱动。
_Avoid_: 切歌提示、无缝提示

**混响类型（Reverb Type）**:
HSE 混响分两条路由——卷积混响（可导入 IR，带去周期化处理）与算法混响。**混响类型**指算法混响的 5 种类型：大厅 / 房间 / 板式 / 弹簧 / 舞台，各自附带干湿比、预延迟、衰减时间等参数。
_Avoid_: 混响风格、空间预设

**系统音量（System Volume）**:
操作系统主音量（区别于播放器自身音量滑块）。HSE 的"音量自适应补偿"按它计算等响度补偿曲线；调音室的音量滑块则走 `loudnessNormalization.externalGainDb` 通道。
_Avoid_: 设备音量、主音量

**音效引擎版本（Engine Version）**:
**HSE（HyperSoundEngine）为当前唯一引擎。** 它就是代码里的 v3（`src/services/HyperSoundEngine-v1/`，纯 TS DSP 内核）；历史上可切换的 v1（远程原版）/ v2（本地增强版）已随减配整体移除。适配层注册表 `src/services/audio-engine/` 目前只注册 v3 一项（默认引擎即 v3），框架仍支持未来接入新引擎（写 `XxxAdapter.ts` + `engines/xxx.ts` + 注册表加一行）。
_Avoid_: 音效模式、旧版/新版开关
