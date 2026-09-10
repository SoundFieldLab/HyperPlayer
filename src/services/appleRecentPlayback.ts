import type { Song } from './musicApi'

const STORAGE_KEY = 'appleRecentPlaybackFallbackV1'
const MAX_ITEMS = 100

const appleSongIdentity = (song: Song) => String(song.appleId || song.appleLibraryId || song.mid || song.id || '')

const normalizeStoredSong = (value: unknown): Song | null => {
  if (!value || typeof value !== 'object') return null
  const song = value as Song
  if (song.platform !== 'apple' || !song.name || !appleSongIdentity(song)) return null
  return song
}

export const readAppleRecentPlaybackFallback = (): Song[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.map(normalizeStoredSong).filter((song): song is Song => Boolean(song)) : []
  } catch {
    return []
  }
}

export const recordAppleRecentPlaybackFallback = (song: Song) => {
  if (song.platform !== 'apple') return
  const identity = appleSongIdentity(song)
  if (!identity) return
  const next = [song, ...readAppleRecentPlaybackFallback().filter(item => appleSongIdentity(item) !== identity)].slice(0, MAX_ITEMS)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    return
  }
  window.dispatchEvent(new CustomEvent('hyperplayer-recent-playback-reported', { detail: { platform: 'apple' } }))
}

export const mergeAppleRecentPlayback = (remote: Song[], local = readAppleRecentPlaybackFallback(), limit = MAX_ITEMS) => {
  const seen = new Set<string>()
  return [...remote, ...local].filter(song => {
    const identity = appleSongIdentity(song)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  }).slice(0, limit)
}
