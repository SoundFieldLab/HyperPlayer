import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const collection = (source: string, items: unknown[]) => ({ source, sourceUrl: '', updatedAt: Date.now(), items })

describe('hazard snapshot stability', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps the last successful source when a partial refresh returns null', async () => {
    const typhoons = collection('typhoon', [{ id: 'one' }])
    const earthquakes = collection('earthquake', [{ id: 'quake-one' }])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, typhoons, earthquakes, errors: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, typhoons: null, earthquakes: collection('earthquake', [{ id: 'quake-two' }]), errors: { typhoons: 'temporary', earthquakes: '' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { ensureHazardSnapshot } = await import('../src/services/hazardService')

    await ensureHazardSnapshot({ forceRefresh: true })
    const refreshed = await ensureHazardSnapshot({ forceRefresh: true })

    expect(refreshed.typhoons?.items).toEqual([{ id: 'one' }])
    expect(refreshed.earthquakes?.items).toEqual([{ id: 'quake-two' }])
    expect(refreshed.errors.typhoons).toBe('temporary')
  })

  it('reports internal timeout instead of silently exposing an empty state', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))
    const { ensureHazardSnapshot } = await import('../src/services/hazardService')
    const request = ensureHazardSnapshot({ forceRefresh: true })
    const expectation = expect(request).rejects.toThrow('灾害信息请求超时')

    await vi.advanceTimersByTimeAsync(35_000)
    await expectation
  })
})
