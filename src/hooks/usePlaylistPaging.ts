import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Song } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { PLATFORM_CHANGED_EVENT } from '../services/platformSync'

export const PLAYLIST_SESSION_RESET_EVENT = 'hyperplayer-playlist-session-reset'
import {
  getPlaylistTrackPage,
  type PlaylistTrackPage,
} from '../services/playlistService'

export interface PlaylistPagingSnapshot {
  songs: Song[]
  playlist: any
  nextOffset: number
  hasMore: boolean
  total: number
  scrollTop?: number
}

export interface PlaylistPagingControls {
  hasMore: boolean
  loadingMore: boolean
  loadingAll: boolean
  moreError: string
  allError: string
  allProgress: { loaded: number; total: number }
  scrollTop: number
  setScrollTop: (scrollTop: number) => void
  loadMore: () => Promise<Song[]>
  retryMore: () => Promise<Song[]>
  locateSong: (song: Song) => Promise<Song[]>
  cancelAll: () => void
}

interface PlaylistPagingSession {
  playlistId: string
  platform: MusicPlatform
  nextOffset: number
  pageSize: number
  hasMore: boolean
  total: number
  forceRefresh: boolean
  generation: number
}

function songIdentity(song: Song): string {
  return `${song.platform || 'unknown'}:${song.mid || song.id || song.name}`
}

