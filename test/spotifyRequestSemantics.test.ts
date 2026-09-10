/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  clear: () => storage.clear(),
  getItem: (key: string) => storage.get(key) ?? null,
  removeItem: (key: string) => storage.delete(key),
  setItem: (key: string, value: string) => storage.set(key, String(value)),
})

const { renameSpotifyPlaylist, spotifyFetch } = await import('../src/services/spotifyService')

describe('Spotify request semantics', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('spotify_access_token', 'token')
    vi.restoreAllMocks()
  })

  it('treats successful empty responses as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(spotifyFetch('/me', { method: 'PUT' })).resolves.toEqual({ ok: true })
    await expect(renameSpotifyPlaylist('playlist', 'Renamed')).resolves.toBe(true)
  })
})
