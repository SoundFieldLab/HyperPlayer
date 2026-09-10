# 网易云音乐 Android 推荐页逆向记录（9.5.81）

> 目标：HyperPlayer 的网易云探索页使用网易云手机客户端的原生推荐流语义，不再用若干公开接口拼装固定首页。
>
> 样本：MuMu 模拟器，`com.netease.cloudmusic`，`versionName=9.5.81`，`versionCode=9005081`。

## 证据等级

- **已证实（APK）**：来自 9.5.81 APK 的 smali、资源或内置缓存。
- **已证实（运行）**：来自 ADB Activity、UIAutomator、logcat 或实际播放来源。
- **已证实（响应）**：使用 APK 中恢复出的 URI、参数与加密方式获得的真实响应。
- **待补**：因同一模拟器当时由另一个任务操作 QQ 音乐，为避免抢占前台而暂停的点击验证。

## 推荐页整体协议

### 主 Feed

**已证实（APK、响应）**

- URI：`/api/homepage/block/page`
- 协议：`weapi`
- 普通请求路径在客户端内部写作 `homepage/block/page`；全量重载作为 batch 子请求时使用带 `/api/` 的绝对路径。
- batch 子请求头：`CMPageId: MainActivity`
- 请求标签：`main_page_feed`
- 强制网络请求附加本地 batch header：`x-mr: 1`
- 请求字段：`cursor`、`adextjson`、`refresh`、`extInfo`（JSON 字符串）。
- 请求状态由 `DiscoveryDataRequest` 保存：`reloadAll`、`forceRefresh`、`forceRequestNet`、`isFirstLoad`、`portalVersion`、`pageExtInfo`。

`extInfo` 字段由 `PageExtInfo.toJson()` 生成，包含：

- `netstat`：1 Wi-Fi，2 蜂窝网络
- `lan`、`lat`、`lon`：位置可用时写入
- `guideToastLastShow`
- `carrier`
- `abInfo["hp-new-homepageV3.1"]`
- `titles`
- `exposedResource`
- `blockCodeOrderList`
- `triggerList`
- `requestLongVideoBanner`
- `refreshType`：是否刷新 VIP 卡
- `forceFreshForNewUser`
- 运行时追加的 extra map

响应主结构：

```text
data {
  cursor, blocks[], hasMore, blockUUIDs, pageConfig, guideToast,
  internalTest, titles, blockCodeOrderList[], exposedResource, demote
}
trp
xHeaderTraceId
```

客户端先解析 `trp` 和 `xHeaderTraceId`，再调用 `DiscoveryBlockData.fromJson(data)`。最终不是按收到顺序简单追加，而是用 `blockCodeOrderList` 重建页面。响应缓存键为私有 SharedPreferences 中的 `discoveryPageBlockList2`，旧版回退键为 `discoveryPageBlockList`。

### 首页无限流

**已证实（APK、响应）**

- URI：`/api/homepage/block/page/unlimited/flow`
- 协议：`weapi`
- 请求体：空对象
- 响应：`data.hasMore + data.resources[]`
- 每批实测返回 8 项
- 播放来源：`HP-Flow`
- 资源字段包含 `resourceType`、`resourceId`、`coverImageUrl`、`targetUrl`、`playUrl`、`startTime`、`endTime`、`mainTitle`、`subTitle`、`resourceInteractInfo`、`resourceInfoList`、`extInfo`、`alg`、`logInfo`、`songData`、`song`、`crossPlatformConfig`。
- 实测资源类型有 `LYRIC`、`MV`、`COMMENT`、`PLAYLIST`。

它不是主 Feed 的下一页，也不能被“推荐歌单”替代；它是首页内单独的连续混合内容流。

### 每日播客入口与播客首页

**已证实（APK、响应）**

每日播客顶部入口使用专属接口：

- URI：`/api/my/podcast/tab/recommend`
- 参数：`scenePageCode=PAGE_MY_PODCAST`、`blockCode=MY_PAGE_PODCAST_RECOMMEND`
- 返回：`VoiceListModel[]`

