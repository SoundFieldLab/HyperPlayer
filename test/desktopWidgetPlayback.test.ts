import { describe, expect, it } from 'vitest'
import { clampPlaybackProgress, getLyricExcerpt } from '../src/services/desktopWidgetPlayback'

describe('desktop widget playback helpers', () => {
  it('clamps progress to a finite 0..1 range', () => {
    expect(clampPlaybackProgress(-2, 100)).toBe(0)
    expect(clampPlaybackProgress(25, 100)).toBe(0.25)
    expect(clampPlaybackProgress(120, 100)).toBe(1)
    expect(clampPlaybackProgress(1, 0)).toBe(0)
    expect(clampPlaybackProgress(Number.NaN, 100)).toBe(0)
  })

  it('returns an empty excerpt during the lyric prelude', () => {
    expect(getLyricExcerpt([{ time: 5, text: 'first' }], 0)).toBe('')
  })

  it('skips empty lyric lines and selects the last eligible line', () => {
    const lyrics = [
      { time: 1, text: '  ' },
      { time: 2, text: 'second' },
      { time: 4, text: '' },
      { time: 6, text: 'last' },
    ]
    expect(getLyricExcerpt(lyrics, 1.6, 0, 0)).toBe('')
    expect(getLyricExcerpt(lyrics, 5, 0, 0)).toBe('second')
    expect(getLyricExcerpt(lyrics, 8, 0, 0)).toBe('last')
  })

  it('applies lyric offset to boundary selection', () => {
    expect(getLyricExcerpt([{ time: 5, text: 'shifted' }], 4, 1, 0)).toBe('shifted')
  })
})
