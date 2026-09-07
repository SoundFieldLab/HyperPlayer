import crypto from 'node:crypto'

// server/netease-native-explore.mjs

const HOME_PATH = '/api/homepage/block/page'
const FLOW_PATH = '/api/homepage/block/page/unlimited/flow'
const PODCAST_PATH = '/api/podcast/home/tab/v2/get'
const SIMILAR_PATHS = {
  songs: '/api/v1/discovery/simiSong',
  playlists: '/api/discovery/simiPlaylist',
  users: '/api/discovery/simiUser',
}
const DAILY_PATH = '/api/v3/discovery/recommend/songs'
const ROAM_PATH = '/api/v1/radio/get'
const HEART_PATH = '/api/playmode/intelligence/list'
const DAILY_PODCAST_PATH = '/api/my/podcast/tab/recommend'
const DAILY_HISTORY_PATH = '/api/discovery/recommend/songs/history/recent'
const DAILY_HISTORY_DETAIL_PATH = '/api/discovery/recommend/songs/history/detail'
const DAILY_STYLE_CONFIG_PATH = '/api/homepage/daily/song/config/get'
const DAILY_STYLE_SONGS_PATH = '/api/homepage/category/daily/song/list'
const RED_COUNT_PATH = '/api/song/red/count'
export const RED_COUNT_BATCH_LIMIT = 40
const RED_COUNT_CONCURRENCY = 6
const RED_COUNT_TIMEOUT_MS = 8_000
const RED_COUNT_CACHE_TTL_MS = 5 * 60_000

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16)
}

export function responseBody(result) {
  const body = result?.body ?? result ?? {}
  if (!body || typeof body !== 'object') return { code: 502, message: '网易云返回了无效响应' }
  const { cookie: _cookie, ...safeBody } = body
  return safeBody
}

export function isAccountScopedCookie(cookie) {
  return /(?:^|;\s*)MUSIC_U=/.test(String(cookie || ''))
}

export function arrayResponseData(body) {
  return Array.isArray(body) ? body : body?.data ?? body
}

function createTimedCache(ttlMs, maxEntries = 24) {
  const entries = new Map()
  return {
    get(key) {
      const item = entries.get(key)
      if (!item || item.expiresAt <= Date.now()) {
        entries.delete(key)
        return null
      }
      return item.value
    },
    set(key, value) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs })
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    },
  }
}

const homeCache = createTimedCache(90_000)
const podcastCache = createTimedCache(3 * 60_000)
const redCountCache = createTimedCache(RED_COUNT_CACHE_TTL_MS, 1_000)

