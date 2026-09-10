/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  release: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  fatal: null as ((error: Error) => void) | null,
}))

vi.mock('../src/services/applePlayback', () => ({
  resolveAppleNativeStream: mocks.resolve,
  releaseAppleNativeStream: mocks.release,
}))

vi.mock('../src/services/appleHlsPlayer', () => ({
  attachAppleHls: mocks.attach,
  detachAppleHls: mocks.detach,
}))

vi.mock('../src/tv/tvCore', () => ({ useTvBack: vi.fn() }))

import AppleVideoModal from '../src/components/AppleVideoModal'
import type { AppleWebItem } from '../src/services/appleWebService'

const item: AppleWebItem = {
  id: 'video.1',
  playId: 'video.1',
  type: 'music-videos',
  name: 'Test Video',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fatal = null
  mocks.resolve.mockResolvedValue({ url: 'https://example.test/video.m3u8', masterUrl: 'https://example.test/video.m3u8', songId: 'video.1' })
  mocks.attach.mockImplementation(async (_element, _stream, onFatal) => { mocks.fatal = onFatal })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})

describe('AppleVideoModal', () => {
  it('notifies the caller once after a real play event', async () => {
    const onPlaybackStart = vi.fn()
    const view = render(<AppleVideoModal item={item} onClose={vi.fn()} onPlaybackStart={onPlaybackStart} />)

    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce())
    expect(onPlaybackStart).not.toHaveBeenCalled()
    const video = view.container.querySelector('video')!
    fireEvent.play(video)
    fireEvent.play(video)
    expect(onPlaybackStart).toHaveBeenCalledTimes(1)
  })

  it('does not report playback when autoplay is blocked', async () => {
    const autoplayError = new Error('blocked')
    autoplayError.name = 'NotAllowedError'
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(autoplayError)
    const onPlaybackStart = vi.fn()
    render(<AppleVideoModal item={item} onClose={vi.fn()} onPlaybackStart={onPlaybackStart} />)

    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce())
    expect(onPlaybackStart).not.toHaveBeenCalled()
  })

  it('shows a retry action when HLS fails after becoming ready', async () => {
    render(<AppleVideoModal item={item} onClose={vi.fn()} />)
    await waitFor(() => expect(mocks.fatal).toBeTypeOf('function'))

    mocks.fatal?.(new Error('Apple HLS load failed'))

    expect(await screen.findByText('Apple HLS load failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2))
  })
})
