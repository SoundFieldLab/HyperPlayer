/**
 * HseController —— HyperSoundEngine 宿主生命周期/参数/旁路（播放器架构.md §3.6）。
 *
 * 生命周期：detached → attaching → attached ⇄ bypassed。
 * 降级：host 以 mode:'auto' 创建（worklet 失败 → ScriptProcessor 由 vendor 内建回退）；
 *       DSP 异常（attach/setParams 抛错）→ 自动全局旁路直通（宁无效果不出不了声）。
 * 旁路语义：参数级 enabled=false 全旁路（对齐 vendor 冻结向量 all-bypass bit-exact 锚点）。
 */
import { createHyperSoundEngineHost } from 'hypersoundengine/browser';
import { createDefaultParams } from 'hypersoundengine';
import type { HyperSoundEngineParams } from 'hypersoundengine';

/** HSE TS worklet 打包产物（由 scripts/copy-hse-worklet.mjs 复制到 app/public/worklet/）。 */
export const HSE_WORKLET_URL = '/worklet/hse-worklet.js';

export type HseState = 'detached' | 'attaching' | 'attached' | 'bypassed';

/** host.attach 的接入句柄（鸭子类型，与 vendor HyperSoundEngineHostHandle 对齐）。 */
export interface HseAttachHandle {
  audioContext: { sampleRate: number };
  masterGain: { connect?(dest: unknown): unknown; disconnect?(dest?: unknown): unknown };
  analyser: { connect?(dest: unknown): unknown; disconnect?(dest?: unknown): unknown };
}

/** host 最小接口（测试可用 stub）。 */
export interface HyperSoundEngineHostLike {
  attach(handle: HseAttachHandle, params?: HyperSoundEngineParams): Promise<void>;
  setParams(params: HyperSoundEngineParams): Promise<void>;
  dispose(): void;
}

/** 全部效果键（对齐 HyperSoundEngineParams 的 16 个效果设置）。 */
const EFFECT_KEYS: readonly (keyof HyperSoundEngineParams)[] = [
  'eq',
  'deesser',
  'compressor',
  'nightMode',
  'bassEnhancer',
  'reverb',
  'surround3d',
  'loudnessCompensation',
  'loudnessNormalization',
  'limiter',
  'ieq',
  'dynamicEq',
  'pitch',
  'modulation',
  'modEffects',
  'hearing',
];

/** 生成全旁路参数快照（所有效果 enabled=false、空间音频 off、宽度 1）。 */
export function createBypassParams(base: HyperSoundEngineParams): HyperSoundEngineParams {
  const next: HyperSoundEngineParams = { ...base };
  for (const key of EFFECT_KEYS) {
    const settings = next[key];
    if (settings && typeof settings === 'object' && 'enabled' in settings) {
      (settings as { enabled: boolean }).enabled = false;
    }
  }
  next.spatial = { ...next.spatial, mode: 'off' as const } as HyperSoundEngineParams['spatial'];
  next.stereoWidth = 1;
  next.sceneId = null;
  next.customized = true;
  return next;
}

export interface HseControllerDeps {
  /** 测试注入 stub host；缺省使用真实 createHyperSoundEngineHost({ mode: 'auto' })。 */
  createHost?: () => HyperSoundEngineHostLike;
  onDspError?: (error: unknown) => void;
}

export class HseController {
  private _state: HseState = 'detached';
  private lastParams: HyperSoundEngineParams | null = null;
  private readonly host: HyperSoundEngineHostLike;
  private readonly onDspError: (error: unknown) => void;

  constructor(deps: HseControllerDeps = {}) {
    this.onDspError = deps.onDspError ?? (() => {});
    const createHost =
      deps.createHost ?? (() => createHyperSoundEngineHost({ mode: 'auto', workletUrl: HSE_WORKLET_URL }));
    this.host = createHost() as HyperSoundEngineHostLike;
  }

  get state(): HseState {
    return this._state;
  }

  /** 接入音频图；worklet/script 降级由 host mode:'auto' 内建处理。 */
  async attach(handle: HseAttachHandle, params?: HyperSoundEngineParams): Promise<void> {
    this._state = 'attaching';
    const resolved = params ?? createDefaultParams(handle.audioContext.sampleRate);
    try {
      await this.host.attach(handle, resolved);
      this.lastParams = resolved;
      this._state = 'attached';
    } catch (error) {
      this._state = 'detached';
      this.onDspError(error);
      throw error;
    }
  }

  /** 下发完整参数快照；异常自动旁路直通。 */
  async setParams(params: HyperSoundEngineParams): Promise<void> {
    try {
      await this.host.setParams(params);
      this.lastParams = params;
      this._state = 'attached';
    } catch (error) {
      this.onDspError(error);
      await this.bypass();
    }
  }

  /** 全局旁路直通（参数级全 disabled）。 */
  async bypass(): Promise<void> {
    if (!this.lastParams) return;
    try {
      await this.host.setParams(createBypassParams(this.lastParams));
      this._state = 'bypassed';
    } catch (error) {
      this.onDspError(error);
    }
  }

  /** 恢复旁路前参数快照。 */
  async restore(): Promise<void> {
    if (!this.lastParams) return;
    await this.host.setParams(this.lastParams);
    this._state = 'attached';
  }

  dispose(): void {
    this.host.dispose();
    this._state = 'detached';
    this.lastParams = null;
  }
}
