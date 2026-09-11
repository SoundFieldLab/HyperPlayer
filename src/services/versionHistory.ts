/**
 * 版本历史（关于 → 更新 → 版本历史）。
 *
 * 内容维护约定：与 GitHub Releases（SoundFieldLab/HyperPlayer）及 git 版本节点保持同步。
 * 每次发布新版本时，把上一版条目挪到这里（保留完整说明），并在顶部加入
 * 「当前版本」条目——更新日志（update.json 的 notes）与该处文案保持一致。
 *
 * 版本号起点：本仓库自 v1.0.0 起重新编号（减配 + 改名后的首个正式版本），
 * v1.0.0 之前的 0.x 记录不再保留。
 *
 * notes 写法约定（与发布脚本 --notes 一致）：
 *   按「新功能 / 改进 / 修复」分组，面向用户描述，避免内部代号与提交号；
 *   单条一行、以 - 开头；没有的分组可以省略。
 */
export interface VersionHistoryEntry {
  version: string
  date: string
  /** true = 当前已安装版本（列表顶部高亮） */
  current?: boolean
  notes: string
}

export const VERSION_HISTORY: VersionHistoryEntry[] = [
  {
    version: '1.0.0',
    date: '2026-09-11',
    current: true,
    notes: `✨ 新功能
- 五大音源聚合：网易云 / QQ 音乐 / Apple Music / Spotify / B 站看歌
- 无缝衔接：专辑曲目直切拼接、60ms 等功率淡入淡出、gapless 边界调度
- HSE 音效引擎：14 级处理主链 + 空间音频，附 HSE 调音室（9 页可视化调音）
- 空间音频：头锁定环绕 / 世界漫游 / 舞台影院，支持 HRTF 与房间模拟
- 桌面歌词独立窗口 + 任务栏歌词小组件
- 探索模式：网易云 / QQ 每日推荐与个性化歌单
- Apple 逐字歌词与动态封面

⚡ 改进
- 项目重新编号为 1.0.0：减配收敛，移除 TV / 汽水 / 酷狗等冗余形态
- 启动性能优化：首屏瘦身、列表虚拟化、组件 memo、后端 gzip

🐛 修复
- 修复改名后灯效插件自身注册名被误列为待清理项`,
  },
]
