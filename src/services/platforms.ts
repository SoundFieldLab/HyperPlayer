/**
 * 音乐平台抽象层
 *
 * HyperPlayer 的"平台"曾长期是散落在 40+ 文件里的 'netease' | 'qq' 字面量。
 * 本模块集中定义：
 * 1. MusicPlatform —— 平台联合类型（新增平台只需在此加一个成员）
 * 2. PlatformCapabilities / PLATFORM_CAPABILITIES —— 平台能力注册表。
 *    UI 全部共享，按能力增减功能：对比某平台与网易云/QQ 的能力差，UI 自然增删。
 * 3. 平台级工具函数（标签 / cookie / 播放载体判定）
 *
 * Apple Music 与 Spotify 音源已于 2026-09-13 移除（含其登录、目录、播放与 DRM 适配）。
 */

export type MusicPlatform = 'netease' | 'qq'

export const MUSIC_PLATFORMS: readonly MusicPlatform[] = ['netease', 'qq']

export const PLATFORM_LABELS: Record<MusicPlatform, string> = {
  netease: '网易云音乐',
  qq: 'QQ音乐',
}

export interface PlatformVisualMetadata {
  label: string
  shortLabel: string
  color: string
  background: string
}

/** 所有平台都提供本地文字视觉信息，避免依赖跨站图标。 */
export const PLATFORM_VISUAL_METADATA: Record<MusicPlatform, PlatformVisualMetadata> = {
  netease: { label: '网易云音乐', shortLabel: '网', color: '#fff', background: '#d81e2b' },
  qq: { label: 'QQ音乐', shortLabel: 'QQ', color: '#102a1d', background: '#31c27c' },
}

export function getPlatformVisualMetadata(platform: MusicPlatform): PlatformVisualMetadata {
  return PLATFORM_VISUAL_METADATA[platform]
}

export function platformLabel(platform: MusicPlatform | string | undefined | null): string {
  if (platform && platform in PLATFORM_LABELS) return PLATFORM_LABELS[platform as MusicPlatform]
  return '未知平台'
}

/** 探索页区块 ID（与 ExploreSettingsPanel 的 ExploreSectionId 同构） */
export type ExploreSectionId = 'discover' | 'journey' | 'playlists' | 'charts' | 'newSongs' | 'albums' | 'channels'

export interface PlatformCapabilities {
  /** 是否提供登录能力 */
  login: boolean
  /** 个人中心（用户资料页） */
  profile: boolean
  /** 用户歌单（查看） */
  userPlaylists: boolean
  createPlaylist: boolean
  /** 修改自建歌单名称/描述 */
  updatePlaylist: boolean
  deletePlaylist: boolean
  /** 搜索公开歌单 */
  searchPlaylists: boolean
  /** 生成可靠的公开歌单链接 */
  sharePlaylist: boolean
  /** 从自建歌单移除曲目 */
  removeTracksFromPlaylist: boolean
  /** 歌单加歌 */
  addTracksToPlaylist: boolean
  /** 收藏他人歌单 */
  subscribePlaylist: boolean
  /** 我喜欢 / 音乐库歌曲 */
  likedSongs: boolean
  /** 单曲喜欢/取消喜欢 */
  likeSong: boolean
  /** 探索页 */
  explore: boolean
  /** 探索页可用的区块（按能力增减） */
  exploreSections: readonly ExploreSectionId[]
  search: boolean
  searchSuggest: boolean
  lyrics: boolean
  comments: boolean
  /** 个性化每日推荐（未登录/不支持时可用公开榜单兜底） */
  dailyRecommend: boolean
  charts: boolean
  channels: boolean
  newSongs: boolean
  albums: boolean
  mv: boolean
  /** 每日签到 / 打卡 */
  signin: boolean
  /** 关注 / 粉丝 */
  social: boolean
  /** 听歌排行 */
  rank: boolean
  /** 云盘 */
  cloudDisk: boolean
  recentPlayed: boolean
  artistDetail: boolean
  albumDetail: boolean
  similarSongs: boolean
  /** 连续电台（FM / 猜你喜欢） */
  radio: boolean
  /** 是否可直接作为音频播放载体 */
  playAsCarrier: boolean
  audioQuality: boolean
}

const NETEASE_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true,
  createPlaylist: true,
  updatePlaylist: true,
  deletePlaylist: true,
  searchPlaylists: true,
  sharePlaylist: true,
  removeTracksFromPlaylist: true,
  addTracksToPlaylist: true,
  subscribePlaylist: true,
  likedSongs: true,
  likeSong: true,
  explore: true,
  exploreSections: ['discover', 'journey', 'playlists', 'charts', 'newSongs', 'albums', 'channels'],
  search: true,
  searchSuggest: true,
  lyrics: true,
  comments: true,
  dailyRecommend: true,
  charts: true,
  channels: true,
  newSongs: true,
  albums: true,
  mv: true,
  signin: false,
  social: true,
  rank: true,
  cloudDisk: true,
  recentPlayed: true,
  artistDetail: true,
  albumDetail: true,
  similarSongs: true,
  radio: true,
  playAsCarrier: true,
  audioQuality: true,
}

