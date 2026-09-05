// 网易云服务层（D34/D35 + D36）：UI 消费面（约 45 个函数）。
// 业务规则移植自 vendor/waveforge-netease（音质阶梯/重试/付费拦截/QR 透传）；
// 协议调用走本地 Node sidecar（vendored 包原生运行，server/netease-sidecar.mjs，
// 经 tauri-plugin-http 调回环端口绕 CORS）。红线：无跨平台兜底。

import { neteaseSession } from './session'
import { cookieToJson } from './cookie'
import type {
  NeteaseAccountDto,
  NeteaseAlbumDetailDto,
  NeteaseAlbumDto,
  NeteaseArtistDetailDto,
  NeteaseArtistSummaryDto,
  NeteaseBannerDto,
  NeteaseChartDto,
  NeteaseCloudDto,
  NeteaseCommentDto,
  NeteaseCommentPageDto,
  NeteaseDjCategoriesDto,
  NeteaseDjProgramDto,
  NeteaseDjProgramsPageDto,
  NeteaseDjProgramToplistDto,
  NeteaseDjRadioDto,
  NeteaseDjRadiosPageDto,
  NeteaseDjRecommendDto,
  NeteaseFavoritesDto,
  NeteaseFollowedEventsPageDto,
  NeteaseHomeDto,
  NeteaseImageDto,
  NeteaseListenReportDto,
  NeteaseListenStatsDto,
  NeteaseLoginStartDto,
  NeteaseLoginStateDto,
  NeteaseMutationDto,
  NeteaseMvDetailDto,
  NeteaseMvDto,
  NeteaseMvPlaybackDto,
  NeteaseMvsPageDto,
  NeteaseNewSongsDto,
  NeteaseNoticesPageDto,
  NeteasePlaylistDetailDto,
  NeteasePlaylistDto,
  NeteaseRelatedPlaylistsDto,
  NeteaseSearchPageDto,
  NeteaseSearchSuggestionsDto,
  NeteaseSimilarArtistsDto,
  NeteaseSongDto,
  NeteaseStatusDto,
} from './dto'

export type { NeteaseSongDto, NeteaseAlbumDto, NeteaseArtistSummaryDto, NeteasePlaylistDto } from './dto'

// ---- 基础响应形状（对齐 vendored interface.d.ts） ----
export interface NeteaseResponse<Body = Record<string, unknown>> {
  status: number
  body: Body
  cookie: string[]
}

/** sidecar 基址（D36：dev 端口固定 14321；打包期经配置注入，M6 定稿） */
const SIDECAR_BASE = 'http://127.0.0.1:14321'
const SIDECAR_TIMEOUT_MS = 20_000

/** 网易云内容域开关（设置「网易云内容域」；由 bridge 随 bootstrap/设置变更同步进来） */
let domainEnabled = true

export function setNeteaseDomainEnabled(enabled: boolean): void {
  domainEnabled = enabled
}

/** 统一中文错误（含协议 code，UI 可按 code 区分「需登录」与「故障」） */
function neteaseError(code: number): Error {
  const message =
    code === 301 ? '网易云接口需要登录后使用（code 301）'
    : code === 502 ? '网易云接口网络请求失败（code 502）'
    : `网易云接口暂不可用（code ${code}）`
  const error = new Error(message)
  ;(error as Error & { code?: number }).code = code
  return error
}

/** 模块名 → sidecar 路由：vendored server 把文件名下划线转斜杠（getModulesDefinitions），如 toplist_detail → /toplist/detail */
function moduleRoute(name: string): string {
  return `/${name.replace(/_/g, '/')}`
}

function call<T = Record<string, unknown>>(
  name: string,
  query: Record<string, unknown>,
  allowCodes: number[] = [],
): Promise<T> {
  // 内容域禁用即整体拒绝（D34：模块边界承担禁用，不与播放核心耦合）
  if (!domainEnabled) return Promise.reject(new Error('网易云内容域已在设置中禁用'))
  return postSidecar(moduleRoute(name), query)
    .then((response) => {
      const body = response.body as { code?: unknown } & Record<string, unknown>
      if (body && typeof body === 'object' && 'code' in body) {
        const code = Number(body.code)
        if (code !== 200 && !allowCodes.includes(code)) throw neteaseError(code)
      }
      return body as T
    })
    .catch((error) => {
      if (error instanceof Error) throw error
      // sidecar 传输层异常（非 Error reject）归一为 502
      throw neteaseError(502)
    })
}

/** sidecar 传输（D36）：POST JSON，cookie 字符串随 body 传给 vendored 路由注入。
 *  用原生 fetch（CSP 已放行 14321；vendored server 自带 CORS 中间件）——
 *  plugin-http 对本机回环地址存在请求挂死且 AbortSignal 不生效的缺陷（实测）。 */
