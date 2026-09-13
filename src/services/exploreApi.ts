import type { MusicPlatform } from './platforms'
import { getPlatformCookie } from './platforms'
import { getApiBase } from './apiConfig'
import type { Song } from './musicApi'
import { getQQMusicSkillHeaders } from './qqMusicSkills'

const API_BASES = [getApiBase()]
const EXPLORE_MEMORY_CACHE_TTL = 9 * 60 * 1000

const exploreHomeMemoryCache = new Map<string, { payload: ExplorePayload; expiresAt: number }>()
const exploreHomePending = new Map<string, Promise<ExplorePayload>>()
// 任一平台登录态变化 → 失效探索页内存缓存，个性化数据立即可见
if (typeof window !== 'undefined') {
  window.addEventListener('hyperplayer-auth-changed', () => { exploreHomeMemoryCache.clear() })
}

export type ExplorePlatform = MusicPlatform

function fingerprintExploreValue(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function getExploreHomeCacheKey(platform: ExplorePlatform): string {
  const userIdKey = platform === 'qq' ? 'qq_user_id' : platform === 'netease' ? 'netease_user_id' : `${platform}_user_id`
  const userId = localStorage.getItem(userIdKey) || ''
  const cookie = getExploreCookie(platform)
  const accountKey = userId ? `user:${userId}` : cookie ? `cookie:${fingerprintExploreValue(cookie)}` : 'guest'
  return `${platform}:${accountKey}`
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export interface ExplorePlaylist {
  id: string
  name: string
  description?: string
  coverUrl: string
  playCount?: number
  trackCount?: number
  creator?: string
  /** 歌单仅来自网易云/QQ */
  platform: MusicPlatform
  source?: 'personalized' | 'community' | 'qqmusic-skills' | string
}

export interface ExploreChartSong {
  id?: number
  /** 平台歌曲标识（QQ mid 等），用于直接播放 */
  mid?: string
  name: string
  artist: string
  coverUrl?: string
  rank?: number
}

export interface ExploreChart {
  id: string
  name: string
  group: string
  description?: string
  coverUrl: string
  playCount?: number
  updateText?: string
  platform: ExplorePlatform
  source?: 'community' | 'qqmusic-skills' | string
  songs: ExploreChartSong[]
}

export interface ExploreAlbum {
  id: number
  mid?: string
  name: string
  artist: string
  coverUrl: string
  publishTime?: number | string
  platform: ExplorePlatform
}

export interface ExploreChannel {
  id: string
  name: string
  group: string
  description?: string
  coverUrl: string
  playCount?: number
  platform: ExplorePlatform
  song?: Song | null
}

export interface QQNativeExploreCard {
  id: string
  type: number
  subtype: number
  style: number
  title: string
  subtitle?: string
  coverUrl?: string
  reason?: string
  songs: Song[]
  playlist?: ExplorePlaylist | null
}

export interface QQNativeExploreModule {
  id: string
  title: string
  style: number
  personalized: true
  source: 'qq-native-recommend-feed'
  cards: QQNativeExploreCard[]
}

export interface QQNativeExploreFeed {
  accountScoped: true
  generatedAt: number
  loadMark: number
  hasMore: boolean
  cursor: { page: number; shelfCount: number }
  daily30?: {
    playlistId: string
    title: string
    coverUrl?: string
    dateKey: string
    songs: Song[]
  } | null
  modules: QQNativeExploreModule[]
}

export interface ExplorePayload {
  code: number
  platform: ExplorePlatform
  officialEnhanced: boolean
  personalized: boolean
  dailySongs: Song[]
  radioSongs: Song[]
  newSongs: Song[]
  playlists: ExplorePlaylist[]
  charts: ExploreChart[]
  albums: ExploreAlbum[]
  channels: ExploreChannel[]
  qqNative?: QQNativeExploreFeed | null
  meta: {
    source: string
    recommendationSource?: 'qq-guess-you-like' | 'qqmusic-skills-radio' | 'qq-daily' | 'public' | string
    updatedAt: number
  }
}

export interface ExploreDetail {
  playlist: {
    id: string
    name: string
    coverImgUrl: string
    trackCount: number
    description?: string
    /** 歌单被播放次数（QQ listennum / 网易云 playCount） */
    playCount?: number
    /** 创建者（后端归一化对象） */
    creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
    tags?: string[]
    isLike?: boolean
    createTime?: number
    platform: MusicPlatform
  }
  songs: Song[]
}

const ensureOk = async (response: Response) => {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error(`探索服务返回了无效响应 (${response.status})`)
  }
  const data = await response.json()
  if (!response.ok || (data.code && Number(data.code) >= 400)) {
    throw new Error(data.error || data.message || `请求失败 (${response.status})`)
  }
  return data
}

const fetchExploreJson = async (
  path: string,
  params: Record<string, string | undefined>,
  signal?: AbortSignal
) => {
  let lastError: unknown
  for (const base of API_BASES) {
    const url = new URL(`${base}${path}`)
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
    })
    try {
      const headers = path.includes('/qq') || params.platform === 'qq'
        ? await getQQMusicSkillHeaders()
        : undefined
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 20_000)
      const abortFromCaller = () => controller.abort()
      signal?.addEventListener('abort', abortFromCaller, { once: true })
      try {
        return await ensureOk(await fetch(url.toString(), { signal: controller.signal, headers, cache: 'no-store' }))
      } finally {
        window.clearTimeout(timeoutId)
        signal?.removeEventListener('abort', abortFromCaller)
      }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('探索服务暂时不可用')
}

