/**
 * TelemetryTap —— 自研分析 worklet tap（UI-D80/D86）。
 *
 * 接在 HSE 节点之后、输出增益之前（post-DSP pre-output-gain）；
 * worklet 内计算 64 桶双声道 min/max 波形 + 96 对数频谱带，port.postMessage
 * 覆盖式发帧；主线程只取最新帧（无 ACK 背压），不共享可变对象、不走 React state。
 */

/** 分析 worklet 打包产物（scripts/build-analysis-worklet.mjs → app/public/worklet/analysis-tap.js）。 */
export const ANALYSIS_TAP_WORKLET_URL = '/worklet/analysis-tap.js';

export const ANALYSIS_TAP_PROCESSOR_NAME = 'hyperplayer-analysis-tap';

export interface TelemetryFrame {
  type: 'frame';
  sequence: number;
  /** 每声道 64 桶 min/max 对（ch0 在前，ch1 紧随）：[min0,max0,min1,max1,...]。 */
  wave: Float32Array;
  /** 96 对数频谱带（RMS 能量近似）。 */
  spectrum: Float32Array;
  sampleRate: number;
  at: number;
}

/** AudioWorkletNode 最小接口（测试 stub）。 */
export interface AudioWorkletNodeLike {
  port: {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  };
  connect(destination: unknown): unknown;
  disconnect(): void;
}

type AudioWorkletNodeFactory = (name: string, options?: object) => AudioWorkletNodeLike;

/** 真实上下文创建 tap 节点（AudioContext 类型的 createAudioWorkletNode 由运行时提供）。 */
function createTapNode(context: AudioContext): AudioWorkletNodeLike {
  const factory = (context as AudioContext & { createAudioWorkletNode?: AudioWorkletNodeFactory }).createAudioWorkletNode;
  if (!factory) throw new Error('telemetry-tap: AudioContext.createAudioWorkletNode is unavailable');
  return factory(ANALYSIS_TAP_PROCESSOR_NAME);
}

export interface TelemetryTapDeps {
  /** worklet 产物 URL；缺省 '/worklet/analysis-tap.js'。 */
  workletUrl?: string;
  /** 测试注入节点工厂（跳过 addModule）。 */
  createNode?: (context: AudioContext) => AudioWorkletNodeLike;
  onError?: (error: unknown) => void;
}

export class TelemetryTap {
  private node: AudioWorkletNodeLike | null = null;
  private latest: TelemetryFrame | null = null;
  private readonly workletUrl: string;
  private readonly createNode: ((context: AudioContext) => AudioWorkletNodeLike) | null;
  private readonly onError: (error: unknown) => void;

  constructor(deps: TelemetryTapDeps = {}) {
    this.workletUrl = deps.workletUrl ?? ANALYSIS_TAP_WORKLET_URL;
    this.createNode = deps.createNode ?? null;
    this.onError = deps.onError ?? (() => {});
  }

  /** 主线程只取最新帧（覆盖式，无队列）。 */
  get latestFrame(): TelemetryFrame | null {
    return this.latest;
  }

  /** 装配：input（HSE 输出）→ tap 节点 → output（输出增益）。 */
  async connect(context: AudioContext, input: AudioNode, output: AudioNode): Promise<void> {
    if (this.node) return;
    try {
      if (!this.createNode) {
        await context.audioWorklet.addModule(this.workletUrl);
      }
      const node = this.createNode ? this.createNode(context) : createTapNode(context);
      node.port.onmessage = (e: { data: unknown }) => {
        if (e.data && typeof e.data === 'object' && (e.data as TelemetryFrame).type === 'frame') {
          this.latest = e.data as TelemetryFrame; // 覆盖式：新帧直接替换
        }
      };
      input.connect(node as unknown as AudioNode);
      node.connect(output);
      this.node = node;
    } catch (error) {
      this.onError(error);
      throw error;
    }
  }

  dispose(): void {
    this.node?.disconnect();
    this.node = null;
    this.latest = null;
  }
}
