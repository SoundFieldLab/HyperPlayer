/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PlaylistDetailPanel from '../src/components/PlaylistDetailPanel'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PlaylistDetailPanel errors', () => {
  it('shows a retriable error instead of an empty playlist state', () => {
    const onRetry = vi.fn()
    render(
      <PlaylistDetailPanel
        show
        playlist={{ id: 'pl.1', name: 'Test Playlist', coverImgUrl: '', trackCount: 10, platform: 'apple' }}
        songs={[]}
        loading={false}
        error="Apple Music 登录或订阅状态无效，请重新登录"
        onRetry={onRetry}
        onClose={vi.fn()}
        onSongSelect={vi.fn()}
        currentPlatform="apple"
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('Apple Music 登录或订阅状态无效')
    expect(screen.queryByText('当前歌单暂无歌曲')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
