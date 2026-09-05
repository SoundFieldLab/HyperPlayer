import { describe, expect, it, vi } from 'vitest';
import { TelemetryTap } from '../../../src/domains/player/TelemetryTap';
import type { AudioWorkletNodeLike, TelemetryFrame } from '../../../src/domains/player/TelemetryTap';

class FakeNode implements AudioWorkletNodeLike {
  connects: unknown[] = [];
  port: AudioWorkletNodeLike['port'] = { onmessage: null, postMessage: vi.fn() };

  connect(dest: unknown): void {
    this.connects.push(dest);
  }
  disconnect(): void {
    this.connects.length = 0;
  }
}

class FakeContext {
  audioWorklet = { addModule: vi.fn(async () => {}) };
}

function makeFrame(sequence: number): TelemetryFrame {
  return {
    type: 'frame',
    sequence,
    wave: new Float32Array(4),
    spectrum: new Float32Array(4),
    sampleRate: 48000,
    at: sequence,
  };
}

const inputNode = { connect: vi.fn() };
const outputNode = { connect: vi.fn() };

describe('TelemetryTap', () => {
  it('connect：addModule + 节点装配 input → tap → output', async () => {
    const ctx = new FakeContext();
    const onError = vi.fn();
    const node = new FakeNode();
    const tap = new TelemetryTap({ workletUrl: '/worklet/analysis-tap.js', createNode: () => node, onError });
    await tap.connect(ctx as unknown as AudioContext, inputNode as unknown as AudioNode, outputNode as unknown as AudioNode);
    expect(ctx.audioWorklet.addModule).not.toHaveBeenCalled(); // 注入工厂跳过 addModule
    expect(inputNode.connect).toHaveBeenCalledWith(node);
    expect(node.connects).toContain(outputNode);
    expect(onError).not.toHaveBeenCalled();
  });

  it('覆盖式发帧：主线程只取最新帧（无队列）', async () => {
    const ctx = new FakeContext();
    const node = new FakeNode();
    const tap = new TelemetryTap({ createNode: () => node });
    await tap.connect(ctx as unknown as AudioContext, inputNode as unknown as AudioNode, outputNode as unknown as AudioNode);
    node.port.onmessage?.({ data: makeFrame(1) });
    node.port.onmessage?.({ data: makeFrame(2) });
    node.port.onmessage?.({ data: makeFrame(3) });
    expect(tap.latestFrame?.sequence).toBe(3);
  });

  it('dispose：断开节点并清空最新帧', async () => {
    const ctx = new FakeContext();
    const node = new FakeNode();
    const tap = new TelemetryTap({ createNode: () => node });
    await tap.connect(ctx as unknown as AudioContext, inputNode as unknown as AudioNode, outputNode as unknown as AudioNode);
    node.port.onmessage?.({ data: makeFrame(1) });
    expect(tap.latestFrame).not.toBeNull();
    tap.dispose();
    expect(tap.latestFrame).toBeNull();
    expect(node.connects).toHaveLength(0);
  });

  it('addModule 路径：真实上下文加载 worklet（无注入工厂）', async () => {
    const ctx = new FakeContext();
    const tap = new TelemetryTap({ workletUrl: '/worklet/analysis-tap.js' });
    await expect(
      tap.connect(ctx as unknown as AudioContext, inputNode as unknown as AudioNode, outputNode as unknown as AudioNode),
    ).rejects.toThrow();
    // addModule 被调用，随后 createAudioWorkletNode 不存在而抛错（node 环境无 AudioContext）
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('/worklet/analysis-tap.js');
  });
});
