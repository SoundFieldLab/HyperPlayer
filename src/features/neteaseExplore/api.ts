import type { Song } from '../../services/musicApi'
import { getApiBase } from '../../services/apiConfig'
import { getExploreCookie } from '../../services/exploreApi'
import { normalizeNeteaseFlow, normalizeNeteaseHome, type NeteaseNativeFlow, type NeteaseNativeHome } from './model'

// src/features/neteaseExplore/api.ts

const API_BASE = `${getApiBase()}/netease/native`

async function request(path: string, params: Record<string, string | undefined>, signal?: AbortSignal) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value)
  const response = await fetch(url, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok || Number(data?.code) >= 400) throw new Error(data?.error || data?.message || `网易云请求失败 (${response.status})`)
  return data
}

export async function fetchNeteaseNativeHome(
  refresh = false,
  signal?: AbortSignal,
  state?: { cursor?: string; blockCodeOrderList?: string[]; exposedResource?: string },
): Promise<NeteaseNativeHome> {
  const extInfo = state ? JSON.stringify({
    netstat: 1,
    guideToastLastShow: 0,
    carrier: '',
    abInfo: { 'hp-new-homepageV3.1': '' },
    requestLongVideoBanner: true,
    refreshType: refresh ? 1 : 0,
    forceFreshForNewUser: false,
    blockCodeOrderList: state.blockCodeOrderList || [],
    exposedResource: state.exposedResource || '',
  }) : undefined
  const payload = await request('/home', {
    cookie: getExploreCookie('netease'),
    refresh: refresh ? '1' : undefined,
    cursor: state?.cursor,
    extInfo,
  }, signal)
  return normalizeNeteaseHome(payload)
}

export async function fetchNeteaseUnlimitedFlow(signal?: AbortSignal): Promise<NeteaseNativeFlow> {
  const payload = await request('/unlimited-flow', { cookie: getExploreCookie('netease') }, signal)
  return normalizeNeteaseFlow(payload)
}

export function normalizeNeteaseSongs(payload: any): Song[] {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.data?.dailySongs || payload?.data?.songs || payload?.dailySongs || payload?.songs || payload?.data || []
  if (!Array.isArray(candidates)) return []
  return candidates.map((value: any) => {
    const track = value?.songInfo || value?.song || value?.simpleSong || value
    const album = track?.al || track?.album || {}
    const artists = track?.ar || track?.artists || []
    return {
      id: Number(track?.id || 0),
      name: String(track?.name || ''),
      artists: (Array.isArray(artists) ? artists : []).map((artist: any) => ({ id: Number(artist?.id) || undefined, name: String(artist?.name || '未知歌手') })),
      album: { id: Number(album?.id) || undefined, name: String(album?.name || ''), picUrl: String(album?.picUrl || album?.blurPicUrl || '').replace(/^http:/, 'https:') },
      duration: Number(track?.dt || track?.duration || 0),
      platform: 'netease' as const,
      fee: Number(track?.fee || 0),
      vip: Number(track?.fee) === 1,
      requiredTier: Number(track?.fee) === 1 ? 'vip' as const : 'free' as const,
      noCopyright: Number(track?.privilege?.st) < 0,
    }
  }).filter((song: Song) => song.id && song.name)
}

export async function fetchNeteaseDailySongs(signal?: AbortSignal): Promise<Song[]> {
  return normalizeNeteaseSongs(await request('/daily-songs', { cookie: getExploreCookie('netease') }, signal))
}

export interface NeteaseDailyStyleCategory {
  categoryId: string
  categoryName: string
  tags: Array<{ tagId: string; tagName: string }>
}

export async function fetchNeteaseDailyHistory(date?: string, signal?: AbortSignal): Promise<{ dates: string[]; songs: Song[]; description: string; emptyMessage: string }> {
  const payload = await request('/daily-history', { cookie: getExploreCookie('netease'), date }, signal)
  const data = payload?.data || {}
  return {
    dates: (Array.isArray(data.dates) ? data.dates : []).map((item: any) => String(item?.date || item || '')).filter(Boolean),
    songs: normalizeNeteaseSongs(data?.songs || data?.dailySongs || []),
    description: String(data.description || ''),
    emptyMessage: String(data.noHistoryMessage || ''),
  }
}

