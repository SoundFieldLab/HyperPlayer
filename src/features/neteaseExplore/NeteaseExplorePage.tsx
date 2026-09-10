import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Disc3, HeartPulse, Loader2, LogIn, Mic2, Radio, RefreshCw, Sparkles, Trophy, UserRoundSearch, Waves, X } from 'lucide-react'
import { HorizontalShelf } from '../../components/apple-explore/HorizontalShelf'
import CachedImage from '../../components/CachedImage'
import type { Song } from '../../services/musicApi'
import { getUserDetail } from '../../services/musicApi'
import type { ExploreChannel, ExplorePayload, ExplorePlaylist } from '../../services/exploreApi'
import { applyFavoriteMutation, getFavoriteSongIdentifiers, invalidateFavoriteIdentifiers, loadFavoriteIdentifiers } from '../../services/favoriteStatusService'
import {
  fetchNeteaseDailyPodcast,
  fetchNeteaseDailySongs,
  fetchNeteaseHeartMode,
  fetchNeteaseNativeHome,
  fetchNeteasePodcastHome,
  fetchNeteaseProgramSong,
  fetchNeteaseRedCounts,
  fetchNeteaseRoam,
  fetchNeteaseSimilarContext,
  fetchNeteaseUnlimitedFlow,
} from './api'
import {
  normalizeNeteaseDailyPodcast,
  normalizeNeteaseResource,
  type NeteaseNativeBlock,
  type NeteaseNativeFlow,
  type NeteaseNativeHome,
  type NeteaseNativeResource,
} from './model'
import NeteaseDailyRecommendPanel from './NeteaseDailyRecommendPanel'
import { NeteaseFlowGrid, NeteaseNativeBlockView, SongRestrictionBadges } from './NeteaseResourceView'
import type { EntitlementTier } from '../../utils/musicEntitlements'

// src/features/neteaseExplore/NeteaseExplorePage.tsx

interface NeteaseExplorePageProps {
  loggedIn: boolean
  username: string
  userId?: string
  entitlement: EntitlementTier
  authRevision: number
  accent: string
  showDescription: boolean
  currentSong?: Song | null
  publicContent?: ExplorePayload | null
  accountPlaylists: any[]
  onRequestFallback: () => void
  onLogin: () => void
  onPlaySongs: (song: Song, songs: Song[], continuous?: boolean) => void
  onOpenPlaylist: (playlist: ExplorePlaylist, autoplay?: boolean) => void
  onOpenChannel: (channel: ExploreChannel, autoplay?: boolean) => void
  onOpenAlbum?: (albumId: string) => void
  onOpenArtist?: (artistId: string) => void
  onOpenMV: (mvId: string) => void
  onViewComments?: (song: Song) => void
  onSongContextMenu: (event: React.MouseEvent, song: Song, songs: Song[], continuous?: boolean) => void
  onPlaylistContextMenu: (event: React.MouseEvent, playlist: ExplorePlaylist) => void
  onAddToFavorites?: (song: Song) => void | Promise<boolean>
  onRemoveFromFavorites?: (song: Song) => void | Promise<boolean>
}

interface SimilarPanelState {
  loading: boolean
  error: string
  songs: Song[]
  playlists: ExplorePlaylist[]
  users: Array<{ id: string; name: string; avatarUrl: string; signature: string }>
}

const EMPTY_SIMILAR: SimilarPanelState = { loading: false, error: '', songs: [], playlists: [], users: [] }

const ENTRY_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--explore-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d1118]'

function NeteaseExploreSkeleton() {
  return <div className="animate-pulse space-y-10" aria-label="正在加载网易云推荐"><div className="flex gap-4 overflow-hidden">{Array.from({ length: 5 }).map((_, index) => <div key={index} className="aspect-[1.2/1] w-52 shrink-0 rounded-md bg-white/[0.055]" />)}</div><div className="grid gap-x-6 md:grid-cols-2 2xl:grid-cols-3">{Array.from({ length: 9 }).map((_, index) => <div key={index} className="flex items-center gap-3 border-b border-white/[0.05] py-3"><div className="h-14 w-14 rounded-md bg-white/[0.06]" /><div className="flex-1 space-y-2"><div className="h-3 w-3/5 rounded bg-white/[0.07]" /><div className="h-2 w-2/5 rounded bg-white/[0.045]" /></div></div>)}</div></div>
}

function normalizeSong(value: any): Song | null {
  const resource = normalizeNeteaseResource({ resourceId: value?.id, resourceType: 'song', songData: value }, 0)
  return resource?.song || null
}

