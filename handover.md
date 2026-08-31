# HyperPlayer 当前交接

更新时间：2026-09-01

## 一句话结论

HyperPlayer 已具备可构建、可运行的 Tauri 2 播放器主干，以及本地播放/曲库/队列/歌词、部分缓存策略和部分网易云能力的真实闭环，但**尚未达到 v1 全功能完成**。

判断功能是否完成必须使用完整证据链：

`定调要求 → Rust/TS 领域实现 → Tauri IPC → frontend bridge → UI 工作流 → 自动测试 → 真实 Tauri / 公网 / 账号 / 硬件验收`

测试数量、command 数量和网易云 115 项 route catalog 都只是辅助证据，不能单独证明端到端完成。

## 当前 Git 状态

- 唯一规范分支：`main`
- PR #2 已合并：<https://github.com/SoundFieldLab/HyperPlayer/pull/2>
- 业务功能提交：`39de988 feat: close library and anonymous discovery workflows`
- `main` 合并提交：`0be5403 Merge pull request #2 from SoundFieldLab/feat/p0-netease-runtime-closure`
- 合并后 Quality：<https://github.com/SoundFieldLab/HyperPlayer/actions/runs/33416186027>，成功
- 合并后 Licenses：<https://github.com/SoundFieldLab/HyperPlayer/actions/runs/33416186019>，成功
- 本文档与 `AGENTS.md` 的 D31/UI-D80 更新作为后续文档提交进入 `main`
- `src-tauri/gen/` 是未跟踪生成目录，清理后不得进入提交
- `temp/`、`node_modules/`、`dist/` 和 Rust `target/` 均已 gitignore

历史功能提交：

1. `7137bea feat(netease): close runtime playback and image gaps`
2. `c9b239d feat(engine): persist playback history and entitlement locks`
3. `23ef617 feat(desktop): close playback context and desktop actions`
4. `39de988 feat: close library and anonymous discovery workflows`

## 权威定调文件

后续工作必须先按能力类别查阅对应文件：

| 能力 | 权威输入 |
|---|---|
| 产品范围、技术栈、里程碑 | `docs/需求基线.md`、`docs/定调决策记录.md` |
| Tauri / Rust / 曲库所有权 | `docs/adr/0004-rust-owns-library.md`、`docs/adr/0005-tauri2-react-rust.md` |
| UI 信息架构、状态、交互 | `docs/UI设计基线.md`、`docs/UI定调决策记录.md` |
| 网易云协议与 Cleanroom 行为 | `docs/音源-网易云-行为规范.md`、`src/audio-source/netease/` oracle |
| 自动化与外部验收门槛 | `tests/ACCEPTANCE_MATRIX.md` |
| HSE 使用、修改和分发权利 | `LICENSE-HSE-AUTHORIZATION.md` |
| Agent 执行硬约束 | `AGENTS.md` |

现行新增决策：

- **D29**：HyperSoundEngine v1.5.1 完整 DSP 核心接入，解除 D16/D27 的 DSP 挂起。
- **D30**：采用保守 D25 缓存默认，解除容量/离线/后台资源策略待定。
- **D31 / UI-D80**：vGPU 0.3.1 只作为主窗口可选 WebGPU 可视化层，Rust/HSE 继续负责权威音频与分析计算。

## 已完成并推送

### 网易云最小播放闭环

- XEAPI 首次调用具备并发安全、幂等、失败可重试的 lazy bootstrap。
- 二维码为本地 SVG data URL。
- 网易云图片代理限制 HTTPS、网易域名、公网 DNS/IP、逐跳重定向、MIME 和 10 MiB。
- 免费曲目使用官方播放 URL；登录 VIP 用户可按音质梯度请求官方完整 URL。
- 试听 URL、无 URL 和替代源均拒绝。

### 播放上下文、D23/D24 与桌面动作