function appendUniqueSongs(current: Song[], incoming: Song[]): Song[] {
  const seen = new Set(current.map(songIdentity))
  const next = [...current]
  for (const song of incoming) {
    const key = songIdentity(song)
    if (!key || seen.has(key)) continue
    seen.add(key)
    next.push(song)
  }
  return next
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function usePlaylistPaging(pageSize = 50) {
  const [songs, setSongs] = useState<Song[]>([])
  const [playlist, setPlaylist] = useState<any>(null)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState(0)
  const [loadingInitial, setLoadingInitial] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  const [initialError, setInitialError] = useState('')
  const [moreError, setMoreError] = useState('')
  const [allError, setAllError] = useState('')
  const [allProgress, setAllProgress] = useState({ loaded: 0, total: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const scrollTopRef = useRef(0)
  const scrollTopFrameRef = useRef<number | null>(null)
  const songsRef = useRef<Song[]>([])
  const requestRef = useRef<AbortController | null>(null)
  const sessionRef = useRef<PlaylistPagingSession>({
    playlistId: '',
    platform: 'netease',
    nextOffset: 0,
    pageSize: 50,
    hasMore: false,
    total: 0,
    forceRefresh: false,
    generation: 0,
  })
  const lastOpenRef = useRef<{
    playlistId: string | number
    platform: MusicPlatform
    forceRefresh?: boolean
  } | null>(null)

  const commitSongs = useCallback((next: Song[]) => {
    songsRef.current = next
    setSongs(next)
  }, [])

  const abortRequest = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = null
    sessionRef.current.generation += 1
  }, [])

  const commitScrollTop = useCallback((value: number) => {
    scrollTopRef.current = Math.max(0, value)
    if (scrollTopFrameRef.current !== null) return
    scrollTopFrameRef.current = window.requestAnimationFrame(() => {
      scrollTopFrameRef.current = null
      setScrollTop(scrollTopRef.current)
    })
  }, [])

  const reset = useCallback(() => {
    abortRequest()
    lastOpenRef.current = null
    sessionRef.current = {
      ...sessionRef.current,
      playlistId: '',
      nextOffset: 0,
      pageSize,
      hasMore: false,
      total: 0,
    }
    commitSongs([])
    setPlaylist(null)
    setHasMore(false)
    setTotal(0)
    setNextOffset(0)
    setLoadingInitial(false)
    setLoadingMore(false)
    setLoadingAll(false)
    setInitialError('')
    setMoreError('')
    setAllError('')
    setAllProgress({ loaded: 0, total: 0 })
    scrollTopRef.current = 0
    setScrollTop(0)
    if (scrollTopFrameRef.current !== null) window.cancelAnimationFrame(scrollTopFrameRef.current)
    scrollTopFrameRef.current = null
  }, [abortRequest, commitSongs, pageSize])

  const applyPage = useCallback((page: PlaylistTrackPage, replace: boolean) => {
    const nextSongs = replace ? appendUniqueSongs([], page.songs) : appendUniqueSongs(songsRef.current, page.songs)
    commitSongs(nextSongs)
    setPlaylist((current: any) => ({ ...(current || {}), ...(page.playlist || {}) }))
    setNextOffset(page.nextOffset)
    setHasMore(page.more)
    setTotal(page.total || page.playlist?.trackCount || nextSongs.length)
    const session = sessionRef.current
    session.nextOffset = page.nextOffset
    session.pageSize = page.limit || session.pageSize
    session.hasMore = page.more
    session.total = page.total || page.playlist?.trackCount || nextSongs.length
    return nextSongs
  }, [commitSongs])

  const open = useCallback(async (
    playlistId: string | number,
    platform: MusicPlatform,
    options: { forceRefresh?: boolean } = {},
  ): Promise<Song[]> => {
    abortRequest()
    lastOpenRef.current = { playlistId, platform, forceRefresh: options.forceRefresh }
    const openController = new AbortController()
    requestRef.current = openController
    const generation = sessionRef.current.generation
    sessionRef.current = {
      playlistId: String(playlistId),
      platform,
      nextOffset: 0,
      pageSize,
      hasMore: false,
      total: 0,
      forceRefresh: Boolean(options.forceRefresh),
      generation,
    }
    commitSongs([])
    setPlaylist(null)
    setHasMore(false)
    setTotal(0)
    setNextOffset(0)
    setInitialError('')
    setMoreError('')
    setAllError('')
    setAllProgress({ loaded: 0, total: 0 })
    scrollTopRef.current = 0
    setScrollTop(0)
    setLoadingInitial(true)
    try {
      const page = await getPlaylistTrackPage(playlistId, platform, 0, pageSize, {
        signal: openController.signal,
        forceRefresh: options.forceRefresh,
      })
      if (sessionRef.current.generation !== generation || openController.signal.aborted) {
        return songsRef.current
      }
      return applyPage(page, true)
    } catch (error) {
      if (!isAbortError(error) && sessionRef.current.generation === generation) {
        setInitialError(error instanceof Error ? error.message : '歌单加载失败，请重试')
      }
      return songsRef.current
    } finally {
      if (requestRef.current === openController) requestRef.current = null
      if (sessionRef.current.generation === generation) setLoadingInitial(false)
    }
  }, [abortRequest, applyPage, commitSongs, pageSize])

  const loadMore = useCallback(async (forceRefresh = false): Promise<Song[]> => {
    const session = sessionRef.current
    if (!session.playlistId || !session.hasMore || requestRef.current || session.nextOffset <= 0) {
      return songsRef.current
    }
    const controller = new AbortController()
    requestRef.current = controller
    const generation = session.generation
    setLoadingMore(true)
    setMoreError('')
    try {
      let offset = session.nextOffset
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const page = await getPlaylistTrackPage(session.playlistId, session.platform, offset, pageSize, {
          signal: controller.signal,
          forceRefresh: forceRefresh || session.forceRefresh,
        })
        if (sessionRef.current.generation !== generation || controller.signal.aborted) {
          return songsRef.current
        }
        const previousLength = songsRef.current.length
        applyPage(page, false)
        if (!page.more || page.nextOffset <= offset) break
        offset = page.nextOffset
        // 空页或整页重复时继续向前推进；有有效新行则留给下一屏再加载。
        if (songsRef.current.length > previousLength) break
      }
      return songsRef.current
    } catch (error) {
      if (!isAbortError(error) && sessionRef.current.generation === generation) {
        setMoreError(error instanceof Error ? error.message : '加载更多失败，请重试')
      }
      return songsRef.current
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (sessionRef.current.generation === generation) setLoadingMore(false)
    }
  }, [applyPage, pageSize])

  const loadAll = useCallback(async (): Promise<Song[]> => {
    const session = sessionRef.current
    if (!session.playlistId || !session.hasMore) return songsRef.current
    abortRequest()
    const controller = new AbortController()
    requestRef.current = controller
    const generation = sessionRef.current.generation
    session.hasMore = true
    setLoadingAll(true)
    setAllError('')
    setMoreError('')
    setAllProgress({ loaded: songsRef.current.length, total: session.total })

    let offset = songsRef.current.length > 0 ? session.nextOffset : 0
    let pageCount = 0
    try {
      while (!controller.signal.aborted) {
        const step = Math.max(1, session.pageSize || pageSize)
        const secondOffset = offset + step
        const offsets = [offset]
        if (session.total > secondOffset) offsets.push(secondOffset)
        const pages = await Promise.all(offsets.map(pageOffset => getPlaylistTrackPage(
          session.playlistId,
          session.platform,
          pageOffset,
          pageSize,
          {
            signal: controller.signal,
            forceRefresh: session.forceRefresh,
          }
        )))
        if (sessionRef.current.generation !== generation || controller.signal.aborted) break
        const firstPage = pages[0]
        let nextSongs = applyPage(firstPage, false)
        let nextOffset = firstPage.nextOffset
        // 只接受与上一页结束位置无缝衔接的第二页；上游页大小变化时丢弃预取页并回到串行安全路径。
        if (pages[1]?.offset === nextOffset) {
          nextSongs = applyPage(pages[1], false)
          nextOffset = pages[1].nextOffset
        }
        setAllProgress({ loaded: nextSongs.length, total: session.total })
        pageCount += pages[1]?.offset === firstPage.nextOffset ? 2 : 1
        if (!sessionRef.current.hasMore || nextOffset <= offset) break
        offset = nextOffset
        if (pageCount > Math.ceil((session.total || nextSongs.length) / Math.max(1, session.pageSize)) + 4) break
      }
      if (controller.signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      if (sessionRef.current.hasMore) {
        throw new Error('歌单完整加载异常：上游页码未继续前进，请重试')
      }
      return songsRef.current
    } catch (error) {
      if (isAbortError(error)) throw error
      if (sessionRef.current.generation === generation) {
        setAllError(error instanceof Error ? error.message : '准备完整歌单失败，请重试')
      }
      throw error
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (sessionRef.current.generation === generation) setLoadingAll(false)
    }
  }, [abortRequest, applyPage, commitSongs, pageSize])

  const cancelAll = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = null
    sessionRef.current.generation += 1
    setLoadingInitial(false)
    setLoadingMore(false)
    setLoadingAll(false)
    setMoreError('')
    setAllError('')
  }, [])

  const retryInitial = useCallback(() => {
    const last = lastOpenRef.current
    if (!last) return Promise.resolve<Song[]>([])
    return open(last.playlistId, last.platform, { forceRefresh: true })
  }, [open])

  const removeSong = useCallback((target: Song) => {
    const targetKey = songIdentity(target)
    commitSongs(songsRef.current.filter(song => songIdentity(song) !== targetKey))
  }, [commitSongs])

  const retryMore = useCallback(() => loadMore(true), [loadMore])

  const locateSong = useCallback(async (target: Song): Promise<Song[]> => {
    const targetKey = songIdentity(target)
    if (songsRef.current.some(song => songIdentity(song) === targetKey)) return songsRef.current
    return loadAll()
  }, [loadAll])

  const restore = useCallback((snapshot: PlaylistPagingSnapshot) => {
    abortRequest()
    lastOpenRef.current = snapshot.playlist?.id
      ? { playlistId: snapshot.playlist.id, platform: snapshot.playlist.platform || 'netease' }
      : null
    sessionRef.current = {
      playlistId: String(snapshot.playlist?.id || ''),
      platform: snapshot.playlist?.platform || 'netease',
      nextOffset: snapshot.nextOffset,
      pageSize,
      hasMore: snapshot.hasMore,
      total: snapshot.total,
      forceRefresh: false,
      generation: sessionRef.current.generation,
    }
    commitSongs(appendUniqueSongs([], snapshot.songs))
    setPlaylist(snapshot.playlist)
    setNextOffset(snapshot.nextOffset)
    setHasMore(snapshot.hasMore)
    setTotal(snapshot.total)
    setInitialError('')
    setMoreError('')
    setAllError('')
    setAllProgress({ loaded: snapshot.songs.length, total: snapshot.total })
    setLoadingInitial(false)
    setLoadingMore(false)
    setLoadingAll(false)
    scrollTopRef.current = snapshot.scrollTop || 0
    setScrollTop(snapshot.scrollTop || 0)
  }, [abortRequest, commitSongs, pageSize])

  useEffect(() => {
    const invalidateAccount = () => {
      const hadPlaylist = Boolean(sessionRef.current.playlistId)
      reset()
      if (hadPlaylist) window.dispatchEvent(new Event(PLAYLIST_SESSION_RESET_EVENT))
    }
    const invalidatePlatform = (event: Event) => {
      const nextPlatform = (event as CustomEvent<MusicPlatform>).detail
      if (sessionRef.current.playlistId && nextPlatform !== sessionRef.current.platform) {
        reset()
        window.dispatchEvent(new Event(PLAYLIST_SESSION_RESET_EVENT))
      }
    }
    const invalidatePlaylist = (event: Event) => {
      const detail = (event as CustomEvent<{
        platform?: MusicPlatform
        type?: string
        playlistId?: string | number
      }>).detail
      const session = sessionRef.current
      if (!session.playlistId || (detail?.platform && detail.platform !== session.platform)) return
      if (detail?.playlistId != null && String(detail.playlistId) !== session.playlistId) return
      if (detail?.type === 'playlist-delete') {
        reset()
        window.dispatchEvent(new Event(PLAYLIST_SESSION_RESET_EVENT))
        return
      }
      if (detail?.type === 'playlist-tracks') {
        session.forceRefresh = true
      }
    }
    window.addEventListener('hyperplayer-auth-changed', invalidateAccount)
    window.addEventListener(PLATFORM_CHANGED_EVENT, invalidatePlatform)
    window.addEventListener('playlist-content-changed', invalidatePlaylist)
    return () => {
      window.removeEventListener('hyperplayer-auth-changed', invalidateAccount)
      window.removeEventListener(PLATFORM_CHANGED_EVENT, invalidatePlatform)
      window.removeEventListener('playlist-content-changed', invalidatePlaylist)
      abortRequest()
      if (scrollTopFrameRef.current !== null) window.cancelAnimationFrame(scrollTopFrameRef.current)
      scrollTopFrameRef.current = null
    }
  }, [abortRequest, reset])

  const snapshot = useMemo<PlaylistPagingSnapshot>(() => ({
    songs,
    playlist,
    nextOffset,
    hasMore,
    total,
    scrollTop,
  }), [hasMore, nextOffset, playlist, scrollTop, songs, total])

  return {
    songs,
    playlist,
    hasMore,
    total,
    loadingInitial,
    loadingMore,
    loadingAll,
    initialError,
    moreError,
    allError,
    allProgress,
    scrollTop,
    setScrollTop: commitScrollTop,
    open,
    loadMore,
    retryMore,
    locateSong,
    loadAll,
    retryInitial,
    cancelAll,
    reset,
    restore,
    removeSong,
    snapshot,
  }
}