async function callPrivate(getNeteaseApi, uri, data, cookie) {
  const api = getNeteaseApi()
  if (!api?.api) throw new Error('网易云 API 尚未初始化')
  const result = await api.api({ uri, data, crypto: 'weapi', cookie: String(cookie || '') })
  return responseBody(result)
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

export function parseRedCountIds(rawIds, limit = RED_COUNT_BATCH_LIMIT) {
  const values = String(rawIds ?? '').split(',').map(value => value.trim())
  if (values.length === 1 && !values[0]) throw new Error('请提供歌曲 ID')
  if (values.some(value => !/^\d+$/.test(value))) throw new Error('歌曲 ID 必须是逗号分隔的数字')

  const ids = [...new Set(values)]
  if (ids.length > limit) throw new Error(`一次最多查询 ${limit} 首歌曲`)
  return ids
}

export function redCountFromBody(body) {
  if (Number(body?.code) !== 200) throw new Error(body?.message || body?.error || '网易云红心数量请求失败')
  const value = body?.data?.count ?? body?.data?.redCount ?? body?.data ?? body?.count ?? body?.redCount
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('网易云返回了无效红心数量')
  return count
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

export function formatRedCountBatch(ids, results) {
  const counts = {}
  const errors = {}
  ids.forEach((id, index) => {
    const result = results[index]
    if (result?.ok) counts[id] = result.count
    else errors[id] = result?.error || '请求失败'
  })
  return { code: 200, counts, errors, nativeProtocol: 'netease-android-9.5.81' }
}

function defaultExtInfo(raw) {
  if (raw) {
    try { return JSON.stringify(JSON.parse(String(raw))) } catch { /* use the client-compatible default */ }
  }
  return JSON.stringify({
    netstat: 1,
    guideToastLastShow: 0,
    carrier: '',
    abInfo: { 'hp-new-homepageV3.1': '' },
    requestLongVideoBanner: true,
    refreshType: 1,
    forceFreshForNewUser: false,
  })
}

export function registerNeteaseNativeExploreRoutes(app, { getNeteaseApi }) {
  app.get('/api/netease/native/home', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const refresh = String(req.query.refresh || '') === '1'
      const cursor = String(req.query.cursor || '')
      const cacheKey = `${fingerprint(cookie)}:${cursor || 'first'}`
      if (!refresh) {
        const cached = homeCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, HOME_PATH, {
        cursor: cursor || null,
        adextjson: String(req.query.adextjson || ''),
        refresh,
        extInfo: defaultExtInfo(req.query.extInfo),
      }, cookie)
      const payload = {
        ...body,
        nativeProtocol: 'netease-android-9.5.81',
        accountScoped: isAccountScopedCookie(cookie),
        generatedAt: Date.now(),
      }
      if (Number(body.code) === 200) homeCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云原生推荐加载失败' })
    }
  })

  app.get('/api/netease/native/unlimited-flow', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, FLOW_PATH, {}, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云首页乐流加载失败' })
    }
  })

  app.get('/api/netease/native/daily-songs', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, DAILY_PATH, { ispush: false }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云每日推荐加载失败' })
    }
  })

  app.get('/api/netease/native/daily-history', async (req, res) => {
    try {
      const date = String(req.query.date || '')
      const uri = date ? DAILY_HISTORY_DETAIL_PATH : DAILY_HISTORY_PATH
      const body = await callPrivate(getNeteaseApi, uri, date ? { date } : {}, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云历史日推加载失败' })
    }
  })

  app.get('/api/netease/native/daily-style', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const categoryId = String(req.query.categoryId || '')
      const tagId = String(req.query.tagId || '')
      const uri = categoryId || tagId ? DAILY_STYLE_SONGS_PATH : DAILY_STYLE_CONFIG_PATH
      const data = uri === DAILY_STYLE_CONFIG_PATH ? {} : {
        source: 'dailyrecommend',
        tagId,
        categoryId,
        songId: Number(req.query.songId) || 0,
      }
      const body = await callPrivate(getNeteaseApi, uri, data, cookie)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云风格日推加载失败' })
    }
  })

  app.get('/api/netease/native/roam', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, ROAM_PATH, {
        mode: String(req.query.mode || 'DEFAULT'),
        subMode: String(req.query.subMode || ''),
        limit: Math.max(1, Math.min(50, Number(req.query.limit) || 30)),
        entranceType: String(req.query.entranceType || ''),
        unplaySongIds: String(req.query.unplaySongIds || '[]'),
        fmCascadeModeStr: String(req.query.fmCascadeModeStr || ''),
        openAidj: String(req.query.openAidj || '') === '1',
        aidjReqTimes: Math.max(0, Number(req.query.aidjReqTimes) || 0),
      }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ code: 200, data: arrayResponseData(body), nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云私人漫游加载失败' })
    }
  })

  app.get('/api/netease/native/heart-mode', async (req, res) => {
    try {
      const songId = String(req.query.songId || '')
      const playlistId = String(req.query.playlistId || '')
      if (!/^\d+$/.test(songId) || !/^\d+$/.test(playlistId)) return res.status(400).json({ code: 400, error: '心动模式需要歌曲和我喜欢歌单' })
      const body = await callPrivate(getNeteaseApi, HEART_PATH, {
        songId,
        type: String(req.query.type || 'fromPlayOne'),
        playlistId,
        startMusicId: String(req.query.startMusicId || songId),
        count: Math.max(1, Math.min(50, Number(req.query.count) || 30)),
        extJson: String(req.query.extJson || '{}'),
      }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云心动模式加载失败' })
    }
  })

  app.get('/api/netease/native/red-counts', async (req, res) => {
    let ids
    try {
      ids = parseRedCountIds(req.query.ids)
    } catch (error) {
      return res.status(400).json({ code: 400, error: error?.message || '歌曲 ID 无效' })
    }

    const cookie = String(req.query.cookie || '')
    const results = await mapWithConcurrency(ids, RED_COUNT_CONCURRENCY, async id => {
      const cached = redCountCache.get(id)
      if (cached !== null) return { ok: true, count: cached }
      try {
        const body = await withTimeout(
          callPrivate(getNeteaseApi, RED_COUNT_PATH, { songId: id }, cookie),
          RED_COUNT_TIMEOUT_MS,
          '网易云红心数量请求超时',
        )
        const count = redCountFromBody(body)
        redCountCache.set(id, count)
        return { ok: true, count }
      } catch (error) {
        return { ok: false, error: error?.message || '请求失败' }
      }
    })

    res.setHeader('Cache-Control', 'private, max-age=60')
    res.json(formatRedCountBatch(ids, results))
  })

  app.get('/api/netease/native/similar-context', async (req, res) => {
    try {
      const songId = String(req.query.songId || '')
      if (!/^\d+$/.test(songId)) return res.status(400).json({ code: 400, error: '请提供当前歌曲 ID' })
      const cookie = String(req.query.cookie || '')
      const data = { songid: Number(songId) }
      const [songs, playlists, users] = await Promise.allSettled(
        Object.values(SIMILAR_PATHS).map(uri => withTimeout(
          callPrivate(getNeteaseApi, uri, data, cookie),
          12_000,
          '相似推荐子请求超时',
        )),
      )
      const value = result => result.status === 'fulfilled' ? result.value : { code: 502, error: result.reason?.message || '请求失败' }
      res.setHeader('Cache-Control', 'private, max-age=60')
      res.json({ code: 200, songId, songs: value(songs), playlists: value(playlists), users: value(users), nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云相似推荐加载失败' })
    }
  })

  app.get('/api/netease/native/program-detail', async (req, res) => {
    try {
      const id = String(req.query.id || '')
      if (!/^\d+$/.test(id)) return res.status(400).json({ code: 400, error: '请提供节目 ID' })
      const api = getNeteaseApi()
      if (!api?.dj_program_detail) return res.status(503).json({ code: 503, error: '网易云节目接口未初始化' })
      const result = await api.dj_program_detail({ id, cookie: String(req.query.cookie || '') })
      const body = responseBody(result)
      res.setHeader('Cache-Control', 'private, max-age=120')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云节目加载失败' })
    }
  })

  app.get('/api/netease/native/daily-podcast', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, DAILY_PODCAST_PATH, {
        scenePageCode: 'PAGE_MY_PODCAST',
        blockCode: 'MY_PAGE_PODCAST_RECOMMEND',
      }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ code: 200, data: arrayResponseData(body), nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云每日播客加载失败' })
    }
  })

  app.get('/api/netease/native/podcast-home', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const cacheKey = fingerprint(cookie)
      const cached = podcastCache.get(cacheKey)
      if (cached) return res.json(cached)
      const body = await callPrivate(getNeteaseApi, PODCAST_PATH, {
        pageCode: 'PODCAST_TAB_V2',
        subParams: String(req.query.subParams || '{}'),
      }, cookie)
      const payload = { ...body, nativeProtocol: 'netease-android-9.5.81' }
      if (Number(body.code) === 200) podcastCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云播客推荐加载失败' })
    }
  })
}
