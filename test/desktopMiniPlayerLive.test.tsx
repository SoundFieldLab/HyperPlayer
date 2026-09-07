/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DesktopMiniPlayer from '../src/components/DesktopMiniPlayer'
import type { Song } from '../src/services/musicApi'

const radioSong: Song = {
  id: 0,
  name: 'Radio',
  artists: [{ name: 'Apple Music' }],
  album: { name: 'Radio', picUrl: '' },
  duration: 0,
  platform: 'apple',
  appleRadio: { stationId: 'station', storefront: 'cn', timeline: 'live' },
}

describe('DesktopMiniPlayer live semantics', () => {
  it('shows live state without finite progress or queue navigation', () => {
    const { container } = render(
      <DesktopMiniPlayer
        currentSong={radioSong}
        isPlaying
        live
        currentTime={20}
        duration={60}
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        cardBlurAmount={12}
      />,
    )
    expect(screen.getByText('正在直播')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '上一首' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下一首' })).toBeNull()
    expect(container.querySelector('[style*="scaleX"]')).toBeNull()
  })
})
