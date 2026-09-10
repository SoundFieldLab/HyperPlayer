import type { Song } from '../../services/musicApi'
import type { ExploreChannel, ExplorePlaylist } from '../../services/exploreApi'

// src/features/neteaseExplore/model.ts

export type NeteaseResourceAction =
  | { type: 'song'; song: Song }
  | { type: 'comments'; song: Song }
  | { type: 'playlist'; playlist: ExplorePlaylist; autoplay: boolean }
  | { type: 'album'; id: string }
  | { type: 'radio'; channel: ExploreChannel }
  | { type: 'program'; id: string }
  | { type: 'artist'; id: string }
  | { type: 'user'; id: string }
  | { type: 'mv'; id: string }
  | { type: 'web'; url: string }
  | { type: 'podcast-section'; section: 'mine' | 'categories' }
  | { type: 'none' }

export interface NeteaseNativeResource {
  id: string
  type: string
  title: string
  subtitle: string
  coverUrl: string
  purePictureUrl: string
  purePicture: boolean
  purePicName: string
  recommendationShowType: string
  actionUrl: string
  action: NeteaseResourceAction
  alg: string
  playCount?: number
  favoriteCount?: number
  isFavorite?: boolean
  song?: Song
  playlist?: ExplorePlaylist
  raw: Record<string, any>
}

export interface NeteaseNativeBlock {
  id: string
  blockCode: string
  showType: string
  title: string
  subtitle: string
  resources: NeteaseNativeResource[]
  raw: Record<string, any>
}

export interface NeteaseNativeHome {
  accountScoped: boolean
  generatedAt: number
  cursor: string
  hasMore: boolean
  blockCodeOrderList: string[]
  exposedResource: string
  blocks: NeteaseNativeBlock[]
  rawBlocks: Record<string, any>[]
}

export interface NeteaseNativeFlow {
  hasMore: boolean
  resources: NeteaseNativeResource[]
}

function textOf(value: any): string {
  if (typeof value === 'string') return value
  return String(value?.title || value?.text || value?.name || '')
}

function imageOf(value: any): string {
  const image = typeof value === 'string'
    ? value
    : value?.imageUrl || value?.backupImageUrl || value?.picUrl || value?.coverUrl || value?.coverImgUrl || value?.coverImageUrl || ''
  return String(image).replace(/^http:/, 'https:')
}

function songOf(value: any): Song | undefined {
  const source = value?.songData || value?.song || value?.mainSong || value?.resourceExtInfo?.songData || value?.resourceExtInfo?.song || value?.creativeExtInfoVO?.songData || value?.creativeExtInfoVO?.song || value?.creativeExtInfoVO?.djProgram?.mainSong
  if (!source) return undefined
  const track = source?.simpleSong || source
  const id = Number(track?.id || 0)
  if (!id || !track?.name) return undefined
  const album = track.al || track.album || {}
  const artists = track.ar || track.artists || []
  return {
    id,
    name: String(track.name),
    artists: (Array.isArray(artists) ? artists : []).map((artist: any) => ({ id: Number(artist?.id) || undefined, name: String(artist?.name || '未知歌手') })),
    album: { id: Number(album?.id) || undefined, name: String(album?.name || ''), picUrl: imageOf(album) || imageOf(value?.uiElement?.image) || imageOf(value) },
    duration: Number(track.dt || track.duration || 0),
    platform: 'netease',
    fee: Number(track.fee || 0),
    vip: Number(track.fee) === 1,
    requiredTier: Number(track.fee) === 1 ? 'vip' : 'free',
    noCopyright: Number(track.privilege?.st) < 0,
    commentCount: Number(track.commentCount || value?.resourceInteractInfo?.commentCount || 0) || undefined,
  }
}

function recursiveCandidates(value: any, output: Record<string, any>[], seen: Set<any>, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10 || seen.has(value)) return
  seen.add(value)
  const hasNestedResources = Array.isArray(value.resources) && value.resources.length > 0
  const hasEmbeddedSong = Boolean(value.song || value.songData || value.resourceExtInfo?.song || value.resourceExtInfo?.songData || value.creativeExtInfoVO?.song || value.creativeExtInfoVO?.songData)
  const isProgramObject = Boolean(value.id && value.mainSong && value.radio)
  const isCreative = value.creativeId != null
  const isResource = value.resourceId != null
  if (isResource || isProgramObject || hasEmbeddedSong || (isCreative && !hasNestedResources)) output.push(value)
  if ((isCreative && !hasNestedResources) || isProgramObject) return
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => recursiveCandidates(item, output, seen, depth + 1))
    else recursiveCandidates(child, output, seen, depth + 1)
  }
}

