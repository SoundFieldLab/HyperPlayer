/**
 * AudioEngineController —— 唯一 AudioContext 持有者（播放器架构.md §3.6 / 架构基线.md §5）。
 *
 * 职责：
 *  - AudioContext 首次播放用户手势时惰性创建（absent → running ⇄ suspended）；
 *  - 装配节点图：MediaElementSource → 输入总线 → HSE host 节点 → analyser
 *    → telemetry tap（post-DSP pre-output-gain）→ 输出增益 → destination；
 *  - enumerateDevices + setSinkId 输出设备切换（失败回退原设备，UI-D45/D85）；
 *  - rAF 时钟：读 active 元素 currentTime 帧级写 store.position（窗口隐藏降频）。
 */
import { createDefaultParams } from 'hypersoundengine';
import type { HyperSoundEngineParams } from 'hypersoundengine';
import type { HseController } from './HseController';
import type { TelemetryTap } from './TelemetryTap';

export type AudioContextLifecycle = 'absent' | 'running' | 'suspended';

export interface AudioEngineControllerDeps {
  hse: HseController;
  /** 分析 tap（UI-D80/86：post-DSP pre-output-gain）；装配图时接入 analyser→outputGain。 */
  telemetry?: TelemetryTap;
  /** 测试注入 fake AudioContext；缺省 new AudioContext()。 */
  createContext?: () => AudioContext;
  /** 测试注入 rAF；缺省 requestAnimationFrame。 */
  raf?: (callback: () => void) => number;
  /** 测试注入取消；缺省 cancelAnimationFrame。 */
  cancelRaf?: (id: number) => void;
  /** 读 active 元素当前播放位置（秒）。 */
  readPosition: () => number;
  /** 帧级写入 store.position。 */
  writePosition: (position: number) => void;
  /** 帧级位置更新后通知歌词时间轴等消费者。 */
  onPosition?: (position: number) => void;
  /** 窗口隐藏检测（失焦降频）；缺省 document.hidden。 */
  isHidden?: () => boolean;
  /** 设备切换失败提示（UI-D85：保持/回退原设备并提示具体原因）。 */
  onSinkError?: (message: string) => void;
  /** 首次创建音频图时应用持久化后的有效音量。 */
  initialOutputVolume?: () => number;
  /** 首次装配音频图时恢复持久化的输出设备。 */
  preferredSinkId?: () => string | null;
}

interface SinkableAudioContext extends AudioContext {
  setSinkId?: (deviceId: string) => Promise<void>;
}

const HIDDEN_CLOCK_SKIP = 10;

export class AudioEngineController {
  private ctx: AudioContext | null = null;
  private inputBus: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private outputGain: GainNode | null = null;
  private clockId: number | null = null;
  private lastPosition = 0;
  private currentSinkId: string | null = null;
  private readonly attachedElements = new WeakSet<HTMLMediaElement>();

  constructor(private readonly deps: AudioEngineControllerDeps) {}

  get contextState(): AudioContextLifecycle {
    if (!this.ctx) return 'absent';
    return this.ctx.state === 'suspended' ? 'suspended' : 'running';
  }

