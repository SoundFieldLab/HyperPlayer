import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSongUrlCache,
  getSongUrl,
  invalidateSongUrl,
  refreshSongUrlOnce,
} from '../src/services/musicApi'
import type { MusicPlatform } from '../src/services/platforms'

// 通过真实 musicApi 公开接口观察结果；仅替换浏览器、存储、网络与时钟边界。
const START = Date.UTC(2026, 10, 11)
const browserEvents = new EventTarget()
const fetchMock = vi.fn<typeof fetch>()

function songResponse(platform: MusicPlatform, url: string | null): Response {
  return Response.json(platform === 'qq' ? { url } : { data: [{ url }] })
}

function requestUrl(index = 0): URL {
  return new URL(String(fetchMock.mock.calls[index][0]))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  localStorage.clear()
  clearSongUrlCache()
  fetchMock.mockReset()
  // 意外的额外请求必须立即失败，不能落到真实网络。
  fetchMock.mockImplementation(() => {
    throw new Error('未设置响应的歌曲 URL 请求')
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', {
    addEventListener: browserEvents.addEventListener.bind(browserEvents),
    dispatchEvent: browserEvents.dispatchEvent.bind(browserEvents),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
})

afterEach(() => {
  clearSongUrlCache()
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each<MusicPlatform>(['netease', 'qq'])('%s 歌曲 URL 缓存身份与有效期', platform => {
  it('音质变化使用独立缓存，切回原音质仍复用原 URL', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/auto'))
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/lossless'))
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/auto')
    localStorage.setItem('audioQualitySettings', JSON.stringify({ [platform]: 'lossless' }))
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/lossless')
    localStorage.removeItem('audioQualitySettings')
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/auto')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestUrl(0).searchParams.get('quality')).toBe('auto')
    expect(requestUrl(1).searchParams.get('quality')).toBe('lossless')
  })

  it('VIP 身份变化使用独立缓存，切回免费身份仍复用原 URL', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/free'))
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/vip'))
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/free')
    localStorage.setItem(`${platform}_vip`, 'true')
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/vip')
    localStorage.setItem(`${platform}_vip`, 'false')
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/free')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestUrl(0).searchParams.get('vip')).toBe('false')
    expect(requestUrl(1).searchParams.get('vip')).toBe('true')
  })

  it('cookie 指纹隔离账号，保留旧键回退及新键优先级', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/legacy-account'))
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/current-account'))
    localStorage.setItem(`${platform}Cookie`, 'session=legacy')
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/legacy-account')
    localStorage.setItem(`${platform}_cookie`, 'session=current')
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/current-account')
    localStorage.setItem(`${platform}Cookie`, 'session=ignored')
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/current-account')
    localStorage.removeItem(`${platform}_cookie`)
    localStorage.setItem(`${platform}Cookie`, 'session=legacy')
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/legacy-account')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestUrl(0).searchParams.get('cookie')).toBe('session=legacy')
    expect(requestUrl(1).searchParams.get('cookie')).toBe('session=current')
  })

  it('正缓存持续 5 分钟，精确到期时重新请求', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/first'))
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/renewed'))
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/first')
    vi.setSystemTime(START + 300_000 - 1)
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/first')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(START + 300_000)
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/renewed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('空 URL 负缓存持续 25 秒，精确到期时重新请求', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse(platform, null))
      .mockResolvedValueOnce(songResponse(platform, 'https://cdn.test/recovered'))
    expect(await getSongUrl('42', platform)).toBeNull()
    vi.setSystemTime(START + 25_000 - 1)
    expect(await getSongUrl('42', platform)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(START + 25_000)
    expect(await getSongUrl('42', platform)).toBe('https://cdn.test/recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('歌曲 URL 缓存隔离', () => {
  it('相同歌曲标识在两个平台互不命中', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/netease'))
      .mockResolvedValueOnce(songResponse('qq', 'https://cdn.test/qq'))
    expect(await getSongUrl('42', 'netease')).toBe('https://cdn.test/netease')
    expect(await getSongUrl('42', 'qq')).toBe('https://cdn.test/qq')
    expect(await getSongUrl('42', 'netease')).toBe('https://cdn.test/netease')
    expect(await getSongUrl('42', 'qq')).toBe('https://cdn.test/qq')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestUrl(0).pathname).toBe('/api/netease/song/url')
    expect(requestUrl(1).pathname).toBe('/api/qq/song/url')
  })

  it('跨平台回退设置仅隔离网易缓存，QQ 缓存不受影响', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/original'))
      .mockResolvedValueOnce(songResponse('qq', 'https://cdn.test/qq'))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/fallback'))
    expect(await getSongUrl('42', 'netease')).toBe('https://cdn.test/original')
    expect(await getSongUrl('42', 'qq')).toBe('https://cdn.test/qq')
    localStorage.setItem('crossPlatformFallbackEnabled', 'true')
    expect(await getSongUrl('42', 'netease')).toBe('https://cdn.test/fallback')
    expect(await getSongUrl('42', 'qq')).toBe('https://cdn.test/qq')
    localStorage.setItem('crossPlatformFallbackEnabled', 'false')
    expect(await getSongUrl('42', 'netease')).toBe('https://cdn.test/original')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(requestUrl(0).searchParams.get('fallback')).toBe('false')
    expect(requestUrl(2).searchParams.get('fallback')).toBe('true')
  })
})

