/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  DEFAULT_AUDIO_QUALITY_SETTINGS,
  getAudioQualityPreference,
  loadAudioQualitySettings,
  saveAudioQualitySettings,
} from '../src/services/audioQualitySettings'

describe('audioQualitySettings Apple preference', () => {
  beforeEach(() => localStorage.clear())

  it('gives Apple an independent auto preference', () => {
    expect(loadAudioQualitySettings()).toEqual(DEFAULT_AUDIO_QUALITY_SETTINGS)
    expect(getAudioQualityPreference('apple')).toBe('auto')
  })

  it('does not borrow the Netease preference for Apple', () => {
    saveAudioQualitySettings({ netease: 'hi-res', apple: 'aac' })
    expect(getAudioQualityPreference('netease')).toBe('hi-res')
    expect(getAudioQualityPreference('apple')).toBe('aac')
  })

  it('rejects unsupported persisted Apple values', () => {
    localStorage.setItem('audioQualitySettings', JSON.stringify({ apple: 'fake-atmos', qq: 'high' }))
    const settings = loadAudioQualitySettings()
    expect(settings.apple).toBe('auto')
    expect(settings.qq).toBe('high')
  })

  it('emits the complete updated settings snapshot', () => {
    const listener = vi.fn()
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
    const settings = saveAudioQualitySettings({ apple: 'aac' })
    expect(settings.apple).toBe('aac')
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(settings)
    window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
  })
})
