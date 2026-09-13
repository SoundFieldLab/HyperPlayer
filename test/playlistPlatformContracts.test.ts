import { beforeEach, describe, expect, it, vi } from 'vitest'

const invalidatePlaylist = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/services/indexedDBCache', () => ({
  indexedDBCache: {
    invalidatePlaylist,
    getCachedPlaylist: vi.fn(),
    cachePlaylist: vi.fn(),
  },
}))

const { getArtistAllSongs } = await import('../src/services/musicApi')
const { invalidateUserPlaylistsCache } = await import('../src/services/playlistService')

describe('platform pagination and cache contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('forwards QQ artist offsets to the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ songs: [], total: 80 }) })
    vi.stubGlobal('fetch', fetchMock)
    await getArtistAllSongs('artist-mid', 'qq', 40, 40)
    expect(String(fetchMock.mock.calls[0][0])).toContain('offset=40')
  })

  it('invalidates the platform-scoped playlist cache for a known user id', () => {
    localStorage.setItem('netease_cookie', 'MUSIC_U=token')
    invalidateUserPlaylistsCache('netease', '12345')
    expect(invalidatePlaylist).toHaveBeenCalledTimes(1)
    expect(String(invalidatePlaylist.mock.calls[0][0])).toContain('netease:12345')
    expect(invalidatePlaylist.mock.calls[0][1]).toBe('netease')
  })

  it('skips cache invalidation when the user id is empty', () => {
    invalidateUserPlaylistsCache('qq', '')
    expect(invalidatePlaylist).not.toHaveBeenCalled()
  })
})
