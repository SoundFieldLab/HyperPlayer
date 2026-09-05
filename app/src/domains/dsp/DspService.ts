/**
 * DspService —— 音效工作台后端（M4：基于 HSE 真实能力定制，UI-D89/D57）。
 *
 * 职责（架构基线 domains/dsp/：音效工作台状态与 HSE 参数模型映射）：
 *  - 参数快照管理（HyperSoundEngineParams，不可变快照语义）；
 *  - 12 个内置场景（HSE SCENE_PRESETS）加载/切换，sceneId 状态；
 *  - 分享串编解码（HSE ShareCodec v2）；
 *  - A/B 快照对比（保存/加载两个槽位）；
 *  - 旁路/恢复（委托 HseController 参数级全旁路）；
 *  - 离线 LUFS 分析（HSE LufsMeter 真实模块，链内分析器语义）。
 * DSP 跨模式全局（UI-D1）：服务层单例，与播放模式无关。
 */
import {
  SCENE_PRESETS,
  getSceneById,
  encodeShareCode,
  decodeShareCode,
  createDefaultParams,
  LufsMeter,
} from 'hypersoundengine';
import type { HyperSoundEngineParams } from 'hypersoundengine';
import type { HseController } from '../player/HseController';
import type { Logger } from '../../shared/logger';
import { createNullLogger } from '../../shared/logger';

export interface DspSceneInfo {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
}

export interface DspSnapshot {
  sceneId: string | null;
  sceneName: string | null;
  customized: boolean;
  bypassed: boolean;
  params: HyperSoundEngineParams;
  ab: { a: HyperSoundEngineParams | null; b: HyperSoundEngineParams | null };
  activeSlot: 'a' | 'b' | null;
}

export interface DspServiceDeps {
  hse: HseController;
  /** 参数快照采样率（与 AudioContext 一致）。 */
  sampleRate: number;
  onStateChange?: (state: DspSnapshot) => void;
  logger?: Logger;
}

export class DspService {
  private params: HyperSoundEngineParams;
  private sceneId: string | null = null;
  private customized = false;
  private bypassed = false;
  private abA: HyperSoundEngineParams | null = null;
  private abB: HyperSoundEngineParams | null = null;
  private activeSlot: 'a' | 'b' | null = null;
  private readonly hse: HseController;
  private readonly sampleRate: number;
  private readonly onStateChange: ((state: DspSnapshot) => void) | undefined;
  private readonly logger: Logger;

  constructor(deps: DspServiceDeps) {
    this.hse = deps.hse;
    this.sampleRate = deps.sampleRate;
    this.onStateChange = deps.onStateChange;
    this.logger = deps.logger ?? createNullLogger();
    this.params = createDefaultParams(this.sampleRate);
  }

  get snapshot(): DspSnapshot {
    return {
      sceneId: this.sceneId,
      sceneName: this.sceneId ? (getSceneById(this.sceneId)?.name ?? null) : null,
      customized: this.customized,
      bypassed: this.bypassed,
      params: this.params,
      ab: { a: this.abA, b: this.abB },
      activeSlot: this.activeSlot,
    };
  }

  listScenes(): DspSceneInfo[] {
    return SCENE_PRESETS.map((scene) => ({
      id: scene.id,
      name: scene.name,
      description: scene.description,
      builtin: scene.builtin,
    }));
  }

  /** 应用完整参数快照（场景/分享串导入/A-B 加载共用）。 */
  async apply(params: HyperSoundEngineParams, opts: { sceneId?: string | null; customized?: boolean } = {}): Promise<void> {
    this.params = params;
    if (opts.sceneId !== undefined) this.sceneId = opts.sceneId;
    if (opts.customized !== undefined) this.customized = opts.customized;
    await this.hse.setParams(params); // DSP 异常由 HseController 自动旁路兜底
    this.bypassed = this.hse.state === 'bypassed';
    this.emit();
  }

  /** 切换内置场景（12 场景，HSE SCENE_PRESETS）。 */
  async setScene(id: string): Promise<void> {
    const scene = getSceneById(id);
    if (!scene) throw new Error(`dsp: 未知场景 ${id}`);
    await this.apply(scene.params, { sceneId: id, customized: false });
  }

  /** 用户手动调整（EQ 曲线编辑/效果链参数等）：部分快照合并 → 脱离场景快照。 */
  async customize(patch: Partial<HyperSoundEngineParams>): Promise<void> {
    await this.apply({ ...this.params, ...patch, customized: true }, { sceneId: null, customized: true });
  }

  /** 全局旁路直通（宁无效果不出不了声）。 */
  async bypass(): Promise<void> {
    await this.hse.bypass();
    this.bypassed = true;
    this.emit();
  }

  /** 恢复旁路前参数。 */
  async restore(): Promise<void> {
    await this.hse.restore();
    this.bypassed = false;
    this.emit();
  }

  // —— A/B 快照对比（工作台语义） ——
  async saveToA(): Promise<void> {
    this.abA = this.params;
    this.activeSlot = 'a';
    this.emit();
  }

  async saveToB(): Promise<void> {
    this.abB = this.params;
    this.activeSlot = 'b';
    this.emit();
  }

  async loadFromA(): Promise<void> {
    if (!this.abA) return;
    await this.apply(this.abA, { sceneId: null, customized: true });
  }

  async loadFromB(): Promise<void> {
    if (!this.abB) return;
    await this.apply(this.abB, { sceneId: null, customized: true });
  }

  // —— 分享串（HSE ShareCodec v2） ——
  encodeShare(): string {
    return encodeShareCode(this.params);
  }

  /** 导入分享串：解码失败返回 false（不改变当前参数）。 */
  async applyShare(code: string): Promise<boolean> {
    try {
      const params = decodeShareCode(code);
      // 分享串采样率与当前上下文不一致时以当前为准（引擎按上下文建）
      await this.apply({ ...params, sampleRate: this.sampleRate }, { sceneId: null, customized: true });
      return true;
    } catch (error) {
      this.logger.warn('dsp: share code import failed', error);
      return false;
    }
  }

  /**
   * 离线 LUFS 分析（HSE LufsMeter 真实模块；UI-D80/86 链内 LufsMeter 语义）。
   * chunks：双声道块序列（Float32Array[]，每块 [l, r]）。
   */
  static analyzeLufs(sampleRate: number, chunks: Array<[Float32Array, Float32Array]>): number {
    const meter = new LufsMeter(sampleRate);
    for (const [l, r] of chunks) {
      meter.processStereo(l, r);
    }
    return meter.getIntegratedLufs();
  }

  private emit(): void {
    this.onStateChange?.(this.snapshot);
  }
}
