/**
 * neteaseApi —— vendored @neteasecloudmusicapienhanced/api 的白名单入口。
 *
 * main.js 的动态模块加载（fs.readdirSync）与 express server 不适合浏览器，
 * 这里显式 import 92 条路由业务所需的端点模块，统一注入浏览器 request 传输。
 * 未列入的模块（如 song_url_match——LGPL 解灰红线）不引入。
 * 每个端点签名与上游一致：fn(data, request) → Promise<answer>。
 */
import * as createRequestModule from '@neteasecloudmusicapienhanced/api/util/request.js';
const createRequest = unwrapCjs<NeteaseApiModule>(createRequestModule);
import type { NeteaseApiAnswer, NeteaseApiModule, NeteaseRequestFn } from './vendor-api';

// —— 白名单端点模块（92 条路由业务所需）——
import * as loginQrKeyModule from '@neteasecloudmusicapienhanced/api/module/login_qr_key.js';
const loginQrKey = unwrapCjs<NeteaseApiModule>(loginQrKeyModule);
import * as loginQrCreateModule from '@neteasecloudmusicapienhanced/api/module/login_qr_create.js';
const loginQrCreate = unwrapCjs<NeteaseApiModule>(loginQrCreateModule);
import * as loginQrCheckModule from '@neteasecloudmusicapienhanced/api/module/login_qr_check.js';
const loginQrCheck = unwrapCjs<NeteaseApiModule>(loginQrCheckModule);
import * as loginStatusModule from '@neteasecloudmusicapienhanced/api/module/login_status.js';
const loginStatus = unwrapCjs<NeteaseApiModule>(loginStatusModule);
import * as songUrlV1Module from '@neteasecloudmusicapienhanced/api/module/song_url_v1.js';
const songUrlV1 = unwrapCjs<NeteaseApiModule>(songUrlV1Module);
import * as songDetailModule from '@neteasecloudmusicapienhanced/api/module/song_detail.js';
const songDetail = unwrapCjs<NeteaseApiModule>(songDetailModule);
import * as lyricModule from '@neteasecloudmusicapienhanced/api/module/lyric.js';
const lyric = unwrapCjs<NeteaseApiModule>(lyricModule);
import * as searchModule from '@neteasecloudmusicapienhanced/api/module/search.js';
const search = unwrapCjs<NeteaseApiModule>(searchModule);
import * as searchSuggestModule from '@neteasecloudmusicapienhanced/api/module/search_suggest.js';
const searchSuggest = unwrapCjs<NeteaseApiModule>(searchSuggestModule);
import * as searchHotModule from '@neteasecloudmusicapienhanced/api/module/search_hot.js';
const searchHot = unwrapCjs<NeteaseApiModule>(searchHotModule);
import * as playlistDetailModule from '@neteasecloudmusicapienhanced/api/module/playlist_detail.js';
const playlistDetail = unwrapCjs<NeteaseApiModule>(playlistDetailModule);
import * as playlistTracksModule from '@neteasecloudmusicapienhanced/api/module/playlist_tracks.js';
const playlistTracks = unwrapCjs<NeteaseApiModule>(playlistTracksModule);
import * as playlistCreateModule from '@neteasecloudmusicapienhanced/api/module/playlist_create.js';
const playlistCreate = unwrapCjs<NeteaseApiModule>(playlistCreateModule);
import * as playlistDeleteModule from '@neteasecloudmusicapienhanced/api/module/playlist_delete.js';
const playlistDelete = unwrapCjs<NeteaseApiModule>(playlistDeleteModule);
import * as playlistUpdateModule from '@neteasecloudmusicapienhanced/api/module/playlist_update.js';
const playlistUpdate = unwrapCjs<NeteaseApiModule>(playlistUpdateModule);
import * as playlistSubscribeModule from '@neteasecloudmusicapienhanced/api/module/playlist_subscribe.js';
const playlistSubscribe = unwrapCjs<NeteaseApiModule>(playlistSubscribeModule);
import * as playlistCoverUpdateModule from '@neteasecloudmusicapienhanced/api/module/playlist_cover_update.js';
const playlistCoverUpdate = unwrapCjs<NeteaseApiModule>(playlistCoverUpdateModule);
import * as playlistCatlistModule from '@neteasecloudmusicapienhanced/api/module/playlist_catlist.js';
const playlistCatlist = unwrapCjs<NeteaseApiModule>(playlistCatlistModule);
import * as playlistHotModule from '@neteasecloudmusicapienhanced/api/module/playlist_hot.js';
const playlistHot = unwrapCjs<NeteaseApiModule>(playlistHotModule);
import * as topPlaylistHighqualityModule from '@neteasecloudmusicapienhanced/api/module/top_playlist_highquality.js';
const topPlaylistHighquality = unwrapCjs<NeteaseApiModule>(topPlaylistHighqualityModule);
import * as simiPlaylistModule from '@neteasecloudmusicapienhanced/api/module/simi_playlist.js';
const simiPlaylist = unwrapCjs<NeteaseApiModule>(simiPlaylistModule);
import * as userPlaylistModule from '@neteasecloudmusicapienhanced/api/module/user_playlist.js';
const userPlaylist = unwrapCjs<NeteaseApiModule>(userPlaylistModule);
import * as userAccountModule from '@neteasecloudmusicapienhanced/api/module/user_account.js';
const userAccount = unwrapCjs<NeteaseApiModule>(userAccountModule);
import * as userDetailModule from '@neteasecloudmusicapienhanced/api/module/user_detail.js';
const userDetail = unwrapCjs<NeteaseApiModule>(userDetailModule);
import * as userFollowsModule from '@neteasecloudmusicapienhanced/api/module/user_follows.js';
const userFollows = unwrapCjs<NeteaseApiModule>(userFollowsModule);
import * as userFollowedsModule from '@neteasecloudmusicapienhanced/api/module/user_followeds.js';
const userFolloweds = unwrapCjs<NeteaseApiModule>(userFollowedsModule);
import * as recordRecentSongModule from '@neteasecloudmusicapienhanced/api/module/record_recent_song.js';
const recordRecentSong = unwrapCjs<NeteaseApiModule>(recordRecentSongModule);
import * as recordRecentAlbumModule from '@neteasecloudmusicapienhanced/api/module/record_recent_album.js';
const recordRecentAlbum = unwrapCjs<NeteaseApiModule>(recordRecentAlbumModule);
import * as recordRecentPlaylistModule from '@neteasecloudmusicapienhanced/api/module/record_recent_playlist.js';
const recordRecentPlaylist = unwrapCjs<NeteaseApiModule>(recordRecentPlaylistModule);
import * as recordRecentDjModule from '@neteasecloudmusicapienhanced/api/module/record_recent_dj.js';
const recordRecentDj = unwrapCjs<NeteaseApiModule>(recordRecentDjModule);
import * as userRecordModule from '@neteasecloudmusicapienhanced/api/module/user_record.js';
const userRecord = unwrapCjs<NeteaseApiModule>(userRecordModule);
import * as songWikiSummaryModule from '@neteasecloudmusicapienhanced/api/module/song_wiki_summary.js';
const songWikiSummary = unwrapCjs<NeteaseApiModule>(songWikiSummaryModule);
import * as recommendSongsModule from '@neteasecloudmusicapienhanced/api/module/recommend_songs.js';
const recommendSongs = unwrapCjs<NeteaseApiModule>(recommendSongsModule);
import * as recommendResourceModule from '@neteasecloudmusicapienhanced/api/module/recommend_resource.js';
const recommendResource = unwrapCjs<NeteaseApiModule>(recommendResourceModule);
import * as recommendSongsDislikeModule from '@neteasecloudmusicapienhanced/api/module/recommend_songs_dislike.js';
const recommendSongsDislike = unwrapCjs<NeteaseApiModule>(recommendSongsDislikeModule);
import * as personalFmModule from '@neteasecloudmusicapienhanced/api/module/personal_fm.js';
const personalFm = unwrapCjs<NeteaseApiModule>(personalFmModule);
import * as fmTrashModule from '@neteasecloudmusicapienhanced/api/module/fm_trash.js';
const fmTrash = unwrapCjs<NeteaseApiModule>(fmTrashModule);
import * as personalizedNewsongModule from '@neteasecloudmusicapienhanced/api/module/personalized_newsong.js';
const personalizedNewsong = unwrapCjs<NeteaseApiModule>(personalizedNewsongModule);
import * as topSongModule from '@neteasecloudmusicapienhanced/api/module/top_song.js';
const topSong = unwrapCjs<NeteaseApiModule>(topSongModule);
import * as topArtistsModule from '@neteasecloudmusicapienhanced/api/module/top_artists.js';
const topArtists = unwrapCjs<NeteaseApiModule>(topArtistsModule);
import * as topAlbumModule from '@neteasecloudmusicapienhanced/api/module/top_album.js';
const topAlbum = unwrapCjs<NeteaseApiModule>(topAlbumModule);
import * as topMvModule from '@neteasecloudmusicapienhanced/api/module/top_mv.js';
const topMv = unwrapCjs<NeteaseApiModule>(topMvModule);
import * as toplistDetailModule from '@neteasecloudmusicapienhanced/api/module/toplist_detail.js';
const toplistDetail = unwrapCjs<NeteaseApiModule>(toplistDetailModule);
import * as toplistModule from '@neteasecloudmusicapienhanced/api/module/toplist.js';
const toplist = unwrapCjs<NeteaseApiModule>(toplistModule);
import * as artistDetailModule from '@neteasecloudmusicapienhanced/api/module/artist_detail.js';
const artistDetail = unwrapCjs<NeteaseApiModule>(artistDetailModule);
import * as artistDescModule from '@neteasecloudmusicapienhanced/api/module/artist_desc.js';
const artistDesc = unwrapCjs<NeteaseApiModule>(artistDescModule);
import * as artistFollowCountModule from '@neteasecloudmusicapienhanced/api/module/artist_follow_count.js';
const artistFollowCount = unwrapCjs<NeteaseApiModule>(artistFollowCountModule);
import * as artistSongsModule from '@neteasecloudmusicapienhanced/api/module/artist_songs.js';
const artistSongs = unwrapCjs<NeteaseApiModule>(artistSongsModule);
import * as artistAlbumModule from '@neteasecloudmusicapienhanced/api/module/artist_album.js';
const artistAlbum = unwrapCjs<NeteaseApiModule>(artistAlbumModule);
import * as artistMvModule from '@neteasecloudmusicapienhanced/api/module/artist_mv.js';
const artistMv = unwrapCjs<NeteaseApiModule>(artistMvModule);
import * as artistListModule from '@neteasecloudmusicapienhanced/api/module/artist_list.js';
const artistList = unwrapCjs<NeteaseApiModule>(artistListModule);
import * as artistSubModule from '@neteasecloudmusicapienhanced/api/module/artist_sub.js';
const artistSub = unwrapCjs<NeteaseApiModule>(artistSubModule);
import * as artistSublistModule from '@neteasecloudmusicapienhanced/api/module/artist_sublist.js';
const artistSublist = unwrapCjs<NeteaseApiModule>(artistSublistModule);
import * as simiArtistModule from '@neteasecloudmusicapienhanced/api/module/simi_artist.js';
const simiArtist = unwrapCjs<NeteaseApiModule>(simiArtistModule);
import * as simiSongModule from '@neteasecloudmusicapienhanced/api/module/simi_song.js';
const simiSong = unwrapCjs<NeteaseApiModule>(simiSongModule);
import * as albumModule from '@neteasecloudmusicapienhanced/api/module/album.js';
const album = unwrapCjs<NeteaseApiModule>(albumModule);
import * as albumDetailModule from '@neteasecloudmusicapienhanced/api/module/album_detail.js';
const albumDetail = unwrapCjs<NeteaseApiModule>(albumDetailModule);
import * as albumSubModule from '@neteasecloudmusicapienhanced/api/module/album_sub.js';
const albumSub = unwrapCjs<NeteaseApiModule>(albumSubModule);
import * as albumSublistModule from '@neteasecloudmusicapienhanced/api/module/album_sublist.js';
const albumSublist = unwrapCjs<NeteaseApiModule>(albumSublistModule);
import * as mvUrlModule from '@neteasecloudmusicapienhanced/api/module/mv_url.js';
const mvUrl = unwrapCjs<NeteaseApiModule>(mvUrlModule);
import * as mvDetailModule from '@neteasecloudmusicapienhanced/api/module/mv_detail.js';
const mvDetail = unwrapCjs<NeteaseApiModule>(mvDetailModule);
import * as mvAllModule from '@neteasecloudmusicapienhanced/api/module/mv_all.js';
const mvAll = unwrapCjs<NeteaseApiModule>(mvAllModule);
import * as mvSubModule from '@neteasecloudmusicapienhanced/api/module/mv_sub.js';
const mvSub = unwrapCjs<NeteaseApiModule>(mvSubModule);
import * as mvSublistModule from '@neteasecloudmusicapienhanced/api/module/mv_sublist.js';
const mvSublist = unwrapCjs<NeteaseApiModule>(mvSublistModule);
import * as simiMvModule from '@neteasecloudmusicapienhanced/api/module/simi_mv.js';
const simiMv = unwrapCjs<NeteaseApiModule>(simiMvModule);
import * as djRecommendModule from '@neteasecloudmusicapienhanced/api/module/dj_recommend.js';
const djRecommend = unwrapCjs<NeteaseApiModule>(djRecommendModule);
import * as djSubModule from '@neteasecloudmusicapienhanced/api/module/dj_sub.js';
const djSub = unwrapCjs<NeteaseApiModule>(djSubModule);
import * as djSublistModule from '@neteasecloudmusicapienhanced/api/module/dj_sublist.js';
const djSublist = unwrapCjs<NeteaseApiModule>(djSublistModule);
import * as djCatelistModule from '@neteasecloudmusicapienhanced/api/module/dj_catelist.js';
const djCatelist = unwrapCjs<NeteaseApiModule>(djCatelistModule);
import * as djHotModule from '@neteasecloudmusicapienhanced/api/module/dj_hot.js';
const djHot = unwrapCjs<NeteaseApiModule>(djHotModule);
import * as likeModule from '@neteasecloudmusicapienhanced/api/module/like.js';
const like = unwrapCjs<NeteaseApiModule>(likeModule);
import * as likelistModule from '@neteasecloudmusicapienhanced/api/module/likelist.js';
const likelist = unwrapCjs<NeteaseApiModule>(likelistModule);
import * as songLikeCheckModule from '@neteasecloudmusicapienhanced/api/module/song_like_check.js';
const songLikeCheck = unwrapCjs<NeteaseApiModule>(songLikeCheckModule);
import * as commentMusicModule from '@neteasecloudmusicapienhanced/api/module/comment_music.js';
const commentMusic = unwrapCjs<NeteaseApiModule>(commentMusicModule);
import * as commentFloorModule from '@neteasecloudmusicapienhanced/api/module/comment_floor.js';
const commentFloor = unwrapCjs<NeteaseApiModule>(commentFloorModule);
import * as commentHotModule from '@neteasecloudmusicapienhanced/api/module/comment_hot.js';
const commentHot = unwrapCjs<NeteaseApiModule>(commentHotModule);
import * as commentAddModule from '@neteasecloudmusicapienhanced/api/module/comment_add.js';
const commentAdd = unwrapCjs<NeteaseApiModule>(commentAddModule);
import * as commentReplyModule from '@neteasecloudmusicapienhanced/api/module/comment_reply.js';
const commentReply = unwrapCjs<NeteaseApiModule>(commentReplyModule);
import * as commentDeleteModule from '@neteasecloudmusicapienhanced/api/module/comment_delete.js';
const commentDelete = unwrapCjs<NeteaseApiModule>(commentDeleteModule);
import * as commentLikeModule from '@neteasecloudmusicapienhanced/api/module/comment_like.js';
const commentLike = unwrapCjs<NeteaseApiModule>(commentLikeModule);
import * as bannerModule from '@neteasecloudmusicapienhanced/api/module/banner.js';
const banner = unwrapCjs<NeteaseApiModule>(bannerModule);
import * as playmodeIntelligenceListModule from '@neteasecloudmusicapienhanced/api/module/playmode_intelligence_list.js';
const playmodeIntelligenceList = unwrapCjs<NeteaseApiModule>(playmodeIntelligenceListModule);
import * as vipInfoModule from '@neteasecloudmusicapienhanced/api/module/vip_info.js';
const vipInfo = unwrapCjs<NeteaseApiModule>(vipInfoModule);
import * as cloudModule from '@neteasecloudmusicapienhanced/api/module/cloud.js';
const cloud = unwrapCjs<NeteaseApiModule>(cloudModule);
import * as cloudSearchModule from '@neteasecloudmusicapienhanced/api/module/cloudsearch.js';
const cloudSearch = unwrapCjs<NeteaseApiModule>(cloudSearchModule);
import * as songCloudDownloadModule from '@neteasecloudmusicapienhanced/api/module/song_cloud_download.js';
const songCloudDownload = unwrapCjs<NeteaseApiModule>(songCloudDownloadModule);
import * as eventForwardModule from '@neteasecloudmusicapienhanced/api/module/event_forward.js';
const eventForward = unwrapCjs<NeteaseApiModule>(eventForwardModule);
import * as eventModule from '@neteasecloudmusicapienhanced/api/module/event.js';
const event = unwrapCjs<NeteaseApiModule>(eventModule);
import * as userEventModule from '@neteasecloudmusicapienhanced/api/module/user_event.js';
const userEvent = unwrapCjs<NeteaseApiModule>(userEventModule);
import * as userCloudDelModule from '@neteasecloudmusicapienhanced/api/module/user_cloud_del.js';
const userCloudDel = unwrapCjs<NeteaseApiModule>(userCloudDelModule);
import * as followModule from '@neteasecloudmusicapienhanced/api/module/follow.js';
const follow = unwrapCjs<NeteaseApiModule>(followModule);
import * as msgNoticesModule from '@neteasecloudmusicapienhanced/api/module/msg_notices.js';
const msgNotices = unwrapCjs<NeteaseApiModule>(msgNoticesModule);
import * as msgCommentsModule from '@neteasecloudmusicapienhanced/api/module/msg_comments.js';
const msgComments = unwrapCjs<NeteaseApiModule>(msgCommentsModule);

