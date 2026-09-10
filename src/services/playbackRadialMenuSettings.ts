import type { MusicPlatform } from './platforms'
import { getPlatformCapabilities } from './platforms'

export type PlaybackRadialActionId =
  | 'play-next'
  | 'favorite'
  | 'comments'
  | 'album'
  | 'artist'
  | 'details'
  | 'add-to-playlist'
  | 'copy-info'
  | 'similar'

export const PLAYBACK_RADIAL_MENU_SETTINGS_EVENT = 'waveforge-playback-radial-menu-settings-changed'
export const PLAYBACK_RADIAL_MENU_SETTINGS_KEY = 'waveforge:playbackRadialMenu'
export const MAX_PLAYBACK_RADIAL_ACTIONS = 8

export const DEFAULT_PLAYBACK_RADIAL_ACTIONS: PlaybackRadialActionId[] = [
  'favorite',
  'comments',
  'album',
  'artist',
  'details',
  'play-next',
  'copy-info',
]

export interface PlaybackRadialActionMeta {
  id: PlaybackRadialActionId
  label: string
  description: string
  capability?: keyof ReturnType<typeof getPlatformCapabilities>
}

export const PLAYBACK_RADIAL_ACTIONS: readonly PlaybackRadialActionMeta[] = [
  { id: 'play-next', label: '再听一次', description: '将当前歌曲再次加入下一首' },
  { id: 'favorite', label: '收藏歌曲', description: '按当前平台收藏或取消收藏', capability: 'likeSong' },
  { id: 'comments', label: '查看评论', description: '打开当前歌曲评论', capability: 'comments' },
  { id: 'album', label: '查看专辑', description: '打开歌曲所属专辑', capability: 'albumDetail' },
  { id: 'artist', label: '查看歌手', description: '打开歌曲所属歌手', capability: 'artistDetail' },
  { id: 'details', label: '歌曲详情', description: '查看歌曲的完整信息' },
  { id: 'add-to-playlist', label: '添加到歌单', description: '打开歌单选择菜单', capability: 'addTracksToPlaylist' },
  { id: 'copy-info', label: '复制歌曲信息', description: '复制歌曲和平台信息' },
  { id: 'similar', label: '相似歌曲', description: '查找相似歌曲', capability: 'similarSongs' },
]

const ACTION_IDS = new Set<PlaybackRadialActionId>(PLAYBACK_RADIAL_ACTIONS.map(action => action.id))

export function getAvailablePlaybackRadialActions(platform?: MusicPlatform): PlaybackRadialActionMeta[] {
  const capabilities = getPlatformCapabilities(platform || 'netease')
  return PLAYBACK_RADIAL_ACTIONS.filter(action => !action.capability || capabilities[action.capability])
}

export function isPlaybackRadialActionAvailable(id: PlaybackRadialActionId, platform?: MusicPlatform): boolean {
  return getAvailablePlaybackRadialActions(platform).some(action => action.id === id)
}

export function normalizePlaybackRadialActions(value: unknown): PlaybackRadialActionId[] {
  const source = Array.isArray(value) ? value : []
  const normalized = source.filter((id): id is PlaybackRadialActionId => typeof id === 'string' && ACTION_IDS.has(id as PlaybackRadialActionId))
  const unique = normalized.filter((id, index) => normalized.indexOf(id) === index)
  const merged = [...unique, ...DEFAULT_PLAYBACK_RADIAL_ACTIONS.filter(id => !unique.includes(id))]
  return merged.slice(0, MAX_PLAYBACK_RADIAL_ACTIONS)
}

function normalizeSavedPlaybackRadialActions(value: unknown): PlaybackRadialActionId[] | null {
  if (!Array.isArray(value)) return null
  const normalized = value.filter((id): id is PlaybackRadialActionId => typeof id === 'string' && ACTION_IDS.has(id as PlaybackRadialActionId))
  return normalized.filter((id, index) => normalized.indexOf(id) === index).slice(0, MAX_PLAYBACK_RADIAL_ACTIONS)
}

export function getPlaybackRadialActions(): PlaybackRadialActionId[] {
  try {
    const raw = localStorage.getItem(PLAYBACK_RADIAL_MENU_SETTINGS_KEY)
    if (!raw) return [...DEFAULT_PLAYBACK_RADIAL_ACTIONS]
    return normalizeSavedPlaybackRadialActions(JSON.parse(raw)) || [...DEFAULT_PLAYBACK_RADIAL_ACTIONS]
  } catch {
    return [...DEFAULT_PLAYBACK_RADIAL_ACTIONS]
  }
}

export function setPlaybackRadialActions(actions: PlaybackRadialActionId[]): void {
  const normalized = normalizeSavedPlaybackRadialActions(actions) || []
  try {
    localStorage.setItem(PLAYBACK_RADIAL_MENU_SETTINGS_KEY, JSON.stringify(normalized))
    window.dispatchEvent(new CustomEvent(PLAYBACK_RADIAL_MENU_SETTINGS_EVENT, { detail: { actions: normalized } }))
  } catch {
    // Storage may be unavailable in private or embedded contexts.
  }
}
