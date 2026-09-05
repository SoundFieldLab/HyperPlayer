"use strict";
(() => {
  // src/domains/player/analysis-tap.worklet.ts
  var WAVE_BUCKETS = 64;
  var SPECTRUM_BANDS = 96;
  var HyperPlayerAnalysisTap = class extends AudioWorkletProcessor {
    sequence = 0;
    process(inputs, _outputs, _parameters) {
      const input = inputs[0];
      if (!input || input.length < 2) return true;
      const ch0 = input[0] ?? new Float32Array(0);
      const ch1 = input[1] ?? ch0;
      const frameLength = Math.max(ch0.length, ch1.length);
      if (frameLength === 0) return true;
      const wave = new Float32Array(WAVE_BUCKETS * 4);
      const perBucket = Math.max(1, Math.floor(frameLength / WAVE_BUCKETS));
      for (let bucket = 0; bucket < WAVE_BUCKETS; bucket += 1) {
        const start = bucket * perBucket;
        const end = Math.min(start + perBucket, frameLength);
        let min0 = Number.POSITIVE_INFINITY;
        let max0 = Number.NEGATIVE_INFINITY;
        let min1 = Number.POSITIVE_INFINITY;
        let max1 = Number.NEGATIVE_INFINITY;
        for (let i = start; i < end; i += 1) {
          const s0 = ch0[i] ?? 0;
          const s1 = ch1[i] ?? 0;
          if (s0 < min0) min0 = s0;
          if (s0 > max0) max0 = s0;
          if (s1 < min1) min1 = s1;
          if (s1 > max1) max1 = s1;
        }
        if (!Number.isFinite(min0)) min0 = 0;
        if (!Number.isFinite(max0)) max0 = 0;
        if (!Number.isFinite(min1)) min1 = 0;
        if (!Number.isFinite(max1)) max1 = 0;
        wave[bucket * 2] = min0;
        wave[bucket * 2 + 1] = max0;
        wave[WAVE_BUCKETS * 2 + bucket * 2] = min1;
        wave[WAVE_BUCKETS * 2 + bucket * 2 + 1] = max1;
      }
      const spectrum = new Float32Array(SPECTRUM_BANDS);
      const logMax = Math.log(frameLength + 1);
      for (let band = 0; band < SPECTRUM_BANDS; band += 1) {
        const lo = Math.floor(Math.exp(band / SPECTRUM_BANDS * logMax) - 1);
        const hi = Math.floor(Math.exp((band + 1) / SPECTRUM_BANDS * logMax) - 1);
        const start = Math.max(0, lo);
        const end = Math.min(frameLength, Math.max(start + 1, hi));
        let sum = 0;
        let count = 0;
        for (let i = start; i < end; i += 1) {
          const s0 = ch0[i] ?? 0;
          const s1 = ch1[i] ?? 0;
          sum += s0 * s0 + s1 * s1;
          count += 2;
        }
        spectrum[band] = count > 0 ? Math.sqrt(sum / count) : 0;
      }
      const frame = {
        type: "frame",
        sequence: ++this.sequence,
        wave,
        spectrum,
        sampleRate,
        at: globalThis.performance?.now() ?? 0
      };
      this.port.postMessage(frame, [wave.buffer, spectrum.buffer]);
      return true;
    }
  };
  registerProcessor("hyperplayer-analysis-tap", HyperPlayerAnalysisTap);
})();
