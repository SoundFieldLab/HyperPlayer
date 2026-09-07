import { describe, expect, it } from 'vitest'
import { getAddablePlaylists } from '../src/services/addablePlaylists'

const owners = {
  neteaseUserId: 'n1',
  qqUserId: 'q1',
  spotifyUserId: 's1',
  kugouUserId: 'k1',
  sodaUserId: 'd1',
}

describe('addable playlists', () => {
  it('keeps only owned writable playlists on the song platform', () => {
    const playlists = [
      { id: 'mine', platform: 'netease', userId: 'n1' },
      { id: 'other', platform: 'netease', userId: 'n2', isCollected: true },
      { id: 'liked', platform: 'netease', userId: 'n1', isLike: true },
      { id: 'wrong-platform', platform: 'qq', userId: 'q1' },
    ]
    expect(getAddablePlaylists(playlists, 'netease', owners).map(item => item.id)).toEqual(['mine'])
  })

  it('rejects followed Spotify and virtual Soda playlists', () => {
    expect(getAddablePlaylists([
      { id: 'owned', platform: 'spotify', ownedByMe: true },
      { id: 'followed', platform: 'spotify', ownedByMe: false, owner: 'other' },
    ], 'spotify', owners).map(item => item.id)).toEqual(['owned'])

    expect(getAddablePlaylists([
      { id: 'qishui-recent', platform: 'soda', userId: 'd1' },
      { id: 'real', platform: 'soda', userId: 'd1' },
    ], 'soda', owners).map(item => item.id)).toEqual(['real'])
  })
})
