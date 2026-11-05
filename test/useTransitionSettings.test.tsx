// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { setTransitionMode, TRANSITION_KEYS } from '../src/services/transitionSettings'
import { useTransitionSettings } from '../src/hooks/useTransitionSettings'

afterEach(() => cleanup())

describe('useTransitionSettings', () => {
  it('订阅 service 写入并触发重渲染', () => {
    for (const key of Object.values(TRANSITION_KEYS)) localStorage.removeItem(key)

    const { result } = renderHook(() => useTransitionSettings())
    expect(result.current.crossfadeEnabled).toBe(false)

    act(() => {
      setTransitionMode('crossfade', true)
    })

    expect(result.current.crossfadeEnabled).toBe(true)
  })
})
