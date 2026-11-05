import { useSyncExternalStore } from 'react'
import {
  getTransitionSnapshot,
  subscribeTransitionSettings,
  type TransitionSettings,
} from '../services/transitionSettings'

/** 播放过渡设置的 React adapter；写入仍走 service 的 setter。 */
export function useTransitionSettings(): TransitionSettings {
  return useSyncExternalStore(
    subscribeTransitionSettings,
    getTransitionSnapshot,
    getTransitionSnapshot,
  )
}
