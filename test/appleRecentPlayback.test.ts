import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Song } from '../src/services/musicApi'
import { mergeAppleRecentPlayback, readAppleRecentPlaybackFallback, recordAppleRecentPlaybackFallback } from '../src/services/appleRecentPlayback'

const song = (appleId: string, name: string): Song => ({
  id: 0,
  appleId,
  platform: 'apple',
  name,
  artists: [{ name: 'Artist' }],
  album: { name: 'Album', picUrl: `${appleId}.jpg` },
  duration: 180000,
})

describe('Apple recent playback fallback', () => {
  beforeEach(() => localStorage.clear())

  it('records unique Apple identities newest first', () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    recordAppleRecentPlaybackFallback(song('one', 'One'))
    recordAppleRecentPlaybackFallback(song('two', 'Two'))
    recordAppleRecentPlaybackFallback(song('one', 'One again'))

    expect(readAppleRecentPlaybackFallback().map(item => item.name)).toEqual(['One again', 'Two'])
  })

  it('keeps remote order and appends local tracks not yet synchronized', () => {
    const merged = mergeAppleRecentPlayback([song('one', 'Remote one')], [song('two', 'Local two'), song('one', 'Local one')])

    expect(merged.map(item => item.name)).toEqual(['Remote one', 'Local two'])
  })
})
