import type { LyricLine } from './musicApi'

export function clampPlaybackProgress(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(1, Math.max(0, currentTime / duration))
}

export function getLyricExcerpt(lyrics: LyricLine[], currentTime: number, lyricOffset = 0, leadSeconds = 0.5): string {
  if (!lyrics.length || !Number.isFinite(currentTime)) return ''
  const adjustedTime = currentTime + leadSeconds + (Number.isFinite(lyricOffset) ? lyricOffset : 0)
  for (let index = lyrics.length - 1; index >= 0; index -= 1) {
    if (lyrics[index].time > adjustedTime) continue
    const text = lyrics[index].text.trim()
    if (text) return text
  }
  return ''
}
