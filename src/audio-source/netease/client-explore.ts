/**
 * 探索模式聚合：网易云首页多源并行聚合（歌单/榜单/电台/新歌/日推/FM）
 * 与无限推荐下一批。单项失败不阻塞整体（allSettled 语义）。
 */
import { getDjProgramToplist, getDjRecommend, getPersonalizedDjRadios } from './client-catalog'
import {
  getNewSongs,
  getPersonalFmBatched,
  getPersonalizedNewSongs,
  getPersonalizedPlaylists,
  getPlaylistTracks,
  getRecommendPlaylists,
  getRecommendSongs,
} from './client-core'
import { callEapi, type CallOptions } from './request'
import { asArray, asNumber, asRecord, asString, type PlaylistSummary, type RawBody, type Track } from './types'

export interface ExploreChannel {
  id: string
  name: string
  group: string
  coverUrl?: string
  playCount?: number
}

export interface ExploreChart {
  id: string
  name: string
  group: string
  description?: string
  coverUrl?: string
  updateText?: string
  preview: { name: string; artist: string; rank: number }[]
}

export interface ExploreResult {
  dailySongs: Track[]
  radioSongs: Track[]
  newSongs: Track[]
  playlists: PlaylistSummary[]
  charts: ExploreChart[]
  channels: ExploreChannel[]
}

function normalizeSong(value: unknown): Track | null {
  const record = asRecord(value)
  const song = asRecord(record.song ?? record.mainSong ?? record)
  if (!asNumber(song.id)) return null
  return {
    id: asNumber(song.id),
    name: asString(song.name),
    artists: asArray(song.ar ?? song.artists).map((item) => {
      const artist = asRecord(item)
      return { id: asNumber(artist.id), name: asString(artist.name) }
    }),
    album: {
      id: asNumber(asRecord(song.al ?? song.album).id),
      name: asString(asRecord(song.al ?? song.album).name),
      picUrl: asString(asRecord(song.al ?? song.album).picUrl) || asString(record.picUrl) || undefined,
    },
    durationMs: asNumber(song.dt ?? song.duration),
    fee: asNumber(song.fee),
    mvId: typeof song.mv === 'number' ? song.mv : undefined,
  }
}

function stripMarkup(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim()
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback
}

/** 探索页聚合 */
export async function getExploreNetease(options: CallOptions = {}): Promise<ExploreResult> {
  const hasLogin = Boolean(options.cookie)
  const results = await Promise.allSettled([
    getPersonalizedPlaylists({ limit: 30 }, options),
    getPersonalizedNewSongs({ limit: 30 }, options),
    getNewSongs({ areaId: 0 }, options),
    callEapi<RawBody>('/api/toplist/detail', {}, options),
    getPersonalizedDjRadios(options),
    getDjRecommend(options),
    getDjProgramToplist({ limit: 30 }, options),
    hasLogin ? getRecommendSongs(options) : Promise.resolve<RawBody | null>(null),
    hasLogin ? getPersonalFmBatched(30, 8, options) : Promise.resolve<Track[] | null>(null),
    hasLogin ? getRecommendPlaylists(options) : Promise.resolve<RawBody[] | null>(null),
  ])
  const [
    personalizedResult,
    freshSongsResult,
    newAreaSongsResult,
    toplistResult,
    djChannelsResult,
    djRecommendResult,
    djToplistResult,
    dailyResult,
    fmResult,
    resourceResult,
  ] = results

  // 歌单：官方推荐 + 个性化，去重取 30
  const playlistById = new Map<number, PlaylistSummary>()
  const toSummary = (item: RawBody): PlaylistSummary => ({
    id: asNumber(item.id),
    name: asString(item.name, '网易云歌单'),
    coverUrl: asString(item.picUrl) || asString(item.coverImgUrl) || undefined,
    description: stripMarkup(asString(item.copywriter) || asString(item.description)) || undefined,
    trackCount: asNumber(item.trackCount),
    playCount: asNumber(item.playcount ?? item.playCount) || undefined,
    ownerId: asNumber(asRecord(item.creator).userId),
    ownerName: asString(asRecord(item.creator).nickname) || undefined,
  })
  const officialPlaylists = settledValue(resourceResult, [] as RawBody[] | null) ?? []
  const communityPlaylists = settledValue(personalizedResult, [] as RawBody[])
  for (const item of [...officialPlaylists, ...communityPlaylists]) {
    const summary = toSummary(item)
    if (summary.id > 0 && !playlistById.has(summary.id)) playlistById.set(summary.id, summary)
  }

  // 榜单：官方榜/特色榜 + 每榜 3 首预览
  const toplistBody = settledValue(toplistResult, {} as RawBody)
  const charts: ExploreChart[] = asArray(toplistBody.list)
    .slice(0, 30)
    .map((item, index) => {
      const chart = asRecord(item)
      return {
        id: String(asNumber(chart.id, index)),
        name: asString(chart.name, '网易云榜单'),
        group: asString(chart.ToplistType) ? '官方榜' : '特色榜',
        description: stripMarkup(asString(chart.description)) || undefined,
        coverUrl: asString(chart.coverImgUrl) || undefined,
        updateText: asString(chart.updateFrequency) || undefined,
        preview: asArray(chart.tracks)
          .slice(0, 3)
          .map((entry, rank) => {
            const track = asRecord(entry)
            return {
              name: asString(track.first ?? track.name, '未知歌曲'),
              artist: asString(track.second ?? track.artist, '未知歌手'),
              rank: rank + 1,
            }
          }),
      }
    })

  // 电台频道：推荐 + 个性化 + 节目榜
  const channelById = new Map<string, ExploreChannel>()
  const channelItems: unknown[] = [
    ...settledValue(djChannelsResult, [] as RawBody[]),
    ...settledValue(djRecommendResult, [] as RawBody[]),
    ...settledValue(djToplistResult, [] as RawBody[]),
  ]
  for (const item of channelItems) {
    const record = asRecord(item)
    const program = asRecord(record.program ?? record)
    const radio = asRecord(program.radio ?? record)
    const id = String(asNumber(radio.id ?? program.radioId ?? record.id))
    if (id === '0' || channelById.has(id)) continue
    channelById.set(id, {
      id,
      name: asString(radio.name ?? record.name ?? program.name, '声音节目'),
      group: asString(radio.category ?? program.category, '播客'),
      coverUrl: asString(radio.picUrl) || asString(record.picUrl) || asString(program.coverUrl) || undefined,
      playCount: asNumber(radio.subCount ?? program.listenerCount) || undefined,
    })
  }

  // 歌曲：日推（登录）/ FM（登录）/ 新歌 + 新歌速递去重
  const dailyBody = asRecord(settledValue(dailyResult, null as RawBody | null) ?? {})
  const dailySongs = asArray(dailyBody.data !== undefined ? asRecord(dailyBody.data).dailySongs : dailyBody.recommend)
    .map(normalizeSong)
    .filter((song): song is Track => song !== null)
    .slice(0, 30)
  const radioSongs = (settledValue(fmResult, [] as Track[] | null) ?? []).slice(0, 30)
  const newSongPool = [...settledValue(freshSongsResult, [] as Track[]), ...settledValue(newAreaSongsResult, [] as Track[])]
  const seenIds = new Set<number>()
  const newSongs = newSongPool.filter((song) => {
    if (seenIds.has(song.id)) return false
    seenIds.add(song.id)
    return true
  }).slice(0, 50)

  return {
    dailySongs,
    radioSongs,
    newSongs,
    playlists: [...playlistById.values()].slice(0, 30),
    charts,
    channels: [...channelById.values()],
  }
}

