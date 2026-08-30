/**
 * 核心端点：搜索、歌曲、播放地址（音质阶梯）、歌词、歌单读取、推荐、私人FM。
 * 每个导出函数对应参考项目的一条服务端路由（Cleanroom 重写）。
 */
import { RANK_PLAYLIST_IDS } from './config'
import { callEapi, callWeapi, callXeapi, withRetry, NeteaseApiError, type CallOptions } from './request'
import { parseLrc, parseTtml, parseYrc, type TimedLyrics } from '../lyrics'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  type PlayInfo,
  type PlaylistDetail,
  type PlaylistSummary,
  type QualityLevel,
  type QualityPreference,
  type RawBody,
  type Track,
  type TrackAlbum,
  type TrackArtist,
} from './types'

/* ------------------------------- 通用映射 ------------------------------- */

export function mapArtist(value: unknown): TrackArtist {
  const record = asRecord(value)
  return { id: asNumber(record.id), name: asString(record.name) }
}

export function mapAlbum(value: unknown): TrackAlbum {
  const record = asRecord(value)
  return {
    id: asNumber(record.id),
    name: asString(record.name),
    picUrl: asString(record.picUrl) || (typeof record.pic === 'string' ? asString(record.pic) : undefined),
  }
}

/** 兼容 web api（artists/album/duration）与 v3 detail（ar/al/dt）两种形状 */
export function mapTrack(value: unknown): Track {
  const song = asRecord(value)
  const artists = asArray(song.ar ?? song.artists).map(mapArtist)
  const album = mapAlbum(song.al ?? song.album)
  const fee = asNumber(song.fee)
  const privilege = asRecord(song.privilege)
  return {
    id: asNumber(song.id),
    name: asString(song.name),
    artists,
    album,
    durationMs: asNumber(song.dt ?? song.duration),
    fee,
    mvId: typeof song.mv === 'number' ? song.mv : typeof song.mvid === 'number' ? song.mvid : undefined,
    isVip: fee === 1 || fee === 4,
    noCopyright: (asNumber(privilege.st, 0) < 0 || asNumber(privilege.playMaxbr, 0) === 0) || undefined,
  }
}

function toIdsParam(ids: (number | string)[]): string {
  return `[${ids.map(Number).join(',')}]`
}

/* --------------------------------- 搜索 --------------------------------- */

/** 搜索单曲（/api/search/get），封面补齐前 15 个专辑 + VIP/版权标记 */
export async function searchSongs(
  keywords: string,
  { limit = 30, offset = 0, type = 1 }: { limit?: number; offset?: number; type?: number } = {},
  options: CallOptions = {},
): Promise<Track[]> {
  const body = await withRetry(
    () => callEapi<RawBody>('/api/search/get', { s: keywords, type, limit, offset }, options),
    3,
  )
  const songs = asArray(asRecord(body.result).songs)
  const tracks = songs.map(mapTrack)

  // 专辑封面补齐：仅前 15 个专辑，批 3 个并发，请求间隔 100/200ms（限流友好）
  const albumIds = [...new Set(tracks.map((track) => track.album.id).filter((id) => id > 0))].slice(0, 15)
  const covers = new Map<number, string>()
  for (let i = 0; i < albumIds.length; i += 3) {
    await Promise.all(
      albumIds.slice(i, i + 3).map(async (albumId) => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        try {
          const album = await getAlbumDetail(albumId, options)
          if (album.picUrl) covers.set(albumId, album.picUrl)
        } catch {
          /* 封面缺失不致命 */
        }
      }),
    )
    if (i + 3 < albumIds.length) await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return tracks.map((track) => (covers.has(track.album.id) ? { ...track, album: { ...track.album, picUrl: covers.get(track.album.id) } } : track))
}

/** 搜索建议（mobile 关键词联想 + 歌手卡片） */
export async function searchSuggest(keywords: string, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/search/suggest/keyword', { s: keywords }, options)
}

/** 热搜词 */
export async function searchHot(options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/search/hot', { type: 1111 }, options)
}

/* --------------------------------- 歌曲详情 -------------------------------- */

