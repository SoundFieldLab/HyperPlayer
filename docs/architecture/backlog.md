# 架构候选索引

架构审查报告默认写到系统临时目录，文件名形如
`architecture-review-<YYYYMMDD-HHMMSS>.html`。本文件保存候选的**稳定编号与状态**，让
`/implement 0X` 有明确目标。

## 2026-11-05 报告

报告文件：`%TEMP%\architecture-review-20261105-143500.html`（临时文件，可能被系统清理）。

| 编号 | 候选 | 状态 | 落地 |
|---|---|---|---|
| 01 | 收拢播放过渡设置的读 / 写 / 订阅 | 已完成 | `cfc4559` |
| 02 | 把账号会话做成深模块 | 已完成 | `c9a3678` |
| 03 | 合并插件启用门控与生命周期 | 已完成 | `a941ccd` |
| 04 | 让 trusted IPC 注册成为深模块 | 已完成 | `3f428ac` |
| 05 | 抽出更新清单生成模块 | 已完成 | `9ea8f02` |
| 06 | 歌词模式偏好深模块（报告外补充） | 已完成 | `386f336` |

## 2026-11-05 第二轮报告

报告文件：`%TEMP%\architecture-review-20261105-165110.html`（临时文件，可能被系统清理）。

| 编号 | 候选 | 状态 | 落地 |
|---|---|---|---|
| 07 | 歌词源仲裁 module（Top） | 已完成 | `7a58e14` |
| 08 | 预载账本 module（App 侧条目账本） | 已完成 | 本提交；musicApi 的短 TTL URL 缓存是另一条候选，不并入本轮 |
| 09 | 播放页显示偏好 module | 已完成 | `332431b` |
| 10 | 详情导航栈 module | 已完成 | `c6c6020` |
| 11 | 进程内过期缓存 module | 已完成 | `e1e5f01` |

### 已登记但尚未实现的遗留项

这两项来自候选 08 / 11 的落地说明，范围已界定但尚未开工。**按旧编号继续排，不要重新发明候选**。

| 编号 | 项 | 来源 | 范围 |
|---|---|---|---|
| 12 | `musicApi` 短 TTL URL 缓存并入预载账本 | 候选 08 落地说明 | `songUrlCache` / `songUrlPending` / `songUrlInvalidationVersions` 与 `PreloadLedger` 目前是两套失效体系。注意 `musicApi` 那套是 5 分钟正缓存 + 25 秒负缓存，且键含音质 / VIP / cookie 指纹，合并前必须先补等价性用例（`test/migrationEquivalence.test.ts`）。风险：取歌链。 |
| 13 | 后端剩余自定义过期缓存 | 候选 11 落地说明 | `server/bilibili-api.mjs` 的 `pruneCache` 三处、`server/netease-native-explore.mjs` 的 `createTimedCache` 三处、`server/location-api.mjs` 的 `reverseCache`。它们淘汰判据与主缓存不同（滚动窗口 / 带 pending 合并），迁移需逐处确认后再接 `TtlCache`。 |

## 使用规则

- `/implement 0X` 前先查本表；编号不存在时**停下来问**，不要临时发明一个候选。
- 新报告落地后，把候选摘要追加到本文件，并保留报告文件名与日期。
- 候选完成后补上 commit 与回归测试名，方便下一次审查跳过已完成项。
- **已界定范围但未开工的项也要给编号**（当前 `12` / `13`），否则下次 `/implement 0X` 会卡在“编号不存在”。
- 迁移类候选一律先补 `test/migrationEquivalence.test.ts` 的 `legacy*` 再动实现；`npm run test:equivalence` 是它的闸门。




