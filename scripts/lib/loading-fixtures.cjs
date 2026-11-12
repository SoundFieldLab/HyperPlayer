'use strict'

/**
 * 仅由 loading-network-probe 在显式 fixture 模式加载。
 * 数据固定：两平台各 160 首，歌单 9001，艺人 1 / artist-fixture。
 * 只替换第三方公开 SDK 与外部上游响应，不替换任何本地 route/账号判断。
 * SDK 调用的延迟/速率模拟作用于 logical JSON envelope，不代表真实 HTTP 扇出。
 * 未实现操作返回 null/501，不能以空成功响应掩盖覆盖缺口。
 */
const SONG_COUNT = 160
// TEST-NET-3 文档 IP：生产 SSRF 仍真实执行，不需要为虚构域名做 DNS。
const MEDIA_URL = 'https://203.0.113.10/audio.wav'
const COVER_URL = 'https://203.0.113.10/cover.svg'
const QQ_FIXTURE_LRC = '[00:00.00]清晨的风吹过站台\n[00:04.00]我们沿着旋律向前\n[00:08.00]让每一句歌声被听见'
const artist = () => ({ id: 1, mid: 'artist-fixture', name: '基准歌手', picUrl: COVER_URL, img1v1Url: COVER_URL,
  musicSize: SONG_COUNT, albumSize: 1, mvSize: 1, briefDesc: '固定基准艺人' })
const album = () => ({ id: 1, mid: 'album-fixture', name: '基准专辑 001', picUrl: COVER_URL, artist: artist(),
  artists: [artist()], size: SONG_COUNT, publishTime: 1700000000000, description: '固定基准专辑' })
const name = id => `基准歌曲 ${String(id).padStart(3, '0')}`
function neteaseSong(id) {
  const ar = [artist()], al = album()
  return { id, name: name(id), ar, artists: ar, al, album: al, dt: 180000, duration: 180000,
    fee: 0, mv: 0, privilege: { st: 0, fee: 0, pl: 320000, fl: 320000, playMaxbr: 320000 } }
}
function qqSong(id) {
  return { id, songid: id, mid: `song-fixture-${id}`, songmid: `song-fixture-${id}`,
    name: name(id), title: name(id), songname: name(id), singer: [artist()], album: album(),
    albumid: 1, albummid: 'album-fixture', albumname: '基准专辑 001', albumpic: COVER_URL,
    interval: 180, pay: { payplay: 0 }, file: { media_mid: `song-fixture-${id}`, size_128mp3: 2880000 } }
}
const all = factory => Array.from({ length: SONG_COUNT }, (_, i) => factory(i + 1))
function page(items, query = {}, defaultSize = 30) {
  const size = Math.max(1, Math.min(10000, Number(query.limit ?? query.num ?? query.pageSize ?? query.n ?? defaultSize) || defaultSize))
  const offset = Math.max(0, Number(query.offset ?? ((Number(query.page ?? query.pageNo ?? 1) - 1) * size)) || 0)
  return items.slice(offset, offset + size)
}
function ids(query, key = 'ids') {
  const raw = query[key] ?? query.id ?? '1'
  let list
  try { list = JSON.parse(String(raw)) } catch { list = String(raw).split(',') }
  return (Array.isArray(list) ? list : [list]).map(Number).filter(id => id >= 1 && id <= SONG_COUNT)
}
const neteasePlaylist = () => ({ id: 9001, name: '基准歌单', coverImgUrl: COVER_URL, picUrl: COVER_URL,
  description: '固定 160 首基准歌单', trackCount: SONG_COUNT, playCount: 1000, subscribed: false,
  creator: { userId: 1, nickname: '基准用户', avatarUrl: COVER_URL }, tags: [],
  trackIds: all(id => ({ id })), tracks: all(neteaseSong) })
const qqPlaylist = () => ({ id: 9001, tid: '9001', dissid: '9001', disstid: '9001', dissname: '基准歌单',
  name: '基准歌单', songnum: SONG_COUNT, total_song_num: SONG_COUNT, logo: COVER_URL, diss_cover: COVER_URL,
  desc: '固定 160 首基准歌单', nickname: '基准用户', songlist: all(qqSong) })