/** 歌曲详情（批量 ≤1000），附带音质等级与专辑扩展信息 */
export async function getSongDetail(ids: (number | string)[], options: CallOptions = {}): Promise<Track[]> {
  if (ids.length === 0) return []
  const body = await callWeapi<RawBody>('/api/v3/song/detail', { c: `[${ids.map((id) => `{"id":${Number(id)}}`).join(',')}]` }, options)
  return asArray(body.songs).map(mapTrack)
}

/** 歌曲音质等级（Hi-Res/杜比/臻品等可用档位） */
export async function getSongQualityLevels(id: number | string, options: CallOptions = {}): Promise<QualityOptionLite[]> {
  const body = await callEapi<RawBody>('/api/song/music/detail/get', { songId: Number(id) }, options)
  const data = asRecord(body.data)
  const levels: QualityOptionLite[] = []
  const push = (key: string, label: string) => {
    const entry = asRecord(data[key])
    if (Object.keys(entry).length > 0) {
      levels.push({ key, label, bitrate: asNumber(entry.br), sizeBytes: asNumber(entry.size), sampleRate: asNumber(entry.sr) || undefined })
    }
  }
  push('hr', 'Hi-Res 无损')
  push('sq', '无损 FLAC')
  push('db', '杜比全景声')
  push('jm', '臻品母带')
  push('je', '臻品全景声')
  push('h', '高品质')
  push('m', '标准')
  push('l', '普通')
  return levels.sort((a, b) => b.bitrate - a.bitrate)
}

export interface QualityOptionLite {
  key: string
  label: string
  bitrate: number
  sizeBytes: number
  sampleRate?: number
}

/* --------------------------------- 播放地址 -------------------------------- */

/** 音质候选降级序（参考项目验证的策略） */
export function getQualityCandidates(preference: QualityPreference = 'auto', isVip = false): QualityLevel[] {
  if (!isVip) {
    if (preference === 'standard') return ['standard']
    return ['exhigh', 'standard']
  }
  switch (preference) {
    case 'standard':
      return ['standard']
    case 'high':
      return ['exhigh', 'standard']
    case 'very-high':
    case 'lossless':
      return ['lossless', 'exhigh', 'standard']
    case 'hi-res':
      return ['hires', 'lossless', 'exhigh', 'standard']
    case 'auto':
    default:
      return ['jymaster', 'hires', 'lossless', 'exhigh', 'standard']
  }
}

/** 单一等级播放地址（xeapi 通道） */
export async function getSongPlayInfo(id: number | string, level: QualityLevel, options: CallOptions = {}): Promise<PlayInfo> {
  const payload: Record<string, unknown> = { ids: toIdsParam([id]), level, encodeType: 'flac' }
  if (level === 'sky') payload.immerseType = 'c51'
  const body = await callXeapi<RawBody>('/api/song/enhance/player/url/v1', payload, options)
  const item = asRecord(asArray(body.data)[0])
  const url = asString(item.url) || null
  return {
    id: asNumber(item.id, Number(id)),
    url: url && url.length > 0 ? url : null,
    level: (asString(item.level) || level) as QualityLevel,
    bitrate: asNumber(item.br),
    sizeBytes: asNumber(item.size),
    md5: asString(item.md5),
    containerType: asString(item.type),
    fee: asNumber(item.fee),
    freeTrialInfo: (asRecord(item.freeTrialInfo).start !== undefined
      ? { start: asNumber(asRecord(item.freeTrialInfo).start), end: asNumber(asRecord(item.freeTrialInfo).end) }
      : null),
    isPaidContent: false,
  }
}

export interface SongUrlOptions {
  preference?: QualityPreference
  isVip?: boolean
  totalBudgetMs?: number
}

/**
 * 按音质阶梯取播放地址：首候选 2 次、其余 1 次；单次超时 [300,4500]ms；
 * 间隔 150ms；总预算 16s。全失败 → 付费判定（fee 1/4 → url:null），否则抛最后错误。
 */
