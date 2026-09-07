import { describe, expect, it } from 'vitest'
import { sanitizeAppleRadioPlayParams } from '../src/services/applePlayback'
import { appleStationToSong, type AppleWebItem } from '../src/services/appleWebService'

describe('Apple radio playback descriptor', () => {
  it('preserves all safe scalar play parameters', () => {
    const input = JSON.parse('{"id":"asset.1","kind":"radioStation","stationHash":"abc","customFlag":true,"seed":42,"nested":{"no":true},"list":[1]}')
    Object.defineProperty(input, 'constructor', { value: 'blocked', enumerable: true })
    const result = sanitizeAppleRadioPlayParams(input)
    expect({ ...result }).toEqual({ id: 'asset.1', kind: 'radioStation', stationHash: 'abc', customFlag: true, seed: 42 })
    expect(Object.getPrototypeOf(result)).toBeNull()
  })

  it('stores station presentation but not an expiring stream in the queue', () => {
    const station: AppleWebItem = {
      id: 'ra.1',
      playId: 'ra.1',
      type: 'stations',
      name: '测试电台',
      showName: '测试节目',
      description: '描述',
      artworkUrl: 'static.jpg',
      motionArtworkUrl: 'motion.m3u8',
      motionPosterUrl: 'poster.jpg',
      heroArtworkUrl: 'hero.jpg',
      isLive: true,
      playParams: { id: 'asset.1', kind: 'radioStation', extra: 'kept' },
    }
    const song = appleStationToSong(station, { url: 'expired.m3u8', masterUrl: 'expired.m3u8', songId: 'ra.1' }, 'cn')
    expect(song.appleRadio).toMatchObject({
      stationId: 'ra.1',
      storefront: 'cn',
      timeline: 'live',
      motionArtworkUrl: 'motion.m3u8',
      motionPosterUrl: 'poster.jpg',
      heroArtworkUrl: 'hero.jpg',
      playParams: { extra: 'kept' },
    })
    expect(song.appleRadio?.stream).toBeUndefined()
  })
})
