import { useSyncExternalStore } from 'react'
import {
  getLyricModeSnapshot,
  subscribeLyricModeSettings,
  type LyricModeSettings,
} from '../services/lyricModeSettings'

/** 歌词模式偏好的 React adapter；写入仍走 service 的 commit / toggle。 */
export function useLyricModeSettings(): LyricModeSettings {
  return useSyncExternalStore(
    subscribeLyricModeSettings,
    getLyricModeSnapshot,
    getLyricModeSnapshot,
  )
}
