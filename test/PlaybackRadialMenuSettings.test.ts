import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULT_PLAYBACK_RADIAL_ACTIONS,
  MAX_PLAYBACK_RADIAL_ACTIONS,
  getAvailablePlaybackRadialActions,
  normalizePlaybackRadialActions,
  setPlaybackRadialActions,
  getPlaybackRadialActions,
} from '../src/services/playbackRadialMenuSettings'

describe('playback radial menu settings', () => {
  beforeEach(() => localStorage.clear())

  it('normalizes unknown, duplicate, and oversized action lists', () => {
    const actions = normalizePlaybackRadialActions(['comments', 'comments', 'nope', ...DEFAULT_PLAYBACK_RADIAL_ACTIONS, 'similar'])
    expect(actions.length).toBe(MAX_PLAYBACK_RADIAL_ACTIONS)
    expect(new Set(actions).size).toBe(actions.length)
    expect(actions[0]).toBe('comments')
  })

  it('persists normalized actions and falls back to defaults', () => {
    expect(getPlaybackRadialActions()).toEqual(DEFAULT_PLAYBACK_RADIAL_ACTIONS)
    setPlaybackRadialActions(['play' as any, 'play-next', 'play-next'])
    expect(getPlaybackRadialActions()).toEqual(['play-next'])
  })

  it('filters actions by platform capability', () => {
    expect(getAvailablePlaybackRadialActions('netease').some(action => action.id === 'comments')).toBe(true)
    expect(getAvailablePlaybackRadialActions('qq').some(action => action.id === 'similar')).toBe(true)
    // 缺省平台回退网易云能力表
    expect(getAvailablePlaybackRadialActions()).toEqual(getAvailablePlaybackRadialActions('netease'))
    // 无能力约束的动作两个平台都必须保留
    for (const platform of ['netease', 'qq'] as const) {
      expect(getAvailablePlaybackRadialActions(platform).some(action => action.id === 'copy-info')).toBe(true)
    }
  })
})
