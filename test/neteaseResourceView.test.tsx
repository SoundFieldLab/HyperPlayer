/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NeteaseNativeBlockView, formatNeteaseCount, groupSongResources, SongRestrictionBadges, type ResourceCallbacks } from '../src/features/neteaseExplore/NeteaseResourceView'
import type { NeteaseNativeResource } from '../src/features/neteaseExplore/model'

function songResource(id: number, favorite = false): NeteaseNativeResource {
  const song = { id, name: `Song ${id}`, artists: [{ name: 'Artist' }], album: { name: 'Album', picUrl: '' }, duration: 1000, platform: 'netease' as const }
  return { id: String(id), type: 'song', title: song.name, subtitle: 'Artist', coverUrl: '', purePictureUrl: '', purePicture: false, purePicName: '', recommendationShowType: '', actionUrl: '', action: { type: 'song', song }, alg: '', isFavorite: favorite, favoriteCount: 12000, song, raw: {} }
}

function callbacks(overrides: Partial<ResourceCallbacks> = {}): ResourceCallbacks {
  return {
    onExecute: vi.fn(),
    onSongContextMenu: vi.fn(),
    onPlaylistContextMenu: vi.fn(),
    isSongFavorite: resource => Boolean(resource.isFavorite),
    isFavoritePending: () => false,
    onToggleFavorite: vi.fn(),
    favoriteCount: resource => resource.favoriteCount,
    ...overrides,
  }
}

describe('NeteaseResourceView', () => {
  it('groups song shelves into fixed columns of three and formats counts', () => {
    const resources = Array.from({ length: 7 }, (_, index) => songResource(index + 1))
    expect(groupSongResources(resources).map(group => group.length)).toEqual([3, 3, 1])
    expect(formatNeteaseCount(12000)).toBe('1.2万+')
    expect(formatNeteaseCount(120000000)).toBe('1.2亿+')
  })

  it('plays from the whole row while heart clicks stay isolated and show seeded state', () => {
    const resource = songResource(1, true)
    const handlers = callbacks()
    render(<NeteaseNativeBlockView block={{ id: 'songs', blockCode: 'SONGS', showType: 'HOMEPAGE_SLIDE_SONGLIST_ALIGN', title: '好歌', subtitle: '', resources: [resource], raw: {} }} callbacks={handlers} />)

    const heart = screen.getByRole('button', { name: '取消喜欢 Song 1' })
    expect(heart.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('1.2万+')).toBeTruthy()
    fireEvent.click(heart)
    expect(handlers.onToggleFavorite).toHaveBeenCalledOnce()
    expect(handlers.onExecute).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Song 1'))
    expect(handlers.onExecute).toHaveBeenCalledWith(resource, [resource])
  })

  it('routes playlist right-clicks to the shared playlist callback', () => {
    const playlist = { id: '42', name: 'Feed list', coverUrl: '', platform: 'netease' as const, source: 'netease-native-feed' }
    const resource: NeteaseNativeResource = { id: '42', type: 'playlist', title: playlist.name, subtitle: '', coverUrl: '', purePictureUrl: '', purePicture: false, purePicName: '', recommendationShowType: '', actionUrl: '', action: { type: 'playlist', playlist, autoplay: false }, alg: '', playlist, raw: {} }
    const handlers = callbacks()
    render(<NeteaseNativeBlockView block={{ id: 'lists', blockCode: 'LISTS', showType: 'HOMEPAGE_SLIDE_PLAYLIST', title: '歌单', subtitle: '', resources: [resource], raw: {} }} callbacks={handlers} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /Feed list/ }), { clientX: 10, clientY: 20 })
    expect(handlers.onPlaylistContextMenu).toHaveBeenCalledWith(expect.anything(), playlist)
  })
})
