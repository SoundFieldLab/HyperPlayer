/** @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppleSearchBrowse from '../src/components/AppleSearchBrowse'
import * as appleWeb from '../src/services/appleWebService'

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: (_target, key) => key }),
}))

vi.mock('../src/services/appleWebService', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/appleWebService')>()
  return {
    ...actual,
    fetchAppleSearchLanding: vi.fn(),
    fetchAppleCuratorPage: vi.fn(),
    appleWebItemToSong: vi.fn(actual.appleWebItemToSong),
  }
})

const curator = (id: string, name: string) => ({
  id,
  playId: id,
  type: 'apple-curators' as const,
  name,
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Apple Explore categories', () => {
  it('返回类别浏览后可切换分类，且只渲染最新分类的详情', async () => {
    vi.mocked(appleWeb.fetchAppleSearchLanding).mockResolvedValue({
      sections: [{ id: 'curators', title: 'Categories', kind: 'curators', items: [curator('one', 'One'), curator('two', 'Two')] }],
      hero: null,
      personalized: false,
      sourceLabel: 'test',
    })
    vi.mocked(appleWeb.fetchAppleCuratorPage)
      .mockResolvedValueOnce({ curator: curator('one', 'One Detail'), sections: [], playlists: [], playlistCount: 0 })
      .mockResolvedValueOnce({ curator: curator('two', 'Two Detail'), sections: [], playlists: [], playlistCount: 0 })

    render(<AppleSearchBrowse onSongSelect={vi.fn()} />)
    await screen.findByText('One')
    fireEvent.click(screen.getByText('One'))
    await screen.findByText('One Detail')

    // 详情页的返回入口（组件自带按钮，不再依赖 TV back）回到「类别浏览」
    fireEvent.click(screen.getByRole('button', { name: '返回类别浏览' }))
    await waitFor(() => expect(screen.getByText('类别浏览')).toBeTruthy())
    expect(screen.queryByText('One Detail')).toBeNull()

    fireEvent.click(screen.getByText('Two'))
    await screen.findByText('Two Detail')
    expect(screen.queryByText('One Detail')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '返回类别浏览' }))
    await waitFor(() => expect(screen.getByText('类别浏览')).toBeTruthy())
  })

  it('keeps landing, curator details, and songs on the explicit storefront', async () => {
    vi.mocked(appleWeb.fetchAppleSearchLanding).mockResolvedValue({
      sections: [{ id: 'curators', title: 'Categories', kind: 'curators', items: [curator('one', 'One')] }],
      hero: null,
      personalized: false,
      sourceLabel: 'test',
    })
    vi.mocked(appleWeb.fetchAppleCuratorPage).mockResolvedValue({
      curator: curator('one', 'One Detail'),
      sections: [{
        id: 'songs',
        title: 'Songs',
        kind: 'grid',
        items: [{ id: 'song.1', playId: 'song.1', type: 'songs', name: 'Song One', artistName: 'Artist' }],
      }],
      playlists: [],
      playlistCount: 0,
    })
    const onSongSelect = vi.fn()

    render(<AppleSearchBrowse storefront="jp" onSongSelect={onSongSelect} />)
    fireEvent.click(await screen.findByText('One'))
    fireEvent.click(await screen.findByText('Song One'))

    expect(appleWeb.fetchAppleSearchLanding).toHaveBeenCalledWith('jp')
    expect(appleWeb.fetchAppleCuratorPage).toHaveBeenCalledWith('one', 'jp')
    expect(appleWeb.appleWebItemToSong).toHaveBeenCalledWith(expect.objectContaining({ id: 'song.1' }), 'jp')
    expect(vi.mocked(appleWeb.appleWebItemToSong).mock.calls.every(([, storefront]) => storefront === 'jp')).toBe(true)
    expect(onSongSelect).toHaveBeenCalledOnce()
  })

  it('shows and retries a failed category landing request', async () => {
    vi.mocked(appleWeb.fetchAppleSearchLanding)
      .mockRejectedValueOnce(new Error('landing unavailable'))
      .mockResolvedValueOnce({
        sections: [{ id: 'curators', title: 'Categories', kind: 'curators', items: [curator('one', 'Recovered Category')] }],
        hero: null,
        personalized: false,
        sourceLabel: 'test',
      })

    render(<AppleSearchBrowse onSongSelect={vi.fn()} />)
    expect((await screen.findByRole('alert')).textContent).toContain('landing unavailable')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('Recovered Category')
    expect(appleWeb.fetchAppleSearchLanding).toHaveBeenCalledTimes(2)
  })

  it('retries a failed curator request locally', async () => {
    vi.mocked(appleWeb.fetchAppleSearchLanding).mockResolvedValue({
      sections: [{ id: 'curators', title: 'Categories', kind: 'curators', items: [curator('one', 'One')] }],
      hero: null,
      personalized: false,
      sourceLabel: 'test',
    })
    vi.mocked(appleWeb.fetchAppleCuratorPage)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ curator: curator('one', 'Recovered'), sections: [], playlists: [], playlistCount: 0 })

    render(<AppleSearchBrowse onSongSelect={vi.fn()} />)
    fireEvent.click(await screen.findByText('One'))
    fireEvent.click(await screen.findByText('重试'))
    await screen.findByText('Recovered')
    expect(appleWeb.fetchAppleCuratorPage).toHaveBeenCalledTimes(2)
  })
})
