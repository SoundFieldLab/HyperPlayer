import type { MusicPlatform } from './platforms'

export type AudioQualityPreference =
  | 'auto'
  | 'standard'
  | 'high'
  | 'very-high'
  | 'lossless'
  | 'hi-res'

export type AppleAudioQualityPreference =
  | 'auto'
  | 'aac'
  | 'lossless'
  | 'hi-res-lossless'
  | 'atmos'

export interface AudioQualitySettings {
  netease: AudioQualityPreference
  qq: AudioQualityPreference
  spotify: AudioQualityPreference
  kugou: AudioQualityPreference
  soda: AudioQualityPreference
  apple: AppleAudioQualityPreference
}

export const AUDIO_QUALITY_SETTINGS_KEY = 'audioQualitySettings'
export const AUDIO_QUALITY_SETTINGS_EVENT = 'waveforge-audio-quality-changed'

export const DEFAULT_AUDIO_QUALITY_SETTINGS: AudioQualitySettings = {
  netease: 'auto',
  qq: 'auto',
  spotify: 'auto',
  kugou: 'auto',
  soda: 'auto',
  apple: 'auto',
}

const QUALITY_VALUES: AudioQualityPreference[] = [
  'auto',
  'standard',
  'high',
  'very-high',
  'lossless',
  'hi-res',
]

const APPLE_QUALITY_VALUES: AppleAudioQualityPreference[] = [
  'auto',
  'aac',
  'lossless',
  'hi-res-lossless',
  'atmos',
]

const isQualityPreference = (value: unknown): value is AudioQualityPreference => (
  typeof value === 'string' && QUALITY_VALUES.includes(value as AudioQualityPreference)
)

const isAppleQualityPreference = (value: unknown): value is AppleAudioQualityPreference => (
  typeof value === 'string' && APPLE_QUALITY_VALUES.includes(value as AppleAudioQualityPreference)
)

export function loadAudioQualitySettings(): AudioQualitySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }

  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIO_QUALITY_SETTINGS_KEY) || '{}') as Partial<AudioQualitySettings>
    return {
      netease: isQualityPreference(parsed.netease) ? parsed.netease : DEFAULT_AUDIO_QUALITY_SETTINGS.netease,
      qq: isQualityPreference(parsed.qq) ? parsed.qq : DEFAULT_AUDIO_QUALITY_SETTINGS.qq,
      spotify: isQualityPreference(parsed.spotify) ? parsed.spotify : DEFAULT_AUDIO_QUALITY_SETTINGS.spotify,
      kugou: isQualityPreference(parsed.kugou) ? parsed.kugou : DEFAULT_AUDIO_QUALITY_SETTINGS.kugou,
      soda: isQualityPreference(parsed.soda) ? parsed.soda : DEFAULT_AUDIO_QUALITY_SETTINGS.soda,
      apple: isAppleQualityPreference(parsed.apple) ? parsed.apple : DEFAULT_AUDIO_QUALITY_SETTINGS.apple,
    }
  } catch {
    return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }
  }
}

export function saveAudioQualitySettings(patch: Partial<AudioQualitySettings>): AudioQualitySettings {
  const next = {
    ...loadAudioQualitySettings(),
    ...patch,
  }
  if (!isQualityPreference(next.netease)) next.netease = DEFAULT_AUDIO_QUALITY_SETTINGS.netease
  if (!isQualityPreference(next.qq)) next.qq = DEFAULT_AUDIO_QUALITY_SETTINGS.qq
  if (!isQualityPreference(next.spotify)) next.spotify = DEFAULT_AUDIO_QUALITY_SETTINGS.spotify
  if (!isQualityPreference(next.kugou)) next.kugou = DEFAULT_AUDIO_QUALITY_SETTINGS.kugou
  if (!isQualityPreference(next.soda)) next.soda = DEFAULT_AUDIO_QUALITY_SETTINGS.soda
  if (!isAppleQualityPreference(next.apple)) next.apple = DEFAULT_AUDIO_QUALITY_SETTINGS.apple

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(AUDIO_QUALITY_SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(AUDIO_QUALITY_SETTINGS_EVENT, { detail: next }))
  }
  return next
}

export function getAudioQualityPreference(platform: MusicPlatform): AudioQualityPreference | AppleAudioQualityPreference {
  const settings = loadAudioQualitySettings()
  if (platform === 'apple') return settings.apple
  if (platform === 'spotify') return settings.spotify
  if (platform === 'kugou') return settings.kugou
  if (platform === 'soda') return settings.soda
  return settings[platform as 'netease' | 'qq']
}

export function getPlatformVipState(platform: MusicPlatform): boolean {
  if (typeof localStorage === 'undefined') return false
  if (platform === 'apple' || platform === 'spotify' || platform === 'soda') return false
  if (platform === 'kugou') return localStorage.getItem('kugou_vip') === 'true'
  return localStorage.getItem(platform === 'netease' ? 'netease_vip' : 'qq_vip') === 'true'
}

export function getAudioQualityRequest(platform: MusicPlatform): {
  preference: AudioQualityPreference | AppleAudioQualityPreference
  isVip: boolean
} {
  return {
    preference: getAudioQualityPreference(platform),
    isVip: getPlatformVipState(platform),
  }
}