const normalizeNeteaseSong = (input: any): Song | null => {
  const track = input?.song || input || {}
  const album = track.al || track.album || {}
  const artists = track.ar || track.artists || []
  const id = Number(track.id || 0)
  if (!id || !track.name) return null

  return {
    id,
    name: track.name,
    artists: (artists.length ? artists : [{ name: '未知歌手' }]).map((artist: any) => ({
      id: Number(artist.id) || undefined,
      name: artist.name || '未知歌手'
    })),
    album: {
      id: Number(album.id) || undefined,
      name: album.name || '',
      picUrl: album.picUrl || album.blurPicUrl || input?.picUrl || ''
    },
    duration: Number(track.dt || track.duration || 0),
    platform: 'netease',
    vip: Number(track.fee) === 1,
    fee: Number(track.fee) || 0,
    noCopyright: Number(track.privilege?.st) < 0
  }
}

const normalizeQQSong = (input: any): Song | null => {
  const track = input?.songInfo || input?.song || input || {}
  const mid = String(track.mid || track.songmid || track.songMid || '').trim()
  const id = Number(track.id || track.songid || track.songId || 0)
  const album = track.album || track.albumInfo || {}
  const albumMid = album.mid || album.pmid || album.albumMid || album.albumMID ||
    track.albummid || track.albumMid || track.albumMID || track.album_mid || ''
  const rawArtists = track.singer || track.singers || track.artists || []
  const name = track.name || track.title || track.songname || track.songName || ''
  if (!name || (!mid && !id)) return null

  const coverUrl = track.cover || track.picUrl || track.picurl || track.albumpic || track.albumPic ||
    track.albumCover || album.picUrl || album.picurl || album.cover || album.coverUrl || (
    albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${String(albumMid).replace(/_\d+$/, '')}.jpg` : ''
  )

  return {
    id,
    mid: mid || undefined,
    name,
    artists: (rawArtists.length ? rawArtists : [{ name: track.singerName || '未知歌手' }]).map((artist: any) => ({
      id: Number(artist.id || artist.singerid) || undefined,
      mid: artist.mid || artist.singermid || artist.singerMid || undefined,
      name: artist.name || artist.title || artist.singerName || '未知歌手'
    })),
    album: {
      id: Number(album.id || track.albumid) || undefined,
      mid: albumMid || undefined,
      pmid: album.pmid || undefined,
      name: album.name || album.title || track.albumname || '',
      picUrl: coverUrl
    },
    duration: Number(track.interval || 0) * 1000 || Number(track.duration || 0),
    platform: 'qq',
    vip: Boolean(track.pay?.pay_play || track.pay?.paydownload || track.isonly === 1)
  }
}

export function getExploreCookie(platform: ExplorePlatform): string {
  return getPlatformCookie(platform)
}

async function syncQQExploreCookie(cookie: string, signal?: AbortSignal): Promise<void> {
  if (!cookie) return
  await fetch(`${API_BASES[0]}/qq/user/setCookie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: cookie }),
    signal,
    cache: 'no-store'
  }).catch(error => {
    if ((error as Error).name === 'AbortError') throw error
  })
}