function neteaseResult(method, query = {}) {
  const songs = () => page(all(neteaseSong), query)
  switch (method) {
    case 'search': case 'cloudsearch': {
      const type = Number(query.type || 1)
      const result = type === 100 ? { artists: [artist()], artistCount: 1 } :
        type === 1000 ? { playlists: [neteasePlaylist()], playlistCount: 1 } :
          type === 10 ? { albums: [album()], albumCount: 1 } : { songs: songs(), songCount: SONG_COUNT }
      return { result: { ...result, hasMore: Number(query.offset || 0) + (result.songs?.length || 0) < SONG_COUNT } }
    }
    case 'search_suggest': return { result: { songs: page(all(neteaseSong), { limit: 5 }), artists: [artist()], playlists: [neteasePlaylist()], order: ['songs', 'artists', 'playlists'] } }
    case 'playlist_detail': return { playlist: neteasePlaylist() }
    case 'playlist_track_all': return { songs: page(all(neteaseSong), query, SONG_COUNT), privileges: [] }
    case 'song_detail': return { songs: ids(query).map(neteaseSong), privileges: [] }
    case 'song_music_detail': return { data: { id: Number(query.id) || 1, song: neteaseSong(Number(query.id) || 1) } }
    case 'song_url_v1': case 'song_url': return { data: ids(query).map(id => ({ id, url: MEDIA_URL, br: 128000, size: null, type: 'wav', code: 200, level: 'standard', time: 180000, freeTrialInfo: null })) }
    case 'album': return { album: album(), songs: all(neteaseSong) }
    case 'artists': return { artist: artist(), hotSongs: songs(), more: true }
    case 'artist_detail': return { data: { artist: artist(), identify: { imageDesc: '基准歌手' } } }
    case 'artist_desc': return { briefDesc: '固定基准艺人', introduction: [] }
    case 'artist_follow_count': return { data: { fansCnt: 1000, followCnt: 0 } }
    case 'artist_songs': return { songs: songs(), total: SONG_COUNT, more: Number(query.offset || 0) + songs().length < SONG_COUNT }
    case 'artist_album': return { artist: artist(), hotAlbums: page([album()], query), more: false }
    case 'artist_mv': return { mvs: [{ id: 1, name: '基准歌曲 001', artistName: '基准歌手', imgurl: COVER_URL, duration: 180000 }], hasMore: false }
    case 'mv_detail': return { data: { id: 1, name: '基准歌曲 001', artistId: 1, artistName: '基准歌手',
      cover: COVER_URL, duration: 180000, desc: '固定基准 MV', brs: { 720: 'https://203.0.113.10/video.mp4' } } }
    case 'mv_url': return { data: { id: 1, url: 'https://203.0.113.10/video.mp4', r: 720, code: 200 } }
    case 'lyric': case 'lyric_new': return { lrc: { lyric: '[00:00.00]基准歌曲\n[00:01.00]固定基准歌词\n[00:02.00]继续播放' }, tlyric: { lyric: '' }, romalrc: { lyric: '' } }
    case 'personalized': case 'recommend_resource': return { result: [neteasePlaylist()], recommend: [neteasePlaylist()] }
    case 'recommend_songs': return { data: { dailySongs: songs() } }
    case 'personalized_newsong': return { result: songs().map(song => ({ ...song, song })) }
    case 'top_song': return { data: songs() }
    case 'toplist_detail': case 'toplist': return { list: [neteasePlaylist()] }
    case 'login_status': return { data: { code: 200, account: null, profile: null } }
    // 不生成假登录态；匿名账号行为仍由真实本地路由判断。
    case 'user_account': return { account: null, profile: null }
    case 'comment_music': case 'comment_new': case 'comment_playlist': return { comments: [], hotComments: [], total: 0, more: false, data: { comments: [], totalCount: 0, hasMore: false } }
    case 'personalized_djprogram': return { result: [] }
    case 'dj_personalize_recommend': case 'dj_program_toplist': return { data: [], toplist: [] }
    default: return null
  }
}

function qqResult(method, query = {}) {
  switch (method) {
    case 'search': {
      if (Number(query.t) === 2) {
        const playlist = { dissid: '9001', tid: '9001', dissname: '基准歌单', name: '基准歌单',
          imgurl: COVER_URL, picurl: COVER_URL, songnum: SONG_COUNT, song_count: SONG_COUNT,
          listennum: 1000, creator: { nick: '基准用户' } }
        return { list: page([playlist], query), total: 1, pageNo: Number(query.pageNo) || 1, pageSize: Number(query.pageSize) || 30, t: 2 }
      }
      if (Number(query.t) === 9) return { list: page([artist()], query), total: 1 }
      if (Number(query.t) === 8) return { list: page([album()], query), total: 1 }
      if (query.t !== undefined && Number(query.t) !== 0) return null
      return { list: page(all(qqSong), query), total: SONG_COUNT }
    }
    case 'songlist': return qqPlaylist()
    case 'singer/songs': return { list: page(all(qqSong), query), total: SONG_COUNT,
      singer: { ...artist(), singer_id: 1, singer_mid: 'artist-fixture', singername: '基准歌手', song_num: SONG_COUNT, album_num: 1, fans: 1000 } }
    case 'singer/album': return { list: page([{ ...album(), album_mid: 'album-fixture', album_name: '基准专辑 001', albumid: 1 }], query), total: 1 }
    case 'singer/mv': return { list: [{ vid: 'mv-fixture', name: '基准歌曲 001', pic: COVER_URL }], total: 1 }
    case 'album/songs': return { list: all(qqSong), total: SONG_COUNT }
    case 'song': return { track_info: qqSong(Number(String(query.songmid || '').match(/\d+$/)?.[0]) || 1) }
    case 'song/url': return MEDIA_URL
    case 'lyric': return { lyric: QQ_FIXTURE_LRC, trans: '' }
    case 'new/songs': return { list: page(all(qqSong), query) }
    case 'recommend/playlist/u': case 'songlist/list': case 'recommend/playlist': return { list: [qqPlaylist()], total: 1 }
    case 'top': return { list: all(qqSong), total: SONG_COUNT, info: { title: '基准歌单', picUrl: COVER_URL } }
    case 'top/category': return { list: [] }
    case 'radio/category': return []
    default: return null
  }
}