export async function getSongUrl(
  id: number | string,
  { preference = 'auto', isVip = false, totalBudgetMs = 16_000 }: SongUrlOptions = {},
  options: CallOptions = {},
): Promise<PlayInfo> {
  const candidates = getQualityCandidates(preference, isVip)
  const deadlineAt = Date.now() + totalBudgetMs
  let lastError: unknown = null

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const level = candidates[candidateIndex]!
    const attempts = candidateIndex === 0 ? 2 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 300) break
      try {
        const info = await getSongPlayInfo(id, level, {
          ...options,
          timeoutMs: Math.min(4500, Math.max(300, remainingMs)),
        })
        if (info.url) return info
        lastError = new NeteaseApiError(`等级 ${level} 未返回播放地址`, 0)
        break
      } catch (error) {
        lastError = error
        if (attempt + 1 < attempts && deadlineAt - Date.now() > 500) {
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      }
    }
  }

  try {
    const [detail] = await getSongDetail([Number(id)], options)
    const fee = detail?.fee ?? 0
    if (fee === 1 || fee === 4) {
      return {
        id: Number(id),
        url: null,
        level: 'standard',
        bitrate: 0,
        sizeBytes: 0,
        md5: '',
        containerType: '',
        fee,
        freeTrialInfo: null,
        isPaidContent: true,
      }
    }
  } catch {
    /* 付费判定失败不遮蔽原始错误 */
  }
  throw lastError ?? new NeteaseApiError('获取播放地址失败', 0)
}

/* --------------------------------- 歌词 --------------------------------- */

export interface SongLyrics {
  original: string
  translation: string
  romanization: string
  wordSynced: string
  wordSyncedTranslation: string
  ttml: string
  parsed: TimedLyrics | null
}

const EMPTY_LYRICS: SongLyrics = {
  original: '',
  translation: '',
  romanization: '',
  wordSynced: '',
  wordSyncedTranslation: '',
  ttml: '',
  parsed: null,
}

