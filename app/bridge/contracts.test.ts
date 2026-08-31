import { beforeEach, describe, expect, it } from "vitest";
import { adaptPlayback, adaptTrack, bridge, bridgeError, TAURI_COMMANDS } from "./index";
import type { BackendPlaybackStateDto, BackendQueueSnapshotDto } from "./contracts";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
} satisfies Storage });
beforeEach(() => storage.clear());

const track = {
  trackRef: { id: "track-1", source: "local" as const },
  title: "Track",
  artists: ["Artist"],
  album: "Album",
  durationMs: 120_000,
  qualityLabel: "无损",
  playable: true,
};

const playback: BackendPlaybackStateDto = {
  status: "paused",
  currentTrack: track,
  positionMs: 10,
  durationMs: 120_000,
  volume: 0.5,
  muted: false,
  repeatMode: "sequential",
};

const queue: BackendQueueSnapshotDto = {
  currentItemId: "queue-current",
  playNext: [{ queueItemId: "queue-next", track }],
  context: [{ queueItemId: "queue-context", track }],
  revision: 3,
};

describe("bridge contract adapters", () => {
  it("preserves stable queue item identities", () => {
    const result = adaptPlayback(playback, queue);
    expect(result.currentQueueItemId).toBe("queue-current");
    expect(result.nextUp[0].queueItemId).toBe("queue-next");
    expect(result.queue[0].queueItemId).toBe("queue-context");
  });

  it("keeps trusted metadata separate from the command TrackRef", () => {
    const result = adaptPlayback(playback, queue);
    expect(result.current).toMatchObject({ id: "track-1", source: "local", title: "Track" });
  });

  it("adapts nullable backend metadata without inventing availability", () => {
    expect(adaptTrack({ ...track, album: null, durationMs: null, qualityLabel: null, playable: false })).toMatchObject({
      album: "未知专辑",
      durationMs: 0,
      quality: "标准",
      entitlement: "unavailable",
      cache: "none",
    });
  });

  it("classifies structured unavailable errors", () => {
    expect(bridgeError({ code: "unavailable", message: "not configured" })).toEqual({ code: "unavailable", message: "not configured", unavailable: true });
    expect(bridgeError(new Error("network failed"))).toMatchObject({ code: "unknown", message: "network failed", unavailable: false });
  });

  it("declares the Tauri-only bridge contract", () => {
    expect(typeof bridge.bootstrap).toBe("function");
    expect(typeof bridge.libraryPickLocation).toBe("function");
  });

  it("declares every newly connected command", () => {
    expect(Object.values(TAURI_COMMANDS)).toHaveLength(79);
    expect(Object.values(TAURI_COMMANDS)).toEqual(expect.arrayContaining([
      "playback_stop", "playback_next", "playback_previous", "playback_set_repeat_mode",
      "library_overview", "library_query_tracks", "library_register_location", "library_start_scan", "library_cancel_scan",
      "library_create_playlist", "library_rename_playlist", "library_delete_playlist", "library_add_playlist_track", "library_remove_playlist_track", "library_reorder_playlist_track",
      "netease_status", "netease_search", "netease_home", "netease_album_detail", "netease_playlist_detail", "netease_artist_detail", "netease_personal_fm",
      "netease_mvs", "netease_mv_detail", "netease_dj_radios", "netease_dj_programs", "netease_charts", "netease_new_songs",
      "netease_account", "netease_favorites", "netease_comments", "netease_follows", "netease_cloud", "netease_image", "netease_start_qr_login", "netease_poll_qr_login", "netease_logout",
      "cache_stats", "cache_status", "cache_track", "cache_remove", "cache_clear", "lyrics_get",
      "window_show", "window_hide", "window_close", "window_set_always_on_top", "desktop_lyrics_set_click_through",
      "updater_status", "updater_check", "updater_update",
    ]));
  });
});
