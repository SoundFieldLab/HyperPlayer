# HyperPlayer 当前交接

更新时间：2026-08-31

## 当前结论

HyperPlayer 已完成 Tauri 2 + React/TypeScript + Rust 工程主干，并形成播放、队列、本地曲库、歌词、缓存门禁和部分网易云能力的真实闭环，但**尚未达到 v1 全功能完成**。

后续必须按完整链路判断功能完成度：

`定调 → 领域实现 → Tauri IPC → frontend bridge → UI 工作流 → 自动测试 → 真实 Tauri / 公网 / 账号 / 硬件验收`

不得再用测试数量、IPC command 数量或网易云 115 项 route catalog 代替端到端证据。

2026-08-31 曾误将主窗口替换为无关 `ProjectDashboard`。该偏移已完整撤销：`app/App.tsx`、`index.html` 已恢复，错误 dashboard 文件已删除，真实 Tauri/WebView2 已确认 HyperPlayer 主界面恢复。

## 依据

- `AGENTS.md`
- `docs/需求基线.md`
- `docs/定调决策记录.md`
- `docs/UI设计基线.md`
- `docs/UI定调决策记录.md`
- `docs/音源-网易云-行为规范.md`
- `tests/ACCEPTANCE_MATRIX.md`
- `LICENSE-HSE-AUTHORIZATION.md`

## Git 状态

- 分支：`feat/p0-netease-runtime-closure`
- 提交基线：`23ef617 feat(desktop): close playback context and desktop actions`
- 远程 feature tip 与本地基线一致，检查时为 `0 ahead / 0 behind`；无需先 pull。
- 当前大型业务批次仍在工作区，准备提交并推送。
- `src-tauri/gen/` 是未跟踪生成物，不得进入提交。
- `temp/`、`node_modules/`、`dist/` 和 Rust `target/` 均为忽略内容。

此前已推送：

1. `7137bea feat(netease): close runtime playback and image gaps`
2. `c9b239d feat(engine): persist playback history and entitlement locks`
3. `23ef617 feat(desktop): close playback context and desktop actions`

已有 CI：

- `7137bea` Quality：<https://github.com/SoundFieldLab/HyperPlayer/actions/runs/33363666181>
- `7137bea` Licenses：<https://github.com/SoundFieldLab/HyperPlayer/actions/runs/33363666175>
- `23ef617` Quality：<https://github.com/SoundFieldLab/HyperPlayer/actions/runs/33370697809>

## 当前批次已实现

### 播放和恢复队列

- 恢复队列启动后保持暂停。
- 播放时通过正常 `TrackResolverPort` 重新解析当前和相邻媒体，不信任持久化 URL 或文件句柄。
- 连续 Next/Previous、自动 EOF、shuffle、repeat-all、托盘和 SMTC 均走 resolver-aware transition。
- 当前项或目标项解析失败时保持非 Playing，不破坏 queue ID、顺序、模式、历史和保存位置。
- standby decoder 在可用时持续重新预热。

### 本地曲库和扫描

- engine 统一声明当前可播放格式：WAV、FLAC、MP3；scanner 与 Tauri 使用同一集合。
- Tauri 正式扫描复用 `LibraryScanner::scan_with_cancel`。
- 完整扫描后删除真正缺失的索引；取消或根目录读取不完整时不清理。
- 现存历史不支持格式条目不会被误删，新扫描不会继续索引不可播放格式。
- 嵌入封面进入内容寻址存储；遍历、元数据、封面和入库错误逐文件报告。

### 本地歌词

- 支持 LRC/YRC/TTML sidecar 与 Lofty `Lyrics/UnsyncLyrics` 嵌入歌词。
- 只能通过已注册 `MediaId` 和曲库根解析，不接受前端裸路径。
- sidecar 规范化后必须仍在注册根内，限制 1 MiB。
- 历史与新增曲库根同步到 engine repository。

### 本地播放列表

- repository 支持 create/rename/delete/add/remove/reorder/query，名称上限 80 字符。
- 添加、移除、重排为事务操作；重复添加不改变更新时间；临时负位置避免唯一索引冲突。
- UI 支持首个列表创建、重命名、删除、完整分页加载候选歌曲、添加、批量移除、单曲上移/下移。
- 列表详情保持后端顺序；批量部分失败后仍刷新并可重试。

