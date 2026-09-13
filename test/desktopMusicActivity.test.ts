import { beforeEach, describe, expect, it } from 'vitest'
import {
  addDesktopListeningSeconds,
  clearDesktopMusicActivity,
  getDesktopActivityForPlatform,
  getDesktopSongKey,
  loadDesktopMusicActivity,
  recordDesktopSongStart,
} from '../src/services/desktopMusicActivity'
import type { Song } from '../src/services/musicApi'

const song = (overrides: Partial<Song>): Song => ({
  id: 1,
  name: '测试歌曲',
  artists: [{ name: '测试歌手' }],
  album: { name: '测试专辑', picUrl: '' },
  duration: 180000,
  ...overrides,
})

describe('desktop music activity platform isolation', () => {
  beforeEach(() => localStorage.clear())

  it('builds activity identity from the song platform and mid', () => {
    expect(getDesktopSongKey(song({ platform: 'netease', id: 123 }))).toBe('netease:123')
    expect(getDesktopSongKey(song({ platform: 'qq', mid: 'QQMID', id: 123 }))).toBe('qq:QQMID')
    expect(getDesktopSongKey(song({ platform: 'netease', mid: 'NMID', id: 123 }))).toBe('netease:NMID')
  })

  it('keeps history and daily totals separated by song platform', () => {
    const netease = song({ platform: 'netease', id: 1 })
    const qq = song({ platform: 'qq', id: 0, mid: 'qq-mid' })
    recordDesktopSongStart(netease)
    addDesktopListeningSeconds(netease, 20)
    recordDesktopSongStart(qq)
    addDesktopListeningSeconds(qq, 30)

    const activity = loadDesktopMusicActivity()
    expect(getDesktopActivityForPlatform(activity, 'netease').history).toHaveLength(1)
    expect(getDesktopActivityForPlatform(activity, 'qq').history).toHaveLength(1)
    expect(getDesktopActivityForPlatform(activity, 'netease').days).toEqual(expect.objectContaining({
      [new Date().toLocaleDateString('sv-SE')]: expect.objectContaining({ listenedSeconds: 20, platform: 'netease' }),
    }))
    expect(getDesktopActivityForPlatform(activity, 'qq').days).toEqual(expect.objectContaining({
      [new Date().toLocaleDateString('sv-SE')]: expect.objectContaining({ listenedSeconds: 30, platform: 'qq' }),
    }))
  })

  it('clears only the selected platform activity', () => {
    recordDesktopSongStart(song({ platform: 'netease', id: 1 }))
    recordDesktopSongStart(song({ platform: 'qq', id: 0, mid: 'qq-mid' }))

    clearDesktopMusicActivity('qq')

    const activity = loadDesktopMusicActivity()
    expect(getDesktopActivityForPlatform(activity, 'qq').history).toEqual([])
    expect(getDesktopActivityForPlatform(activity, 'netease').history).toHaveLength(1)
  })

  it('does not assign legacy unscoped daily totals to Netease', () => {
    localStorage.setItem('desktopMusicActivityV1', JSON.stringify({
      history: [],
      days: { '2026-09-06': { date: '2026-09-06', listenedSeconds: 99, songStarts: 3 } },
      lastSongKey: '',
      lastStartedAt: 0,
    }))
    const activity = loadDesktopMusicActivity()
    expect(getDesktopActivityForPlatform(activity, 'netease').days).toEqual({})
  })
})
