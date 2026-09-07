/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManualMarkPrompt } from '../src/components/BilibiliMvPlayer'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('manual MV mark prompt', () => {
  it('counts down from ten and auto-dismisses once', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<ManualMarkPrompt songTitle="Villain" onConfirm={vi.fn()} onDismiss={onDismiss} />)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: '不标记，10 秒后自动关闭' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('不标记 (9)')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(9000) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('cleans timers after explicit confirmation or dismissal', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn()
    const onDismiss = vi.fn()
    const { unmount } = render(<ManualMarkPrompt songTitle="Villain" onConfirm={onConfirm} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: '标记' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    unmount()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