function sdkRoute(method) {
  if (/search/.test(method)) return 'search'
  if (/url/.test(method)) return 'song-url'
  if (/lyric/.test(method)) return 'lyrics'
  if (/^mv_/.test(method)) return 'media'
  if (/artist|singer/.test(method)) return 'artist'
  if (/album/.test(method)) return 'album'
  if (/recommend|personalized|top|new\/songs|radio|dj_/.test(method)) return 'recommendation'
  if (/playlist|songlist/.test(method)) return 'playlist'
  if (/song/.test(method)) return 'song-detail'
  if (/login|user|config/.test(method)) return 'account'
  return 'unknown'
}

// invoke 由 probe 提供：只观察公开第三方边界，不观察 fixture 内部 helper。
const directInvoke = async (_platform, _route, value) => {
  if (value === null) throw unknownError()
  return value
}
function unknownError() {
  const error = new Error('Unsupported loading fixture')
  error.code = 'HYPERPLAYER_FIXTURE_UNKNOWN'; error.status = 501
  return error
}
function createNeteaseApi(invoke = directInvoke) {
  return new Proxy({}, {
    get(_target, method) {
      if (typeof method !== 'string' || ['then', '__esModule'].includes(method)) return undefined
      return (query = {}) => {
        const result = neteaseResult(method, query)
        return invoke('netease', result === null ? 'unknown' : sdkRoute(method),
          result === null ? null : { status: 200, body: { code: 200, ...result }, cookie: [] })
      }
    },
  })
}
function createQqMusicApi(invoke = directInvoke) {
  let cookie = {}
  return {
    get cookie() { return cookie },
    get uin() { return cookie.uin },
    setCookie(value) { cookie = typeof value === 'object' && value ? { ...value } : {} },
    api(method, query = {}) {
      const result = qqResult(method, query)
      return invoke('qq', result === null ? 'unknown' : sdkRoute(method), result)
    },
  }
}

function json(data) {
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(data)) }
}
function wav() {
  // 与 runner 共用 12 秒正弦 WAV；只在 fixture 外部网络边界加载，不是生产依赖。
  return require('./loading-renderer-fixture.cjs').audioFixture()
}