function normalizeSimilarPayload(payload: any): Omit<SimilarPanelState, 'loading' | 'error'> {
  const rawSongs = payload?.songs?.songs || payload?.songs?.data?.songs || []
  const rawPlaylists = payload?.playlists?.playlists || payload?.playlists?.data?.playlists || []
  const rawUsers = payload?.users?.userprofiles || payload?.users?.data?.userprofiles || []
  return {
    songs: (Array.isArray(rawSongs) ? rawSongs : []).map(normalizeSong).filter((song): song is Song => Boolean(song)),
    playlists: (Array.isArray(rawPlaylists) ? rawPlaylists : []).map((item: any) => ({ id: String(item.id || ''), name: String(item.name || '相关歌单'), coverUrl: String(item.coverImgUrl || item.picUrl || '').replace(/^http:/, 'https:'), description: String(item.description || item.copywriter || ''), playCount: Number(item.playCount || 0) || undefined, trackCount: Number(item.trackCount || 0) || undefined, platform: 'netease' as const, source: 'netease-native-similar' })).filter((item: ExplorePlaylist) => item.id),
    users: (Array.isArray(rawUsers) ? rawUsers : []).map((item: any) => ({ id: String(item.userId || item.id || ''), name: String(item.nickname || item.name || '网易云用户'), avatarUrl: String(item.avatarUrl || '').replace(/^http:/, 'https:'), signature: String(item.signature || '') })).filter((item: { id: string }) => item.id),
  }
}

