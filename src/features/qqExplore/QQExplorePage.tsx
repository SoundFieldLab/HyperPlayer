import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronRight, Disc3, Headphones, Heart, Loader2, MessageCircle, MoreHorizontal, Play, Radio, RefreshCw, SlidersHorizontal, Sparkles, Trophy, X } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import type { ExploreChart, ExplorePayload, ExplorePlaylist } from '../../services/exploreApi'
import type { MusicPlatform } from '../../services/platforms'
import type { EntitlementTier } from '../../utils/musicEntitlements'
import { shouldShowEntitlementBadge } from '../../utils/musicEntitlements'
import { HorizontalShelf } from '../../components/apple-explore/HorizontalShelf'
import VideoPlayer from '../../components/VideoPlayer'
import QQMusicJourney from '../../components/QQMusicJourney'
import { fetchQQGuessYouLikeBatch, getExploreCookie } from '../../services/exploreApi'
import { applyFavoriteMutation, getFavoriteSongIdentifiers, getFavoriteUserId, loadFavoriteIdentifiers } from '../../services/favoriteStatusService'
import { fetchQQExploreFeedbackOptions, fetchQQExplorePreferences, fetchQQRadarSongs, resolveQQExploreSong, resolveQQExploreSongs, saveQQExplorePreferences, submitQQExploreFeedback, type QQExploreFeedbackOption, type QQExplorePreferenceItem } from './api'
import { qqCardPlaylist, qqModuleIdentity, qqModuleInstanceIdentity, type QQExploreCard, type QQExploreModule, type QQMusicHallCard, type QQMusicHallShelf } from './model'
import { qqExploreAccountKey, useQQExploreController } from './useQQExploreController'

interface QQExplorePageProps {
  loggedIn: boolean
  username: string
  userId?: string
  authRevision: number
  entitlement: EntitlementTier
  accent: string
  showDescription: boolean
  officialEnhanced: boolean
  publicContent?: ExplorePayload | null
  onLogin: () => void
  onPlaySongs: (song: Song, songs: Song[], continuous?: boolean) => void
  onOpenPlaylist: (playlist: ExplorePlaylist, autoplay?: boolean) => void
  onOpenChart: (chart: ExplorePayload['charts'][number], autoplay?: boolean) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onOpenChannel: (channel: ExplorePayload['channels'][number], autoplay?: boolean) => void
  onOpenSearch: (query?: string) => void
  onConfiguredChange: (configured: boolean) => void
  onOpenPlaylists: () => void
  onOpenCharts: () => void
  onSongContextMenu: (event: React.MouseEvent, song: Song, songs: Song[]) => void
  onViewComments?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void | Promise<boolean>
  onRemoveFromFavorites?: (song: Song) => void | Promise<boolean>
}

const ENTRY_LABELS: Record<string, string> = {
  '猜你喜欢': 'For You',
  '每日30首': 'Daily 30',
  '雷达模式': 'Fav Radar',
  '百万收藏': 'Top Fav',
  '新歌推荐': 'New Songs',
  '歌手漫游': 'Star Mix',
}

const HIDDEN_MUSIC_HALL_SHELVES = new Set(['精选视频', '墙裂推荐', '明星空降', '数字专辑', '编辑甄选'])
const HIDDEN_MUSIC_HALL_EXACT = new Set(['直播', '排行榜'])
const HIDDEN_QUICK_LINK_TITLES = new Set(['歌手', '排行', '歌单', '星光', '农场', '专辑', '商城', 'bubble', 'DM', '写歌', '歌词卡', '频道'])

function visibleMusicHallShelves(shelves: QQMusicHallShelf[]) {
  return shelves.filter(shelf => {
    const title = shelf.title.trim()
    const cardTitles = shelf.cards.map(card => card.title.trim()).filter(Boolean)
    const quickLinkMatches = cardTitles.filter(cardTitle => HIDDEN_QUICK_LINK_TITLES.has(cardTitle)).length
    if (shelf.id === '3' || !title || title === '更多' || quickLinkMatches >= 3 || HIDDEN_MUSIC_HALL_EXACT.has(title)) return false
    return !Array.from(HIDDEN_MUSIC_HALL_SHELVES).some(hidden => title.includes(hidden))
  })
}

function isEntryModule(module: QQExploreModule) {
  return module.id === '301'
}

function isPersonalizedFlowModule(module: QQExploreModule) {
  return module.id === '315'
}

function topCardKind(card: QQExploreCard): 'guess' | 'daily' | 'radar' | 'generic' {
  if (card.style !== 202) return 'generic'
  if (card.type === 700 && card.subtype === 711 && card.classification === '10001') return 'guess'
  if (card.type === 500 && card.subtype === 510 && card.classification === '10002') return 'daily'
  if (card.type === 900 && card.subtype === 991 && card.classification === '22000') return 'radar'
  return 'generic'
}

function groupIntoRows<T>(items: T[], size = 3): T[][] {
  const groups: T[][] = []
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size))
  return groups
}

function isSongCard(card: QQExploreCard) {
  return card.action.type === 'play-songs'
}

function cardSong(card: QQExploreCard): Song {
  return card.songs[0] || {
    id: Number(card.id) || 0,
    name: card.title,
    artists: card.subtitle ? [{ name: card.subtitle }] : [],
    album: { name: '', picUrl: card.coverUrl || '' },
    duration: 0,
    platform: 'qq',
  }
}

function closedShelfStorageKey(account: string) {
  return `hyperplayer:qq-explore:closed-shelves:${account}`
}

function qqFavoriteUserId(userId?: string) {
  if (userId) return userId
  const stored = getFavoriteUserId('qq')
  if (stored) return stored
  const cookie = getExploreCookie('qq')
  const match = cookie.match(/(?:^|;\s*)(?:uin|qqmusic_uin)=o?(\d+)/i)
  return match?.[1] || ''
}

function QQImage({ src, className, fallbackClassName = '' }: { src?: string; className: string; fallbackClassName?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) return <span aria-hidden="true" className={`block bg-[linear-gradient(135deg,rgba(60,70,82,0.8),rgba(22,26,32,0.95))] ${fallbackClassName || className}`} />
  return <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onLoad={event => event.currentTarget.classList.add('wf-qq-image-loaded')} onError={() => setFailed(true)} className={`wf-qq-image ${className}`} />
}

function FavoriteCountIcon({ count, active = false, loading = false }: { count?: string; active?: boolean; loading?: boolean }) {
  return <span className="relative inline-flex h-8 min-w-12 items-end justify-start" aria-hidden="true">{loading ? <Loader2 className="mb-0.5 h-5 w-5 animate-spin" /> : <Heart strokeWidth={1.8} className={`h-7 w-7 ${active ? 'text-white/78' : 'text-white/48'}`} />}{count && <span className="absolute left-[23px] top-0 whitespace-nowrap text-[11px] font-semibold leading-none text-white/58">{count}</span>}</span>
}

function FlowFavoriteCount({ count, active }: { count?: string; active: boolean }) {
  return <span className={`wf-qq-flow-favorite ${active ? 'wf-qq-flow-favorite-active' : ''}`} aria-label={count ? `收藏 ${count}` : '收藏'}><Heart strokeWidth={1.7} className={active ? 'fill-rose-400 text-rose-400' : 'text-white/55'} /><span>{count}</span></span>
}

function adjustFavoriteCount(value: string, delta: number) {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return normalized
  return String(Math.max(0, Number(normalized) + delta))
}

