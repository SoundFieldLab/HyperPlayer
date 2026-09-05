import { describe, expect, it, vi } from 'vitest';
import { createDefaultParams } from 'hypersoundengine';
import {
  HseController,
  createBypassParams,
} from '../../../src/domains/player/HseController';
import type {
  HseAttachHandle,
  HyperSoundEngineHostLike,
} from '../../../src/domains/player/HseController';
import type { HyperSoundEngineParams } from 'hypersoundengine';

class StubHost implements HyperSoundEngineHostLike {
  attachParams: HyperSoundEngineParams | null = null;
  setParamsCalls: HyperSoundEngineParams[] = [];
  failAttach = false;
  failSetParams = false;
  /** 只抛一次后复位：模拟一次 DSP 异常，随后旁路可成功下发。 */
  failSetParamsOnce = false;
  disposed = false;

  async attach(_handle: HseAttachHandle, params?: HyperSoundEngineParams): Promise<void> {
    if (this.failAttach) throw new Error('attach failed');
    if (params) this.attachParams = params;
  }

  async setParams(params: HyperSoundEngineParams): Promise<void> {
    if (this.failSetParamsOnce) {
      this.failSetParamsOnce = false;
      throw new Error('dsp error');
    }
    if (this.failSetParams) throw new Error('dsp error');
    this.setParamsCalls.push(params);
    this.attachParams = params;
  }

  dispose(): void {
    this.disposed = true;
  }
}

const handle: HseAttachHandle = {
  audioContext: { sampleRate: 48000 },
  masterGain: {},
  analyser: {},
};

describe('createBypassParams', () => {
  it('全旁路：所有效果 enabled=false、空间音频 off、宽度 1、sceneId null', () => {
    const base = createDefaultParams(48000);
    const bypassed = createBypassParams(base);
    expect(bypassed.eq.enabled).toBe(false);
    expect(bypassed.deesser.enabled).toBe(false);
    expect(bypassed.compressor.enabled).toBe(false);
    expect(bypassed.reverb.enabled).toBe(false);
    expect(bypassed.limiter.enabled).toBe(false);
    expect(bypassed.spatial?.mode).toBe('off');
    expect(bypassed.stereoWidth).toBe(1);
    expect(bypassed.sceneId).toBeNull();
    expect(bypassed.customized).toBe(true);
  });
});

describe('HseController', () => {
  it('attach 成功：detached → attaching → attached', async () => {
    const host = new StubHost();
    const hse = new HseController({ createHost: () => host });
    expect(hse.state).toBe('detached');
    await hse.attach(handle);
    expect(hse.state).toBe('attached');
    expect(host.attachParams?.sampleRate).toBe(48000); // 缺省参数按上下文采样率
  });

  it('attach 失败：回 detached 并抛错', async () => {
    const host = new StubHost();
    host.failAttach = true;
    const onDspError = vi.fn();
    const hse = new HseController({ createHost: () => host, onDspError });
    await expect(hse.attach(handle)).rejects.toThrow('attach failed');
    expect(hse.state).toBe('detached');
    expect(onDspError).toHaveBeenCalled();
  });

  it('setParams 成功：attached 且记录参数快照', async () => {
    const host = new StubHost();
    const hse = new HseController({ createHost: () => host });
    await hse.attach(handle);
    const params = createDefaultParams(48000);
    await hse.setParams(params);
    expect(hse.state).toBe('attached');
    expect(host.setParamsCalls.at(-1)).toBe(params);
  });

  it('DSP 异常自动旁路直通（宁无效果不出不了声）', async () => {
    const host = new StubHost();
    const onDspError = vi.fn();
    const hse = new HseController({ createHost: () => host, onDspError });
    await hse.attach(handle);
    const params = createDefaultParams(48000);
    host.failSetParamsOnce = true;
    await hse.setParams(params);
    expect(hse.state).toBe('bypassed');
    expect(onDspError).toHaveBeenCalled();
    // 旁路参数：全部效果 disabled
    const bypassed = host.setParamsCalls.at(-1);
    expect(bypassed?.eq.enabled).toBe(false);
    expect(bypassed?.limiter.enabled).toBe(false);
  });

  it('bypass / restore 状态切换（attached ⇄ bypassed）', async () => {
    const host = new StubHost();
    const hse = new HseController({ createHost: () => host });
    await hse.attach(handle);
    const params = createDefaultParams(48000);
    await hse.setParams(params);

    await hse.bypass();
    expect(hse.state).toBe('bypassed');
    expect(host.setParamsCalls.at(-1)?.eq.enabled).toBe(false);

    await hse.restore();
    expect(hse.state).toBe('attached');
    expect(host.setParamsCalls.at(-1)).toBe(params);
  });

  it('未 attach 时 bypass/restore 为 no-op', async () => {
    const host = new StubHost();
    const hse = new HseController({ createHost: () => host });
    await hse.bypass();
    expect(hse.state).toBe('detached');
    await hse.restore();
    expect(host.setParamsCalls).toHaveLength(0);
  });

  it('dispose 转发给 host 并回 detached', async () => {
    const host = new StubHost();
    const hse = new HseController({ createHost: () => host });
    await hse.attach(handle);
    hse.dispose();
    expect(host.disposed).toBe(true);
    expect(hse.state).toBe('detached');
  });
});