完整播客推荐页使用另一条 Feed：

- URI：`/api/podcast/home/tab/v2/get`
- 协议：`weapi`
- 参数：`pageCode=PODCAST_TAB_V2`、`subParams`
- RN 包：`rn-podcast-home-recommend@index`
- 实测返回 9 个 `blockVOS`：`EDITOR_PICK_BLOCK`、`FINITE_DRAGONBALL`、`RCMD_FOR_YOU`、`FINITE_CHARTS_BLOCK`、`NEWEST_GOOD_VOICE_BLOCK`、`FRIEND_ARTIST_BLOCK`、`HOTTEST_VOICELIST_BLOCK`、`MODULE_YOUR_LIKE_CATEGORY_VONE_PODCAST`、`MODULE_EXPLORE_MORE_VONE`。

因此“每日播客/从你喜欢的音乐听播客/热门节目/有声书”不能只用旧 DJ toplist 模拟。

## 区块渲染机制

**已证实（APK）**

客户端支持四条渲染路径：原生 `showType` 解析器、v3 动态 Block、`RNBlock`、`crossPlatformConfig.dslContent` 服务端 DSL。

主要 `showType -> model`：

| showType | 模型/用途 |
|---|---|
| `DRAGON_BALL` | 顶部快捷入口 |
| `BANNER` | Banner |
| `HOMEPAGE_SLIDE_SONGLIST_ALIGN` | 多列歌曲推荐（含语言/风格偏好） |
| `HOMEPAGE_SLIDE_PLAYLIST` | 横向歌单 |
| `HOMEPAGE_BLOCK_PLAYLIST_RCMD` | 推荐歌单 |
| `HOMEPAGE_SLIDE_TOPLIST` | 排行榜 |
| `HOMEPAGE_SLIDE_TAB_TOPLIST` | 带 Tab 的排行榜 |
| `HOMEPAGE_NEW_SONG_NEW_ALBUM` | 新歌新碟 |
| `SLIDE_MUSICPODCAST_VOICE` | 音乐关联播客 |
| `SLIDE_PODCAST_VOICE_MORE_TAB` | 播客/有声书多 Tab |
| `DOUBLE_RCMDLIKE_VOICELIST` / `SLIDE_RCMDLIKE_VOICELIST` | 推荐节目 |
| `SLIDE_VOICE_LIST` / `SLIDE_HOT_VOICE_LIST` | 播客列表 |
| `YUNCUN_PRODUCED` | 云村原创 |
| `SHUFFLE_MUSIC_CALENDAR` | 音乐日历 |
| `HOMEPAGE_FIXED_PLAYABLE_RESOURCE` | 可播放资源 |
| `HOMEPAGE_SLIDE_PLAYABLE_RESOURCE_SQUARE` | 方形场景/助眠资源 |
| `HOMEPAGE_SLIDE_PLAYABLE_MLOG` | Mlog |
| `HOMEPAGE_FIXED_LISTEN_LIVE` / `HOMEPAGE_SLIDE_LISTEN_LIVE` | 直播 |
| `HOMEPAGE_LOCAL_CUSTOM_RN` | RN 自定义区块 |

HyperPlayer 必须保留原始 `blockCode/showType/crossPlatformConfig/dslData/rnData/nativeData`。未知模块应降级成通用资源卡，而不是丢弃。

## 顶部入口

### 每日推荐

**已证实（运行、APK）**

- Activity：`com.netease.cloudmusic.module.dailyrecomm.DailyRecommendMusicActivity`
- 主请求：`v3/discovery/recommend/songs`
- 参数：`ispush`
- 页面包含日期、历史日推、播放全部、默认推荐/风格推荐、歌曲“不喜欢”、双人推荐入口。
- 客户端文案：每天 6:00 更新。
- 历史最近：`discovery/recommend/songs/history/recent`
- 历史详情：`/api/discovery/recommend/songs/history/detail`，参数 `date`。

