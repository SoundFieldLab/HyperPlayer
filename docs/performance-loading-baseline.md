# 按需加载改造前的网络与流畅度基线

对应 [规格 #3](https://github.com/SoundFieldLab/HyperPlayer/issues/3) 与 [观测任务 #4](https://github.com/SoundFieldLab/HyperPlayer/issues/4)。本任务增加独立诊断工具，不修改产品加载策略。后续分页、后台预取和媒体准备改造须以同条件结果对照。

## 运行方式

使用 PowerShell；先结束自己启动的开发服务。工具检测到 3210 或 3211 已占用会拒绝启动，不复用、不终止已有服务。浏览器工具使用外部 Playwright，不加入应用运行依赖。

```powershell
$env:HYPERPLAYER_BROWSER_TOOLS = 'C:\Users\IceFire_Icer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
npm run benchmark:loading -- --plan
# dist 必须来自待测版本的生产构建；本地构建遵循仓库便携版约定。
npm run build:electron:dir
npm run benchmark:loading -- --run=loading-before
```

默认运行简约／传统／探索／桌面 × 网易／QQ × 正常／慢网 × 3轮，共48个独立profile。首次联调可以缩小矩阵，但不能将局部结果称为完整验收：

```powershell
npm run benchmark:loading -- --modes=minimal --platforms=netease --networks=normal --repeats=1 --run=loading-smoke
```

报告输出到 `logs/perf/<run>/report.json`，后端安全事件为同目录的 `*.upstream.ndjson`。目录存在时拒绝覆盖，请换运行名。合成模式下失败动作保存截图方便修复定位；真实联网模式不保存截图或页面内容。报告和运行产物处于忽略目录，仓库中的本文件保存测量口径与结果摘要。

## 场景与指标口径

| 场景 | 完成条件 | 适用入口 |
| --- | --- | --- |
| startup-cold | 新匿名profile首次导航后壳界面可交互 | 四模式、双平台 |
| startup-warm | 同一session重载后壳界面可交互 | 四模式、双平台 |
| search | 实际输入并提交后第一首合成结果显示 | 四模式各自搜索入口 |
| search-scroll | 在真实搜索结果区往返滚动 | 四模式 |
| artist-tabs | 从歌曲右键进入歌手，访问专辑及视频／热门歌曲，再返回 | 四模式对应详情 |
| playlist-open | 实际搜歌单并进入详情，歌曲及播放全部按钮可用 | 四模式 |
| playlist-play-all | 点击播放全部，真实Audio对象进入playing且时间前进 | 四模式 |
| continuous-play | 三次点击下一首，每次等新的playing事件及时间前进 | 四模式 |
| mv-toggle | 进入播放页，开启看歌surface再切回现代歌词 | 四模式进入共享播放页 |
| idle | 固定空闲观察窗口，默认4000ms | 四模式、双平台 |

`usableMs` 是上表动作完成耗时；启动仅测壳界面，不能称为首页业务内容全部加载完成；艺人标签和连续切歌为组合动作，不能与单次起播直接比较。滚动和空闲仅报告观察时长，不给首次可用值。`firstPlayingMs` 单列当前场景首次playing延迟，连续切歌还需观察完整动作耗时。

renderer 网络通过 CDP 观测，事件在采集时立即丢弃原始URL、查询、header与正文，仅保留资源类别、状态、时刻及计数。窗口指标包含与该窗口重叠的请求，`started` 是本窗发起量，`carriedIn` 是前窗尚未结束量；并发保留跨窗工作。跨窗传输不能可靠分摊时记未知。`knownTransferredBytes` 只是已知部分，任一请求未知时整体 `transferredBytes=null`，不能将未知当作0。

普通场景从动作发起后固定观察1500ms，空闲使用固定4000ms（可用 `--idle=<ms>` 延长以覆盖10分钟周期）。动作完成延迟单独等待并记录，即使慢网让动作持续更久，网络／CPU统计窗口也不跟着扩大。超出窗口的工作在整次运行汇总可见，不能将单窗统计当作完整动作网络总量。CDP／IPC命令调度带来少量窗口误差，报告同时列名义和实际时长，窗口偏差明显时需复测。

后端观察使用仅独立runner加载的可选Node preload；环境开关未设置时不hook、不订阅、不创建timer。fetch使用undici生命周期channel，Node HTTP(S)保留正常消费流模式。NDJSON仅输出常量分类，不保存原始URL或错误正文。报告将以下三类分开，不能相加后命名为“真实HTTP扇出”：

- `logicalSdk`：受控模式下第三方公开SDK逻辑调用；保留本地路由、账号判断、缓存、聚合和解析，但SDK内部网络／加解密成本未覆盖。
- `fixtureHttp`：在真实上游fetch或HTTP客户端边界返回受控响应。
- `http`：真实上游HTTP请求；fetch编码字节及所有线上传输字节无法可靠测得时为null。

CDP的TaskDuration、ScriptDuration、LayoutDuration分别报告，不能直接把任务时长除以不同观察窗口后当作可比CPU百分比。Electron进程CPU为采样快照，内存分别列JS堆、working set和private。独立后端通过请求式IPC在场景前后采样CPU微秒累计量及RSS／堆／外部内存，默认关闭时没有监听或计时器；后端不在Electron的进程列表中，因此单列。`responseJsonAwaitMs` 包含等待响应正文及解析，多个并发调用可重叠，**不是纯JSON解析CPU**；纯解析CPU当前未知，记为null。长任务与rAF间隔分布独立报告，rAF间隔不是GPU呈现帧率证明。

## 受控上游与慢网边界

默认完全合成、匿名、无天气配置：两平台固定160首、固定艺人与歌单、固定12秒PCM正弦音频。使用文档IP的媒体和封面在网络边界拦截，真实本地代理仍执行原有SSRF判断，不放宽安全规则。未知外部请求明确失败并计为fixtureMiss，不能用空成功响应掩盖未覆盖操作。

正常档不额外注入延迟／限速；慢档每个受控响应注入180ms延迟和128KiB/s速率。SDK边界按逻辑JSON响应模拟成本，HTTP fixture按正文流模拟；renderer外部fixture在返回响应前按大小延迟。它们**不模拟同一链路上的总带宽争用**，也不包含真实DNS、TLS、SDK内部HTTP扇出或真实平台服务端耗时。Playwright路由会禁用HTTP缓存，因此warm指session／应用缓存复用，不是浏览器HTTP热缓存。

B站API fixture可覆盖匹配和回退触发，暂不提供可解码视频；视频请求明确失败。看歌surface启停成功不代表MV播放成功。歌词第三方源返回失败供真实仲裁回退，不能据此评价多源歌词质量。

全新profile的首次renderer导航与同session重载分别统计；后端就绪和Electron启动到壳界面另列。这里不是OS冷启动，也不是打包版splash及后端启动门控基准。既有 `benchmark:ui` 仍适用于固定响应下的搜索滚动渲染对照，不能用它推断真实网络收益。

## 真实联网与缺口

可单列匿名真实联网启动／空闲，使用全新profile，不读取真实账号与用户配置：

```powershell
npm run benchmark:loading -- --source=live --modes=minimal --platforms=netease --networks=normal,slow --scenarios=startup-cold,startup-warm,idle --repeats=3 --run=loading-live-anonymous
```

live慢网仅对主renderer的CDP网络注入180ms、下载128KiB/s、上传64KiB/s；本地后端上游仍为真实网络且不受此限速。报告注明作用范围，不能与受控SDK慢网直接合并。自动runner只提供匿名启动／空闲，不使用合成资源名冒充真实账号业务验证。真实登录态、付费资源、完整MV播放、账号特有探索／用户歌单以及打包file协议体验，须另行在相同场景与合法账号下验证，证据缺失时明确未测。

## 对照与验收方法

1. 改造前后使用相同生产构建条件、矩阵、合成数据、屏幕刷新率、视口、窗口可见状态、profile／缓存定义及观察时长；报告记录dist内容hash、Electron／Chromium／Node及主机信息，变更的工具／fixture也需记录版本。
2. 同条件至少3次，分别报告中位数、min/max和P95，不把失败或未执行场景填0纳入中位数；检查coverage、失败截图和fixtureMiss，不能只看summary。
3. 首次可用、起播、完整切歌动作和帧P95的初始退化复核线用 `baseline.max + (baseline.max - baseline.min)`；零波动时至少保留1ms计时分辨率。它是本机小样本的复核线，超出需重复验证／定位，不能作为通用SLO，也不能用高噪声区间掩盖明显体验下降。
4. 请求数和传输量按前后台／资源类型及上游类型比较，网络等待与响应后CPU／布局／长任务分别分析。传输未知、观察窗不一致或网络不可比时不计算虚假的改善百分比。
5. 播放范围、随机、过渡、歌词和MV回退的功能验收是硬门槛。请求量下降不能抵消起播／衔接明显退化；确认退化则修复或回退后再接受。未完成真实环境证据不等于已通过。

## 本轮运行结果

本轮交付为观测工具和边界测试，**正式48组矩阵未完成，#4仍需保留开放**。联调成功样本可证明页面、本地路由、受控上游和真实Audio对象能够贯通，不足以给出稳定性能结论。失败样本仅用于诊断工具，不进入成功场景中位数。

- 固定生产构建的dist SHA-256：`e5e4ea6163eec85242c8db47043e2b07fa2624eaaaf2dcea484e41728a11d44c`。
- 成功的完整慢网冒烟：`logs/perf/loading-final-smoke-12/report.json`，传统模式／QQ／匿名，10个场景全部执行；普通观察窗口1503–1517ms，屏幕240Hz、DPR1.5。该次为单轮联调，不能作为三轮性能定标依据。
- 四模式／双平台入口曾逐步联调；旧失败样本及中止的正式矩阵仍在忽略目录，不能合并不同工具版本的数据。完整矩阵需后续在固定工具版本下重新执行，不因部分成功宣称已覆盖。
- 检查通过：观测工具24项；全量2125通过、16跳过；桌面46项；接线13项；迁移等价性78项；类型、端口及便携版打包／asar校验。这里只证明代码回归与打包结构，不代替真实账号、MV解码或完整基线。
- Standards／Spec双轴审查已修正独立后端资源采样、固定观察窗口、loopback域名判定与分项清理；产品加载策略、播放接线和后端业务逻辑没有改变。
- 目前不能据这些样本设置产品条数、并发默认值或声称网络是主要卡顿原因。后续先选择一个稳定、可复现的最小场景补齐三轮对照，再逐项扩大；功能正确性始终优先于性能数字。

联调发现QQ艺人“全部歌曲”的现存字段契约不一致：本地路由将SDK结果映射为 `songid/songmid/songname` 与扁平专辑字段，前端公开服务仍按 `id/mid/name/album` 读取，导致标题与身份缺失。合法fixture不能绕过自有路由补造字段。本票保留产品行为，传统标签场景使用“专辑→热门歌曲”；后续艺人任务须验证并修复此契约，不能误归因为fixture或网络性能。