- 播放上下文区分 manual/album/playlist/search/personalFm。
- D24 只接受匹配后端 albumId 的明确专辑上下文，seek 跳跃不累计有效时间。
- 播放历史按真实 Playing 会话保存最终位置。
- D23 支持按账号或全部账号锁定 AccountEntitled 缓存并撤销 lease。
- 登出锁定权益缓存并停止当前网易云播放。
- 队列 mutation 会同步 standby decoder。
- Windows 回收站使用 `IFileOperation + FOFX_RECYCLEONDELETE`，无永久删除回退。

## 当前工作区已实现但尚未提交

以下内容已经存在于当前工作区，不能整体恢复或覆盖。

### 播放与恢复队列

- 恢复队列启动后保持暂停。
- 调用播放时通过正常 `TrackResolverPort` 重新解析媒体，不信任持久化 URL 或文件句柄。
- 当前、下一项、后续 standby 持续水合，覆盖手动 Next/Previous、自动 EOF、shuffle、repeat-all、托盘和 SMTC。
- 解析或 decoder 准备失败不改变 queue ID、顺序、模式、历史或保存位置，并保持非 Playing。
- 本地媒体重新经过 SQLite 和注册根；网易云媒体重新经过官方 resolver 和 D23。

### 本地曲库扫描

- engine 单一声明当前可播放格式：WAV、FLAC、MP3；scanner 和 Tauri 复用同一集合。
- Tauri 正式扫描复用 `LibraryScanner::scan_with_cancel`。
- 未取消且完整遍历后删除真正缺失的索引。
- 取消、根目录读取失败、现存元数据失败和磁盘上仍存在的历史不支持格式不会误删。
- 嵌入封面进入内容寻址存储。
- 遍历、元数据、封面和入库错误通过现有 scan progress `phase` 逐文件报告。

### 本地歌词

- 支持 LRC/YRC/TTML sidecar 与 Lofty `Lyrics/UnsyncLyrics`。
- 仅通过已注册 `MediaId` 和曲库根解析；前端裸路径不能作为 TrackRef。
- sidecar 规范化后必须仍位于注册根内，大小限制 1 MiB。
- 历史和新增位置会同步到 engine repository。

### 本地播放列表

- repository 支持 create/rename/delete/add/remove/reorder/query，名称上限 80 字符。
- 添加、移除和重排使用事务；重复添加不刷新更新时间；临时负位置避免唯一索引冲突。
- UI 支持首个列表创建、重命名、删除、分页加载候选歌曲、添加、批量移除、上移/下移。
- 批量部分失败后会刷新列表并允许继续重试。

### 双内容域导航

- 网易云和本地域分别保存 current/back/forward stack，最多 20 条。
- history entry 保存 view、detailId 和本地 entity kind。
- 字符串本地 ID 与数字网易云 ID 分离。
- 本地 album/artist/folder/playlist 详情可被前进、后退和域切换恢复。
- 标题栏前进/后退与 Alt+Left/Alt+Right 已接通。

### 缓存 UI 与状态

- 展开播放器使用受信 `{id, source}` 查询 cache status。
- missing/failed、queued/caching、ready、lockedEntitlement 都有明确状态和动作。
- 旧异步响应不会覆盖已切换的新曲目。
- 同曲目多个质量版本按最严格状态聚合；`cachedVersions` 显示版本数，删除语义为删除该曲目的全部缓存版本。
- 未实现的喜欢/更多保持禁用，不伪造写操作。

### 网易云匿名首页与 Discover

- 匿名 `public_explore()` 并行请求公开歌单、新歌、榜单和热门艺人，分区独立降级，全部失败才报错。
- 匿名首页不调用日推、账号推荐资源或私人 FM；私人 FM 变成登录入口。
- 真实 Tauri/WebView2 已确认未登录首页加载公开新歌，不再显示私人 FM 认证错误。
- Discover 已接榜单、新歌、MV 元数据、DJ/电台，分区独立 loading/empty/error/retry，并支持适用分页。
- 新歌和 DJ 主曲目使用真实播放/队列；榜单打开现有歌单详情；MV 没有运行时播放链路时不显示假播放。
- 艺人详情补齐 head info、introduction、fans count，可选分区独立降级。
- source 层新增 `mv_play_url`、`similar_mvs`、`top_mvs`；尚未接到 Tauri 和视频播放器。