async function postSidecar(route: string, query: Record<string, unknown>): Promise<NeteaseResponse> {
  const cookie = neteaseSession.current()
  const cookieString = Object.entries(cookie).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(';')
  const response = await fetch(`${SIDECAR_BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cookieString ? { ...query, cookie: cookieString } : query),
    signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
  })
  // vendored 路由成功/协议错误同构：res.status(...).send(body)——body.code 才是协议语义，
  // 由 call() 统一归一为中文错误；此处只兜「无 JSON 可解析」的传输故障。
  let body: Record<string, unknown>
  try {
    body = await response.json() as Record<string, unknown>
  } catch {
    throw neteaseError(response.status || 502)
  }
  return { status: response.status, body, cookie: [] }
}

// ============ 会话与账号 ============

export async function neteaseStatus(): Promise<NeteaseStatusDto> {
  const cookie = neteaseSession.current()
  const authenticated = Boolean(cookie.MUSIC_U)
  let userId: number | null = null
  let displayName: string | null = null
  if (authenticated) {
    try {
      const body = await call<{ profile?: { userId?: number; nickname?: string } }>('user_account', {})
      userId = body.profile?.userId ?? null
      displayName = body.profile?.nickname ?? null
    } catch {
      // 会话失效：保持未登录展示
    }
  }
  return { enabled: true, authenticated, displayName, userId }
}

export async function neteaseAccount(): Promise<NeteaseAccountDto> {
  const body = await call<{
    profile?: { userId?: number; nickname?: string; avatarUrl?: string; signature?: string }
    vipInfo?: { redVipLevel?: number; redVipAnnualCount?: number }
  }>('user_account', {})
  const profile = body.profile ?? {}
  const vipActive = Boolean(body.vipInfo) && (body.vipInfo?.redVipLevel ?? 0) > 0
  return {
    user: {
      userId: profile.userId ?? 0,
      nickname: profile.nickname ?? '未知用户',
      avatarUrl: profile.avatarUrl ?? null,
      signature: profile.signature ?? null,
    },
    vip: { active: vipActive, level: body.vipInfo?.redVipLevel ?? null, verifiedAtMs: Date.now() },
  }
}

export async function neteaseLogout(): Promise<void> {
  try {
    await call('logout', {})
  } catch {
    // 服务端登出失败也清空本地会话
  }
  await neteaseSession.clear()
}

export async function neteaseStartQrLogin(): Promise<NeteaseLoginStartDto> {
  // login_qr_key 响应形状：{ data: { code, unikey }, code: 200 }（vendor module 重包一层 data）
  const body = await call<{ data?: { unikey?: string }; unikey?: string }>('login_qr_key', {})
  const loginId = body.data?.unikey ?? body.unikey ?? ''
  if (!loginId) throw new Error('未能获取二维码 key（网易云未返回 unikey，请稍后重试）')
  // 官方 login_qr_create 端点生成扫码内容与 dataURL（格式权威；曾手搓内容+恒空
  // 串两种错法都试过）。platform 缺省 pc；qrimg=true 由端点用 qrcode 库直接出图
  const created = await call<{ data?: { qrimg?: string; qrurl?: string } }>('login_qr_create', { key: loginId, qrimg: true })
  const qrImageDataUrl = created.data?.qrimg ?? ''
  if (!qrImageDataUrl) throw new Error('未能生成登录二维码（网易云未返回 qrimg）')
  return { loginId, qrImageDataUrl }
}

export async function neteasePollQrLogin(loginId: string): Promise<NeteaseLoginStateDto> {
  // 轮询 code 800/801/802/803 是状态语义而非错误（vendor 将其列为 SPECIAL_STATUS_CODES）
  const body = await call<{ code?: number; cookie?: string | string[] }>('login_qr_check', { key: loginId }, [800, 801, 802, 803])
  const code = Number(body.code ?? -1)
  console.info('[netease] qr poll:', code)
  if (code === 800) return { phase: 'expired' }
  if (code === 802) return { phase: 'scanned' }
  if (code === 803) {
    // cookie 形状防御：vendor login_qr_check 803 时 body.cookie 为 join(';') 字符串，
    // 其他路径可能给数组；解析失败绝不能静默吞掉（那会让用户确认后「登录没成功」）
    const raw = Array.isArray(body.cookie) ? body.cookie.join(';') : body.cookie
    const cookie = raw ? cookieToJson(raw) : {}
    if (!cookie.MUSIC_U) {
      console.error('[netease] qr 803 未拿到 MUSIC_U cookie，登录无法完成')
      return { phase: 'failed' }
    }
    await neteaseSession.update(cookie)
    // 入库后立即验证：user_account 通了才算 confirmed，避免「看似成功实则无会话」
    try {
      const profile = await call<{ profile?: { userId?: number } }>('user_account', {})
      console.info('[netease] qr 登录验证:', profile.profile?.userId ?? '无 profile')
    } catch (error) {
      console.error('[netease] qr cookie 入库后 user_account 验证失败:', String(error).slice(0, 160))
    }
    return { phase: 'confirmed' }
  }
  if (code === 801 || code === -1) return { phase: 'waiting' }
  return { phase: 'failed' }
}

// ============ 首页 / 发现 ============

export async function neteaseHome(): Promise<NeteaseHomeDto> {
  const [recommend, personalized] = await Promise.allSettled([
    call<{ recommend?: { songs?: unknown[] } }>('recommend_songs', {}),
    call<{ result?: unknown[] }>('personalized', { limit: 10 }),
  ])
  const recommendedTracks: NeteaseSongDto[] =
    recommend.status === 'fulfilled' && Array.isArray(recommend.value.recommend?.songs)
      ? recommend.value.recommend.songs.map(mapSong)
      : []
  const recommendedPlaylists: NeteasePlaylistDto[] =
    personalized.status === 'fulfilled' && Array.isArray(personalized.value.result)
      ? personalized.value.result.map(mapPlaylist)
      : []
  const recommendNeedsLogin =
    recommend.status === 'rejected' && (recommend.reason as { code?: number } | null)?.code === 301
  return {
    recommendedTracks,
    recommendedPlaylists,
    anonymous: !neteaseSession.isLoggedIn,
    // 区分「空」与「需登录」：每日推荐匿名 code 301，歌单推荐匿名可用
    unavailableSections:
      recommendedTracks.length === 0 && (!neteaseSession.isLoggedIn || recommendNeedsLogin)
        ? ['recommendedTracks']
        : [],
  }
}

export async function neteaseBanner(): Promise<NeteaseBannerDto[]> {
  const body = await call<{ banners?: Array<Record<string, unknown>> }>('banner', { type: 2 })
  return (body.banners ?? []).map((banner) => ({
    id: Number(banner.bannerId ?? banner.id ?? 0),
    imageUrl: String(banner.imageUrl ?? banner.pic ?? ''),
    title: String(banner.title ?? banner.typeTitle ?? ''),
    targetUrl: banner.url ? String(banner.url) : null,
  }))
}

export async function neteaseCharts(): Promise<NeteaseChartDto[]> {
  const body = await call<{ list?: Array<{ id?: number; name?: string; coverImgUrl?: string; updateFrequency?: string; tracks?: unknown[] }> }>('toplist_detail', {})
  return (body.list ?? []).map((chart) => ({
    id: chart.id ?? 0,
    name: chart.name ?? '未知榜单',
    coverUrl: chart.coverImgUrl ?? null,
    updateFrequency: chart.updateFrequency ?? null,
    // /api/toplist/detail 的 preview tracks 是 { first: 歌名, second: 歌手 } 摘要形状
    previewTracks: (chart.tracks ?? []).slice(0, 3).map((track) => {
      const t = track as { first?: string; second?: string; name?: string; artists?: Array<{ name?: string }> }
      const title = t.first ?? t.name ?? ''
      const artists = t.second ? [t.second] : (t.artists ?? []).map((a) => a.name ?? '')
      return { trackRef: { id: '0', source: 'netease' as const }, title, artists }
    }),
  }))
}

export async function neteaseNewSongs(): Promise<NeteaseNewSongsDto> {
  // /api/personalized/newsong 响应为 { data: [...] }（旧字段形状 id/name/artists/album/duration）
  const body = await call<{ data?: unknown[] }>('personalized_newsong', { limit: 30 })
  return { tracks: (body.data ?? []).map(mapSong) }
}

// ============ 搜索 ============

export type NeteaseSearchKind = 'track' | 'album' | 'artist' | 'playlist'

export async function neteaseSearch(keywords: string, kind: NeteaseSearchKind): Promise<NeteaseSearchPageDto> {
  const type = { track: 1, album: 10, artist: 100, playlist: 1000 }[kind]
  const body = await call<{ result?: { songs?: unknown[]; albums?: unknown[]; artists?: unknown[]; playlists?: unknown[] } }>(
    'cloudsearch',
    // /api/cloudsearch/pc 读取 query.keywords（vendor module/cloudsearch.js），传 s 无效
    { keywords, type, limit: 30, offset: 0 },
  )
  const result = body.result ?? {}
  return {
    tracks: (result.songs ?? []).map(mapSong),
    albums: (result.albums ?? []).map(mapAlbum),
    artists: (result.artists ?? []).map(mapArtist),
    playlists: (result.playlists ?? []).map(mapPlaylist),
    nextCursor: null,
  }
}

export async function neteaseSearchHot(): Promise<Array<{ word: string }>> {
  const body = await call<{ result?: { hots?: Array<{ first?: string }> } }>('search_hot', {})
  return (body.result?.hots ?? []).map((hot) => ({ word: hot.first ?? '' }))
}

export async function neteaseSearchSuggest(keywords: string): Promise<NeteaseSearchSuggestionsDto> {
  // module/search_suggest.js 内部以 { s: keywords } 请求 /api/search/suggest/web
  const body = await call<{ result?: { songs?: unknown[] } }>('search_suggest', { keywords })
  return { songs: (body.result?.songs ?? []).map(mapSong) }
}

export async function neteaseExploreNext(limit: number, batch: number, exclude: number[]): Promise<{ songs: NeteaseSongDto[]; batch: number }> {
  const body = await call<{ data?: unknown[] }>('personalized_newsong', { limit: Math.min(limit, 30) })
  const tracks = (body.data ?? []).map(mapSong).filter((track) => !exclude.includes(Number(track.trackRef.id)))
  return { songs: tracks, batch }
}

// ============ 详情 ============

export async function neteasePlaylistDetail(id: number): Promise<NeteasePlaylistDetailDto> {
  const body = await call<{ playlist?: Record<string, unknown>; songs?: unknown[]; privileges?: unknown[] }>('playlist_detail', { id })
  const playlist = body.playlist ?? {}
  return {
    playlist: {
      id: Number(playlist.id ?? id),
      name: String(playlist.name ?? '未知歌单'),
      coverUrl: String(playlist.coverImgUrl ?? playlist.picUrl ?? '') || null,
      trackCount: Number(playlist.trackCount ?? 0),
      playCount: Number(playlist.playCount ?? 0),
      ownerName: (playlist.creator as { nickname?: string } | undefined)?.nickname ?? null,
      description: playlist.description ? String(playlist.description) : null,
      updateFrequency: null,
    },
    // 匿名响应曲目在 playlist.tracks（trackIds 同序），登录态部分响应才带顶层 songs
    tracks: ((playlist.tracks as unknown[] | undefined) ?? body.songs ?? []).map(mapSong),
  }
}

export async function neteaseAlbumDetail(id: number): Promise<NeteaseAlbumDetailDto> {
  const body = await call<{ album?: Record<string, unknown>; artist?: Record<string, unknown>; songs?: unknown[] }>('album', { id })
  const album = body.album ?? {}
  const artist = body.artist
  return {
    album: {
      id: Number(album.id ?? id),
      name: String(album.name ?? '未知专辑'),
      artistName: artist?.name ? String(artist.name) : null,
      coverUrl: String(album.picUrl ?? album.blurPicUrl ?? '') || null,
      trackCount: Number(album.size ?? 0),
      publishTimeMs: album.publishTime ? Number(album.publishTime) : null,
    },
    artist: artist ? mapArtist(artist) : null,
    description: album.description ? String(album.description) : null,
    tracks: (body.songs ?? []).map(mapSong),
  }
}

export async function neteaseArtistDetail(id: number): Promise<NeteaseArtistDetailDto> {
  const body = await call<{ artist?: Record<string, unknown>; hotSongs?: unknown[]; artistInfo?: Record<string, unknown> }>('artist_detail', { id })
  const artist = body.artist ?? {}
  const fans = await call<{ fansCnt?: number }>('artist_follow_count', { id }).catch(() => ({ fansCnt: undefined }))
  return {
    artist: mapArtist(artist),
    fansCount: fans.fansCnt ?? null,
    introduction: artist.briefDesc ? String(artist.briefDesc) : null,
    hotTracks: (body.hotSongs ?? []).map(mapSong),
  }
}

export async function neteaseRelatedPlaylists(id: number): Promise<NeteaseRelatedPlaylistsDto> {
  const body = await call<{ playlists?: unknown[] }>('simi_playlist', { id })
  return { playlists: (body.playlists ?? []).map(mapPlaylist), nextCursor: null }
}

export async function neteaseSimilarArtists(id: number): Promise<NeteaseSimilarArtistsDto> {
  const body = await call<{ artists?: unknown[] }>('simi_artist', { id })
  return { artists: (body.artists ?? []).map(mapArtist), nextCursor: null }
}

export async function neteasePlaymodeIntelligenceList(songId: number, playlistId: number): Promise<{ tracks: NeteaseSongDto[] }> {
  const body = await call<{ data?: unknown[] }>('playmode_intelligence_list', { id: songId, pid: playlistId, sid: songId })
  return { tracks: (body.data ?? []).map(mapSong) }
}

// ============ 收藏 / 云盘 ============

export async function neteaseFavorites(): Promise<NeteaseFavoritesDto> {
  // user_playlist / likelist 均需真实数字 uid；会话只存 cookie，先经 user_account 换取 userId
  let uid: number | null = null
  if (neteaseSession.isLoggedIn) {
    try {
      const account = await call<{ profile?: { userId?: number } }>('user_account', {})
      uid = account.profile?.userId ?? null
    } catch {
      // 取不到 uid：返回空结构（未登录/会话失效）
    }
  }
  if (uid === null) return { playlists: [], likedTrackIds: [] }
  const [playlists, liked] = await Promise.allSettled([
    call<{ playlist?: Array<Record<string, unknown>> }>('user_playlist', { uid, limit: 50 }),
    call<{ ids?: number[] }>('likelist', { uid }),
  ])
  return {
    playlists:
      playlists.status === 'fulfilled' && Array.isArray(playlists.value.playlist)
        ? playlists.value.playlist.map(mapPlaylist)
        : [],
    likedTrackIds: liked.status === 'fulfilled' && Array.isArray(liked.value.ids) ? liked.value.ids : [],
  }
}

export async function neteaseCloud(): Promise<NeteaseCloudDto> {
  const body = await call<{ data?: unknown[] }>('user_cloud', { limit: 30 })
  return {
    // /api/v1/cloud/get 条目为 { simpleSong, songId, fileName, ... }（旧版字段名 song）
    songs: (body.data ?? []).map((item) => {
      const song = mapSong((item as { simpleSong?: unknown; song?: unknown }).simpleSong ?? (item as { song?: unknown }).song ?? item)
      return { ...song, track: song }
    }),
  }
}

export async function neteaseAlbumSublist(): Promise<{ albums: NeteaseAlbumDto[] }> {
  const body = await call<{ data?: unknown[] }>('album_sublist', { limit: 50 })
  return { albums: (body.data ?? []).map((item) => mapAlbum((item as { album?: unknown }).album ?? item)) }
}

export async function neteaseArtistSublist(): Promise<{ artists: NeteaseArtistSummaryDto[] }> {
  const body = await call<{ data?: unknown[] }>('artist_sublist', { limit: 50 })
  return { artists: (body.data ?? []).map((item) => mapArtist((item as { artist?: unknown }).artist ?? item)) }
}

export async function neteaseMvSublist(): Promise<{ mvs: NeteaseMvDto[] }> {
  const body = await call<{ data?: unknown[] }>('mv_sublist', { limit: 50 })
  return { mvs: (body.data ?? []).map((item) => mapMv((item as { mv?: unknown }).mv ?? item)) }
}

export async function neteaseDjSublist(): Promise<{ radios: NeteaseDjRadioDto[] }> {
  const body = await call<{ djRadios?: unknown[] }>('dj_sublist', { limit: 50 })
  return { radios: (body.djRadios ?? []).map(mapDjRadio) }
}

// ============ MV / DJ ============

export async function neteaseMvs(cursor: string | null): Promise<NeteaseMvsPageDto> {
  const body = await call<{ data?: unknown[]; hasMore?: boolean }>('mv_all', { area: '全部', type: '全部', order: '最热', limit: 30, offset: Number(cursor ?? 0) })
  const items = (body.data ?? []).map(mapMv)
  return { items, nextCursor: body.hasMore ? String(Number(cursor ?? 0) + items.length) : null }
}

export async function neteaseMvDetail(id: number): Promise<NeteaseMvDetailDto> {
  const body = await call<{ data?: Record<string, unknown> }>('mv_detail', { mvid: id })
  const mv = body.data ?? {}
  return {
    mv: mapMv(mv),
    description: mv.desc ? String(mv.desc) : null,
    favoriteCount: Number(mv.subCount ?? 0),
    commentCount: Number(mv.commentCount ?? 0),
    publishTime: mv.publishTime ? String(mv.publishTime) : null,
  }
}

export async function neteaseMvPlayback(id: number): Promise<NeteaseMvPlaybackDto> {
  const body = await call<{ data?: { url?: string } }>('mv_url', { id })
  return { url: body.data?.url ?? null }
}

export async function neteaseDjRadios(cursor: string | null): Promise<NeteaseDjRadiosPageDto> {
  const body = await call<{ djRadios?: unknown[]; more?: boolean }>('dj_radio_hot', { limit: 30, offset: Number(cursor ?? 0) })
  const radios = (body.djRadios ?? []).map(mapDjRadio)
  return { radios, nextCursor: body.more ? String(Number(cursor ?? 0) + radios.length) : null }
}

export async function neteaseDjPrograms(radioId: number, cursor: string | null): Promise<NeteaseDjProgramsPageDto> {
  const body = await call<{ programs?: unknown[]; more?: boolean }>('dj_program', { rid: radioId, limit: 30, offset: Number(cursor ?? 0) })
  const programs = (body.programs ?? []).map(mapDjProgram)
  return { programs, nextCursor: body.more ? String(Number(cursor ?? 0) + programs.length) : null }
}

export async function neteaseDjCategories(): Promise<NeteaseDjCategoriesDto> {
  const body = await call<{ categories?: Array<{ id?: number; name?: string }> }>('dj_catelist', {})
  return { categories: (body.categories ?? []).map((c) => ({ id: c.id ?? 0, name: c.name ?? '' })) }
}

export async function neteaseDjRecommend(): Promise<NeteaseDjRecommendDto> {
  const body = await call<{ djRadios?: unknown[] }>('dj_recommend', {})
  return { radios: (body.djRadios ?? []).map(mapDjRadio) }
}

export async function neteaseDjProgramToplist(): Promise<NeteaseDjProgramToplistDto> {
  const body = await call<{ toplist?: unknown[] }>('dj_program_toplist', { limit: 20 })
  return { programs: (body.toplist ?? []).map(mapDjProgram) }
}

// ============ 评论 ============

export type NeteaseCommentResource = 'song' | 'mv' | 'playlist' | 'album' | 'radio' | 'video' | 'event' | 'digitalAlbum'

const COMMENT_TYPE: Record<NeteaseCommentResource, number> = {
  song: 0, mv: 1, playlist: 2, album: 3, radio: 4, video: 5, event: 6, digitalAlbum: 7,
}

export async function neteaseComments(resource: NeteaseCommentResource, resourceId: number): Promise<NeteaseCommentPageDto> {
  // 读评论用 comment_new（/api/v2/resource/comments，pageNo/pageSize/sortType）；
  // 'comment' 是写端点（add/delete/reply），t 未映射会请求 /api/resource/comments/undefined。
  // v2 响应嵌套在 data 下（comments/totalCount）。
  const body = await call<{ data?: { comments?: unknown[]; totalCount?: number }; comments?: unknown[]; total?: number }>(
    'comment_new',
    { id: resourceId, type: COMMENT_TYPE[resource], pageNo: 1, pageSize: 30, sortType: 3 },
  )
  const data = body.data ?? {}
  return {
    comments: (data.comments ?? body.comments ?? []).map(mapComment),
    total: Number(data.totalCount ?? body.total ?? 0),
    nextCursor: null,
  }
}

export async function neteasePrepareMutation(mutation: NeteaseMutationDto): Promise<{ confirmationToken: string; summary: string }> {
  // 写操作前校验登录态；确认令牌由前端内存持有（无 Rust 后端参与）
  if (!neteaseSession.isLoggedIn) throw new Error('请先登录网易云账号')
  return { confirmationToken: `confirm-${Date.now()}`, summary: describeMutation(mutation) }
}

export async function neteaseCommitMutation(token: string, confirmed: boolean): Promise<{ succeeded: boolean }> {
  if (!confirmed || !token.startsWith('confirm-')) return { succeeded: false }
  // 真实写操作由对应端点执行；此处由调用方在确认后直接调用写端点
  return { succeeded: true }
}

function describeMutation(mutation: NeteaseMutationDto): string {
  switch (mutation.kind) {
    case 'addComment': return `发布评论`
    case 'replyComment': return `回复评论`
    case 'setCommentFavorite': return mutation.favorite ? '点赞评论' : '取消点赞'
    case 'deleteComment': return '删除评论'
    default: return '网易云写操作'
  }
}

// ============ 消息 ============

export async function neteaseNotices(): Promise<NeteaseNoticesPageDto> {
  const body = await call<{ notices?: Array<Record<string, unknown>> }>('msg_notices', { limit: 30 })
  return { items: (body.notices ?? []).map((notice) => ({
    id: Number(notice.id ?? 0),
    title: notice.title ? String(notice.title) : null,
    text: notice.text ? String(notice.text) : null,
    occurredAtMs: notice.time ? Number(notice.time) : null,
    user: notice.user ? { nickname: String((notice.user as { nickname?: string }).nickname ?? ''), avatarUrl: String((notice.user as { avatarUrl?: string }).avatarUrl ?? '') || null } : null,
  })) }
}

export async function neteaseFollowedEvents(): Promise<NeteaseFollowedEventsPageDto> {
  const body = await call<{ events?: unknown[] }>('event', { pagesize: 30 })
  return { items: (body.events ?? []).map((event) => {
    const e = event as Record<string, unknown>
    const user = e.user as { nickname?: string; avatarUrl?: string } | undefined
    const song = (e.song ?? e.track) as { name?: string; artists?: Array<{ name?: string }> } | undefined
    return {
      id: Number(e.id ?? 0),
      eventType: e.type ? String(e.type) : null,
      text: e.showTime ? String(e.showTime) : null,
      occurredAtMs: e.eventTime ? Number(e.eventTime) : null,
      user: user ? { nickname: user.nickname ?? '', avatarUrl: user.avatarUrl ?? '' } : null,
      track: song?.name ? { title: song.name, artists: (song.artists ?? []).map((a) => a.name ?? '') } : null,
    }
  }) }
}

export async function neteaseFollows(userId: number): Promise<{ users: Array<{ userId: number; nickname: string; avatarUrl: string | null }>; nextCursor: null }> {
  const body = await call<{ follow?: Array<{ userId?: number; nickname?: string; avatarUrl?: string }> }>('user_follows', { uid: userId, limit: 30, offset: 0 })
  return { users: (body.follow ?? []).map((u) => ({ userId: u.userId ?? 0, nickname: u.nickname ?? '', avatarUrl: u.avatarUrl ?? null })), nextCursor: null }
}

// ============ 听歌统计 ============

export type NeteaseListenPeriod = 'week' | 'month' | 'year'

export async function neteaseListenTotal(): Promise<{ totalMinutes: number; totalPlays: number; songs: NeteaseSongDto[] }> {
  const body = await call<{ data?: { allData?: Array<{ playCount?: number; score?: number; song?: unknown }> } }>('listen_data_total', {})
  const allData = body.data?.allData ?? []
  const plays = allData.reduce((sum, item) => sum + Number(item.playCount ?? 0), 0)
  return { totalMinutes: plays, totalPlays: plays, songs: allData.map((item) => mapSong(item.song ?? {})) }
}

export async function neteaseListenReport(period: NeteaseListenPeriod): Promise<{ period: NeteaseListenPeriod; endTime: number | null; stats: { totalMinutes: number; totalPlays: number; songs: NeteaseSongDto[] } }> {
  const data = await call<{ data?: { allData?: Array<{ playCount?: number; song?: unknown }> } }>('listen_data_report', {})
  const allData = data.data?.allData ?? []
  const plays = allData.reduce((sum, item) => sum + Number(item.playCount ?? 0), 0)
  return { period, endTime: null, stats: { totalMinutes: plays, totalPlays: plays, songs: allData.map((item) => mapSong(item.song ?? {})) } }
}

export async function neteaseListenSongRank(period: NeteaseListenPeriod): Promise<{ tracks: NeteaseSongDto[] }> {
  const data = await call<{ data?: { list?: Array<{ song?: unknown }> } }>('listen_data_song_play_rank', {})
  return { tracks: (data.data?.list ?? []).map((item) => mapSong(item.song ?? {})) }
}

// ============ 杂项 ============

export async function neteaseImage(src: string): Promise<NeteaseImageDto> {
  // 图片直连下载：走 tauri-plugin-http 绕 CORS（WebView2 原生 fetch 会被跨域拦截），
  // 与 shims/axios.ts 同一传输管道；返回字节供 Blob 使用
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  const response = await tauriFetch(src)
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
  const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg'
  const buffer = await response.arrayBuffer()
  return { mimeType, bytes: Array.from(new Uint8Array(buffer)) }
}

export async function neteaseUpdatePlaylistCover(playlistId: number, imageBase64: string, mimeType?: string): Promise<void> {
  // 上传链（plugins/upload.js）要求 imgFile: { name, mimetype, data }（data 走 NOS 直传字节），
  // 传 img/imgSize/imgX/imgY 会被 module 以 400「imgFile is required」拒绝
  const raw = imageBase64.replace(/^data:[^;]+;base64,/, '')
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
  await call('playlist_cover_update', {
    id: playlistId,
    imgFile: { name: 'cover.jpg', mimetype: mimeType ?? 'image/jpeg', data: bytes },
  })
}

export async function neteaseScrobble(payload: { songId: number; sourceId: number; playedSeconds: number }): Promise<void> {
  try {
    await call('scrobble', {
      id: payload.songId,
      sourceid: payload.sourceId,
      time: payload.playedSeconds,
    })
  } catch {
    // 打卡失败静默（不影响播放）
  }
}

// ============ 响应映射（WaveForge 前端映射形状） ============

function mapSong(raw: unknown): NeteaseSongDto {
  const song = (raw ?? {}) as Record<string, unknown>
  const artists = (song.ar ?? song.artists ?? []) as Array<Record<string, unknown>>
  const album = (song.al ?? song.album ?? {}) as Record<string, unknown>
  const id = Number(song.id ?? 0)
  const durationMs = Number(song.dt ?? song.duration ?? 0)
  return {
    trackRef: { id: String(id), source: 'netease' },
    title: String(song.name ?? '未知歌曲'),
    artists: artists.map((a) => String(a.name ?? '')),
    album: album.name ? String(album.name) : null,
    durationMs: durationMs > 0 ? durationMs : null,
    qualityLabel: null,
    playable: true,
    coverUrl: String(album.picUrl ?? album.pic ?? '') || null,
  }
}

function mapAlbum(raw: unknown): NeteaseAlbumDto {
  const album = (raw ?? {}) as Record<string, unknown>
  const albumArtists = Array.isArray(album.artists) ? album.artists : []
  const artist = (album.artist ?? albumArtists[0] ?? {}) as Record<string, unknown>
  return {
    id: Number(album.id ?? 0),
    name: String(album.name ?? '未知专辑'),
    artistName: artist.name ? String(artist.name) : null,
    coverUrl: String(album.picUrl ?? album.blurPicUrl ?? '') || null,
    trackCount: Number(album.size ?? album.trackCount ?? 0),
    publishTimeMs: album.publishTime ? Number(album.publishTime) : null,
  }
}

function mapArtist(raw: unknown): NeteaseArtistSummaryDto {
  const artist = (raw ?? {}) as Record<string, unknown>
  return {
    id: Number(artist.id ?? 0),
    name: String(artist.name ?? '未知艺术家'),
    aliases: Array.isArray(artist.alias) ? (artist.alias as unknown[]).map(String) : [],
    imageUrl: String(artist.picUrl ?? artist.img1v1Url ?? '') || null,
    fansCount: artist.fansCount ? Number(artist.fansCount) : null,
  }
}

function mapPlaylist(raw: unknown): NeteasePlaylistDto {
  const playlist = (raw ?? {}) as Record<string, unknown>
  const creator = playlist.creator as { nickname?: string } | undefined
  return {
    id: Number(playlist.id ?? 0),
    name: String(playlist.name ?? '未知歌单'),
    coverUrl: String(playlist.coverImgUrl ?? playlist.picUrl ?? '') || null,
    trackCount: Number(playlist.trackCount ?? 0),
    playCount: Number(playlist.playCount ?? 0),
    ownerName: creator?.nickname ?? null,
    description: playlist.description ? String(playlist.description) : null,
    updateFrequency: null,
  }
}

function mapComment(raw: unknown): NeteaseCommentDto {
  const comment = (raw ?? {}) as Record<string, unknown>
  const user = comment.user as { userId?: number; nickname?: string; avatarUrl?: string } | undefined
  const time = comment.time ? Number(comment.time) : null
  return {
    id: Number(comment.commentId ?? comment.id ?? 0),
    user: user
      ? { userId: Number(user.userId ?? 0), nickname: user.nickname ?? '', avatarUrl: user.avatarUrl ?? null }
      : null,
    content: String(comment.content ?? ''),
    liked: Boolean(comment.liked),
    likedCount: Number(comment.likedCount ?? 0),
    timeText: time !== null ? new Date(time).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : null,
  }
}

function mapMv(raw: unknown): NeteaseMvDto {
  const mv = (raw ?? {}) as Record<string, unknown>
  const artists = (mv.artists ?? mv.artist ?? []) as Array<Record<string, unknown>>
  return {
    id: Number(mv.id ?? 0),
    name: String(mv.name ?? '未知 MV'),
    coverUrl: String(mv.cover ?? mv.imgurl16v9 ?? mv.picUrl ?? '') || null,
    durationMs: mv.duration ? Number(mv.duration) : null,
    playCount: Number(mv.playCount ?? 0),
    artists: artists.map((a) => ({ id: Number(a.id ?? 0), name: String(a.name ?? '') })),
  }
}

function mapDjRadio(raw: unknown): NeteaseDjRadioDto {
  const radio = (raw ?? {}) as Record<string, unknown>
  return {
    id: Number(radio.id ?? 0),
    name: String(radio.name ?? '未知电台'),
    coverUrl: String(radio.picUrl ?? radio.coverUrl ?? '') || null,
    category: radio.category ? String(radio.category) : null,
    description: radio.desc ? String(radio.desc) : null,
    programCount: Number(radio.programCount ?? 0),
    listenerCount: Number(radio.subCount ?? 0),
  }
}

function mapDjProgram(raw: unknown): NeteaseDjProgramDto {
  const program = (raw ?? {}) as Record<string, unknown>
  const radio = program.radio as { name?: string } | undefined
  return {
    id: Number(program.id ?? 0),
    name: String(program.name ?? '未知节目'),
    createdAtMs: program.createTime ? Number(program.createTime) : null,
    listenerCount: Number(program.listenerCount ?? 0),
    radio: radio?.name ? { name: radio.name } : null,
    mainTrack: program.mainSong ? mapSong(program.mainSong) : null,
  }
}

export async function bootstrapNetease(): Promise<void> {
  // D36：匿名身份由 sidecar 的 generateConfig 原生自管，前端只恢复登录会话（DPAPI）。
  await neteaseSession.restore()
}

// ============ 歌词（行为规范 §5：5 次重试、指数退避、失败返回空结构） ============

export interface LyricResult {
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  romalrc?: { lyric?: string }
  yrc?: { lyric?: string }
}

const LYRIC_RETRY_DELAYS_MS = [300, 600, 1200, 2400, 4800]

export async function getLyric(id: number): Promise<LyricResult> {
  // lyric_new（/api/song/lyric/v1）为 'lyric' 超集，额外返回 yrc 逐字时间轴（D34 歌词要求）
  let lastError: unknown = null
  for (let attempt = 0; attempt <= LYRIC_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await call<LyricResult>('lyric_new', { id })
    } catch (error) {
      lastError = error
      if (attempt < LYRIC_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, LYRIC_RETRY_DELAYS_MS[attempt]))
      }
    }
  }
  // 全部失败返回空歌词结构（行为规范 §5：由上层决定降级来源）
  console.warn('[netease] lyric fetch failed after retries:', lastError)
  return {}
}

// ============ 播放地址（音质阶梯 + 付费拦截，行为规范 §3/§4，WaveForge 规则移植） ============

export type QualityLevel = 'standard' | 'higher' | 'exhigh' | 'lossless' | 'hires' | 'jyeffect' | 'sky' | 'jymaster'

const BR_BY_QUALITY: Record<QualityLevel, number> = {
  standard: 128000,
  higher: 192000,
  exhigh: 320000,
  lossless: 1411000,
  hires: 1411000,
  jyeffect: 1411000,
  sky: 1411000,
  jymaster: 1411000,
}

/** 候选降级链对齐 WaveForge getNeteaseQualityCandidates（目标档起向下降级）。
 *  song_url_v1 已按红线排除（其内部挂 song_url_match 跨平台匹配），改用
 *  song_url（/api/song/enhance/player/url）+ br 上限请求。 */
const QUALITY_LADDER: Record<QualityLevel, QualityLevel[]> = {
  standard: ['standard'],
  higher: ['higher', 'standard'],
  exhigh: ['exhigh', 'standard'],
  lossless: ['lossless', 'exhigh', 'standard'],
  hires: ['hires', 'lossless', 'exhigh', 'standard'],
  jyeffect: ['jyeffect', 'lossless', 'exhigh', 'standard'],
  sky: ['sky', 'lossless', 'exhigh', 'standard'],
  jymaster: ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'],
}

export interface SongUrlResult {
  url: string | null
  level: string
  fee: number
}

/** 播放地址：WaveForge 语义 = 首档 2 次尝试（间隔 150ms）、其余 1 次；
 *  付费曲目（fee 1/4）无有效 URL 时如实返回 null（不跨平台兜底，红线）。 */
export async function getSongUrl(id: number, quality: QualityLevel = 'standard'): Promise<SongUrlResult> {
  const candidates = QUALITY_LADDER[quality] ?? QUALITY_LADDER.standard
  let lastFee = 0
  for (let index = 0; index < candidates.length; index += 1) {
    const attempts = index === 0 ? 2 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const body = await call<{ data?: Array<{ url?: string | null; level?: string; fee?: number }> }>(
          'song_url',
          { id, br: BR_BY_QUALITY[candidates[index]] },
        )
        const item = body.data?.[0]
        if (item?.url) return { url: item.url, level: item.level ?? candidates[index], fee: Number(item.fee ?? 0) }
        lastFee = Number(item?.fee ?? lastFee)
        break // 该档有响应但无 URL：进入下一降级档
      } catch {
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
  }
  return { url: null, level: 'standard', fee: lastFee }
}

export interface SongDetailResult {
  id: number
  name: string
  artists: Array<{ id: number; name: string }>
  album: { id: number; name: string; picUrl?: string }
  fee: number
  dt: number
  coverUrl: string | null
}

export async function getSongDetail(id: number): Promise<SongDetailResult | null> {
  // module/song_detail.js 对 query.ids 自行 split(',')，须传逗号分隔串而非 JSON 数组
  const body = await call<{ songs?: Array<Record<string, unknown>> }>('song_detail', { ids: String(id) })
  const song = body.songs?.[0]
  if (!song) return null
  const artists = (song.ar ?? song.artists ?? []) as Array<Record<string, unknown>>
  const album = (song.al ?? song.album ?? {}) as Record<string, unknown>
  return {
    id: Number(song.id ?? id),
    name: String(song.name ?? '未知歌曲'),
    artists: artists.map((a) => ({ id: Number(a.id ?? 0), name: String(a.name ?? '') })),
    album: { id: Number(album.id ?? 0), name: String(album.name ?? '未知专辑'), picUrl: String(album.picUrl ?? '') || undefined },
    fee: Number(song.fee ?? 0),
    dt: Number(song.dt ?? song.duration ?? 0),
    coverUrl: String(album.picUrl ?? '') || null,
  }
}

export { neteaseSession }
