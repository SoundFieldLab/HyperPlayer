/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlaylistTrackPage } from '../src/services/playlistService'
import { usePlaylistPaging } from '../src/hooks/usePlaylistPaging'

function track(id: number, name = `Track ${id}`) {
  return {
    id,
    name,
    ar: [{ id: `artist-${id}`, name: 'Artist' }],
    al: { id: `album-${id}`, name: 'Album', picUrl: '' },
    dt: 120_000,
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('playlist paging contract', () => {
  it('requests a real offset/limit page and preserves stable order', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      playlist: {
        id: 'pl-1',
        trackCount: 6,
        tracks: [track(5), track(6)],
      },
      offset: 4,
      limit: 2,
      nextOffset: 6,
      more: false,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await getPlaylistTrackPage('pl-1', 'netease', 4, 2)

    expect(String(fetchMock.mock.calls[0][0])).toContain('offset=4')
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=2')
    expect(page.songs.map(song => song.id)).toEqual([5, 6])
    expect(page.nextOffset).toBe(6)
    expect(page.more).toBe(false)
  })

  it('surfaces a page that claims more data without advancing its cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      playlist: { id: 'pl-stalled', trackCount: 100, tracks: [track(1)] },
      offset: 0,
      limit: 1,
      nextOffset: 0,
      more: true,
    })))

    await expect(getPlaylistTrackPage('pl-stalled', 'netease', 0, 50))
      .rejects.toThrow('歌单分页页码未前进')
  })

  it('locates a song outside the first page, skips duplicates and reaches the explicit end', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const offset = Number(url.searchParams.get('offset'))
      return jsonResponse(offset === 0
        ? {
            playlist: { id: 'pl-2', trackCount: 3, tracks: [track(1), track(2)] },
            offset: 0,
            limit: 2,
            nextOffset: 2,
            more: true,
          }
        : {
            playlist: { id: 'pl-2', trackCount: 3, tracks: [track(2), track(3)] },
            offset: 2,
            limit: 2,
            nextOffset: 4,
            more: false,
          })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => usePlaylistPaging(2))
    await act(async () => {
      await result.current.open('pl-2', 'netease')
    })
    await act(async () => {
      await result.current.locateSong({
        id: 3,
        name: 'Track 3',
        artists: [],
        album: { name: 'Album', picUrl: '' },
        duration: 120_000,
        platform: 'netease',
      })
    })

    await waitFor(() => expect(result.current.songs.map(song => song.id)).toEqual([1, 2, 3]))
    expect(result.current.hasMore).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('loads the complete queue from the current page and deduplicates it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const offset = Number(url.searchParams.get('offset'))
      return jsonResponse(offset === 0
        ? {
            playlist: { id: 'pl-3', trackCount: 4, tracks: [track(1), track(2)] },
            offset: 0,
            limit: 2,
            nextOffset: 2,
            more: true,
          }
        : {
            playlist: { id: 'pl-3', trackCount: 4, tracks: [track(2), track(3), track(4)] },
            offset: 2,
            limit: 2,
            nextOffset: 5,
            more: false,
          })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => usePlaylistPaging(2))
    await act(async () => {
      await result.current.open('pl-3', 'netease')
    })
    let completeSongs: Awaited<ReturnType<typeof result.current.loadAll>> = []
    await act(async () => {
      completeSongs = await result.current.loadAll()
    })

    expect(completeSongs.map(song => song.id)).toEqual([1, 2, 3, 4])
    expect(result.current.songs.map(song => song.id)).toEqual([1, 2, 3, 4])
    expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).searchParams.get('offset'))).toEqual(['0', '2'])
  })

  it('rejects an in-progress complete load when the user cancels it', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.searchParams.get('offset') === '0') {
        return Promise.resolve(jsonResponse({
          playlist: { id: 'pl-cancel', trackCount: 100, tracks: [track(1)] },
          offset: 0,
          limit: 50,
          nextOffset: 50,
          more: true,
        }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => usePlaylistPaging(50))
    await act(async () => {
      await result.current.open('pl-cancel', 'netease')
    })
    let loading: Promise<unknown> = Promise.resolve([])
    act(() => {
      loading = result.current.loadAll()
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    act(() => result.current.cancelAll())
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(result.current.loadingAll).toBe(false)
  })
})