### 心动模式

**已证实（运行、APK）**

- 点击后直接进入 `PlayerActivity`，不是列表页。
- URI：`playmode/intelligence/list`
- 参数：`songId`、`type=fromPlayAll|fromPlayOne`、`playlistId`、`startMusicId`、`count`、`extJson`。
- 客户端请求超时：5000 ms。
- 语义是以“我喜欢”歌单中的起点歌曲为锚点，在红心歌与相似推荐间延展。

### 漫游

**已证实（运行）**

- 点击后直接进入 `PlayerActivity`。
- 页面标题：`私人漫游 · 默认模式`。
- `PlayExtraInfo.sourceType=105`，来源名“私人漫游”。
- 实测算法：`alg-music-rec-unite-userFm-...-default`。
- 本质是统一推荐系统的 user FM 流，不是普通歌单。

### 雷达歌单

**已证实（APK、首页 UI）**

- 首页下发该用户的雷达歌单资源，点击按 `orpheus://playlist/<id>` 打开普通歌单详情。
- 客户端通过远程配置 `playlist#radar_playlist_name` 获取 `playlistId -> playlistName` 覆盖表，不应写死名称或 ID。
- 当前账号 UI 实测包含私人、时光、宝藏、怀旧等雷达，均为账号生成内容。

### 相似歌曲 / 相似用户（服务端也可动态下发“相似艺人”）

**已证实（APK）**

客户端固定相似页为 `SimilarRecommendActivity`（路由 `page_similar_recommend`），以当前播放歌曲 ID 为输入，同时 batch：

- `/api/v1/discovery/simiSong`
- `/api/discovery/simiPlaylist`
- `/api/discovery/simiUser`

三者参数都是 `{'songid': <当前歌曲ID>}`。固定相似页展示相似歌曲、相似歌单和相似用户（Profile）；服务端 DSL 另有 `similarArtist` action，可动态提供真正的相似艺人入口。没有当前歌曲时不能生成同样结果。

### Dragon Ball 封面组合机制

**已证实（APK、实现）**

- 普通快捷入口直接使用服务端 `uiElement.image.imageUrl`；`purePicture=true` 时优先使用 `purePictureUrl`，`purePicName` 用于识别客户端语义层。
- 客户端允许在服务端主体图片上叠加打包 drawable、遮罩、文字和状态；每日推荐会通过 `Canvas.drawText` 绘制当天日期。
- 未发现客户端把任意专辑封面拼成快捷入口马赛克的证据。HyperPlayer 因此保留服务端图片作为主体，仅实现有 APK 证据的日期/状态组合；缺图时使用稳定语义降级，不伪造专辑拼图。

### Dragon Ball 引导

- URI：`homepage/block/dragon/ball/guide/get`
- 参数：`logInfo`、`clickLogInfo`
- 顶部入口本身来自 `DRAGON_BALL` block，action 由服务端下发。

## 模块个性化分类

| 模块 | 分类 | 依据 |
|---|---|---|
| 每日推荐、心动模式、私人漫游 | 账号生成 | 依赖登录、红心、历史及 user FM |
| 根据你喜爱的歌曲推荐 | 账号生成 | 首页 block 的歌曲推荐算法及曝光上下文 |
| 猜你喜欢的某语言好歌 | 账号生成 | `HOMEPAGE_BLOCK_STYLE_RCMD` / 歌曲 block，标题和语言由服务端决定 |
| 推荐歌单 | 混合 | 登录时个性化召回；匿名也有公共降级 block |
| `<用户名>的雷达歌单` | 账号生成 | 账号歌单和远程雷达配置 |
| 排行榜 | 通用为主 | 榜单本体通用，选择/排序可能由首页策略调整 |
| VIP 限免 | 账号/权益相关 | `PAGE_RECOMMEND_VIP_MODULE`、`PAGE_RECOMMEND_VIP_SMALL_CARD` |
| 艺人热门、影视原声、心情氛围、场景歌单 | 混合 | 资源可公共，模块出现与排序由推荐流决定 |
| 从喜欢的歌曲/艺人开始漫游 | 账号生成 | 需要历史歌曲或艺人作为种子 |
| 从喜欢的音乐听播客、热门节目 | 账号生成 | 音乐偏好/收听历史召回 |
| 精品有声书、广播 | 混合 | 公共资源 + 个性化排序/算法标识 |
| 关注艺人新动向 | 账号生成 | 关注关系 |
| 每周趋势、原创歌曲 | 通用或弱个性化 | 内容池通用，位置/挑选可个性化 |