function QQExploreSkeleton() {
  return <div className="space-y-10 pb-8" aria-label="正在加载 QQ 音乐推荐"><div className="h-9 w-72 animate-pulse rounded bg-white/[0.07]" /><div className="wf-drag-rail wf-no-scrollbar flex gap-4 overflow-hidden"><div className="aspect-[1.35/1] w-[340px] shrink-0 animate-pulse rounded-lg bg-white/[0.06]" /><div className="aspect-[1.35/1] w-[340px] shrink-0 animate-pulse rounded-lg bg-white/[0.06]" /><div className="aspect-[1.35/1] w-[340px] shrink-0 animate-pulse rounded-lg bg-white/[0.06]" /><div className="aspect-[1.35/1] w-[170px] shrink-0 animate-pulse rounded-lg bg-white/[0.06]" /></div><div className="space-y-3"><div className="h-6 w-48 animate-pulse rounded bg-white/[0.07]" /><div className="grid grid-cols-3 gap-4">{Array.from({ length: 9 }, (_, index) => <div key={index} className="flex items-center gap-3 border-b border-white/[0.05] py-2"><span className="h-14 w-14 shrink-0 animate-pulse rounded-md bg-white/[0.07]" /><span className="h-4 flex-1 animate-pulse rounded bg-white/[0.055]" /></div>)}</div></div></div>
}

function SongStateBadges({ song, entitlement }: { song: Song; entitlement: EntitlementTier }) {
  return <>{song.noCopyright && <span className="rounded border border-white/10 px-1 text-[10px] text-white/35">无版权</span>}{shouldShowEntitlementBadge(song, entitlement) && <span className="rounded border border-amber-300/20 px-1 text-[10px] text-amber-200/75">{song.requiredTier === 'svip' ? 'SVIP' : 'VIP'}</span>}</>
}

