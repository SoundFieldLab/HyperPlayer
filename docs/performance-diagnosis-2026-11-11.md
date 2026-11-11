# 2026-11-11：搜索列表滚动与内存诊断

本轮从用户反馈的「内存占用高、UI 不流畅」进入诊断。已复现并缩小搜索列表滚动的运行期开销；尚不能把结论外推到逐字歌词、视频、其他界面模式或长时间播放，也没有确认应用整体内存泄漏。

## 测量条件

- 基点：`158964f`。Electron 44.5.0 / Chromium 152.0.7977.130，Windows，本机 rAF 空闲周期约 4.2ms（约 240Hz），窗口 1400×900 CSS px，DPR 1.5，GPU 合成开启。
- 真实 Electron 主进程与 preload，加载 Vite **生产构建**，通过 3210 preview 服务；不是 HMR，也不是打包版 `file://` 性能实测。
- 匿名临时 userData，不读取登录态。renderer 网络由 Playwright 固定响应，不播放音频；100 首歌曲从 sessionStorage 恢复到实际 `SearchPanel`。数据用于复现，不写入用户配置。
- 每轮新进程：home idle 4s → search idle 4s → 50 次滚轮（25 次向下、25 次向上，间隔 35ms）。采集 rAF 分位数、长任务、CDP TaskDuration / LayoutDuration、JS 堆与各进程工作集 / privateBytes。
- 严格诊断判据：scroll P95 ≤ 本轮 home idle P95 × 2.2，本机约 9.46ms。此阈值只用于该场景相对对照，不声称是通用显示帧率验收标准；rAF 间隔也不等于实际呈现 FPS。
- trace / CPU profile 只定位热点，不将其耗时与无 profile 轮次直接比较。trace 导出前先结束帧统计，避免统计窗口不一致。

## 复现与缩小

运行证据保存在忽略目录 `logs/perf/`，不提交含环境路径的大型 trace。

| 场景 | scroll P95 | 结果 |
|---|---:|---|
| 原实现 100 首（baseline-100） | 20.9ms | 未通过；最大帧 70.9ms，Task 2011ms，Layout 341ms |
| 原实现 30 首 | 16.4ms | 未通过 |
| 原实现 20 首 | 16.6ms | 未通过 |
| 原实现 10 首 | 8.4ms | 通过 |

空闲 home/search 的 P95 均约 4.3ms。滚动和结果规模是复现要素，不需要真实网络或播放。

## 假设与排除

1. 行交互/动画的成本随挂载规模增长。隔离行指针事件后 100 首 P95 降至 8.3ms、Layout 约 5ms，支持该方向；关闭指针事件会破坏功能，仅用于诊断。
2. 模糊合成是主要原因。临时禁用 filter/backdrop-filter 仍未通过，不能据此删除现有玻璃视觉。
3. 资源加载或滚动尺寸读取是主要原因。资源稳定后重复滚动仍触发；缓存 scrollHeight/clientHeight 也未通过。CPU profile 中 ScrollToTop 回调会触发布局，但仅修改此处不足以解决问题。

`content-visibility:auto`、滚动区域 containment、逐行 `will-change`、CSS hover 替换均未稳定通过，未进入产品代码。profile 显示开销集中在 Layout / Paint；不能把这归因于 React 大面积重渲染。

## 修改

`SearchSongList.tsx` 复用已有 `@tanstack/react-virtual`，将 100 行全部挂载改为视口附近约 8–12 行；保留原 `SearchPanel` 行内容、hover scale、选歌与右键菜单。行内容 memo，虚拟列表滚动不使用 flushSync。动态测量 offsetHeight，避免弹窗/hover 的 scale 污染尺寸；用 scrollMargin 处理融合搜索上方实体区的偏移。

`test/SearchSongList.test.tsx` 通过实际虚拟器和浏览器几何替身检查挂载规模、滚动后的索引、选歌及右键归属。Electron 流程另检查最后一首可到达、静止 hover transform、实际右键菜单。

