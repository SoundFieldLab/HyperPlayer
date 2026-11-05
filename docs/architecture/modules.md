# 前端模块深水区

这些模块的共同目标：把「校验 / 存储格式 / 事件 / 快照 / 订阅」收在一处，UI 只负责呈现。改动前先读对应小节，别再在组件里裸读 localStorage 或手写同义事件。

改 `App.tsx` 的播放接线后，先跑 `npm run test:wiring`（秒级），再跑全量 `npm run test`。

## 播放过渡设置

Crossfade / Gapless / 专辑融合的互斥、时长钳制、存储格式、快照与事件派发**唯一实现在 `src/services/transitionSettings.ts`**。`App.tsx` 与 `SettingsPanel.tsx` 通过 `src/hooks/useTransitionSettings.ts` 订阅缓存快照，`globalSettingsRegistry.ts` 通过 `getTransitionSnapshot()` 读取；三个入口都只负责呈现，**不要再各自裸读 localStorage 或手写事件监听**。

这条链原先有两套不等价的写法，实际后果有两个：

1. 镜像侧写完会派发 `hyperplayer:global-setting-changed` 而简约侧不派发，且 SettingsPanel 的四个过渡 state 只在挂载时读一次 localStorage——**从传统模式改完回到简约设置页会显示旧值**。
2. 镜像滑杆 step 是 0.5 而写入只 clamp 不取整，同一档位能存出 4.5 秒。

现在写入走共享 `commit`，一次逻辑写入只通知一次最终快照；旧领域事件仍保留给播放侧，注册表只监听通用事件。键名（`crossfadeEnabled` / `crossfadeDuration` / `gaplessEnabled` / `albumGaplessEnabled`）与事件名是**历史裸键，勿改**（改名丢用户设置）。

回归测试：`test/transitionSettings.test.ts`（真实注册表条目 vs 共享规则等价性）、`test/transitionSettingsStore.test.ts`（注入 host 的快照/单次通知/外部事件）与 `test/useTransitionSettings.test.tsx`（hook 冒烟）。

## 歌词模式偏好

当前模式与可见模式集合的校验、默认值、历史迁移（补回看歌 / PV）、可见性约束（不能隐藏当前模式、现代模式、最后一个可见模式）、事件与快照**唯一实现在 `src/services/lyricModeSettings.ts`**。

- `App.tsx` / `QuickSettings.tsx` 通过 `src/hooks/useLyricModeSettings.ts` 订阅。
- 切换当前模式只调 `commitLyricDisplayMode()`；切换可见性只调 `toggleLyricModeVisibility()`。
- **不要再裸读 localStorage，也不要用 `lyricDisplayModeChanged` 同步 React 状态**。`App.tsx` 仅保留一个该事件的监听，专门触发看歌进出的播放交接副作用（`test/modeIntegrationWiring.test.ts` 钉住这个入口）。
- 键名 `lyricDisplayMode` / `hyperplayer_visible_lyric_modes`、两个迁移标记与事件名 `lyricDisplayModeChanged` / `hyperplayer-lyric-modes-visibility-changed` 是历史值，勿改。

旧实现只在「已有历史值」时迁移，导致新用户隐藏看歌后重载又被补回；现在首次读取即落库默认集合并置位两个迁移标记。

回归测试：`test/lyricModeSettings.test.ts`（默认值 / 损坏值修复 / 迁移一次性 / 可见性约束 / 单次通知 / 外部事件）。

## 账号会话

`src/services/accountSession.ts` 同时拥有代际失效、两个平台的历史 localStorage 键、登录有效期、`hyperplayer-auth-changed` 事件与 UI adapter。`App.tsx` 的登录回调只保留网络请求、平台资料映射与提示文案，退出统一走 `endAccountSession()`。

**不要重新在 App 里手写 cookie / 资料键的增删或认证事件。** 回归测试：`test/accountSession.test.ts`（登录提交、资料提交、迟到丢弃、失败清理、退出清空）。

## 插件启用 / 生命周期

consent、运行时能力门控、enabled 写入、生命周期队列 / 代际与停止清理**唯一实现在 `src/plugins/pluginActivation.ts`**。`src/plugins/toggle.ts` 只保留详情首次须知门控与旧入口 re-export；`PluginOverlay.tsx` 只调用 `startPluginLifecycle()`。

**不要再在 UI 层另写 `unavailableReason` 检查或生命周期队列。** 回归测试：`test/pluginActivation.test.ts`（consent、不可用回滚、启停顺序、停止清理）。

## IPC 注册 / capability

所有 `ipcMain.handle` 统一经过 `desktop/ipc-registry.cjs`；channel 前缀决定 `desktopLyrics` / `desktopPlayer` / `taskbarWidget` / `update`，其余主窗口专用 channel 显式列入 `MAIN_ONLY_CHANNELS`。

- 未知 channel、重复注册抛 `IpcRegistryError` 并在启动时中止。
- `desktop/main.cjs` 的 `ipcMain` 把 `handle` / `removeHandler` 转发到 registry；`on` / `removeListener` / `removeAllListeners` 保持 Electron 直连（fire-and-forget 不在此次 capability 范围内）。
- 新增 handler 必须先在 registry 声明 capability。

回归测试：`test/ipc-registry.test.cjs`（含主进程 / 更新 / Chroma / SignalRGB channel 全覆盖）。

## 过渡计划层

`src/audio/transitionPlanner.ts` 保留 `planTransition` / `planTransitionV2` 导出，但**只产出 `fixed-crossfade`**（smart-rendered / smart-rendered-v2 / beat-crossfade 生成分支已整体移除）。

`transitionPlanner.ts` / `TransitionRenderer.ts` / `autoMixAnalysisService.ts` 仍保留节拍分析能力（供 MV 对齐、PV 歌词等消费），但不再用于智能混音。切歌时右上角弹 gapless 方案提示（`GaplessModeToast.tsx`：直接拼接 / 60ms 淡入淡出 / albumGapless 交叉淡化，`App.tsx` 按 transitionCommit.strategy + 专辑归属判定）。

## 设置快照模块的复用边界

`transitionSettings.ts` 与 `lyricModeSettings.ts` 的 `WeakMap` store / snapshot / commit / subscribe 骨架目前是两份近似实现。**这是有意接受的两份重复**：两份的领域规则差异大，过早抽公共层会把语义压平。

出现第三份同类「单 host 快照 + 单次通知」需求时，再抽 `createSettingsSnapshotStore`，并先补一组跨模块等价性测试。这是判断题，不是机械 lint 规则。
