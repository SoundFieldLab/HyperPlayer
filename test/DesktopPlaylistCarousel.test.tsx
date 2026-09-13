/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlaylistCarousel3D from '../src/components/PlaylistCarousel3D'

vi.mock('../src/platform', () => ({ isTvModeActive: () => false }))
vi.mock('../src/tv/tvCore', () => ({
  setTvFocus: vi.fn(),
  useTvFocus: () => null,
}))

afterEach(cleanup)

describe('Desktop playlist carousel', () => {
  it('shows an explicit fallback when playlist artwork fails', () => {
    const playlist = {
      id: 'broken-playlist',
      name: 'Broken Cover',
      coverImgUrl: 'https://example.test/broken.jpg',
      platform: 'netease' as const,
    }

    render(
      <PlaylistCarousel3D
        playlists={[playlist]}
        platform="netease"
        onPlaylistSelect={vi.fn()}
      />,
    )

    fireEvent.error(screen.getByRole('img', { name: 'Broken Cover' }))
    expect(screen.getByText('暂无封面')).not.toBeNull()
  })

  it('preserves the playlist platform when selecting a desktop playlist', () => {
    const onPlaylistSelect = vi.fn()
    const playlist = {
      id: 'qq-playlist',
      name: 'QQ Mix',
      coverImgUrl: 'https://example.test/cover.jpg',
      platform: 'qq' as const,
      ownedByMe: true,
    }

    render(
      <PlaylistCarousel3D
        playlists={[playlist]}
        platform="netease"
        onPlaylistSelect={onPlaylistSelect}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'QQ Mix' }))
    expect(onPlaylistSelect).toHaveBeenCalledWith(playlist)
  })
})