### 双内容域导航

- 网易云和本地域分别保存 current/back/forward stack。
- history entry 保存 view、detailId 和本地 entity kind；字符串本地 ID 与数字网易云 ID 分离。
- 切换域恢复该域最后页面，新增导航只清当前域 forward，栈上限 20。
- 标题栏前进/后退、Alt+Left/Alt+Right 已接入。

### 缓存和 D23/D24

- D23 AccountEntitled 缓存绑定账号并实时校验；登出、切号、过期或验证失败 fail closed。
- D24 专辑上下文、有效时长、每日计数、五次晋升和下一首预取基础已实现。
- 展开播放器显示真实 cache status，处理 missing/failed/queued/caching/ready/lockedEntitlement，并防止旧请求覆盖新曲目。
- 同曲目多个质量版本按最严格状态聚合；删除操作明确删除所有缓存版本。

### 网易云匿名与发现

- 匿名首页使用 `public_explore()` 并行聚合公开歌单、新歌、榜单和热门艺人；分区独立降级，全部失败才报错。
- 匿名首页不调用日推、账号推荐资源或私人 FM；私人 FM 显示登录入口。
- 真实 Tauri/WebView2 已确认未登录首页加载公开新歌且不出现私人 FM 认证错误。
- Discover 已接榜单、新歌、MV 元数据、DJ/电台，分区独立 loading/empty/error/retry；支持适用分页。
- 新歌和 DJ 主曲目复用真实播放/队列；榜单进入歌单详情；MV 未接视频播放时不显示假播放。
- 艺人详情补齐 head info、简介和粉丝数，可选分区独立降级。
- source 层新增 `mv_play_url`、`similar_mvs`、`top_mvs`；尚未接入 Tauri MV 视频播放。

### Updater

- 仅保留 `updater_update(expectedVersion)` 单一安装 IPC。
- metadata 与 package 均要求 HTTPS、无凭据/fragment；DNS 全部为公网地址并绑定已验证地址；禁用代理；逐跳手动验证重定向。
- metadata 限制 1 MiB，package 限制 512 MiB；使用全流程 deadline。
- 本地解析 Tauri release metadata、进行 semantic version 比较；expectedVersion 变化时 fail closed。
- 使用 Minisign 验签后才启动 Windows installer；所有外部错误向前端脱敏。
- 缺少公钥/endpoint 时真实 Tauri 已确认 fail closed。

### 前端页面与测试

- Settings 已分为外观、播放、音频/DSP、曲库、缓存、网易云、快捷键、系统、隐私、关于。
- 展开播放器的缓存控制为真实 bridge 行为，未实现的喜欢/更多保持禁用。
- 新增页面级播放列表、Settings、Discover、Player cache 和导航测试。

## 当前验证基线

最新整合结果：

- frontend：53 tests / 8 files
- engine：69 tests
- NetEase Rust：49 tests
- Tauri：85 tests
- IPC：79 commands / 12 events
- Rust 1.98 三个 manifest fmt/clippy/test：通过
- 三个 manifest `cargo deny --offline`：通过，只有既有 duplicate/unmatched allow warnings
- 网易云 TypeScript oracle：通过
- JavaScript production license audit：通过
- `pnpm frontend:build`：通过，仍有约 598 KiB chunk warning
- 最新完整 `pnpm build`：通过，生成 x64 NSIS 与 MSI

提交前必须基于最终工作树重跑上述门禁；文档数字不能代替命令结果。

## HSE v1.5.1 与 D29

用户已要求 HSE 完整 DSP 核心接入，并授权 HyperPlayer 修改、融合、再许可和以 Apache-2.0 分发 HSE v1.5.1 自有代码、参数、预设、规范与测试向量；见 `LICENSE-HSE-AUTHORIZATION.md`。

固定来源：

- checkout：`temp/hse-v1.5.1/`
- tag：`v1.5.1`
- tag object：`3602b86906e6a345baaf6e87fe559f80ed399cc4`
- commit：`f7017621b7d84005fbfed8a3c42a119487a17326`
- 本地源码归档：`temp/HyperSoundEngine-v1.5.1-local.tar.gz`
- SHA-256：`25fa1568b067ca241882f93fa5f562852425ec32f2b0afd8b8f72b5315a49a91`