广告/商业插卡不在 HyperPlayer 的复刻范围。

## 当前样本与限制

- 已完整滚动推荐页 13 个采样点并到达页尾。
- 已采集每日推荐、心动模式、私人漫游的 Activity/运行行为。
- 另一个任务随后把同一模拟器前台切到 QQ 音乐；为避免干扰，雷达及后续入口点击已停止。
- 模拟器无 root，应用不可 `run-as`；`tcpdump` 存在但 shell 无 raw socket 权限。
- 当前 HyperPlayer Electron 会话只有匿名 `MUSIC_A`，没有模拟器账号的 `MUSIC_U`，所以不能把匿名响应冒充当前账号完整推荐。
- 私有响应样本位于本地逆向目录 `.netease-reverse/responses/`，不提交账号 Cookie。

## HyperPlayer 实现约束

1. 网易云使用独立 native feed 模块，不与 QQ 推荐协议混用。
2. 后端直接调用上述私有 URI；公共 `personalized/toplist/dj_*` 只能作为故障降级，不能成为主页面。
3. 页面按服务端 block 顺序渲染，不硬编码截图中的歌曲或用户名。
4. 请求缓存必须按 Cookie 指纹隔离，不能持久化 Cookie。
5. 保留原始 block 和未知字段以兼容服务端新增模块。
6. action 优先解析服务端 `orpheus`/`action`；当前客户端不支持的 action 显示为不可用，而不是错误跳转。
7. 歌曲推荐区块按手机客户端语义重排为横向列，每列固定三行；桌面端保留非整数可见列数，让下一列稳定露出。
8. “是否已喜欢”以登录账号的完整 `song/like/get` ID 集合为权威；Feed 的 `collect/starred` 仅作为加载前提示。评论/视频语境的 `resourceInteractInfo.liked` 不得当作歌曲红心。
9. 公开红心数来自独立 `/api/song/red/count`，与账号收藏状态分离；前端仅为进入视口的歌曲分批请求。
10. 推荐歌单右键菜单只提供适用于服务端推荐资源的打开、收藏/取消收藏和分享；编辑/删除仅属于本人歌单，匿名状态不显示不可执行的收藏命令。

## HyperPlayer 落地与最终自检

**已证实（实现、运行）**