export async function fetchExploreHome(
  platform: ExplorePlatform,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; enhanced?: boolean } = {}
): Promise<ExplorePayload> {
  const cacheKey = getExploreHomeCacheKey(platform)
  if (!options.forceRefresh) {
    const cached = exploreHomeMemoryCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.payload
    const pending = exploreHomePending.get(cacheKey)
    if (pending) return awaitWithSignal(pending, signal)
  }

  const request = (async () => {
  // enhanced=false：关闭平台增强（不传 cookie，后端只返回公开榜单/热门，不请求个性化推荐）
  const cookie = options.enhanced === false ? '' : getExploreCookie(platform)
  if (platform === 'qq') {
    await syncQQExploreCookie(cookie)
  }
  let data = await fetchExploreJson(`/explore/${platform}`, { cookie })
  if (
    platform === 'qq' &&
    cookie &&
    data?.personalized !== true &&
    data?.meta?.recommendationSource === 'public'
  ) {
    await syncQQExploreCookie(cookie)
    data = await fetchExploreJson(`/explore/${platform}`, { cookie, personalized: '1' })
  }
  const normalizedPayload = {
    ...data,
    dailySongs: Array.isArray(data.dailySongs) ? data.dailySongs : [],
    radioSongs: Array.isArray(data.radioSongs) ? data.radioSongs : [],
    newSongs: Array.isArray(data.newSongs) ? data.newSongs : [],
    playlists: Array.isArray(data.playlists) ? data.playlists : [],
    charts: Array.isArray(data.charts) ? data.charts : [],
    albums: Array.isArray(data.albums) ? data.albums : [],
    channels: Array.isArray(data.channels) ? data.channels : [],
    qqNative: data.qqNative && Array.isArray(data.qqNative.modules) ? data.qqNative : null
  } as ExplorePayload
  exploreHomeMemoryCache.set(cacheKey, {
    payload: normalizedPayload,
    expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL
  })
  return normalizedPayload
  })()

  if (!options.forceRefresh) {
    exploreHomePending.set(cacheKey, request)
    const cleanup = () => {
      if (exploreHomePending.get(cacheKey) === request) exploreHomePending.delete(cacheKey)
    }
    void request.then(cleanup, cleanup)
  }
  return awaitWithSignal(request, signal)
}

export function prefetchExploreHome(platform: ExplorePlatform): Promise<ExplorePayload> {
  return fetchExploreHome(platform)
}

export async function fetchQQNativeFeedPage(
  cursor: { page: number; shelfCount: number },
  seen: { shelfIds?: string[]; feedKeys?: string[] } = {},
  signal?: AbortSignal
): Promise<Pick<QQNativeExploreFeed, 'modules' | 'hasMore' | 'loadMark' | 'cursor'>> {
  const cookie = getExploreCookie('qq')
  if (!cookie) throw new Error('需要登录 QQ 音乐')
  await syncQQExploreCookie(cookie, signal)
  const headers = { 'Content-Type': 'application/json', ...(await getQQMusicSkillHeaders()) }
  const response = await fetch(`${API_BASES[0]}/explore/qq/native/feed`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      page: cursor.page,
      direction: cursor.page > 1 ? 1 : 0,
      shelfCount: cursor.shelfCount,
      shelfIds: (seen.shelfIds || []).slice(-200),
      feedKeys: (seen.feedKeys || []).slice(-100)
    }),
    signal,
    cache: 'no-store'
  })
  const data = await ensureOk(response)
  return {
    modules: Array.isArray(data.modules) ? data.modules : [],
    hasMore: data.hasMore === true,
    loadMark: Number(data.loadMark ?? -1),
    cursor: data.cursor || { page: cursor.page + 1, shelfCount: cursor.shelfCount }
  }
}

export async function fetchQQGuessYouLikeBatch(
  batch: number,
  excludeSongKeys: string[] = [],
  signal?: AbortSignal
): Promise<Song[]> {
  const cookie = getExploreCookie('qq')
  if (cookie) await syncQQExploreCookie(cookie, signal)
  const data = await fetchExploreJson('/explore/qq/radio/next', {
    cookie,
    batch: String(Math.max(1, Math.floor(batch))),
    count: '30',
    exclude: excludeSongKeys.slice(-300).join(',') || undefined
  }, signal)
  const songs = Array.isArray(data.songs) ? data.songs : []
  return songs
    .map((song: any) => normalizeQQSong(song))
    .filter((song: Song | null): song is Song => Boolean(song))
}