### Updater

- 只保留单一 `updater_update(expectedVersion)` 安装 IPC。
- metadata 和 package 均要求 HTTPS、无 credentials/fragment、公网 DNS/IP，绑定已验证地址并禁用系统代理。
- 每一跳手动校验重定向，metadata 限制 1 MiB，package 限制 512 MiB，并有全流程 deadline。
- metadata 本地解析和 semantic-version 比较，expectedVersion 改变时 fail closed。
- 使用 Minisign 公钥验签后才启动 Windows installer。
- 缺少公钥或 endpoint 时 fail closed；所有外部错误向前端脱敏。

### Settings、测试与 Discover UI

- Settings 已拆分外观、播放、音频/DSP、曲库、缓存、网易云、快捷键、系统、隐私、关于。
- 无后端支持的项目明确只读或 unavailable。
- 新增页面级 playlist、Settings、Discover、Player cache 和 navigation 测试。

## 当前最终验证结果

当前工作树最近一次通过：

- frontend：53 tests / 8 files
- engine：69 tests
- NetEase Rust：49 tests
- Tauri：85 tests
- IPC：79 commands / 12 events
- Rust 1.98 三个 manifest fmt/clippy/test：通过
- 三个 manifest `cargo deny --offline`：通过，仅既有 duplicate/unmatched allow warnings
- 网易云 TypeScript oracle：通过
- JavaScript production license audit：通过
- `pnpm frontend:build`：通过，仍有约 598 KiB chunk warning
- 最新 `pnpm build`：通过，生成 x64 NSIS 和 MSI

提交前仍需再执行一次最终 diff/状态检查，并确保 `src-tauri/gen/` 不进入提交。

## HSE v1.5.1 固定来源与授权

用户已要求 HSE 完整 DSP 核心接入，并授权 HyperPlayer 修改、融合、再许可和以 Apache-2.0 分发 HSE v1.5.1 自有代码、参数、预设、规范与测试向量；见 `LICENSE-HSE-AUTHORIZATION.md`。

固定来源：

- checkout：`temp/hse-v1.5.1/`
- tag：`v1.5.1`
- tag object：`3602b86906e6a345baaf6e87fe559f80ed399cc4`
- commit：`f7017621b7d84005fbfed8a3c42a119487a17326`
- 本地归档：`temp/HyperSoundEngine-v1.5.1-local.tar.gz`
- SHA-256：`25fa1568b067ca241882f93fa5f562852425ec32f2b0afd8b8f72b5315a49a91`

D29 接入范围：完整 22 阶段 Rust/TS DSP 核心、完整参数模型、12 个预设、HSE2 编码和 parity。HyperPlayer 不复用 HSE UI、browser host、WASM/service/N-API 或重复 WASAPI。第三方 IR、素材与 SOFA/HRTF 数据不在专项授权内，须独立审计。

## D30 缓存默认

- 10 GiB 默认容量，可配置 2–100 GiB，到上限清理至 90%。
- 保护最近 100 个不同远程曲目。
- 淘汰顺序：过期 partial/orphan → locked entitlement → album-fill remainder → automatic → user-requested → 最旧 recent。
- partial 24 小时清理；启动时 DB/object orphan 对账。
- Public 离线证明最长 7 天；AccountEntitled 离线永远拒绝。
- 整专补齐 standard、单并发、让路 manual/next-track；AC、非计费网络和磁盘保留条件满足时运行。
- schema v7、迁移前备份、LRU、获取类型、授权/完整性时间和 durable album-fill items 尚未实现。

## vGPU 可视化定调（D31 / UI-D80）