function FlowCard({ card, entitlement, loading, favoritesReady, favoritePending, onClick, onSongClick, onSongContextMenu, onSongFavorite, isSongFavorite }: { card: QQExploreCard; entitlement: EntitlementTier; loading: boolean; favoritesReady: boolean; favoritePending: Set<string>; onClick: () => void; onSongClick: (song: Song) => void; onSongContextMenu: (event: React.MouseEvent, song: Song) => void; onSongFavorite: (event: React.MouseEvent, song: Song) => void; isSongFavorite: (song: Song) => boolean }) {
  const isSongGroup = card.style === 304 || card.subtype === 206
  const songs = card.songs
  if (isSongGroup && songs.length > 1) {
    return (
      <div className="relative min-w-0 self-start overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.045] p-3">
        <div className="mb-2 truncate text-[13px] font-medium text-white/88">{card.title}</div>
        <div className="space-y-0.5">{songs.slice(0, 3).map(song => <div key={song.mid || song.id} role="button" tabIndex={song.noCopyright ? -1 : 0} aria-disabled={song.noCopyright || undefined} onClick={() => { if (!song.noCopyright) onSongClick(song) }} onContextMenu={event => onSongContextMenu(event, song)} onKeyDown={event => { if (!song.noCopyright && (event.key === 'Enter' || event.key === ' ')) onSongClick(song) }} className={`group/song flex items-center gap-2 rounded-md p-1 ${song.noCopyright ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:bg-white/[0.055]'}`}><QQImage src={song.album.picUrl} className="h-10 w-10 rounded object-cover" /><span className="min-w-0 flex-1"><span className="flex items-center gap-1"><span className="truncate text-[13px] text-white/85">{song.name}</span><SongStateBadges song={song} entitlement={entitlement} /></span><span className="block truncate text-[11px] text-white/38">{song.artists.map(artist => artist.name).join('/')}</span></span><button type="button" disabled={!favoritesReady || favoritePending.has(String(song.mid || song.id))} onClick={event => onSongFavorite(event, song)} className="h-7 w-7 shrink-0 text-white/30 hover:text-rose-300 disabled:opacity-40" aria-label={isSongFavorite(song) ? `取消喜欢${song.name}` : `喜欢${song.name}`}>{favoritePending.has(String(song.mid || song.id)) ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" /> : <Heart className={`mx-auto h-3.5 w-3.5 ${isSongFavorite(song) ? 'fill-rose-400 text-rose-400' : ''}`} />}</button></div>)}</div>
        {loading && <span className="absolute inset-0 flex items-center justify-center bg-black/35"><Loader2 className="h-5 w-5 animate-spin" /></span>}
      </div>
    )
  }
  const primarySong = songs[0]
  const unavailable = Boolean(primarySong?.noCopyright)
  return (
    <button type="button" disabled={unavailable} onClick={onClick} onContextMenu={event => primarySong && onSongContextMenu(event, primarySong)} className="group relative w-full min-w-0 overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.045] text-left disabled:cursor-not-allowed disabled:opacity-50">
      <span className="relative block">{card.coverUrl && <QQImage src={card.coverUrl} className="aspect-[4/3] w-full object-contain transition duration-500 group-hover:scale-[1.015]" />}{card.typeTag && <span className="absolute left-2 top-2 max-w-[70%] truncate rounded bg-black/48 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">{card.typeTag}</span>}<span className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:opacity-100"><Play className="h-3.5 w-3.5 fill-current" /></span></span>
      <span className="block p-3"><span className="flex items-center gap-1.5"><span className="block min-w-0 truncate text-[13px] font-medium">{card.title}</span>{primarySong && <SongStateBadges song={primarySong} entitlement={entitlement} />}</span>{(card.reason || card.subtitle || card.content) && <span className="mt-1 block line-clamp-2 text-[11px] text-white/40">{card.reason || card.subtitle || card.content}</span>}<span className="mt-2 flex min-h-7 items-end gap-2"><span className="flex min-w-0 flex-1 flex-wrap gap-1">{(card.lowerTags.length > 0 ? card.lowerTags.map(tag => tag.tag) : card.countContent ? [card.countContent] : card.badges).slice(0, 3).map(label => <span key={label} className="max-w-full truncate rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/48">{label}</span>)}</span><FlowFavoriteCount count={card.favoriteCount} active={card.isFavorite} /></span></span>
      {loading && <span className="absolute inset-0 flex items-center justify-center bg-black/35"><Loader2 className="h-5 w-5 animate-spin" /></span>}
    </button>
  )
}

export default function QQExplorePage({
  loggedIn,
  username,
  userId,
  authRevision,
  entitlement,
  accent,
  showDescription,
  officialEnhanced,
  publicContent,
  onLogin,
  onPlaySongs,
  onOpenPlaylist,
  onOpenChart,
  onOpenAlbum,
  onOpenChannel,
  onOpenSearch,
  onConfiguredChange,
  onOpenPlaylists,
  onOpenCharts,
  onSongContextMenu,
  onViewComments,
  onAddToFavorites,
  onRemoveFromFavorites,
}: QQExplorePageProps) {
  const flowAnchorRef = useRef<HTMLDivElement | null>(null)
  const previousLoadingMore = useRef(false)
  const { state, refreshFeed, refreshModule, appendFromCard, replaceWithSimilar, loadMore } = useQQExploreController(loggedIn, userId, authRevision)
  const [actionLoading, setActionLoading] = useState('')
  const [actionError, setActionError] = useState('')
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())
  const [favoritesReady, setFavoritesReady] = useState(false)
  const favoriteOwnerRef = useRef('')
  const [favoriteOverrides, setFavoriteOverrides] = useState<Map<string, boolean>>(new Map())
  const [favoritePending, setFavoritePending] = useState<Set<string>>(new Set())
  const [favoriteCountOverrides, setFavoriteCountOverrides] = useState<Map<string, string>>(new Map())
  const favoritePendingRef = useRef(new Set<string>())
  const [guessSong, setGuessSong] = useState<Song | null>(null)
  const [guessLoading, setGuessLoading] = useState(false)
  const [guessError, setGuessError] = useState('')
  const guessBatch = useRef(0)
  const guessGeneration = useRef(0)
  const [playingMV, setPlayingMV] = useState<{ id: string; name: string } | null>(null)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [preferences, setPreferences] = useState<QQExplorePreferenceItem[]>([])
  const [initialPreferences, setInitialPreferences] = useState<Map<string, boolean>>(new Map())
  const [preferencesLoading, setPreferencesLoading] = useState(false)
  const [preferencesError, setPreferencesError] = useState('')
  const [feedbackCard, setFeedbackCard] = useState<QQExploreCard | null>(null)
  const [feedbackModule, setFeedbackModule] = useState<QQExploreModule | null>(null)
  const [feedbackOptions, setFeedbackOptions] = useState<QQExploreFeedbackOption[]>([])
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState('')
  const account = qqExploreAccountKey(userId)
  const [closedShelves, setClosedShelves] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(closedShelfStorageKey(account)) || '[]')) } catch { return new Set() }
  })
  const favoriteUserId = qqFavoriteUserId(userId)
  const snapshot = state.snapshot
  const musicHallShelves = visibleMusicHallShelves(snapshot?.musicHall || [])
  const entryModule = snapshot?.feed.modules.find(isEntryModule)
  const entries = entryModule?.cards || []
  const skillPlaylists = (publicContent?.playlists || []).filter(playlist => playlist.source === 'qqmusic-skills')
  const communityPlaylists = (publicContent?.playlists || []).filter(playlist => playlist.source !== 'qqmusic-skills')
  const contentModules = useMemo(
    () => (snapshot?.feed.modules || []).filter(module => !isEntryModule(module) && !closedShelves.has(qqModuleInstanceIdentity(module))),
    [closedShelves, snapshot?.feed.modules],
  )

  useEffect(() => {
    try { setClosedShelves(new Set(JSON.parse(localStorage.getItem(closedShelfStorageKey(account)) || '[]'))) } catch { setClosedShelves(new Set()) }
  }, [account])

  const closeModule = useCallback((module: QQExploreModule) => {
    const identity = qqModuleInstanceIdentity(module)
    setClosedShelves(previous => {
      const next = new Set(previous).add(identity)
      try { localStorage.setItem(closedShelfStorageKey(account), JSON.stringify([...next])) } catch { /* Keep the in-memory close state. */ }
      return next
    })
  }, [account])

  useEffect(() => {
    if (previousLoadingMore.current && !state.loadingMore && flowAnchorRef.current) {
      flowAnchorRef.current.scrollIntoView({ block: 'nearest' })
    }
    previousLoadingMore.current = state.loadingMore
  }, [state.loadingMore])

  useEffect(() => {
    const requestId = ++guessGeneration.current
    if (!loggedIn) {
      guessBatch.current = 0
      setGuessSong(null)
      setGuessLoading(false)
      setGuessError('')
      return
    }
    const previousKey = guessSong ? String(guessSong.mid || guessSong.id) : ''
    const batch = ++guessBatch.current
    setGuessSong(null)
    setGuessLoading(true)
    setGuessError('')
    const abortController = new AbortController()
    void fetchQQGuessYouLikeBatch(batch, previousKey ? [previousKey] : [], abortController.signal).then(songs => {
      if (requestId === guessGeneration.current) setGuessSong(songs[0] || null)
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error || '')
      const cancelled = abortController.signal.aborted || error instanceof DOMException && error.name === 'AbortError' || /aborted without reason/i.test(message)
      if (!cancelled && requestId === guessGeneration.current) setGuessError(message || '代表歌曲加载失败')
    }).finally(() => {
      if (requestId === guessGeneration.current) setGuessLoading(false)
    })
    return () => {
      guessGeneration.current += 1
      abortController.abort()
    }
  }, [authRevision, loggedIn, snapshot?.generatedAt])

  useEffect(() => {
    const owner = loggedIn && favoriteUserId ? `qq:${favoriteUserId}` : ''
    favoriteOwnerRef.current = owner
    setFavoriteIds(new Set())
    setFavoriteOverrides(new Map())
    setFavoritePending(new Set())
    setFavoriteCountOverrides(new Map())
    favoritePendingRef.current.clear()
    setFavoritesReady(false)
    if (!owner || !favoriteUserId) return
    let cancelled = false
    void loadFavoriteIdentifiers('qq', favoriteUserId).then(ids => {
      if (!cancelled && favoriteOwnerRef.current === owner) {
        setFavoriteIds(new Set(ids))
        setFavoritesReady(true)
      }
    }).catch(() => {
      if (!cancelled && favoriteOwnerRef.current === owner) setFavoritesReady(true)
    })
    const handleFavoriteChange = (event: Event) => {
      const detail = (event as CustomEvent<{ platform?: MusicPlatform; type?: string; songId?: string | number; songMid?: string }>).detail
      if (detail?.platform !== 'qq') return
      applyFavoriteMutation(detail)
      setFavoriteIds(previous => {
        const next = new Set(previous)
        for (const identifier of [detail.songId, detail.songMid]) {
          if (identifier === undefined || identifier === null) continue
          if (detail.type === 'like') next.add(String(identifier))
          if (detail.type === 'unlike') next.delete(String(identifier))
        }
        return next
      })
      setFavoriteOverrides(previous => {
        const next = new Map(previous)
        for (const identifier of [detail.songMid, detail.songId]) {
          if (identifier !== undefined && identifier !== null) next.set(String(identifier), detail.type === 'like')
        }
        return next
      })
    }
    window.addEventListener('playlist-content-changed', handleFavoriteChange)
    return () => {
      cancelled = true
      window.removeEventListener('playlist-content-changed', handleFavoriteChange)
    }
  }, [favoriteUserId, loggedIn])

  const isSongFavorite = useCallback((song: Song | undefined, card: QQExploreCard) => {
    const key = String(song?.mid || song?.id || card.id)
    if (favoriteOverrides.has(key)) return Boolean(favoriteOverrides.get(key))
    return Boolean(card.isFavorite || (song && getFavoriteSongIdentifiers(song).some(identifier => favoriteIds.has(identifier))))
  }, [favoriteIds, favoriteOverrides])

  const mutateFavorite = useCallback(async (song: Song, current: boolean): Promise<boolean> => {
    const identifiers = getFavoriteSongIdentifiers(song)
    const key = String(song.mid || song.id)
    if (!favoritesReady || favoritePendingRef.current.has(key)) return false
    favoritePendingRef.current.add(key)
    const previousOverride = favoriteOverrides.get(key)
    setFavoritePending(previous => new Set(previous).add(key))
    setFavoriteOverrides(previous => new Map(previous).set(key, !current))
    try {
      const result = current ? await onRemoveFromFavorites?.(song) : await onAddToFavorites?.(song)
      if (result === false || (!current && !onAddToFavorites) || (current && !onRemoveFromFavorites)) {
        throw new Error(current ? '取消喜欢失败' : '添加到喜欢失败')
      }
      setFavoriteIds(previous => {
        const next = new Set(previous)
        for (const identifier of identifiers) {
          if (current) next.delete(identifier)
          else next.add(identifier)
        }
        return next
      })
      setFavoriteCountOverrides(previous => {
        const next = new Map(previous)
        const card = snapshot?.feed.modules.flatMap(module => module.cards).find(item => item.songs.some(value => String(value.mid || value.id) === key) || String(item.id) === String(song.id))
        if (card) next.set(key, adjustFavoriteCount(next.get(key) ?? card.favoriteCount, current ? -1 : 1))
        return next
      })
      return true
    } catch (error) {
      setFavoriteOverrides(previous => {
        const next = new Map(previous)
        if (previousOverride === undefined) next.delete(key)
        else next.set(key, previousOverride)
        return next
      })
      setActionError(error instanceof Error ? error.message : '收藏状态更新失败')
      return false
    } finally {
      favoritePendingRef.current.delete(key)
      setFavoritePending(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }, [favoriteOverrides, favoritesReady, onAddToFavorites, onRemoveFromFavorites, snapshot?.feed.modules])

  const toggleFavorite = useCallback(async (event: React.MouseEvent, card: QQExploreCard, module?: QQExploreModule) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      const fallbackSong = cardSong(card)
      const song = fallbackSong.mid ? fallbackSong : await resolveQQExploreSong(card.id, { title: card.title, artist: card.subtitle, coverUrl: card.coverUrl })
      const wasFavorite = isSongFavorite(song, card)
      const success = await mutateFavorite(song, wasFavorite)
      if (success && !wasFavorite && module) void appendFromCard(module, card, 'like')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '收藏状态更新失败')
    }
  }, [appendFromCard, isSongFavorite, mutateFavorite])

  const isStandaloneSongFavorite = useCallback((song: Song, card?: QQExploreCard) => {
    const key = String(song.mid || song.id)
    if (favoriteOverrides.has(key)) return Boolean(favoriteOverrides.get(key))
    return Boolean(card?.isFavorite || getFavoriteSongIdentifiers(song).some(identifier => favoriteIds.has(identifier)))
  }, [favoriteIds, favoriteOverrides])

  const toggleStandaloneFavorite = useCallback((event: React.MouseEvent, song: Song, card?: QQExploreCard) => {
    event.preventDefault()
    event.stopPropagation()
    void mutateFavorite(song, isStandaloneSongFavorite(song, card))
  }, [isStandaloneSongFavorite, mutateFavorite])

  const resolveCards = useCallback(async (cards: QQExploreCard[]) => {
    const alreadyResolved = new Map(cards
      .filter(card => card.songs[0]?.mid)
      .map(card => [card.id, card.songs[0]] as const))
    const unresolved = cards.filter(card => isSongCard(card) && !alreadyResolved.has(card.id))
    const fetched = unresolved.length > 0 ? await resolveQQExploreSongs(unresolved.map(card => ({
      songId: card.id,
      title: card.title,
      artist: card.subtitle,
      coverUrl: card.coverUrl,
    }))) : []
    const fetchedById = new Map(fetched.map(song => [String(song.id), song]))
    return cards.map(card => alreadyResolved.get(card.id) || fetchedById.get(card.id)).filter((song): song is Song => Boolean(song))
  }, [])

  const openResolvedSongContextMenu = useCallback(async (event: React.MouseEvent, card: QQExploreCard, siblings: QQExploreCard[]) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      const song = card.songs[0]?.mid ? card.songs[0] : await resolveQQExploreSong(card.id, { title: card.title, artist: card.subtitle, coverUrl: card.coverUrl })
      const resolved = await resolveCards(siblings.filter(isSongCard))
      onSongContextMenu(event, song, resolved.length > 0 ? resolved : [song])
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '歌曲信息加载失败')
    }
  }, [onSongContextMenu, resolveCards])

  const openFeedback = useCallback(async (card: QQExploreCard, module: QQExploreModule) => {
    if (!card.feedbackToken) return
    setFeedbackCard(card)
    setFeedbackModule(module)
    setFeedbackOptions([])
    setFeedbackError('')
    setFeedbackLoading(true)
    try {
      const result = await fetchQQExploreFeedbackOptions(card.feedbackToken)
      setFeedbackOptions(result.options)
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : '反馈选项加载失败')
    } finally {
      setFeedbackLoading(false)
    }
  }, [])

  const submitFeedback = useCallback(async (option: QQExploreFeedbackOption) => {
    if (!feedbackCard?.feedbackToken) return
    setFeedbackLoading(true)
    setFeedbackError('')
    try {
      await submitQQExploreFeedback(feedbackCard.feedbackToken, [option.token])
      setFeedbackCard(null)
      await refreshFeed()
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : '反馈提交失败')
    } finally {
      setFeedbackLoading(false)
    }
  }, [feedbackCard, refreshFeed])

  const openPreferences = useCallback(async () => {
    setPreferencesOpen(true)
    setPreferencesLoading(true)
    setPreferencesError('')
    try {
      const result = await fetchQQExplorePreferences()
      setPreferences(result.items)
      setInitialPreferences(new Map(result.items.map(item => [item.id, item.selected])))
    } catch (error) {
      setPreferencesError(error instanceof Error ? error.message : '推荐偏好加载失败')
    } finally {
      setPreferencesLoading(false)
    }
  }, [])

  const savePreferences = useCallback(async () => {
    const changed = preferences.filter(item => initialPreferences.get(item.id) !== item.selected)
    if (changed.length === 0) {
      setPreferencesOpen(false)
      return
    }
    setPreferencesLoading(true)
    setPreferencesError('')
    try {
      await saveQQExplorePreferences(changed)
      setPreferencesOpen(false)
      await refreshFeed()
    } catch (error) {
      setPreferencesError(error instanceof Error ? error.message : '推荐偏好保存失败')
    } finally {
      setPreferencesLoading(false)
    }
  }, [initialPreferences, preferences, refreshFeed])

  const executeCard = useCallback(async (card: QQExploreCard, module?: QQExploreModule) => {
    if (actionLoading) return
    setActionLoading(card.feedKey || card.id)
    setActionError('')
    try {
      if (card.action.type === 'open-playlist') {
        const playlist = qqCardPlaylist(card)
        if (playlist) onOpenPlaylist(playlist)
        return
      }
      if (card.action.type === 'play-radio') {
        const songs = await fetchQQGuessYouLikeBatch(1)
        if (songs[0]) onPlaySongs(songs[0], songs, true)
        return
      }
      if (card.action.type === 'play-radar') {
        const result = await fetchQQRadarSongs(card.action)
        if (result.songs[0]) onPlaySongs(result.songs[0], result.songs, true)
        return
      }
      if (card.action.type === 'play-songs') {
        if (card.songs.length > 1) {
          const playable = card.songs.filter(song => !song.noCopyright)
          if (playable[0]) onPlaySongs(playable[0], playable)
          if (module) void appendFromCard(module, card, 'play')
          return
        }
        const siblings = module?.cards.filter(isSongCard) || [card]
        const songs = await resolveCards(siblings)
        const playable = songs.filter(song => !song.noCopyright)
        const selected = playable.find(song => String(song.id) === card.id || String(song.mid || '') === card.id) || playable[0]
        if (selected) {
          onPlaySongs(selected, playable)
          if (module) void appendFromCard(module, card, 'play')
        }
        return
      }
      if (card.action.type === 'open-preferences') {
        await openPreferences()
        return
      }
      if (card.action.type === 'open-external') {
        const bridge = window.electronAPI
        if (bridge?.openExternal) await bridge.openExternal(card.action.url)
        else window.open(card.action.url, '_blank', 'noopener,noreferrer')
        return
      }
      if (card.action.type === 'search') onOpenSearch(card.action.query)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '推荐内容暂时无法打开')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, appendFromCard, onOpenPlaylist, onOpenSearch, onPlaySongs, openPreferences, resolveCards])

  const executeMusicHallCard = useCallback(async (card: QQMusicHallCard, shelf: QQMusicHallShelf) => {
    const action = card.action
    if (action.type === 'play-songs') {
      const song = card.songs[0] || await resolveQQExploreSongs([{ songId: card.id, title: card.title, artist: card.subtitle, coverUrl: card.coverUrl }]).then(items => items[0])
      const queue = shelf.cards.flatMap(item => item.songs).filter(item => !item.noCopyright)
      if (song && !song.noCopyright) onPlaySongs(song, queue.length > 0 ? queue : [song])
      return
    }
    if (action.type === 'open-playlist') {
      onOpenPlaylist({ id: action.playlistId, name: card.title || 'QQ 音乐歌单', coverUrl: card.coverUrl, platform: 'qq', source: 'qq-native-music-hall' })
      return
    }
    if (action.type === 'open-album') {
      onOpenAlbum?.(action.albumId, 'qq')
      return
    }
    if (action.type === 'open-chart') {
      const chart: ExploreChart = { id: action.chartId, name: card.title || 'QQ 音乐榜单', group: shelf.title || '排行榜', coverUrl: card.coverUrl, platform: 'qq', songs: [] }
      onOpenChart(chart)
      return
    }
    if (action.type === 'open-mv') {
      setPlayingMV({ id: action.mvId, name: card.title || 'QQ 音乐视频' })
      return
    }
    if (action.type === 'open-section') {
      if (action.section === 'charts') onOpenCharts()
      else if (action.section === 'playlists') onOpenPlaylists()
      return
    }
    if (action.type === 'open-external') {
      const bridge = window.electronAPI
      if (bridge?.openExternal) await bridge.openExternal(action.url)
      else window.open(action.url, '_blank', 'noopener,noreferrer')
    }
  }, [onOpenAlbum, onOpenChart, onOpenCharts, onOpenPlaylist, onOpenPlaylists, onPlaySongs])

  if (!loggedIn) {
    return (
      <div className="flex min-h-[520px] items-center justify-center px-5">
        <div className="max-w-md text-center">
          <Radio className="mx-auto h-10 w-10" style={{ color: accent }} />
          <h2 className="mt-5 text-2xl font-semibold">登录 QQ 音乐查看账号推荐</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/45">登录后显示与手机客户端同账号的猜你喜欢、每日30首、雷达模式和专属推荐流。</p>
          <button type="button" onClick={onLogin} className="mt-6 rounded-full px-5 py-2.5 text-sm font-semibold text-[#061018]" style={{ background: accent }}>登录 QQ 音乐</button>
        </div>
      </div>
    )
  }

  if (state.initialLoading && !snapshot) {
    return <QQExploreSkeleton />
  }

  return (
    <div className="space-y-10 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-white/42">
            <Sparkles className="h-4 w-4" style={{ color: accent }} />
            QQ 音乐账号推荐
          </div>
          <h2 className="mt-2 text-2xl font-semibold md:text-3xl">{entryModule?.title || `${username || 'QQ 音乐用户'}，今日为你推荐`}</h2>
          {showDescription && <p className="mt-2 text-sm text-white/42">内容直接来自当前账号的手机客户端推荐流。</p>}
        </div>
        <button type="button" onClick={() => void refreshFeed()} disabled={state.refreshing || Boolean(state.refreshingModuleId) || state.loadingMore} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.05] px-4 text-sm text-white/65 transition hover:bg-white/[0.1] disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${state.refreshing ? 'animate-spin' : ''}`} />
          刷新推荐
        </button>
      </div>

      {(state.error || actionError) && (
        <div className="flex items-center gap-3 rounded-lg border border-rose-300/15 bg-rose-300/[0.08] px-4 py-3 text-sm text-rose-100/80">
          <AlertCircle className="h-4 w-4" />{actionError || state.error}
        </div>
      )}

      {entries.length > 0 && (
        <section aria-label="QQ 音乐快捷入口">
          <HorizontalShelf ariaLabel="QQ 音乐快捷入口" edgeControls="hover" className="-mx-5" viewportClassName="gap-4" itemClassName="w-[250px] sm:w-[270px] xl:w-[290px]">
            {entries.map(card => {
              const kind = topCardKind(card)
              const daily = kind === 'daily' ? snapshot?.daily30 : null
              const entrySong = kind === 'guess' ? guessSong : daily?.songs[0]
              const entryCover = card.coverUrl || entrySong?.album.picUrl || daily?.coverUrl
              const loading = actionLoading === (card.feedKey || card.id) || (kind === 'guess' && guessLoading)
              const layerPictures = [card.layerElementPic0, card.layerElementPic1, card.layerElementPic2].filter(Boolean)
              return (
                <button
                  key={card.feedKey || card.id}
                  type="button"
                  onClick={() => void executeCard(card, entryModule)}
                  className="group relative aspect-[1.5/1] w-full overflow-hidden rounded-lg border border-white/[0.09] bg-white/[0.05] text-left"
                >
                  <span className="absolute inset-0 bg-white/[0.035]" />
                  {kind === 'guess' && layerPictures.length === 0 && <span className="absolute inset-0 bg-[linear-gradient(135deg,#bc1f25_0%,#7f1017_60%,#23080b_100%)]" />}
                  {entryCover && <QQImage src={entryCover} className="absolute right-[5%] top-[8%] h-[58%] w-[54%] rounded-md object-contain transition duration-500 group-hover:scale-[1.02]" />}
                  {layerPictures.map((picture, index) => <QQImage key={`${picture}-${index}`} src={picture} className="pointer-events-none absolute inset-0 h-full w-full object-contain" fallbackClassName="hidden" />)}
                  {card.layerTitle && <span className="pointer-events-none absolute left-5 top-5 max-w-[45%] text-3xl font-semibold leading-none text-white">{card.layerTitle}</span>}
                  {card.layerClassifyTitle && <span className="pointer-events-none absolute left-5 top-[4.25rem] max-w-[45%] truncate text-xs font-medium text-white/68">{card.layerClassifyTitle}</span>}
                  {!card.layerTitle && kind === 'guess' && <span className="pointer-events-none absolute left-5 top-5 whitespace-pre-line text-4xl font-semibold leading-[0.9] text-white">{'For\nYou'}</span>}
                  {!ENTRY_LABELS[card.title] && !entryCover && layerPictures.length === 0 && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-5xl font-semibold text-white/12">{card.title.slice(0, 2)}</span>}
                  {card.layerUrl && <QQImage src={card.layerUrl} className="pointer-events-none absolute inset-0 h-full w-full object-contain" fallbackClassName="hidden" />}
                  <span className="absolute inset-0 bg-[linear-gradient(0deg,rgba(5,8,12,0.9),rgba(5,8,12,0.02)_72%)]" />
                  <span className="relative flex h-full flex-col p-5">
                    {card.reason && <span className="w-fit max-w-[70%] truncate rounded bg-white/14 px-2 py-1 text-[10px] font-medium text-white/82 backdrop-blur">{card.reason}</span>}
                    <span className="mt-auto flex items-end justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-white">{card.title}</span>
                        <span className="mt-1 block truncate text-xs text-white/62">{kind === 'guess' && guessError ? guessError : card.subtitle || (entrySong ? `${entrySong.name}-${entrySong.artists.map(artist => artist.name).join('/')}` : guessLoading ? '正在获取推荐歌曲' : '为你准备推荐歌曲')}</span>
                      </span>
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black">
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : card.action.type === 'open-preferences' || card.action.type === 'unsupported' ? <ChevronRight className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
                      </span>
                    </span>
                  </span>
                </button>
              )
            })}
          </HorizontalShelf>
        </section>
      )}

      <div className="space-y-10">
        {contentModules.map((module, moduleIndex) => {
          const moduleIdentity = qqModuleIdentity(module)
          const moduleInstanceIdentity = qqModuleInstanceIdentity(module)
          const moduleRefreshing = state.refreshingModuleId === moduleIdentity
          const moduleError = state.moduleErrors[moduleIdentity]
          const songCards = module.cards.filter(card => isSongCard(card) && !card.twoColumn)
          const flowCards = module.cards.filter(card => card.twoColumn)
          const playlistCards = module.cards.filter(card => card.action.type === 'open-playlist' && !card.twoColumn)
          const otherCards = module.cards.filter(card => !isSongCard(card) && card.action.type !== 'open-playlist' && !card.twoColumn)
          return (
              <section key={`${module.id}-${moduleIndex}-${moduleInstanceIdentity}`}>
              {module.title && (
                <div className="mb-4 flex items-center gap-3">
                  <h3 className="text-xl font-semibold">{module.title}</h3>
                  {songCards.length > 0 && <button type="button" onClick={async () => { const songs = (await resolveCards(songCards)).filter(song => !song.noCopyright); if (songs[0]) onPlaySongs(songs[0], songs) }} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.07] text-white/65 hover:bg-white hover:text-black" aria-label={`播放${module.title}`}><Play className="h-3.5 w-3.5 fill-current" /></button>}
                  {module.refresh && <button type="button" onClick={() => void refreshModule(module)} disabled={Boolean(state.refreshingModuleId) || state.refreshing || state.loadingMore} className="flex h-8 w-8 items-center justify-center rounded-full text-white/38 hover:bg-white/[0.07] hover:text-white disabled:opacity-40" aria-label={`刷新${module.title || '专属乐流'}`}><RefreshCw className={`h-3.5 w-3.5 ${moduleRefreshing ? 'animate-spin' : ''}`} /></button>}
                  {!isPersonalizedFlowModule(module) && <button type="button" onClick={() => closeModule(module)} className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-white/28 hover:bg-white/[0.07] hover:text-white" aria-label={`关闭${module.title || '推荐栏目'}`}><X className="h-3.5 w-3.5" /></button>}
                </div>
              )}
              {!module.title && !isPersonalizedFlowModule(module) && <div className="mb-2 flex justify-end"><button type="button" onClick={() => closeModule(module)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/28 hover:bg-white/[0.07] hover:text-white" aria-label="关闭推荐栏目"><X className="h-3.5 w-3.5" /></button></div>}
              {moduleError && <p className="mb-3 text-xs text-rose-200/75">{moduleError}</p>}

              {flowCards.length > 0 && (
                <div ref={module.id === '315' ? flowAnchorRef : undefined} className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                  {flowCards.map((card, cardIndex) => (
                    <div key={card.feedKey || card.id} className="wf-qq-card-enter" style={{ animationDelay: `${Math.min(cardIndex, 12) * 24}ms` }}>
                    <FlowCard
                      key={card.feedKey || card.id}
                      card={card}
                      entitlement={entitlement}
                      loading={actionLoading === (card.feedKey || card.id)}
                      favoritesReady={favoritesReady}
                      favoritePending={favoritePending}
                      onClick={() => void executeCard(card, module)}
                      onSongClick={song => { const playable = card.songs.filter(item => !item.noCopyright); if (!song.noCopyright) onPlaySongs(song, playable) }}
                      onSongContextMenu={(event, song) => onSongContextMenu(event, song, card.songs.filter(item => !item.noCopyright))}
                      onSongFavorite={(event, song) => toggleStandaloneFavorite(event, song, card)}
                      isSongFavorite={song => isStandaloneSongFavorite(song, card)}
                    />
                    </div>
                  ))}
                </div>
              )}

              {songCards.length > 0 && (
                <HorizontalShelf ariaLabel={`${module.title || '歌曲推荐'}歌曲`} edgeControls="hover" className="-mx-5" itemClassName="w-[min(82vw,28rem)] md:w-[27rem] xl:w-[29rem]">
                  {groupIntoRows(songCards).map((column, columnIndex) => (
                    <div key={`${module.instanceId}-songs-${columnIndex}`} className="grid h-[216px] grid-rows-3">
                    {column.map(card => {
                      const resolvedSong = cardSong(card)
                      const noCopyright = Boolean(resolvedSong.noCopyright)
                      return (
                        <div
                        key={card.feedKey || card.id}
                        role="button"
                        aria-disabled={noCopyright || undefined}
                        tabIndex={noCopyright ? -1 : 0}
                        onContextMenu={event => void openResolvedSongContextMenu(event, card, songCards)}
                        onClick={() => { if (!noCopyright) void executeCard(card, module) }}
                        onKeyDown={event => { if (!noCopyright && (event.key === 'Enter' || event.key === ' ')) void executeCard(card, module) }}
                        className={`group flex min-w-0 items-center gap-3 border-b border-white/[0.055] py-2.5 text-left ${noCopyright ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`}
                      >
                        <span className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-white/[0.05]"><QQImage src={card.coverUrl} className="h-full w-full object-cover" /></span>
                        <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="truncate text-sm font-medium text-white/88">{card.title}</span><SongStateBadges song={resolvedSong} entitlement={entitlement} /></span><span className="mt-1 block truncate text-xs text-white/40">{card.subtitle || card.reason}</span>{card.badges.length > 0 && <span className="mt-1 flex gap-1 overflow-hidden">{card.badges.slice(0, 2).map(label => <span key={label} className="shrink-0 rounded bg-white/[0.06] px-1 text-[10px] text-white/45">{label}</span>)}</span>}</span>
                        <button type="button" disabled={!favoritesReady || favoritePending.has(String(resolvedSong.mid || resolvedSong.id || card.id))} onClick={event => void toggleFavorite(event, card, module)} className="flex shrink-0 items-center gap-1 text-xs text-white/42 hover:text-rose-300 disabled:opacity-45" aria-label={isSongFavorite(cardSong(card), card) ? `取消喜欢${card.title}` : `喜欢${card.title}`}>
                          <FavoriteCountIcon count={(favoriteCountOverrides.get(String(resolvedSong.mid || resolvedSong.id || card.id)) ?? card.favoriteCount) || undefined} active={isSongFavorite(cardSong(card), card)} loading={favoritePending.has(String(resolvedSong.mid || resolvedSong.id || card.id))} />
                        </button>
                        {card.commentCount && onViewComments && <button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); onViewComments(resolvedSong) }} className="flex shrink-0 items-center gap-1 text-[11px] text-white/35 hover:text-white" aria-label={`查看${card.title}评论`}><MessageCircle className="h-3.5 w-3.5" />{card.commentCount}</button>}
                        {card.feedbackToken && <button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); void openFeedback(card, module) }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/25 opacity-0 hover:bg-white/[0.08] hover:text-white group-hover:opacity-100" aria-label={`不感兴趣或调整${card.title}推荐`}><MoreHorizontal className="h-4 w-4" /></button>}
                        </div>
                      )
                    })}
                    </div>
                  ))}
                </HorizontalShelf>
              )}

              {playlistCards.length > 0 && (
                <HorizontalShelf ariaLabel={`${module.title || '推荐'}歌单`} edgeControls="hover" className="-mx-5" itemClassName="w-48">
                  {playlistCards.map(card => (
                    <button key={card.feedKey || card.id} type="button" onClick={() => void executeCard(card, module)} className="group w-full text-left">
                      <span className="relative block aspect-square overflow-hidden rounded-lg bg-white/[0.05]"><QQImage src={card.coverUrl} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" /><span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-white text-black opacity-0 transition group-hover:opacity-100"><Play className="h-3.5 w-3.5 fill-current" /></span></span>
                      <span className="mt-2 block line-clamp-2 text-sm font-medium">{card.title || '专属歌单'}</span>
                      {(card.reason || card.subtitle || card.content) && <span className="mt-1 block line-clamp-2 text-xs text-white/38">{card.reason || card.subtitle || card.content}</span>}
                      <span className="mt-1 block">{card.favoriteCount && <FavoriteCountIcon count={card.favoriteCount} />}{card.badges.length > 0 && <span className="ml-1 inline-flex gap-2 align-top text-[11px] text-white/35">{card.badges.slice(0, 2).map(label => <span key={label}>{label}</span>)}</span>}</span>
                    </button>
                  ))}
                </HorizontalShelf>
              )}

              {otherCards.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {otherCards.map(card => {
                    const unsupported = card.action.type === 'unsupported'
                    return (
                    <button key={card.feedKey || card.id} type="button" disabled={unsupported} title={unsupported ? `QQ 客户端专属内容 · ${card.type}:${card.subtype}:${card.style}:${card.jumpType}` : undefined} onClick={() => void executeCard(card, module)} className="flex min-h-20 items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.035] p-3 text-left disabled:cursor-not-allowed disabled:opacity-60">
                      {card.coverUrl && <QQImage src={card.coverUrl} className="h-14 w-14 rounded-md object-cover" />}
                      <span className="min-w-0 flex-1"><span className="block line-clamp-2 text-sm font-medium">{card.title || '推荐内容'}</span>{(card.content || card.reason || card.subtitle) && <span className="mt-1 block line-clamp-2 text-xs text-white/38">{card.content || card.reason || card.subtitle}</span>}<span className="mt-1 flex flex-wrap gap-1">{card.badges.filter(label => !/^https?:/i.test(label)).map(label => <span key={label} className="text-[11px] text-white/35">{label}</span>)}{unsupported && <span className="text-[11px] text-amber-200/55">QQ 客户端专属</span>}</span></span>
                      {!unsupported && <ChevronRight className="h-4 w-4 text-white/25" />}
                    </button>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
      </div>

      {closedShelves.size > 0 && <div className="flex justify-end"><button type="button" onClick={() => { setClosedShelves(new Set()); try { localStorage.removeItem(closedShelfStorageKey(account)) } catch { /* In-memory restore still succeeds. */ } }} className="text-xs text-white/38 hover:text-white">恢复已关闭栏目</button></div>}

      {state.paginationError && <p className="text-center text-xs text-rose-200/75">{state.paginationError}</p>}
      {snapshot?.feed.hasMore && (
        <div className="flex justify-center">
          <button type="button" disabled={state.loadingMore || state.refreshing || Boolean(state.refreshingModuleId)} onClick={() => void loadMore()} className="flex h-11 items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.04] px-6 text-sm text-white/62 hover:bg-white/[0.08] disabled:opacity-50">
            {state.loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4 rotate-90" />}
            {state.loadingMore ? `正在加载 ${state.loadingMoreProgress}/5 批` : '加载接下来 5 批专属乐流'}
          </button>
        </div>
      )}

      {musicHallShelves.length > 0 && (
        <div className="space-y-12 border-t border-white/[0.08] pt-10" aria-label="QQ 音乐馆">
          {musicHallShelves.map(shelf => {
            const isFocus = shelf.title === '焦点图'
            const isSongShelf = shelf.title === '新歌'
            return (
              <section key={shelf.id}>
                {shelf.title && !isFocus && <div className="mb-4 flex items-center gap-2"><Disc3 className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">{shelf.title}</h3></div>}
                {isFocus ? (
                  <HorizontalShelf ariaLabel="QQ 音乐焦点图" edgeControls="hover" className="-mx-5" itemClassName="w-[76%] max-w-[760px]">
                    {shelf.cards.map(card => <button key={`${card.id}-${card.title}`} type="button" disabled={card.action.type === 'unsupported'} onClick={() => void executeMusicHallCard(card, shelf)} className="group relative aspect-[2.25/1] w-full overflow-hidden rounded-lg bg-white/[0.05] text-left disabled:opacity-60"><QQImage src={card.coverUrl} className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.02]" /><span className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" /><span className="absolute inset-x-0 bottom-0 p-5 text-base font-semibold">{card.title}</span></button>)}
                  </HorizontalShelf>
                ) : isSongShelf ? (
                  <HorizontalShelf ariaLabel={`${shelf.title}歌曲`} edgeControls="hover" className="-mx-5" itemClassName="w-[min(82vw,28rem)] md:w-[27rem]">
                    {groupIntoRows(shelf.cards).map((column, columnIndex) => <div key={`${shelf.id}-${columnIndex}`} className="grid h-[216px] grid-rows-3">{column.map(card => <button key={card.id} type="button" disabled={card.action.type === 'unsupported'} onClick={() => void executeMusicHallCard(card, shelf)} className="group flex min-w-0 items-center gap-3 border-b border-white/[0.055] py-2.5 text-left"><QQImage src={card.coverUrl} className="h-14 w-14 shrink-0 rounded-md object-cover" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{card.title}</span><span className="mt-1 block truncate text-xs text-white/38">{card.subtitle}</span></span><Play className="h-4 w-4 shrink-0 text-white/25 group-hover:text-white" /></button>)}</div>)}
                  </HorizontalShelf>
                ) : (
                  <HorizontalShelf ariaLabel={`${shelf.title}内容`} edgeControls="hover" className="-mx-5" itemClassName="w-[min(82vw,28rem)] max-w-[220px]">
                    {shelf.cards.map(card => <button key={`${card.id}-${card.title}`} type="button" disabled={card.action.type === 'unsupported'} onClick={() => void executeMusicHallCard(card, shelf)} className="group w-full text-left disabled:opacity-45"><span className="relative block aspect-square overflow-hidden rounded-lg bg-white/[0.05]"><QQImage src={card.coverUrl} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />{card.action.type !== 'unsupported' && <span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-white text-black opacity-0 transition group-hover:opacity-100"><Play className="h-3.5 w-3.5 fill-current" /></span>}</span><span className="mt-2 block line-clamp-2 text-sm font-medium">{card.title}</span>{card.subtitle && <span className="mt-1 block truncate text-xs text-white/38">{card.subtitle}</span>}</button>)}
                  </HorizontalShelf>
                )}
              </section>
            )
          })}
        </div>
      )}

      {publicContent && (
        <div className="space-y-12 border-t border-white/[0.08] pt-10" aria-label="QQ 音乐公共内容">
          {skillPlaylists.length > 0 && (
            <section><div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Sparkles className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">AI 推荐歌单</h3><span className="text-xs text-white/35">QQ Music Skills</span></div><button type="button" onClick={onOpenPlaylists} className="text-sm text-white/45 hover:text-white">查看全部</button></div><div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{skillPlaylists.slice(0, 10).map(playlist => <button key={playlist.id} type="button" onClick={() => onOpenPlaylist(playlist)} className="group min-w-0 text-left"><span className="block aspect-square overflow-hidden rounded-lg bg-white/[0.05]"><QQImage src={playlist.coverUrl} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" /></span><span className="mt-2 block line-clamp-2 text-sm font-medium">{playlist.name}</span><span className="mt-1 block text-xs" style={{ color: accent }}>AI 推荐</span></button>)}</div></section>
          )}
          {communityPlaylists.length > 0 && (
            <section><div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Headphones className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">推荐歌单</h3></div><button type="button" onClick={onOpenPlaylists} className="text-sm text-white/45 hover:text-white">查看全部</button></div><div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">{communityPlaylists.slice(0, 12).map(playlist => <button key={playlist.id} type="button" onClick={() => onOpenPlaylist(playlist)} className="group min-w-0 text-left"><span className="block aspect-square overflow-hidden rounded-lg bg-white/[0.05]"><img src={playlist.coverUrl} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" /></span><span className="mt-2 block line-clamp-2 text-sm font-medium">{playlist.name}</span><span className="mt-1 block text-xs text-white/35">{playlist.creator || 'QQ 音乐'}</span></button>)}</div></section>
          )}
          {publicContent.charts.length > 0 && (
            <section><div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Trophy className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">排行榜</h3></div><button type="button" onClick={onOpenCharts} className="text-sm text-white/45 hover:text-white">查看全部</button></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{publicContent.charts.slice(0, 6).map(chart => <button key={chart.id} type="button" onClick={() => onOpenChart(chart)} className="group flex min-h-36 overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.04] text-left"><img src={chart.coverUrl} alt="" className="aspect-square w-36 shrink-0 object-cover" /><span className="min-w-0 flex-1 p-4"><span className="block truncate font-semibold">{chart.name}</span><span className="mt-2 block space-y-1">{chart.songs.slice(0, 3).map((song, index) => <span key={`${song.mid || song.id}-${index}`} className="block truncate text-xs text-white/45">{index + 1}. {song.name} · {song.artist}</span>)}</span></span></button>)}</div></section>
          )}
          {publicContent.newSongs.length > 0 && (
            <section><div className="mb-4 flex items-center gap-2"><Disc3 className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">新歌推荐</h3></div><div className="grid gap-x-7 md:grid-cols-2 xl:grid-cols-3">{publicContent.newSongs.slice(0, 18).map(song => <button key={`${song.mid || song.id}-${song.name}`} type="button" onClick={() => onPlaySongs(song, publicContent.newSongs)} className="group flex min-w-0 items-center gap-3 border-b border-white/[0.055] py-3 text-left"><img src={song.album.picUrl} alt="" className="h-14 w-14 rounded-md object-cover" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{song.name}</span><span className="mt-1 block truncate text-xs text-white/38">{song.artists.map(artist => artist.name).join(' / ')}</span></span><Play className="h-4 w-4 text-white/25 transition group-hover:text-white" /></button>)}</div></section>
          )}
          {publicContent.channels.length > 0 && (
            <section><div className="mb-4 flex items-center gap-2"><Radio className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">电台频道</h3></div><div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">{publicContent.channels.slice(0, 12).map(channel => <button key={channel.id} type="button" onClick={() => onOpenChannel(channel)} className="group relative aspect-square overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.035] text-left"><img src={channel.coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105" /><span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" /><span className="absolute inset-x-0 bottom-0 p-3"><span className="block line-clamp-2 text-sm font-medium">{channel.name}</span><span className="mt-1 block truncate text-xs text-white/45">{channel.group}</span></span></button>)}</div></section>
          )}
        </div>
      )}

      {feedbackCard && (
        <div className="fixed inset-0 z-[270] flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="调整推荐" onMouseDown={event => { if (event.target === event.currentTarget && !feedbackLoading) setFeedbackCard(null) }}>
          <div className="w-full max-w-md rounded-lg border border-white/[0.1] bg-[#111418] p-6 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><h3 className="text-lg font-semibold">调整推荐</h3><p className="mt-1 line-clamp-2 text-sm text-white/45">{feedbackCard.title}</p></div><button type="button" disabled={feedbackLoading} onClick={() => setFeedbackCard(null)} className="flex h-8 w-8 items-center justify-center rounded-md text-white/45 hover:bg-white/[0.07] hover:text-white" aria-label="关闭推荐反馈"><X className="h-4 w-4" /></button></div><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" disabled={feedbackLoading} onClick={() => { setFeedbackCard(null); void openPreferences() }} className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-left text-sm hover:bg-white/[0.08]"><SlidersHorizontal className="h-4 w-4" />调节听歌偏好</button><button type="button" disabled={feedbackLoading || !feedbackModule || !feedbackCard.canRequestSimilar || !feedbackCard.appendToken} onClick={() => { if (feedbackModule && feedbackCard) void replaceWithSimilar(feedbackModule, feedbackCard); setFeedbackCard(null) }} className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-left text-sm hover:bg-white/[0.08] disabled:opacity-40"><RefreshCw className="h-4 w-4" />更多相似歌曲</button></div>{feedbackLoading && feedbackOptions.length === 0 ? <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : feedbackError ? <p className="mt-5 rounded-lg bg-rose-300/[0.08] p-3 text-sm text-rose-100/80">{feedbackError}</p> : feedbackOptions.length > 0 ? <div className="mt-5 grid gap-2">{feedbackOptions.map(option => <button key={option.token} type="button" disabled={feedbackLoading} onClick={() => void submitFeedback(option)} className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-left text-sm hover:bg-white/[0.08] disabled:opacity-45">{option.title}</button>)}</div> : <p className="mt-5 text-sm text-white/45">QQ 音乐未提供可选反馈原因。</p>}</div>
        </div>
      )}

      {preferencesOpen && (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="自定义推荐偏好" onMouseDown={event => { if (event.target === event.currentTarget && !preferencesLoading) setPreferencesOpen(false) }}>
          <div className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-lg border border-white/[0.1] bg-[#111418] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5"><div><h3 className="text-xl font-semibold">自定义推荐</h3><p className="mt-1 text-xs text-white/42">偏好会同步到当前 QQ 音乐账号</p></div><button type="button" disabled={preferencesLoading} onClick={() => setPreferencesOpen(false)} className="h-9 px-3 text-sm text-white/48 hover:text-white">取消</button></div>
            <div className="max-h-[58vh] overflow-y-auto p-6">
              {preferencesLoading && preferences.length === 0 ? <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : preferencesError ? <p className="rounded-lg bg-rose-300/[0.08] p-4 text-sm text-rose-100/80">{preferencesError}</p> : <div className="grid gap-3 sm:grid-cols-2">{preferences.map(item => <label key={item.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.035] p-3"><img src={item.coverUrl} alt="" loading="lazy" decoding="async" draggable={false} className="h-12 w-12 rounded-md object-cover" /><span className="min-w-0 flex-1 truncate text-sm">{item.title}</span><input type="checkbox" checked={item.selected} onChange={event => setPreferences(current => current.map(value => value.id === item.id ? { ...value, selected: event.target.checked } : value))} className="h-4 w-4 accent-emerald-400" /></label>)}</div>}
            </div>
            <div className="flex justify-end border-t border-white/[0.08] px-6 py-4"><button type="button" disabled={preferencesLoading || preferences.length === 0} onClick={() => void savePreferences()} className="flex h-10 items-center gap-2 rounded-full px-5 text-sm font-semibold text-[#061018] disabled:opacity-45" style={{ background: accent }}>{preferencesLoading && <Loader2 className="h-4 w-4 animate-spin" />}保存到 QQ 音乐</button></div>
          </div>
        </div>
      )}

      {playingMV && <VideoPlayer mvId={playingMV.id} mvName={playingMV.name} platform="qq" onClose={() => setPlayingMV(null)} />}

      <QQMusicJourney
        configured={officialEnhanced}
        cookie={getExploreCookie('qq')}
        accent={accent}
        showDescription={showDescription}
        onConfiguredChange={onConfiguredChange}
        onOpenPlaylists={onOpenPlaylists}
        onOpenCharts={onOpenCharts}
      />
    </div>
  )
}