function numericIdFromAction(action: string, kind: string): string {
  const direct = action.match(new RegExp(`orpheus:\\/\\/(?:nm\\/)?${kind}\\/(\\d+)`, 'i'))
  if (direct?.[1]) return direct[1]
  try {
    const parsed = new URL(action)
    return parsed.searchParams.get('id') || parsed.searchParams.get(`${kind}Id`) || ''
  } catch {
    return ''
  }
}

function safeWebUrl(action: string): string {
  if (/^https:\/\//i.test(action)) return action
  if (!/^orpheus:\/\/(?:openurl|rnpage|miniProgram)/i.test(action)) return ''
  try {
    const parsed = new URL(action)
    for (const key of ['url', 'fallbackURL', 'fallbackUrl']) {
      const candidate = parsed.searchParams.get(key)
      if (candidate && /^https:\/\//i.test(candidate)) return candidate
    }
  } catch {
    return ''
  }
  return ''
}

function channelOf(value: any, id: string, title: string, subtitle: string, coverUrl: string): ExploreChannel {
  return {
    id,
    name: title || value?.radio?.name || '网易云播客',
    group: String(value?.category || value?.radio?.category || '播客'),
    description: subtitle || String(value?.description || value?.radio?.desc || ''),
    coverUrl,
    playCount: Number(value?.playCount || value?.listenerCount || value?.subCount || 0) || undefined,
    platform: 'netease',
  }
}

function actionOf(value: any, type: string, id: string, actionUrl: string, title: string, subtitle: string, coverUrl: string, song?: Song): NeteaseResourceAction {
  const normalizedType = type.toLowerCase()
  const playlistId = /^(list|playlist|toplist|songlist_homepage)$/i.test(type)
    ? String(value.resourceId || numericIdFromAction(actionUrl, 'playlist') || id)
    : numericIdFromAction(actionUrl, 'playlist')
  if (playlistId) {
    const playlist: ExplorePlaylist = {
      id: playlistId,
      name: title || '网易云歌单',
      coverUrl,
      description: subtitle,
      playCount: Number(value.playCount || value.playcount || 0) || undefined,
      trackCount: Number(value.trackCount || value.resourceExtInfo?.trackCount || 0) || undefined,
      creator: value.creator?.nickname || value.userName || undefined,
      userId: value.userId || value.creator?.userId || value.resourceExtInfo?.userId,
      isCollected: Boolean(value.isCollected || value.subscribed || value.resourceInteractInfo?.collect),
      subscribed: Boolean(value.isCollected || value.subscribed || value.resourceInteractInfo?.collect),
      platform: 'netease',
      source: /toplist/i.test(type) ? 'netease-native-toplist' : 'netease-native-feed',
    } as ExplorePlaylist
    return { type: 'playlist', playlist, autoplay: /[?&]autoplay=1/.test(actionUrl) }
  }

  const albumId = /album/i.test(normalizedType) ? String(value.resourceId || numericIdFromAction(actionUrl, 'album') || id) : numericIdFromAction(actionUrl, 'album')
  if (albumId) return { type: 'album', id: albumId }

  const programSource = value?.creativeExtInfoVO?.djProgram || value
  const programId = /^(voice|program)$/i.test(type) || (programSource?.id && programSource?.mainSong && programSource?.radio)
    ? String(programSource?.id || value.resourceId || numericIdFromAction(actionUrl, 'program') || id)
    : numericIdFromAction(actionUrl, 'program')
  if (programId) return { type: 'program', id: programId }

  const radioId = /^(voicelist|djradio|broadcast)$/i.test(type)
    ? String(value.resourceId || value.radio?.id || id)
    : numericIdFromAction(actionUrl, 'djradio') || numericIdFromAction(actionUrl, 'voicelist')
  if (radioId) return { type: 'radio', channel: channelOf(value, radioId, title, subtitle, coverUrl) }

  const artistId = numericIdFromAction(actionUrl, 'artist') || (/artist/i.test(normalizedType) ? String(value.resourceId || value.artist?.id || id) : '')
  if (artistId) return { type: 'artist', id: artistId }

  const userId = numericIdFromAction(actionUrl, 'user') || (/^(user|profile)$/i.test(type) ? String(value.resourceId || value.userId || value.profile?.userId || id) : '')
  if (userId) return { type: 'user', id: userId }

  const nestedMvId = value.resourceInfoList?.find((item: any) => item?.resourceId)?.resourceId || value.songData?.mv || value.song?.mv || value.songData?.mvid || value.song?.mvid
  const mvId = /^mv$/i.test(type) ? String(nestedMvId || numericIdFromAction(actionUrl, 'mv') || '') : numericIdFromAction(actionUrl, 'mv')
  if (mvId && mvId !== '0') return { type: 'mv', id: mvId }

  if (song && /^comment$/i.test(type)) return { type: 'comments', song }
  if (song) return { type: 'song', song }

  const webUrl = safeWebUrl(actionUrl)
  if (webUrl) return { type: 'web', url: webUrl }
  if (type === 'mypodcast' || /component=rn-podcast-my/i.test(actionUrl)) return { type: 'podcast-section', section: 'mine' }
  if (type === 'category' || /component=rn-podcast-category/i.test(actionUrl)) return { type: 'podcast-section', section: 'categories' }
  return { type: 'none' }
}

export function normalizeNeteaseResource(value: Record<string, any>, index: number): NeteaseNativeResource | null {
  const ui = value.uiElement || value.resourceUiElement || {}
  const ext = value.resourceExtInfo || value.creativeExtInfoVO || {}
  const song = songOf(value)
  const type = String(value.resourceType || value.creativeType || (song ? 'song' : '')).toLowerCase()
  const id = String(value.resourceId ?? value.creativeId ?? value.programId ?? value.id ?? song?.id ?? '')
  const actionUrl = String(value.action || value.orpheus || value.targetUrl || ui?.button?.action || '')
  const title = textOf(ui.mainTitle) || textOf(value.mainTitle) || textOf(value) || song?.name || ''
  const subtitle = textOf(ui.subTitle) || textOf(value.subTitle) || textOf(ext?.artist) || song?.artists.map(artist => artist.name).join(' / ') || ''
  const coverUrl = imageOf(ui.image) || imageOf(value) || song?.album.picUrl || imageOf(ext)
  const purePictureValue = ui.purePicture?.purePicture ?? ui.purePicture ?? value.purePicture?.purePicture ?? value.purePicture
  const purePictureUrl = imageOf(ui.purePictureUrl?.purePictureUrl || ui.purePictureUrl || value.purePictureUrl?.purePictureUrl || value.purePictureUrl)
  const interact = value.resourceInteractInfo || ext.resourceInteractInfo || {}
  const sourceSong = value?.songData || value?.song || value?.mainSong || value?.resourceExtInfo?.songData || value?.resourceExtInfo?.song || value?.creativeExtInfoVO?.songData || value?.creativeExtInfoVO?.song
  const favoriteCount = Number(
    sourceSong?.starCount || sourceSong?.starredNum || sourceSong?.redCount
      || value.starCount || value.starredNum || value.redCount || value.redCountValue
      || interact.redCount || interact.collectCount || 0,
  ) || undefined
  const isSongFavorite = song
    ? Boolean(interact.collect ?? sourceSong?.starred ?? sourceSong?.starStatus ?? value.starred ?? value.starStatus ?? ext.starred)
    : undefined
  if (!id && !title && !coverUrl && !purePictureUrl) return null
  const action = actionOf(value, type, id, actionUrl, title, subtitle, coverUrl, song)
  return {
    id: id || `${type || 'resource'}-${index}`,
    type: type || 'unknown',
    title: title || '推荐内容',
    subtitle,
    coverUrl,
    purePictureUrl,
    purePicture: purePictureValue === true || String(purePictureValue) === '1' || String(purePictureValue).toLowerCase() === 'true',
    purePicName: textOf(ui.purePicName?.purePicName || ui.purePicName || value.purePicName?.purePicName || value.purePicName),
    recommendationShowType: textOf(ui.rcmdShowType?.rcmdShowType || ui.rcmdShowType || value.rcmdShowType?.rcmdShowType || value.rcmdShowType),
    actionUrl,
    action,
    alg: String(value.alg || value.track?.s_calg || ''),
    playCount: Number(value.playCount || value.playcount || ext.playCount || interact.playCount || 0) || undefined,
    favoriteCount,
    isFavorite: isSongFavorite,
    song,
    playlist: action.type === 'playlist' ? action.playlist : undefined,
    raw: value,
  }
}

export function normalizeNeteaseBlock(value: Record<string, any>, index: number): NeteaseNativeBlock {
  const ui = value.uiElement || {}
  const candidates: Record<string, any>[] = []
  const directRoots = [
    ...(Array.isArray(value.creatives) ? value.creatives : []),
    value.dslData,
    value.nativeData,
    value.rnData,
  ].filter(Boolean)
  const roots = directRoots.length > 0
    ? directRoots
    : [value.crossPlatformConfig?.dslContent, value.crossPlatformConfig?.rnContent].filter(Boolean)
  roots.forEach((root: any) => recursiveCandidates(root, candidates, new Set()))
  const resources = candidates
    .map(normalizeNeteaseResource)
    .filter((item): item is NeteaseNativeResource => Boolean(item))
    .filter((item, itemIndex, all) => all.findIndex(candidate => `${candidate.action.type}:${candidate.id}:${candidate.actionUrl}` === `${item.action.type}:${item.id}:${item.actionUrl}`) === itemIndex)
  return {
    id: String(value.blockId || value.blockUUID || value.constructLogId || value.blockCode || `block-${index}`),
    blockCode: String(value.blockCode || value.positionCode || value.bizCode || ''),
    showType: String(value.showType || value.frontShowType || value.moduleType || ''),
    title: textOf(ui.mainTitle) || textOf(value.dslData?.header) || String(value.blockName || ''),
    subtitle: textOf(ui.subTitle),
    resources,
    raw: value,
  }
}

export function normalizeNeteaseHome(payload: any): NeteaseNativeHome {
  const data = payload?.data || {}
  const rawBlocks: Record<string, any>[] = Array.isArray(data.blocks) ? data.blocks : []
  const blocks: NeteaseNativeBlock[] = rawBlocks.map(normalizeNeteaseBlock).filter((block: NeteaseNativeBlock) => block.resources.length > 0 || block.title)
  const order: string[] = Array.isArray(data.blockCodeOrderList) ? data.blockCodeOrderList.map(String) : []
  if (order.length > 0) blocks.sort((a, b) => {
    const ai = order.indexOf(a.blockCode)
    const bi = order.indexOf(b.blockCode)
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
  })
  return {
    accountScoped: payload?.accountScoped === true,
    generatedAt: Number(payload?.generatedAt || Date.now()),
    cursor: String(data.cursor || ''),
    hasMore: data.hasMore === true,
    blockCodeOrderList: order,
    exposedResource: String(data.exposedResource || ''),
    blocks,
    rawBlocks,
  }
}

export function normalizeNeteaseDailyPodcast(value: any, index: number): ExploreChannel | null {
  const id = String(value?.voiceListId || value?.radioId || value?.id || '')
  const name = String(value?.voiceListName || value?.name || value?.title || '')
  if (!id || !name) return null
  return {
    id,
    name,
    group: String(value?.category || value?.categoryName || '每日播客'),
    description: String(value?.description || value?.desc || value?.rcmdText || ''),
    coverUrl: imageOf(value?.coverUrl || value?.coverImgUrl || value?.picUrl || value?.image || {}),
    playCount: Number(value?.playCount || value?.listenerCount || value?.subCount || 0) || undefined,
    platform: 'netease',
  }
}

export function normalizeNeteaseFlow(payload: any): NeteaseNativeFlow {
  const data = payload?.data || {}
  const resources: Record<string, any>[] = Array.isArray(data.resources) ? data.resources : []
  return { hasMore: data.hasMore === true, resources: resources.map(normalizeNeteaseResource).filter((item): item is NeteaseNativeResource => Boolean(item)) }
}
