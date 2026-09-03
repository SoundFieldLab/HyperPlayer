import { useEffect, useState } from "react";
import {
  Waveform, ArrowsClockwise, ArrowsHorizontal, Broadcast, Headphones, Info, Lightning, Microphone,
  Moon, MusicNotes, Pulse, ShieldCheck, SlidersHorizontal, Sparkle, SpeakerHigh, SpeakerLow,
  Timer, WaveSine, Waves, Wind, X,
} from "@phosphor-icons/react";
import { bridge } from "../bridge";
import type { DspConfigurationDto } from "../bridge/contracts";
import { SectionTitle, Toggle, Page } from "../components/ui";
import { useAppStore } from "../store";
import { MeterStrip, ResponseCurveSvg, SpectrumCanvas2D } from "../visualization/renderers";
import { useMainWindowTelemetry, type TelemetryFrame } from "../visualization/telemetry";

type DspSectionKey = Exclude<keyof DspConfigurationDto, "revision" | "midSide">;
type ModuleKey = DspSectionKey | "midSide" | "lufsTap";

type EffectMeta = {
  key: ModuleKey;
  stage: string;
  name: string;
  desc: string;
  intro: string;
  icon: typeof Waveform;
};

/** 按用户意图分组的效果卡片；stage 编号仅作角标，不再主导导航。 */
const EFFECT_GROUPS: Array<{ title: string; hint: string; effects: EffectMeta[] }> = [
  {
    title: "响度与音量",
    hint: "统一各首歌的音量，低音量下保护听感",
    effects: [
      { key: "loudnessNormalization", stage: "01", name: "响度归一化", desc: "切换歌曲音量一致", intro: "实时测量每首歌的响度并对齐到目标值（默认 -14 LUFS），换歌时不再忽大忽小。", icon: SpeakerHigh },
      { key: "loudnessComp", stage: "15", name: "等响度补偿", desc: "小音量下补足低频高频", intro: "人耳在小音量下对低频和高频不敏感；打开后按当前音量自动补偿频响，音量恢复后自动回平。", icon: WaveSine },
      { key: "nightMode", stage: "07", name: "夜间模式", desc: "压平音量起伏，深夜不吵", intro: "动态压缩增强并衰减高频刺耳感，适合深夜低音量听播客和影视。强度 0–10 级。", icon: Moon },
      { key: "limiter", stage: "21", name: "限制器", desc: "防止削波爆音的安全阀", intro: "前瞻式限幅器配合真峰值检测，在效果叠加后仍然杜绝削波；建议常开。", icon: ShieldCheck },
    ],
  },
  {
    title: "空间与声场",
    hint: "耳机里的距离感、房间感与宽度",
    effects: [
      { key: "spatial", stage: "22", name: "空间音频", desc: "HRTF 双耳渲染与舞台模式", intro: "基于 MIT KEMAR HRTF 的双耳渲染：即时展开、头锁定、世界与舞台四种模式，HRTF 资源经 SHA-256 校验加载。", icon: Headphones },
      { key: "surround3d", stage: "02", name: "环绕运动", desc: "声音绕头旋转", intro: "让声音在耳机内围绕头部旋转，可设置角度、距离、速度与方向。", icon: ArrowsClockwise },
      { key: "reverb", stage: "13", name: "混响", desc: "给声音加房间感", intro: "算法混响（音乐厅/房间/金属板/弹簧/舞台）、FDN 混响与分区卷积混响三种路由，可自由切换。", icon: Waves },
      { key: "midSide", stage: "03", name: "M/S 声场", desc: "声场宽度与人声比例", intro: "基于中/侧声道分离：宽度 0–2 控制声场开合，人声比例在伴奏与纯人声之间滑动。", icon: ArrowsHorizontal },
    ],
  },
  {
    title: "均衡与音色",
    hint: "修正频响、微调听感",
    effects: [
      { key: "preEq", stage: "04", name: "参数均衡", desc: "手动调整各频段增益", intro: "最多 20 个频段的参数均衡器，可逐段调整频率、增益与 Q 值。", icon: SlidersHorizontal },
      { key: "ieq", stage: "16/17", name: "智能均衡", desc: "按目标曲线自动修正", intro: "分析当前频谱并与目标曲线（平坦/温暖/通透/人声）对比后缓慢修正，避免跟随音乐抽吸。", icon: Sparkle },
      { key: "dynamicEq", stage: "18", name: "动态均衡", desc: "只在超标时压频段", intro: "五个频段的动态均衡：信号超过阈值才收敛，比静态均衡更透明。", icon: Waveform },
    ],
  },
  {
    title: "动态与调制",
    hint: "压缩、激励与周期性效果",
    effects: [
      { key: "compressor", stage: "06", name: "动态压缩", desc: "让响度更平稳", intro: "软拐点压缩器压平音量起伏；阈值越低压缩越狠，补偿增益弥补压缩损失的电平。", icon: Waveform },
      { key: "deesser", stage: "05", name: "齿音控制", desc: "压低刺耳的 s / t 音", intro: "侧链检测 4–8kHz 齿音频段并压低：分带式只压高频带（推荐），宽带式整体压缩。", icon: Microphone },
      { key: "bassEnhancer", stage: "14", name: "低频增强", desc: "小设备也能感知低音", intro: "提取低频并生成谐波（奇次/偶次/ATSR/软饱和），增强低频冲击力；建议与限制器同开。", icon: SpeakerLow },
      { key: "delay", stage: "08", name: "延迟", desc: "回声与空间纵深", intro: "环形延迟线 + 反馈 + 干湿混合，用于回声与节奏型重复。", icon: Timer },
      { key: "chorus", stage: "09", name: "合唱", desc: "加厚与空间感", intro: "多路 LFO 调制分数延迟，营造厚度与空间感。", icon: MusicNotes },
      { key: "flanger", stage: "10", name: "镶边", desc: "喷气式扫频", intro: "短延迟 + LFO 调制 + 反馈，产生标志性的金属扫频。", icon: Wind },
      { key: "phaser", stage: "11", name: "移相", desc: "柔和的相位扫频", intro: "多级全通滤波器 + LFO 调制，比镶边更平滑的扫频效果。", icon: Lightning },
      { key: "tremolo", stage: "12", name: "颤音", desc: "周期性音量起伏", intro: "LFO 调制信号幅度，常用于复古颤音与氛围铺底。", icon: Pulse },
      { key: "modulation", stage: "20", name: "参数调制", desc: "LFO / 包络驱动参数", intro: "把 LFO 与包络跟随器作为调制源，按路由叠加到主增益或立体声宽度。", icon: Broadcast },
    ],
  },
];