export async function fetchExploreRecommendationBatch(
  platform: ExplorePlatform,
  batch: number,
  excludeSongKeys: string[] = [],
  signal?: AbortSignal
): Promise<Song[]> {
  const cookie = getExploreCookie(platform)
  if (platform === 'qq') {
    return fetchQQGuessYouLikeBatch(batch, excludeSongKeys, signal)
  }

  const data = await fetchExploreJson('/explore/netease/recommendations/next', {
    cookie,
    batch: String(Math.max(1, Math.floor(batch))),
    count: '30',
    exclude: excludeSongKeys.slice(-300).join(',') || undefined
  }, signal)
  const songs = Array.isArray(data.songs) ? data.songs : []
  return songs
    .map((song: any) => normalizeNeteaseSong(song))
    .filter((song: Song | null): song is Song => Boolean(song))
}

export async function fetchExplorePlaylist(playlist: ExplorePlaylist, signal?: AbortSignal): Promise<ExploreDetail> {
  const cookie = getExploreCookie(playlist.platform)
  const data = await fetchExploreJson(`/${playlist.platform}/playlist/detail`, {
    id: playlist.id,
    songNum: playlist.platform === 'qq' ? '10000' : undefined,
    limit: playlist.platform === 'netease' ? '10000' : undefined,
    source: playlist.source,
    cookie
  }, signal)
  const rawSongs = playlist.platform === 'qq'
    ? data.songlist || data.playlist?.tracks || []
    : data.playlist?.tracks || data.songs || []
  const songs = rawSongs
    .map((song: any) => playlist.platform === 'qq' ? normalizeQQSong(song) : normalizeNeteaseSong(song))
    .filter((song: Song | null): song is Song => Boolean(song))

  return {
      playlist: {
        ...playlist,
        creator: data.playlist?.creator || (typeof playlist.creator === 'string' ? { nickname: playlist.creator } : playlist.creator),
        id: playlist.id,
        name: data.playlist?.name || playlist.name,
      coverImgUrl: data.playlist?.coverImgUrl || playlist.coverUrl,
      trackCount: Number(data.playlist?.trackCount || songs.length || playlist.trackCount || 0),
      description: data.playlist?.description || playlist.description || '',
      // 元数据透传：播放次数/创建者/标签（后端歌单详情已归一化；用于传统模式歌单页角标与创建者展示）
      playCount: Number(data.playlist?.playCount || playlist.playCount || 0),
      tags: Array.isArray(data.playlist?.tags) ? data.playlist.tags : [],
      isLike: Boolean((playlist as any).isLike),
      createTime: Number(data.playlist?.createTime || 0) || undefined,
      platform: playlist.platform
    },
    songs
  }
}

export async function fetchExploreChart(chart: ExploreChart, signal?: AbortSignal): Promise<ExploreDetail> {
  const cookie = getExploreCookie(chart.platform)
  let lastResult: ExploreDetail | null = null
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await fetchExploreJson('/explore/chart', {
        platform: chart.platform,
        id: chart.id,
        name: chart.name,
        coverUrl: chart.coverUrl,
        description: chart.description,
        source: chart.source,
        cookie
      }, signal) as ExploreDetail
      lastResult = result
      if (Array.isArray(result.songs) && result.songs.length > 0) return result
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
    if (attempt < 2) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }, 180 * (attempt + 1))
        const abort = () => {
          window.clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
  }
  if (lastResult) return lastResult
  throw lastError instanceof Error ? lastError : new Error(`${chart.name} 暂时没有返回歌曲，请稍后重试`)
}

export async function fetchExploreChannel(channel: ExploreChannel, signal?: AbortSignal): Promise<ExploreDetail> {
  const cookie = getExploreCookie('qq')
  const detail = await fetchExploreJson('/explore/radio', {
    platform: channel.platform,
    id: channel.id,
    name: channel.name,
    coverUrl: channel.coverUrl,
    cookie: getExploreCookie(channel.platform) || cookie
  }, signal)
  if ((!Array.isArray(detail.songs) || detail.songs.length === 0) && channel.song) {
    return {
      ...detail,
      playlist: { ...detail.playlist, trackCount: 1 },
      songs: [channel.song]
    }
  }
  return detail
}
