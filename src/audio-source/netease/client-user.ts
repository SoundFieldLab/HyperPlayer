/**
 * 用户端点：账号/登录态/详情/歌单、听歌记录、云盘、VIP、听歌足迹、journey 聚合。
 */
import { DOMAIN_CLIENTLOG } from './config'
import { callEapi, callEapiRaw, callWeapi, callWeapiRaw, withRetry, type CallOptions } from './request'
import { mapTrack } from './client-core'
import { ensureSession } from './session'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  type PlaylistSummary,
  type RawBody,
  type Track,
  type UserDetail,
} from './types'

/* ------------------------------- 账号/登录态 ------------------------------- */

/** 当前账号（未登录 profile 为空） */
export async function getUserAccount(options: CallOptions = {}): Promise<{ userId: number; nickname: string; avatarUrl?: string } | null> {
  const body = await callWeapi<RawBody>('/api/nuser/account/get', {}, options)
  const profile = asRecord(body.profile)
  if (!profile.userId) return null
  return { userId: asNumber(profile.userId), nickname: asString(profile.nickname), avatarUrl: asString(profile.avatarUrl) || undefined }
}

/** 登录态校验（w/ 前缀端点，返回原始数据含 cookie 续期信息） */
export async function getLoginStatus(options: CallOptions = {}): Promise<RawBody> {
  const body = await callWeapi<RawBody>('/api/w/nuser/account/get', {}, options)
  return { data: body }
}

/** 扫码登录 key */
export async function createLoginQrKey(options: CallOptions = {}): Promise<string> {
  const body = await withRetry(() => callEapiRaw<{ data?: { unikey?: string } }>('/api/login/qrcode/unikey', { type: 3 }, options), 3)
  const key = asString(asRecord(body.data).unikey)
  if (!key) throw new Error('二维码 key 获取失败')
  return key
}

export function getLoginQrImageUrl(key: string): string {
  return `https://music.163.com/login?codekey=${encodeURIComponent(key)}`
}

/** 扫码状态轮询：800 过期 801 待扫 802 已扫 803 授权（附 cookie） */
export async function checkLoginQrState(key: string, options: CallOptions = {}): Promise<import('./types').LoginQrState> {
  const body = await callEapiRaw<{ code?: number; cookie?: string[] }>('/api/login/qrcode/client/login', { key, type: 3 }, options)
  switch (Number(body.code)) {
    case 800:
      return { state: 'expired' }
    case 802:
      return { state: 'scanned' }
    case 803:
      return { state: 'authorized', cookie: (body.cookie ?? []).join(';') }
    case 801:
    default:
      return { state: 'waiting' }
  }
}

/* ------------------------------- 用户资料 ------------------------------- */

/** 用户详情 */
export async function getUserDetail(uid: number | string, options: CallOptions = {}): Promise<UserDetail> {
  const body = await callWeapi<RawBody>(`/api/v1/user/detail/${Number(uid)}`, {}, options)
  const profile = asRecord(body.profile)
  return {
    userId: asNumber(profile.userId, Number(uid)),
    nickname: asString(profile.nickname),
    avatarUrl: asString(profile.avatarUrl) || undefined,
    signature: asString(profile.signature) || undefined,
    province: asNumber(profile.province) || undefined,
    city: asNumber(profile.city) || undefined,
    followCount: asNumber(asRecord(body).follows) || undefined,
    fanCount: asNumber(asRecord(body).followeds) || undefined,
    playlistCount: asNumber(asRecord(body).playlistCount) || undefined,
    listenSongs: asNumber(asRecord(body).listenSongs) || undefined,
  }
}

/** 用户歌单 */
export async function getUserPlaylists(
  uid: number | string,
  { limit = 30, offset = 0 }: { limit?: number; offset?: number } = {},
  options: CallOptions = {},
): Promise<PlaylistSummary[]> {
  const body = await callWeapi<RawBody>('/api/user/playlist', { uid: Number(uid), limit, offset, includeVideo: true }, options)
  return asArray(body.playlist).map((item) => {
    const record = asRecord(item)
    return {
      id: asNumber(record.id),
      name: asString(record.name),
      coverUrl: asString(record.coverImgUrl) || undefined,
      trackCount: asNumber(record.trackCount),
      playCount: asNumber(record.playCount) || undefined,
      ownerId: asNumber(asRecord(record.creator).userId ?? record.userId),
      ownerName: asString(asRecord(record.creator).nickname) || undefined,
    }
  })
}