export interface ExploreNextResult {
  songs: Track[]
  batch: number
  hasMore: true
}

const EXPLORE_AREA_IDS = [0, 7, 96, 8, 16]

/** 无限推荐下一批（批次轮换地区；FM/日推登录可用，歌单曲目补池） */
export async function getExploreNext(
  { count = 30, batch = 1, exclude = [] }: { count?: number; batch?: number; exclude?: number[] } = {},
  options: CallOptions = {},
): Promise<ExploreNextResult> {
  const clampedCount = Math.max(10, Math.min(count, 60))
  const areaType = EXPLORE_AREA_IDS[(batch - 1) % EXPLORE_AREA_IDS.length] ?? 0

  const results = await Promise.allSettled([
    options.cookie ? getPersonalFmBatched(clampedCount, 6, options) : Promise.resolve<Track[] | null>(null),
    options.cookie ? getRecommendSongs(options) : Promise.resolve<RawBody | null>(null),
    getPersonalizedNewSongs({ limit: 100 }, options),
    getNewSongs({ areaId: areaType }, options),
    getPersonalizedPlaylists({ limit: 30 }, options),
  ])
  const [fmResult, dailyResult, freshSongsResult, areaSongsResult, personalizedResult] = results

  // 旋转取 4 个个性化歌单，每单拉 80 首补池
  const playlistPool = settledValue(personalizedResult, [] as RawBody[])
  const rotated = playlistPool.length > 0 ? [...playlistPool.slice((batch * 3) % playlistPool.length), ...playlistPool].slice(0, 4) : []
  const playlistTracks: Track[] = []
  for (const playlist of rotated) {
    try {
      playlistTracks.push(...(await getPlaylistTracks(asNumber(playlist.id), { limit: 80 }, options)))
    } catch {
      /* 单歌单失败跳过 */
    }
  }

  const dailyBody = asRecord(settledValue(dailyResult, null as RawBody | null) ?? {})
  const candidates: unknown[] = [
    ...((settledValue(fmResult, [] as Track[] | null) ?? []).map((track) => ({ id: track.id }))),
    ...asArray(dailyBody.data !== undefined ? asRecord(dailyBody.data).dailySongs : dailyBody.recommend),
    ...settledValue(freshSongsResult, [] as Track[]),
    ...settledValue(areaSongsResult, [] as Track[]),
    ...playlistTracks,
  ]

  const songs: Track[] = []
  const seen = new Set(exclude)
  for (const candidate of candidates) {
    const song = normalizeSong(candidate)
    if (!song || seen.has(song.id)) continue
    seen.add(song.id)
    songs.push(song)
    if (songs.length >= clampedCount) break
  }
  return { songs, batch, hasMore: true }
}