  /** 首次播放用户手势时惰性创建并装配图（幂等）。 */
  ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = this.deps.createContext ? this.deps.createContext() : new AudioContext();
    const inputBus = ctx.createGain();
    inputBus.gain.value = 1;
    const analyser = ctx.createAnalyser();
    const outputGain = ctx.createGain();
    outputGain.gain.value = this.deps.initialOutputVolume?.() ?? 1;
    // Output is connected here; the analyser fan-out is completed by telemetry or its fallback below.
    outputGain.connect(ctx.destination);
    this.ctx = ctx;
    this.inputBus = inputBus;
    this.analyser = analyser;
    this.outputGain = outputGain;
    return ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // 手势外的 resume 可能被浏览器拒绝；保持 suspended，由下一次用户手势驱动。
      }
    }
  }

  /**
   * 接入 HSE 节点（host 负责 masterGain 槽全断与 engine 插入），并装配分析 tap：
   * analyser（HSE 输出挂点）→ tap（post-DSP pre-output-gain）→ 输出增益。
   */
  async attachHse(params?: HyperSoundEngineParams): Promise<void> {
    const ctx = this.ensureContext();
    const handle = {
      audioContext: ctx,
      masterGain: this.inputBus as unknown as HseHandleNode,
      analyser: this.analyser as unknown as HseHandleNode,
    };
    await this.deps.hse.attach(handle, params ?? createDefaultParams(ctx.sampleRate));
    // 闭合规格书链图：source→HSE→analyser→tap→outputGain→destination
    if (this.analyser && this.outputGain) {
      if (this.deps.telemetry) {
        try {
          await this.deps.telemetry.connect(ctx, this.analyser, this.outputGain);
        } catch (error) {
          // Telemetry is optional; analyser→outputGain remains the audible fallback.
          this.analyser.connect(this.outputGain);
          this.deps.onSinkError?.(`音频分析不可用：${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        this.analyser.connect(this.outputGain);
      }
    }
    const preferredSinkId = this.deps.preferredSinkId?.();
    if (preferredSinkId) await this.setSinkId(preferredSinkId);
  }

  /** MediaElement 接入：元素 → MediaElementSource → 输入总线（每个元素一次）。 */
  attachMediaElement(element: HTMLMediaElement): MediaElementAudioSourceNode | null {
    if (this.attachedElements.has(element)) return null;
    const ctx = this.ensureContext();
    const source = ctx.createMediaElementSource(element);
    this.attachedElements.add(element);
    this.wireSource(source);
    return source;
  }

  get outputNode(): AudioNode | null {
    return this.outputGain;
  }

  /** 音量变化只影响输出增益（UI-D45：不修改 DSP 预设参数）。 */
  setOutputVolume(volume: number): void {
    if (this.outputGain) this.outputGain.gain.value = volume;
  }

  /** 源接入：MediaElementSource → 输入总线（HSE 链头）。 */
  wireSource(source: MediaElementAudioSourceNode): void {
    const bus = this.inputBus;
    if (!bus) throw new Error('audio-engine: wireSource before ensureContext');
    source.connect(bus);
  }

  async listOutputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = navigator.mediaDevices ? await navigator.mediaDevices.enumerateDevices() : [];
    return devices.filter((d) => d.kind === 'audiooutput');
  }

  /** 输出设备切换：失败回退原设备并提示（UI-D45/D85）。 */
  async setSinkId(deviceId: string): Promise<boolean> {
    if (!this.ctx) {
      this.deps.onSinkError?.('音频尚未启动，请开始播放后再切换输出设备。');
      return false;
    }
    const sinkCtx = this.ctx as SinkableAudioContext;
    if (!sinkCtx.setSinkId) {
      this.deps.onSinkError?.('当前系统不支持应用内切换输出设备。');
      return false;
    }
    try {
      await sinkCtx.setSinkId(deviceId);
      this.currentSinkId = deviceId;
      return true;
    } catch (error) {
      if (this.currentSinkId !== null) {
        try {
          await sinkCtx.setSinkId(this.currentSinkId);
        } catch {
          // 回退也失败：系统仍会选择可用的默认输出。
        }
      }
      this.deps.onSinkError?.(
        `切换输出设备失败，已回退原设备：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** rAF 时钟：帧级写 position；窗口隐藏时降频（每 10 帧写一次）。 */
  startClock(): void {
    if (this.clockId !== null) return;
    const schedule = this.deps.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
    let frame = 0;
    const loop = (): void => {
      frame += 1;
      const hidden = this.deps.isHidden
        ? this.deps.isHidden()
        : typeof document !== 'undefined' && document.hidden;
      if (!hidden || frame % HIDDEN_CLOCK_SKIP === 0) {
        const position = this.deps.readPosition();
        if (position !== this.lastPosition) {
          this.lastPosition = position;
          this.deps.writePosition(position);
          this.deps.onPosition?.(position);
        }
      }
      this.clockId = schedule(loop);
    };
    this.clockId = schedule(loop);
  }

  stopClock(): void {
    if (this.clockId === null) return;
    (this.deps.cancelRaf ?? ((id: number) => cancelAnimationFrame(id)))(this.clockId);
    this.clockId = null;
  }

  dispose(): void {
    this.stopClock();
    this.deps.hse.dispose();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.inputBus = null;
      this.analyser = null;
      this.outputGain = null;
    }
  }
}

/** host handle 所需的最小节点接口（与 GainNode/AnalyserNode 结构兼容）。 */
interface HseHandleNode {
  connect?(dest: unknown): unknown;
  disconnect?(dest?: unknown): unknown;
}
