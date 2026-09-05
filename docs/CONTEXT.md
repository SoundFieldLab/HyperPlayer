# HyperPlayer

现代化 Windows 桌面音乐播放器的统一语言（Tauri 2 壳 + 全 TypeScript 应用层）。工程基线见 `docs/架构基线.md`，UI 设计语言见 `docs/设计语言-apple.md`，UI 决策记录见 `docs/UI定调决策记录.md`。

## Language

**Web 应用层（Web Application）**:
运行在 Tauri 承载的 WebView2 中的 React/TypeScript 应用；拥有播放管线、协议服务、曲库与全部业务逻辑。
_Avoid_: 渲染进程、前端页面层（它不止是 UI）、Electron renderer

**壳（Shell）**:
Tauri 2 桌面适配层：窗口、托盘、生命周期、更新与系统能力，**零自定义 Rust**——只由官方/社区插件与配置构成。
_Avoid_: 主进程、Rust 引擎层、业务后端

**引擎（HSE）**:
HyperSoundEngine v1.5.1 纯 TypeScript DSP 引擎（vendored），经浏览器宿主以 AudioWorklet 接入，承担全部实时音频处理；Rust 支线已删除。
_Avoid_: 原生引擎、Rust DSP、sidecar

**冻结向量（Frozen Vectors）**:
HSE specs 附带的输入 PCM + 参数 → 期望输出 PCM 夹具；行为变更 = 新增向量，基线永不修改。CI 中作为 DSP 行为锁回归。
_Avoid_: 快照测试（指 UI）、对拍基线（那是 oracle 的职责）

**行为 oracle（Behavior Oracle）**:
WaveForge 现网实现，用于验证网易云协议层移植后的行为等价；不是运行时组件。
_Avoid_: 最终音源实现、参考代码（它有验收职责）

**服务层（Services）**:
无 React 依赖的 TypeScript 单例模块，持有网易云协议、曲库扫描、播放控制、DSP 参数等业务规则；组件只订阅状态切片并调用服务。
_Avoid_: hook 里的业务逻辑、组件内协议调用

**域切片（Domain Slice）**:
zustand 按域拆分的状态切片（playback/queue/library/netease/settings/ui），各自独立文件；禁止单文件巨 store。
_Avoid_: 全局单 store、分散的组件状态（指播放/队列态）

**高频态（High-Frequency State）**:
播放进度、逐字索引等以帧级频率进 zustand 的响应式状态；订阅必须窄选择器，只取所需单字段。
_Avoid_: 每帧全树渲染、绕开 React 的私有时钟

**音频源提供者（Source Provider）**:
向播放链供给音频流的抽象接口。两类实现：LocalFileSource（本地/缓存文件经 asset 协议）、NeteaseStreamSource（直链直播 + 边播边缓存）。
_Avoid_: 硬编码 src、下载器（不存在"先下后播"）

**PCM 升级闸门（PCM Upgrade Gate）**:
MediaElement 起步的全 PCM 管线预留升级点：M3 后若无缝/预取质量不达标，局部引入 WebCodecs/PCM 管线而不推翻播放链结构。
_Avoid_: 一步到位重写、无缝承诺（MediaElement 阶段不承诺无缝）

**分析 tap（Analysis Tap）**:
接在 HSE 节点之后、输出增益之前的独立分析 AudioWorkletNode；计算波形/频谱带并以覆盖式发帧供可视化消费，不阻塞音频。
_Avoid_: Rust telemetry 通道、postMessage 背压 ACK

**胶囊坞（Capsule Dock）**:
底部悬浮胶囊形常驻播放坞：封面、歌名/歌手、播放三键、队列入口、音量弹出滑杆、底边细进度条；点击封面连续展开为播放层。取代旧贴底整宽坞。
_Avoid_: 迷你播放器（辅助窗口已砍除）、Dock 栏（macOS 语义）

**播放层（Now Playing Layer）**:
由胶囊坞连续展开的沉浸界面，42/58 封面与逐字歌词双主角；展开不改变播放上下文。
_Avoid_: 播放页面（不是割裂的独立路由）

**材质（Material）**:
半透明功能性浮层（自绘标题栏/侧栏/胶囊坞/浮出面板），内容从其下滚过；重量分级（大表面重 blur+深阴影，小芯片轻）；永不久轻玻璃叠轻玻璃。参数基线见设计语言-apple。
_Avoid_: 玻璃卡片墙、多层 blur、不透明假材质

**主动作（Primary Action）**:
每屏至多一个的 Hyper Blue pill CTA；次级/工具动作一律 8px utility 矩形。
_Avoid_: 多主按钮、渐变按钮、无 pill 的主动作

**流体弹簧（Fluid Springs）**:
全应用动效基座：可中断弹簧（默认临界阻尼 bounce 0），momentum 手势带轻微 bounce 与释放速度交接；pointer-down 即时反馈；进出场同路径。_Avoid_: 固定时长手势动画、不可中断过渡、GSAP

**双栈导航（Dual-Stack Navigation）**:
自研导航切片：网易云/本地两个内容域各自维护 entry 历史栈（routeId + 实体 ID + 快照）；瞬时层（播放层/面板/命令面板）不进栈。
_Avoid_: react-router、URL 路由（桌面无 URL 消费方）

**内容域模式（Content Mode）**:
决定主界面浏览与导航数据来源的模式：网易云模式（默认）与本地模式。切换模式不改变或中断共享播放状态；播放队列跨模式共享并标明来源。
_Avoid_: 播放模式、音源切换

**落盘缓存（Disk Cache）**:
v1 即实现的音频流文件缓存（app 缓存目录 + SQLite 索引），分**公共播放缓存**（不绑定账号、容量淘汰）与**账号权益缓存**（绑定 ownerUserId、播放前重验证）。
_Avoid_: 下载、离线音乐

**锁定缓存（Locked Entitlement Cache）**:
文件仍在，但因登出、切换账号、会员过期或权限校验失败而不可播放的账号权益缓存；优先淘汰。
_Avoid_: 失效下载

**高频专辑（Frequent Album）**:
累计有效专辑会话达标、获得空闲时全专辑缓存资格的专辑；补全调度可后置于缓存核心之后。
_Avoid_: 已下载专辑、收藏专辑

**封面氛围场（Artwork Atmosphere）**:
展开播放层以当前专辑封面放大、裁切和模糊后形成的环境背景；随歌曲切换平滑过渡。
_Avoid_: 动态渐变背景、光效背景

**下一首预取（Next-Track Prefetch）**:
当前曲播放期间高优先级准备队列下一曲：预解析直链/预载元数据，缓存流提前写入落盘缓存；MediaElement 阶段不创建 standby decoder（那是 PCM 升级后的能力）。
_Avoid_: 后台下载

**E2E 行为流（E2E Flow）**:
tauri-driver WebDriverIO 自动化验收：双域导航、胶囊坞控制、播放层展开、主题切换等行为断言；视觉验证仅限人工。
_Avoid_: 截图基线测试、Computer Use 验收流程
