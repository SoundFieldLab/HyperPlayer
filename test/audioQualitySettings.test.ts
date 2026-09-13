/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  DEFAULT_AUDIO_QUALITY_SETTINGS,
  getAudioQualityPreference,
  loadAudioQualitySettings,
  saveAudioQualitySettings,
} from '../src/services/audioQualitySettings'

describe('audioQualitySettings per-platform preference', () => {
  beforeEach(() => localStorage.clear())

  it('gives each platform an independent auto preference', () => {
    expect(loadAudioQualitySettings()).toEqual(DEFAULT_AUDIO_QUALITY_SETTINGS)
    expect(getAudioQualityPreference('netease')).toBe('auto')
    expect(getAudioQualityPreference('qq')).toBe('auto')
  })

  it('does not borrow the Netease preference for QQ', () => {
    saveAudioQualitySettings({ netease: 'hi-res', qq: 'high' })
    expect(getAudioQualityPreference('netease')).toBe('hi-res')
    expect(getAudioQualityPreference('qq')).toBe('high')
  })

  it('rejects unsupported persisted values', () => {
    localStorage.setItem('audioQualitySettings', JSON.stringify({ netease: 'fake-atmos', qq: 'high' }))
    const settings = loadAudioQualitySettings()
    expect(settings.netease).toBe('auto')
    expect(settings.qq).toBe('high')
  })

  it('emits the complete updated settings snapshot', () => {
    const listener = vi.fn()
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
    const settings = saveAudioQualitySettings({ netease: 'lossless' })
    expect(settings.netease).toBe('lossless')
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(settings)
    window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
  })
})