const QQ_CAPABILITIES: PlatformCapabilities = {
  ...NETEASE_CAPABILITIES,
  updatePlaylist: false,
  signin: false,
  social: true,
  // QQ 无听歌排行 / 云盘
  rank: false,
  cloudDisk: false,
}

export const PLATFORM_CAPABILITIES: Record<MusicPlatform, PlatformCapabilities> = {
  netease: NETEASE_CAPABILITIES,
  qq: QQ_CAPABILITIES,
}

export function getPlatformCapabilities(platform: MusicPlatform): PlatformCapabilities {
  return PLATFORM_CAPABILITIES[platform] || NETEASE_CAPABILITIES
}

export interface PlatformFavoriteLabels {
  add: string
  remove: string
  collection: string
}

const PLATFORM_FAVORITE_LABELS: Record<MusicPlatform, PlatformFavoriteLabels> = {
  netease: { add: '我喜欢', remove: '从喜欢歌单中移除', collection: '我喜欢的音乐' },
  qq: { add: '我喜欢', remove: '从喜欢歌单中移除', collection: '我喜欢的歌曲' },
}

/** 收藏/资料库在各平台的用户可见名称，避免菜单各自硬编码。 */
export function getPlatformFavoriteLabels(platform: MusicPlatform): PlatformFavoriteLabels {
  return PLATFORM_FAVORITE_LABELS[platform] || PLATFORM_FAVORITE_LABELS.netease
}

// ─────────────────────────── 平台排序（用户自定义，三模式继承） ───────────────────────────

const PLATFORM_ORDER_KEY = 'hyperplayer:platformOrder'
export const PLATFORM_ORDER_EVENT = 'hyperplayer-platform-order-changed'

/** 用户自定义平台顺序（缺省 = MUSIC_PLATFORMS 默认顺序） */
export function getPlatformOrder(): MusicPlatform[] {
  try {
    const raw = localStorage.getItem(PLATFORM_ORDER_KEY)
    if (!raw) return [...MUSIC_PLATFORMS]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...MUSIC_PLATFORMS]
    const valid = parsed.filter((p): p is MusicPlatform => MUSIC_PLATFORMS.includes(p as MusicPlatform))
    // 补全缺失平台，去重
    const set = new Set(valid)
    const merged = [...valid, ...MUSIC_PLATFORMS.filter(p => !set.has(p))]
    return merged
  } catch {
    return [...MUSIC_PLATFORMS]
  }
}

/** 保存用户平台顺序（触发 PLATFORM_ORDER_EVENT） */
export function setPlatformOrder(order: MusicPlatform[]): void {
  const valid = order.filter((p, i, arr) => MUSIC_PLATFORMS.includes(p) && arr.indexOf(p) === i)
  if (valid.length === 0) return
  try {
    localStorage.setItem(PLATFORM_ORDER_KEY, JSON.stringify(valid))
    window.dispatchEvent(new CustomEvent(PLATFORM_ORDER_EVENT, { detail: { order: valid } }))
  } catch {
    // 忽略
  }
}

// ─────────────────────────── 平台可见性（隐藏平台） ───────────────────────────

const HIDDEN_PLATFORMS_KEY = 'hyperplayer:hiddenPlatforms'
export const PLATFORM_VISIBILITY_EVENT = 'hyperplayer-platform-visibility-changed'

/** 用户手动隐藏的平台列表（默认空 = 全部显示） */
export function getHiddenPlatforms(): MusicPlatform[] {
  try {
    const raw = localStorage.getItem(HIDDEN_PLATFORMS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is MusicPlatform => MUSIC_PLATFORMS.includes(item as MusicPlatform))
      : []
  } catch {
    return []
  }
}

/** 当前应显示的平台列表（按用户自定义顺序，至少保留一个平台） */
export function getVisiblePlatforms(): MusicPlatform[] {
  const hidden = new Set(getHiddenPlatforms())
  const order = getPlatformOrder()
  const visible = order.filter(platform => !hidden.has(platform))
  return visible.length > 0 ? visible : ['netease']
}

export function isPlatformVisible(platform: MusicPlatform): boolean {
  return getVisiblePlatforms().includes(platform)
}

/** 设置某平台是否隐藏（hidden=true 隐藏）。禁止隐藏最后一个可见平台。 */
export function setPlatformHidden(platform: MusicPlatform, hidden: boolean): void {
  const current = new Set(getHiddenPlatforms())
  if (hidden) {
    current.add(platform)
  } else {
    current.delete(platform)
  }
  const nextHidden = [...current]
  // 至少保留一个平台
  if (MUSIC_PLATFORMS.every(item => nextHidden.includes(item))) return
  localStorage.setItem(HIDDEN_PLATFORMS_KEY, JSON.stringify(nextHidden))
  window.dispatchEvent(new CustomEvent(PLATFORM_VISIBILITY_EVENT, { detail: { hidden: nextHidden } }))
}

/** 平台 cookie/token（QQ 走 cookie，网易云走 cookie） */
export function getPlatformCookie(platform: MusicPlatform): string {
  if (platform === 'qq') {
    return localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
  }
  return localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
}
