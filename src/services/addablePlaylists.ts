import type { MusicPlatform } from './platforms'
import { getPlatformCapabilities } from './platforms'
import { isPlaylistOwner, type PlaylistOwnershipContext } from './playlistOwnership'

const VIRTUAL_PLAYLIST_IDS = new Set([
  '__apple_library__',
  '__apple_favorites__',
  'qishui-liked',
  'qishui-recent',
  'qishui-feed',
])

export function getPlaylistMutationId(playlist: any): string {
  return String(playlist?.dirId ?? playlist?.id ?? '')
}

export function isAddablePlaylist(
  playlist: any,
  songPlatform: MusicPlatform,
  owners: PlaylistOwnershipContext,
): boolean {
  const id = getPlaylistMutationId(playlist)
  const platform = (playlist?.platform || songPlatform) as MusicPlatform
  if (!id || platform !== songPlatform || !getPlatformCapabilities(platform).addTracksToPlaylist) return false
  if (VIRTUAL_PLAYLIST_IDS.has(id)) return false
  if (playlist?.isLike || playlist?.isCollected || playlist?.subscribed || playlist?.isSubscribed || playlist?.isVirtual) return false
  return isPlaylistOwner({ ...playlist, platform }, owners)
}

export function getAddablePlaylists(
  playlists: any[],
  songPlatform: MusicPlatform,
  owners: PlaylistOwnershipContext,
): any[] {
  return playlists.filter(playlist => isAddablePlaylist(playlist, songPlatform, owners))
}
