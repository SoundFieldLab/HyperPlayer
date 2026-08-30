/** 网易云音源领域类型。时间均为毫秒。 */

export type QualityLevel =
  | 'standard'
  | 'higher'
  | 'exhigh'
  | 'lossless'
  | 'hires'
  | 'jyeffect'
  | 'sky'
  | 'jymaster'

export type QualityPreference = 'standard' | 'high' | 'very-high' | 'lossless' | 'hi-res' | 'auto'

/** 原始响应透传（次要端点不做深度建模） */
export type RawBody = Record<string, unknown>

export function asRecord(value: unknown): RawBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RawBody) : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export interface TrackArtist {
  id: number
  name: string
}

export interface TrackAlbum {
  id: number
  name: string
  picUrl?: string
}

export interface Track {
  id: number
  name: string
  artists: TrackArtist[]
  album: TrackAlbum
  durationMs: number
  /** 0免费 1VIP 4购买专辑 8低音质免费 */
  fee: number
  mvId?: number
  /** fee 1/4 */
  isVip?: boolean
  /** privilege.st<0 或 playMaxbr=0 */
  noCopyright?: boolean
}

export interface QualityOption {
  key: string
  label: string
  bitrate: number
  sizeBytes: number
  sampleRate?: number
}

export interface PlayInfo {
  id: number
  url: string | null
  level: QualityLevel
  bitrate: number
  sizeBytes: number
  md5: string
  containerType: string
  fee: number
  freeTrialInfo: { start: number; end: number } | null
  /** fee 1/4 且无可用 url：付费内容，禁止备用音源 */
  isPaidContent: boolean
}

export interface PlaylistSummary {
  id: number
  name: string
  coverUrl?: string
  trackCount: number
  playCount?: number
  ownerId: number
  ownerName?: string
  description?: string
}

export interface PlaylistDetail extends PlaylistSummary {
  tracks: Track[]
  trackIds: number[]
}

export interface ArtistSummary {
  id: number
  name: string
  picUrl?: string
  alias?: string[]
  briefDesc?: string
  fansCount?: number
}

export interface MvSummary {
  id: number
  name: string
  cover?: string
  durationMs?: number
  artists?: TrackArtist[]
  playCount?: number
}

export interface MvPlayInfo {
  id: number
  url: string | null
  resolution: number
  sizeBytes?: number
}

export interface UserAccount {
  userId: number
  nickname: string
  avatarUrl?: string
}

export interface UserDetail extends UserAccount {
  signature?: string
  province?: number
  city?: number
  followCount?: number
  fanCount?: number
  playlistCount?: number
  listenSongs?: number
}

export interface CommentItem {
  id: number
  content: string
  timeStr?: string
  likedCount?: number
  liked?: boolean
  userNickname?: string
  userAvatarUrl?: string
  replyCount?: number
}

export interface CommentPage {
  comments: CommentItem[]
  totalCount: number
  hasMore: boolean
  cursor: string
  hotComments?: CommentItem[]
}

export interface LoginQrState {
  state: 'expired' | 'waiting' | 'scanned' | 'authorized'
  cookie?: string
  qrUrl?: string
}

export interface VipInfo {
  isVip: boolean
  expireTime?: number
  redVipLevel?: number
}
