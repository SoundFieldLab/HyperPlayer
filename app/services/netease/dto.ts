// 网易云服务层 DTO（UI 消费面，形状对齐 vendor 协议响应 + WaveForge 前端映射）

// 歌曲形状与 bridge/contracts 的 BackendTrackDto 结构兼容（trackRef/title/artists/
// album/durationMs/qualityLabel/playable），使既有 adaptTrack 映射可直接复用。
export interface NeteaseTrackRef {
  id: string
  source: 'netease' | 'local'
}

export interface NeteaseSongDto {
  trackRef: NeteaseTrackRef
  title: string
  artists: string[]
  album: string | null
  durationMs: number | null
  qualityLabel: string | null
  playable: boolean
  /** 协议响应中的原始 song 字段（映射过程保留；云盘条目自引用便于 adaptTrack） */
  track?: NeteaseSongDto
}

export interface NeteaseAlbumDto {
  id: number
  name: string
  artistName: string | null
  coverUrl: string | null
  trackCount: number
  publishTimeMs: number | null
}

export interface NeteaseArtistSummaryDto {
  id: number
  name: string
  aliases: string[]
  imageUrl: string | null
  fansCount: number | null
  briefDescription?: string | null
}

export interface NeteasePlaylistDto {
  id: number
  name: string
  coverUrl: string | null
  trackCount: number
  playCount: number
  ownerName: string | null
  description: string | null
  updateFrequency: string | null
}

export interface NeteaseStatusDto {
  enabled: boolean
  authenticated: boolean
  displayName: string | null
  userId: number | null
}

export interface NeteaseUserProfileDto {
  userId: number
  nickname: string
  avatarUrl: string | null
  signature: string | null
}

export interface NeteaseVipStatusDto {
  active: boolean
  level: number | null
  verifiedAtMs: number
}

export interface NeteaseAccountDto {
  user: NeteaseUserProfileDto
  vip: NeteaseVipStatusDto
}

export interface NeteaseLoginStartDto {
  loginId: string
  qrImageDataUrl: string
}

export type NeteaseLoginPhase = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed'

export interface NeteaseLoginStateDto {
  phase: NeteaseLoginPhase
}

export interface NeteaseSearchPageDto {
  tracks: NeteaseSongDto[]
  albums: NeteaseAlbumDto[]
  artists: NeteaseArtistSummaryDto[]
  playlists: NeteasePlaylistDto[]
  nextCursor: string | null
}

export interface NeteaseSearchSuggestionsDto {
  songs: NeteaseSongDto[]
}

export interface NeteaseHomeDto {
  recommendedTracks: NeteaseSongDto[]
  recommendedPlaylists: NeteasePlaylistDto[]
  anonymous: boolean
  unavailableSections: string[]
}

export interface NeteaseBannerDto {
  id: number
  imageUrl: string
  title: string
  targetUrl: string | null
}

export interface NeteaseChartDto {
  id: number
  name: string
  coverUrl: string | null
  updateFrequency: string | null
  previewTracks: Array<{ trackRef: NeteaseTrackRef; title: string; artists: string[] }>
}

export interface NeteaseNewSongsDto {
  tracks: NeteaseSongDto[]
}

export interface NeteaseAlbumDetailDto {
  album: NeteaseAlbumDto
  artist: NeteaseArtistSummaryDto | null
  description: string | null
  tracks: NeteaseSongDto[]
}

export interface NeteaseArtistDetailDto {
  artist: NeteaseArtistSummaryDto
  fansCount: number | null
  introduction: string | null
  hotTracks: NeteaseSongDto[]
}

export interface NeteasePlaylistDetailDto {
  playlist: NeteasePlaylistDto
  tracks: NeteaseSongDto[]
}

export interface NeteaseRelatedPlaylistsDto {
  playlists: NeteasePlaylistDto[]
  nextCursor: string | null
}

export interface NeteaseSimilarArtistsDto {
  artists: NeteaseArtistSummaryDto[]
  nextCursor: string | null
}

export interface NeteaseCommentDto {
  id: number
  user: { userId: number; nickname: string; avatarUrl: string | null } | null
  content: string
  liked: boolean
  likedCount: number
  timeText: string | null
}

export interface NeteaseCommentPageDto {
  comments: NeteaseCommentDto[]
  total: number
  nextCursor: string | null
}

export interface NeteaseMutationDto {
  kind: 'addComment' | 'replyComment' | 'setCommentFavorite' | 'deleteComment'
  resource: 'song' | 'mv' | 'playlist' | 'album' | 'radio' | 'video' | 'event' | 'digitalAlbum'
  resourceId: number
  commentId?: number
  content?: string
  favorite?: boolean
}

export interface NeteaseMvDto {
  id: number
  name: string
  coverUrl: string | null
  durationMs: number | null
  playCount: number
  artists: Array<{ id: number; name: string }>
}

export interface NeteaseMvDetailDto {
  mv: NeteaseMvDto
  description: string | null
  favoriteCount: number
  commentCount: number
  publishTime: string | null
}

export interface NeteaseMvPlaybackDto {
  url: string | null
}

export interface NeteaseMvsPageDto {
  items: NeteaseMvDto[]
  nextCursor: string | null
}

export interface NeteaseDjRadioDto {
  id: number
  name: string
  coverUrl: string | null
  category: string | null
  description: string | null
  programCount: number
  listenerCount: number
}

export interface NeteaseDjRadiosPageDto {
  radios: NeteaseDjRadioDto[]
  nextCursor: string | null
}

export interface NeteaseDjProgramDto {
  id: number
  name: string
  createdAtMs: number | null
  listenerCount: number
  radio: { name: string } | null
  mainTrack: NeteaseSongDto | null
}

export interface NeteaseDjProgramsPageDto {
  programs: NeteaseDjProgramDto[]
  nextCursor: string | null
}

export interface NeteaseDjCategoriesDto {
  categories: Array<{ id: number; name: string }>
}

export interface NeteaseDjRecommendDto {
  radios: NeteaseDjRadioDto[]
}

export interface NeteaseDjProgramToplistDto {
  programs: NeteaseDjProgramDto[]
}

export interface NeteaseFavoritesDto {
  playlists: NeteasePlaylistDto[]
  likedTrackIds: number[]
}

export interface NeteaseCloudDto {
  songs: NeteaseSongDto[]
}

export interface NeteaseFollowUserDto {
  userId: number
  nickname: string
  avatarUrl: string | null
}

export interface NeteaseNoticesPageDto {
  items: Array<{
    id: number
    title: string | null
    text: string | null
    occurredAtMs: number | null
    user: { nickname: string; avatarUrl: string | null } | null
  }>
}

export interface NeteaseFollowedEventsPageDto {
  items: Array<{
    id: number
    eventType: string | null
    text: string | null
    occurredAtMs: number | null
    user: { nickname: string; avatarUrl: string | null } | null
    track: { title: string; artists: string[] } | null
  }>
}

export interface NeteaseIntelligenceListDto {
  tracks: NeteaseSongDto[]
}

export interface NeteaseImageDto {
  mimeType: string
  bytes: number[]
}

export interface NeteaseListenReportDto {
  succeeded: boolean
}

export interface NeteaseListenStatsDto {
  total: number | null
  rank: number | null
}
