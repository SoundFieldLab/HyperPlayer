import { useSyncExternalStore } from 'react'
import {
  getPlaybackDisplaySnapshot,
  subscribePlaybackDisplaySettings,
  type PlaybackDisplaySettings,
} from '../services/playbackDisplaySettings'

/** 播放页显示偏好的 React adapter；写入仍走 service 的 setter。 */
export function usePlaybackDisplaySettings(): PlaybackDisplaySettings {
  return useSyncExternalStore(
    subscribePlaybackDisplaySettings,
    getPlaybackDisplaySnapshot,
    getPlaybackDisplaySnapshot,
  )
}
