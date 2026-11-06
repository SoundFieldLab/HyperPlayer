/**
 * 详情导航账本 module。
 *
 * 艺人 / 专辑 / 歌曲详情弹窗原先在 `App.tsx` 里由「一个 ref 数组栈 + 三个 show 布尔 +
 * 若干 selected* 状态」共同表达，重置语义散在 6 条路径上（返回、彻底关闭、打开新详情、
 * 选歌、回首页）。这里拥有栈本身：压栈去重、深度上限、返回、彻底清空与整体替换。
 * UI 只负责把栈顶映射成弹窗。
 */

import type { Song } from './musicApi'
import type { MusicPlatform } from './platforms'

export const MAX_DETAIL_STACK_DEPTH = 20

export type DetailNavigationEntry =
  | { type: 'artist'; id: string; platform: MusicPlatform; tab?: string }
  | { type: 'album'; id: string; platform: MusicPlatform }
  | { type: 'song'; song: Song }

/**
 * 歌曲身份与 App 的 `getSongKey` 保持一致：`platform-mid||id`。
 * QQ 歌曲以 mid 为唯一键，用 id 比较会把同 mid 的两条当成不同歌曲。
 */
const songIdentity = (song: Song): string =>
  `${song.platform || 'netease'}-${song.mid || song.id}`

const sameSong = (a: Song, b: Song): boolean => songIdentity(a) === songIdentity(b)

const isSameEntry = (a: DetailNavigationEntry, b: DetailNavigationEntry): boolean => {
  if (a.type !== b.type) return false
  if (a.type === 'song') return b.type === 'song' && sameSong(a.song, b.song)
  if (b.type === 'song') return false
  return a.id === b.id && a.platform === b.platform
}

export class DetailNavigationLedger {
  private stack: DetailNavigationEntry[] = []

  get size(): number {
    return this.stack.length
  }

  /** 当前栈内容的副本；调用方改它不会影响账本。 */
  entries(): DetailNavigationEntry[] {
    return [...this.stack]
  }

  /**
   * 压栈：只有**栈顶重复**才忽略（A→B→A 是合法路径），超过上限丢弃最旧条目。
   * 返回是否真的入栈，便于调用方决定要不要继续后续副作用。
   */
  push(entry: DetailNavigationEntry): boolean {
    const top = this.stack[this.stack.length - 1]
    if (top && isSameEntry(top, entry)) return false
    if (this.stack.length >= MAX_DETAIL_STACK_DEPTH) this.stack.shift()
    this.stack.push(entry)
    return true
  }

  /** 返回上一级；空栈返回 undefined。 */
  pop(): DetailNavigationEntry | undefined {
    return this.stack.pop()
  }

  /** 彻底关闭：清空栈。 */
  clear(): void {
    this.stack = []
  }

  /**
   * 打开新详情前批量压栈：**保留已有历史**，按给定顺序依次压入栈顶
   *（同样走去重与上限规则）。空数组是 no-op。
   *
   * 不能改成"清空后重建"：旧实现在临时置空栈后恢复 `savedStack`，
   * 深层的 A→B→C 历史仍可逐级返回，清空会丢掉多级返回能力。
   */
  pushAll(entries: DetailNavigationEntry[]): void {
    for (const entry of entries) this.push(entry)
  }
}
