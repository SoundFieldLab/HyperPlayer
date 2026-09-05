import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installConsoleCapture, resetConsoleCaptureForTests } from "./weblog";

describe("weblog console capture", () => {
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    resetConsoleCaptureForTests();
  });

  afterEach(() => {
    Object.assign(console, originals);
    vi.useRealTimers();
  });

  it("captures console output and flushes to the sender", () => {
    const send = vi.fn();
    installConsoleCapture({ send });

    console.warn("playback stalled", { track: 42 });
    // warn 即时上报（诊断窗口宝贵，不允许批量延迟）。
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("warn", "playback stalled {\"track\":42}");

    console.log("plain info line");
    // info 走批量：未到阈值与时间窗不发送。
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_500);
    expect(send).toHaveBeenCalledWith("info", "plain info line");
  });

  it("flushes immediately when the queue reaches the batch limit", () => {
    const send = vi.fn();
    installConsoleCapture({ send });

    for (let index = 0; index < 20; index += 1) {
      console.log(`line ${index}`);
    }
    expect(send).toHaveBeenCalledTimes(20);
  });

  it("maps log and info to level info", () => {
    const send = vi.fn();
    installConsoleCapture({ send });

    console.log("plain");
    console.info("info line");
    vi.advanceTimersByTime(1_500);
    expect(send).toHaveBeenCalledWith("info", "plain");
    expect(send).toHaveBeenCalledWith("info", "info line");
  });

  it("masks login tokens before reporting", () => {
    const send = vi.fn();
    installConsoleCapture({ send });

    console.error("request failed with Cookie: MUSIC_U=SECRET_TOKEN_123; os=pc");
    vi.advanceTimersByTime(1_500);
    const reported = send.mock.calls[0][1] as string;
    expect(reported).toContain("MUSIC_U=***");
    expect(reported).not.toContain("SECRET_TOKEN_123");
  });

  it("serializes Error objects compactly", () => {
    const send = vi.fn();
    installConsoleCapture({ send });

    console.error(new TypeError("cannot read property of undefined"));
    vi.advanceTimersByTime(1_500);
    expect(send).toHaveBeenCalledWith("error", "TypeError: cannot read property of undefined");
  });

  it("swallows sender failures without breaking console output", () => {
    const send = vi.fn(() => { throw new Error("backend unreachable"); });
    installConsoleCapture({ send });

    expect(() => {
      console.error("still works");
      vi.advanceTimersByTime(1_500);
    }).not.toThrow();
    expect(send).toHaveBeenCalled();
  });

  it("installs only once even if called twice", () => {
    const send = vi.fn();
    installConsoleCapture({ send });
    installConsoleCapture({ send: vi.fn() });

    console.log("once");
    vi.advanceTimersByTime(1_500);
    // 第二次 install 的 sender 不生效：仍用第一次的。
    expect(send).toHaveBeenCalledWith("info", "once");
  });
});
