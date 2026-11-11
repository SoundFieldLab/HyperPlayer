/** @vitest-environment jsdom */
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SearchSongList from '../src/components/SearchSongList'
import type { Song } from '../src/services/musicApi'

const songs: Song[] = Array.from({ length: 100 }, (_, index) => ({
  id: index + 1, name: `歌曲 ${index + 1}`, artists: [{ name: '歌手' }],
  album: { name: '专辑', picUrl: '' }, duration: 180_000, platform: 'netease',
}))

beforeEach(() => {
  // jsdom 没有布局；仅提供浏览器几何与 ResizeObserver，不替换虚拟列表实现。
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return this.dataset.scrollHost ? 480 : 88
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(192)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('搜索歌曲虚拟列表', () => {
  it('只挂载可见歌曲；滚动跨过上方实体区后，原歌曲索引与点击、右键归属不变', async () => {
    const scrollRef = createRef<HTMLDivElement>()
    const selected = vi.fn()
    const context = vi.fn()
    render(
      <div ref={scrollRef} data-scroll-host="true">
        <div style={{ height: 192 }}>实体区</div>
        <SearchSongList songs={songs} scrollContainerRef={scrollRef}>
          {(song, index) => (
            <button data-song-index={index} onClick={() => selected(song.id)} onContextMenu={() => context(song.id)}>
              {song.name}
            </button>
          )}
        </SearchSongList>
      </div>,
    )
    await screen.findByText('歌曲 1')
    expect(screen.queryByText('歌曲 100')).toBeNull()
    expect(document.querySelectorAll('[data-song-index]').length).toBeLessThan(20)
    const host = scrollRef.current!
    host.scrollTop = 192 + 50 * 96
    fireEvent.scroll(host)
    await waitFor(() => expect(screen.queryByText('歌曲 51')).not.toBeNull())
    expect(screen.queryByText('歌曲 1')).toBeNull()
    expect(document.querySelectorAll('[data-song-index]').length).toBeLessThan(20)
    fireEvent.click(screen.getByText('歌曲 51'))
    fireEvent.contextMenu(screen.getByText('歌曲 51'))
    expect(selected).toHaveBeenCalledWith(51)
    expect(context).toHaveBeenCalledWith(51)
  })
})
