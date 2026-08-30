/**
 * 目录端点：专辑、歌手、MV、电台（DJ）、歌单浏览与管理。
 */
import { DOMAIN_NOS_UPLOAD } from './config'
import { callEapi, callEapiRaw, callWeapi, withRetry, type CallOptions } from './request'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  type ArtistSummary,
  type MvPlayInfo,
  type MvSummary,
  type PlaylistSummary,
  type RawBody,
  type TrackAlbum,
} from './types'
import { getAlbumDetail, mapArtist, mapTrack } from './client-core'

function mapArtistSummary(value: unknown): ArtistSummary {
  const artist = asRecord(value)
  return {
    id: asNumber(artist.id),
    name: asString(artist.name),
    picUrl: asString(artist.picUrl) || asString(artist.img1v1Url) || undefined,
    alias: asArray(artist.alias).map((item) => asString(item)),
    briefDesc: asString(artist.briefDesc) || undefined,
  }
}

function mapMvSummary(value: unknown): MvSummary {
  const mv = asRecord(value)
  return {
    id: asNumber(mv.id ?? mv.vid),
    name: asString(mv.name ?? mv.title),
    cover: asString(mv.cover) || asString(mv.coverUrl) || asString(mv.imgurl) || undefined,
    durationMs: asNumber(mv.duration) || undefined,
    artists: asArray(mv.artists).map(mapArtist),
    playCount: asNumber(mv.playCount) || undefined,
  }
}

/* --------------------------------- 专辑 --------------------------------- */

export { getAlbumDetail } from './client-core'

/** 收藏/取消收藏专辑（t: 1=sub 2=unsub） */
export async function subscribeAlbum(id: number | string, t: 1 | 2, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>(`/api/album/${t === 1 ? 'sub' : 'unsub'}`, { id: Number(id) }, options)
}

/** 已收藏专辑（一次拉全量，上限 1000） */
export async function getAlbumSublist(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/album/sublist', { limit: 1000, offset: 0, total: true }, options)
}

/** 新碟上架 */
export async function getTopAlbums(
  { area = 'ALL', limit = 30, offset = 0 }: { area?: string; limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<TrackAlbum[]> {
  const now = new Date()
  const body = await callWeapi<RawBody>(
    '/api/discovery/new/albums/area',
    { area, limit, offset, type: 'new', year: now.getFullYear(), month: now.getMonth() + 1, total: false, rcmd: true },
    options,
  )
  return asArray(body.albums).map((item) => {
    const record = asRecord(item)
    return { id: asNumber(record.id), name: asString(record.name), picUrl: asString(record.picUrl) || undefined }
  })
}

/** 批量专辑封面（串行 300ms 间隔防限流） */
export async function getAlbumCoversBatch(ids: (number | string)[], options: CallOptions = {}): Promise<Record<number, string>> {
  const covers: Record<number, string> = {}
  for (const id of ids) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      const album = await getAlbumDetail(id, options)
      if (album.picUrl) covers[Number(id)] = album.picUrl
    } catch {
      /* 单个失败不中断 */
    }
  }
  return covers
}

/* --------------------------------- 歌手 --------------------------------- */

/** 歌手聚合详情：基本信息+热门歌 / 简介 головы / 介绍 / 粉丝数 */
export async function getArtistOverview(id: number | string, options: CallOptions = {}): Promise<{
  artist: ArtistSummary
  hotSongs: ReturnType<typeof mapTrack>[]
  intro?: string
  fansCount?: number
}> {
  const base = await withRetry(() => callWeapi<RawBody>(`/api/v1/artist/${Number(id)}`, {}, options), 3)
  const artist = asRecord(base.artist)
  const summary = mapArtistSummary(artist)

  const [detail, desc, follow] = await Promise.allSettled([
    callEapi<RawBody>('/api/artist/head/info/get', { id: Number(id) }, options),
    callWeapi<RawBody>('/api/artist/introduction', { id: Number(id) }, options),
    callWeapi<RawBody>('/api/artist/follow/count/get', { id: Number(id) }, options),
  ])
  if (detail.status === 'fulfilled') {
    const briefDesc = asString(asRecord(detail.value.data).briefDesc)
    if (briefDesc) summary.briefDesc = briefDesc
  }
  let intro: string | undefined
  if (desc.status === 'fulfilled') {
    const introduction = asArray(desc.value.introduction)
      .map((item) => asString(asRecord(item).txt))
      .filter(Boolean)
      .join('\n')
    intro = introduction || undefined
    if (!summary.briefDesc) summary.briefDesc = asString(desc.value.briefDesc) || undefined
  }
  let fansCount: number | undefined
  if (follow.status === 'fulfilled') fansCount = asNumber(asRecord(follow.value.data).fansCnt) || undefined

  return { artist: summary, hotSongs: asArray(base.hotSongs).map(mapTrack), intro, fansCount }
}

