# Stage 16：网易云产品闭环

状态：进行中（115 条 RouteSpec 全部实现并接线：crate 68 测试 / Tauri 165 测试 / 前端 230 测试 / deny 全绿；UI 已消费全部新能力；剩余真实账号矩阵验收）

更新时间：2026-09-03

## 当前基础与目标

TS Cleanroom oracle 已覆盖 94 路由/115 函数；Rust 已有会话、部分 bridge、官方 URL 和受控缓存基础。剩余 Rust 网络/加密迁移、UI/MV、写操作与真实账号权益验收尚未完成。本切片在模块隔离前提下完成官方网易云产品能力。

非目标：Node sidecar、Unblock、灰歌替代源、跨平台匹配、伪造会员、音频下载/导出。

## 前置门禁

严格遵守 `docs/音源-网易云-行为规范.md`；参考代码只用于提炼规范，永不复制入实现；Cookie/设备会话/协议密钥不进入前端；模块可整体禁用。

## 预计修改与任务

修改独立网易云 Rust workspace/adapter、Tauri commands/events/capabilities、账号与内容 UI、缓存权益桥、MV 播放边界和测试。

1. 盘点 oracle 与 Rust endpoint 差距，按行为规范迁移。
2. 完成登录、会话刷新、账号切换和 DPAPI 生命周期。
3. 接搜索、首页、歌单/专辑/艺人、收藏/写操作和错误语义。
4. 接官方播放 URL、Public/AccountEntitled 缓存授权和 fail closed。
5. 实现 MV 的受控播放，不提供下载。
6. 普通/VIP/过期/风控账号按受控矩阵验收。

## 测试与验收

Rust contract/fixture、oracle parity、敏感信息日志审计、账号切换、权益过期、网络失败、限流/风控、模块禁用和 UI 状态。真实账号测试凭据不入库、不写日志。

只有普通/VIP/过期三类关键路径实测后，才能声明对应账号能力完成。

## 完成后同步

更新行为规范、handover、验收矩阵和账号验收记录（不含敏感数据）。

## 已完成（2026-09-03，三线并行 + 中央集成）

### 1. 差异清单（任务 1）
- `docs/调研报告Stage16-Netease-Gap.md`：TS oracle（115 函数）vs Rust（11 文件 5950 行）逐路由对照，42 条缺失 handler + 8 项行为差异 + 接线层缺口 + 敏感信息风险点。

### 2. crate 后端（任务 2 协议/会话；任务 3 搜索/首页/歌单/艺人/收藏/评论）
- **行为差异修复**：
  - 设备 Cookie 画像（session.rs `request_cookies`/`xeapi_cookie`）：补 `__remember_me/ntes_kaola_ad/_ntes_nuid/_ntes_nnid/WNMCID/WEVNSM/osver/channel/appver`，nuid/WNMCID 跨请求稳定；xeapi 通道独立画像（android osver/appver/buildver/sDeviceId，不注入匿名 token）。
  - xeapi 请求头（service.rs `xeapi_ready`）：补 `x-aeapi/x-os/x-osver/x-appver/x-sdeviceid/x-buildver/x-music-u` + 安卓 UA。
  - **weapi 备用算法**（crypto.rs `encrypt_weapi`）：AES-128-CBC 双层 + raw RSA（1024 位模数偏移 29、指数 65537、原序右对齐 128B），与 Node `RSA_NO_PADDING` 权威向量逐字节 golden 验证（`weapi_golden_*` 3 测试）。
  - StdSleeper → `tokio::time::sleep`（不阻塞 async 线程）。
  - scrobble 走 clientlog 域 + `os=osx`（`clientlog_eapi`），失败降级不阻塞播放。
- **30 条新路由 handler**（domains.rs）：searchHot/searchSuggest/banner/playlistCategories/highQualityPlaylists/similarPlaylists(×2)/artistAlbums/artistMvs/artistList/artistSublist/albumSublist/mvSublist/personalizedNewSongs/dislikeRecommendSong/checkSongsLiked/hotComments/commentFloor/msgComments/userFolloweds/userLevel/userSubcount/stylePreference/loginStatus/playRecord/listenDataToday/journeyOverview/similarSongs/scrobble/recentPlays/songQualityLevels。全部按行为规范通道/参数/映射，敏感字段不进 DTO。
- 测试：54→62（新增 10 个 fixture 测试：hot/suggest/banner/categories/liked/hot/floor/level/subcount/login-status/scrobble clientlog 降级）。

### 3. Tauri/bridge 接线（任务 3/4）
- NeteasePort 扩 25 方法，NeteaseAdapter 全实现；DTO 178 行新增；adapter_mapping 16 个映射函数。
- **28 个新 command** 注册（`netease_search_hot` … `netease_scrobble`），IPC 契约 97→125（`verify-contract.mjs` 验证 125 commands / 14 events）。
- 前端 bridge：TAURI_COMMANDS + BridgeContract + contracts.ts 类型（~22 个 DTO）全部同步，`pnpm test` 230 全过、`tsc -b` 零错误、`pnpm frontend:build` 成功。
- **敏感信息审计**：crate 零日志；DTO 无 cookie/token 字段；错误路径不含 URL/Cookie；`playback_serialization_does_not_leak_transport_or_session_data` 防泄露测试在；DPAPI 持久化仍限 app_data_dir + zeroize。

### 4. 门禁
- crate：fmt / strict clippy / 62 测试全绿；Tauri：fmt / strict clippy / 165 测试全绿；前端 230 全绿 + tsc + build；oracle `tsc -p tests/oracle-tsconfig.json` 零错误；`cargo deny` advisories/bans/licenses/sources 全 ok（num-bigint MIT/Apache-2.0 合规）。

## 已完成（第二批收尾，2026-09-03）

### 5. 长尾路由全量实现（115/115）
- 13+1 条补齐：DJ 分类/推荐/节目榜/订阅/个性化电台、歌曲百科/相关播客/详情聚合、
  智能播放列表、相关歌单（公开 HTML regex 解析）、批量专辑封面、相似艺人、
  explore-next 无限推荐（批次轮换地区+去重补池）、updatePlaylistCover（NOS 上传：
  token alloc → 裸传 yyimgs → cover/update）。
- 新增公开通道：public_get / public_post_form / public_get_text / raw_post_bytes；
  regex 依赖（MIT/Apache-2.0）。
- Tauri：14+1 新 command（IPC 契约 140），DTO/mapping/port 补齐；deny 全过。

### 6. UI 全量消费（功能可用闭环）
- HomeView：banner 轮播 + 探索发现无限流（explore-next 分批加载、去重、加载更多）。
- SearchView：热搜词（点击填充）+ 搜索建议（songs 联想）。
- DetailView（playlist）：相关歌单区块。
- NeteaseLibraryView：收藏艺人/专辑/MV 子列表。
- DiscoverView：DJ 分类 tab（热门/分类/推荐/节目榜/我的订阅）+ **MV 播放**（video 播放器，
  分辨率 1080→720→480→240 降级，替代原「接线中」占位）。
- 前端 230 测试全绿（含 MV 播放新断言）、tsc 零错、build 成功、IPC 140 契约验证通过。

## 剩余（关闭切片阻断项）

1. **真实账号矩阵验收**（任务 6）：普通/VIP/过期/风控账号的关键路径实测（登录、VIP 音质、
   权益过期 fail-closed、风控）需用户本机凭据；按规范凭据不入库、不写日志，验收后更新
   账号验收记录。
2. 联网对拍建议：设备 Cookie 画像/xeapi 头/公开网页解析在真实网络下与 oracle 对拍。