`vgpu` skill 已全局安装给 ZCode。上游 `vercel-labs/vgpu` 版本 0.3.1，MIT 许可证；当前没有加入 HyperPlayer `package.json`。

允许接入：

- 主窗口 B 材质封面氛围。
- 用户按需打开的微型波形/频谱。
- DSP 响应曲线、FFT/LUFS/peak/limiter-reduction 仪表。
- HRTF 的 2D 或克制 2.5D 空间场。

边界：

- Rust/HSE 负责权威 DSP、FFT、LUFS、true peak 和 HRTF；vGPU 只渲染 bounded telemetry。
- 不传原始高频 PCM，不进入 Zustand 或通用 Tauri events。
- 迷你播放器和桌面歌词不创建独立 GPU context。
- 缺少 WebGPU、初始化失败或 device lost 时退化到同一 telemetry 驱动的 Canvas2D/SVG/DOM，不影响播放。
- 使用独立二进制 channel、subscribe/ack/activity/close；每 WebView 一个会话，全局默认最多两个，每会话一个未 ACK 动态帧，积压覆盖旧帧。
- tap 为 `post_dsp_pre_output_gain`；默认 30 Hz，失焦/节能 15 Hz，减少动效 2 Hz，隐藏 0 Hz；动态帧目标小于 1 KiB。
- 接入顺序：Rust/HSE telemetry → Canvas2D fallback → vGPU renderer → 真实 WebView2 device-loss 与像素验收。

## 尚未完成的主要能力

### DSP / D29

- 22 阶段 HSE 核心尚未迁入 HyperPlayer。
- ProcessorChain 的 prepare/replace/revision/latency/fault/tail 契约尚未实现。
- standby raw PCM 与状态型 DSP 连续性尚未重构。
- 参数、12 个预设、HSE2、Rust/TS parity、Tauri DspPort、原生工作台、telemetry 和 vGPU 均未实现。

### 缓存 / D30

- schema v7、容量策略、LRU/最近 100、partial/orphan 对账、Windows power/metered/disk probes、durable album-fill worker 和 UI 尚未实现。

### 网易云

- 115 route catalog 不是 115 个实现。
- 仍缺 hot/suggest、完整 playlist/artist/MV/DJ、similar、banner/wiki/blog、热评/楼层、账号历史、scrobble、journey/explore-next 等。
- MV URL source API 尚未进入 Tauri 和视频播放器。
- 登录/VIP/写操作尚无受控账号外部验收；fee `4` 购买权益模型仍需确认。

### 音频、本地与 Windows

- MP3/FLAC 增量解码、真实 codec delay/padding、完整 gapless fixture。
- 输出设备枚举/切换、默认设备恢复、格式协商和独占模式。
- 本地首页、文件夹管理、标签重读、播放列表拖拽和完整上下文菜单。
- typed scan errors、完整 SMTC metadata/timeline、文件关联和真实 PCM telemetry。

### 前端产品收口

- 真实 entitlement/quality/cache/artwork 映射仍不完整。
- 消息、动态、报告、云盘写操作和受控 mutation UI 未完成。
- 跨域实体搜索、建议、历史、scroll/filter snapshot 未完成。
- 完整焦点陷阱、forced-colors、文本缩放和多尺寸页面验收未完成。

## 下一步执行顺序

1. 对当前工作树执行最终 diff/status 检查，排除 `src-tauri/gen`。
2. 创建当前跨层原子提交并推送，等待 Quality/Licenses 全绿。
3. CI 通过后清理 `node_modules`、`dist`、全部 `target` 和 `src-tauri/gen`。
4. 进行 D29 DSP runtime 基础重构。
5. 五个算法组并行迁入 HSE 22 阶段完整核心，主线程串行整合。
6. 完成参数、预设、HSE2、parity、Tauri DSP、HyperPlayer 原生 UI、telemetry 和 vGPU。
7. 实施 D30 schema/policy/worker/UI。
8. 继续网易云剩余能力、音频设备/系统能力和最终产品验收。

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