function resolveHttpFixture(url, options = {}) {
  const host = url.hostname, pathname = url.pathname
  if (host === 'fixture.invalid') {
    if (pathname === '/audio.wav') return { status: 200, headers: { 'content-type': 'audio/wav' }, body: wav() }
    if (pathname === '/cover.svg') return { status: 200, headers: { 'content-type': 'image/svg+xml' },
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#386c75"/></svg>') }
  }
  if (host === '203.0.113.10') return resolveHttpFixture(new URL(`https://fixture.invalid${pathname}`), options)
  if (/(^|\.)gtimg\.cn$/.test(host) && /\.(jpg|png|webp)$/i.test(pathname)) {
    return resolveHttpFixture(new URL(COVER_URL))
  }
  if (host === 'music.163.com') {
    if (/\/api\/playlist\/detail$|\/api\/v6\/playlist\/detail$/.test(pathname)) return json({ code: 200, playlist: neteasePlaylist() })
    if (/\/api\/song\/detail\/?$/.test(pathname)) return json({ code: 200, songs: ids(Object.fromEntries(url.searchParams)).map(neteaseSong) })
    if (/^\/api\/artist\/albums\//.test(pathname)) return json({ code: 200, artist: artist(), hotAlbums: [album()], more: false })
  }
  if (host === 'c.y.qq.com') {
    if (/\/soso\/fcgi-bin\/(search_for_qq_cp|client_search_cp)$/.test(pathname)) {
      const query = Object.fromEntries(url.searchParams)
      const list = page(all(qqSong), { limit: query.n || query.perpage || 30, page: query.p || 1 })
      return json({ code: 0, data: { song: { list, totalnum: SONG_COUNT, curnum: list.length },
        singer: { list: [{ ...artist(), singer_id: 1, singer_mid: 'artist-fixture', singer_name: '基准歌手', song_num: SONG_COUNT, album_num: 1 }], totalnum: 1 },
        album: { list: [{ ...album(), albumMID: 'album-fixture', albumName: '基准专辑 001' }], totalnum: 1 },
        mv: { list: [], totalnum: 0 } } })
    }
    if (pathname.endsWith('/fcg_get_singer_desc.fcg')) return { status: 200, headers: { 'content-type': 'text/xml' },
      body: Buffer.from('<root><singer><name>基准歌手</name><desc>固定基准艺人</desc></singer></root>') }
  }
  if (host === 'u.y.qq.com' && pathname.endsWith('/musicu.fcg')) {
    let payload
    try { payload = JSON.parse(url.searchParams.get('data') || options.body || '{}') } catch { return null }
    const result = { code: 0 }
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'comm') continue
      const param = value?.param || {}
      if (value?.module === 'music.musichallSong.PlayLyricInfo' && value?.method === 'GetPlayLyricInfo') {
        // 真实路由的 decodeQQLyricText 接受 base64 UTF-8 LRC；不伪造加密逐字歌词。
        result[key] = { code: 0, data: { lyric: Buffer.from(QQ_FIXTURE_LRC, 'utf8').toString('base64'), qrc: '', trans: '', roma: '' } }
      } else if (value?.module === 'music.pf_song_detail_svr') {
        result[key] = { code: 0, data: { track_info: qqSong(Number(String(param.song_mid || '').match(/\d+$/)?.[0]) || 1) } }
      } else if (value?.module === 'music.srfDissInfo.aiDissInfo') {
        result[key] = { code: 0, data: { code: 0, dirinfo: qqPlaylist(), total_song_num: SONG_COUNT,
          songlist: all(qqSong).slice(Number(param.song_begin) || 0, (Number(param.song_begin) || 0) + (Number(param.song_num) || 30)) } }
      } else if (/vkey/.test(value?.module || '')) {
        result[key] = { code: 0, data: { sip: ['https://203.0.113.10/'], midurlinfo: [{ purl: 'audio.wav', songmid: param.songmid?.[0], vkey: 'fixture' }] } }
      } else return null
    }
    return Object.keys(result).length > 1 ? json(result) : null
  }
  if (host === 'api.bilibili.com') {
    const video = { bvid: 'BV1fixture01', aid: 1, cid: 1, title: '基准歌曲 001', duration: 180, pic: COVER_URL,
      author: '基准歌手', mid: 1, play: 1000, pubdate: 1700000000, description: '固定基准 MV',
      stat: { view: 1000 }, owner: { mid: 1, name: '基准歌手', face: COVER_URL },
      pages: [{ cid: 1, page: 1, part: '基准歌曲 001', duration: 180 }] }
    if (pathname === '/x/web-interface/nav') return json({ code: 0, data: { isLogin: false,
      wbi_img: { img_url: 'https://fixture.invalid/0123456789abcdef0123456789abcdef.png', sub_url: 'https://fixture.invalid/fedcba9876543210fedcba9876543210.png' } } })
    if (pathname === '/x/frontend/finger/spi') return json({ code: 0, data: { b_3: 'fixture', b_4: 'fixture' } })
    if (pathname === '/x/web-interface/wbi/search/type' || pathname === '/x/web-interface/search/type') return json({ code: 0, data: { result: [video], numResults: 1, numPages: 1, page: 1 } })
    if (pathname === '/x/web-interface/view') return json({ code: 0, data: video })
    if (pathname === '/x/web-interface/card') return json({ code: 0, data: { card: { official_verify: { type: 1 } } } })
    if (pathname === '/x/player/playurl') return json({ code: 0, data: { accept_quality: [80], dash: {
      video: [{ id: 80, baseUrl: 'https://203.0.113.10/video.mp4', bandwidth: 1000000 }],
      audio: [{ id: 30280, baseUrl: MEDIA_URL, bandwidth: 128000 }] } } })
    if (pathname === '/x/player/wbi/v2') return json({ code: 0, data: { subtitle: { subtitles: [] } } })
    // 没有真实视频 fixture，video.mp4 保持 unknown/501，不能用 WAV 冒充可解码视频。
  }
  return null
}

module.exports = { SONG_COUNT, MEDIA_URL, COVER_URL, createNeteaseApi, createQqMusicApi, resolveHttpFixture, unknownError }