export default function NeteaseExplorePage({
  loggedIn,
  username,
  userId,
  entitlement,
  authRevision,
  accent,
  showDescription,
  currentSong,
  publicContent,
  accountPlaylists,
  onRequestFallback,
  onLogin,
  onPlaySongs,
  onOpenPlaylist,
  onOpenChannel,
  onOpenAlbum,
  onOpenArtist,
  onOpenMV,
  onViewComments,
  onSongContextMenu,
  onPlaylistContextMenu,
  onAddToFavorites,
  onRemoveFromFavorites,
}: NeteaseExplorePageProps) {
  const [home, setHome] = useState<NeteaseNativeHome | null>(null)
  const [podcast, setPodcast] = useState<NeteaseNativeHome | null>(null)
  const [flow, setFlow] = useState<NeteaseNativeFlow | null>(null)
  const [homeError, setHomeError] = useState('')
  const [podcastError, setPodcastError] = useState('')
  const [flowError, setFlowError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMoreHome, setLoadingMoreHome] = useState(false)
  const [flowLoading, setFlowLoading] = useState(false)
  const [entryLoading, setEntryLoading] = useState('')
  const [dailySongs, setDailySongs] = useState<Song[] | null>(null)
  const [similar, setSimilar] = useState<SimilarPanelState | null>(null)
  const [profile, setProfile] = useState<any | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())
  const [favoritesReady, setFavoritesReady] = useState(false)
  const [favoriteRefreshRevision, setFavoriteRefreshRevision] = useState(0)
  const [favoriteOverrides, setFavoriteOverrides] = useState<Map<string, boolean>>(new Map())
  const [favoritePending, setFavoritePending] = useState<Set<string>>(new Set())
  const [redCounts, setRedCounts] = useState<Map<string, number>>(new Map())
  const [visibleSongIds, setVisibleSongIds] = useState<Set<string>>(new Set())
  const favoriteOwnerRef = useRef('')
  const favoritePendingRef = useRef(new Set<string>())
  const redCountRequestedRef = useRef(new Set<string>())
  const requestRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const podcastSectionRef = useRef<HTMLElement | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const exposedResourcesRef = useRef(new Set<string>())
  const homeRef = useRef<NeteaseNativeHome | null>(null)
  homeRef.current = home
  const fallbackRef = useRef({ publicContent, onRequestFallback })
  fallbackRef.current = { publicContent, onRequestFallback }
  const accountKey = `${loggedIn ? 'user' : 'guest'}:${userId || ''}:${authRevision}`
  const verifiedAccount = loggedIn && Boolean(userId) && home?.accountScoped === true

  const load = useCallback(async (refresh = false) => {
    const requestId = ++requestRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (refresh) setRefreshing(true); else setLoading(true)
    setHomeError('')
    setPodcastError('')
    setFlowError('')
    if (refresh) {
      setHome(null)
      setPodcast(null)
      setFlow(null)
    }
    const [homeResult, podcastResult, flowResult] = await Promise.allSettled([
      fetchNeteaseNativeHome(refresh, controller.signal, refresh && homeRef.current ? {
        blockCodeOrderList: homeRef.current.blockCodeOrderList,
        exposedResource: JSON.stringify([...exposedResourcesRef.current]),
      } : undefined),
      fetchNeteasePodcastHome(controller.signal),
      fetchNeteaseUnlimitedFlow(controller.signal),
    ])
    if (requestId !== requestRef.current || controller.signal.aborted) return
    if (homeResult.status === 'fulfilled') setHome(homeResult.value)
    else {
      setHomeError(homeResult.reason instanceof Error ? homeResult.reason.message : '首页推荐加载失败')
      if (!fallbackRef.current.publicContent) fallbackRef.current.onRequestFallback()
    }
    if (podcastResult.status === 'fulfilled') setPodcast(podcastResult.value)
    else setPodcastError(podcastResult.reason instanceof Error ? podcastResult.reason.message : '播客推荐加载失败')
    if (flowResult.status === 'fulfilled') setFlow(flowResult.value)
    else setFlowError(flowResult.reason instanceof Error ? flowResult.reason.message : '继续探索加载失败')
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    setHome(null)
    setPodcast(null)
    setFlow(null)
    setDailySongs(null)
    setSimilar(null)
    void load(false)
    return () => controllerRef.current?.abort()
  }, [accountKey, load])

  useEffect(() => {
    const owner = verifiedAccount && userId ? `netease:${userId}` : ''
    favoriteOwnerRef.current = owner
    setFavoriteIds(new Set())
    setFavoriteOverrides(new Map())
    setFavoritePending(new Set())
    favoritePendingRef.current.clear()
    setFavoritesReady(false)
    if (!owner || !userId) return
    let cancelled = false
    void loadFavoriteIdentifiers('netease', userId).then(ids => {
      if (!cancelled && favoriteOwnerRef.current === owner) {
        setFavoriteIds(new Set(ids))
        setFavoritesReady(true)
      }
    }).catch(() => {
      if (!cancelled && favoriteOwnerRef.current === owner) setFavoritesReady(true)
    })
    const handleFavoriteChange = (event: Event) => {
      const detail = (event as CustomEvent<{ platform?: 'netease'; type?: string; songId?: string | number }>).detail
      if (detail?.platform !== 'netease' || (detail.type !== 'like' && detail.type !== 'unlike')) return
      applyFavoriteMutation(detail)
      const id = String(detail.songId || '')
      if (!id) return
      setFavoriteIds(previous => {
        const next = new Set(previous)
        if (detail.type === 'like') next.add(id); else next.delete(id)
        return next
      })
      setFavoriteOverrides(previous => new Map(previous).set(id, detail.type === 'like'))
    }
    window.addEventListener('playlist-content-changed', handleFavoriteChange)
    return () => {
      cancelled = true
      window.removeEventListener('playlist-content-changed', handleFavoriteChange)
    }
  }, [favoriteRefreshRevision, userId, verifiedAccount])

  useEffect(() => {
    const missing = [...visibleSongIds].filter(id => !redCountRequestedRef.current.has(id))
    if (missing.length === 0) return
    const controller = new AbortController()
    missing.forEach(id => redCountRequestedRef.current.add(id))
    const chunks: string[][] = []
    for (let index = 0; index < missing.length; index += 40) chunks.push(missing.slice(index, index + 40))
    void Promise.all(chunks.map(chunk => fetchNeteaseRedCounts(chunk, controller.signal))).then(results => {
      if (controller.signal.aborted) return
      setRedCounts(previous => {
        const next = new Map(previous)
        results.forEach(counts => Object.entries(counts).forEach(([id, count]) => next.set(id, count)))
        return next
      })
    }).catch(() => undefined)
    return () => controller.abort()
  }, [visibleSongIds])

  useEffect(() => {
    const root = pageRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const element = entry.target as HTMLElement
          const resourceId = element.dataset.resourceId
          if (resourceId) exposedResourcesRef.current.add(resourceId)
          const songId = element.dataset.songId
          if (songId) setVisibleSongIds(previous => previous.has(songId) ? previous : new Set(previous).add(songId))
        }
      }
    }, { root: root.closest('.explore-scrollbar'), threshold: 0.45 })
    root.querySelectorAll<HTMLElement>('[data-resource-id]').forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [home, flow, podcast])

  const normalizedAccountPlaylists = useMemo(() => (accountPlaylists || []).map((playlist: any) => ({
    id: String(playlist.id || ''),
    name: String(playlist.name || ''),
    coverUrl: String(playlist.coverImgUrl || playlist.coverUrl || ''),
    trackCount: Number(playlist.trackCount || 0),
    platform: 'netease' as const,
    source: playlist.isLike ? 'netease-liked' : 'netease-account',
  })).filter((playlist: ExplorePlaylist) => playlist.id), [accountPlaylists])
  const likedPlaylist = normalizedAccountPlaylists.find(playlist => playlist.source === 'netease-liked' || /我喜欢/.test(playlist.name)) || null
  const radarPlaylist = home?.blocks.flatMap(block => block.resources).find(resource => resource.playlist && /雷达/.test(`${resource.title}${resource.subtitle}${resource.actionUrl}`))?.playlist
    || normalizedAccountPlaylists.find(playlist => /雷达/.test(playlist.name)) || null
  const neteaseCurrentSong = currentSong && (currentSong.platform || 'netease') === 'netease' ? currentSong : null
  const dragonBlock = home?.blocks.find(block => block.showType === 'DRAGON_BALL')
  const coreEntryPattern = /每日推荐|心动|漫游|雷达|相似歌曲|相似用户|相似艺人|每日播客/
  const extraDragonBlock = dragonBlock ? { ...dragonBlock, resources: dragonBlock.resources.filter(resource => !coreEntryPattern.test(resource.title)) } : null
  const contentBlocks = (home?.blocks || []).filter(block => block !== dragonBlock)

  const runEntry = useCallback(async (name: string, task: () => Promise<void>) => {
    if (entryLoading) return
    setEntryLoading(name)
    setHomeError('')
    try { await task() } catch (error) { setHomeError(error instanceof Error ? error.message : `${name}加载失败`) } finally { setEntryLoading('') }
  }, [entryLoading])

  const requireLogin = () => {
    if (verifiedAccount) return true
    onLogin()
    return false
  }

  const openSimilar = async () => {
    if (!neteaseCurrentSong) throw new Error('请先播放一首网易云歌曲')
    setSimilar({ ...EMPTY_SIMILAR, loading: true })
    try {
      const result = normalizeSimilarPayload(await fetchNeteaseSimilarContext(neteaseCurrentSong.id))
      setSimilar({ ...result, loading: false, error: '' })
    } catch (error) {
      setSimilar({ ...EMPTY_SIMILAR, error: error instanceof Error ? error.message : '相似推荐加载失败' })
    }
  }

  const openUser = async (id: string) => {
    setProfileLoading(true)
    try {
      const result = await getUserDetail(id)
      if (!result?.profile) throw new Error('用户资料加载失败')
      setProfile(result)
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : '用户资料加载失败')
    } finally { setProfileLoading(false) }
  }

  const executeResource = useCallback(async (resource: NeteaseNativeResource, queue: NeteaseNativeResource[]) => {
    const action = resource.action
    const queueSongs = queue.map(item => item.song).filter((song): song is Song => Boolean(song))
    switch (action.type) {
      case 'song': onPlaySongs(action.song, queueSongs.length ? queueSongs : [action.song]); return
      case 'comments': onViewComments?.(action.song); return
      case 'playlist': onOpenPlaylist(action.playlist, action.autoplay); return
      case 'album': onOpenAlbum?.(action.id); return
      case 'radio': onOpenChannel(action.channel); return
      case 'program': {
        const song = await fetchNeteaseProgramSong(action.id)
        if (!song) throw new Error('节目暂时无法播放')
        onPlaySongs(song, [song])
        return
      }
      case 'artist': onOpenArtist?.(action.id); return
      case 'user': await openUser(action.id); return
      case 'mv': onOpenMV(action.id); return
      case 'web': {
        const bridge = (window as any).electron
        if (bridge?.openExternal) await bridge.openExternal(action.url)
        else window.open(action.url, '_blank', 'noopener,noreferrer')
        return
      }
      case 'podcast-section': podcastSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return
      case 'none': setHomeError(`${resource.title} 暂不支持在 WaveForge 内打开`)
    }
  }, [onOpenAlbum, onOpenArtist, onOpenChannel, onOpenMV, onOpenPlaylist, onPlaySongs, onViewComments])

  const isSongFavorite = useCallback((resource: NeteaseNativeResource) => {
    const song = resource.song
    if (!song) return false
    const key = String(song.id)
    if (favoriteOverrides.has(key)) return Boolean(favoriteOverrides.get(key))
    const authoritativeFavorite = getFavoriteSongIdentifiers(song).some(identifier => favoriteIds.has(identifier))
    return favoritesReady ? authoritativeFavorite : Boolean(resource.isFavorite || authoritativeFavorite)
  }, [favoriteIds, favoriteOverrides, favoritesReady])

  const toggleFavorite = useCallback(async (event: React.MouseEvent, resource: NeteaseNativeResource) => {
    event.preventDefault()
    event.stopPropagation()
    const song = resource.song
    if (!song || !verifiedAccount || !favoritesReady) {
      if (!verifiedAccount) onLogin()
      return
    }
    const key = String(song.id)
    if (favoritePendingRef.current.has(key)) return
    const current = isSongFavorite(resource)
    const previousOverride = favoriteOverrides.get(key)
    favoritePendingRef.current.add(key)
    setFavoritePending(previous => new Set(previous).add(key))
    setFavoriteOverrides(previous => new Map(previous).set(key, !current))
    setRedCounts(previous => {
      const baseline = previous.get(key) ?? resource.favoriteCount
      if (baseline === undefined) return previous
      return new Map(previous).set(key, Math.max(0, baseline + (current ? -1 : 1)))
    })
    try {
      const result = current ? await onRemoveFromFavorites?.(song) : await onAddToFavorites?.(song)
      if (result === false || (current ? !onRemoveFromFavorites : !onAddToFavorites)) throw new Error(current ? '取消喜欢失败' : '添加到喜欢失败')
      setFavoriteIds(previous => {
        const next = new Set(previous)
        getFavoriteSongIdentifiers(song).forEach(identifier => { if (current) next.delete(identifier); else next.add(identifier) })
        return next
      })
    } catch (error) {
      setFavoriteOverrides(previous => {
        const next = new Map(previous)
        if (previousOverride === undefined) next.delete(key); else next.set(key, previousOverride)
        return next
      })
      setRedCounts(previous => {
        const value = previous.get(key)
        if (value === undefined) return previous
        return new Map(previous).set(key, Math.max(0, value + (current ? 1 : -1)))
      })
      setHomeError(error instanceof Error ? error.message : '收藏状态更新失败')
    } finally {
      favoritePendingRef.current.delete(key)
      setFavoritePending(previous => { const next = new Set(previous); next.delete(key); return next })
    }
  }, [favoriteOverrides, favoritesReady, isSongFavorite, onAddToFavorites, onLogin, onRemoveFromFavorites, verifiedAccount])

  const callbacks = useMemo(() => ({
    onExecute: (resource: NeteaseNativeResource, queue: NeteaseNativeResource[]) => { void executeResource(resource, queue).catch(error => setHomeError(error instanceof Error ? error.message : '内容打开失败')) },
    onSongContextMenu,
    onPlaylistContextMenu,
    isSongFavorite,
    isFavoritePending: (song: Song) => favoritePending.has(String(song.id)),
    onToggleFavorite: (event: React.MouseEvent, resource: NeteaseNativeResource) => { void toggleFavorite(event, resource) },
    favoriteCount: (resource: NeteaseNativeResource) => resource.song ? redCounts.get(String(resource.song.id)) ?? resource.favoriteCount : resource.favoriteCount,
    entitlement,
  }), [entitlement, executeResource, favoritePending, isSongFavorite, onPlaylistContextMenu, onSongContextMenu, redCounts, toggleFavorite])

  const loadMoreHome = async () => {
    if (!home?.hasMore || !home.cursor || loadingMoreHome) return
    setLoadingMoreHome(true)
    try {
      const next = await fetchNeteaseNativeHome(false, undefined, {
        ...home,
        exposedResource: JSON.stringify([...exposedResourcesRef.current]),
      })
      const seen = new Set(home.blocks.map(block => `${block.blockCode}:${block.id}`))
      const additions = next.blocks.filter(block => !seen.has(`${block.blockCode}:${block.id}`))
      setHome({ ...next, blocks: [...home.blocks, ...additions], rawBlocks: [...home.rawBlocks, ...next.rawBlocks] })
    } catch (error) { setHomeError(error instanceof Error ? error.message : '更多推荐加载失败') } finally { setLoadingMoreHome(false) }
  }

  const loadMoreFlow = async () => {
    if (!flow?.hasMore || flowLoading) return
    setFlowLoading(true)
    try {
      const next = await fetchNeteaseUnlimitedFlow()
      const seen = new Set(flow.resources.map(item => `${item.type}:${item.id}`))
      const additions = next.resources.filter(item => !seen.has(`${item.type}:${item.id}`))
      setFlow({ hasMore: next.hasMore && additions.length > 0, resources: [...flow.resources, ...additions] })
    } catch (error) { setFlowError(error instanceof Error ? error.message : '乐流加载失败') } finally { setFlowLoading(false) }
  }

  const fallbackResources = useMemo(() => {
    const songs = (publicContent?.dailySongs || []).map((song, index) => normalizeNeteaseResource({ resourceId: song.id, resourceType: 'song', songData: song, uiElement: { mainTitle: { title: song.name }, subTitle: { title: song.artists.map(artist => artist.name).join(' / ') }, image: { imageUrl: song.album.picUrl } } }, index)).filter((item): item is NeteaseNativeResource => Boolean(item))
    const playlists = (publicContent?.playlists || []).map((playlist, index) => normalizeNeteaseResource({ resourceId: playlist.id, resourceType: 'list', action: `orpheus://playlist/${playlist.id}`, uiElement: { mainTitle: { title: playlist.name }, subTitle: { title: playlist.description || '' }, image: { imageUrl: playlist.coverUrl } } }, index)).filter((item): item is NeteaseNativeResource => Boolean(item))
    return { songs, playlists }
  }, [publicContent])

  const shortcutResource = (title: string) => dragonBlock?.resources.find(resource => {
    const semanticTitle = `${resource.title}${resource.purePicName}${resource.subtitle}`
    if (title === '每日推荐') return /每日推荐|日推/.test(semanticTitle)
    if (title === '心动模式') return /心动/.test(semanticTitle)
    if (title === '漫游') return /漫游|私人漫游/.test(semanticTitle)
    if (title === '雷达歌单') return /雷达/.test(semanticTitle)
    if (title === '相似推荐') return /相似歌曲|相似推荐/.test(semanticTitle)
    if (title === '相似用户') return /相似用户|相似艺人/.test(semanticTitle)
    return /每日播客|播客/.test(semanticTitle)
  })

  const entryCards = [
    { title: '每日推荐', subtitle: '今日限定好歌推荐', icon: Sparkles, enabled: verifiedAccount, run: () => requireLogin() && void runEntry('每日推荐', async () => { const songs = await fetchNeteaseDailySongs(); if (!songs.length) throw new Error('今日暂无推荐'); setDailySongs(songs) }) },
    { title: '心动模式', subtitle: likedPlaylist && neteaseCurrentSong ? '红心歌曲和相似推荐' : '需要网易云歌曲和我喜欢歌单', icon: HeartPulse, enabled: verifiedAccount && Boolean(likedPlaylist && neteaseCurrentSong), run: () => requireLogin() && likedPlaylist && neteaseCurrentSong && void runEntry('心动模式', async () => { const songs = await fetchNeteaseHeartMode(neteaseCurrentSong.id, likedPlaylist.id); if (!songs.length) throw new Error('心动模式暂无歌曲'); onPlaySongs(songs[0], songs, true) }) },
    { title: '漫游', subtitle: '多样频道无限畅听', icon: Radio, enabled: verifiedAccount, run: () => requireLogin() && void runEntry('私人漫游', async () => { const songs = await fetchNeteaseRoam(); if (!songs.length) throw new Error('私人漫游暂无歌曲'); onPlaySongs(songs[0], songs, true) }) },
    { title: '雷达歌单', subtitle: radarPlaylist?.name || '等待账号雷达歌单', icon: Trophy, enabled: verifiedAccount && Boolean(radarPlaylist), run: () => requireLogin() && radarPlaylist && onOpenPlaylist(radarPlaylist) },
    { title: '相似推荐', subtitle: neteaseCurrentSong ? `从 ${neteaseCurrentSong.name} 开始` : '需要当前网易云歌曲', icon: Disc3, enabled: Boolean(neteaseCurrentSong), run: () => void openSimilar() },
    { title: '相似用户', subtitle: '与当前歌曲口味相近的人', icon: UserRoundSearch, enabled: Boolean(neteaseCurrentSong), run: () => void openSimilar() },
    { title: '每日播客', subtitle: '你的播客推荐', icon: Mic2, enabled: verifiedAccount, run: () => requireLogin() && void runEntry('每日播客', async () => { const channels = (await fetchNeteaseDailyPodcast()).map(normalizeNeteaseDailyPodcast).filter((item): item is ExploreChannel => Boolean(item)); if (!channels.length) throw new Error('每日播客暂无推荐'); onOpenChannel(channels[0]) }) },
  ]

  return (
    <div ref={pageRef} className="space-y-10 pb-48">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><div className="flex items-center gap-2 text-xs font-medium text-white/42"><Waves className="h-4 w-4" style={{ color: accent }} />网易云手机客户端推荐流</div><h2 className="mt-2 text-2xl font-semibold md:text-3xl">{username ? `${username}，` : ''}为你推荐</h2>{showDescription && <p className="mt-2 text-sm text-white/42">区块、顺序和资源由网易云移动端推荐服务实时下发。</p>}</div>
        <div className="flex items-center gap-2">{!verifiedAccount && <button type="button" onClick={onLogin} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-4 text-sm text-white/65"><LogIn className="h-4 w-4" />登录</button>}<button type="button" disabled={refreshing} onClick={() => {
          if (userId) {
            invalidateFavoriteIdentifiers('netease', userId)
            setFavoriteRefreshRevision(revision => revision + 1)
          }
          redCountRequestedRef.current.clear()
          setVisibleSongIds(new Set())
          void load(true)
        }} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.05] px-4 text-sm text-white/65 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />刷新推荐</button></div>
      </div>

      {homeError && <div role="alert" className="flex items-center gap-3 rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm"><AlertCircle className="h-4 w-4 text-rose-400" />{homeError}</div>}
      {!verifiedAccount && home && !home.accountScoped && <div className="rounded-md border border-amber-200/15 bg-amber-100/[0.05] px-4 py-3 text-sm text-amber-50/65">当前是网易云匿名推荐。登录后才会下发每日推荐、雷达歌单、关注艺人和账号口味模块。</div>}
      {loading && !home ? <NeteaseExploreSkeleton /> : (
        <>
          <section aria-label="网易云推荐快捷入口" aria-busy={Boolean(entryLoading)}>
            <HorizontalShelf ariaLabel="网易云推荐快捷入口" itemClassName="w-52">
              {entryCards.map(({ title, subtitle, icon: Icon, enabled, run }, index) => {
                const artwork = shortcutResource(title)
                const imageUrl = artwork?.purePictureUrl || artwork?.coverUrl
                const today = new Date().getDate()
                return (
                  <button
                    key={title}
                    type="button"
                    onClick={run}
                    disabled={!enabled || Boolean(entryLoading)}
                    title={!enabled ? subtitle : undefined}
                    className={`group relative aspect-[1.2/1] w-full overflow-hidden rounded-md border border-white/[0.08] bg-[#202630] text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${ENTRY_FOCUS}`}
                  >
                    {imageUrl ? <CachedImage src={imageUrl} alt="" lazy className="absolute inset-0 h-full w-full object-cover" fallback={<span className="absolute inset-0 bg-[linear-gradient(145deg,#303844,#171c25)]" />} /> : <span className="absolute inset-0 bg-[linear-gradient(145deg,#303844,#171c25)]" />}
                    <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.05),rgba(0,0,0,0.78))]" />
                    <span className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/35 backdrop-blur-md">
                      {entryLoading === title ? <Loader2 className="h-5 w-5 animate-spin" style={{ color: accent }} /> : title === '每日推荐' ? <span className="text-lg font-bold tabular-nums" style={{ color: accent }}>{today}</span> : <Icon className="h-5 w-5" style={{ color: index === 0 ? accent : undefined }} />}
                    </span>
                    <span className="absolute inset-x-4 bottom-4"><span className="block font-semibold text-white">{title}</span><span className="mt-1 block line-clamp-2 text-xs text-white/60">{subtitle}</span></span>
                  </button>
                )
              })}
            </HorizontalShelf>
          </section>
          {extraDragonBlock && extraDragonBlock.resources.length > 0 && <NeteaseNativeBlockView block={extraDragonBlock} callbacks={callbacks} />}
          <div className="space-y-12">{contentBlocks.map((block, index) => <NeteaseNativeBlockView key={`${block.id}-${index}`} block={block} callbacks={callbacks} />)}</div>
          {contentBlocks.length === 0 && (fallbackResources.songs.length > 0 || fallbackResources.playlists.length > 0) && <div className="space-y-12">{fallbackResources.songs.length > 0 && <NeteaseNativeBlockView block={{ id: 'fallback-songs', blockCode: 'FALLBACK_SONGS', showType: 'HOMEPAGE_SLIDE_SONGLIST_ALIGN', title: '今日推荐', subtitle: '', resources: fallbackResources.songs, raw: {} }} callbacks={callbacks} />}{fallbackResources.playlists.length > 0 && <NeteaseNativeBlockView block={{ id: 'fallback-playlists', blockCode: 'FALLBACK_PLAYLISTS', showType: 'HOMEPAGE_SLIDE_PLAYLIST', title: '推荐歌单', subtitle: '', resources: fallbackResources.playlists, raw: {} }} callbacks={callbacks} />}</div>}
          {home?.hasMore && home.cursor && <div className="flex justify-center"><button type="button" disabled={loadingMoreHome} onClick={() => void loadMoreHome()} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.09] px-5 text-sm text-white/60 disabled:opacity-50">{loadingMoreHome && <Loader2 className="h-4 w-4 animate-spin" />}加载更多推荐</button></div>}
        </>
      )}

      <section><div className="mb-4 flex items-center gap-2"><Sparkles className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">继续探索</h3></div>{flowError ? <div className="flex items-center justify-between rounded-md border border-white/[0.07] px-4 py-3 text-sm text-white/50"><span>{flowError}</span><button type="button" onClick={() => void load(false)}>重试</button></div> : flow?.resources.length ? <><NeteaseFlowGrid resources={flow.resources} callbacks={callbacks} />{flow.hasMore && <div className="mt-5 flex justify-center"><button type="button" disabled={flowLoading} onClick={() => void loadMoreFlow()} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.09] px-5 text-sm text-white/60 disabled:opacity-50">{flowLoading && <Loader2 className="h-4 w-4 animate-spin" />}加载更多乐流</button></div>}</> : <p className="text-sm text-white/38">暂无更多内容</p>}</section>

      <section ref={podcastSectionRef}>
        <div className="mb-5 flex items-center gap-2"><Mic2 className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">播客推荐</h3></div>
        {podcastError
          ? <div className="rounded-md border border-white/[0.07] px-4 py-3 text-sm text-white/50">{podcastError}</div>
          : podcast?.blocks.length
            ? <div className="space-y-10">{podcast.blocks.map((block, index) => <NeteaseNativeBlockView key={`${block.id}-${index}`} block={block} callbacks={callbacks} />)}</div>
            : <p className="text-sm text-white/38">暂无播客推荐</p>}
      </section>

      {dailySongs && <NeteaseDailyRecommendPanel initialSongs={dailySongs} entitlement={entitlement} onClose={() => setDailySongs(null)} onPlaySongs={(song, songs) => onPlaySongs(song, songs)} onSongContextMenu={(event, song, songs) => onSongContextMenu(event, song, songs)} />}

      {similar && <div className="fixed inset-0 z-[175] flex items-center justify-center bg-black/65 p-5 backdrop-blur-xl" onClick={() => setSimilar(null)}><div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-md border border-white/[0.1] bg-[#0d1118] text-white" onClick={event => event.stopPropagation()}><div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4"><div><h3 className="font-semibold">相似推荐</h3><p className="mt-1 text-xs text-white/38">基于当前歌曲，同时获取歌曲、歌单和用户</p></div><button type="button" onClick={() => setSimilar(null)} aria-label="关闭相似推荐"><X className="h-5 w-5" /></button></div><div className="overflow-y-auto p-5">{similar.loading ? <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : similar.error ? <p className="text-sm text-rose-200">{similar.error}</p> : <div className="space-y-8">{similar.songs.length > 0 && <section><h4 className="mb-3 font-medium">相似歌曲</h4><div className="grid gap-2 md:grid-cols-2">{similar.songs.map(song => <button key={song.id} type="button" onClick={() => onPlaySongs(song, similar.songs, true)} onContextMenu={event => onSongContextMenu(event, song, similar.songs, true)} className="flex items-center gap-3 rounded-md p-2 text-left hover:bg-white/[0.06]"><img src={song.album.picUrl} alt="" className="h-12 w-12 rounded-md object-cover" /><span className="min-w-0"><span className="block truncate text-sm">{song.name}</span><span className="block truncate text-xs text-white/38">{song.artists.map(artist => artist.name).join(' / ')}</span></span><SongRestrictionBadges song={song} entitlement={entitlement} /></button>)}</div></section>}{similar.playlists.length > 0 && <section><h4 className="mb-3 font-medium">相关歌单</h4><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{similar.playlists.map(item => <button key={item.id} type="button" onClick={() => onOpenPlaylist(item)} className="text-left"><img src={item.coverUrl} alt="" className="aspect-square w-full rounded-md object-cover" /><span className="mt-2 block line-clamp-2 text-sm">{item.name}</span></button>)}</div></section>}{similar.users.length > 0 && <section><h4 className="mb-3 font-medium">相似用户</h4><div className="grid gap-3 md:grid-cols-3">{similar.users.map(user => <button key={user.id} type="button" onClick={() => void openUser(user.id)} className="flex items-center gap-3 rounded-md border border-white/[0.07] p-3 text-left"><img src={user.avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" /><span className="min-w-0"><span className="block truncate text-sm">{user.name}</span><span className="block truncate text-xs text-white/38">{user.signature}</span></span></button>)}</div></section>}{similar.songs.length === 0 && similar.playlists.length === 0 && similar.users.length === 0 && <p className="py-16 text-center text-sm text-white/45">当前歌曲暂无相似推荐</p>}</div>}</div></div></div>}

      {(profile || profileLoading) && <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/65 p-5 backdrop-blur-xl" onClick={() => setProfile(null)}><div className="w-full max-w-md rounded-md border border-white/[0.1] bg-[#0d1118] p-6 text-white" onClick={event => event.stopPropagation()}>{profileLoading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : <><div className="flex items-start justify-between"><div className="flex min-w-0 items-center gap-4"><img src={profile.profile.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" /><div className="min-w-0"><h3 className="truncate text-lg font-semibold">{profile.profile.nickname}</h3><p className="mt-1 text-xs text-white/38">Lv.{profile.level || 0} · {profile.profile.follows || 0} 关注 · {profile.profile.followeds || 0} 粉丝</p></div></div><button type="button" onClick={() => setProfile(null)} aria-label="关闭用户资料"><X className="h-5 w-5" /></button></div><p className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-white/55">{profile.profile.signature || '这个用户还没有填写个人介绍。'}</p></>}</div></div>}
    </div>
  )
}
