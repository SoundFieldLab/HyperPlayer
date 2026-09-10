import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMessage = vi.fn();
let Processor: new () => {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
};

beforeEach(async () => {
  postMessage.mockClear();
  vi.resetModules();
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage }; });
  vi.stubGlobal('sampleRate', 48_000);
  vi.stubGlobal('registerProcessor', vi.fn((_name: string, ctor: typeof Processor) => { Processor = ctor; }));
  await import('../../../src/domains/player/analysis-tap.worklet');
});

describe('analysis tap worklet', () => {
  it('每个量子原样透传单声道 PCM 到所有输出声道', () => {
    const processor = new Processor();
    const input = new Float32Array([0.25, -0.5, 0.75]);
    const left = new Float32Array(3);
    const right = new Float32Array(3);

    expect(processor.process([[input]], [[left, right]], {})).toBe(true);
    expect([...left]).toEqual([...input]);
    expect([...right]).toEqual([...input]);
  });

  it('约 30 FPS 限流发送遥测帧', () => {
    const processor = new Processor();
    const input = new Float32Array(128).fill(0.5);
    for (let quantum = 0; quantum < 12; quantum += 1) {
      processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {});
    }
    expect(postMessage).not.toHaveBeenCalled();

    processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {});
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'frame', sequence: 1, sampleRate: 48_000 });
  });
});
