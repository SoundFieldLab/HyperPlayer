import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  recent: vi.fn(),
  songs: vi.fn(),
  albums: vi.fn(),
  artists: vi.fn(),
  playlists: vi.fn(),
  videos: vi.fn(),
}))

vi.mock('../src/services/appleApiBridge', () => ({ appleApiRequest: mocks.api }))
vi.mock('../src/services/appleAuth', () => ({
  getAppleCredentials: () => ({ developerToken: 'dev', mediaUserToken: 'user', storefront: 'cn' }),
}))
vi.mock('../src/services/appleMusic', () => ({ toHighResArtwork: (value: string) => value }))
vi.mock('../src/services/appleCatalog', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/appleCatalog')>()
  return {
    ...original,
    getAppleRecentPlayed: mocks.recent,
    getAppleLibrarySongs: mocks.songs,
    getAppleLibraryAlbums: mocks.albums,
    getAppleLibraryArtists: mocks.artists,
    getAppleLibraryPlaylists: mocks.playlists,
    getAppleLibraryMusicVideos: mocks.videos,
  }
})

const web = await import('../src/services/appleWebService')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.recent.mockResolvedValue([])
  mocks.songs.mockResolvedValue([])
  mocks.albums.mockResolvedValue([])
  mocks.artists.mockResolvedValue([])
  mocks.playlists.mockResolvedValue([])
  mocks.videos.mockResolvedValue([])
})

describe('Apple web page composition', () => {
  it('adds a real recent-played shelf before recently added', async () => {
    mocks.recent.mockResolvedValue([{ id: '101', name: 'Recent', artistName: 'Artist', artworkUrl: 'recent.jpg', durationMs: 1000 }])
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes('/v1/me/recommendations')) {
        return { ok: true, status: 200, data: { data: [{ attributes: { title: 'For You' }, relationships: { contents: { data: [{ id: '201', type: 'songs', attributes: { name: 'Recommended', artistName: 'Artist' } }] } } }] } }
      }
      if (path.includes('/v1/me/library/recently-added')) {
        return { ok: true, status: 200, data: { data: [{ id: 'i.album', type: 'library-albums', attributes: { name: 'Added' }, relationships: { catalog: { data: [{ id: '301', type: 'albums' }] } } }] } }
      }
      return { ok: true, status: 200, data: { data: [] } }
    })

    const page = await web.fetchAppleHomePage('cn')
    const recentIndex = page.sections.findIndex(section => section.id === 'home-recent-played')
    const addedIndex = page.sections.findIndex(section => section.id === 'home-recently-added')
    expect(recentIndex).toBeGreaterThan(-1)
    expect(addedIndex).toBeGreaterThan(recentIndex)
    expect(page.sections[recentIndex].items[0]).toMatchObject({ playId: '101', type: 'songs' })
  })

  it('preserves each chart item type and every chart returned by Apple', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        results: {
          songs: [
            {
              chart: 'most-played',
              shortName: '热门歌曲',
              data: [
                { id: 'song-1', type: 'songs', attributes: { name: 'Song' } },
                { id: 'playlist-1', type: 'playlists', attributes: { name: 'Playlist' } },
              ],
            },
            {
              chart: 'new-releases',
              shortName: '新歌',
              data: [{ id: 'song-2', type: 'songs', attributes: { name: 'New Song' } }],
            },
          ],
          cityCharts: [{
            chart: 'city',
            shortName: '城市榜',
            data: [{ id: 'city-1', attributes: { name: 'City Playlist' } }],
          }],
        },
      },
    })

    const sections = await web.fetchAppleTopCharts('cn')

    expect(sections).toHaveLength(3)
    expect(sections[0].items.map(item => item.type)).toEqual(['songs', 'playlists'])
    expect(sections[1].items[0].type).toBe('songs')
    expect(sections[2].items[0].type).toBe('playlists')
    expect(new Set(sections.map(section => section.id)).size).toBe(3)
  })

  it('requests paginated library data at non-truncating limits and reports partial failures', async () => {
    mocks.songs.mockRejectedValue(new Error('songs unavailable'))
    mocks.api.mockResolvedValue({ ok: true, status: 200, data: { data: [] } })

    const page = await web.fetchAppleLibraryPage('cn')

    expect(mocks.songs).toHaveBeenCalledWith(5000)
    expect(mocks.albums).toHaveBeenCalledWith(2000)
    expect(mocks.artists).toHaveBeenCalledWith(1000)
    expect(mocks.playlists).toHaveBeenCalledWith(2000)
    expect(mocks.videos).toHaveBeenCalledWith(1000)
    expect(page.fallbackReason).toContain('歌曲')
    expect(page.personalized).toBe(true)
  })
})