/* ------------------------------- 听歌记录 ------------------------------- */

/** 听歌排行（type 0 全部 / 1 每周） */
export async function getUserPlayRecord(uid: number | string, { type = 0 }: { type?: 0 | 1 } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/v1/play/record', { uid: Number(uid), type }, options)
}

const RECENT_PATHS: Record<string, string> = {
  song: 'song',
  playlist: 'playlist',
  album: 'album',
  dj: 'djradio',
  voice: 'voice',
  video: 'newvideo',
}

/** 最近播放（song/playlist/album/dj/voice/video，上限 100） */
export async function getRecentPlays(
  type: keyof typeof RECENT_PATHS,
  { limit = 100 }: { limit?: number } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  const path = RECENT_PATHS[type]
  if (!path) throw new Error('不支持的最近播放类型')
  return callWeapi<RawBody>(`/api/play-record/${path}/list`, { limit: Math.max(1, Math.min(limit, 100)) }, options)
}

/** 听歌打卡（startplay + play 两次 weblog，进最近播放与听歌排行计数；cookie 注入 os=osx） */
export async function scrobble(
  id: number | string,
  sourceId: number | string,
  playedSeconds: number,
  options: CallOptions = {},
): Promise<{ synced: boolean }> {
  await ensureSession()
  const cookieWithOsx = (options.cookie ?? '').replace(/os=[^;]+/g, 'os=osx') || 'os=osx'
  const userCookie = options.cookie ?? ''
  const mergedCookie = userCookie.includes('os=') ? cookieWithOsx : `${userCookie ? `${userCookie}; ` : ''}os=osx`
  const buildLog = (action: string, extra: Record<string, unknown>) =>
    JSON.stringify([{ action, json: { type: 'song', mainsite: '1', mainsiteWeb: '1', ...extra } }])
  const option = { ...options, cookie: mergedCookie, domain: DOMAIN_CLIENTLOG }

  await callEapiRaw<RawBody>(
    '/api/feedback/weblog',
    { logs: buildLog('startplay', { id: Number(id), content: `id=${Number(sourceId)}` }) },
    option,
  )
  const playResult = await callEapiRaw<RawBody>(
    '/api/feedback/weblog',
    {
      logs: buildLog('play', {
        download: 0,
        end: 'playend',
        id: Number(id),
        sourceId: Number(sourceId),
        time: Math.max(1, Math.floor(playedSeconds)),
        wifi: 0,
        source: 'list',
        content: `id=${Number(sourceId)}`,
      }),
    },
    option,
  )
  return { synced: asNumber(asRecord(playResult).code, 200) === 200 }
}

/* --------------------------- 听歌足迹 / 偏好 / 等级 --------------------------- */

/** 听歌足迹：总时长 */
export async function getListenDataTotal(options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/content/activity/listen/data/total', {}, options)
}

/** 听歌足迹：周/月/年报告 */
export async function getListenDataReport({ type = 'month', endTime }: { type?: 'week' | 'month' | 'year'; endTime?: string } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/content/activity/listen/data/report', { type, endTime }, options)
}

/** 听歌足迹：歌曲播放排行 Top20 */
export async function getListenDataSongRank({ type = 'month', endTime }: { type?: 'week' | 'month'; endTime?: string } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/content/activity/listen/data/song/play/rank', { type, endTime }, options)
}

/** 听歌足迹：今日收听 */
export async function getListenDataToday(options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/content/activity/listen/data/today/song/play/rank', {}, options)
}

/** 曲风偏好 */
export async function getStylePreference(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/tag/my/preference/get', {}, options)
}

/** 用户等级 */
export async function getUserLevel(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/user/level', {}, options)
}

/** 收藏计数总览 */
export async function getUserSubcount(options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/subcount', {}, options)
}

/* --------------------------------- 云盘 --------------------------------- */