接入范围：完整 22 阶段 Rust/TS DSP 核心、完整参数、12 个预设、HSE2 编码与 parity；不复用 HSE UI、browser host、WASM/service/N-API 或重复 WASAPI。第三方 IR、素材和 SOFA/HRTF 数据不在专项授权内，须独立审计。

## D30 缓存默认

- 10 GiB 默认容量，可配置 2–100 GiB，到上限清理至 90%。
- 保护最近 100 个不同远程曲目。
- 淘汰顺序：过期 partial/orphan → locked entitlement → album-fill remainder → automatic → user-requested → 最旧 recent。
- Public 离线证明最长 7 天；AccountEntitled 离线永远拒绝。
- 整专补齐 standard、单并发、让路 manual/next-track；AC、非计费网络和磁盘保留条件满足时运行。
- schema v7、迁移前备份、LRU、获取类型、授权/完整性时间和 durable album-fill items 尚待实现。

## 全功能审查仍存在的缺口

### 前端

- 本地首页仍是导航壳，未完成继续聆听、最近新增、常听内容和扫描/存储摘要。
- 网易云消息、动态、报告和写操作多数尚未进入 bridge/UI。
- 搜索缺少完整实体分组、跨域模式、历史和建议。
- `adaptTrack` 仍把 playable 简化为 free、默认 cache 为 none，权益/缓存/封面映射尚未完整。
- 展开播放器真实 PCM 波形、部分上下文动作、完整焦点陷阱和可访问性仍不足。
- Discover MV 目前只展示元数据；没有 Tauri MV URL command 和视频播放器。

### 后端

- MP3/FLAC 增量解码、真实 codec delay/padding 和完整 gapless fixture 未完成。
- 设备枚举/切换、默认设备恢复、格式协商和独占模式未完成。
- typed scan error DTO、完整 SMTC metadata/timeline、文件关联未完成。
- D29 DSP 完整迁入和 D30 schema/policy/worker 尚未开始。

### 网易云 Cleanroom

- 115 route catalog 不是 115 个实现。
- Rust 可执行对应仍约为一半以上，MV read group 和 artist enrichment 已增加，但仍缺 hot/suggest、完整 playlist/artist/MV/DJ、similar、banner/wiki/blog、热评/楼层、账号历史、scrobble、journey/explore-next 等。
- Rust/Tauri 匿名公网 smoke、登录/VIP/写操作受控账号验收尚未完成。
- fee `4` 的购买权益模型仍需确认，不能简单永久等同 VIP。

## 下一步执行顺序

1. 对当前工作树执行最终门禁、完整构建和真实 Tauri 回归。
2. 拆分或原子提交当前跨层批次，推送并等待 Quality/Licenses。
3. CI 通过后清理 `node_modules`、`dist`、全部 `target` 和 `src-tauri/gen`。
4. 基于固定 HSE v1.5.1 开始 DSP runtime 重构，再按五个算法组并行迁入完整核心。
5. 实施 D30 schema v7、策略、资源探针、worker 和 UI。
6. 继续网易云剩余能力、本地体验、音频设备/系统集成和最终 UI 验收。

## 外部验收阻塞

- 网易云登录/VIP/写操作需要受控测试账号；凭据不得进入聊天、日志、fixture 或 artifact。
- 音频设备、独占模式、SMTC、媒体键和长期播放需要真实 Windows 硬件。
- updater 需要真实签名 key、托管 metadata/package、安装升级和 Authenticode。
- HRTF SOFA 数据需要独立再分发许可。
- 最终 UI 需要明/暗、A/B、多尺寸和辅助窗口逐页用户确认。

缺少外部资源时，只能标记“代码完成、外部验收阻塞”，不能标记“全功能完成”。

## 子代理协作规则

- 每个代理必须有严格文件白名单。
- `actor.rs`、`runtime.rs`、`repository.rs`、`adapters.rs`、DTO、bridge、store、Cargo、`lib.rs` 等热点文件必须单 owner。
- 代理完成以实际 diff、主线程复审和命令结果为准，不接受文字声明替代证据。
- 网易云 Cleanroom 仍遵守“参考代码只用于提炼规范，正式实现只按规范独立编写”。
