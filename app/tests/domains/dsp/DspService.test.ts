import { describe, expect, it } from 'vitest';
import { DspService } from '../../../src/domains/dsp/DspService';
import { HseController } from '../../../src/domains/player/HseController';
import type { HseAttachHandle, HyperSoundEngineHostLike } from '../../../src/domains/player/HseController';
import type { HyperSoundEngineParams } from 'hypersoundengine';
import { createNullLogger } from '../../../src/shared/logger';

class StubHost implements HyperSoundEngineHostLike {
  setParamsCalls: HyperSoundEngineParams[] = [];

  async attach(_handle: HseAttachHandle, params?: HyperSoundEngineParams): Promise<void> {
    if (params) this.setParamsCalls.push(params);
  }
  async setParams(params: HyperSoundEngineParams): Promise<void> {
    this.setParamsCalls.push(params);
  }
  dispose(): void {}
}

function makeDsp() {
  const host = new StubHost();
  const hse = new HseController({ createHost: () => host });
  const states: DspService['snapshot'][] = [];
  const dsp = new DspService({
    hse,
    sampleRate: 48000,
    onStateChange: (s) => states.push(s),
    logger: createNullLogger(),
  });
  return { host, hse, dsp, states };
}

describe('DspService（M4 音效工作台后端）', () => {
  it('初始快照：默认参数、无场景、未旁路', () => {
    const { dsp } = makeDsp();
    const snap = dsp.snapshot;
    expect(snap.sceneId).toBeNull();
    expect(snap.customized).toBe(false);
    expect(snap.bypassed).toBe(false);
    expect(snap.params.sampleRate).toBe(48000);
    expect(dsp.listScenes()).toHaveLength(12); // HSE 12 个内置场景
  });

  it('setScene：加载 HSE 场景参数并标记场景 id（customized=false）', async () => {
    const { dsp, host } = makeDsp();
    await dsp.setScene('pop');
    expect(dsp.snapshot.sceneId).toBe('pop');
    expect(dsp.snapshot.sceneName).toBe('流行');
    expect(dsp.snapshot.customized).toBe(false);
    expect(host.setParamsCalls.at(-1)).toBe(dsp.snapshot.params);
    expect(host.setParamsCalls.at(-1)?.eq.enabled).toBe(true);
  });

  it('setScene 未知场景抛错', async () => {
    const { dsp } = makeDsp();
    await expect(dsp.setScene('no-such-scene')).rejects.toThrow('未知场景');
  });

  it('customize：部分快照合并 → 脱离场景（sceneId null、customized true）', async () => {
    const { dsp } = makeDsp();
    await dsp.setScene('jazz');
    await dsp.customize({ eq: { ...dsp.snapshot.params.eq, enabled: false } });
    expect(dsp.snapshot.customized).toBe(true);
    expect(dsp.snapshot.sceneId).toBeNull();
    expect(dsp.snapshot.params.eq.enabled).toBe(false);
    // 未修改的效果保持场景参数
    expect(dsp.snapshot.params.limiter.enabled).toBe(true);
  });

  it('分享串：encode → applyShare 往返可用（sampleRate 以当前上下文为准）', async () => {
    const { dsp } = makeDsp();
    await dsp.setScene('warm');
    const code = dsp.encodeShare();
    expect(code.length).toBeGreaterThan(0);

    const ok = await dsp.applyShare(code);
    expect(ok).toBe(true);
    expect(dsp.snapshot.customized).toBe(true);
    expect(dsp.snapshot.params.sampleRate).toBe(48000);
  });

  it('applyShare 非法串返回 false 且不改参数', async () => {
    const { dsp } = makeDsp();
    await dsp.setScene('pop');
    const before = dsp.snapshot.params;
    const ok = await dsp.applyShare('!!!not-a-share-code!!!');
    expect(ok).toBe(false);
    expect(dsp.snapshot.params).toBe(before);
    expect(dsp.snapshot.sceneId).toBe('pop');
  });

  it('A/B 快照：save → customize → load 恢复（恢复保存时刻的参数）', async () => {
    const { dsp } = makeDsp();
    await dsp.setScene('dance');
    const saved = dsp.snapshot.params;
    await dsp.saveToA();
    expect(dsp.snapshot.activeSlot).toBe('a');
    await dsp.customize({ stereoWidth: saved.stereoWidth + 0.5 });
    expect(dsp.snapshot.params.stereoWidth).toBe(saved.stereoWidth + 0.5);
    await dsp.loadFromA();
    expect(dsp.snapshot.params.stereoWidth).toBe(saved.stereoWidth);
    expect(dsp.snapshot.activeSlot).toBe('a');
  });

  it('bypass/restore 委托 HSE 参数级旁路并联动状态', async () => {
    const { dsp, host } = makeDsp();
    await dsp.setScene('pop');
    const popParams = host.setParamsCalls.at(-1);
    await dsp.bypass();
    expect(dsp.snapshot.bypassed).toBe(true);
    expect(host.setParamsCalls.at(-1)?.eq.enabled).toBe(false); // 全旁路快照
    await dsp.restore();
    expect(dsp.snapshot.bypassed).toBe(false);
    expect(host.setParamsCalls.at(-1)).toBe(popParams); // 恢复场景参数（同一快照）
  });

  it('analyzeLufs：HSE LufsMeter 真实模块（白噪声有限、静音为 -∞）', () => {
    // 白噪声：±0.5 幅度
    const chunks: Array<[Float32Array, Float32Array]> = [];
    for (let i = 0; i < 20; i += 1) {
      const l = new Float32Array(4800);
      const r = new Float32Array(4800);
      for (let j = 0; j < 4800; j += 1) {
        l[j] = (Math.random() - 0.5) * 1;
        r[j] = (Math.random() - 0.5) * 1;
      }
      chunks.push([l, r]);
    }
    const lufs = DspService.analyzeLufs(48000, chunks);
    expect(Number.isFinite(lufs)).toBe(true);
    expect(lufs).toBeGreaterThan(-30);
  });
});

describe('DspService 状态上报', () => {
  it('每次变更通知订阅者（场景/自定义/旁路）', async () => {
    const { dsp, states } = makeDsp();
    await dsp.setScene('studio');
    expect(states.length).toBeGreaterThan(0);
    expect(states.at(-1)?.sceneId).toBe('studio');
    await dsp.bypass();
    expect(states.at(-1)?.bypassed).toBe(true);
  });
});
