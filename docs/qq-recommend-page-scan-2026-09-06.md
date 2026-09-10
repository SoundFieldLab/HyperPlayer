# QQ 音乐推荐页脱敏扫描报告

扫描日期：2026-09-06
应用：QQ 音乐 20.8.0.8（com.tencent.qqmusic）
设备：MuMu Android 12，1080x1920，280 dpi

## 1. 页面结构

推荐页根结构：

```text
AppStarterActivity
└─ MainDeskViewPager
   └─ MainDesckChildViewPager
      └─ MusicHallCellRecyclerView
```

已确认的容器：

- 顶部入口：`BlockRoomRecyclerView`
- 顶部猜你喜欢实现：`GuessYouLikePagView`
- 动态推荐列表：`BlockGridRecyclerView`
- 下拉刷新：`RefreshHeaderLayout` / `RefreshHeaderView`
- 继续加载：`MusicHallLoadMoreFooter`

顶部卡片区域是横向虚拟化容器，不是一次性平铺所有入口。逐屏横向展开后确认共有 6 个入口。

## 2. 顶部六个入口

按实际横向顺序：

1. 猜你喜欢 - 沉浸刷歌
2. 每日30首
3. 雷达模式
4. 百万收藏
5. 新歌推荐
6. 歌手漫游

已读取到的卡片字段：

- 卡片无障碍描述：入口标题 + 当前代表歌曲/歌手
- 卡片标题/副标题
- 当前代表歌曲
- 播放入口
- 卡片图片
- 卡片类型视觉标签

已确认的示例标签：

- 猜你喜欢：`For You`
- 每日30首：`Daily 30`
- 雷达模式：`Fav Radar`
- 百万收藏：`Top Fav`
- 新歌推荐：`New Songs`
- 歌手漫游：`Star Mix`

顶部卡片通用资源 ID 线索：

- 主卡标题：`d61`
- 主卡副标题：`d62`
- 主卡图片：`d67`
- 主卡播放：`d69`
- 每日30首卡片标题：`myw`
- 每日30首卡片副标题：`myx`
- 每日30首卡片图片：`mz0`

HyperPlayer 适配结论：猜你喜欢和每日30首使用同等尺寸；其余四项也作为真实入口卡片展示，不能用公共歌单替代。卡片中的“30首连续推荐”属于实现描述，应删除。

## 3. 刷新前后结论

已在推荐页顶部完成一次标准下拉刷新，并在稳定等待后保存 XML、截图和日志摘要。

### 猜你喜欢

刷新前后代表歌曲可能变化。例如本次基线与刷新后代表歌曲不同，说明猜你喜欢属于动态账号推荐流。不能使用固定本地数组或只旋转当前数组模拟。

### 每日30首

刷新前后标题保持“每日30首”，当天标记保持“今天更新”，代表日推内容没有随普通首页推荐刷新而整体替换。它应按自然日独立缓存。

### 下方动态推荐

刷新后模块中的标题、代表歌曲和歌单搜索卡发生变化。例如：

- “听「COCOON」也会喜欢”/“听「エトセトラ」也会喜欢”会变化
- “从你的红心歌曲开始探索”会保留模块语义，但歌曲内容会变化
- “你的惊喜好歌”中的歌曲会变化
- 右下角搜索推荐词会变化

结论：下方动态推荐与猜你喜欢属于同一次推荐 feed 刷新语义，应由一个推荐流刷新动作协调更新；每日30首不要跟随该动作替换。

## 4. 动态推荐模块类型

已完整下滑到当前加载末端附近，确认推荐页不是固定两块，而是连续分页的混合模块流。

### 歌曲横向模块

每个模块通常包含 3 首主要歌曲，横向列表还会虚拟挂载下一组内容。每首歌曲可包含：

- 封面
- 歌曲名
- 歌手
- 收藏状态
- 播放按钮
- 热度/评论/榜单/好友关系标签

已观察到的模块语义：

- 听「某首歌」也会喜欢
- 听「某首歌」的也在听
- 从你的红心歌曲开始探索
- 这是你的宝藏好歌
- 这是你的惊喜好歌
- 反复/听完某首歌后推荐
- 听感 DNA 高度匹配
- 同频好歌速领
- 本月新歌
- 好友关注歌手
- 一定比例的人听完
- 某榜单名次/昨日热播/本周热播

### 歌单/精选模块

混合流中还会出现歌单卡，字段包括：

- 歌单标题
- “包含某首歌”等推荐原因
- 播放量
- 收藏量
- 播放入口
- 歌单标识

观察到的语义包括：

- 基于某首歌精选
- 某风格/场景歌单
- 大家都在听
- 收听量和收藏量