const MEASURE_META: EffectMeta = { key: "lufsTap", stage: "19", name: "LUFS 测量", desc: "实时响度与真峰值读数", intro: "BS.1770 双模式响度测量，播放中实时显示。", icon: Waveform };

const LABELS: Record<string, string> = { targetLufs: "目标 LUFS", maxGainDb: "最大增益 dB", minGainDb: "最小增益 dB", useRealtimeMeter: "实时测量", externalGainDb: "外部增益 dB", distance: "距离", speed: "速度", angle: "角度", direction: "方向", stereoWidth: "宽度", voiceBalance: "人声平衡", bandCount: "频段数", qCompensation: "Q 补偿", stereoMode: "立体声模式", centerHz: "中心频率 Hz", q: "Q", thresholdDb: "阈值 dB", ratio: "压缩比", attackMs: "启动 ms", releaseMs: "释放 ms", splitBand: "分频处理", mix: "混合", kneeDb: "拐点 dB", makeupDb: "补偿 dB", outputGain: "输出增益", amount: "强度", delayMs: "延迟 ms", feedback: "反馈", rateHz: "速率 Hz", depthMs: "深度 ms", depth: "深度", stages: "级数", cutoffHz: "截止频率 Hz", harmonicType: "谐波类型", harmonicGain: "谐波增益", levelDb: "电平 dB", lowBoostDb: "低频提升 dB", mode: "模式", reverbType: "混响类型", roomSize: "房间大小", damping: "阻尼", wet: "湿声增益", dry: "干声增益", preDelayMs: "预延迟 ms", width: "声场宽度", fdnLines: "FDN 线数", partitionSize: "最短分区（样本）", shortRegionMs: "短区段时长 ms", preset: "场景预设", volumePercent: "音量百分比", smoothingSeconds: "平滑时间 s", blockSize: "分析块长（样本）", strength: "处理强度", truePeak: "真峰值检测", targetGainDb: "目标增益 dB", frequency: "频率 Hz", gain: "增益 dB", targetCurve: "目标曲线", timeConstantSec: "平滑时间 s", lfoShape: "LFO 波形", lfoRateHz: "LFO 速率 Hz", lfoDepth: "LFO 深度", envelopeAttackMs: "包络启动 ms", envelopeReleaseMs: "包络释放 ms", envelopeAmount: "包络输出量", polarity: "极性", smoothingMs: "路由平滑 ms", masterGain: "主增益", instantAmount: "干湿量", instantSpreadDeg: "展开角 度", instantRoom: "房间预设", instantRoomAmount: "房间混合", distanceModel: "距离模型", refDistance: "参考距离 m", maxDistance: "最大距离 m", convolution: "卷积实现", hrtfInterp: "HRTF 插值", stagePreset: "舞台布局", seat: "座位", stageRoomSize: "房间缩放", stageReverbAmount: "混响量", worldOcclusion: "遮挡量", ambienceEnabled: "环境声层", ambienceAmount: "环境声强度" };
type DspNumberConstraint = { min: number; max: number; step: number; integer?: boolean };
const DSP_CONSTRAINTS: Record<string, Record<string, DspNumberConstraint>> = {
  loudnessNormalization: {
    targetLufs: { min: -40, max: 0, step: 0.1 }, maxGainDb: { min: 0, max: 24, step: 0.1 }, minGainDb: { min: -24, max: 0, step: 0.1 }, externalGainDb: { min: -24, max: 24, step: 0.1 },
  },
  surround3d: { distance: { min: 0, max: 10, step: 0.01 }, speed: { min: 0, max: 10, step: 0.1 }, angle: { min: -360, max: 360, step: 1 } },
  midSide: { stereoWidth: { min: 0, max: 2, step: 0.01 }, voiceBalance: { min: -1, max: 1, step: 0.01 } },
  preEq: { bandCount: { min: 1, max: 20, step: 1, integer: true }, frequency: { min: 20, max: 20_000, step: 1 }, gain: { min: -20, max: 20, step: 0.1 }, q: { min: 0.1, max: 10, step: 0.1 } },
  deesser: { centerHz: { min: 100, max: 16_000, step: 1 }, q: { min: 0.1, max: 10, step: 0.1 }, thresholdDb: { min: -60, max: 0, step: 0.1 }, ratio: { min: 1, max: 50, step: 0.1 }, attackMs: { min: 0, max: 100, step: 0.1 }, releaseMs: { min: 0, max: 2_000, step: 1 }, mix: { min: 0, max: 1, step: 0.01 } },
  compressor: { thresholdDb: { min: -60, max: 0, step: 0.1 }, ratio: { min: 1, max: 50, step: 0.1 }, kneeDb: { min: 0, max: 24, step: 0.1 }, attackMs: { min: 0, max: 500, step: 0.1 }, releaseMs: { min: 0, max: 3_000, step: 1 }, makeupDb: { min: -24, max: 24, step: 0.1 }, outputGain: { min: 0, max: 2, step: 0.01 } },
  nightMode: { amount: { min: 0, max: 10, step: 0.01 } },
  delay: { delayMs: { min: 0, max: 2_000, step: 1 }, feedback: { min: 0, max: 0.98, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 } },
  chorus: { rateHz: { min: 0.01, max: 20, step: 0.01 }, depthMs: { min: 0, max: 50, step: 0.1 }, mix: { min: 0, max: 1, step: 0.01 } },
  flanger: { rateHz: { min: 0.01, max: 20, step: 0.01 }, depthMs: { min: 0, max: 50, step: 0.1 }, feedback: { min: 0, max: 0.98, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 } },
  phaser: { rateHz: { min: 0.01, max: 20, step: 0.01 }, depth: { min: 0, max: 1, step: 0.01 }, feedback: { min: 0, max: 0.98, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 }, stages: { min: 2, max: 8, step: 1, integer: true } },
  tremolo: { rateHz: { min: 0.01, max: 30, step: 0.01 }, depth: { min: 0, max: 1, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 } },
  reverb: { roomSize: { min: 0, max: 1, step: 0.01 }, damping: { min: 0, max: 1, step: 0.01 }, wet: { min: 0, max: 4, step: 0.01 }, dry: { min: 0, max: 4, step: 0.01 }, preDelayMs: { min: 0, max: 1000, step: 1 }, width: { min: 0, max: 2, step: 0.01 }, fdnLines: { min: 2, max: 16, step: 1, integer: true }, mix: { min: 0, max: 1, step: 0.01 }, partitionSize: { min: 32, max: 8192, step: 1, integer: true }, shortRegionMs: { min: 0, max: 5000, step: 10 } },
  bassEnhancer: { cutoffHz: { min: 20, max: 500, step: 1 }, q: { min: 0.1, max: 10, step: 0.1 }, harmonicGain: { min: 0, max: 1, step: 0.01 }, mix: { min: 0, max: 1, step: 0.01 }, levelDb: { min: -6, max: 6, step: 0.1 }, lowBoostDb: { min: -6, max: 12, step: 0.1 } },
  loudnessComp: { volumePercent: { min: 0, max: 100, step: 1 }, maxBoostDb: { min: 0, max: 24, step: 0.1 }, smoothingSeconds: { min: 0.01, max: 10, step: 0.01 }, frequency: { min: 20, max: 20_000, step: 1 }, gain: { min: -24, max: 24, step: 0.1 } },
  ieq: { strength: { min: 0, max: 1, step: 0.01 }, timeConstantSec: { min: 0.1, max: 10, step: 0.01 } },
  dynamicEq: { strength: { min: 0, max: 1, step: 0.01 }, thresholdDb: { min: -80, max: 0, step: 0.1 }, ratio: { min: 1, max: 100, step: 0.1 }, kneeDb: { min: 0, max: 40, step: 0.1 }, attackMs: { min: 0, max: 1000, step: 0.1 }, releaseMs: { min: 0, max: 5000, step: 1 }, blockSize: { min: 16, max: 2048, step: 1, integer: true }, frequency: { min: 30, max: 20_000, step: 1 }, targetGainDb: { min: -12, max: 12, step: 0.1 } },
  modulation: { lfoRateHz: { min: 0, max: 1000, step: 0.1 }, lfoDepth: { min: 0, max: 1, step: 0.01 }, envelopeAttackMs: { min: 0.05, max: 5000, step: 0.1 }, envelopeReleaseMs: { min: 0.05, max: 5000, step: 1 }, envelopeAmount: { min: 0, max: 1, step: 0.01 } },
  limiter: { thresholdDb: { min: -60, max: 0, step: 0.1 }, lookaheadMs: { min: 0, max: 20, step: 0.1 }, attackMs: { min: 0, max: 100, step: 0.1 }, releaseMs: { min: 0, max: 1000, step: 1 } },
  spatial: { masterGain: { min: 0.5, max: 1, step: 0.01 }, instantAmount: { min: 0, max: 1, step: 0.01 }, instantSpreadDeg: { min: 20, max: 120, step: 1 }, instantRoomAmount: { min: 0, max: 1, step: 0.01 }, refDistance: { min: 0.1, max: 100, step: 0.1 }, maxDistance: { min: 0.2, max: 1000, step: 1 }, stageRoomSize: { min: 0.5, max: 2, step: 0.01 }, stageReverbAmount: { min: 0, max: 1, step: 0.01 }, worldOcclusion: { min: 0, max: 1, step: 0.01 }, ambienceAmount: { min: 0, max: 1, step: 0.01 } },
};