- 新增独立后端模块 `server/netease-native-explore.mjs`，主页、无限流、日推、历史日推、风格日推、漫游、心动模式、相似推荐、节目详情、每日播客和播客首页均直接调用逆向恢复的移动端 URI。
- 新增 `src/features/neteaseExplore/`，按照 `blockCodeOrderList` 和 `showType` 渲染服务端区块；原始 block、未知字段及未知资源仍被保留。
- 捕获的主页、无限流与播客响应共 173 个资源全部解析成明确动作；匿名实时桌面样本渲染出 189 个 `data-resource-id` 动作目标。
- 已覆盖歌单、歌曲、专辑、数字专辑、节目、播客、MV、评论、艺人、用户和安全 HTTPS 页面动作；歌单详情实测加载 81 首歌曲，包含歌手、专辑、时长及播放控制。
- 节目 `3715608827` 实测解析到 `mainSong=3363556036`（《拉车门进行曲》），节目音频可进入 HyperPlayer 统一播放链。
- 桌面实测点击歌曲后媒体会话得到真实曲名和歌手，并解锁基于当前网易云歌曲的相似推荐。
- 歌曲右键菜单实测包含播放、下一首播放、我喜欢、添加到、评论、专辑、歌手、歌曲详情、不感兴趣、相似歌曲和复制信息。
- 1280×800 桌面首屏已检查：顶部平台栏、账号提示、快捷入口、横向资源轨道和可见滚动条没有重叠；长内容由独立纵向滚动容器承载并保留播放条底部空间。
- 封面通过统一 `getApiBase()` 图片代理正常加载；NetEase native API、通用音乐 API 与歌单详情 API 也统一使用该可信运行时基址，避免设置了服务地址后部分功能仍请求旧地址。
- 快捷入口保留服务端 `imageUrl/purePictureUrl/purePicture/purePicName/rcmdShowType`，每日推荐按原生机制叠加当天日期，不生成无证据的专辑马赛克。
- 所有网易云横向区块复用同一轨道：隐藏原生滚动条，支持鼠标拖拽、阈值后 pointer capture、惯性投影、卡片吸附、拖后点击/右键抑制、键盘分页和 reduced-motion；左右按钮仅在对应边缘热区悬停且该方向可滚动时显示。
- 歌曲推荐按每列三行横向排列，行尾为歌曲红心而非播放三角；整行播放，歌曲与歌单均接入共享右键菜单。
- 登录态喜欢同步复用账号隔离缓存，完整喜欢 ID 列表加载后覆盖 Feed 旧快照；喜欢/取消喜欢采用 pending 去重、乐观更新和失败回滚，并同步“我喜欢”歌单数量。
- 公开红心数由新增的 `/api/netease/native/red-counts` 聚合 `/api/song/red/count`：最多 40 个唯一数字 ID、6 路并发、单项 8 秒超时、成功缓存 5 分钟并允许部分失败；前端只查询进入视口的歌曲，显示 `万+` / `亿+`。
- 相似歌曲、歌单和用户使用三个独立上游请求；每个子请求有 12 秒上限，一个失败不会阻塞其他成功结果，三类均为空时展示明确空状态。
- 请求切换使用 `AbortController`、请求序号和账号键防止旧账号响应覆盖新账号；主页缓存按不可逆 Cookie 指纹隔离，后端不持久化或回传 Cookie。
- 本轮聚焦回归测试为 36/36 通过（5 个测试文件）；全量 `tsc --noEmit` 通过；生产 Vite 构建成功。构建仅报告既存的大 chunk 体积警告。
- 1280×800 隔离页面截图确认 HyperPlayer 基础桌面布局无重叠；但 Browser Use 在加载完整长 Feed 后截图捕获失败，Computer Use 随后因 broker 连接中断不可用。因此本轮新增轨道的 1280×800、1440×900 明暗主题视觉验收未形成完整截图证据，不能记为人工视觉通过；交互行为由组件测试覆盖。

### 仍需真实账号才能验证的边界

- 当前最终桌面验收使用匿名响应。每日推荐、历史日推、风格日推、心动模式、账号雷达、关注艺人和精确个人口味区块的协议与界面已实现，但没有用有效 `MUSIC_U` 在 HyperPlayer 中完成账号态端到端验收。
- NetEase 可在未来下发当前样本未出现的新 RN、mini-program、v3 动态或 DSL action。已知 action 会映射到等价 PC 功能；未知 action 会明确不可用，不会伪装成功。
- 原生 Android 专属页面无法逐像素嵌入桌面应用；HyperPlayer 复刻的是同一服务端内容、顺序、语义和功能，并按 PC 交互重排，而不是照搬 1080×1920 手机尺寸。
- 同一模拟器仍可能被另一任务用于 QQ 音乐，因此后续未执行会抢占前台的 ADB 点击，不影响本记录中已完成的静态、协议、接口和桌面验证。
