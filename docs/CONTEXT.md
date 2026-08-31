# HyperPlayer

现代化 Windows 桌面音乐播放器的统一语言（Tauri 2 + React/TS + Rust 引擎）。规划文档与决策记录见 `docs/`。

## Language

**Web 前端（Web Frontend）**:
React + TypeScript 构建的 UI，运行在 Tauri 承载的系统 WebView2 中；只通过显式 commands/events/channel 与 Rust 通信。
_Avoid_: 渲染进程、浏览器页、Electron renderer

**Tauri 应用层（Tauri Application Layer）**:
Rust 桌面适配层：窗口、托盘、生命周期、权限、更新、系统集成和 command 编排；不承载音频、曲库或音源领域规则。
_Avoid_: 主进程、Node 后端、业务后端

**Command**:
前端调用 Rust 的有界请求/响应入口；输入输出使用显式 serde DTO 并做参数校验。
_Avoid_: IPC API、任意调用

**Event/Channel**:
Rust 向前端持续发送播放状态、进度、扫描进度和长期任务状态的通道。
_Avoid_: 轮询接口

**引擎 crate（Engine Crate）**:
框架无关的 Rust 领域核心，拥有音频解码、DSP、WASAPI 输出，以及曲库扫描、lofty 元数据和 rusqlite 存储；不依赖 Tauri。
_Avoid_: Tauri 后端、应用层

**DSP 管线**:
引擎内 PCM 流经的处理链；用户自研 DSP 效果在此插入，是一等公民，任何引擎改动不得破坏其插入点。
_Avoid_: 音效模块（指单个效果实现）

**音源模块（Source Module）**:
官方内置的在线音源实现，独立隔离、可整体禁用，不与引擎播放管线耦合。网易云协议、网络、Cookie 和设备会话终态位于 Rust 后端。
_Avoid_: 插件（保留给未来社区扩展体系）

**行为 oracle（Behavior Oracle）**:
现有 Cleanroom TypeScript 网易云实现及其 PoC，用于验证 Rust 迁移后的输入、输出与边界行为等价；不是 Tauri 运行时组件。
_Avoid_: 最终音源实现、Node sidecar

**曲库（Library）**:
本地音乐文件的扫描索引与元数据集合，存于 SQLite，由 engine/domain crate 拥有。

**内容域模式（Content Mode）**:
决定主界面当前浏览和导航的数据来源。HyperPlayer 有网易云模式与本地模式；切换模式不改变或中断共享播放状态。
_Avoid_: 播放模式、音源切换（播放队列可混合来源）

**网易云模式（NetEase Mode）**:
默认内容域，首页和导航以网易云推荐、歌单、榜单、账号内容为主。
_Avoid_: 在线播放器（应用仍是同一个播放器）

**本地模式（Local Mode）**:
以本地曲库、文件夹、专辑、艺术家和扫描管理为主的内容域。
_Avoid_: 离线模式（它不代表网络断开）

**公共播放缓存（Public Cache）**:
服务端确认可免费完整播放的官方音频流缓存，不绑定网易账号；受最近播放和容量淘汰策略管理。
_Avoid_: 下载、离线音乐

**账号权益缓存（Account-Entitled Cache）**:
由特定网易账号的 VIP/付费权益创建的受控播放缓存。缓存必须绑定 ownerUserId，每次播放前重新验证当前账号身份、会员权益和歌曲权限。
_Avoid_: VIP 下载、公共缓存

**权益快照（Entitlement Snapshot）**:
缓存创建或最近一次验证时记录的账号、歌曲权限、音质与有效时间信息；它只用于审计和决定何时重新验证，不能单独作为播放授权。
_Avoid_: 授权令牌、永久权益

**锁定缓存（Locked Entitlement Cache）**:
文件仍存在，但因登出、切换账号、会员过期或权限校验失败而不可播放的账号权益缓存；可被优先淘汰。
_Avoid_: 失效下载

**专辑播放上下文（Album Playback Context）**:
由用户从专辑页或明确的专辑入口启动、并保持专辑曲序关系的播放会话。搜索单曲、歌单、随机电台和临时队列不属于该上下文。
_Avoid_: 当前歌曲所属专辑（仅元数据关系不足以构成上下文）

**有效专辑会话（Qualified Album Session）**:
从专辑播放上下文发起，并在一次会话中完整播放至少一首或累计有效播放五分钟；同一专辑同一自然日最多记录一次。
_Avoid_: 点击次数、单曲播放次数

**高频专辑（Frequent Album）**:
累计达到五次有效专辑会话、获得空闲时全专辑缓存资格的专辑。该资格不是永久下载承诺，仍受权益、容量和淘汰策略约束。
_Avoid_: 已下载专辑、收藏专辑

**封面氛围场（Artwork Atmosphere）**:
展开播放层以当前专辑封面放大、裁切和模糊后形成的环境背景；其职责是承载歌曲氛围并衬托封面与歌词，不是独立装饰特效。
_Avoid_: 动态渐变背景、光效背景

**播放层（Now Playing Layer）**:
由底部播放坞连续展开的沉浸界面，封面与逐字歌词是双主角；展开不改变播放上下文。
_Avoid_: 播放页面（它不是割裂的独立路由）

**下一首预取（Next-Track Prefetch）**:
当前曲播放期间，高优先级获取并准备队列中的下一曲；除了缓存网络数据，还包括创建 standby decoder 和预填 PCM ring buffer。
_Avoid_: 后台下载

**专辑补全（Album Fill）**:
对高频专辑在系统和网络空闲时低优先级补齐尚未缓存的曲目；切换上下文或资源受限时可取消。
_Avoid_: 专辑下载、离线专辑

**桥（Bridge）**:
Web 前端与 Rust 之间的 Tauri commands/events/channel 边界；Tauri 应用层负责 DTO 转换和生命周期编排。
_Avoid_: Electron IPC、napi-rs、Node 桥