// 枚举型字段统一用下拉选择渲染；键为 `${section}.${field}`。
const FIELD_OPTIONS: Record<string, Array<[string, string]>> = {
  "reverb.mode": [["algorithmic", "算法混响"], ["fdn", "FDN 混响"], ["convolution", "卷积混响"]],
  "reverb.reverbType": [["hall", "音乐厅"], ["room", "房间"], ["plate", "金属板"], ["spring", "弹簧"], ["stage", "舞台"]],
  "reverb.fdnLines": [["2", "2 线"], ["4", "4 线"], ["8", "8 线"], ["16", "16 线"]],
  "loudnessComp.mode": [["auto", "自动"], ["preset", "预设"], ["custom", "自定义"]],
  "loudnessComp.preset": [["flat", "平直"], ["bass", "低频"], ["vocal", "人声"], ["warm", "温暖"], ["bright", "明亮"], ["night", "夜间"]],
  "spatial.mode": [["off", "关闭"], ["instant", "即时展开"], ["headLocked", "头锁定"], ["world", "世界模式"], ["stage", "舞台模式"]],
  "spatial.instantRoom": [["off", "无"], ["studio", "录音室"], ["hall", "音乐厅"], ["stage", "舞台"], ["church", "教堂"], ["outdoor", "户外"], ["bathroom", "浴室"], ["corridor", "走廊"]],
  "spatial.distanceModel": [["inverse", "反比"], ["linear", "线性"], ["exponential", "指数"]],
  "spatial.convolution": [["partitioned", "分区卷积"], ["time", "时域卷积"]],
  "spatial.hrtfInterp": [["nearest", "最近邻"], ["spherical", "球面插值"]],
  "spatial.stagePreset": [["stage", "舞台"], ["cinema", "影院"], ["piano", "钢琴"], ["nature", "自然"]],
  "spatial.seat": [["front", "前排"], ["middle", "中排"], ["back", "后排"]],
  "bassEnhancer.harmonicType": [["odd", "奇次谐波"], ["even", "偶次谐波"], ["atan", "ATSR 饱和"], ["soft", "软饱和"]],
  "preEq.stereoMode": [["independent", "独立声道"], ["hseShared", "HSE 共享"]],
  "surround3d.direction": [["-1", "逆向"], ["1", "正向"]],
  "modulation.lfoShape": [["sine", "正弦"], ["triangle", "三角"], ["square", "方波"], ["saw", "锯齿"]],
  "ieq.targetCurve": [["flat", "平坦"], ["warm", "温暖"], ["bright", "通透"], ["vocal", "人声"]],
};

