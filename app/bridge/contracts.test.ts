import { beforeEach, describe, expect, it } from "vitest";
import { adaptDspConfigurationRejected, adaptPlayback, adaptTrack, bridge, bridgeError, createEngineSnapshotGate, TAURI_COMMANDS, TAURI_EVENTS } from "./index";
import type { BackendDspExecutionStatusDto, BackendPlaybackStateDto, BackendQueueSnapshotDto, DspConfigurationDto, DspProcessingFaultDto } from "./contracts";

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

const healthyDsp = (revision: number): BackendDspExecutionStatusDto => ({
  revision: revision.toString(),
  safeBypassActive: false,
  fault: null,
});

describe("bridge contract adapters", () => {
  it("preserves stable queue item identities", () => {
    const result = adaptPlayback({ revision: queue.revision, playback, queue, dspExecution: healthyDsp(0) });
    expect(result.dsp).toEqual({
      available: true,
      bypassed: true,
      label: "Rust DSP runtime 与参数桥已接通；当前支持 21 阶段实时处理（spatial 待合规资产）",
    });
    expect(result.currentQueueItemId).toBe("queue-current");
    expect(result.nextUp[0].queueItemId).toBe("queue-next");
    expect(result.queue[0].queueItemId).toBe("queue-context");
  });

  it("keeps trusted metadata separate from the command TrackRef", () => {
    const result = adaptPlayback({ revision: queue.revision, playback, queue, dspExecution: healthyDsp(0) });
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

  it("keeps atomic engine snapshots monotonic and scopes progress by revision", () => {
    const gate = createEngineSnapshotGate();
    const snapshot = (revision: number, positionMs: number) => ({
      revision,
      playback: { ...playback, positionMs },
      queue: { ...queue, revision },
      dspExecution: healthyDsp(4),
    });

    expect(gate.accept(snapshot(7, 70)).positionMs).toBe(70);
    expect(gate.accept(snapshot(5, 50)).positionMs).toBe(70);
    expect(gate.accept(snapshot(7, 71)).positionMs).toBe(70);
    expect(gate.accept(snapshot(8, 80)).positionMs).toBe(80);
    expect(gate.acceptProgress({ revision: 7, positionMs: 700, durationMs: 120_000 })).toBe("ignore");
    expect(gate.acceptProgress({ revision: 8, positionMs: 800, durationMs: 120_000 })).toBe("apply");
    expect(gate.current().positionMs).toBe(800);
    expect(gate.accept(snapshot(8, 81)).positionMs).toBe(800);
    expect(gate.acceptProgress({ revision: 9, positionMs: 900, durationMs: 120_000 })).toBe("resync");
    expect(() => gate.accept({ ...snapshot(9, 90), queue: { ...queue, revision: 8 } })).toThrow("revisions do not match");
  });

  it("merges DSP execution status independently from playback revision", () => {
    const gate = createEngineSnapshotGate();
    const base = { revision: 7, playback, queue: { ...queue, revision: 7 }, dspExecution: healthyDsp(8) };
    const fault = {
      revision: "8",
      processorIndex: 2,
      processorName: "compressor",
      kind: "nonFiniteOutput" as const,
      streamFrame: "4096",
      safeBypassActive: true,
      fallbackStatus: "rustSafeBypass" as const,
    };

    gate.accept(base);
    expect(gate.accept({ ...base, dspExecution: { revision: "8", safeBypassActive: true, fault: null } })).toMatchObject({
      dsp: { available: true, bypassed: true },
      dspExecution: {
        revision: 8n,
        safeBypassActive: true,
        fault: null,
      },
    });
    expect(gate.accept({ ...base, revision: 6, queue: { ...queue, revision: 6 }, dspExecution: { revision: "8", safeBypassActive: true, fault } })).toMatchObject({
      revision: 7,
      dspExecution: {
        revision: 8n,
        safeBypassActive: true,
        fault: { ...fault, revision: 8n, streamFrame: 4096n },
      },
    });
    expect(gate.accept({ ...base, dspExecution: healthyDsp(8) }).dspExecution?.safeBypassActive).toBe(true);
    expect(gate.accept({ ...base, dspExecution: healthyDsp(9) })).toMatchObject({
      dsp: { available: true, bypassed: false },
      dspExecution: { revision: 9n, safeBypassActive: false, fault: null },
    });
  });

  it("declares the Tauri-only bridge contract", () => {
    expect(typeof bridge.bootstrap).toBe("function");
    expect(typeof bridge.libraryPickLocation).toBe("function");
    expect(typeof bridge.createTelemetryTransport).toBe("function");
    expect(bridge.createTelemetryTransport()).not.toBe(bridge.createTelemetryTransport());
  });

  it("declares every backend event in the frontend manifest", () => {
    expect(Object.values(TAURI_EVENTS)).toHaveLength(14);
    expect(TAURI_EVENTS.dspConfigurationRejected).toBe("hyperplayer://dsp/configuration-rejected");
    expect(TAURI_EVENTS.dspProcessingFault).toBe("hyperplayer://dsp/processing-fault");
  });

  it("preserves DSP rejection revisions beyond the JavaScript safe integer range", () => {
    expect(adaptDspConfigurationRejected({
      revision: "9007199254740993",
      code: "applyFailed",
      reason: "DSP configuration could not be applied to the audio runtime",
      stage: "apply",
    }).revision).toBe(9_007_199_254_740_993n);
  });

  it("contracts DSP processing faults as Rust safe-bypass diagnostics", () => {
    const fault = {
      revision: 8n,
      processorIndex: 2,
      processorName: "compressor",
      kind: "nonFiniteOutput",
      streamFrame: 4096n,
      safeBypassActive: true,
      fallbackStatus: "rustSafeBypass",
    } satisfies DspProcessingFaultDto;

    expect(fault).toMatchObject({ safeBypassActive: true, fallbackStatus: "rustSafeBypass" });
    expect(fault).not.toHaveProperty("pcm");
  });

  it("declares every newly connected command", () => {
    expect(Object.values(TAURI_COMMANDS)).toHaveLength(90);
    expect(Object.values(TAURI_COMMANDS)).toEqual(expect.arrayContaining([
      "playback_stop", "playback_next", "playback_previous", "playback_set_repeat_mode",
      "library_overview", "library_query_tracks", "library_register_location", "library_start_scan", "library_cancel_scan",
      "library_create_playlist", "library_rename_playlist", "library_delete_playlist", "library_add_playlist_track", "library_remove_playlist_track", "library_reorder_playlist_track",
      "netease_status", "netease_search", "netease_home", "netease_album_detail", "netease_playlist_detail", "netease_artist_detail", "netease_personal_fm",
      "netease_mvs", "netease_mv_detail", "netease_dj_radios", "netease_dj_programs", "netease_charts", "netease_new_songs",
      "netease_account", "netease_favorites", "netease_comments", "netease_follows", "netease_cloud", "netease_image", "netease_start_qr_login", "netease_poll_qr_login", "netease_logout",
      "cache_stats", "cache_status", "cache_track", "cache_remove", "cache_clear", "lyrics_get",
      "window_show", "window_hide", "window_close", "window_set_always_on_top", "desktop_lyrics_set_click_through",
      "updater_status", "updater_check", "updater_update", "shenzhen_weather",
      "dsp_get_configuration", "dsp_configure", "dsp_list_presets", "dsp_apply_preset", "dsp_import_hse2", "dsp_export_hse2",
      "telemetry_subscribe", "telemetry_ack", "telemetry_set_activity", "telemetry_close",
    ]));
  });

  it("defaults the 21-stage DSP configuration to transparent new-stage sections", () => {
    // 与 Rust `DspConfig::default()` 的 camelCase 投影一致：13/15/16/17/18/20/21 全部禁用、
    // 其余参数对齐各 stage 默认值；本断言同时让 TypeScript 校验完整 DTO 形状。
    const configuration: Omit<DspConfigurationDto, "revision" | "loudnessNormalization" | "surround3d" | "midSide" | "preEq" | "deesser" | "compressor" | "nightMode" | "delay" | "chorus" | "flanger" | "phaser" | "tremolo" | "bassEnhancer"> = {
      reverb: { enabled: false, mode: "algorithmic", reverbType: "hall", roomSize: 0.5, damping: 0.5, wet: 0.3, dry: 0.7, preDelayMs: 0, width: 1, fdnLines: 8, mix: 0.3, partitionSize: 512, shortRegionMs: 100 },
      loudnessComp: { enabled: false, mode: "auto", preset: "flat", volumePercent: 100, maxBoostDb: 12, smoothingSeconds: 0.2, bands: [] },
      dynamicEq: { enabled: false, strength: 1, thresholdDb: -20, ratio: 2, kneeDb: 6, attackMs: 20, releaseMs: 200, blockSize: 128, bands: [
        { enabled: true, frequency: 200, targetGainDb: 0 },
        { enabled: true, frequency: 800, targetGainDb: 0 },
        { enabled: true, frequency: 2500, targetGainDb: 0 },
        { enabled: true, frequency: 8000, targetGainDb: 0 },
        { enabled: true, frequency: 0, targetGainDb: 0 },
      ] },
      limiter: { enabled: false, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true },
      ieq: { enabled: false, strength: 0.5, targetCurve: "flat", timeConstantSec: 3 },
      modulation: { enabled: false, lfoShape: "sine", lfoRateHz: 1, lfoDepth: 0.5, envelopeAttackMs: 10, envelopeReleaseMs: 200, envelopeAmount: 0.5, routes: [] },
      lufsMetering: { mode: "hseV151" },
    };
    expect(configuration.reverb.enabled).toBe(false);
    expect(configuration.loudnessComp.enabled).toBe(false);
    expect(configuration.dynamicEq.bands).toHaveLength(5);
    expect(configuration.limiter.thresholdDb).toBe(-1);
  });
});