describe('歌曲 URL 请求完成、异常与并发', () => {
  it.each([
    { url: 'https://cdn.test/ready', ttl: 300_000 },
    { url: null, ttl: 25_000 },
  ])('TTL 从成功响应完成时起算（url=$url）', async ({ url, ttl }) => {
    const response = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/next'))
    const pending = getSongUrl('42')
    vi.setSystemTime(START + 10_000)
    response.resolve(songResponse('netease', url))
    expect(await pending).toBe(url)
    vi.setSystemTime(START + 10_000 + ttl - 1)
    expect(await getSongUrl('42')).toBe(url)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(START + 10_000 + ttl)
    expect(await getSongUrl('42')).toBe('https://cdn.test/next')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['network', 'http'] as const)('%s 异常返回 null 但不写入负缓存', async failure => {
    if (failure === 'network') {
      fetchMock.mockRejectedValueOnce(new Error('测试网络断开'))
    } else {
      fetchMock.mockResolvedValueOnce(Response.json({ error: '测试服务不可用' }, { status: 503 }))
    }
    fetchMock.mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/retry'))
    expect(await getSongUrl('42')).toBeNull()
    expect(await getSongUrl('42')).toBe('https://cdn.test/retry')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await getSongUrl('42')).toBe('https://cdn.test/retry')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['https://cdn.test/shared', null])('同键并发只请求一次并共享结果（url=%s）', async url => {
    const response = deferred<Response>()
    fetchMock.mockReturnValueOnce(response.promise)
    const first = getSongUrl(42)
    const second = getSongUrl('42')
    const third = getSongUrl('42')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    response.resolve(songResponse('netease', url))
    expect(await Promise.all([first, second, third])).toEqual([url, url, url])
    expect(await getSongUrl('42')).toBe(url)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('合并的并发请求失败后允许立即重新请求', async () => {
    const response = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(songResponse('qq', 'https://cdn.test/retry'))
    const first = getSongUrl('42', 'qq')
    const second = getSongUrl('42', 'qq')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    response.reject(new Error('测试并发网络失败'))
    expect(await Promise.all([first, second])).toEqual([null, null])
    expect(await getSongUrl('42', 'qq')).toBe('https://cdn.test/retry')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('不同 cookie 的在途请求互不合并', async () => {
    const accountA = deferred<Response>()
    const accountB = deferred<Response>()
    fetchMock.mockReturnValueOnce(accountA.promise).mockReturnValueOnce(accountB.promise)
    localStorage.setItem('netease_cookie', 'session=account-a')
    const first = getSongUrl('42')
    localStorage.setItem('netease_cookie', 'session=account-b')
    const second = getSongUrl('42')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    accountB.resolve(songResponse('netease', 'https://cdn.test/account-b'))
    expect(await second).toBe('https://cdn.test/account-b')
    accountA.resolve(songResponse('netease', 'https://cdn.test/account-a'))
    expect(await first).toBe('https://cdn.test/account-a')
    expect(await getSongUrl('42')).toBe('https://cdn.test/account-b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('歌曲 URL 清理与单键失效竞态', () => {
  it('全局清理同时移除正缓存和负缓存', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/old'))
      .mockResolvedValueOnce(songResponse('qq', null))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/current'))
      .mockResolvedValueOnce(songResponse('qq', 'https://cdn.test/recovered'))
    expect(await getSongUrl('42')).toBe('https://cdn.test/old')
    expect(await getSongUrl('43', 'qq')).toBeNull()
    clearSongUrlCache()
    expect(await getSongUrl('42')).toBe('https://cdn.test/current')
    expect(await getSongUrl('43', 'qq')).toBe('https://cdn.test/recovered')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each(['resolve', 'reject'] as const)('全局清理后旧请求 %s，按当前账号与音质重新获取 URL', async outcome => {
    const oldResponse = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/current'))
    localStorage.setItem('netease_cookie', 'session=old')
    const oldRequest = getSongUrl('42')
    clearSongUrlCache()
    localStorage.setItem('netease_cookie', 'session=current')
    localStorage.setItem('audioQualitySettings', JSON.stringify({ netease: 'lossless' }))
    if (outcome === 'resolve') oldResponse.resolve(songResponse('netease', 'https://cdn.test/stale'))
    else oldResponse.reject(new Error('被清理的旧请求失败'))
    expect(await oldRequest).toBe('https://cdn.test/current')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestUrl(1).searchParams.get('cookie')).toBe('session=current')
    expect(requestUrl(1).searchParams.get('quality')).toBe('lossless')
    expect(await getSongUrl('42')).toBe('https://cdn.test/current')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('全局清理后旧请求返回当前已缓存的 URL，不覆盖较新结果', async () => {
    const oldResponse = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/current'))
    const oldRequest = getSongUrl('42')
    clearSongUrlCache()
    expect(await getSongUrl('42')).toBe('https://cdn.test/current')
    oldResponse.resolve(songResponse('netease', 'https://cdn.test/stale'))
    expect(await oldRequest).toBe('https://cdn.test/current')
    expect(await getSongUrl('42')).toBe('https://cdn.test/current')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('全局清理后旧请求加入当前在途请求，不重复拉取', async () => {
    const oldResponse = deferred<Response>()
    const currentResponse = deferred<Response>()
    fetchMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise)
    const oldRequest = getSongUrl('42')
    clearSongUrlCache()
    const currentRequest = getSongUrl('42')
    oldResponse.resolve(songResponse('netease', 'https://cdn.test/stale'))
    currentResponse.resolve(songResponse('netease', 'https://cdn.test/current'))
    expect(await Promise.all([oldRequest, currentRequest])).toEqual([
      'https://cdn.test/current', 'https://cdn.test/current',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)('单键失效后旧请求 %s 返回 null，且不能删除较新的 pending', async outcome => {
    const oldResponse = deferred<Response>()
    const currentResponse = deferred<Response>()
    fetchMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise)
    const oldRequest = getSongUrl('42')
    invalidateSongUrl('42')
    const currentRequest = getSongUrl('42')
    if (outcome === 'resolve') oldResponse.resolve(songResponse('netease', 'https://cdn.test/stale'))
    else oldResponse.reject(new Error('被失效的旧请求失败'))
    expect(await oldRequest).toBeNull()
    // 旧请求的 finally 已执行；第三个调用仍应加入新的 pending。
    const joinedRequest = getSongUrl('42')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    currentResponse.resolve(songResponse('netease', 'https://cdn.test/current'))
    expect(await Promise.all([currentRequest, joinedRequest])).toEqual([
      'https://cdn.test/current', 'https://cdn.test/current',
    ])
    expect(await getSongUrl('42')).toBe('https://cdn.test/current')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('单键失效只影响当前歌曲与平台，其他缓存继续命中', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/old'))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/other-song'))
      .mockResolvedValueOnce(songResponse('qq', 'https://cdn.test/other-platform'))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/current'))
    await getSongUrl('42')
    await getSongUrl('43')
    await getSongUrl('42', 'qq')
    invalidateSongUrl('42')
    expect(await getSongUrl('43')).toBe('https://cdn.test/other-song')
    expect(await getSongUrl('42', 'qq')).toBe('https://cdn.test/other-platform')
    expect(await getSongUrl('42')).toBe('https://cdn.test/current')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('歌曲 URL 单次刷新', () => {
  it('刷新跳过已有缓存并合并同一失败 URL，完成后冷却 15 秒', async () => {
    const refreshedResponse = deferred<Response>()
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/expired'))
      .mockReturnValueOnce(refreshedResponse.promise)
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/next-refresh'))
    expect(await getSongUrl('42')).toBe('https://cdn.test/expired')
    const first = refreshSongUrlOnce('42', 'netease', 'https://cdn.test/expired')
    const second = refreshSongUrlOnce('42', 'netease', 'https://cdn.test/expired')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(START + 10_000)
    refreshedResponse.resolve(songResponse('netease', 'https://cdn.test/refreshed'))
    expect(await Promise.all([first, second])).toEqual([
      'https://cdn.test/refreshed', 'https://cdn.test/refreshed',
    ])
    expect(await getSongUrl('42')).toBe('https://cdn.test/refreshed')
    expect(await refreshSongUrlOnce('42', 'netease', 'https://cdn.test/expired')).toBeNull()
    vi.setSystemTime(START + 10_000 + 14_999)
    expect(await refreshSongUrlOnce('42', 'netease', 'https://cdn.test/expired')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(START + 10_000 + 15_000)
    expect(await refreshSongUrlOnce('42', 'netease', 'https://cdn.test/expired')).toBe('https://cdn.test/next-refresh')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('冷却按失败 URL 隔离，同一歌曲的另一个失败 URL 可立即刷新', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/refreshed-a'))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/refreshed-b'))
    expect(await refreshSongUrlOnce('42', 'netease', 'https://cdn.test/failed-a')).toBe('https://cdn.test/refreshed-a')
    expect(await refreshSongUrlOnce('42', 'netease', 'https://cdn.test/failed-a')).toBeNull()
    expect(await refreshSongUrlOnce('42', 'netease', 'https://cdn.test/failed-b')).toBe('https://cdn.test/refreshed-b')
    expect(await refreshSongUrlOnce('42', 'netease', 'https://cdn.test/failed-a')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('冷却按歌曲和平台隔离', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/netease-42'))
      .mockResolvedValueOnce(songResponse('qq', 'https://cdn.test/qq-42'))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/netease-43'))
    const failedUrl = 'https://cdn.test/shared-failed-url'
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBe('https://cdn.test/netease-42')
    expect(await refreshSongUrlOnce('42', 'qq', failedUrl)).toBe('https://cdn.test/qq-42')
    expect(await refreshSongUrlOnce('43', 'netease', failedUrl)).toBe('https://cdn.test/netease-43')
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['network', 'empty'] as const)('刷新返回 null（%s）也冷却，到点主动失效后可重试', async failure => {
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('测试刷新网络失败'))
    else fetchMock.mockResolvedValueOnce(songResponse('netease', null))
    fetchMock.mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/recovered'))
    const failedUrl = 'https://cdn.test/expired'
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBeNull()
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(START + 15_000)
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBe('https://cdn.test/recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('全局清理移除刷新冷却，允许立即重新刷新同一失败 URL', async () => {
    fetchMock
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/first'))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/second'))
    const failedUrl = 'https://cdn.test/expired'
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBe('https://cdn.test/first')
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBeNull()
    clearSongUrlCache()
    expect(await refreshSongUrlOnce('42', 'netease', failedUrl)).toBe('https://cdn.test/second')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('刷新使原在途请求失效，原调用返回 null 而刷新返回新 URL', async () => {
    const oldResponse = deferred<Response>()
    const refreshedResponse = deferred<Response>()
    fetchMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(refreshedResponse.promise)
    const original = getSongUrl('42')
    const refreshed = refreshSongUrlOnce('42', 'netease', 'https://cdn.test/expired')
    oldResponse.resolve(songResponse('netease', 'https://cdn.test/stale'))
    expect(await original).toBeNull()
    const joined = getSongUrl('42')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    refreshedResponse.resolve(songResponse('netease', 'https://cdn.test/refreshed'))
    expect(await Promise.all([refreshed, joined])).toEqual([
      'https://cdn.test/refreshed', 'https://cdn.test/refreshed',
    ])
  })
})

describe('歌曲 URL 浏览器边界', () => {
  it.each(['hyperplayer-audio-quality-changed', 'hyperplayer-auth-changed'])(
    '%s 事件清除旧 URL',
    async eventName => {
      fetchMock
        .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/old'))
        .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/current'))
      expect(await getSongUrl('42')).toBe('https://cdn.test/old')
      browserEvents.dispatchEvent(new Event(eventName))
      expect(await getSongUrl('42')).toBe('https://cdn.test/current')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it('26 秒请求超时返回 null，取消后的请求不写负缓存', async () => {
    fetchMock
      .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('测试请求超时', 'AbortError'))
        }, { once: true })
      }))
      .mockResolvedValueOnce(songResponse('netease', 'https://cdn.test/retry'))
    const pending = getSongUrl('42')
    await vi.advanceTimersByTimeAsync(26_000)
    expect(await pending).toBeNull()
    expect(await getSongUrl('42')).toBe('https://cdn.test/retry')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