function validateNumber(value: unknown, constraint: DspNumberConstraint, label: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${label}不能为空且必须是有限数值`;
  if (value < constraint.min || value > constraint.max) return `${label}必须在 ${constraint.min} 到 ${constraint.max} 之间`;
  if (constraint.integer && !Number.isInteger(value)) return `${label}必须是整数`;
  return null;
}

function validateDspDraft(draft: DspConfigurationDto | null): string[] {
  if (!draft) return ["DSP 配置尚未加载"];
  const errors: string[] = [];
  if (!Number.isSafeInteger(Number(draft.revision)) || Number(draft.revision) <= 0) errors.push("配置 revision 必须是正整数");
  // bands 专属约束键不作为标量校验（与 preEq 同理，另行逐带校验）。
  const bandOnlyFields = new Set(["frequency", "gain", "targetGainDb"]);
  for (const [sectionKey, constraints] of Object.entries(DSP_CONSTRAINTS)) {
    if (sectionKey === "preEq") continue;
    const section = draft[sectionKey as keyof DspConfigurationDto] as unknown as Record<string, unknown>;
    for (const [field, constraint] of Object.entries(constraints)) {
      if (bandOnlyFields.has(field) && "bands" in section) continue;
      if (sectionKey === "bassEnhancer" && field === "lowBoostDb" && section[field] === null) continue;
      const error = validateNumber(section[field], constraint, `${LABELS[field] ?? field}`);
      if (error) errors.push(error);
    }
  }
  const countError = validateNumber(draft.preEq.bandCount, DSP_CONSTRAINTS.preEq.bandCount, "频段数");
  if (countError) errors.push(countError);
  if (draft.preEq.bands.length !== draft.preEq.bandCount) errors.push("频段数必须与均衡器频段数量一致");
  draft.preEq.bands.forEach((band, index) => {
    for (const field of ["frequency", "gain", "q"] as const) {
      const error = validateNumber(band[field], DSP_CONSTRAINTS.preEq[field], `频段 ${index + 1} ${field === "frequency" ? "频率" : field === "gain" ? "增益" : "Q"}`);
      if (error) errors.push(error);
    }
  });
  if (![-1, 1].includes(draft.surround3d.direction)) errors.push("方向必须为逆向或正向");
  if (!["independent", "hseShared"].includes(draft.preEq.stereoMode)) errors.push("立体声模式无效");
  if (!["odd", "even", "atan", "soft"].includes(draft.bassEnhancer.harmonicType)) errors.push("谐波类型无效");
  if (!["algorithmic", "fdn", "convolution"].includes(draft.reverb.mode)) errors.push("混响模式无效");
  if (!["hall", "room", "plate", "spring", "stage"].includes(draft.reverb.reverbType)) errors.push("混响类型无效");
  if (![2, 4, 8, 16].includes(draft.reverb.fdnLines)) errors.push("FDN 线数必须为 2、4、8 或 16");
  if (!["auto", "preset", "custom"].includes(draft.loudnessComp.mode)) errors.push("等响度模式无效");
  if (!["flat", "bass", "vocal", "warm", "bright", "night"].includes(draft.loudnessComp.preset)) errors.push("等响度场景预设无效");
  draft.loudnessComp.bands.forEach((band, index) => {
    const frequencyError = validateNumber(band.frequency, DSP_CONSTRAINTS.loudnessComp.frequency, `等响度频点 ${index + 1} 频率`);
    if (frequencyError) errors.push(frequencyError);
    const gainError = validateNumber(band.gain, DSP_CONSTRAINTS.loudnessComp.gain, `等响度频点 ${index + 1} 增益`);
    if (gainError) errors.push(gainError);
  });
  if (draft.dynamicEq.bands.length !== 5) errors.push("动态均衡必须固定 5 个频段");
  draft.dynamicEq.bands.forEach((band, index) => {
    // 末带（第 5 带）交叉频率被引擎忽略，仅要求有限值。
    if (index < 4) {
      const frequencyError = validateNumber(band.frequency, DSP_CONSTRAINTS.dynamicEq.frequency, `动态均衡频段 ${index + 1} 频率`);
      if (frequencyError) errors.push(frequencyError);
    } else if (!Number.isFinite(band.frequency)) {
      errors.push(`动态均衡频段 5 频率不能为空且必须是有限数值`);
    }
    const gainError = validateNumber(band.targetGainDb, DSP_CONSTRAINTS.dynamicEq.targetGainDb, `动态均衡频段 ${index + 1} 目标增益`);
    if (gainError) errors.push(gainError);
  });
  if (!["flat", "warm", "bright", "vocal"].includes(draft.ieq.targetCurve)) errors.push("智能均衡目标曲线无效");
  if (!["sine", "triangle", "square", "saw"].includes(draft.modulation.lfoShape)) errors.push("LFO 波形无效");
  if (draft.modulation.routes.length > 8) errors.push("调制路由最多 8 条");
  draft.modulation.routes.forEach((route, index) => {
    if (!["lfo", "envelope"].includes(route.source)) errors.push(`路由 ${index + 1} 源无效`);
    if (!["masterGain", "stereoWidth"].includes(route.target)) errors.push(`路由 ${index + 1} 目标无效`);
    if (route.polarity !== 1 && route.polarity !== -1) errors.push(`路由 ${index + 1} 极性必须为 +1 或 -1`);
  });
  if (!["off", "instant", "headLocked", "world", "stage"].includes(draft.spatial.mode)) errors.push("空间模式无效");
  if (!["off", "studio", "hall", "stage", "church", "outdoor", "bathroom", "corridor"].includes(draft.spatial.instantRoom)) errors.push("空间房间预设无效");
  if (!["inverse", "linear", "exponential"].includes(draft.spatial.distanceModel)) errors.push("距离模型无效");
  if (!["time", "partitioned"].includes(draft.spatial.convolution)) errors.push("空间卷积实现无效");
  if (!["nearest", "spherical"].includes(draft.spatial.hrtfInterp)) errors.push("HRTF 插值无效");
  if (!["stage", "cinema", "piano", "nature"].includes(draft.spatial.stagePreset)) errors.push("舞台布局无效");
  if (!["front", "middle", "back"].includes(draft.spatial.seat)) errors.push("座位无效");
  if (draft.spatial.maxDistance <= draft.spatial.refDistance + 0.1) errors.push("最大距离必须大于参考距离 + 0.1");
  return errors;
}

function formatValue(field: string, value: number, constraint?: DspNumberConstraint): string {
  if (!Number.isFinite(value)) return "—";
  if (field.endsWith("Hz")) return `${value >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} kHz` : `${value} Hz`}`;
  if (/Db$/.test(field) || field === "targetLufs") return `${value > 0 ? "+" : ""}${value} dB`;
  if (/Ms$/.test(field)) return `${value} ms`;
  if (field === "volumePercent") return `${value}%`;
  if (constraint && constraint.min >= 0 && constraint.max <= 1.001 && constraint.step <= 0.01) return `${Math.round(value * 100)}%`;
  return `${value}`;
}

