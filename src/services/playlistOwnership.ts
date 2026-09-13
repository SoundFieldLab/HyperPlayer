import type { MusicPlatform } from './platforms'

export interface PlaylistOwnershipContext {
  neteaseUserId?: string | number
  qqUserId?: string | number
}

export function isSpecialPlaylist(playlist: any): boolean {
  const id = String(playlist?.id || playlist?.dirId || '')
  return Boolean(playlist?.isLike)
}

export function isPlaylistOwner(playlist: any, context: PlaylistOwnershipContext = {}): boolean {
  if (!playlist || isSpecialPlaylist(playlist) || playlist.isCollected || playlist.subscribed) return false
  const platform = (playlist.platform || 'netease') as MusicPlatform
  const id = String(playlist.id || playlist.dirId || '')
  if (playlist.ownedByMe === true) return true
  const ownerId = playlist.userId ?? playlist.creator?.userId ?? playlist.ownerId
  const currentUserId = platform === 'netease' ? context.neteaseUserId
    : platform === 'qq' ? context.qqUserId : undefined
  return Boolean(ownerId !== undefined && ownerId !== null && currentUserId && String(ownerId) === String(currentUserId))
}
