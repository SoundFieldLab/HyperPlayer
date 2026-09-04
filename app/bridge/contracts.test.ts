import { describe, expect, it } from "vitest";
import { adaptTrack, bridgeError, TAURI_COMMANDS, TAURI_EVENTS } from "./index";
import type { PlaybackSnapshotDto, DspProcessingFaultDto } from "./contracts";

describe("bridge contract surface", () => {
  it("exposes the full Tauri command manifest", () => {
    expect(Object.keys(TAURI_COMMANDS).length).toBeGreaterThanOrEqual(46);
    expect(TAURI_COMMANDS.bootstrap).toBe("bootstrap");
    expect(TAURI_COMMANDS.credentialGet).toBe("credential_get");
    expect(TAURI_COMMANDS.smtcUpdateMetadata).toBe("smtc_update_metadata");
  });

  it("exposes the event manifest with media key downlink", () => {
    expect(TAURI_EVENTS.mediaKeyPressed).toBe("hyperplayer://windows/media-key-pressed");
    expect(TAURI_EVENTS.libraryScanProgress).toBe("hyperplayer://library/scan-progress");
  });

  it("adapts backend tracks into UI tracks", () => {
    const track = {
      trackRef: { id: "track-1", source: "local" as const },
      title: "Track",
      artists: ["Artist"],
      album: "Album",
      durationMs: 120_000,
      qualityLabel: "无损",
      playable: true,
    };
    const result = adaptTrack(track);
    expect(result.id).toBe("track-1");
    expect(result.source).toBe("local");
    expect(result.quality).toBe("无损");
    expect(result.entitlement).toBe("free");
    expect(result.durationMs).toBe(120_000);
  });

  it("maps bridge errors to { code, message, unavailable }", () => {
    expect(bridgeError({ code: "unavailable", message: "no backend" })).toEqual({
      code: "unavailable",
      message: "no backend",
      unavailable: true,
    });
    expect(bridgeError(new Error("boom"))).toEqual({
      code: "unknown",
      message: "boom",
      unavailable: false,
    });
  });

  it("playback snapshot DTO shape matches the playback service contract", () => {
    const snapshot: PlaybackSnapshotDto = {
      revision: "1",
      status: "paused",
      current: null,
      currentQueueItemId: null,
      positionMs: 0,
      durationMs: null,
      volume: 0.5,
      repeat: "off",
      shuffled: false,
      queue: [],
      nextUp: [],
      dspExecution: { revision: "0", safeBypassActive: false, fault: null },
    };
    expect(snapshot.dspExecution.revision).toBe("0");
    expect(snapshot.queue).toEqual([]);
  });

  it("DSP processing fault DTO carries processor/stage/code/reason", () => {
    const fault: DspProcessingFaultDto = {
      revision: "1",
      processorName: "Limiter",
      stage: "21",
      code: "LIMITER_OVERDRIVE",
      reason: "limiter exceeded budget",
    };
    expect(fault.processorName).toBe("Limiter");
    expect(fault.code).toBe("LIMITER_OVERDRIVE");
  });
});
