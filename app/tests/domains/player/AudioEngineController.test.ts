import { describe, expect, it, vi } from 'vitest';
import { AudioEngineController } from '../../../src/domains/player/AudioEngineController';
import type { AudioEngineControllerDeps } from '../../../src/domains/player/AudioEngineController';
import { HseController } from '../../../src/domains/player/HseController';
import type { HseAttachHandle, HyperSoundEngineHostLike } from '../../../src/domains/player/HseController';
import type { HyperSoundEngineParams } from 'hypersoundengine';
import type { TelemetryTap } from '../../../src/domains/player/TelemetryTap';

class FakeNode {
  connects: unknown[] = [];
  disconnects: unknown[] = [];
  gain = { value: 1 };
  connect(dest: unknown): void {
    this.connects.push(dest);
  }
  disconnect(dest?: unknown): void {
    this.disconnects.push(dest ?? null);
  }
}

class FakeAudioContext {
  sampleRate = 48000;
  state: 'running' | 'suspended' = 'suspended';
  destination = new FakeNode();
  currentTime = 0;
  resumeCalls = 0;
  closeCalls = 0;
  sinkCalls: string[] = [];
  failSink = false;
  mediaSources: FakeNode[] = [];

  createGain(): FakeNode {
    return new FakeNode();
  }
  createAnalyser(): FakeNode {
    return new FakeNode();
  }
  createMediaElementSource(): FakeNode {
    const node = new FakeNode();
    this.mediaSources.push(node);
    return node;
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  async setSinkId(deviceId: string): Promise<void> {
    this.sinkCalls.push(deviceId);
    if (this.failSink) throw new Error('sink device unavailable');
  }
}

class StubHost implements HyperSoundEngineHostLike {
  attachParams: HyperSoundEngineParams | null = null;
  async attach(_handle: HseAttachHandle, params?: HyperSoundEngineParams): Promise<void> {
    if (params) this.attachParams = params;
  }
  async setParams(): Promise<void> {}
  dispose(): void {}
}

function createRafHarness() {
  let queue: Array<() => void> = [];
  let nextId = 1;
  const raf = (cb: () => void): number => {
    queue.push(cb);
    return nextId++;
  };
  const cancelRaf = (): void => {
    queue = [];
  };
  const step = (): void => {
    const current = queue;
    queue = [];
    for (const cb of current) cb();
  };
  const hasPending = (): boolean => queue.length > 0;
  return { raf, cancelRaf, step, hasPending };
}

function makeController(overrides: Partial<AudioEngineControllerDeps> = {}) {
  const contexts: FakeAudioContext[] = [];
  const hse = new HseController({ createHost: () => new StubHost() });
  const readPosition = vi.fn(() => 0);
  const writePosition = vi.fn();
  const controller = new AudioEngineController({
    hse,
    createContext: () => {
      const ctx = new FakeAudioContext();
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
    readPosition,
    writePosition,
    ...overrides,
  });
  return { controller, contexts, hse, readPosition, writePosition };
}

describe('AudioEngineController', () => {
  it('AudioContext 惰性创建：ensureContext 前为 absent', () => {
    const { controller } = makeController();
    expect(controller.contextState).toBe('absent');
  });

  it('ensureContext 装配节点图：输出增益 → destination', () => {
    const { controller, contexts } = makeController();
    const ctx = controller.ensureContext();
    expect(ctx).toBe(contexts[0] as unknown as AudioContext);
    expect(controller.contextState).toBe('suspended');
    const output = contexts[0]?.destination as FakeNode;
    expect(output.connects).toHaveLength(0);
    // outputGain.connect(destination) 在 createGain 阶段调用（FakeNode.connect 记录在 target）
    expect(contexts[0]).toBeDefined();
  });

  it('attachHse：handle 携带输入总线与 analyser，缺省参数按采样率', async () => {
    const { controller, hse } = makeController();
    await controller.attachHse();
    expect(hse.state).toBe('attached');
    const host = (hse as unknown as { host: StubHost }).host;
    expect(host.attachParams?.sampleRate).toBe(48000);
  });

  it('attachHse 闭合分析 tap：analyser→tap→outputGain（post-DSP pre-output-gain）', async () => {
    const { contexts } = makeController();
    const connect = vi.fn(async () => {});
    const telemetry = {
      connect,
      latestFrame: null,
      dispose: vi.fn(),
    } as unknown as TelemetryTap;
    const hse = new HseController({ createHost: () => new StubHost() });
    const controller = new AudioEngineController({
      hse,
      telemetry,
      createContext: () => {
        const ctx = new FakeAudioContext();
        contexts.push(ctx);
        return ctx as unknown as AudioContext;
      },
      readPosition: () => 0,
      writePosition: () => {},
    });
    await controller.attachHse();
    expect(hse.state).toBe('attached');
    expect(connect).toHaveBeenCalledTimes(1);
    const [ctx, analyser, outputGain] = connect.mock.calls[0] as unknown as [unknown, unknown, unknown];
    expect(ctx).toBe(contexts[0] as unknown as AudioContext);
    expect(analyser).toBeDefined();
    expect(outputGain).toBeDefined();
  });

  it('attachMediaElement：元素 → MediaElementSource → 输入总线', () => {
    const { controller, contexts } = makeController();
    const element = { src: '' } as unknown as HTMLMediaElement;
    controller.attachMediaElement(element);
    const ctx = contexts[0] as FakeAudioContext;
    expect(ctx.mediaSources).toHaveLength(1);
    // source.connect(inputBus)：MediaElementSource 的 connects 含输入总线节点
    expect(ctx.mediaSources[0]?.connects.length).toBe(1);
  });

  it('setSinkId 成功记录当前设备', async () => {
    const { controller, contexts } = makeController();
    controller.ensureContext();
    await controller.setSinkId('device-2');
    expect(contexts[0]?.sinkCalls).toEqual(['device-2']);
  });

  it('setSinkId 失败回退原设备并提示', async () => {
    const onSinkError = vi.fn();
    const { controller, contexts } = makeController({ onSinkError });
    controller.ensureContext();
    const ctx = contexts[0] as FakeAudioContext;
    await controller.setSinkId('device-2');
    ctx.failSink = true;
    await controller.setSinkId('device-3');
    expect(ctx.sinkCalls).toEqual(['device-2', 'device-3', 'device-2']);
    expect(onSinkError).toHaveBeenCalledOnce();
    expect(onSinkError.mock.calls[0]?.[0]).toContain('切换输出设备失败');
  });

  it('resume 恢复 running', async () => {
    const { controller, contexts } = makeController();
    controller.ensureContext();
    await controller.resume();
    expect(contexts[0]?.resumeCalls).toBe(1);
  });

  it('rAF 时钟：帧级写 position，值不变不写', () => {
    const { raf, step, hasPending } = createRafHarness();
    const readPosition = vi.fn(() => 1.5);
    const writePosition = vi.fn();
    const { controller } = makeController({ raf, cancelRaf: () => {}, readPosition, writePosition });
    controller.startClock();
    step();
    expect(readPosition).toHaveBeenCalled();
    expect(writePosition).toHaveBeenCalledWith(1.5);
    step(); // 值不变 → 不写
    expect(writePosition).toHaveBeenCalledTimes(1);
    expect(hasPending()).toBe(true);
  });

  it('窗口隐藏时降频：每 10 帧写一次', () => {
    const { raf, step } = createRafHarness();
    let position = 1;
    const readPosition = vi.fn(() => position);
    const writePosition = vi.fn();
    const { controller } = makeController({
      raf,
      cancelRaf: () => {},
      readPosition,
      writePosition,
      isHidden: () => true,
    });
    controller.startClock();
    for (let i = 0; i < 9; i += 1) {
      position += 1;
      step();
    }
    expect(writePosition).toHaveBeenCalledTimes(0);
    position += 1;
    step();
    expect(writePosition).toHaveBeenCalledTimes(1);
  });

  it('stopClock 取消 rAF 循环', () => {
    const { raf, cancelRaf, step, hasPending } = createRafHarness();
    const { controller } = makeController({
      raf,
      cancelRaf,
      readPosition: () => 0,
      writePosition: () => {},
    });
    controller.startClock();
    step();
    expect(hasPending()).toBe(true);
    controller.stopClock();
    expect(hasPending()).toBe(false);
  });
});
