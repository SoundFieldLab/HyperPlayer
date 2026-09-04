// HSE 遥测传输（D31 修订：权威 DSP/分析 = HSE TS）：
// 从 playbackService 的 HSE 宿主读取 getLastStats/getLastAnalysis，
// 编码为 HPTM v4 帧喂给遥测会话（波形/频谱/LUFS/限制器衰减）。

import type { TelemetryTransport } from "./session";
import type { TelemetryRate } from "./activity";
import { encodeTelemetryFrame, createTelemetrySource } from "./hse-encoder";
import { playbackService } from "../../services/playback/playbackService";

const INTERVAL_MS: Record<Exclude<TelemetryRate, 0>, number> = { 2: 500, 15: 66, 30: 33 };

export function createHseTelemetryTransport(): TelemetryTransport {
  let timer: number | null = null;
  let onFrame: ((frame: ArrayBuffer | ArrayBufferView) => void) | null = null;
  let epoch = 0n;
  let sequence = 0n;
  let sampleFrame = 0n;

  const tick = () => {
    const host = playbackService.getHseHost();
    if (!host) return;
    const stats = host.getLastStats?.() ?? null;
    const analysis = host.getLastAnalysis?.() ?? null;
    const sampleRate = host.engine?.getParams().sampleRate ?? 48000;
    if (!stats) return;
    sequence += 1n;
    sampleFrame += 128n;
    const frame = encodeTelemetryFrame(
      createTelemetrySource(
        epoch,
        sequence,
        sampleFrame,
        0n,
        sampleRate,
        {
          peakDb: stats.peakDb,
          truePeakDb: stats.truePeakDb,
          limiterReductionDb: stats.limiterReductionDb,
          lufsIntegrated: Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated : undefined,
          lufsMomentary: Number.isFinite(stats.lufsMomentary) ? stats.lufsMomentary : undefined,
        },
        analysis?.spectrum ?? null,
      ),
    );
    onFrame?.(frame);
  };

  const clearTimer = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  return {
    open(rate, handler) {
      onFrame = handler;
      epoch += 1n;
      sequence = 0n;
      clearTimer();
      if (rate === 0) return;
      timer = window.setInterval(tick, INTERVAL_MS[rate]);
    },
    setRate(rate) {
      clearTimer();
      if (rate === 0 || !onFrame) return;
      timer = window.setInterval(tick, INTERVAL_MS[rate]);
    },
    acknowledge() {
      return true;
    },
    close() {
      clearTimer();
      onFrame = null;
    },
  };
}