### 保留全部悬停行为的复测

| 指标 | 原实现 baseline-100 | 虚拟列表 final-preserved-hover-100 |
|---|---:|---:|
| 挂载歌曲行 | 100 | 约 8–12 |
| scroll P95 | 20.9ms | 12.4ms |
| 最大帧间隔 | 70.9ms | 16.8ms |
| 主线程 TaskDuration | 2011ms / 3.27s 场景 | 770ms / 2.78s 场景 |
| LayoutDuration | 341ms | 47ms |
| ≥50ms 长任务 | 1 / 51ms | 0 |
| renderer 工作集（滚动后） | 242MB | 196MB |

固定操作序列因卡顿而耗时不同，不能把两轮总 TaskDuration 当作等长窗口 CPU 百分比。工作集是单次快照，尚未证明长期/全应用内存下降。

早期「滚动时暂时停 hover」版本两轮 P95 8.4ms，通过相对目标；为完整保留交互已撤掉。最终版本 **严格 9.46ms 目标仍未通过**，只报告已测得的开销下降。不得引用早期绿色结果宣称最终版本全部通过。

最终源码（含祖先 ResizeObserver 修正）重建后 `delivered-100`：P95 12.6ms、最大 21ms、Task 822ms / 2.88s、Layout 46ms、长任务 0，挂载 8 行。再次确认相对判据未通过；主要改进在减少渲染工作与长停顿，不是宣称达到 240Hz 满帧。

验证：全量 Vitest 2125 通过 / 16 跳过，类型检查与播放接线/等价性通过；`build:electron:dir` 成功，asar 结构与依赖分区校验通过、82MB。已有 3211 listener 的拒绝启动测试确认 listener 存活；脚本退出用 `app.exit` 避开主进程 `will-quit` 全局清扫，已验证执行结束后关闭测试进程与端口。

## 内存结果与边界

早期虚拟列表版本 10 次搜索弹窗关闭/重开并在相同阶段执行 **诊断用 CDP GC**：document 固定 1、DOM nodes 固定 498、listeners 固定 499；回收后 JS 堆从约 15.64MB 增至 16.81MB。节点/监听器未累积，堆仍有增长，短样本不足证明无泄漏。最终保留 hover 版本的逐轮数据也保存在 `logs/perf/final-preserved-hover-100.json`，不把不同版本的堆数字直接当作优化收益。

GPU 工作集本轮约 400–480MB，privateBytes 可达约 0.75–1.0GB；这些指标受资源分配/驱动缓存影响，不能相加当作实际物理占用，也不能凭一个快照认定泄漏。未完成长时间视频/歌词播放的 heap-retainer 或 GPU 资源诊断。

## 复现命令

先 `npm run build`。使用已安装 Playwright 的外部 node_modules（例如 Codex 工具运行时），不增加产品运行依赖：

```powershell
$env:HYPERPLAYER_BROWSER_TOOLS = '<含 playwright 的 node_modules 绝对路径>'
$env:HYPERPLAYER_PERF_ROWS = '100'
$env:HYPERPLAYER_PERF_RUN = 'search-scroll-100'
$env:HYPERPLAYER_PERF_CYCLES = '10' # 可选，0–30；采样 GC 后 JS 堆/DOM/监听器
npm run benchmark:ui
```

可选 `HYPERPLAYER_PERF_TRACE=1` 输出 `.cpuprofile` 与 `.trace.json`，仅用于定位。输出在 `logs/perf/<run>.json` 与截图；退出 0 表示相对帧判据通过，2 表示未通过，1 表示运行错误。已有 3210/3211 服务时拒绝启动；不复用或停止已有服务。

基准不是独立 debug 网页，不新增 HTML 或生产入口。测试结束关闭本次 Electron 和 preview，清理本次匿名 profile；产品无新增采样循环或 GC 调用。