/** 云盘歌曲列表 */
export async function getCloudDiskSongs({ limit = 30, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/v1/cloud/get', { limit, offset }, options)
}

/** 云盘歌曲播放地址（http → https） */
export async function getCloudSongUrl(id: number | string, options: CallOptions = {}): Promise<string | null> {
  const body = await callEapi<RawBody>('/api/cloud/dowonload', { songId: Number(id) }, options)
  const url = asString(asRecord(asArray(body.data)[0]).url)
  return url ? url.replace(/^http:\/\//, 'https://') : null
}

/** 删除云盘歌曲 */
export async function deleteCloudSong(id: number | string, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/cloud/del', { songIds: [Number(id)] }, options)
}

/* --------------------------------- VIP --------------------------------- */

/** VIP 信息 */
export async function getVipInfo(options: CallOptions = {}): Promise<{ isVip: boolean; raw: RawBody }> {
  const account = await getUserAccount(options)
  const body = await callWeapi<RawBody>('/api/music-vip-membership/client/vip/info', { userId: account?.userId ?? '' }, options)
  const data = asRecord(body.data)
  return {
    isVip: asNumber(asRecord(data.redVipLevel ?? data).redVipLevel, 0) > 0 || asNumber(data.vipLevel, 0) > 0,
    raw: body,
  }
}

/* ------------------------------- journey 聚合 ------------------------------- */

export interface JourneyPart {
  available: boolean
  error?: string
  data?: unknown
}

async function journeyPart<T>(task: () => Promise<T>): Promise<JourneyPart & { data?: T }> {
  try {
    return { available: true, data: await task() }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function normalizeJourneySongs(payload: unknown, preferredKeys: string[]): Track[] {
  const source = asRecord(payload)
  for (const key of preferredKeys) {
    const list = asArray(source[key])
    if (list.length > 0) {
      return list.map((item) => {
        const record = asRecord(item)
        return mapTrack(record.song ?? record.resource ?? record)
      })
    }
  }
  return []
}

/** 网易云旅程概览：8 项并行（全部降级为 available/error 结构） */
export async function getJourneyOverview(
  uid: number | string,
  options: CallOptions = {},
): Promise<{
  uid: string
  rank: JourneyPart & { songs: Track[] }
  report: JourneyPart & { monthlySongs: Track[]; todaySongs: Track[]; total?: unknown; period?: unknown; monthlyRank?: unknown; todayRank?: unknown }
  preference: JourneyPart
  archive: JourneyPart & { level?: unknown; subcount?: unknown }
}> {
  const [record, total, report, monthlyRank, todayRank, preference, level, subcount] = await Promise.all([
    journeyPart(() => callWeapi<RawBody>('/api/v1/play/record', { uid: Number(uid), type: 0 }, options)),
    journeyPart(() => callEapi<RawBody>('/api/content/activity/listen/data/total', {}, options)),
    journeyPart(() => callEapi<RawBody>('/api/content/activity/listen/data/report', { type: 'month' }, options)),
    journeyPart(() => callEapi<RawBody>('/api/content/activity/listen/data/song/play/rank', { type: 'month' }, options)),
    journeyPart(() => callEapi<RawBody>('/api/content/activity/listen/data/today/song/play/rank', {}, options)),
    journeyPart(() => callWeapi<RawBody>('/api/tag/my/preference/get', {}, options)),
    journeyPart(() => callWeapi<RawBody>('/api/user/level', {}, options)),
    journeyPart(() => callWeapi<RawBody>('/api/subcount', {}, options)),
  ])

  return {
    uid: String(uid),
    rank: { ...record, songs: normalizeJourneySongs(record.data, ['allData', 'weekData']) },
    report: {
      available: total.available || report.available || monthlyRank.available || todayRank.available,
      error: [total.error, report.error, monthlyRank.error, todayRank.error].filter(Boolean).join('；') || undefined,
      data: undefined,
      total: total.data,
      period: report.data,
      monthlyRank: monthlyRank.data,
      todayRank: todayRank.data,
      monthlySongs: normalizeJourneySongs(monthlyRank.data, ['songPlayRank', 'rankList']),
      todaySongs: normalizeJourneySongs(todayRank.data, ['songPlayRank', 'rankList']),
    },
    preference,
    archive: {
      available: level.available || subcount.available,
      error: [level.error, subcount.error].filter(Boolean).join('；') || undefined,
      level: level.data,
      subcount: subcount.data,
    },
  }
}
