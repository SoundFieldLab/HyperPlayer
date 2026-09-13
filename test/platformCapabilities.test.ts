import { describe, expect, it } from 'vitest'
import { getPlatformCapabilities } from '../src/services/platforms'

describe('platform capability contracts', () => {
  it('exposes only supported playlist operations', () => {
    expect(getPlatformCapabilities('netease')).toMatchObject({ searchPlaylists: true, updatePlaylist: true, deletePlaylist: true, sharePlaylist: true, removeTracksFromPlaylist: true })
    expect(getPlatformCapabilities('qq')).toMatchObject({ searchPlaylists: true, updatePlaylist: false, deletePlaylist: true, sharePlaylist: true, removeTracksFromPlaylist: true })
  })

  it('only declares the two surviving music platforms', () => {
    expect(getPlatformCapabilities('netease').login).toBe(true)
    expect(getPlatformCapabilities('qq').login).toBe(true)
    // QQ 无听歌排行 / 云盘，网易云有
    expect(getPlatformCapabilities('netease')).toMatchObject({ rank: true, cloudDisk: true })
    expect(getPlatformCapabilities('qq')).toMatchObject({ rank: false, cloudDisk: false })
  })
})
