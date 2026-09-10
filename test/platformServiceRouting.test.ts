import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchSpotifyPlaylists = vi.fn()
const fetchSpotifyAlbum = vi.fn()
const fetchSpotifyArtistTopTracks = vi.fn()
const spotifyTrackToSong = vi.fn((track: any) => ({
  id: 1,
  mid: track.id,
  name: track.name,
  artists: track.artists || [],
  album: track.album || { name: '', picUrl: '' },
  duration: 0,
  platform: 'spotify',
}))

// 减配后 kugou / soda 平台及其服务已移除，本文件只保留 Spotify 跨平台路由用例。
vi.mock('../src/services/spotifyService', () => ({
  searchSpotifyPlaylists,
  fetchSpotifyAlbum,
  fetchSpotifyArtistTopTracks,
  spotifyTrackToSong,
}))

const { getAlbumSongs, searchPlaylists } = await import('../src/services/musicApi')

describe('cross-platform service routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected legacy request'))))
  })

  it('normalizes Spotify playlist search without legacy backend requests', async () => {
    searchSpotifyPlaylists.mockResolvedValue([{ id: 'sp-list', name: 'Mix', coverUrl: 'cover', tracksTotal: 12, owner: 'owner' }])
    await expect(searchPlaylists('mix', 'spotify')).resolves.toEqual({ playlists: [{
      id: 'sp-list', name: 'Mix', coverImgUrl: 'cover', trackCount: 12, creator: 'owner', platform: 'spotify',
    }] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('routes Spotify album tracks through Spotify services', async () => {
    fetchSpotifyAlbum.mockResolvedValue({ songs: [{ id: 'track', name: 'Song', artists: [{ name: 'Artist', id: 'artist' }], album: { id: 'album', name: 'Album' } }] })
    const songs = await getAlbumSongs('album', 'spotify')
    expect(fetchSpotifyAlbum).toHaveBeenCalledWith('album')
    expect(songs[0]).toMatchObject({ mid: 'track', platform: 'spotify' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