/** NeteaseApi：端点名 → 调用函数（白名单，仅列出上表）。 */
/** CJS 模块互操作：namespace.default 或模块本体（rollup commonjs interop）。 */
type CjsModuleNamespace = { default?: unknown } & Record<string, unknown>;

function unwrapCjs<T>(module: CjsModuleNamespace): T {
  return (module.default ?? module) as T;
}

export interface NeteaseApi {
  [endpoint: string]: (data: Record<string, unknown>) => Promise<NeteaseApiAnswer>;
}

const MODULES: Record<string, NeteaseApiModule> = {
  login_qr_key: loginQrKey,
  login_qr_create: loginQrCreate,
  login_qr_check: loginQrCheck,
  login_status: loginStatus,
  song_url_v1: songUrlV1,
  song_detail: songDetail,
  lyric,
  search,
  search_suggest: searchSuggest,
  search_hot: searchHot,
  playlist_detail: playlistDetail,
  playlist_tracks: playlistTracks,
  playlist_create: playlistCreate,
  playlist_delete: playlistDelete,
  playlist_update: playlistUpdate,
  playlist_subscribe: playlistSubscribe,
  playlist_cover_update: playlistCoverUpdate,
  playlist_catlist: playlistCatlist,
  playlist_hot: playlistHot,
  top_playlist_highquality: topPlaylistHighquality,
  simi_playlist: simiPlaylist,
  user_playlist: userPlaylist,
  user_account: userAccount,
  user_detail: userDetail,
  user_follows: userFollows,
  user_followeds: userFolloweds,
  record_recent_song: recordRecentSong,
  record_recent_album: recordRecentAlbum,
  record_recent_playlist: recordRecentPlaylist,
  record_recent_dj: recordRecentDj,
  user_record: userRecord,
  song_wiki_summary: songWikiSummary,
  recommend_songs: recommendSongs,
  recommend_resource: recommendResource,
  recommend_songs_dislike: recommendSongsDislike,
  personal_fm: personalFm,
  fm_trash: fmTrash,
  personalized_newsong: personalizedNewsong,
  top_song: topSong,
  top_artists: topArtists,
  top_album: topAlbum,
  top_mv: topMv,
  toplist_detail: toplistDetail,
  toplist,
  artist_detail: artistDetail,
  artist_desc: artistDesc,
  artist_follow_count: artistFollowCount,
  artist_songs: artistSongs,
  artist_album: artistAlbum,
  artist_mv: artistMv,
  artist_list: artistList,
  artist_sub: artistSub,
  artist_sublist: artistSublist,
  simi_artist: simiArtist,
  simi_song: simiSong,
  album,
  album_detail: albumDetail,
  album_sub: albumSub,
  album_sublist: albumSublist,
  mv_url: mvUrl,
  mv_detail: mvDetail,
  mv_all: mvAll,
  mv_sub: mvSub,
  mv_sublist: mvSublist,
  simi_mv: simiMv,
  dj_recommend: djRecommend,
  dj_sub: djSub,
  dj_sublist: djSublist,
  dj_catelist: djCatelist,
  dj_hot: djHot,
  like,
  likelist,
  song_like_check: songLikeCheck,
  comment_music: commentMusic,
  comment_floor: commentFloor,
  comment_hot: commentHot,
  comment_add: commentAdd,
  comment_reply: commentReply,
  comment_delete: commentDelete,
  comment_like: commentLike,
  banner,
  playmode_intelligence_list: playmodeIntelligenceList,
  vip_info: vipInfo,
  cloud,
  cloudsearch: cloudSearch,
  song_cloud_download: songCloudDownload,
  event_forward: eventForward,
  event,
  user_event: userEvent,
  user_cloud_del: userCloudDel,
  follow,
  msg_notices: msgNotices,
  msg_comments: msgComments,
};

export interface NeteaseApiStorage {
  getAnonymousToken(): Promise<string>;
  getXeapiPublicKey(): Promise<unknown>;
}

/** 注入浏览器传输（tauriHttp）与存储（anonymous token/xeapi key）。 */
export function wireNeteaseApi(http: unknown, storage: NeteaseApiStorage): NeteaseRequestFn {
  (createRequest as unknown as { setBrowserHttpTransport(t: unknown): void }).setBrowserHttpTransport(http);
  (createRequest as unknown as { setBrowserStorage(s: NeteaseApiStorage): void }).setBrowserStorage(storage);
  return createRequest as unknown as NeteaseRequestFn;
}

/** 组装白名单 API（端点名 → 已绑定 request 的调用函数）。 */
export function createNeteaseApi(request: NeteaseRequestFn): NeteaseApi {
  const api: NeteaseApi = {};
  for (const [endpoint, module] of Object.entries(MODULES)) {
    api[endpoint] = (data: Record<string, unknown>) => module(data, request) as Promise<NeteaseApiAnswer>;
  }
  return api;
}