/** 歌手全部歌曲（分页） */
export async function getArtistSongs(
  id: number | string,
  { order = 'hot', limit = 200, offset = 0 }: { order?: 'hot' | 'time'; limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<{ songs: ReturnType<typeof mapTrack>[]; total: number; more: boolean }> {
  const body = await withRetry(
    () => callEapi<RawBody>('/api/v1/artist/songs', { id: Number(id), private_cloud: 'true', work_type: 1, order, offset, limit }, options),
    3,
  )
  return { songs: asArray(body.songs).map(mapTrack), total: asNumber(body.total), more: Boolean(body.more) }
}

/** 歌手专辑（公开 GET 接口，无加密） */
export async function getArtistAlbums(
  id: number | string,
  { limit = 200, offset = 0 }: { limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<{ albums: TrackAlbum[]; more: boolean }> {
  const response = await fetch(`https://music.163.com/api/artist/albums/${Number(id)}?limit=${limit}&offset=${offset}`, {
    headers: { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
  })
  const json = (await response.json()) as RawBody
  return {
    albums: asArray(json.hotAlbums).map((item) => {
      const record = asRecord(item)
      return { id: asNumber(record.id), name: asString(record.name), picUrl: asString(record.picUrl) || undefined }
    }),
    more: Boolean(json.more),
  }
}

/** 歌手 MV */
export async function getArtistMvs(
  id: number | string,
  { limit = 200, offset = 0 }: { limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<MvSummary[]> {
  const body = await callWeapi<RawBody>('/api/artist/mvs', { artistId: Number(id), limit, offset, total: true }, options)
  return asArray(body.mvs).map(mapMvSummary)
}

/** 相似歌手 */
export async function getSimilarArtists(id: number | string, options: CallOptions = {}): Promise<ArtistSummary[]> {
  const body = await callWeapi<RawBody>('/api/discovery/simiArtist', { artistid: Number(id) }, options)
  return asArray(body.artists).map(mapArtistSummary)
}

/** 关注/取关歌手（t: 1=sub 2=unsub） */
export async function subscribeArtist(id: number | string, t: 1 | 2, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>(`/api/artist/${t === 1 ? 'sub' : 'unsub'}`, { artistId: Number(id), artistIds: `[${Number(id)}]` }, options)
}

/** 已关注歌手（全量上限 1000） */
export async function getArtistSublist(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/artist/sublist', { limit: 1000, offset: 0, total: true }, options)
}

/** 歌手分类列表（type 1男 2女 3乐队；area -1全部 7华语 96欧美 8日本 16韩国 0其他） */
export async function getArtistList(
  { type = -1, area = -1, initial = '', limit = 30, offset = 0 }: { type?: number; area?: number; initial?: string; limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<ArtistSummary[]> {
  const initialCode = initial && Number.isNaN(Number(initial)) ? initial.toUpperCase().charCodeAt(0) : initial
  const body = await callWeapi<RawBody>(
    '/api/v1/artist/list',
    { initial: initialCode || undefined, offset, limit, total: true, type, area },
    options,
  )
  return asArray(body.artists).map(mapArtistSummary)
}

/** 热门歌手 */
export async function getTopArtists({ limit = 30, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<ArtistSummary[]> {
  const body = await callWeapi<RawBody>('/api/artist/top', { limit, offset, total: true }, options)
  return asArray(body.artists).map(mapArtistSummary)
}

/* ----------------------------------- MV ----------------------------------- */

/** MV 播放地址（http 强转 https 避免混合内容拦截） */
export async function getMvPlayInfo(id: number | string, r = 1080, options: CallOptions = {}): Promise<MvPlayInfo> {
  const body = await callWeapi<RawBody>('/api/song/enhance/play/mv/url', { id: Number(id), r }, options)
  const data = asRecord(asArray(body.data)[0])
  const url = asString(data.url)
  return {
    id: asNumber(data.id, Number(id)),
    url: url ? url.replace(/^http:\/\//, 'https://') : null,
    resolution: asNumber(data.r, r),
    sizeBytes: asNumber(data.size) || undefined,
  }
}

/** MV 详情 */
export async function getMvDetail(id: number | string, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/v1/mv/detail', { id: Number(id) }, options)
}

/** 全部 MV（tags 地区/类型/排序） */
export async function getMvAll(
  { area = '全部', type = '全部', order = '上升最快', limit = 30, offset = 0 }: { area?: string; type?: string; order?: string; limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<MvSummary[]> {
  const body = await callEapi<RawBody>(
    '/api/mv/all',
    { tags: JSON.stringify({ 地区: area, 类型: type, 排序: order }), offset, total: 'true', limit },
    options,
  )
  return asArray(body.data).map(mapMvSummary)
}

/** 收藏/取消收藏 MV */
export async function subscribeMv(id: number | string, subscribe: boolean, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>(`/api/mv/${subscribe ? 'sub' : 'unsub'}`, { mvId: Number(id), mvIds: `["${Number(id)}"]` }, options)
}

/** 已收藏 MV */
export async function getMvSublist({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/cloudvideo/allvideo/sublist', { limit, offset, total: true }, options)
}

/** 相似 MV */
export async function getSimilarMvs(id: number | string, options: CallOptions = {}): Promise<MvSummary[]> {
  const body = await callWeapi<RawBody>('/api/discovery/simiMV', { mvid: Number(id) }, options)
  return asArray(body.mvs).map(mapMvSummary)
}

/** MV 排行榜 */
export async function getTopMvs({ area = '', limit = 30, offset = 0 }: { area?: string; limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<MvSummary[]> {
  const body = await callWeapi<RawBody>('/api/mv/toplist', { area, limit, offset, total: true }, options)
  return asArray(body.data).map(mapMvSummary)
}

/* --------------------------------- 电台/DJ --------------------------------- */

/** 所有榜单摘要 */
export async function getToplistDetail(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/toplist/detail', {}, options)
}

/** 榜单歌曲（复用歌单详情通道，返回完整歌单结构） */
export async function getToplistSongs(id: number | string, options: CallOptions = {}): Promise<RawBody> {
  const body = await callEapi<RawBody>('/api/v6/playlist/detail', { id: Number(id), n: 100000, s: 8 }, options)
  return body
}

/** 首页轮播图（type 2 = iphone 端，参考行为） */
export async function getBanner(options: CallOptions = {}): Promise<RawBody[]> {
  const body = await callWeapi<RawBody>('/api/v2/banner/get', { clientType: 'iphone' }, options)
  return asArray(body.banners).map(asRecord)
}

/** 个性化推荐电台 */
export async function getPersonalizedDjRadios(options: CallOptions = {}): Promise<RawBody[]> {
  const body = await callWeapi<RawBody>('/api/personalized/djprogram', {}, options)
  return asArray(body.result).map(asRecord)
}

/** 电台个性化推荐（djRadios） */
export async function getDjRecommend(options: CallOptions = {}): Promise<RawBody[]> {
  const body = await callWeapi<RawBody>('/api/djradio/personalize/rcmd', { limit: 6 }, options)
  return asArray(body.djRadios).map(asRecord)
}

/** 电台节目榜 */
export async function getDjProgramToplist({ limit = 30, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<RawBody[]> {
  const body = await callWeapi<RawBody>('/api/program/toplist/v1', { limit, offset }, options)
  return asArray(body.toplist ?? body.programs).map(asRecord)
}

/** 电台节目列表 */
export async function getDjPrograms(
  rid: number | string,
  { limit = 30, offset = 0, asc = false }: { limit?: number; offset?: number; asc?: boolean } = {},
  options: CallOptions = {},
): Promise<RawBody[]> {
  const body = await callWeapi<RawBody>('/api/dj/program/byradio', { radioId: Number(rid), limit, offset, asc }, options)
  return asArray(body.programs).map(asRecord)
}

/** 订阅/退订电台 */
export async function subscribeDjRadio(rid: number | string, subscribe: boolean, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>(`/api/djradio/${subscribe ? 'sub' : 'unsub'}`, { id: Number(rid) }, options)
}

/** 已订阅电台 */
export async function getDjSublist({ limit = 30, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/djradio/get/subed', { limit, offset, total: true }, options)
}

/** 电台分类 */
export async function getDjCategories(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/djradio/category/get', {}, options)
}

/** 热门电台 */
export async function getHotDjRadios({ limit = 30, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<RawBody[]> {
  const body = await callWeapi<RawBody>('/api/djradio/hot/v1', { limit, offset }, options)
  return asArray(body.djRadios).map(asRecord)
}

/* ------------------------------ 歌单浏览/管理 ------------------------------ */

/** 歌单分类目录 */
export async function getPlaylistCategories(options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/playlist/catalogue', {}, options)
}

/** 分类歌单（热门/最新） */
export async function getTopPlaylists(
  { cat = '全部', order = 'hot', limit = 30, offset = 0 }: { cat?: string; order?: 'hot' | 'new'; limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<PlaylistSummary[]> {
  const body = await callWeapi<RawBody>('/api/playlist/list', { cat, order, limit, offset, total: true }, options)
  return asArray(body.playlists).map((item) => {
    const record = asRecord(item)
    return {
      id: asNumber(record.id),
      name: asString(record.name),
      coverUrl: asString(record.coverImgUrl) || undefined,
      trackCount: asNumber(record.trackCount),
      playCount: asNumber(record.playCount) || undefined,
      ownerId: asNumber(asRecord(record.creator).userId),
      ownerName: asString(asRecord(record.creator).nickname) || undefined,
    }
  })
}

/** 精品歌单（lasttime 游标翻页） */
export async function getHighQualityPlaylists(
  { cat = '全部', limit = 30, before }: { cat?: string; limit?: number; before?: string } = {},
  options: CallOptions = {},
): Promise<PlaylistSummary[]> {
  const body = await callWeapi<RawBody>('/api/playlist/highquality/list', { cat, limit, lasttime: before ?? 0, total: true }, options)
  return asArray(body.playlists).map((item) => {
    const record = asRecord(item)
    return {
      id: asNumber(record.id),
      name: asString(record.name),
      coverUrl: asString(record.coverImgUrl) || undefined,
      trackCount: asNumber(record.trackCount),
      playCount: asNumber(record.playCount) || undefined,
      ownerId: asNumber(asRecord(record.creator).userId),
      ownerName: asString(asRecord(record.creator).nickname) || undefined,
    }
  })
}

/** 相似歌单（按歌曲 id 关联） */
export async function getSimilarPlaylistsBySong(
  id: number | string,
  { limit = 5 }: { limit?: number } = {},
  options: CallOptions = {},
): Promise<PlaylistSummary[]> {
  const body = await callWeapi<RawBody>('/api/discovery/simiPlaylist', { songid: Number(id), limit, offset: 0 }, options)
  return asArray(body.playlists).map((item) => {
    const record = asRecord(item)
    return {
      id: asNumber(record.id),
      name: asString(record.name),
      coverUrl: asString(record.coverImgUrl) || undefined,
      trackCount: asNumber(record.trackCount),
      playCount: asNumber(record.playCount) || undefined,
      ownerId: asNumber(asRecord(record.creator).userId),
      ownerName: asString(asRecord(record.creator).nickname) || undefined,
    }
  })
}

/** 相关歌单（按歌单 id：公开网页解析，无加密） */
export async function getRelatedPlaylists(id: number | string, options: CallOptions = {}): Promise<PlaylistSummary[]> {
  const response = await fetch(`https://music.163.com/playlist?id=${Number(id)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
  })
  const html = await response.text()
  const playlists: PlaylistSummary[] = []
  const pattern = /<a href="(\/playlist\?id=(\d+))"[^>]*>([^<]+)<\/a>[\s\S]{0,400}?<img src="([^"]+)"/g
  for (const match of html.matchAll(pattern)) {
    const name = (match[3] ?? '').trim()
    const playlistId = Number(match[2])
    if (!playlistId || !name) continue
    playlists.push({
      id: playlistId,
      name,
      coverUrl: (match[4] ?? '').replace(/\?param=\d+y\d+$/, '') || undefined,
      trackCount: 0,
      ownerId: 0,
    })
    if (playlists.length >= 30) break
  }
  return playlists
}

/** 创建歌单（privacy 0公开 10私密；type NORMAL/SHARED/VIDEO） */
export async function createPlaylist(
  name: string,
  { privacy = '0', type = 'NORMAL' }: { privacy?: '0' | '10'; type?: 'NORMAL' | 'SHARED' | 'VIDEO' } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  if (name.trim().length > 40) throw new Error('歌单名称过长')
  return callWeapi<RawBody>('/api/playlist/create', { name, privacy, type }, options)
}

/** 删除歌单 */
export async function deletePlaylist(id: number | string, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/playlist/remove', { ids: `[${Number(id)}]` }, options)
}

/** 编辑歌单（batch：名称/简介/标签 三合一） */
export async function updatePlaylist(
  id: number | string,
  { name, desc = '', tags = '' }: { name?: string; desc?: string; tags?: string },
  options: CallOptions = {},
): Promise<RawBody> {
  if (name !== undefined && name.trim().length > 40) throw new Error('歌单名称过长')
  if (desc.length > 980) throw new Error('歌单简介过长')
  const finalName = name ?? ''
  return callEapi<RawBody>(
    '/api/batch',
    {
      '/api/playlist/desc/update': `{"id":${Number(id)},"desc":"${desc}"}`,
      '/api/playlist/tags/update': `{"id":${Number(id)},"tags":"${tags}"}`,
      '/api/playlist/update/name': `{"id":${Number(id)},"name":"${finalName}"}`,
    },
    options,
  )
}

/** 歌单增删曲目（op add/del；512 错误时按参考行为重复提交一次） */
export async function manipulatePlaylistTracks(
  op: 'add' | 'del',
  pid: number | string,
  trackIds: (number | string)[],
  options: CallOptions = {},
): Promise<RawBody> {
  const payload = { op, pid: Number(pid), trackIds: JSON.stringify(trackIds.map(Number)), imme: 'true' }
  try {
    const response = await callEapiRaw<RawBody>('/api/playlist/manipulate/tracks', payload, options)
    return response
  } catch (error) {
    const code = (error as { code?: number }).code
    if (code === 512) {
      const duplicated = [...trackIds.map(Number), ...trackIds.map(Number)]
      return callEapiRaw<RawBody>(
        '/api/playlist/manipulate/tracks',
        { op, pid: Number(pid), trackIds: JSON.stringify(duplicated), imme: 'true' },
        options,
      )
    }
    throw error
  }
}

/** 收藏/取消收藏歌单（t=1 需防作弊 token，eapi） */
export async function subscribePlaylist(id: number | string, t: 1 | 2, options: CallOptions = {}): Promise<RawBody> {
  const path = t === 1 ? 'subscribe' : 'unsubscribe'
  const payload: Record<string, unknown> = { id: Number(id) }
  if (t === 1) payload.checkToken = await getPlaylistCheckToken()
  return callEapi<RawBody>(`/api/playlist/${path}`, payload, { ...options, checkToken: 'v2' })
}

let playlistCheckToken = ''

async function getPlaylistCheckToken(): Promise<string> {
  if (playlistCheckToken) return playlistCheckToken
  const response = await fetch('https://dun.163.com/v2/config/js?pn=YD00000558929251', { signal: AbortSignal.timeout(10_000) })
  const data = (await response.json()) as { code?: number; result?: { conf?: string } }
  playlistCheckToken = data?.result?.conf ?? ''
  if (!playlistCheckToken) throw new Error('歌单收藏 token 获取失败')
  return playlistCheckToken
}

/** 更新歌单封面：先上传图片到网易对象存储，再绑定到歌单 */
export async function updatePlaylistCover(
  id: number | string,
  image: { data: Buffer; filename?: string; mimeType?: string },
  options: CallOptions = {},
): Promise<RawBody> {
  if (image.data.length === 0 || image.data.length > 10 * 1024 * 1024) throw new Error('封面图片无效或体积过大')
  const alloc = await callWeapi<RawBody>(
    '/api/nos/token/alloc',
    {
      bucket: 'yyimgs',
      ext: 'jpg',
      filename: image.filename ?? `playlist-${Number(id)}.jpg`,
      local: false,
      nos_product: 0,
      return_body: '{"code":200,"size":"$(ObjectSize)"}',
      type: 'other',
    },
    options,
  )
  const result = asRecord(alloc.result)
  const objectKey = asString(result.objectKey)
  const token = asString(result.token)
  if (!objectKey || !token) throw new Error('封面上传凭证获取失败')

  const uploadResponse = await fetch(`${DOMAIN_NOS_UPLOAD}/yyimgs/${objectKey}?offset=0&complete=true&version=1.0`, {
    method: 'POST',
    headers: { 'x-nos-token': token, 'Content-Type': image.mimeType ?? 'image/jpeg' },
    body: new Uint8Array(image.data),
  })
  if (!uploadResponse.ok) throw new Error('封面上传失败')

  return callWeapi<RawBody>('/api/playlist/cover/update', { id: Number(id), coverImgId: asString(result.docId) }, options)
}

/** 相似歌单（按歌单 id，simiPlaylist 亦接受歌单 id 场景） */
export async function getSimilarPlaylists(id: number | string, { limit = 30 }: { limit?: number } = {}, options: CallOptions = {}): Promise<PlaylistSummary[]> {
  const body = await callEapi<RawBody>('/api/discovery/simiPlaylist', { songid: Number(id), limit, offset: 0 }, options)
  return asArray(body.playlists).map((item) => {
    const record = asRecord(item)
    return {
      id: asNumber(record.id),
      name: asString(record.name),
      coverUrl: asString(record.coverImgUrl) || undefined,
      trackCount: asNumber(record.trackCount),
      ownerId: asNumber(asRecord(record.creator).userId),
      ownerName: asString(asRecord(record.creator).nickname) || undefined,
    }
  })
}