### 搜索/活动卡

流中出现搜索推荐卡和活动入口，例如：

- 搜索某歌手近期循环
- 搜索某歌曲为你推荐
- 新歌发行抢先收听
- 听歌识曲
- 看广告赚金币
- 元宝

这些内容不能直接映射为普通 Song，需要单独的 card union 类型；不支持的活动卡应跳过或以非交互摘要显示。

## 5. 用户专属乐流

已确认页面存在：`「YoShiNo」的专属乐流`。

它不是单一歌单，而是账号级混合 feed，观察到：

- 歌曲卡
- 以某首歌为上下文的 3 首精选
- 歌单卡
- 好友关注/收藏关系
- 榜单名次
- 收藏量、播放量、评论量
- VIP/绿钻标记
- “更多”入口

页面出现“上拉查看更多专属推荐”，说明该模块具备分页/继续加载语义。

HyperPlayer 适配结论：应建独立 `personal-feed` 模型和区块，不能把它压成 `Song[]`，也不能伪装成推荐歌单。feed 游标必须与猜你喜欢连续播放的 batch 分开。

## 6. 可直接实现的数据模型

建议新增版本化 QQ 专属模型：

```ts
interface QQExploreFeed {
  schemaVersion: 1
  accountScoped: boolean
  generatedAt: number
  refreshToken?: string
  hasMore: boolean
  modules: QQExploreModule[]
}

type QQExploreModule =
  | { type: 'entry'; id: string; title: string; label?: string; song?: Song; action: QQEntryAction }
  | { type: 'song-row'; id: string; title: string; reason?: string; songs: Song[]; refreshable: boolean }
  | { type: 'playlist'; id: string; title: string; reason?: string; playlist: ExplorePlaylist }
  | { type: 'personal-feed'; id: string; title: string; items: QQFeedItem[]; cursor?: string; hasMore: boolean }
  | { type: 'search-prompt'; id: string; query: string; subtitle?: string }
  | { type: 'unsupported'; id: string; rawType?: string }

type QQFeedItem =
  | { type: 'song'; song: Song; badges?: string[]; personalized: boolean }
  | { type: 'song-trio'; title?: string; songs: Song[]; reason?: string }
  | { type: 'playlist'; playlist: ExplorePlaylist; reason?: string }
```

每个模块至少保留：`id`、标题、资源类型、账号级标记、来源、降级标记、分页/刷新能力。

## 7. HyperPlayer 刷新设计

- 顶部六张入口卡是入口，不挂整页“换一批”。
- 下方动态推荐流提供一个“换一批/刷新推荐”按钮。
- 该按钮刷新猜你喜欢摘要和动态推荐模块，但不替换每日30首。
- 猜你喜欢连续播放使用独立 batch + exclude 集合。
- 专属乐流使用独立 feed cursor/分页状态。
- 每日30首按自然日缓存；进入入口时单独加载或刷新。
- 刷新失败保留最后成功快照，只显示模块级错误。
- 公共数据降级必须标记 `personalized=false`、`degraded=true`，不能把公共新歌或榜单伪装成账号推荐。

## 8. 接口调查结论

当前通过 ADB、View hierarchy 和脱敏 logcat 未取得 QQ 音乐网络 method/path 或完整响应协议。原因：

- 业务日志没有输出请求路径和模块 JSON。
- 卡片大量使用自定义 View/动态渲染。
- UIAutomator 能读取可访问文本，但不能还原网络请求。

HyperPlayer 现有可复用能力：

- QQ 电台 99：猜你喜欢歌曲流
- `/api/explore/qq/radio/next`：连续歌曲批次
- QQ Music Skills：每日30首、AI 歌单、听歌报告、AI 解读
- 通用歌单详情、榜单详情、播放和收藏动作

现阶段不能声称已经获取到 QQ 原生首页 feed 接口；实现应先使用已验证的模型和明确降级，再逐步接入新增的公开只读字段。

## 9. 扫描限制

本次已完成：

- 顶部入口横向展开并确认六项
- 推荐页多屏纵向扫描
- 动态歌曲与歌单混合模块识别
- 专属乐流识别
- 顶部下拉刷新前后对比
- 可访问文本、资源 ID 和 View 类型整理

仍无法仅通过当前安全范围确认：

- 原生首页 feed 的网络 URL、请求体和响应 schema
- 模块稳定 ID 与实验参数
- 客户端内部 refresh token/cursor
- 视觉卡片未暴露的部分字段

未进行：私有目录/数据库读取、凭据导出、root、Hook、抓包、证书固定绕过、APK 反编译。