export async function fetchNeteaseDailyStyleConfig(signal?: AbortSignal): Promise<NeteaseDailyStyleCategory[]> {
  const payload = await request('/daily-style', { cookie: getExploreCookie('netease') }, signal)
  const categories = payload?.data?.categorys || []
  return (Array.isArray(categories) ? categories : []).map((category: any) => ({
    categoryId: String(category.categoryId || ''),
    categoryName: String(category.categoryName || ''),
    tags: (Array.isArray(category.tagVOList) ? category.tagVOList : []).map((tag: any) => ({ tagId: String(tag.tagId || ''), tagName: String(tag.tagName || '') })).filter((tag: { tagId: string; tagName: string }) => tag.tagId && tag.tagName),
  })).filter((category: NeteaseDailyStyleCategory) => category.categoryId && category.categoryName)
}

export async function fetchNeteaseDailyStyleSongs(categoryId: string, tagId: string, seedSongId = 0, signal?: AbortSignal): Promise<Song[]> {
  const payload = await request('/daily-style', { cookie: getExploreCookie('netease'), categoryId, tagId, songId: String(seedSongId) }, signal)
  return normalizeNeteaseSongs(payload?.data?.dailySongs || [])
}

export async function fetchNeteaseRoam(signal?: AbortSignal): Promise<Song[]> {
  return normalizeNeteaseSongs(await request('/roam', { cookie: getExploreCookie('netease'), mode: 'DEFAULT', limit: '30' }, signal))
}

export async function fetchNeteaseHeartMode(songId: number, playlistId: string, signal?: AbortSignal): Promise<Song[]> {
  return normalizeNeteaseSongs(await request('/heart-mode', { cookie: getExploreCookie('netease'), songId: String(songId), playlistId, startMusicId: String(songId), type: 'fromPlayOne', count: '30' }, signal))
}

export async function fetchNeteaseProgramSong(programId: string, signal?: AbortSignal): Promise<Song | null> {
  const payload = await request('/program-detail', { cookie: getExploreCookie('netease'), id: programId }, signal)
  const program = payload?.program || payload?.data?.program || payload?.data || {}
  const songs = normalizeNeteaseSongs([program?.mainSong || program?.mainTrack].filter(Boolean))
  if (!songs[0]) return null
  return {
    ...songs[0],
    name: String(program?.name || songs[0].name),
    album: { ...songs[0].album, name: String(program?.radio?.name || songs[0].album.name), picUrl: String(program?.coverUrl || program?.blurCoverUrl || songs[0].album.picUrl).replace(/^http:/, 'https:') },
    duration: Number(program?.duration || songs[0].duration || 0),
    commentCount: Number(program?.commentCount || songs[0].commentCount || 0) || undefined,
  }
}

export async function fetchNeteaseDailyPodcast(signal?: AbortSignal): Promise<any[]> {
  const payload = await request('/daily-podcast', { cookie: getExploreCookie('netease') }, signal)
  const data = payload?.data
  return Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
}

export interface NeteaseSimilarContext {
  songs: any
  playlists: any
  users: any
}

export async function fetchNeteaseSimilarContext(songId: number, signal?: AbortSignal): Promise<NeteaseSimilarContext> {
  return request('/similar-context', { cookie: getExploreCookie('netease'), songId: String(songId) }, signal)
}

export async function fetchNeteaseRedCounts(songIds: Array<string | number>, signal?: AbortSignal): Promise<Record<string, number>> {
  const uniqueIds = [...new Set(songIds.map(String).filter(id => /^\d+$/.test(id)))].slice(0, 40)
  if (uniqueIds.length === 0) return {}
  try {
    const payload = await request('/red-counts', { cookie: getExploreCookie('netease'), ids: uniqueIds.join(',') }, signal)
    const counts = payload?.counts
    if (!counts || typeof counts !== 'object') return {}
    return Object.fromEntries(Object.entries(counts).filter(([, value]) => Number.isFinite(Number(value))).map(([id, value]) => [id, Number(value)]))
  } catch {
    return {}
  }
}

export async function fetchNeteasePodcastHome(signal?: AbortSignal): Promise<NeteaseNativeHome> {
  const payload = await request('/podcast-home', { cookie: getExploreCookie('netease') }, signal)
  const data = payload?.data || {}
  return normalizeNeteaseHome({ ...payload, data: { ...data, blocks: data.blockVOS || [] } })
}
