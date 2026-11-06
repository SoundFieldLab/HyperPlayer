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

## 歌词源仲裁

`src/services/lyricsSelection.ts` 拥有歌词源策略：来源名映射、逐字 / 翻译 / 罗马音能力检测、元数据空壳过滤、评分（逐字 / 时长 / 同步中位数）、QQ 官方权威规则、翻译 / 罗马音合并与来源记录。`selectLyrics()` 自己会剔除空数组与元数据空壳，直接调用也安全。

- `musicApi.getLyrics` 只负责取数、流式回调与日志；最终仲裁走 `selectLyrics()`。
- `getPlatformLyrics` 的翻译 / 罗马音合并也复用同一个 `mergeLyricsWithTranslationAndRoman()`。
- 第三方源会按时长错位（-40）与平台时间轴偏差（+30 / +10 / -150）评分；**-150 是重罚而非硬排除**，逐字与主源加分仍可能抵消。QQ 平台强制以 QQ 官方为骨架，第三方只补空缺。
- 回归测试：`test/lyricsSelection.test.ts`（QQ 权威 / 评分 / 时长降权 / 同步排除 / 合并 / 空候选）。

## 预载账本

`src/services/preloadLedger.ts` 拥有预载条目的唯一形状：URL、歌词、时间戳、URL / 歌词失效代际、进行中的歌词 promise 与歌词策略键。

- `App.tsx` 只调 `getFreshUrl()` / `getUrl()` / `getLyrics()` / `getLyricsSnapshot()` / `beginLyrics()` / `updateLyricsProgress()` / `completeLyrics()` / `failLyrics()` / `setUrlIfCurrent()` / `clearUrl()` / `invalidateAudioUrls()` / `invalidateLyrics()` / `prune()`；**不读取内部条目对象**。
- TTL（5 分钟）、30 条上限、最旧淘汰与“URL + 歌词都过期才删”都在 module 内；不要在 App 里再手写记录形状或时间戳。
- URL 与歌词是两个独立代际：音质 / 登录态变化清 URL，歌词策略变化清歌词；异步回来时代际不符的写入被丢弃。
- 回归测试：`test/preloadLedger.test.ts`（TTL / 代际 / 歌词生命周期 / 策略键 / 清理与上限）。

## 播放页显示偏好

`src/services/playbackDisplaySettings.ts` 拥有这组历史裸键的默认值、布尔格式、枚举校验、`upNextSeconds` 钳制（5–30 秒并取整）、历史事件、快照与订阅。

- 覆盖：`upNextEnabled` / `showUpNextOutsidePlayer` / `upNextSeconds` / `translationEnabled` / `translationPosition` / `romanEnabled` / `mvBackgroundEnabled` / `modernAudioVisualizerEnabled` / `hideImmersiveSongInfo` / `playerTheme`。快照包含主题，三个界面都从快照读主题。
- `App.tsx` / `SettingsPanel.tsx` / `QuickSettings.tsx` 通过 `src/hooks/usePlaybackDisplaySettings.ts` 订阅；写入只调 setter，`globalSettingsRegistry.ts` 的镜像条目也读同一份快照。
- **不要再裸读这些键或手写 `upNextEnabledChanged` / `translationSettingsChanged` / `romanSettingsChanged` 监听**。事件名与键名是历史值，勿改。
- 回归测试：`test/playbackDisplaySettings.test.ts`（默认值 / 钳制 / 事件序列 / 快照与单次通知 / 注册表写入等价性）。

## 详情导航栈

`src/services/detailNavigation.ts` 拥有详情弹窗的栈：压栈去重（仅栈顶重复忽略）、20 条深度上限、出栈、彻底清空、以及在打开新详情前 `pushAll()` 批量追加。

- 歌曲身份与 `App.getSongKey()` 同义：`platform-mid||id`；QQ 歌曲以 mid 为准，**不要用 id 比较**。
- `pushAll()` **保留已有历史**，只追加当前仍可见的详情；不要改成「清空再重建」，那会丢掉多级返回。
- `App.tsx` 的 `close*Detail` 先 `pop()` 再回退，`dismiss*Detail` 走 `clear()`，`handleOpenArtist` / `handleOpenAlbum` 用 `pushAll()`，三条路径共享同一账本。
- 回归测试：`test/detailNavigation.test.ts`（去重 / 深度上限 / 出栈 / 清空 / pushAll 保留历史 / QQ mid 身份）。

## 设置快照模块的复用边界

`transitionSettings.ts` / `lyricModeSettings.ts` / `playbackDisplaySettings.ts` 的 store / snapshot / commit / subscribe 骨架是**三份近似实现**。**这是有意接受的重复**：三份的领域规则（互斥、迁移、钳制）差异大，过早抽公共层会把语义压平。

再出现同类「单 host 快照 + 单次通知」需求时，抽 `createSettingsSnapshotStore`，并先补一组跨模块等价性测试。这是判断题，不是机械 lint 规则。

## 进程内过期缓存（后端）

`server/ttl-cache.mjs` 的 `TtlCache` 拥有后端进程内缓存的通用语义：TTL、条目上限、LRU 触达、写入前清过期、超限批量收缩（`evictTo`）、`ttlMs: Infinity` 的纯容量模式。

`local-server.mjs` 里已收口的实例：

| 缓存 | TTL | 上限 | LRU |
|---|---|---|---|
| `recommendCache` | 10 min | 300 | 是 |
| `qqPlaylistDetailCache` | 5 min | 50 | 是 |
| `qqPlaybackMetadataCache` | 30 min | 512 | 是 |
| `neteaseAlbumCoverCache` | 无过期 | 1000 | 是 |
| `neteaseRecentPlaylistCountCache` | 10 min | 500 | 否（FIFO，保持原语义） |
| `neteasePlaylistTrackIdCache` | 5 min | 100 | 否 |
| `neteaseSongDetailCache` | 20 min | 5000 → 3500 | 否 |
| `qqFeedbackContexts` / `qqAppendContexts` | 30 min | 1200 | 否 |

**站点特有语义留在 adapter**：账号指纹校验（`get*Context`）、并发合并（`qqPlaybackMetadataPending`）、cookie 折叠键（`cookieScopedKey`）。后端仍是单文件，不拆进程。

新增进程内缓存时用 `TtlCache`，**不要再手写 `Map + expiresAt + while(size>max)`**。回归测试：`test/ttlCache.test.ts`。

**已声明的豁免（下一轮候选）**：`server/bilibili-api.mjs` 的 `pruneCache` 三处、`server/netease-native-explore.mjs` 的 `createTimedCache` 三处、`server/location-api.mjs` 的 `reverseCache` — 它们的淘汰判据与主缓存不同（滚动窗口 / 带 pending 合并），迁移需要单独一轮确认，不在候选 11 范围内。