function resizeEqBands(draft: DspConfigurationDto, requestedCount: number): DspConfigurationDto {
  const bandCount = Math.max(1, Math.min(20, Math.trunc(requestedCount)));
  const bands = draft.preEq.bands.slice(0, bandCount);
  while (bands.length < bandCount) {
    const previous = bands.at(-1) ?? { frequency: 1000, gain: 0, q: 1 };
    const frequency = previous.frequency >= 20_000 ? 20_000 : Math.min(20_000, Math.round(previous.frequency + (20_000 - previous.frequency) / 2));
    bands.push({ frequency, gain: previous.gain, q: previous.q });
  }
  return { ...draft, preEq: { ...draft.preEq, bandCount, bands } };
}

const FLAT_DSP_RESPONSE = [
  { frequencyHz: 20, gainDb: 0 },
  { frequencyHz: 20_000, gainDb: 0 },
] as const;

function formatLufs(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)} LUFS` : "—";
}

function formatPeak(left: number | null, right: number | null): string {
  if (left === null || right === null) return "—";
  return `${Math.max(left, right).toFixed(2)} dBFS`;
}

function SpatialFieldSvg({ mode, spreadDeg }: { mode: DspConfigurationDto["spatial"]["mode"]; spreadDeg: number }): React.JSX.Element | null {
  // 克制的 2D 顶视示意（DOM/SVG，无 GPU context，UI-D80 边界）：中心听者 +
  // 按模式示意扬声器/音源布局；仅静态示意，不代表实际 HRTF 采样位置。
  if (mode === "off") return null;
  const heading = <text x="44" y="52" textAnchor="middle" fontSize="9" fill="currentColor">前</text>;
  const listener = <g><circle cx="44" cy="30" r="5" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="44" y1="25" x2="44" y2="21" stroke="currentColor" strokeWidth="1.2"/></g>;
  const speaker = (angleDeg: number, radius: number) => {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return <circle key={`${angleDeg}-${radius}`} cx={44 + radius * Math.cos(rad)} cy={30 - radius * Math.sin(rad)} r="2.4" fill="currentColor"/>;
  };
  const points: React.JSX.Element[] = [];
  if (mode === "instant") {
    const half = Math.max(10, Math.min(60, spreadDeg / 2));
    points.push(speaker(-half, 22), speaker(half, 22));
  } else if (mode === "headLocked") {
    points.push(speaker(-90, 10), speaker(90, 10));
  } else if (mode === "world") {
    for (const angle of [-30, 30, -110, 110, 180]) points.push(speaker(angle, 22));
  } else if (mode === "stage") {
    points.push(speaker(-25, 20), speaker(0, 22), speaker(25, 20), speaker(-110, 18), speaker(110, 18));
  }
  return <svg className="spatial-field" role="img" aria-label={`空间场示意（${mode} 模式）`} viewBox="0 0 88 60" width="88" height="60">
    {heading}
    {mode === "stage" && <rect x="16" y="10" width="56" height="40" rx="3" fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.5"/>}
    {listener}
    {points}
  </svg>;
}

/** 单个参数控件：数值带约束用「滑块 + 精调输入」，枚举用下拉，布尔用开关。 */
function DspField({ sectionKey, field, value, onChange }: { sectionKey: string; field: string; value: unknown; onChange(value: unknown): void }): React.JSX.Element {
  const label = LABELS[field] ?? field;
  const optionsKey = `${sectionKey}.${field}`;
  if (typeof value === "boolean") {
    return <div className="dsp-param dsp-param-bool"><span>{label}</span><Toggle checked={value} onChange={onChange}/></div>;
  }
  const options = FIELD_OPTIONS[optionsKey];
  if (options) {
    return <label className="dsp-param"><span>{label}</span><select aria-label={label} value={String(value)} onChange={(event) => onChange(field === "fdnLines" || field === "direction" || field === "stages" ? Number(event.target.value) : event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
  }
  const constraint = DSP_CONSTRAINTS[sectionKey]?.[field];
  if (constraint) {
    const numeric = typeof value === "number" && Number.isFinite(value);
    return <div className="dsp-param dsp-param-number">
      <span className="dsp-param-head"><span>{label}</span><output>{numeric ? formatValue(field, value as number, constraint) : "—"}</output></span>
      <div className="dsp-param-slider">
        <input aria-label={label} type="range" min={constraint.min} max={constraint.max} step={constraint.step} value={numeric ? value as number : constraint.min} onChange={(event) => onChange(Number(event.target.value))}/>
        <input aria-label={`${label} 精确值`} type="number" min={constraint.min} max={constraint.max} step={constraint.step} value={numeric ? value : ""} placeholder={constraint.min === 0 ? "" : String(constraint.min)} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}/>
      </div>
    </div>;
  }
  return <label className="dsp-param"><span>{label}</span><input aria-label={label} type="number" value={value === null ? "" : String(value)} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}/></label>;
}

function sectionEnabled(key: ModuleKey, draft: DspConfigurationDto): boolean {
  if (key === "lufsTap") return false;
  if (key === "spatial") return draft.spatial.mode !== "off";
  if (key === "midSide") return draft.midSide.enabled;
  return Boolean((draft[key] as Record<string, unknown> | undefined)?.enabled);
}

function DspCard({ meta, enabled, onOpen }: { meta: EffectMeta; enabled: boolean; onOpen(): void }): React.JSX.Element {
  const Icon = meta.icon;
  return <div role="button" tabIndex={0} className={`dsp-card ${enabled ? "enabled" : ""}`} aria-label={`${meta.name}设置`} onClick={onOpen}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
    <span className="dsp-card-icon"><Icon/></span>
    <span className="dsp-card-text"><b>{meta.name}<i>{meta.stage}</i></b><small>{meta.desc}</small></span>
    <span className={`dsp-card-state ${enabled ? "on" : ""}`}>{enabled ? "已启用" : "未启用"}</span>
  </div>;
}

function DspModal({ meta, draft, setDraft, onClose }: { meta: EffectMeta; draft: DspConfigurationDto; setDraft(next: DspConfigurationDto): void; onClose(): void }): React.JSX.Element {
  const key = meta.key;
  const Icon = meta.icon;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const intro = key === "spatial"
    ? <>{meta.intro}<SpatialFieldSvg mode={draft.spatial.mode} spreadDeg={draft.spatial.instantSpreadDeg}/></>
    : meta.intro;
  let body: React.JSX.Element;
  if (key === "midSide") {
    const update = (field: string, value: unknown) => setDraft({ ...draft, midSide: { ...draft.midSide, [field]: value } });
    body = <div className="dsp-params">{["stereoWidth", "voiceBalance"].map((field) => <DspField key={field} sectionKey="midSide" field={field} value={draft.midSide[field as "stereoWidth" | "voiceBalance"]} onChange={(value) => update(field, value)}/>)}</div>;
  } else if (key === "spatial") {
    const update = (field: string, value: unknown) => setDraft({ ...draft, spatial: { ...draft.spatial, [field]: value } });
    const fields = Object.entries(draft.spatial).filter(([field]) => field !== "mode");
    body = <div className="dsp-params">
      <DspField sectionKey="spatial" field="mode" value={draft.spatial.mode} onChange={(value) => update("mode", value)}/>
      {fields.map(([field, value]) => <DspField key={field} sectionKey="spatial" field={field} value={value} onChange={(next) => update(field, next)}/>)}
    </div>;
  } else {
    const section = draft[key as DspSectionKey] as Record<string, unknown>;
    const update = (field: string, value: unknown) => setDraft({ ...draft, [key]: { ...section, [field]: value } } as DspConfigurationDto);
    const scalarFields = Object.entries(section).filter(([field]) => !["enabled", "bands", "bandCount", "routes"].includes(field));
    body = <div className="dsp-params">
      {key === "preEq" && <DspField sectionKey="preEq" field="bandCount" value={draft.preEq.bandCount} onChange={(value) => { if (typeof value === "number" && Number.isFinite(value)) setDraft(resizeEqBands(draft, value)); }}/>}
      {scalarFields.map(([field, value]) => <DspField key={field} sectionKey={key} field={field} value={value} onChange={(next) => update(field, next)}/>)}
      {key === "preEq" && <div className="dsp-eq-bands">{draft.preEq.bands.map((band, bandIndex) => <fieldset key={bandIndex}><legend>频段 {bandIndex + 1}</legend><DspField sectionKey="preEq" field="frequency" value={band.frequency} onChange={(value) => { const bands = draft.preEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, frequency: value as number } : item); setDraft({ ...draft, preEq: { ...draft.preEq, bands } }); }}/><DspField sectionKey="preEq" field="gain" value={band.gain} onChange={(value) => { const bands = draft.preEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, gain: value as number } : item); setDraft({ ...draft, preEq: { ...draft.preEq, bands } }); }}/><DspField sectionKey="preEq" field="q" value={band.q} onChange={(value) => { const bands = draft.preEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, q: value as number } : item); setDraft({ ...draft, preEq: { ...draft.preEq, bands } }); }}/></fieldset>)}</div>}
      {key === "loudnessComp" && <div className="dsp-eq-bands">{draft.loudnessComp.bands.map((band, bandIndex) => <fieldset key={bandIndex}><legend>频点 {bandIndex + 1}</legend><DspField sectionKey="loudnessComp" field="frequency" value={band.frequency} onChange={(value) => update("bands", draft.loudnessComp.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, frequency: value as number } : item))}/><DspField sectionKey="loudnessComp" field="gain" value={band.gain} onChange={(value) => update("bands", draft.loudnessComp.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, gain: value as number } : item))}/><button type="button" className="button secondary" onClick={() => update("bands", draft.loudnessComp.bands.filter((_, current) => current !== bandIndex))}>移除频点</button></fieldset>)}<button type="button" className="button secondary" onClick={() => update("bands", [...draft.loudnessComp.bands, { frequency: 1_000, gain: 0 }])}>添加频点</button></div>}
      {key === "dynamicEq" && <div className="dsp-eq-bands">{draft.dynamicEq.bands.map((band, bandIndex) => <fieldset key={bandIndex}><legend>频段 {bandIndex + 1}</legend><div className="dsp-param dsp-param-bool"><span>启用</span><Toggle checked={band.enabled} onChange={(enabled) => update("bands", draft.dynamicEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, enabled } : item))}/></div><DspField sectionKey="dynamicEq" field="frequency" value={band.frequency} onChange={(value) => update("bands", draft.dynamicEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, frequency: value as number } : item))}/><DspField sectionKey="dynamicEq" field="targetGainDb" value={band.targetGainDb} onChange={(value) => update("bands", draft.dynamicEq.bands.map((item, currentIndex) => currentIndex === bandIndex ? { ...item, targetGainDb: value as number } : item))}/></fieldset>)}</div>}
      {key === "modulation" && <div className="dsp-routes">{draft.modulation.routes.length === 0 ? <p className="dsp-routes-empty">暂无调制路由；LFO/包络参数在上方设置，路由由 HSE2 分享码或后续版本编辑。</p> : draft.modulation.routes.map((route, routeIndex) => <p key={routeIndex} className="dsp-routes-empty">{routeIndex + 1}. {route.source === "lfo" ? "LFO" : "包络"} → {route.target === "masterGain" ? "主增益" : "立体声宽度"}</p>)}</div>}
    </div>;
  }
  const toggleEnabled = key === "spatial"
    ? (enabled: boolean) => setDraft({ ...draft, spatial: { ...draft.spatial, mode: enabled ? "instant" : "off" } })
    : key === "midSide"
      ? (enabled: boolean) => setDraft({ ...draft, midSide: { ...draft.midSide, enabled } })
      : (enabled: boolean) => setDraft({ ...draft, [key]: { ...(draft[key as DspSectionKey] as Record<string, unknown>), enabled } } as DspConfigurationDto);
  const enabledNow = sectionEnabled(key, draft);
  return <div className="dsp-modal-backdrop" onClick={onClose}>
    <div className="dsp-modal" role="dialog" aria-modal="true" aria-label={`${meta.name}设置`} onClick={(event) => event.stopPropagation()}>
      <header><span className="dsp-card-icon"><Icon/></span><div><b>{meta.name}<i>{meta.stage}</i></b><small>{meta.desc}</small></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X/></button></header>
      <p className="dsp-intro">{intro}</p>
      <div className="dsp-param dsp-param-bool dsp-modal-enable"><span>启用 {meta.name}</span><Toggle checked={enabledNow} onChange={toggleEnabled}/></div>
      {body}
    </div>
  </div>;
}

export function DspWorkbenchView(): React.JSX.Element {
  const playback = useAppStore((state) => state.playback);
  const reduceMotion = useAppStore((state) => state.settings?.reduceMotion);
  const configuration = useAppStore((state) => state.dspConfiguration);
  const presets = useAppStore((state) => state.dspPresets);
  const partial = useAppStore((state) => state.dspPartial);
  const unsupported = useAppStore((state) => state.dspUnsupportedStages);
  const rejection = useAppStore((state) => state.dspRejection);
  const busy = useAppStore((state) => state.dspBusy);
  const load = useAppStore((state) => state.loadDspWorkspace);
  const configure = useAppStore((state) => state.configureDsp);
  const applyPreset = useAppStore((state) => state.applyDspPreset);
  const importHse2 = useAppStore((state) => state.importDspHse2);
  const exportHse2 = useAppStore((state) => state.exportDspHse2);
  const [draft, setDraft] = useState<DspConfigurationDto | null>(null);
  const [shareCode, setShareCode] = useState("");
  const [editor, setEditor] = useState<EffectMeta | null>(null);
  const frame = useMainWindowTelemetry(() => bridge.createTelemetryTransport(), true, reduceMotion);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (configuration) setDraft(configuration); }, [configuration]);
  const draftErrors = validateDspDraft(draft);
  const safeBypass = playback?.dspExecution.safeBypassActive ?? false;
  const bypassed = playback?.dsp.bypassed ?? true;
  const dirty = draft !== null && configuration !== null && JSON.stringify(draft) !== JSON.stringify(configuration);
  const closeEditor = () => setEditor(null);
  return <Page title="音效工作台" subtitle="点卡片调参数，调好后点底部「应用参数」生效；Rust 引擎是实际播放权威">
    <section className="dsp-console">
      <header><div><span className="eyebrow">ENGINE CHAIN</span><h2>{safeBypass ? "Rust 安全旁路" : bypassed ? "Rust 配置编译中" : "Rust 处理链在线"}</h2><p>Stage 1–15、16/17、18–22 共 22 个处理器由 vendored HSE Rust 实时执行（spatial 资源经 SHA-256 校验加载）；配置 revision {configuration?.revision ?? "-"}。</p></div><span className={`engine-indicator ${bypassed ? "" : "online"}`}><i/>{bypassed ? "BYPASS" : "LIVE"}</span></header>
      {draft && <div className="dsp-scenes" aria-label="HSE 场景">{presets.map((preset) => <button type="button" key={preset.id} className="dsp-scene-chip" disabled={busy} title={preset.description} onClick={() => void applyPreset(preset.id)}><b>{preset.name}</b>{preset.description && <small>{preset.description}</small>}</button>)}{presets.length === 0 && <p className="dsp-routes-empty">暂无可一键应用的 HSE 场景；手动调整卡片参数同样有效。</p>}</div>}
      {draftErrors.length > 0 && draft && <div id="dsp-validation-errors" className="notice dsp-validation-errors" role="alert"><Info/><span><b>参数尚未通过校验</b>{draftErrors.map((error) => <small key={error}>{error}</small>)}</span></div>}
      {busy && <div className="notice"><Info/><span>配置已提交，正在等待 Rust 处理链应用。</span></div>}{partial && <div className="notice"><Info/><span>HSE2 导入遵循 HSE codec 清洗与缺省值还原；当前仅应用 22 阶段投影。未应用：{unsupported.join("、")}</span></div>}{rejection && <div className="notice"><Info/><span>{rejection}</span></div>}
      {draft ? <div className="dsp-groups" aria-label="DSP 参数模块">
        {EFFECT_GROUPS.map((group) => <section key={group.title} className="dsp-group"><SectionTitle>{group.title}</SectionTitle><p className="dsp-group-hint">{group.hint}</p><div className="dsp-cards">{group.effects.map((meta) => <DspCard key={meta.key} meta={meta} enabled={sectionEnabled(meta.key, draft)} onOpen={() => setEditor(meta)}/>)}</div></section>)}
        <section className="dsp-group"><SectionTitle>测量</SectionTitle><p className="dsp-group-hint">播放中的实时读数，不需要配置</p>
          <div className="dsp-cards">
            <article className="dsp-card readonly"><span className="dsp-card-icon"><MEASURE_META.icon/></span><span className="dsp-card-text"><b>{MEASURE_META.name}<i>{MEASURE_META.stage}</i></b><small>{MEASURE_META.desc}</small></span>{frame?.lufs ? <dl className="dsp-lufs"><div><dt>Integrated</dt><dd>{formatLufs(frame.lufs.integrated)}</dd></div><div><dt>Momentary</dt><dd>{formatLufs(frame.lufs.momentary)}</dd></div><div><dt>Short-term</dt><dd>{formatLufs(frame.lufs.shortTerm)}</dd></div><div><dt>True Peak</dt><dd>{formatPeak(frame.meters.truePeakLeft, frame.meters.truePeakRight)}</dd></div><div><dt>Limiter Reduction</dt><dd>{frame.meters.limiterReduction !== null ? `${frame.meters.limiterReduction.toFixed(2)}` : "—"}</dd></div></dl> : <em className="dsp-card-state">等待播放</em>}</article>
          </div>
        </section>
      </div> : <div className="remote-state empty"><span>{busy ? "正在读取 DSP 配置" : "DSP 配置不可用"}</span></div>}
      <div className="eq-preview" aria-label="参数均衡器只读预览"><div className="eq-axis"><span>+12</span><span>0 dB</span><span>-12</span></div><div className="eq-bands"><section className="eq-reference"><ResponseCurveSvg points={FLAT_DSP_RESPONSE} minGainDb={-12} maxGainDb={12} ariaLabel="固定 0 dB 参考响应"/><small>固定平直参考，不代表当前 DSP 配置</small></section></div></div>
      <section className="dsp-telemetry" aria-label="实时 RMS 和峰值遥测"><h3>RMS / Peak</h3>{frame?.spectrum ? <SpectrumCanvas2D bins={frame.spectrum} ariaLabel="实时音频频谱"/> : <div aria-label="频谱暂无数据"/>}<MeterStrip meters={frame?.meters ?? null}/></section>
      <section className="dsp-share"><SectionTitle>HSE2 分享码</SectionTitle><textarea aria-label="HSE2 分享码" rows={4} value={shareCode} onChange={(event) => setShareCode(event.target.value)} placeholder="粘贴 HSE2 分享码"/><div className="dsp-share-actions"><button className="button secondary" disabled={!shareCode.trim() || busy} onClick={() => void importHse2(shareCode)}>导入 22 阶段投影</button><button className="button secondary" disabled={busy} onClick={() => void exportHse2().then(setShareCode)}>导出当前配置</button></div></section>
      <footer><div><b>配置由 actor 后台编译</b><small>严格 revision · 故障自动旁路 · 进程内配置权威</small></div></footer>
      {draft && <div className="dsp-applybar"><span>{draftErrors.length > 0 ? `${draftErrors.length} 项参数待修正` : dirty ? "有未应用的修改" : "与引擎当前配置一致"}</span><button className="button primary" aria-describedby={draftErrors.length ? "dsp-validation-errors" : undefined} disabled={!draft || busy || draftErrors.length > 0} onClick={() => { if (draft && validateDspDraft(draft).length === 0) void configure(draft); }}>{busy ? "编译中" : "应用参数"}</button></div>}
    </section>
    {editor && draft && <DspModal meta={editor} draft={draft} setDraft={setDraft} onClose={closeEditor}/>}
  </Page>;
}
