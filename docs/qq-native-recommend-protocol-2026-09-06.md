# QQ 音乐推荐页原生协议调查（2026-09-06）

## 结论

通过 MuMu 中 QQ 音乐 20.8.0.8 的只读 APK 分析、页面截图和同账号 MusicU 验证，WaveForge 已接入两条手机客户端数据源：

```text
music.recommend.RecommendFeed.get_recommend_feed
music.musicHall.MusicHallHomePage.GetHomePage
```

请求采用 Android 20.8.0.8 环境：

```json
{ "ct": 11, "cv": 20080008, "platform": "android" }
```

Cookie、Token、UIN、签名、设备标识、追踪串和完整响应不写入文档或浏览器缓存。前端只收到渲染字段、白名单动作以及账号绑定的短期随机反馈句柄。

## 推荐流

响应结构为 `v_shelf -> v_niche -> v_card`。分页使用 `direction`、`page`、`s_num`、`client_time`、`v_cache`、`v_uniq` 和 `load_mark`；每次“加载更多”串行读取最多五批，并把成功批次立即合并进现有专属乐流。

栏目刷新使用服务端下发的：

- `ModuleID`
- `Page`
- `LayoutTrace`
- `LayoutSeq`
- `ShelfID`
- `ExtraInfo`

标题使用 `title_template`，将 `{String}` 替换为 `title_content`。同一 shelf 按稳定 shelf ID 合并，动态标题变化不会产生重复栏目。

## 账号入口

当前客户端可下发以下入口：

| 入口 | subtype/style | WaveForge 行为 |
|---|---|---|
| 用户/AI 身份卡 | 712/203 | 显示账号头像；仅打开白名单内的 QQ 官方 HTTPS H5 |
| 猜你喜欢 | 711/201 | 获取账号 99 号电台并连续播放 |
| 每日30首 | 510/202 | 打开当天动态账号歌单，稳定保存 30 首快照 |
| 雷达模式 | 991/202 | 使用 `EntranceSongs/Page/ReqType` 请求雷达歌曲 |
| 百万收藏/新歌推荐/歌手漫游 | 513/202 | 打开服务端下发的推荐歌单 |
| 自定义 | 11/209 | 读取并保存 QQ 账号推荐偏好 |

自定义偏好接口：

```text
music.recommend.RecommendWidget.GetForyouConfigItems
music.recommend.RecommendWidget.SaveForyouConfigItems
```

保存时只提交相对打开弹窗时发生变化的条目，成功后刷新推荐流。

## 推荐卡型

已验证并实现：

- `200:0:208`：36 首、三行横向歌曲架，显示收藏状态和收藏数。
- `200:0:301`：专属乐流单曲卡。
- `500:0:302`：专属乐流歌单卡。
- `200:206:304`：三曲组合卡，每首歌独立播放、右键和收藏。
- `1100:1100:206`：运营推荐卡，以服务端字段安全展示。
- `-1:-100:211`：客户端直播入口，以不可执行摘要展示。
- `217` 星光卡：涉及客户端粉丝/购买能力，以不可执行摘要展示。

歌曲右键前会通过 `music.pf_song_detail_svr.get_song_detail_yqq` 补齐真实 MID、专辑和歌手信息，避免把占位 Song 传入全局菜单。

## 推荐反馈

反馈选项与提交接口：

```text
music.feedback.RecommendFeedback.GetRecommendConfigFeedBackItems
music.feedback.RecommendFeedback.ReportConfigFb
```

原始 CardModel、实验字段、`Trace`、`CommInfo` 等仅保存在服务端内存，30 分钟过期并按账号指纹绑定。浏览器只获得随机 `feedbackToken`、随机 option token 和可显示标题；提交时服务端还原 QQ 原始选项。真实账号只读验证已成功返回九个反馈原因，验收过程中未提交任何会改变账号推荐的反馈。

## 音乐馆

`GetHomePage` 的最小已验证参数为：

```json
{ "ShelfId": [], "Style": 2, "IsSupportDolby": 0 }
```

栏目名称和顺序完全由服务器决定。实测每次返回十个动态栏目，可能包括快捷入口、编辑甄选、新歌、新碟、数字专辑、排行榜、音乐人、分类专区、直播和精选视频等。前端按服务端顺序渲染，并按内容类型使用不同布局。

白名单动作：

- 歌曲：直接播放或先补全详情。
- 歌单：打开 WaveForge 歌单详情。
- 专辑：打开 WaveForge 专辑详情。
- 榜单：打开 WaveForge 榜单详情。
- MV：打开 WaveForge QQ 视频播放器。
- 网页：仅允许 HTTPS 且域名属于 QQ 或 Kugou。
- 未确认的深链、AI 指令、购买、粉丝、跨应用和游戏动作：显示但禁用。

原有 Skills AI 歌单、社区歌单、排行榜、新歌和电台仍作为补充区保留；Skills AI 首页显示 12 个。

## 缓存与并发

- 缓存按 QQ userId 隔离；无 userId 时使用 Cookie 指纹，缓存不保存 Cookie。
- Daily 30 歌单详情使用请求级 Cookie，服务端缓存也按账号指纹隔离。
- 普通推荐刷新不会替换同日成功的 Daily 30。
- 初始化、整页刷新、栏目刷新和五批分页互斥，避免互相取消后留下 loading。
- 前端原生请求具有 25 秒超时；服务端 MusicU 请求具有 20 秒超时。
- MusicHall 失败不会清空成功的账号推荐流。

## 安全与平台边界

- 不执行任意 `qqmusic://` scheme，不向浏览器透传上游 scheme。
- 不模拟无法独立访问的 QQ AI Assistant、PAG 运行时、购买、粉丝、游戏或跨应用能力。
- 静态封面和透明 mask 可复现；QQ 客户端私有 PAG 动效无法在 Web/Electron 中保证像素级一致。
- 原生接口属于非公开客户端协议，QQ 音乐升级后需用脱敏 fixture 回归模块名、字段、卡型和动作。