/** 歌词（新版 v1：含逐字/翻译/罗马音/TTML），5 次指数退避，全失败返回空包 */
export async function getLyric(id: number | string, options: CallOptions = {}): Promise<SongLyrics> {
  let body: RawBody
  try {
    body = await withRetry(
      () =>
        callEapi<RawBody>(
          '/api/song/lyric/v1',
          { id: Number(id), cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
          { ...options, timeoutMs: 10_000 },
        ),
      5,
      300,
    )
  } catch {
    return EMPTY_LYRICS
  }
  const part = (key: string) => asString(asRecord(body[key]).lyric)
  const original = part('lrc')
  const wordSynced = part('yrc')
  let parsed: TimedLyrics | null = parseYrc(wordSynced)
  if (parsed === null) parsed = parseLrc(original)
  if (parsed === null) parsed = parseTtml(part('ttml'))
  return {
    original,
    translation: part('tlyric'),
    romanization: part('romalrc'),
    wordSynced,
    wordSyncedTranslation: part('ytlrc'),
    ttml: part('ttml'),
    parsed,
  }
}

/* --------------------------------- 歌单 --------------------------------- */

export function mapPlaylistSummary(value: unknown): PlaylistSummary {
  const playlist = asRecord(value)
  return {
    id: asNumber(playlist.id),
    name: asString(playlist.name),
    coverUrl: asString(playlist.coverImgUrl) || asString(playlist.picUrl) || undefined,
    trackCount: asNumber(playlist.trackCount ?? asArray(playlist.trackIds).length),
    playCount: asNumber(playlist.playcount ?? playlist.playCount) || undefined,
    ownerId: asNumber(asRecord(playlist.creator).userId ?? playlist.userId),
    ownerName: asString(asRecord(playlist.creator).nickname) || undefined,
    description: asString(playlist.description) || asString(playlist.copywriter) || undefined,
  }
}

/** 歌单详情（trackIds 为准；n=100000 拉全量） */
export async function getPlaylistDetail(id: number | string, options: CallOptions = {}): Promise<PlaylistDetail> {
  const body = await withRetry(() => callEapi<RawBody>('/api/v6/playlist/detail', { id: Number(id), n: 100000, s: 8 }, options), 3)
  const playlist = asRecord(body.playlist)
  return {
    id: asNumber(playlist.id, Number(id)),
    name: asString(playlist.name),
    coverUrl: asString(playlist.coverImgUrl) || undefined,
    trackCount: asNumber(playlist.trackCount),
    playCount: asNumber(playlist.playCount) || undefined,
    ownerId: asNumber(asRecord(playlist.creator).userId ?? playlist.userId),
    ownerName: asString(asRecord(playlist.creator).nickname) || undefined,
    description: asString(playlist.description) || undefined,
    tracks: asArray(playlist.tracks).map(mapTrack),
    trackIds: asArray(playlist.trackIds).map((entry) => asNumber(asRecord(entry).id)).filter((id) => id > 0),
  }
}

/**
 * 分页拉取歌单全部曲目：先 trackIds，再分批 song/detail（每批 500，20 分钟缓存由调用方决定）。
 */
export async function getPlaylistTracks(
  id: number | string,
  { limit = 10000, offset = 0 }: { limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<Track[]> {
  const detail = await getPlaylistDetail(id, options)
  const pageIds = detail.trackIds.slice(offset, offset + limit)
  const tracks: Track[] = []
  for (let i = 0; i < pageIds.length; i += 500) {
    tracks.push(...(await getSongDetail(pageIds.slice(i, i + 500), options)))
  }
  return tracks
}

/* --------------------------------- 推荐/FM -------------------------------- */

/** 每日推荐歌曲（需登录） */
export async function getRecommendSongs(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/v3/discovery/recommend/songs', { afresh: undefined }, { ...options, timeoutMs: options.timeoutMs ?? 12_000 })
}

/** 推荐歌单（登录：官方推荐 + 个性化合并去重） */
export async function getRecommendPlaylists(options: CallOptions = {}): Promise<RawBody[]> {
  const results: RawBody[] = []
  const seen = new Set<number>()
  const [official, personalized] = await Promise.allSettled([
    callWeapi<RawBody>('/api/v1/discovery/recommend/resource', {}, options),
    callWeapi<RawBody>('/api/personalized/playlist', { limit: 30, total: true, n: 1000 }, options),
  ])
  if (official.status === 'fulfilled') {
    for (const item of asArray(official.value.recommend)) {
      const record = asRecord(item)
      const id = asNumber(record.id)
      if (id > 0 && !seen.has(id)) {
        seen.add(id)
        results.push(record)
      }
    }
  }
  if (personalized.status === 'fulfilled') {
    for (const item of asArray(asRecord(personalized.value).result)) {
      const record = asRecord(item)
      const id = asNumber(record.id)
      if (id > 0 && !seen.has(id)) {
        seen.add(id)
        results.push(record)
      }
    }
  }
  return results
}

/** 推荐新歌 */
export async function getPersonalizedNewSongs(
  { limit = 20, areaId = 0 }: { limit?: number; areaId?: number } = {},
  options: CallOptions = {},
): Promise<Track[]> {
  const body = await callWeapi<RawBody>('/api/personalized/newsong', { type: 'recommend', limit, areaId }, options)
  return asArray(body.result).map((item) => mapTrack(asRecord(item).song ?? item))
}

/** 个性化推荐歌单（未登录可用） */
export async function getPersonalizedPlaylists({ limit = 30 }: { limit?: number } = {}, options: CallOptions = {}): Promise<RawBody[]> {
  const body = await callWeapi<RawBody>('/api/personalized/playlist', { limit, total: true, n: 1000 }, options)
  return asArray(body.result).map(asRecord)
}

/** 新歌速递（areaId：0全部 7华语 96欧美 8日本 16韩国） */
export async function getNewSongs({ areaId = 0 }: { areaId?: number } = {}, options: CallOptions = {}): Promise<Track[]> {
  const body = await callWeapi<RawBody>('/api/v1/discovery/new/songs', { areaId, total: true }, options)
  return asArray(body.data).map(mapTrack)
}

/** 官方榜单歌曲（热歌榜/飙升榜，复用歌单详情，3 次重试） */
export async function getRankSongs(kind: 'hot' | 'surge', options: CallOptions = {}): Promise<Track[]> {
  const playlistId = kind === 'surge' ? RANK_PLAYLIST_IDS.surge : RANK_PLAYLIST_IDS.hot
  const detail = await withRetry(() => getPlaylistDetail(playlistId, options), 3, 1000)
  return detail.tracks
}

/** 私人 FM 单批 */
export async function getPersonalFm(options: CallOptions = {}): Promise<Track[]> {
  const body = await callWeapi<RawBody>('/api/v1/radio/get', {}, options)
  return asArray(body.data).map(mapTrack)
}

/** 私人 FM 连续拉取去重（最多 8 批，两轮无增长即止） */
export async function getPersonalFmBatched(targetCount = 21, maxBatches = 8, options: CallOptions = {}): Promise<Track[]> {
  const songs: Track[] = []
  const seen = new Set<number>()
  let noGrowthCount = 0
  for (let batch = 0; batch < maxBatches && songs.length < targetCount; batch += 1) {
    const candidates = await getPersonalFm(options)
    const before = songs.length
    for (const song of candidates) {
      if (seen.has(song.id)) continue
      seen.add(song.id)
      songs.push(song)
      if (songs.length >= targetCount) break
    }
    noGrowthCount = songs.length === before ? noGrowthCount + 1 : 0
    if (candidates.length === 0 || noGrowthCount >= 2) break
    if (batch < maxBatches - 1 && songs.length < targetCount) {
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
  }
  return songs
}

/** 私人 FM 垃圾桶 */
export async function trashFmSong(id: number | string, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/radio/trash/add', { songId: Number(id), alg: 'RT', time: 25 }, options)
}

/** 日推不感兴趣 */
export async function dislikeRecommendSong(id: number | string, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/v2/discovery/recommend/dislike', { resId: Number(id), resType: 4, sceneType: 1 }, options)
}

/** 智能播放列表（雷达歌单） */
export async function getPlaymodeIntelligenceList(
  id: number | string,
  pid: number | string,
  options: CallOptions = {},
): Promise<RawBody> {
  return callEapi<RawBody>(
    '/api/playmode/intelligence/list',
    { songId: Number(id), type: 'fromPlayOne', playlistId: Number(pid), startMusicId: Number(id), count: 30 },
    options,
  )
}

/** 歌曲百科（play/about 页面块） */
export async function getSongWiki(id: number | string, options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/song/play/about/block/page', { songId: Number(id) }, options)
}

/** 相似歌曲 */
export async function getSimilarSongs(
  id: number | string,
  { limit = 10, offset = 0 }: { limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<Track[]> {
  const body = await callWeapi<RawBody>('/api/v1/discovery/simiSong', { songid: Number(id), limit, offset }, options)
  return asArray(body.songs).map(mapTrack)
}

/** 歌曲相关播客（专辑播客公开接口，无加密） */
export async function getSongRelatedBlogs(
  albumId: number | string,
  { page = 1, count = 5 }: { page?: number; count?: number } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  const response = await fetch('https://music.163.com/api/album/blog', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: new URLSearchParams({ albumId: String(albumId), page: String(page), count: String(count), csrf_token: '' }).toString(),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  return (await response.json()) as RawBody
}

/** 歌曲详情聚合版：详情 + 音质等级 + 专辑扩展（参考 /api/netease/song/detail 行为） */
export async function getSongDetailEnriched(
  id: number | string,
  options: CallOptions = {},
): Promise<Track & { qualityLevels: QualityOptionLite[]; albumExtra?: { company: string; subType: string; type: string; publishTime?: number } }> {
  const body = await callWeapi<RawBody>('/api/v3/song/detail', { c: `[{"id":${Number(id)}}]` }, options)
  const song = mapTrack(asArray(body.songs)[0])
  const qualityLevels = await getSongQualityLevels(id, options).catch(() => [] as QualityOptionLite[])
  let albumExtra: { company: string; subType: string; type: string; publishTime?: number } | undefined
  if (song.album.id > 0) {
    try {
      const raw = await callWeapi<RawBody>(`/api/v1/album/${song.album.id}`, {}, options)
      const albumBody = asRecord(raw.album)
      albumExtra = {
        company: asString(albumBody.company),
        subType: asString(albumBody.subType),
        type: asString(albumBody.type),
        publishTime: asNumber(albumBody.publishTime) || undefined,
      }
    } catch {
      /* 专辑扩展失败不致命 */
    }
  }
  return { ...song, qualityLevels, albumExtra }
}

/** 专辑详情（搜索封面补齐复用） */
export async function getAlbumDetail(id: number | string, options: CallOptions = {}): Promise<TrackAlbum & { description?: string; publishTime?: number; artist?: TrackArtist }> {
  const body = await callWeapi<RawBody>(`/api/v1/album/${Number(id)}`, {}, options)
  const album = asRecord(body.album)
  return {
    id: asNumber(album.id, Number(id)),
    name: asString(album.name),
    picUrl: asString(album.picUrl) || undefined,
    description: asString(album.description) || undefined,
    publishTime: asNumber(album.publishTime) || undefined,
    artist: album.artist ? mapArtist(album.artist) : undefined,
  }
}

export { NeteaseApiError }
