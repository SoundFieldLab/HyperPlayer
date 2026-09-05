"use strict";
(() => {
  // src/spatial/layouts.ts
  var TOP_714 = [
    { azimuthDeg: -45, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: 45, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: -135, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: 135, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 }
  ];
  var BOTTOM_714 = [
    { azimuthDeg: -120, elevationDeg: -20, distance: 1.5, gain: 1, size: 0 },
    // BL
    { azimuthDeg: 120, elevationDeg: -20, distance: 1.5, gain: 1, size: 0 }
    // BR
  ];
  var GROUND_714 = [
    { azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: -140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { azimuthDeg: 140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }
  ];
  var LAYOUT_PRESETS = [
    {
      id: "stereo",
      name: "\u7ACB\u4F53\u58F0",
      speakers: [
        { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // L
        { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }
        // R
      ]
    },
    {
      id: "51",
      name: "5.1",
      speakers: [
        { azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // C
        { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // FL
        { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // FR
        { azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // SL
        { azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }
        // SR
      ]
    },
    {
      id: "514",
      name: "5.1.4",
      // 9 只：5 地面（同 5.1 表）+ 4 顶置；heightLayer 关闭后过滤顶置 = 5.1
      speakers: [
        { azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // C
        { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // FL
        { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // FR
        { azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // SL
        { azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        // SR
        ...TOP_714
      ]
    },
    {
      id: "71",
      name: "7.1",
      // 7 地面（与 714 地面层同表：C/FL/FR/SL/SR/RL/RR），无顶置/底部层
      speakers: [...GROUND_714]
    },
    {
      id: "714",
      name: "7.1.4",
      // 13 只：7 地面 + 4 顶置 + 2 底部仰角层（顺序即声道表：地面 0-6、顶置 7-10、底部 11-12）
      speakers: [...GROUND_714, ...TOP_714, ...BOTTOM_714]
    }
  ];
  function presetById(id) {
    const found = LAYOUT_PRESETS.find((p) => p.id === id);
    return found ?? LAYOUT_PRESETS[1];
  }
  function createLayoutSpeakers(layout) {
    return presetById(layout).speakers.map((s) => ({ ...s }));
  }
  function headLockedSpeakers(p) {
    if (p.layout !== "custom") {
      const preset = presetById(p.layout);
      let src = preset.speakers;
      if (p.layout === "714" || p.layout === "514") {
        if (!p.heightLayer) src = src.filter((s) => !TOP_714.includes(s));
      }
      if (p.layout === "714") {
        if (p.bottomLayer === false) src = src.filter((s) => !BOTTOM_714.includes(s));
      }
      return src.map((s) => ({ ...s }));
    }
    if (p.speakers.length === 0) return createLayoutSpeakers("51");
    return p.speakers;
  }
  function multichannelSpeakers(channelCount) {
    const count = Math.min(8, Math.max(3, Math.floor(channelCount)));
    const directions = [
      { azimuthDeg: -30, gain: 1 },
      { azimuthDeg: 30, gain: 1 },
      { azimuthDeg: 0, gain: 1 },
      { azimuthDeg: 0, gain: 0 },
      { azimuthDeg: -110, gain: 1 },
      { azimuthDeg: 110, gain: 1 },
      { azimuthDeg: -150, gain: 1 },
      { azimuthDeg: 150, gain: 1 }
    ];
    const speakers = [];
    for (let channel = 0; channel < count; channel++) {
      const direction = directions[channel];
      speakers.push({
        channel,
        azimuthDeg: direction.azimuthDeg,
        elevationDeg: 0,
        distance: 1.5,
        gain: direction.gain,
        size: 0
      });
    }
    return speakers;
  }

  // src/spatial/types.ts
  function createDefaultSpatialParams() {
    return {
      mode: "off",
      // 默认输出双耳 HRTF 渲染（stereo 干声直通 / multichannel 后续 wave，见 fusion 输出模式分支）
      output: "binaural",
      // 默认 FFT 分区卷积（time 时域直接卷积可经设置弹窗切换，后端契约 spatial_set_convolution_mode）
      convolution: "partitioned",
      // 默认平衡档（quality 球谐插值 / balanced·lowLatency 最近邻，fusion 按此映射 hrtfInterp）
      perfMode: "balanced",
      masterGain: 0.9,
      instant: { spreadDeg: 60, amount: 0.7, room: "studio", roomAmount: 0.15, multichannelAuto: false },
      // 默认 5.1 布局，speakers 取 51 预设副本（与 layouts.ts 单事实源一致）；
      // routes 空数组 = 全按方位角就近路由（行为不回归）
      headLocked: { layout: "51", speakers: createLayoutSpeakers("51"), heightLayer: true, bottomLayer: true, routes: [] },
      // 模式 C 默认：听者立于原点前方 1.6m 高朝 +Z；4 个演示声源——
      //   人声   (-2, 1.6, 4)  左前近场
      //   吉他   (-5, 1.6, 6)  左前远场
      //   鼓组   ( 3, 1.6, 7)  右前远场
      //   环境声 ( 0, 2.5,10)  正前高空（扩散：size 0.5、增益 0.6）
      world: {
        moveSpeed: 2,
        listener: { position: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0 },
        sources: [
          { id: "vocal", position: { x: -2, y: 1.6, z: 4 }, gain: 1, size: 0 },
          { id: "guitar", position: { x: -5, y: 1.6, z: 6 }, gain: 1, size: 0 },
          { id: "drums", position: { x: 3, y: 1.6, z: 7 }, gain: 1, size: 0 },
          { id: "ambience", position: { x: 0, y: 2.5, z: 10 }, gain: 0.6, size: 0.5 }
        ],
        // 播放时钟默认 0 秒、无轨迹（声源静止于 sources 静态位置，行为不回归）、无遮挡
        playhead: 0,
        trajectories: [],
        occlusion: 0
      },
      stage: { preset: "stage", seat: "middle", roomSize: 1, reverbAmount: 0.35, customSources: [] },
      // 自定义附加声源默认空（不附加，行为不回归）
      // 环境声默认关闭（不影响既有空间化行为），开启后默认混合 30%
      ambience: { enabled: false, amount: 0.3 }
      // 多声道物理输出声道数缺省不设置（可选字段）：fusion 按布局类型推导
      // （5.1/其它 → 6、7.1.4 → 8），显式设置 6|8 时优先于推导
      // sinkId 同样缺省不设置（可选字段）：undefined = 系统默认输出设备，
      // 仅用户经设置弹窗切换输出设备后写入（随快照持久化，attach 时自动恢复）
    };
  }
  function instantSpeakers(p) {
    const half = Math.min(60, Math.max(10, p.spreadDeg / 2));
    return [
      { channel: 0, azimuthDeg: -half, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 1, azimuthDeg: half, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }
    ];
  }

  // src/types.ts
  function createDefaultSpatialSettings() {
    const p = createDefaultSpatialParams();
    return {
      mode: p.mode,
      masterGain: p.masterGain,
      instant: p.instant,
      headLocked: p.headLocked,
      world: p.world,
      stage: p.stage,
      ambience: p.ambience,
      convolution: p.convolution,
      hrtfInterp: p.perfMode === "quality" ? "spherical" : "nearest",
      distanceModel: "inverse",
      refDistance: 1,
      maxDistance: 50
    };
  }
  function createDefaultParams(sampleRate2) {
    return {
      sampleRate: sampleRate2,
      eq: {
        enabled: true,
        mode: "pro",
        simpleBands: [0, 0, 0, 0, 0],
        proBands: PRO_EQ_DEFAULT_BANDS.map((f) => ({ frequency: f, gain: 0, q: 1.1 })),
        bandCount: 10,
        qCompensation: true,
        locked: false
      },
      deesser: { enabled: false, centerHz: 6e3, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1, sidechainEnabled: false },
      compressor: { enabled: false, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1, sidechainEnabled: false },
      nightMode: { enabled: false, amount: 0 },
      bassEnhancer: { enabled: false, cutoffHz: 90, q: 0.7, harmonicType: "odd", harmonicGain: 0.6, mix: 0.5, levelDb: 0, lowBoostDb: 0 },
      reverb: {
        enabled: false,
        mode: "algorithmic",
        algorithmic: { type: "hall", roomSize: 0.5, damping: 0.5, wet: 0.3, dry: 0.7, preDelayMs: 0, width: 1 },
        convolution: { ir: null, irName: null, mix: 0.3, preDelayMs: 0, dePeriodize: true }
      },
      surround3d: { enabled: false, distance: 0.5, speed: 1, angle: 0, direction: 1 },
      loudnessCompensation: { enabled: false, mode: "auto", preset: "flat", bands: [], volumePercent: 80, maxBoostDb: 12, smoothingSeconds: 0.2 },
      loudnessNormalization: { enabled: false, targetLufs: -14, maxGainDb: 9, minGainDb: -9, useRealtimeMeter: true, externalGainDb: 0 },
      limiter: { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true },
      ieq: { enabled: false, strength: 0.5, targetCurve: "flat", timeConstantSec: 3 },
      dynamicEq: {
        enabled: false,
        strength: 0.5,
        thresholdDb: -20,
        ratio: 2,
        attackMs: 20,
        releaseMs: 200,
        bands: [0, 1, 2, 3, 4].map(() => ({ enabled: true, targetGainDb: 0 }))
      },
      pitch: { enabled: false, semitones: 0, rate: 1, voiceBalance: 0 },
      modulation: {
        enabled: false,
        lfo: { enabled: false, shape: "sine", rateHz: 1, depth: 0.5 },
        envelope: { enabled: false, attackMs: 10, releaseMs: 200, amount: 0.5 },
        routes: []
      },
      modEffects: {
        delay: { enabled: false, delayMs: 250, feedback: 0.3, mix: 0.3 },
        chorus: { enabled: false, rateHz: 1, depthMs: 3, mix: 0.4 },
        flanger: { enabled: false, rateHz: 0.5, depthMs: 2, feedback: 0.4, mix: 0.5 },
        phaser: { enabled: false, rateHz: 0.5, depth: 0.5, feedback: 0.4, mix: 0.5, stages: 4 },
        tremolo: { enabled: false, rateHz: 5, depth: 0.5, mix: 1 }
      },
      hearing: { enabled: false },
      spatial: createDefaultSpatialSettings(),
      stereoWidth: 1,
      sceneId: null,
      customized: false
    };
  }
  var SIMPLE_EQ_FREQUENCIES = [80, 250, 1e3, 4e3, 12e3];
  var PRO_EQ_DEFAULT_BANDS = [31.5, 63, 125, 250, 500, 1e3, 2e3, 4e3, 8e3, 16e3];
  var PRO_EQ_20_BANDS = [20, 31.5, 50, 63, 100, 125, 200, 250, 400, 500, 800, 1e3, 1600, 2e3, 3200, 4e3, 6300, 8e3, 12500, 16e3, 2e4].slice(0, 20);

  // src/dsp/biquad.ts
  function designBiquad(type, f0, q, gainDb, fs) {
    if (!(fs > 0)) throw new Error("invalid sample rate");
    const nyq = fs / 2;
    const f = Math.min(Math.max(f0, 10), nyq * (1 - 1e-9));
    const qq = Math.max(q, 1e-6);
    const g = Math.min(Math.max(gainDb, -60), 60);
    const w0 = 2 * Math.PI * f / fs;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    const alpha = sinw / (2 * qq);
    let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (type) {
      case "lowpass":
        b0 = (1 - cosw) / 2;
        b1 = 1 - cosw;
        b2 = (1 - cosw) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
        break;
      case "highpass":
        b0 = (1 + cosw) / 2;
        b1 = -(1 + cosw);
        b2 = (1 + cosw) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
        break;
      case "bandpass": {
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
        break;
      }
      case "notch":
        b0 = 1;
        b1 = -2 * cosw;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
        break;
      case "allpass":
        b0 = 1 - alpha;
        b1 = -2 * cosw;
        b2 = 1 + alpha;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
        break;
      case "peaking": {
        const A = Math.pow(10, g / 40);
        b0 = 1 + alpha * A;
        b1 = -2 * cosw;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cosw;
        a2 = 1 - alpha / A;
        break;
      }
      case "lowshelf": {
        const A = Math.pow(10, g / 40);
        const ashelf = sinw / 2 * Math.SQRT2;
        const sqA = Math.sqrt(A);
        b0 = A * (A + 1 - (A - 1) * cosw + 2 * sqA * ashelf);
        b1 = 2 * A * (A - 1 - (A + 1) * cosw);
        b2 = A * (A + 1 - (A - 1) * cosw - 2 * sqA * ashelf);
        a0 = A + 1 + (A - 1) * cosw + 2 * sqA * ashelf;
        a1 = -2 * (A - 1 + (A + 1) * cosw);
        a2 = A + 1 + (A - 1) * cosw - 2 * sqA * ashelf;
        break;
      }
      case "highshelf": {
        const A = Math.pow(10, g / 40);
        const ashelf = sinw / 2 * Math.SQRT2;
        const sqA = Math.sqrt(A);
        b0 = A * (A + 1 + (A - 1) * cosw + 2 * sqA * ashelf);
        b1 = -2 * A * (A - 1 + (A + 1) * cosw);
        b2 = A * (A + 1 + (A - 1) * cosw - 2 * sqA * ashelf);
        a0 = A + 1 - (A - 1) * cosw + 2 * sqA * ashelf;
        a1 = 2 * (A - 1 - (A + 1) * cosw);
        a2 = A + 1 - (A - 1) * cosw - 2 * sqA * ashelf;
        break;
      }
    }
    if (!(a0 > 0) || !Number.isFinite(a0)) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    const inv = 1 / a0;
    return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1 * inv, a2: a2 * inv };
  }
  var Biquad = class {
    b0 = 1;
    b1 = 0;
    b2 = 0;
    a1 = 0;
    a2 = 0;
    /** TDF2 状态（双精度） */
    s1 = 0;
    s2 = 0;
    fs;
    constructor(type, f0, q, gainDb, fs) {
      const rate = fs ?? 48e3;
      if (!(rate > 0)) throw new Error("invalid sample rate");
      this.fs = rate;
      this.reset();
      if (type !== void 0) {
        this.setParams(type, f0 ?? 1e3, q ?? 1, gainDb ?? 0);
      }
    }
    setCoeffs(c) {
      this.b0 = c.b0;
      this.b1 = c.b1;
      this.b2 = c.b2;
      this.a1 = c.a1;
      this.a2 = c.a2;
    }
    /** 按 RBJ 公式重算系数（参数更新即时生效，状态保留） */
    setParams(type, f0, q, gainDb) {
      this.setCoeffs(designBiquad(type, f0, q, gainDb, this.fs));
    }
    /** TDF2 处理单样本，返回 y（转置直接 II 型：状态转移在输出之后） */
    process(x) {
      const y = this.b0 * x + this.s1;
      this.s1 = this.b1 * x - this.a1 * y + this.s2;
      this.s2 = this.b2 * x - this.a2 * y;
      return y;
    }
    processBlock(input, output, frameCount) {
      if (input.length !== output.length) throw new Error("biquad: input/output length mismatch");
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? input.length), input.length, output.length));
      const { b0, b1, b2, a1, a2 } = this;
      let s1 = this.s1;
      let s2 = this.s2;
      for (let i = 0; i < n; i++) {
        const x = input[i];
        const y = b0 * x + s1;
        s1 = b1 * x - a1 * y + s2;
        s2 = b2 * x - a2 * y;
        output[i] = y;
      }
      this.s1 = s1;
      this.s2 = s2;
    }
    reset() {
      this.s1 = 0;
      this.s2 = 0;
    }
    /** 在给定频率处求 |H(e^{jw})|（线性幅度，单位增益），用于级联响应测量 */
    magnitudeAt(freqHz, fs) {
      if (!(fs > 0)) throw new Error("invalid sample rate");
      const f = Math.min(Math.max(freqHz, 1e-6), fs / 2 * (1 - 1e-9));
      const w = 2 * Math.PI * f / fs;
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      const c2w = Math.cos(2 * w);
      const s2w = Math.sin(2 * w);
      const br = this.b0 + this.b1 * cw + this.b2 * c2w;
      const bi = -(this.b1 * sw + this.b2 * s2w);
      const ar = 1 + this.a1 * cw + this.a2 * c2w;
      const ai = -(this.a1 * sw + this.a2 * s2w);
      return Math.hypot(br, bi) / Math.hypot(ar, ai);
    }
  };

  // src/dsp/EqChain.ts
  var GAIN_MIN_DB = -24;
  var GAIN_MAX_DB = 24;
  var Q_MIN = 0.1;
  var Q_MAX = 18;
  var EqChain = class {
    fs;
    bandCount;
    biquads;
    /** 当前频段参数（gains 为补偿后的实际增益；userGains 为用户目标，补偿基准不变） */
    freqs;
    gains;
    userGains;
    qs;
    /** 用户实际设置的段数（<=bandCount）；超出部分为直通填充，不参与补偿 */
    activeCount = 0;
    qCompensationEnabled = false;
    constructor(fs, bandCount) {
      if (!(fs > 0)) throw new Error("invalid sample rate");
      this.fs = fs;
      this.bandCount = Math.max(1, Math.floor(bandCount ?? 20));
      this.biquads = [];
      for (let i = 0; i < this.bandCount; i++) this.biquads.push(new Biquad("peaking", 1e3, 1, 0, fs));
      this.freqs = new Float64Array(this.bandCount);
      this.gains = new Float64Array(this.bandCount);
      this.userGains = new Float64Array(this.bandCount);
      this.qs = new Float64Array(this.bandCount);
      for (let i = 0; i < this.bandCount; i++) {
        this.freqs[i] = 1e3;
        this.gains[i] = 0;
        this.userGains[i] = 0;
        this.qs[i] = 1;
      }
    }
    /** 设置频段并重算系数；若 qCompensation 开启则先做补偿迭代 */
    setBands(bands) {
      const n = this.bandCount;
      const fmax = Math.min(2e4, this.fs / 2 * 0.999);
      for (let i = 0; i < n; i++) {
        const b = bands[i];
        if (b !== void 0) {
          this.freqs[i] = Math.min(Math.max(b.frequency, 20), fmax);
          this.userGains[i] = Math.min(Math.max(b.gain, GAIN_MIN_DB), GAIN_MAX_DB);
          this.gains[i] = this.userGains[i];
          this.qs[i] = Math.min(Math.max(b.q, Q_MIN), Q_MAX);
        } else {
          this.freqs[i] = 1e3;
          this.userGains[i] = 0;
          this.gains[i] = 0;
          this.qs[i] = 1;
        }
      }
      this.activeCount = Math.min(bands.length, this.bandCount);
      if (this.qCompensationEnabled) this.compensate();
      this.updateCoeffs();
    }
    setQCompensation(enabled) {
      if (this.qCompensationEnabled === enabled) return;
      this.qCompensationEnabled = enabled;
      if (enabled) {
        this.compensate();
        this.updateCoeffs();
      }
    }
    /**
     * Q 补偿（自研，API_SPEC 模块 3；Gauss-Seidel 式逐段迭代保证收敛）：
     * ① 用当前 bands 在各自中心频率处测级联响应（线性幅度 → dB）；
     * ② 误差 errDb_i = 目标(dB) − 实测(dB) = 20·log10(用户目标线性 / 实测线性)，
     *    其中"目标"为用户设定的段增益（固定不变，见 userGains）；
     * ③ gain_i ← gain_i + 0.8·errDb_i（0.8 为阻尼系数，防相邻段叠加导致振荡），
     *    每修正一段立即重算该段系数（Gauss-Seidel：后面的段直接看到前面的修正）；
     *    迭代直到最大误差 <0.05dB 或达 5 次。
     * 说明：相邻段耦合可达 0.5dB/dB，若全部段同时按 Jacobi 方式修正会发散，
     * 故采用逐段顺序修正（实测相邻 +6dB 场景收敛后控制点误差 <0.02dB）。
     * 结果仍存回内部增益与系数（补偿只在此处与 setQCompensation(true) 时进行）。
     */
    compensate() {
      const n = this.bandCount;
      const m0 = this.activeCount;
      this.updateCoeffs();
      for (let iter = 0; iter < 5; iter++) {
        let maxErrDb = 0;
        for (let i = 0; i < m0; i++) {
          let mag = 1;
          for (let j = 0; j < n; j++) {
            mag *= this.biquads[j].magnitudeAt(this.freqs[i], this.fs);
          }
          const target = Math.pow(10, this.userGains[i] / 20);
          const m = Math.max(mag, 1e-12);
          const errDb = 20 * Math.log10(target / m);
          this.gains[i] = Math.min(Math.max(this.gains[i] + 0.8 * errDb, GAIN_MIN_DB), GAIN_MAX_DB);
          this.biquads[i].setParams("peaking", this.freqs[i], this.qs[i], this.gains[i]);
          const a = Math.abs(errDb);
          if (a > maxErrDb) maxErrDb = a;
        }
        if (maxErrDb < 0.05) break;
      }
    }
    updateCoeffs() {
      const n = this.bandCount;
      for (let i = 0; i < n; i++) {
        this.biquads[i].setParams("peaking", this.freqs[i], this.qs[i], this.gains[i]);
      }
    }
    /** 级联幅频响应测量：返回各控制频率处的线性幅度（对应传入频率点） */
    responseAt(freqs) {
      const out = new Float32Array(freqs.length);
      const n = this.bandCount;
      for (let i = 0; i < freqs.length; i++) {
        let mag = 1;
        for (let j = 0; j < n; j++) {
          mag *= this.biquads[j].magnitudeAt(freqs[i], this.fs);
        }
        out[i] = mag;
      }
      return out;
    }
    /** 单样本级联处理（20 段 peaking 串联） */
    process(x) {
      let y = x;
      for (let i = 0; i < this.bandCount; i++) y = this.biquads[i].process(y);
      return y;
    }
    processBlock(input, output, frameCount) {
      if (input.length !== output.length) throw new Error("eqchain: input/output length mismatch");
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? input.length), input.length, output.length));
      if (input === output) {
        for (let i = 0; i < this.bandCount; i++) this.biquads[i].processBlock(input, input, n);
        return;
      }
      this.biquads[0].processBlock(input, output, n);
      for (let i = 1; i < this.bandCount; i++) this.biquads[i].processBlock(output, output, n);
    }
    /** 就地处理立体声（左右声道共享同一滤波器状态） */
    processStereo(l, r, frameCount) {
      if (l.length !== r.length) throw new Error("eqchain: L/R length mismatch");
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      this.processBlock(l, l, n);
      this.processBlock(r, r, n);
    }
    reset() {
      for (let i = 0; i < this.bandCount; i++) this.biquads[i].reset();
    }
  };

  // src/dsp/MidSide.ts
  var MidSide = class {
    midGain = 1;
    sideGain = 1;
    constructor() {
    }
    /** width 0..2（1=原始），voiceBalance -1..1（-1=仅伴奏 / +1=仅人声） */
    setParams(width, voiceBalance) {
      const w = Math.min(Math.max(width, 0), 2);
      const vb = Math.min(Math.max(voiceBalance, -1), 1);
      const mg = 1 + Math.min(0, vb);
      const sg = w * (1 - Math.max(0, vb));
      this.midGain = mg;
      this.sideGain = sg;
    }
    /** 就地 M/S 编解码：输入立体声，输出处理后的立体声（M/S 域增益 → 反变换） */
    processStereo(l, r, frameCount) {
      if (l.length !== r.length) throw new Error("midside: L/R length mismatch");
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const mg = this.midGain;
      const sg = this.sideGain;
      for (let i = 0; i < n; i++) {
        const li = l[i];
        const ri = r[i];
        const m = (li + ri) * 0.5;
        const s = (li - ri) * 0.5;
        l[i] = m * mg + s * sg;
        r[i] = m * mg - s * sg;
      }
    }
    /** 无内部状态，保留接口一致性 */
    reset() {
    }
  };

  // src/dsp/Deesser.ts
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function onePoleCoef(timeMs, fs, floorMs) {
    const ms = Math.max(timeMs, floorMs);
    return 1 - Math.exp(-1 / (ms / 1e3 * fs));
  }
  var Deesser = class {
    fs;
    enabled = true;
    centerHz = 6e3;
    q = 0.7;
    thresholdDb = -30;
    ratio = 8;
    splitBand = true;
    mix = 1;
    attackCoef = 0;
    releaseCoef = 0;
    env = 0;
    bp = new Biquad();
    // Linkwitz-Riley 4 阶交叉：每通道 2 级 LP + 2 级 HP（Q=0.7071）
    lpL1 = new Biquad();
    lpL2 = new Biquad();
    lpR1 = new Biquad();
    lpR2 = new Biquad();
    hpL1 = new Biquad();
    hpL2 = new Biquad();
    hpR1 = new Biquad();
    hpR2 = new Biquad();
    constructor(fs) {
      if (!(fs > 0) || !Number.isFinite(fs)) throw new Error("invalid sample rate");
      this.fs = fs;
      this.applyParams({ enabled: true, centerHz: 6e3, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1 });
    }
    setParams(p) {
      this.applyParams(p);
    }
    /** 参数即时生效：钳制 + 系数重算；包络状态保留（避免参数变化时爆音） */
    applyParams(p) {
      this.enabled = p.enabled;
      this.centerHz = clamp(p.centerHz, 100, this.fs * 0.45);
      this.q = clamp(p.q, 0.1, 20);
      this.thresholdDb = clamp(p.thresholdDb, -80, 0);
      this.ratio = clamp(p.ratio, 1, 100);
      this.splitBand = p.splitBand;
      this.mix = clamp(p.mix, 0, 1);
      this.attackCoef = onePoleCoef(p.attackMs, this.fs, 0.05);
      this.releaseCoef = onePoleCoef(p.releaseMs, this.fs, 1);
      this.bp.setParams("bandpass", this.centerHz, this.q, 0);
      const xo = clamp(this.centerHz * 0.6, 2500, this.fs * 0.45);
      this.lpL1.setParams("lowpass", xo, 0.7071, 0);
      this.lpL2.setParams("lowpass", xo, 0.7071, 0);
      this.lpR1.setParams("lowpass", xo, 0.7071, 0);
      this.lpR2.setParams("lowpass", xo, 0.7071, 0);
      this.hpL1.setParams("highpass", xo, 0.7071, 0);
      this.hpL2.setParams("highpass", xo, 0.7071, 0);
      this.hpR1.setParams("highpass", xo, 0.7071, 0);
      this.hpR2.setParams("highpass", xo, 0.7071, 0);
    }
    /** 就地处理立体声（l/r 原地改写） */
    processStereo(l, r, sideL, sideR, frameCount) {
      if (!this.enabled) return;
      const useSide = sideL !== void 0 && sideR !== void 0;
      const n = Math.max(0, Math.min(
        Math.floor(frameCount ?? l.length),
        l.length,
        r.length,
        useSide ? sideL.length : Infinity,
        useSide ? sideR.length : Infinity
      ));
      const attack = this.attackCoef;
      const release = this.releaseCoef;
      const thresholdDb = this.thresholdDb;
      const invRatio = 1 - 1 / this.ratio;
      const mix = this.mix;
      const split = this.splitBand;
      for (let i = 0; i < n; i++) {
        const xl = l[i];
        const xr = r[i];
        const dl = useSide ? sideL[i] : xl;
        const dr = useSide ? sideR[i] : xr;
        const s = this.bp.process(0.5 * (dl + dr));
        const p = s * s;
        if (p > this.env) this.env += attack * (p - this.env);
        else this.env += release * (p - this.env);
        const levelDb = 10 * Math.log10(this.env + 1e-12);
        const over = levelDb - thresholdDb;
        const reduction = over > 0 ? over * invRatio : 0;
        const g = Math.pow(10, -reduction / 20);
        if (split) {
          const lowL = this.lpL2.process(this.lpL1.process(xl));
          const lowR = this.lpR2.process(this.lpR1.process(xr));
          const highL = this.hpL2.process(this.hpL1.process(xl));
          const highR = this.hpR2.process(this.hpR1.process(xr));
          const outL = lowL + g * highL;
          const outR = lowR + g * highR;
          l[i] = xl + mix * (outL - xl);
          r[i] = xr + mix * (outR - xr);
        } else {
          l[i] = xl + mix * (xl * g - xl);
          r[i] = xr + mix * (xr * g - xr);
        }
      }
    }
    reset() {
      this.env = 0;
      this.bp.reset();
      this.lpL1.reset();
      this.lpL2.reset();
      this.lpR1.reset();
      this.lpR2.reset();
      this.hpL1.reset();
      this.hpL2.reset();
      this.hpR1.reset();
      this.hpR2.reset();
    }
  };

  // src/dsp/Compressor.ts
  function clamp2(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function onePoleCoef2(timeMs, fs, floorMs) {
    const ms = Math.max(timeMs, floorMs);
    return 1 - Math.exp(-1 / (ms / 1e3 * fs));
  }
  var Compressor = class {
    fs;
    enabled = true;
    thresholdDb = -20;
    ratio = 4;
    kneeDb = 6;
    attackCoef = 0;
    releaseCoef = 0;
    makeupLin = 1;
    outputGain = 1;
    env = 0;
    reductionDb = 0;
    constructor(fs) {
      if (!(fs > 0) || !Number.isFinite(fs)) throw new Error("invalid sample rate");
      this.fs = fs;
      this.applyParams({ enabled: true, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1 });
    }
    setParams(p) {
      this.applyParams(p);
    }
    /** 参数即时生效：钳制 + 系数重算；包络状态保留（避免参数变化时爆音） */
    applyParams(p) {
      this.enabled = p.enabled;
      this.thresholdDb = clamp2(p.thresholdDb, -80, 0);
      this.ratio = clamp2(p.ratio, 1, 100);
      this.kneeDb = clamp2(p.kneeDb, 0, 40);
      this.attackCoef = onePoleCoef2(p.attackMs, this.fs, 0.05);
      this.releaseCoef = onePoleCoef2(p.releaseMs, this.fs, 0.05);
      this.makeupLin = Math.pow(10, clamp2(p.makeupDb, -24, 24) / 20);
      this.outputGain = clamp2(p.outputGain, 0, 2);
    }
    /** 就地处理立体声（l/r 原地改写）；传入 sideL/sideR 时用外部 sidechain 驱动包络 */
    processStereo(l, r, sideL, sideR, frameCount) {
      if (!this.enabled) {
        this.reductionDb = 0;
        return;
      }
      const useSide = sideL !== void 0 && sideR !== void 0;
      const n = Math.max(0, Math.min(
        Math.floor(frameCount ?? l.length),
        l.length,
        r.length,
        useSide ? sideL.length : Infinity,
        useSide ? sideR.length : Infinity
      ));
      const attack = this.attackCoef;
      const release = this.releaseCoef;
      const thr = this.thresholdDb;
      const ratio = this.ratio;
      const knee = this.kneeDb;
      const invRatio = 1 - 1 / ratio;
      const kneeHalf = knee * 0.5;
      const twoKnee = 2 * knee;
      const gainScale = this.makeupLin * this.outputGain;
      for (let i = 0; i < n; i++) {
        const xl = l[i];
        const xr = r[i];
        let el;
        let er;
        if (useSide) {
          el = sideL[i];
          er = sideR[i];
        } else {
          el = xl;
          er = xr;
        }
        const e = Math.abs(el) > Math.abs(er) ? Math.abs(el) : Math.abs(er);
        if (e > this.env) this.env += attack * (e - this.env);
        else this.env += release * (e - this.env);
        const levelDb = 20 * Math.log10(this.env + 1e-12);
        let reduction;
        if (knee <= 0) {
          reduction = levelDb > thr ? (levelDb - thr) * invRatio : 0;
        } else if (levelDb < thr - kneeHalf) {
          reduction = 0;
        } else if (levelDb > thr + kneeHalf) {
          reduction = (levelDb - thr) * invRatio;
        } else {
          const x = levelDb - (thr - kneeHalf);
          reduction = invRatio * x * x / twoKnee;
        }
        this.reductionDb = -reduction;
        const g = Math.pow(10, -reduction / 20) * gainScale;
        l[i] = xl * g;
        r[i] = xr * g;
      }
    }
    /** 当前增益衰减 dB（<= 0，不含 makeup/outputGain） */
    getReductionDb() {
      return this.reductionDb;
    }
    reset() {
      this.env = 0;
      this.reductionDb = 0;
    }
  };

  // src/dsp/Limiter.ts
  function clamp3(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function onePoleCoef3(timeMs, fs) {
    const ms = Math.max(timeMs, 0.05);
    return 1 - Math.exp(-1 / (ms / 1e3 * fs));
  }
  var Limiter = class {
    fs;
    enabled = true;
    thresholdLin = Math.pow(10, -1 / 20);
    lookahead = 0;
    attackCoef = 0;
    releaseCoef = 0;
    truePeak = false;
    // 延迟线（尺寸 lookahead+1，读取最旧样本 = 延迟 L）
    delayL = new Float32Array(1);
    delayR = new Float32Array(1);
    delayW = 0;
    // 单调递减队列（环形）—— 滑动窗口峰值检测
    qIdx = new Int32Array(8);
    qVal = new Float32Array(8);
    qHead = 0;
    qTail = 0;
    qLen = 0;
    qCap = 8;
    // 真峰值：每通道 8 样本历史（环形）+ 3 相位 × 8 taps 插值系数
    histL = new Float32Array(8);
    histR = new Float32Array(8);
    histW = 0;
    interp = new Float32Array(24);
    gain = 1;
    reductionDb = 0;
    sampleIndex = 0;
    constructor(fs) {
      if (!(fs > 0) || !Number.isFinite(fs)) throw new Error("invalid sample rate");
      this.fs = fs;
      this.applyParams({ enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true });
    }
    setParams(p) {
      this.applyParams(p);
    }
    /** 参数即时生效：钳制 + 系数重算；缓冲尺寸变化或从禁用切回启用时清空管线 */
    applyParams(p) {
      const wasEnabled = this.enabled;
      this.enabled = p.enabled;
      this.thresholdLin = Math.pow(10, clamp3(p.thresholdDb, -60, 0) / 20);
      this.lookahead = Math.max(0, Math.min(Math.round(p.lookaheadMs * this.fs / 1e3), Math.floor(this.fs * 0.1)));
      this.attackCoef = onePoleCoef3(p.attackMs, this.fs);
      this.releaseCoef = onePoleCoef3(p.releaseMs, this.fs);
      this.truePeak = p.truePeak;
      const size = Math.max(this.lookahead + 1, 1);
      const cap = Math.max(this.lookahead + 8, 8);
      if (size !== this.delayL.length || cap !== this.qCap) {
        this.delayL = new Float32Array(size);
        this.delayR = new Float32Array(size);
        this.qIdx = new Int32Array(cap);
        this.qVal = new Float32Array(cap);
        this.qCap = cap;
        this.qHead = 0;
        this.qTail = 0;
        this.qLen = 0;
        this.histL.fill(0);
        this.histR.fill(0);
        this.histW = 0;
        this.gain = 1;
        this.sampleIndex = 0;
        this.reductionDb = 0;
      }
      if (this.enabled && !wasEnabled) {
        this.delayL.fill(0);
        this.delayR.fill(0);
        this.qHead = 0;
        this.qTail = 0;
        this.qLen = 0;
        this.histL.fill(0);
        this.histR.fill(0);
        this.histW = 0;
        this.gain = 1;
        this.sampleIndex = 0;
        this.reductionDb = 0;
      }
      if (this.truePeak) {
        for (let ph = 0; ph < 3; ph++) {
          const frac = (ph + 1) / 4;
          for (let k = -4; k <= 3; k++) {
            const x = frac - k;
            const sx = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            const u = (x + 5) / 10;
            const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
            this.interp[ph * 8 + (k + 4)] = sx * w;
          }
        }
      }
    }
    /** 就地处理立体声（l/r 原地改写）。输出相对输入延迟 lookahead 样本。 */
    processStereo(l, r, frameCount) {
      if (!this.enabled) {
        this.reductionDb = 0;
        return;
      }
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const thr = this.thresholdLin;
      const dsize = this.delayL.length;
      const lookahead = this.lookahead;
      const tp = this.truePeak;
      const attack = this.attackCoef;
      const release = this.releaseCoef;
      const interp = this.interp;
      const histL = this.histL;
      const histR = this.histR;
      const delayL = this.delayL;
      const delayR = this.delayR;
      const qIdx = this.qIdx;
      const qVal = this.qVal;
      const qCap = this.qCap;
      let qHead = this.qHead;
      let qTail = this.qTail;
      let qLen = this.qLen;
      let delayW = this.delayW;
      let histW = this.histW;
      let gain = this.gain;
      let sampleIndex = this.sampleIndex;
      for (let i = 0; i < n; i++) {
        const xl = l[i];
        const xr = r[i];
        const idx = sampleIndex;
        histL[histW] = xl;
        histR[histW] = xr;
        histW = histW + 1 & 7;
        let det;
        if (tp) {
          det = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr);
          if (idx >= 7) {
            const w = histW;
            const i0 = w;
            const i1 = w + 1 & 7;
            const i2 = w + 2 & 7;
            const i3 = w + 3 & 7;
            const i4 = w + 4 & 7;
            const i5 = w + 5 & 7;
            const i6 = w + 6 & 7;
            const i7 = w + 7 & 7;
            const hL0 = histL[i0], hL1 = histL[i1], hL2 = histL[i2], hL3 = histL[i3];
            const hL4 = histL[i4], hL5 = histL[i5], hL6 = histL[i6], hL7 = histL[i7];
            const hR0 = histR[i0], hR1 = histR[i1], hR2 = histR[i2], hR3 = histR[i3];
            const hR4 = histR[i4], hR5 = histR[i5], hR6 = histR[i6], hR7 = histR[i7];
            let vL = 0;
            let vR = 0;
            {
              const sL = interp[0] * hL0 + interp[1] * hL1 + interp[2] * hL2 + interp[3] * hL3 + interp[4] * hL4 + interp[5] * hL5 + interp[6] * hL6 + interp[7] * hL7;
              const sR = interp[0] * hR0 + interp[1] * hR1 + interp[2] * hR2 + interp[3] * hR3 + interp[4] * hR4 + interp[5] * hR5 + interp[6] * hR6 + interp[7] * hR7;
              const aL = Math.abs(sL);
              const aR = Math.abs(sR);
              if (aL > vL) vL = aL;
              if (aR > vR) vR = aR;
            }
            {
              const sL = interp[8] * hL0 + interp[9] * hL1 + interp[10] * (hL2 + hL7) + interp[11] * (hL3 + hL6) + interp[12] * (hL4 + hL5);
              const sR = interp[8] * hR0 + interp[9] * hR1 + interp[10] * (hR2 + hR7) + interp[11] * (hR3 + hR6) + interp[12] * (hR4 + hR5);
              const aL = Math.abs(sL);
              const aR = Math.abs(sR);
              if (aL > vL) vL = aL;
              if (aR > vR) vR = aR;
            }
            {
              const sL = interp[16] * hL0 + interp[17] * hL1 + interp[18] * hL2 + interp[19] * hL3 + interp[20] * hL4 + interp[21] * hL5 + interp[22] * hL6 + interp[23] * hL7;
              const sR = interp[16] * hR0 + interp[17] * hR1 + interp[18] * hR2 + interp[19] * hR3 + interp[20] * hR4 + interp[21] * hR5 + interp[22] * hR6 + interp[23] * hR7;
              const aL = Math.abs(sL);
              const aR = Math.abs(sR);
              if (aL > vL) vL = aL;
              if (aR > vR) vR = aR;
            }
            if (vL > det) det = vL;
            if (vR > det) det = vR;
          }
          const oldest = idx - 3 - lookahead;
          while (qLen > 0 && qIdx[qHead] < oldest) {
            qHead = (qHead + 1) % qCap;
            qLen--;
          }
          const qIdxVal = idx - 3;
          while (qLen > 0) {
            const t = (qTail - 1 + qCap) % qCap;
            if (qVal[t] > det) break;
            qTail = t;
            qLen--;
          }
          qIdx[qTail] = qIdxVal;
          qVal[qTail] = det;
          qTail = (qTail + 1) % qCap;
          qLen++;
        } else {
          det = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr);
          const oldest = idx - lookahead;
          while (qLen > 0 && qIdx[qHead] < oldest) {
            qHead = (qHead + 1) % qCap;
            qLen--;
          }
          while (qLen > 0) {
            const t = (qTail - 1 + qCap) % qCap;
            if (qVal[t] > det) break;
            qTail = t;
            qLen--;
          }
          qIdx[qTail] = idx;
          qVal[qTail] = det;
          qTail = (qTail + 1) % qCap;
          qLen++;
        }
        delayL[delayW] = xl;
        delayR[delayW] = xr;
        delayW++;
        if (delayW >= dsize) delayW = 0;
        const peak = qLen > 0 ? qVal[qHead] : 0;
        const target = Math.min(1, thr / Math.max(peak, 1e-12));
        if (target < gain) gain += attack * (target - gain);
        else gain += release * (target - gain);
        l[i] = delayL[delayW] * gain;
        r[i] = delayR[delayW] * gain;
        sampleIndex++;
      }
      this.delayW = delayW;
      this.qHead = qHead;
      this.qTail = qTail;
      this.qLen = qLen;
      this.histW = histW;
      this.gain = gain;
      this.sampleIndex = sampleIndex;
      this.reductionDb = 20 * Math.log10(gain);
    }
    /** 当前增益衰减 dB（<= 0） */
    getReductionDb() {
      return this.reductionDb;
    }
    /** 引入的延迟（样本数）= lookahead 样本 */
    getLatencySamples() {
      return this.lookahead;
    }
    reset() {
      this.delayL.fill(0);
      this.delayR.fill(0);
      this.delayW = 0;
      this.qHead = 0;
      this.qTail = 0;
      this.qLen = 0;
      this.histL.fill(0);
      this.histR.fill(0);
      this.histW = 0;
      this.gain = 1;
      this.reductionDb = 0;
      this.sampleIndex = 0;
    }
  };

  // src/dsp/BassEnhancer.ts
  function clamp4(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  var BassEnhancer = class {
    fs;
    enabled = true;
    cutoffHz = 90;
    q = 0.7;
    harmonicType = "odd";
    harmonicGain = 0.6;
    mix = 0.5;
    levelLin = 1;
    lowBoostDb = 0;
    lowLin = 0;
    // 10^(lowBoostDb/20) − 1，低频带混回增益（真实能量提升）
    lpL = new Biquad();
    lpR = new Biquad();
    hpL = new Biquad();
    hpR = new Biquad();
    constructor(fs) {
      if (!(fs > 0) || !Number.isFinite(fs)) throw new Error("invalid sample rate");
      this.fs = fs;
      this.applyParams({ enabled: true, cutoffHz: 90, q: 0.7, harmonicType: "odd", harmonicGain: 0.6, mix: 0.5, levelDb: 0 });
    }
    setParams(p) {
      this.applyParams(p);
    }
    /** 参数即时生效：钳制 + 系数重算 */
    applyParams(p) {
      this.enabled = p.enabled;
      this.cutoffHz = clamp4(p.cutoffHz, 20, this.fs * 0.45);
      this.q = clamp4(p.q, 0.1, 20);
      this.harmonicType = p.harmonicType;
      this.harmonicGain = clamp4(p.harmonicGain, 0, 1);
      this.mix = clamp4(p.mix, 0, 1);
      this.levelLin = Math.pow(10, clamp4(p.levelDb, -6, 6) / 20);
      const lb = p.lowBoostDb;
      this.lowBoostDb = clamp4(typeof lb === "number" && Number.isFinite(lb) ? lb : 0, -6, 12);
      this.lowLin = Math.pow(10, this.lowBoostDb / 20) - 1;
      const hpCut = clamp4(Math.max(150, this.cutoffHz * 1.5), 20, this.fs * 0.45);
      this.lpL.setParams("lowpass", this.cutoffHz, this.q, 0);
      this.lpR.setParams("lowpass", this.cutoffHz, this.q, 0);
      this.hpL.setParams("highpass", hpCut, 0.707, 0);
      this.hpR.setParams("highpass", hpCut, 0.707, 0);
    }
    /** 谐波非线性函数（仅作用于低频带，避免全频互调） */
    nonlinearity(x) {
      switch (this.harmonicType) {
        case "odd":
          return x * x * x;
        case "even":
          return Math.abs(x);
        case "atan":
          return Math.atan(Math.sqrt(Math.abs(x))) * Math.sign(x);
        case "soft":
          return Math.tanh(2 * x);
        default:
          return x * x * x;
      }
    }
    /** 就地处理立体声（l/r 原地改写） */
    processStereo(l, r, frameCount) {
      if (!this.enabled) return;
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const k = this.mix * this.harmonicGain * this.levelLin;
      const low = this.lowLin;
      for (let i = 0; i < n; i++) {
        const xl = l[i];
        const xr = r[i];
        const bl = this.lpL.process(xl);
        const br = this.lpR.process(xr);
        const hl = this.hpL.process(this.nonlinearity(bl));
        const hr = this.hpR.process(this.nonlinearity(br));
        l[i] = xl + k * hl + low * bl;
        r[i] = xr + k * hr + low * br;
      }
    }
    reset() {
      this.lpL.reset();
      this.lpR.reset();
      this.hpL.reset();
      this.hpR.reset();
    }
  };

  // src/dsp/fft.ts
  var twiddleCache = /* @__PURE__ */ new Map();
  function getTwiddles(n) {
    let stages = twiddleCache.get(n);
    if (stages !== void 0) return stages;
    stages = [];
    for (let len = 4; len <= n; len <<= 2) {
      const quarter = len >> 2;
      const t = new Float64Array(quarter * 6);
      const step = 2 * Math.PI / len;
      for (let k = 0; k < quarter; k++) {
        const th = step * k;
        const o = k * 6;
        t[o] = Math.cos(th);
        t[o + 1] = Math.sin(th);
        const th2 = 2 * th;
        t[o + 2] = Math.cos(th2);
        t[o + 3] = Math.sin(th2);
        const th3 = 3 * th;
        t[o + 4] = Math.cos(th3);
        t[o + 5] = Math.sin(th3);
      }
      stages.push(t);
    }
    const m = 31 - Math.clz32(n);
    if ((m & 1) !== 0) {
      const half = n >> 1;
      const t = new Float64Array(half * 2);
      const step = 2 * Math.PI / n;
      for (let k = 0; k < half; k++) {
        t[2 * k] = Math.cos(step * k);
        t[2 * k + 1] = Math.sin(step * k);
      }
      stages.push(t);
    }
    twiddleCache.set(n, stages);
    return stages;
  }
  function fft(real, imag, inverse) {
    const n = real.length;
    if (n !== imag.length) throw new Error("fft: real/imag length mismatch");
    if (n === 0 || (n & n - 1) !== 0) throw new Error("fft: length must be a power of two");
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = real[i];
        real[i] = real[j];
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j];
        imag[j] = ti;
      }
    }
    const sign = inverse ? 1 : -1;
    const jSign = inverse ? -1 : 1;
    const m = 31 - Math.clz32(n);
    const stages = getTwiddles(n);
    let stageIdx = 0;
    for (let len = 4; len <= n; len <<= 2) {
      const quarter = len >> 2;
      const t = stages[stageIdx++];
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < quarter; k++) {
          const o = 6 * k;
          const w1r = t[o + 2];
          const w1i = sign * t[o + 3];
          const w2r = t[o];
          const w2i = sign * t[o + 1];
          const w3r = t[o + 4];
          const w3i = sign * t[o + 5];
          const a0 = i + k;
          const a1 = a0 + quarter;
          const a2 = a1 + quarter;
          const a3 = a2 + quarter;
          const x0r = real[a0];
          const x0i = imag[a0];
          const x1r = real[a1];
          const x1i = imag[a1];
          const x2r = real[a2];
          const x2i = imag[a2];
          const x3r = real[a3];
          const x3i = imag[a3];
          const t1r = w1r * x1r - w1i * x1i;
          const t1i = w1r * x1i + w1i * x1r;
          const t2r = w2r * x2r - w2i * x2i;
          const t2i = w2r * x2i + w2i * x2r;
          const t3r = w3r * x3r - w3i * x3i;
          const t3i = w3r * x3i + w3i * x3r;
          const A0r = x0r + t1r;
          const A0i = x0i + t1i;
          const A1r = x0r - t1r;
          const A1i = x0i - t1i;
          const B0r = t2r + t3r;
          const B0i = t2i + t3i;
          const B1r = t2r - t3r;
          const B1i = t2i - t3i;
          real[a0] = A0r + B0r;
          imag[a0] = A0i + B0i;
          real[a1] = A1r + jSign * B1i;
          imag[a1] = A1i - jSign * B1r;
          real[a2] = A0r - B0r;
          imag[a2] = A0i - B0i;
          real[a3] = A1r - jSign * B1i;
          imag[a3] = A1i + jSign * B1r;
        }
      }
    }
    if ((m & 1) !== 0) {
      const half = n >> 1;
      const t = stages[stageIdx];
      for (let k = 0; k < half; k++) {
        const wr = t[2 * k];
        const wi = sign * t[2 * k + 1];
        const ur = real[k];
        const ui = imag[k];
        const vr = real[k + half];
        const vi = imag[k + half];
        const vrW = wr * vr - wi * vi;
        const viW = wr * vi + wi * vr;
        real[k] = ur + vrW;
        imag[k] = ui + viW;
        real[k + half] = ur - vrW;
        imag[k + half] = ui - viW;
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        real[i] *= inv;
        imag[i] *= inv;
      }
    }
  }
  function nextPow2(n) {
    if (n <= 1) return 1;
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }
  function hannWindow(n) {
    const w = new Float32Array(n);
    if (n <= 1) {
      if (n === 1) w[0] = 1;
      return w;
    }
    const denom = n - 1;
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / denom));
    }
    return w;
  }
  function frequencyBins(n, fs) {
    const half = n >> 1;
    const out = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) {
      out[k] = k * fs / n;
    }
    return out;
  }

  // src/dsp/Convolver.ts
  var Convolver = class {
    fs;
    partitionSize;
    longPartitionSize;
    shortRegionSamples;
    k;
    dePeriodize;
    irLoaded = false;
    /** IR 去周期化后的长度 M */
    irLength = 0;
    irName = null;
    /** 短分区数 Ps（覆盖 IR 前部） */
    numShort = 0;
    /** 长分区数 Pl（覆盖 IR 尾部；Pl=0 时退化为均匀分区） */
    numLong = 0;
    /** 长分区起点（IR 样本索引 = Ps·Ls） */
    longStart = 0;
    /** 短 FFT 长度 Ns = nextPow2(2·Ls) */
    shortFftSize = 0;
    /** 长 FFT 长度 Nl = nextPow2(2·Ll) */
    longFftSize = 0;
    /** 短分区预计算频谱（实部/虚部），长度 Ps*Ns */
    shortSpecReal = new Float32Array(0);
    shortSpecImag = new Float32Array(0);
    /** 长分区预计算频谱（实部/虚部），长度 Pl*Nl */
    longSpecReal = new Float32Array(0);
    longSpecImag = new Float32Array(0);
    /** 干湿混合 0..1：out = (1-mix)·dry + mix·wet */
    mix = 1;
    preDelaySamples = 0;
    // ---- 流式（processStereo）状态，全部预分配 ----
    inputBlockL = new Float32Array(0);
    inputBlockR = new Float32Array(0);
    inputPos = 0;
    /** 长输入块累积（每 k 个短块填满 Ll 样本），每通道独立 */
    longInL = new Float32Array(0);
    longInR = new Float32Array(0);
    // outAccum 每通道独立：两通道串行处理且各左移一次，
    // 共用累加器会导致分区历史被后处理通道提前消耗（湿路内容错位/丢失）
    outAccumL = new Float32Array(0);
    outAccumR = new Float32Array(0);
    pendingWetL = new Float32Array(0);
    pendingWetR = new Float32Array(0);
    pendingLen = 0;
    pendingPos = 0;
    wetDelayL = new Float32Array(0);
    wetDelayR = new Float32Array(0);
    wetDelayPos = 0;
    /** 已送入的输入样本总数（累计，仅统计用） */
    totalIn = 0;
    /** 已放行的湿路样本总数 */
    totalWetOut = 0;
    /** 已完成的输入块数（块完成时 +1）：湿路放行的"已产出"依据 */
    completedBlocks = 0;
    /** 已输出的样本总数（跨调用累计）：湿路放行的"位置"依据（逐样本，支持任意块长） */
    totalOut = 0;
    maxFrames = 0;
    explicitlyPrepared = false;
    // ---- 工作缓冲（复用，零分配） ----
    /** 短输入 FFT 工作缓冲（Ns） */
    shortWorkReal = new Float32Array(0);
    shortWorkImag = new Float32Array(0);
    /** 短分区复乘/IFFT 缓冲（Ns） */
    prodShortReal = new Float32Array(0);
    prodShortImag = new Float32Array(0);
    /** 长输入 FFT 工作缓冲（Nl） */
    longWorkReal = new Float32Array(0);
    longWorkImag = new Float32Array(0);
    /** 长分区复乘/IFFT 缓冲（Nl） */
    prodLongReal = new Float32Array(0);
    prodLongImag = new Float32Array(0);
    constructor(fs, opts) {
      if (fs <= 0 || !Number.isFinite(fs)) {
        throw new Error("invalid sample rate");
      }
      this.fs = fs;
      let L = opts && opts.partitionSize !== void 0 ? Math.round(opts.partitionSize) : 512;
      if (!Number.isFinite(L) || L < 1) L = 512;
      this.partitionSize = Math.min(8192, Math.max(32, L));
      let wantLl = opts && opts.longPartitionSize !== void 0 ? Math.round(opts.longPartitionSize) : 4096;
      if (!Number.isFinite(wantLl) || wantLl < 1) wantLl = 4096;
      let k = 1;
      if (wantLl > this.partitionSize) {
        let ratio = wantLl / this.partitionSize;
        let pow = 1;
        while (pow < ratio) pow <<= 1;
        k = Math.max(1, pow);
      }
      this.k = k;
      this.longPartitionSize = this.partitionSize * k;
      let sms = opts && opts.shortRegionMs !== void 0 ? Math.round(opts.shortRegionMs) : 100;
      if (!Number.isFinite(sms) || sms < 0) sms = 100;
      this.shortRegionSamples = Math.round(Math.min(5e3, sms) / 1e3 * fs);
      this.dePeriodize = opts ? opts.dePeriodize !== false : true;
      const maxDelay = fs;
      this.wetDelayL = new Float32Array(maxDelay);
      this.wetDelayR = new Float32Array(maxDelay);
    }
    /**
     * 载入单声道 IR。dePeriodize=true 时先做去周期化（尾部指数衰减窗）。
     * 空 / 全零 / 非法 IR 抛 Error。
     */
    loadIR(ir, irName) {
      if (!ir || ir.length === 0) {
        throw new Error("invalid impulse response: empty");
      }
      let anyNonZero = false;
      for (let i = 0; i < ir.length; i++) {
        const v = ir[i];
        if (!Number.isFinite(v)) {
          throw new Error("invalid impulse response: contains NaN/Infinity");
        }
        if (v !== 0) anyNonZero = true;
      }
      if (!anyNonZero) {
        throw new Error("invalid impulse response: all zero");
      }
      const Ls = this.partitionSize;
      const k = this.k;
      const src = this.dePeriodize ? this.dePeriodizeIR(ir) : ir;
      const M = src.length;
      let Ps = Math.max(1, Math.ceil(this.shortRegionSamples / Ls));
      if (Ps < k - 1) Ps = Math.max(1, k - 1);
      const longStart = Ps * Ls;
      let Pl = 0;
      if (longStart < M) {
        Pl = Math.max(1, Math.ceil((M - longStart) / this.longPartitionSize));
      }
      if (Pl === 0) {
        Ps = Math.max(1, Math.ceil(M / Ls));
      }
      const longStartFinal = Ps * Ls;
      const Ns = nextPow2(2 * Ls);
      const Nl = nextPow2(2 * this.longPartitionSize);
      const PTotal = Ps + Pl * k;
      this.irLength = M;
      this.irName = irName !== void 0 ? irName : null;
      this.numShort = Ps;
      this.numLong = Pl;
      this.longStart = longStartFinal;
      this.shortFftSize = Ns;
      this.longFftSize = Nl;
      this.shortSpecReal = new Float32Array(Ps * Ns);
      this.shortSpecImag = new Float32Array(Ps * Ns);
      const workR = new Float32Array(Math.max(Ns, Nl));
      const workI = new Float32Array(Math.max(Ns, Nl));
      for (let p = 0; p < Ps; p++) {
        workR.fill(0);
        workI.fill(0);
        const base = p * Ls;
        const count = Math.min(Ls, M - base);
        for (let j = 0; j < count; j++) workR[j] = src[base + j];
        fft(workR.subarray(0, Ns), workI.subarray(0, Ns), false);
        this.shortSpecReal.set(workR.subarray(0, Ns), p * Ns);
        this.shortSpecImag.set(workI.subarray(0, Ns), p * Ns);
      }
      this.longSpecReal = new Float32Array(Pl * Nl);
      this.longSpecImag = new Float32Array(Pl * Nl);
      for (let p = 0; p < Pl; p++) {
        workR.fill(0);
        workI.fill(0);
        const base = longStart + p * this.longPartitionSize;
        const count = Math.min(this.longPartitionSize, M - base);
        for (let j = 0; j < count; j++) workR[j] = src[base + j];
        fft(workR.subarray(0, Nl), workI.subarray(0, Nl), false);
        this.longSpecReal.set(workR.subarray(0, Nl), p * Nl);
        this.longSpecImag.set(workI.subarray(0, Nl), p * Nl);
      }
      const accLen = Math.max((PTotal + 2) * Ls, this.pendingCapacity(Ls));
      this.inputBlockL = new Float32Array(Ls);
      this.inputBlockR = new Float32Array(Ls);
      this.longInL = new Float32Array(this.longPartitionSize);
      this.longInR = new Float32Array(this.longPartitionSize);
      this.outAccumL = new Float32Array(accLen);
      this.outAccumR = new Float32Array(accLen);
      this.pendingWetL = new Float32Array(accLen);
      this.pendingWetR = new Float32Array(accLen);
      this.shortWorkReal = new Float32Array(Ns);
      this.shortWorkImag = new Float32Array(Ns);
      this.prodShortReal = new Float32Array(Ns);
      this.prodShortImag = new Float32Array(Ns);
      this.longWorkReal = new Float32Array(Nl);
      this.longWorkImag = new Float32Array(Nl);
      this.prodLongReal = new Float32Array(Nl);
      this.prodLongImag = new Float32Array(Nl);
      this.inputPos = 0;
      this.pendingLen = 0;
      this.pendingPos = 0;
      this.totalIn = 0;
      this.totalWetOut = 0;
      this.completedBlocks = 0;
      this.totalOut = 0;
      this.outAccumL.fill(0);
      this.outAccumR.fill(0);
      this.irLoaded = true;
    }
    prepare(maxFrames) {
      const frames = Number.isFinite(maxFrames) ? Math.max(0, Math.floor(maxFrames)) : 0;
      this.explicitlyPrepared = frames > 0;
      this.ensurePendingCapacity(frames);
    }
    ensurePendingCapacity(frames) {
      if (frames <= this.maxFrames) return;
      this.maxFrames = frames;
      if (!this.irLoaded) return;
      const capacity = Math.max(this.pendingWetL.length, this.pendingCapacity(this.partitionSize));
      if (this.pendingWetL.length < capacity) {
        this.pendingWetL = new Float32Array(capacity);
        this.pendingWetR = new Float32Array(capacity);
        this.pendingLen = 0;
        this.pendingPos = 0;
      }
    }
    pendingCapacity(partitionSize) {
      const produced = Math.ceil(Math.max(this.maxFrames, partitionSize) / partitionSize);
      return Math.max(3, produced + 2) * partitionSize;
    }
    /** 设置干湿混合 0..1（1=纯湿） */
    setMix(mix) {
      this.mix = Math.min(1, Math.max(0, mix));
    }
    /** 设置湿路预延迟 ms（0..1000） */
    setPreDelayMs(ms) {
      const clamped = Math.min(1e3, Math.max(0, ms));
      this.preDelaySamples = Math.round(clamped * this.fs / 1e3);
    }
    /**
     * 单声道一次完整卷积（有限块语义，从零状态开始）：
     * 返回新 Float32Array，长度 = 输入长度 + IR 尾 + preDelay 样本。
     * 未载入 IR 时抛错（调用方应先 loadIR）。
     * 用同一非均匀分区方案（短块 + 长块）直接 overlap-add，数学等价于完整线性卷积。
     */
    process(x) {
      if (!this.irLoaded) {
        throw new Error("no impulse response loaded");
      }
      const Ls = this.partitionSize;
      const Ll = this.longPartitionSize;
      const Ps = this.numShort;
      const Pl = this.numLong;
      const Ns = this.shortFftSize;
      const Nl = this.longFftSize;
      const convLen = x.length + this.irLength - 1;
      const total = convLen + this.preDelaySamples;
      const out = new Float32Array(total);
      const I = Math.ceil(x.length / Ls);
      for (let i = 0; i < I; i++) {
        this.shortWorkReal.fill(0);
        this.shortWorkImag.fill(0);
        const start = i * Ls;
        const end = Math.min(start + Ls, x.length);
        for (let j = start; j < end; j++) this.shortWorkReal[j - start] = x[j];
        fft(this.shortWorkReal, this.shortWorkImag, false);
        for (let p = 0; p < Ps; p++) {
          const specBase = p * Ns;
          for (let k = 0; k < Ns; k++) {
            const r1 = this.shortWorkReal[k];
            const i1 = this.shortWorkImag[k];
            const r2 = this.shortSpecReal[specBase + k];
            const i2 = this.shortSpecImag[specBase + k];
            this.prodShortReal[k] = r1 * r2 - i1 * i2;
            this.prodShortImag[k] = r1 * i2 + i1 * r2;
          }
          fft(this.prodShortReal, this.prodShortImag, true);
          const base1 = (i + p) * Ls;
          const base2 = base1 + Ls;
          for (let j = 0; j < Ls; j++) {
            const idx1 = base1 + j;
            if (idx1 < total) out[idx1] += this.prodShortReal[j];
            const idx2 = base2 + j;
            if (idx2 < total) out[idx2] += this.prodShortReal[Ls + j];
          }
        }
      }
      const J = Math.ceil(x.length / Ll);
      for (let i = 0; i < J; i++) {
        this.longWorkReal.fill(0);
        this.longWorkImag.fill(0);
        const start = i * Ll;
        const end = Math.min(start + Ll, x.length);
        for (let j = start; j < end; j++) this.longWorkReal[j - start] = x[j];
        fft(this.longWorkReal, this.longWorkImag, false);
        for (let p = 0; p < Pl; p++) {
          const specBase = p * Nl;
          for (let k = 0; k < Nl; k++) {
            const r1 = this.longWorkReal[k];
            const i1 = this.longWorkImag[k];
            const r2 = this.longSpecReal[specBase + k];
            const i2 = this.longSpecImag[specBase + k];
            this.prodLongReal[k] = r1 * r2 - i1 * i2;
            this.prodLongImag[k] = r1 * i2 + i1 * r2;
          }
          fft(this.prodLongReal, this.prodLongImag, true);
          const base1 = this.longStart + (i + p) * Ll;
          const base2 = base1 + Ll;
          for (let j = 0; j < Ll; j++) {
            const idx1 = base1 + j;
            if (idx1 < total) out[idx1] += this.prodLongReal[j];
            const idx2 = base2 + j;
            if (idx2 < total) out[idx2] += this.prodLongReal[Ll + j];
          }
        }
      }
      if (this.preDelaySamples > 0) {
        for (let i = convLen - 1; i >= 0; i--) out[i + this.preDelaySamples] = out[i];
        out.fill(0, 0, this.preDelaySamples);
      }
      return out;
    }
    /**
     * 流式立体声就地处理（引擎实时路径）。
     * 湿路 = 非均匀分区卷积 + preDelay；干路 = 输入本身（不延迟）。
     * out[i] = (1-mix)·dry[i] + mix·wet[i]；wet 相对 dry 延迟 Ls + preDelay 样本。
     * 未载入 IR 时抛错。
     */
    processStereo(l, r, frameCount) {
      if (!this.irLoaded) {
        throw new Error("no impulse response loaded");
      }
      const B = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      if (!this.explicitlyPrepared && B > this.maxFrames) this.ensurePendingCapacity(B);
      const Ls = this.partitionSize;
      const dryGain = 1 - this.mix;
      const wetGain = this.mix;
      for (let i = 0; i < B; i++) {
        this.inputBlockL[this.inputPos] = l[i];
        this.inputBlockR[this.inputPos] = r[i];
        this.inputPos++;
        if (this.inputPos >= Ls) {
          const cap = this.pendingWetL.length;
          if (this.pendingPos + this.pendingLen + Ls > cap) {
            const remain = this.pendingLen;
            if (remain > 0 && this.pendingPos > 0) {
              this.pendingWetL.copyWithin(0, this.pendingPos, this.pendingPos + remain);
              this.pendingWetR.copyWithin(0, this.pendingPos, this.pendingPos + remain);
            }
            this.pendingPos = 0;
            if (this.pendingLen + Ls > this.pendingWetL.length) {
              if (this.explicitlyPrepared) {
                throw new Error(`Convolver block ${B} exceeds prepared pending capacity`);
              }
              this.ensurePendingCapacity(B);
            }
          }
          const writeAt = this.pendingPos + this.pendingLen;
          this.processWetBlock(this.inputBlockL, this.longInL, this.pendingWetL, writeAt, this.outAccumL);
          this.processWetBlock(this.inputBlockR, this.longInR, this.pendingWetR, writeAt, this.outAccumR);
          this.pendingLen += Ls;
          this.completedBlocks++;
          this.inputPos = 0;
        }
      }
      this.totalIn += B;
      for (let i = 0; i < B; i++) {
        let wetL = 0;
        let wetR = 0;
        const wetIdx = this.totalOut - Ls;
        if (this.pendingLen > 0 && wetIdx >= 0 && wetIdx < this.completedBlocks * Ls && this.totalWetOut === wetIdx) {
          wetL = this.pendingWetL[this.pendingPos];
          wetR = this.pendingWetR[this.pendingPos];
          this.pendingPos++;
          this.pendingLen--;
          this.totalWetOut++;
          if (this.pendingLen === 0) this.pendingPos = 0;
        }
        this.totalOut++;
        wetL = this.pushDelay(this.wetDelayL, wetL);
        wetR = this.pushDelay(this.wetDelayR, wetR);
        l[i] = dryGain * l[i] + wetGain * wetL;
        r[i] = dryGain * r[i] + wetGain * wetR;
      }
    }
    /** 湿路引入的延迟（样本数）= 短分区长 Ls（块缓冲延迟），引擎可据此补偿 */
    getLatencySamples() {
      return this.partitionSize;
    }
    reset() {
      this.inputPos = 0;
      this.pendingLen = 0;
      this.pendingPos = 0;
      this.totalIn = 0;
      this.totalWetOut = 0;
      this.completedBlocks = 0;
      this.totalOut = 0;
      this.wetDelayPos = 0;
      if (this.outAccumL.length > 0) {
        this.outAccumL.fill(0);
        this.outAccumR.fill(0);
      }
      if (this.pendingWetL.length > 0) {
        this.pendingWetL.fill(0);
        this.pendingWetR.fill(0);
      }
      if (this.wetDelayL.length > 0) {
        this.wetDelayL.fill(0);
        this.wetDelayR.fill(0);
      }
      if (this.inputBlockL.length > 0) {
        this.inputBlockL.fill(0);
        this.inputBlockR.fill(0);
      }
      if (this.longInL.length > 0) {
        this.longInL.fill(0);
        this.longInR.fill(0);
      }
    }
    /** 当前 IR 名称（未载入返回 null） */
    getIrName() {
      return this.irName;
    }
    // ---------------------------------------------------------------- 内部
    /**
     * 处理一个完整短输入块（Ls 样本）：
     * 1) 短 FFT（Ns）→ 与 Ps 个短分区复乘、IFFT、overlap-add 到 outAccum（偏移 p·Ls / (p+1)·Ls）；
     * 2) 长输入块累积：本块复制进 longIn[blockIdx%k 位置]；当第 k 个短块（长块满）时
     *    做长 FFT（Nl）→ 与 Pl 个长分区复乘、IFFT，overlap-add 到 outAccum
     *    （偏移 (Ps+p·k−k+1)·Ls / (Ps+p·k+1)·Ls）；
     * 3) 取出 outAccum[0..Ls)（= 输出块）写入 pending[writeAt..writeAt+Ls)，左移 outAccum。
     * 注意：左右声道队列并行共享同一记账（pendingPos/pendingLen），
     * 写位置由调用方统一计算（writeAt = pendingPos + pendingLen），
     * pendingLen 由调用方在两次调用后只加一次 Ls（此处不记账）。
     * longIn 为通道独立长输入缓冲（长分区贡献跨 k 个短块累积）。
     * outAccum 为通道独立累加器，块处理前**不能** fill(0)——
     * 上一块左移后保留的 [0..(P_total)·Ls) 正是各分区历史贡献（Gardner 分区卷积语义）。
     */
    processWetBlock(blk, longIn, pending, writeAt, outAccum) {
      const Ls = this.partitionSize;
      const Ps = this.numShort;
      const Pl = this.numLong;
      const Ns = this.shortFftSize;
      const Nl = this.longFftSize;
      const k = this.k;
      const blockIdx = this.completedBlocks;
      if (Pl > 0) {
        const longPos = blockIdx % k * Ls;
        for (let j = 0; j < Ls; j++) longIn[longPos + j] = blk[j];
        if (blockIdx % k === k - 1) {
          this.longWorkReal.fill(0);
          this.longWorkImag.fill(0);
          this.longWorkReal.set(longIn);
          fft(this.longWorkReal, this.longWorkImag, false);
          const Ll = this.longPartitionSize;
          const longStart = this.longStart;
          for (let p = 0; p < Pl; p++) {
            const specBase = p * Nl;
            for (let kk = 0; kk < Nl; kk++) {
              const r1 = this.longWorkReal[kk];
              const i1 = this.longWorkImag[kk];
              const r2 = this.longSpecReal[specBase + kk];
              const i2 = this.longSpecImag[specBase + kk];
              this.prodLongReal[kk] = r1 * r2 - i1 * i2;
              this.prodLongImag[kk] = r1 * i2 + i1 * r2;
            }
            fft(this.prodLongReal, this.prodLongImag, true);
            const base1 = longStart + p * Ll - (k - 1) * Ls;
            const base2 = base1 + Ll;
            for (let j = 0; j < Ll; j++) {
              outAccum[base1 + j] += this.prodLongReal[j];
              outAccum[base2 + j] += this.prodLongReal[Ll + j];
            }
          }
        }
      }
      this.shortWorkReal.fill(0);
      this.shortWorkImag.fill(0);
      this.shortWorkReal.set(blk);
      fft(this.shortWorkReal, this.shortWorkImag, false);
      for (let p = 0; p < Ps; p++) {
        const specBase = p * Ns;
        for (let kk = 0; kk < Ns; kk++) {
          const r1 = this.shortWorkReal[kk];
          const i1 = this.shortWorkImag[kk];
          const r2 = this.shortSpecReal[specBase + kk];
          const i2 = this.shortSpecImag[specBase + kk];
          this.prodShortReal[kk] = r1 * r2 - i1 * i2;
          this.prodShortImag[kk] = r1 * i2 + i1 * r2;
        }
        fft(this.prodShortReal, this.prodShortImag, true);
        const base1 = p * Ls;
        const base2 = base1 + Ls;
        for (let j = 0; j < Ls; j++) {
          outAccum[base1 + j] += this.prodShortReal[j];
          outAccum[base2 + j] += this.prodShortReal[Ls + j];
        }
      }
      for (let j = 0; j < Ls; j++) pending[writeAt + j] = outAccum[j];
      const len = outAccum.length;
      outAccum.copyWithin(0, Ls, len);
      outAccum.fill(0, len - Ls, len);
    }
    /** 环形延迟线：写入 x，返回 preDelaySamples 前的样本（preDelay=0 直接返回 x） */
    pushDelay(line, x) {
      if (this.preDelaySamples === 0) return x;
      const size = line.length;
      let readPos = this.wetDelayPos - this.preDelaySamples;
      if (readPos < 0) readPos += size;
      const out = line[readPos];
      line[this.wetDelayPos] = x;
      this.wetDelayPos++;
      if (this.wetDelayPos >= size) this.wetDelayPos = 0;
      return out;
    }
    /**
     * IR 去周期化：检测能量包络峰值，从峰值后 -60dB 点起乘 exp 衰减（τ≈50ms）。
     * 返回新数组（不改动调用方传入的 IR）。
     */
    dePeriodizeIR(ir) {
      const M = ir.length;
      const out = new Float32Array(M);
      out.set(ir);
      const W = Math.max(4, Math.round(0.01 * this.fs));
      const half = W >> 1;
      let peakIdx = 0;
      let peakVal = -1;
      for (let n = 0; n < M; n++) {
        let sum = 0;
        const lo = Math.max(0, n - half);
        const hi = Math.min(M, n + half + 1);
        const cnt = hi - lo;
        for (let j = lo; j < hi; j++) sum += ir[j] * ir[j];
        const env = Math.sqrt(sum / cnt);
        if (env > peakVal) {
          peakVal = env;
          peakIdx = n;
        }
      }
      if (peakVal <= 1e-12) return out;
      const threshold = peakVal * 1e-3;
      let lastAbove = peakIdx;
      for (let n = peakIdx; n < M; n++) {
        let sum = 0;
        const lo = Math.max(0, n - half);
        const hi = Math.min(M, n + half + 1);
        const cnt = hi - lo;
        for (let j = lo; j < hi; j++) sum += ir[j] * ir[j];
        if (Math.sqrt(sum / cnt) > threshold) lastAbove = n;
      }
      const n0 = lastAbove + 1;
      if (n0 >= M) return out;
      const tau = 0.05 * this.fs;
      for (let n = n0; n < M; n++) {
        out[n] *= Math.exp(-(n - n0) / tau);
      }
      return out;
    }
  };

  // src/dsp/ReverbSimple.ts
  var TYPE_TABLE = {
    // hall：大空间长尾，反馈较强、阻尼适中，标准延迟
    hall: { roomSize: 0.7, damping: 0.4, delayScale: 1 },
    // room：小房间短尾，反馈弱、阻尼高（偏闷）
    room: { roomSize: 0.4, damping: 0.6, delayScale: 0.8 },
    // plate：金属板混响，反馈中等、阻尼很低（明亮），延迟偏短密度高
    plate: { roomSize: 0.6, damping: 0.2, delayScale: 0.7 },
    // spring：弹簧混响，反馈弱、阻尼极高（独特"弹簧"音色），延迟特短
    spring: { roomSize: 0.3, damping: 0.8, delayScale: 0.5 },
    // stage：舞台/厅堂，反馈中等、阻尼适中，延迟拉长获得更宽声场
    stage: { roomSize: 0.5, damping: 0.5, delayScale: 1.2 }
  };
  var COMB_DELAYS_L = [1116, 1188, 1277, 1356];
  var COMB_DELAYS_R = [1101, 1173, 1256, 1344];
  var ALLPASS_DELAYS = [556, 441, 341, 225];
  var ReverbSimple = class {
    fs;
    // 梳状滤波器状态（8 组）
    combBufL = [];
    combBufR = [];
    combPosL = new Int32Array(4);
    combPosR = new Int32Array(4);
    combLenL = new Int32Array(4);
    combLenR = new Int32Array(4);
    combStoreL = new Float32Array(4);
    combStoreR = new Float32Array(4);
    // 全通滤波器状态（左右各 4）
    apBufL = [];
    apBufR = [];
    apPosL = new Int32Array(4);
    apPosR = new Int32Array(4);
    apLen = new Int32Array(4);
    // preDelay 延迟线（左右各一）
    preDelayL;
    preDelayR;
    preDelayPos = 0;
    preDelayLen = 0;
    // 参数
    feedback = 0;
    damp1 = 0;
    damp2 = 1;
    wet1 = 0;
    wet2 = 0;
    dry = 0;
    constructor(fs) {
      if (fs <= 0 || !Number.isFinite(fs)) {
        throw new Error("invalid sample rate");
      }
      this.fs = fs;
      const maxCombLen = Math.ceil(1356 * 1.2 * fs / 44100) + 2;
      const maxApLen = Math.ceil(556 * 1.2 * fs / 44100) + 2;
      for (let c = 0; c < 4; c++) {
        this.combBufL.push(new Float32Array(maxCombLen));
        this.combBufR.push(new Float32Array(maxCombLen));
        this.apBufL.push(new Float32Array(maxApLen));
        this.apBufR.push(new Float32Array(maxApLen));
      }
      this.preDelayL = new Float32Array(Math.ceil(fs) + 1);
      this.preDelayR = new Float32Array(Math.ceil(fs) + 1);
    }
    setParams(p) {
      const t = TYPE_TABLE[p.type] || TYPE_TABLE.hall;
      const effRoom = Math.min(0.98, Math.max(0, t.roomSize + (clamp01(p.roomSize) - 0.5) * 0.5));
      const effDamp = Math.min(0.99, Math.max(0.01, t.damping + (clamp01(p.damping) - 0.5) * 0.5));
      this.feedback = effRoom;
      this.damp1 = effDamp;
      this.damp2 = 1 - effDamp;
      const wet = Math.min(4, Math.max(0, p.wet));
      const width = Math.min(2, Math.max(0, p.width));
      this.wet1 = wet * (width / 2 + 0.5);
      this.wet2 = wet * ((1 - width) / 2);
      this.dry = Math.min(4, Math.max(0, p.dry));
      const pdMs = Math.min(1e3, Math.max(0, p.preDelayMs));
      this.preDelayLen = Math.round(pdMs * this.fs / 1e3);
      const scale = t.delayScale * this.fs / 44100;
      for (let c = 0; c < 4; c++) {
        this.combLenL[c] = Math.max(1, Math.round(COMB_DELAYS_L[c] * scale));
        this.combLenR[c] = Math.max(1, Math.round(COMB_DELAYS_R[c] * scale));
        this.apLen[c] = Math.max(1, Math.round(ALLPASS_DELAYS[c] * scale));
      }
    }
    /**
     * 就地处理立体声；out = dry·in + wet 混音（Freeverb 结构）。
     * 热路径：comb/allpass/preDelay 全部内联，字段缓存为局部变量；
     * 运算顺序与内联前逐位一致（数学完全等价）。
     */
    processStereo(l, r, frameCount) {
      const B = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const WET_GAIN = 0.25;
      const cbL = this.combBufL;
      const cbR = this.combBufR;
      const posL = this.combPosL;
      const posR = this.combPosR;
      const lenL = this.combLenL;
      const lenR = this.combLenR;
      const stL = this.combStoreL;
      const stR = this.combStoreR;
      const abL = this.apBufL;
      const abR = this.apBufR;
      const apPosL = this.apPosL;
      const apPosR = this.apPosR;
      const apLen = this.apLen;
      const pDL = this.preDelayL;
      const pDR = this.preDelayR;
      const feedback = this.feedback;
      const damp1 = this.damp1;
      const damp2 = this.damp2;
      const wet1 = this.wet1;
      const wet2 = this.wet2;
      const dry = this.dry;
      let pdLen = this.preDelayLen;
      let pdPos = this.preDelayPos;
      for (let i = 0; i < B; i++) {
        const xl = l[i];
        const xr = r[i];
        let dl;
        let dr;
        if (pdLen === 0) {
          dl = xl;
          dr = xr;
        } else {
          const size = pDL.length;
          let rp = pdPos - pdLen;
          if (rp < 0) rp += size;
          dl = pDL[rp];
          pDL[pdPos] = xl;
          pdPos++;
          if (pdPos >= size) pdPos = 0;
          rp = pdPos - pdLen;
          if (rp < 0) rp += size;
          dr = pDR[rp];
          pDR[pdPos] = xr;
          pdPos++;
          if (pdPos >= size) pdPos = 0;
        }
        let accL = 0;
        let accR = 0;
        {
          const buf = cbL[0];
          const p = posL[0];
          const out = buf[p];
          const filt = out * damp2 + stL[0] * damp1;
          stL[0] = filt;
          buf[p] = dl + filt * feedback;
          let np = p + 1;
          if (np >= lenL[0]) np = 0;
          posL[0] = np;
          accL += out;
        }
        {
          const buf = cbR[0];
          const p = posR[0];
          const out = buf[p];
          const filt = out * damp2 + stR[0] * damp1;
          stR[0] = filt;
          buf[p] = dr + filt * feedback;
          let np = p + 1;
          if (np >= lenR[0]) np = 0;
          posR[0] = np;
          accR += out;
        }
        {
          const buf = cbL[1];
          const p = posL[1];
          const out = buf[p];
          const filt = out * damp2 + stL[1] * damp1;
          stL[1] = filt;
          buf[p] = dl + filt * feedback;
          let np = p + 1;
          if (np >= lenL[1]) np = 0;
          posL[1] = np;
          accL += out;
        }
        {
          const buf = cbR[1];
          const p = posR[1];
          const out = buf[p];
          const filt = out * damp2 + stR[1] * damp1;
          stR[1] = filt;
          buf[p] = dr + filt * feedback;
          let np = p + 1;
          if (np >= lenR[1]) np = 0;
          posR[1] = np;
          accR += out;
        }
        {
          const buf = cbL[2];
          const p = posL[2];
          const out = buf[p];
          const filt = out * damp2 + stL[2] * damp1;
          stL[2] = filt;
          buf[p] = dl + filt * feedback;
          let np = p + 1;
          if (np >= lenL[2]) np = 0;
          posL[2] = np;
          accL += out;
        }
        {
          const buf = cbR[2];
          const p = posR[2];
          const out = buf[p];
          const filt = out * damp2 + stR[2] * damp1;
          stR[2] = filt;
          buf[p] = dr + filt * feedback;
          let np = p + 1;
          if (np >= lenR[2]) np = 0;
          posR[2] = np;
          accR += out;
        }
        {
          const buf = cbL[3];
          const p = posL[3];
          const out = buf[p];
          const filt = out * damp2 + stL[3] * damp1;
          stL[3] = filt;
          buf[p] = dl + filt * feedback;
          let np = p + 1;
          if (np >= lenL[3]) np = 0;
          posL[3] = np;
          accL += out;
        }
        {
          const buf = cbR[3];
          const p = posR[3];
          const out = buf[p];
          const filt = out * damp2 + stR[3] * damp1;
          stR[3] = filt;
          buf[p] = dr + filt * feedback;
          let np = p + 1;
          if (np >= lenR[3]) np = 0;
          posR[3] = np;
          accR += out;
        }
        {
          const buf = abL[0];
          const p = apPosL[0];
          const bufout = buf[p];
          const apOutL = -accL + bufout;
          buf[p] = accL + bufout * 0.5;
          accL = apOutL;
          let np = p + 1;
          if (np >= apLen[0]) np = 0;
          apPosL[0] = np;
        }
        {
          const buf = abR[0];
          const p = apPosR[0];
          const bufout = buf[p];
          const apOutR = -accR + bufout;
          buf[p] = accR + bufout * 0.5;
          accR = apOutR;
          let np = p + 1;
          if (np >= apLen[0]) np = 0;
          apPosR[0] = np;
        }
        {
          const buf = abL[1];
          const p = apPosL[1];
          const bufout = buf[p];
          const apOutL = -accL + bufout;
          buf[p] = accL + bufout * 0.5;
          accL = apOutL;
          let np = p + 1;
          if (np >= apLen[1]) np = 0;
          apPosL[1] = np;
        }
        {
          const buf = abR[1];
          const p = apPosR[1];
          const bufout = buf[p];
          const apOutR = -accR + bufout;
          buf[p] = accR + bufout * 0.5;
          accR = apOutR;
          let np = p + 1;
          if (np >= apLen[1]) np = 0;
          apPosR[1] = np;
        }
        {
          const buf = abL[2];
          const p = apPosL[2];
          const bufout = buf[p];
          const apOutL = -accL + bufout;
          buf[p] = accL + bufout * 0.5;
          accL = apOutL;
          let np = p + 1;
          if (np >= apLen[2]) np = 0;
          apPosL[2] = np;
        }
        {
          const buf = abR[2];
          const p = apPosR[2];
          const bufout = buf[p];
          const apOutR = -accR + bufout;
          buf[p] = accR + bufout * 0.5;
          accR = apOutR;
          let np = p + 1;
          if (np >= apLen[2]) np = 0;
          apPosR[2] = np;
        }
        {
          const buf = abL[3];
          const p = apPosL[3];
          const bufout = buf[p];
          const apOutL = -accL + bufout;
          buf[p] = accL + bufout * 0.5;
          accL = apOutL;
          let np = p + 1;
          if (np >= apLen[3]) np = 0;
          apPosL[3] = np;
        }
        {
          const buf = abR[3];
          const p = apPosR[3];
          const bufout = buf[p];
          const apOutR = -accR + bufout;
          buf[p] = accR + bufout * 0.5;
          accR = apOutR;
          let np = p + 1;
          if (np >= apLen[3]) np = 0;
          apPosR[3] = np;
        }
        accL *= WET_GAIN;
        accR *= WET_GAIN;
        l[i] = xl * dry + accL * wet1 + accR * wet2;
        r[i] = xr * dry + accR * wet1 + accL * wet2;
      }
      this.preDelayPos = pdPos;
    }
    reset() {
      for (let c = 0; c < 4; c++) {
        this.combBufL[c].fill(0);
        this.combBufR[c].fill(0);
        this.apBufL[c].fill(0);
        this.apBufR[c].fill(0);
        this.combPosL[c] = 0;
        this.combPosR[c] = 0;
        this.apPosL[c] = 0;
        this.apPosR[c] = 0;
        this.combStoreL[c] = 0;
        this.combStoreR[c] = 0;
      }
      this.preDelayL.fill(0);
      this.preDelayR.fill(0);
      this.preDelayPos = 0;
    }
  };
  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // src/dsp/FdnReverb.ts
  var TYPE_TABLE2 = {
    // hall:大空间长尾,反馈强、阻尼适中,延迟拉长
    hall: { roomSize: 0.7, damping: 0.4, delayScale: 1.3 },
    // room:小房间短尾,反馈弱、阻尼高(偏闷),延迟短
    room: { roomSize: 0.4, damping: 0.6, delayScale: 0.6 },
    // plate:金属板混响,反馈中等、阻尼很低(明亮),延迟偏短密度高
    plate: { roomSize: 0.6, damping: 0.2, delayScale: 0.7 },
    // spring:弹簧混响,反馈弱、阻尼极高(独特"弹簧"音色),延迟特短
    spring: { roomSize: 0.3, damping: 0.8, delayScale: 0.35 },
    // stage:舞台/厅堂,反馈中等、阻尼适中,延迟最长获得更宽声场
    stage: { roomSize: 0.55, damping: 0.5, delayScale: 1.5 }
  };
  var DELAYS_L = {
    2: [499, 547],
    4: [599, 641, 677, 709],
    8: [701, 719, 733, 757, 773, 797, 811, 823],
    16: [701, 719, 733, 757, 773, 797, 811, 823, 827, 839, 853, 857, 859, 863, 877, 881]
  };
  var DELAYS_R = {
    2: [521, 563],
    4: [607, 653, 683, 727],
    8: [709, 727, 739, 761, 787, 809, 821, 829],
    16: [709, 727, 739, 761, 787, 809, 821, 829, 839, 853, 857, 859, 863, 877, 881, 883]
  };
  var MAX_LINES = 16;
  var MAX_DELAY_BASE = 883;
  var MAX_DELAY_SCALE = 1.5;
  var MAX_FEEDBACK = 0.98;
  var MAX_PREDELAY_MS = 1e3;
  var FdnNetwork = class {
    fs;
    // 延迟线缓冲:Float32Array[] 构造时按最大延迟预分配
    buf = [];
    // 每条线的长度与读写位置:Int32Array
    len = new Int32Array(MAX_LINES);
    pos = new Int32Array(MAX_LINES);
    // 每线阻尼滤波器状态(store = 上一拍低通输出,Freeverb 语义)
    store = new Float32Array(MAX_LINES);
    // 过程暂存(预分配复用 → process 零分配)
    out = new Float32Array(MAX_LINES);
    filt = new Float32Array(MAX_LINES);
    n = 0;
    g = 0;
    damp1 = 0;
    damp2 = 1;
    inject = 0;
    outGain = 0;
    constructor(fs, maxDelay) {
      this.fs = fs;
      for (let j = 0; j < MAX_LINES; j++) this.buf.push(new Float32Array(maxDelay));
    }
    /** 配置线数、延迟长度、反馈/阻尼/注入/输出增益(只改系数,不重新分配) */
    configure(n, baseDelays, delayScale, g, damp1, damp2) {
      this.n = n;
      this.g = g;
      this.damp1 = damp1;
      this.damp2 = damp2;
      this.inject = 1 / Math.sqrt(n);
      this.outGain = 1 / n;
      const scale = delayScale * this.fs / 44100;
      for (let j = 0; j < n; j++) {
        this.len[j] = Math.max(1, Math.round(baseDelays[j] * scale));
      }
    }
    /** 单样本处理:输入 x,返回该线网络的湿输出(就地更新状态) */
    process(x) {
      const n = this.n;
      const { buf, len, pos, store, out, filt } = this;
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const o = buf[j][pos[j]];
        out[j] = o;
        const f = o * this.damp2 + store[j] * this.damp1;
        filt[j] = f;
        store[j] = f;
        sum += f;
      }
      const u = 2 / n * sum;
      for (let j = 0; j < n; j++) {
        const b = buf[j];
        const p = pos[j];
        b[p] = this.inject * x + this.g * (filt[j] - u);
        let np = p + 1;
        if (np >= len[j]) np = 0;
        pos[j] = np;
      }
      let y = 0;
      for (let j = 0; j < n; j++) y += out[j];
      return y * this.outGain;
    }
    reset() {
      for (let j = 0; j < MAX_LINES; j++) {
        this.buf[j].fill(0);
        this.pos[j] = 0;
        this.store[j] = 0;
      }
    }
  };
  var FdnReverb = class {
    fs;
    left;
    right;
    // preDelay 独立延迟线(输入侧,左右各一;注意左右各持独立位置指针——
    // 若共用一个位置,每样本会被推进两次,有效延迟将减半)
    preDelayL;
    preDelayR;
    preDelayPosL = 0;
    preDelayPosR = 0;
    preDelayLen = 0;
    // 混音参数(wet/dry + width 交叉,与 ReverbSimple 相同公式)
    wet1 = 0;
    wet2 = 0;
    dry = 0;
    lineCount = 8;
    constructor(fs) {
      if (fs <= 0 || !Number.isFinite(fs)) {
        throw new Error("invalid sample rate");
      }
      this.fs = fs;
      const maxDelay = Math.ceil(MAX_DELAY_BASE * MAX_DELAY_SCALE * fs / 44100) + 2;
      this.left = new FdnNetwork(fs, maxDelay);
      this.right = new FdnNetwork(fs, maxDelay);
      this.preDelayL = new Float32Array(Math.ceil(fs) + 1);
      this.preDelayR = new Float32Array(Math.ceil(fs) + 1);
    }
    setParams(p) {
      const t = TYPE_TABLE2[p.type ?? "hall"] ?? TYPE_TABLE2.hall;
      const n = normalizeLines(p.lines);
      const effRoom = Math.min(MAX_FEEDBACK, Math.max(0, t.roomSize + (clamp012(p.roomSize) - 0.5) * 0.5));
      const effDamp = Math.min(0.99, Math.max(0.01, t.damping + (clamp012(p.damping) - 0.5) * 0.5));
      const wet = Math.min(4, Math.max(0, p.wet));
      const width = Math.min(2, Math.max(0, p.width));
      this.wet1 = wet * (width / 2 + 0.5);
      this.wet2 = wet * ((1 - width) / 2);
      this.dry = Math.min(4, Math.max(0, p.dry));
      const pdMs = Math.min(MAX_PREDELAY_MS, Math.max(0, p.preDelayMs));
      this.preDelayLen = Math.round(pdMs * this.fs / 1e3);
      this.left.configure(n, DELAYS_L[n], t.delayScale, effRoom, effDamp, 1 - effDamp);
      this.right.configure(n, DELAYS_R[n], t.delayScale, effRoom, effDamp, 1 - effDamp);
      if (n !== this.lineCount) {
        this.lineCount = n;
        this.reset();
      }
    }
    /** 就地处理立体声;out = dry·in + 湿路交叉混合(FDN 结构) */
    processStereo(l, r, frameCount) {
      const B = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      for (let i = 0; i < B; i++) {
        const xl = l[i];
        const xr = r[i];
        const dl = this.delayPush(this.preDelayL, xl, this.preDelayPosL);
        this.preDelayPosL = this.advancePos(this.preDelayPosL, this.preDelayL.length);
        const dr = this.delayPush(this.preDelayR, xr, this.preDelayPosR);
        this.preDelayPosR = this.advancePos(this.preDelayPosR, this.preDelayR.length);
        const wetL = this.left.process(dl);
        const wetR = this.right.process(dr);
        l[i] = xl * this.dry + wetL * this.wet1 + wetR * this.wet2;
        r[i] = xr * this.dry + wetR * this.wet1 + wetL * this.wet2;
      }
    }
    reset() {
      this.left.reset();
      this.right.reset();
      this.preDelayL.fill(0);
      this.preDelayR.fill(0);
      this.preDelayPosL = 0;
      this.preDelayPosR = 0;
    }
    /** 环形延迟线:写入 x,返回 preDelayLen 前的样本(preDelay=0 时恒等) */
    delayPush(line, x, pos) {
      if (this.preDelayLen === 0) return x;
      const size = line.length;
      let readPos = pos - this.preDelayLen;
      if (readPos < 0) readPos += size;
      const out = line[readPos];
      line[pos] = x;
      return out;
    }
    /** 环形延迟线写后位置前进(带环绕) */
    advancePos(pos, size) {
      let np = pos + 1;
      if (np >= size) np = 0;
      return np;
    }
  };
  function normalizeLines(v) {
    const n = v === void 0 ? 8 : Math.trunc(v);
    if (n !== 2 && n !== 4 && n !== 8 && n !== 16) {
      throw new Error(`FdnReverb: lines \u5FC5\u987B\u4E3A 2/4/8/16,\u6536\u5230 ${v}`);
    }
    return n;
  }
  function clamp012(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // src/dsp/DynamicEq.ts
  var BAND_COUNT = 5;
  var DEFAULT_CROSSOVER_HZ = [200, 800, 2500, 8e3];
  var DYNAMIC_EQ_BAND_NAMES = ["low", "low-mid", "mid", "high-mid", "high"];
  var GAIN_MIN = 0;
  var GAIN_MAX = 3;
  function clamp5(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function onePoleCoef4(timeMs, fs, floorMs) {
    const ms = Math.max(timeMs, floorMs);
    return 1 - Math.exp(-1 / (ms / 1e3 * fs));
  }
  function crossoverCoeffs(fc, fs) {
    const wc = 2 * Math.PI * fc / fs;
    const a1 = -Math.tan(Math.PI / 4 - wc / 2);
    return { lp: 0.5 * (1 + a1), hp: 0.5 * (1 - a1), a1 };
  }
  var DynamicEq = class {
    fs;
    enabled = true;
    strength = 1;
    thresholdDb = -20;
    ratio = 2;
    kneeDb = 6;
    attackCoef = 0;
    releaseCoef = 0;
    blockSize = 128;
    /** 每带状态(全部在构造期初始化,process 内零分配) */
    bandEnabled = new Array(BAND_COUNT).fill(true);
    crossFreqs = Float64Array.from(DEFAULT_CROSSOVER_HZ);
    staticDb = new Float64Array(BAND_COUNT);
    sumsq = new Float64Array(BAND_COUNT);
    levelsDb = new Float64Array(BAND_COUNT);
    targetGains = new Float64Array(BAND_COUNT).fill(1);
    gains = new Float64Array(BAND_COUNT).fill(1);
    /** 交叉树:每通道 LP1,HP1,LP2,HP2,LP3,HP3,LP4,HP4(共 8 个 Biquad) */
    treeL = [];
    treeR = [];
    constructor(fs, params) {
      if (!(fs > 0) || !Number.isFinite(fs)) throw new Error("invalid sample rate");
      this.fs = fs;
      for (let i = 0; i < 8; i++) {
        this.treeL.push(new Biquad());
        this.treeR.push(new Biquad());
      }
      this.applyParams(params ?? {});
    }
    setParams(p) {
      this.applyParams(p);
    }
    /** 参数即时生效:钳制 + 系数重算;增益/包络状态保留(避免参数变化时爆音) */
    applyParams(p) {
      const fs = this.fs;
      const nyq = fs / 2;
      this.enabled = p.enabled ?? this.enabled;
      this.strength = clamp5(p.strength ?? this.strength, 0, 1);
      this.thresholdDb = clamp5(p.thresholdDb ?? this.thresholdDb, -80, 0);
      this.ratio = clamp5(p.ratio ?? this.ratio, 1, 100);
      this.kneeDb = clamp5(p.kneeDb ?? this.kneeDb, 0, 40);
      this.attackCoef = onePoleCoef4(p.attackMs ?? this.currentAttackMs(), fs, 0.05);
      this.releaseCoef = onePoleCoef4(p.releaseMs ?? this.currentReleaseMs(), fs, 1);
      this.blockSize = Math.max(16, Math.min(2048, Math.floor(p.blockSize ?? this.blockSize)));
      const bands = p.bands;
      if (bands !== void 0) {
        for (let i = 0; i < BAND_COUNT; i++) {
          const b = bands[i];
          if (b !== void 0) {
            this.bandEnabled[i] = b.enabled;
            this.staticDb[i] = clamp5(b.targetGainDb ?? this.staticDb[i], -12, 12);
            if (i < BAND_COUNT - 1) this.crossFreqs[i] = clamp5(b.frequency, 30, nyq * 0.9);
          }
        }
      }
      this.updateCrossover();
    }
    /** 反解当前 attack/release 毫秒(供 setParams 未指定时保持原平滑时间) */
    currentAttackMs() {
      return this.attackCoef === 0 ? 20 : -1e3 / (this.fs * Math.log(1 - this.attackCoef));
    }
    currentReleaseMs() {
      return this.releaseCoef === 0 ? 200 : -1e3 / (this.fs * Math.log(1 - this.releaseCoef));
    }
    /** 按当前交叉频率重算交叉树系数(仅 setParams 时调用) */
    updateCrossover() {
      const fs = this.fs;
      for (let i = 0; i < BAND_COUNT - 1; i++) {
        const { lp, hp, a1 } = crossoverCoeffs(this.crossFreqs[i], fs);
        const cl = { b0: lp, b1: lp, b2: 0, a1, a2: 0 };
        const ch = { b0: hp, b1: -hp, b2: 0, a1, a2: 0 };
        this.treeL[2 * i].setCoeffs(cl);
        this.treeL[2 * i + 1].setCoeffs(ch);
        this.treeR[2 * i].setCoeffs(cl);
        this.treeR[2 * i + 1].setCoeffs(ch);
      }
    }
    /**
     * 就地处理立体声(l/r 原地改写),内部按 blockSize 分块:
     * 每块先以当前(上一块算出的)目标增益逐样本平滑处理,块末由本块能量
     * 更新目标增益 —— 控制延迟一个分析块,增益平滑掩盖块粒度。
     */
    processStereo(l, r, frameCount) {
      if (l.length !== r.length) throw new Error("dynamiceq: L/R length mismatch");
      if (!this.enabled || this.strength <= 0) return;
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const block = this.blockSize;
      const attack = this.attackCoef;
      const release = this.releaseCoef;
      const invRatio = 1 - 1 / this.ratio;
      const knee = this.kneeDb;
      const kneeHalf = knee * 0.5;
      const twoKnee = 2 * knee;
      const thr = this.thresholdDb;
      const strength = this.strength;
      const gains = this.gains;
      const targets = this.targetGains;
      const sumsq = this.sumsq;
      const levels = this.levelsDb;
      const bandEn = this.bandEnabled;
      const staticDb = this.staticDb;
      const tL = this.treeL;
      const tR = this.treeR;
      let pos = 0;
      while (pos < n) {
        const end = Math.min(pos + block, n);
        const len = end - pos;
        for (let b = 0; b < BAND_COUNT; b++) sumsq[b] = 0;
        const invN = 1 / (2 * len);
        for (let i = pos; i < end; i++) {
          const xl = l[i];
          const xr = r[i];
          const r1l = tL[1].process(xl);
          const b0l = tL[0].process(xl);
          const r2l = tL[3].process(r1l);
          const b1l = tL[2].process(r1l);
          const r3l = tL[5].process(r2l);
          const b2l = tL[4].process(r2l);
          const r4l = tL[7].process(r3l);
          const b3l = tL[6].process(r3l);
          const b4l = r4l;
          const r1r = tR[1].process(xr);
          const b0r = tR[0].process(xr);
          const r2r = tR[3].process(r1r);
          const b1r = tR[2].process(r1r);
          const r3r = tR[5].process(r2r);
          const b2r = tR[4].process(r2r);
          const r4r = tR[7].process(r3r);
          const b3r = tR[6].process(r3r);
          const b4r = r4r;
          sumsq[0] += b0l * b0l + b0r * b0r;
          sumsq[1] += b1l * b1l + b1r * b1r;
          sumsq[2] += b2l * b2l + b2r * b2r;
          sumsq[3] += b3l * b3l + b3r * b3r;
          sumsq[4] += b4l * b4l + b4r * b4r;
          const t0 = targets[0], t1 = targets[1], t2 = targets[2], t3 = targets[3], t4 = targets[4];
          let g0 = gains[0], g1 = gains[1], g2 = gains[2], g3 = gains[3], g4 = gains[4];
          g0 += (t0 < g0 ? attack : release) * (t0 - g0);
          g1 += (t1 < g1 ? attack : release) * (t1 - g1);
          g2 += (t2 < g2 ? attack : release) * (t2 - g2);
          g3 += (t3 < g3 ? attack : release) * (t3 - g3);
          g4 += (t4 < g4 ? attack : release) * (t4 - g4);
          gains[0] = g0;
          gains[1] = g1;
          gains[2] = g2;
          gains[3] = g3;
          gains[4] = g4;
          l[i] = g0 * b0l + g1 * b1l + g2 * b2l + g3 * b3l + g4 * b4l;
          r[i] = g0 * b0r + g1 * b1r + g2 * b2r + g3 * b3r + g4 * b4r;
        }
        for (let b = 0; b < BAND_COUNT; b++) {
          const levelDb = 10 * Math.log10(sumsq[b] * invN + 1e-12);
          levels[b] = levelDb;
          const over = levelDb - thr;
          let reduction;
          if (knee <= 0) {
            reduction = over > 0 ? over * invRatio : 0;
          } else if (over < -kneeHalf) {
            reduction = 0;
          } else if (over > kneeHalf) {
            reduction = over * invRatio;
          } else {
            const x = over + kneeHalf;
            reduction = invRatio * x * x / twoKnee;
          }
          const targetDb = staticDb[b] - reduction;
          const targetLin = Math.pow(10, targetDb / 20);
          const mixed = 1 + strength * (targetLin - 1);
          targets[b] = bandEn[b] ? Math.min(Math.max(mixed, GAIN_MIN), GAIN_MAX) : 1;
        }
        pos = end;
      }
    }
    /** 当前每带平滑增益(线性,5 项;单位增益 = 1 = 无处理) */
    getBandGains() {
      return Array.from(this.gains);
    }
    /** 最近一次分析的各带电平 dB(5 项,调试 / UI 用) */
    getBandLevelsDb() {
      return Array.from(this.levelsDb);
    }
    /** 频带名称(5 项) */
    getBandNames() {
      return DYNAMIC_EQ_BAND_NAMES.slice();
    }
    /** 复位:清空全部滤波器状态与增益/目标/电平(重放与首次一致) */
    reset() {
      for (let i = 0; i < this.treeL.length; i++) {
        this.treeL[i].reset();
        this.treeR[i].reset();
      }
      this.sumsq.fill(0);
      this.levelsDb.fill(0);
      this.targetGains.fill(1);
      this.gains.fill(1);
    }
  };

  // src/dsp/LufsMeter.ts
  function rbjHighPass(f0, q, fs) {
    const w0 = 2 * Math.PI * f0 / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const cw = Math.cos(w0);
    const b0 = (1 + cw) / 2;
    const b1 = -(1 + cw);
    const b2 = b0;
    const a0 = 1 + alpha;
    const a1 = -2 * cw;
    const a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function shelfCoeffs(fs) {
    const f0 = 1681.974450955533;
    const gDb = 3.999843853973347;
    const q = 0.7071752369554196;
    const k = Math.tan(Math.PI * f0 / fs);
    const vh = Math.pow(10, gDb / 20);
    const vb = Math.pow(vh, 0.4996667741545416);
    const a0 = 1 + k / q + k * k;
    return {
      b0: (vh + vb * k / q + k * k) / a0,
      b1: 2 * (k * k - vh) / a0,
      b2: (vh - vb * k / q + k * k) / a0,
      a1: 2 * (k * k - 1) / a0,
      a2: (1 - k / q + k * k) / a0
    };
  }
  var TRUE_PEAK_OVS = 4;
  var TRUE_PEAK_TAPS_PER_PHASE = 24;
  var TRUE_PEAK_HIST = 2 * TRUE_PEAK_TAPS_PER_PHASE;
  var LufsMeter = class _LufsMeter {
    blockLen;
    // 400ms
    hopLen;
    // 100ms
    // K 加权滤波状态：左/右 × 两级
    rlbL;
    shelfL;
    rlbR;
    shelfR;
    // 滑动窗口（400ms）内 z² 之和与 z 环形缓冲
    zBuf;
    zPos = 0;
    sumSq = 0;
    totalSamples = 0;
    // 块历史（环形；容量 = 1 小时 @100ms 步进）
    static BLOCK_CAP = 36e3;
    blockLoud = new Float32Array(_LufsMeter.BLOCK_CAP);
    blockPower = new Float32Array(_LufsMeter.BLOCK_CAP);
    blockWrite = 0;
    blockCount = 0;
    // 短时（3s = 30 块）功率环形
    static SHORT_CAP = 30;
    shortPower = new Float32Array(_LufsMeter.SHORT_CAP);
    shortWrite = 0;
    shortCount = 0;
    // 峰值
    peak = 0;
    truePeak = 0;
    // 真峰值 4× 多相插值（每通道）
    tpKernel = new Float32Array(TRUE_PEAK_OVS * TRUE_PEAK_HIST);
    histL = new Float32Array(TRUE_PEAK_HIST);
    histR = new Float32Array(TRUE_PEAK_HIST);
    histPos = 0;
    histFull = false;
    // LRA 排序暂存
    sortScratch = new Float32Array(_LufsMeter.BLOCK_CAP);
    constructor(fs) {
      if (fs <= 0 || !Number.isFinite(fs)) {
        throw new Error("invalid sample rate");
      }
      const useFs = fs === 44100 || fs === 48e3 ? fs : 48e3;
      const rlb = rbjHighPass(38.135822, 0.5, useFs);
      const shelf = shelfCoeffs(useFs);
      this.rlbL = { c: rlb, z1: 0, z2: 0 };
      this.shelfL = { c: shelf, z1: 0, z2: 0 };
      this.rlbR = { c: rlb, z1: 0, z2: 0 };
      this.shelfR = { c: shelf, z1: 0, z2: 0 };
      this.blockLen = Math.max(1, Math.round(0.4 * fs));
      this.hopLen = Math.max(1, Math.round(0.1 * fs));
      this.zBuf = new Float32Array(this.blockLen);
      for (let phi = 0; phi < TRUE_PEAK_OVS; phi++) {
        let sum = 0;
        const base = phi * TRUE_PEAK_HIST;
        for (let j = 0; j < TRUE_PEAK_HIST; j++) {
          const u = j - (TRUE_PEAK_TAPS_PER_PHASE - 1) + phi / TRUE_PEAK_OVS;
          let c;
          if (Math.abs(u) < 1e-9) c = 1;
          else c = Math.sin(Math.PI * u / TRUE_PEAK_OVS) / (Math.PI * u / TRUE_PEAK_OVS);
          const xw = u / TRUE_PEAK_TAPS_PER_PHASE;
          if (Math.abs(xw) <= 1) {
            c *= 0.42 + 0.5 * Math.cos(Math.PI * xw) + 0.08 * Math.cos(2 * Math.PI * xw);
          } else {
            c = 0;
          }
          this.tpKernel[base + j] = c;
          sum += c;
        }
        if (sum !== 0) {
          for (let j = 0; j < TRUE_PEAK_HIST; j++) this.tpKernel[base + j] /= sum;
        }
      }
    }
    /** 就地分析立体声（L/R 均过 K 加权；z = L'+R'） */
    processStereo(l, r, frameCount) {
      const B = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      for (let i = 0; i < B; i++) {
        const xl = l[i];
        const xr = r[i];
        const rl = this.rlbL;
        const y1l = rl.c.b0 * xl + rl.z1;
        rl.z1 = rl.c.b1 * xl - rl.c.a1 * y1l + rl.z2;
        rl.z2 = rl.c.b2 * xl - rl.c.a2 * y1l;
        const sl = this.shelfL;
        const yl = sl.c.b0 * y1l + sl.z1;
        sl.z1 = sl.c.b1 * y1l - sl.c.a1 * yl + sl.z2;
        sl.z2 = sl.c.b2 * y1l - sl.c.a2 * yl;
        const rr = this.rlbR;
        const y1r = rr.c.b0 * xr + rr.z1;
        rr.z1 = rr.c.b1 * xr - rr.c.a1 * y1r + rr.z2;
        rr.z2 = rr.c.b2 * xr - rr.c.a2 * y1r;
        const sr = this.shelfR;
        const yr = sr.c.b0 * y1r + sr.z1;
        sr.z1 = sr.c.b1 * y1r - sr.c.a1 * yr + sr.z2;
        sr.z2 = sr.c.b2 * y1r - sr.c.a2 * yr;
        const z = yl + yr;
        const zsq = z * z;
        const evict = this.zBuf[this.zPos];
        this.zBuf[this.zPos] = z;
        this.zPos++;
        if (this.zPos >= this.blockLen) this.zPos = 0;
        this.sumSq += zsq - evict * evict;
        this.totalSamples++;
        const aL = xl < 0 ? -xl : xl;
        const aR = xr < 0 ? -xr : xr;
        if (aL > this.peak) this.peak = aL;
        if (aR > this.peak) this.peak = aR;
        this.histL[this.histPos] = xl;
        this.histR[this.histPos] = xr;
        this.histPos++;
        if (this.histPos >= TRUE_PEAK_HIST) {
          this.histPos = 0;
          this.histFull = true;
        }
        this.updateTruePeakInterp(this.histL);
        this.updateTruePeakInterp(this.histR);
        if (this.totalSamples >= this.blockLen && (this.totalSamples - this.blockLen) % this.hopLen === 0) {
          this.recordBlock();
        }
      }
    }
    /** 整合响度 LUFS（绝对 -70 + 相对 -10 双门限）；未测到返回 NaN */
    getIntegratedLufs() {
      if (this.blockCount === 0) return NaN;
      const cap = _LufsMeter.BLOCK_CAP;
      const start = (this.blockWrite - this.blockCount + cap) % cap;
      let sumP1 = 0;
      let sumL1 = 0;
      let n1 = 0;
      for (let k = 0; k < this.blockCount; k++) {
        const idx = (start + k) % cap;
        const lk = this.blockLoud[idx];
        if (lk >= -70) {
          sumP1 += this.blockPower[idx];
          sumL1 += lk;
          n1++;
        }
      }
      if (n1 === 0) return NaN;
      const gate = sumL1 / n1 - 10;
      let sumP2 = 0;
      let n2 = 0;
      for (let k = 0; k < this.blockCount; k++) {
        const idx = (start + k) % cap;
        const lk = this.blockLoud[idx];
        if (lk >= -70 && lk >= gate) {
          sumP2 += this.blockPower[idx];
          n2++;
        }
      }
      if (n2 === 0) return NaN;
      return -0.691 + 10 * Math.log10(sumP2 / n2);
    }
    /** 瞬时响度（最新一个完整 400ms 块）；未测到返回 NaN */
    getMomentaryLufs() {
      if (this.blockCount === 0) return NaN;
      const cap = _LufsMeter.BLOCK_CAP;
      const last = (this.blockWrite - 1 + cap) % cap;
      const v = this.blockLoud[last];
      return Number.isNaN(v) ? NaN : v;
    }
    /** 短时响度（最近 3s = 30 块功率均值）；不足 30 块返回 NaN */
    getShortTermLufs() {
      if (this.shortCount < _LufsMeter.SHORT_CAP) return NaN;
      let sum = 0;
      const cap = _LufsMeter.SHORT_CAP;
      for (let k = 0; k < cap; k++) {
        const idx = (this.shortWrite - cap + k + 2 * cap) % cap;
        sum += this.shortPower[idx];
      }
      if (sum <= 1e-30) return NaN;
      return -0.691 + 10 * Math.log10(sum / cap);
    }
    /** LRA（EBU Tech 3342）：绝对 -70 + 相对 -20 门限后 10/95 百分位差（LU） */
    getLra() {
      if (this.blockCount < 2) return NaN;
      const cap = _LufsMeter.BLOCK_CAP;
      const start = (this.blockWrite - this.blockCount + cap) % cap;
      let sumL = 0;
      let n1 = 0;
      for (let k = 0; k < this.blockCount; k++) {
        const idx = (start + k) % cap;
        const lk = this.blockLoud[idx];
        if (lk >= -70) {
          sumL += lk;
          n1++;
        }
      }
      if (n1 < 2) return NaN;
      const gate = sumL / n1 - 20;
      let m = 0;
      for (let k = 0; k < this.blockCount; k++) {
        const idx = (start + k) % cap;
        const lk = this.blockLoud[idx];
        if (lk >= -70 && lk >= gate) {
          this.sortScratch[m++] = lk;
        }
      }
      if (m < 2) return NaN;
      const arr = this.sortScratch.subarray(0, m);
      arr.sort();
      const p10 = this.percentile(arr, 0.1);
      const p95 = this.percentile(arr, 0.95);
      return p95 - p10;
    }
    /** 样本峰值 dBFS（全静音返回 -Infinity） */
    getPeakDb() {
      if (this.peak <= 0) return -Infinity;
      return 20 * Math.log10(this.peak);
    }
    /** 真峰值 dBFS（4× 过采样；全静音返回 -Infinity） */
    getTruePeakDb() {
      if (this.truePeak <= 0) return -Infinity;
      return 20 * Math.log10(this.truePeak);
    }
    reset() {
      this.zBuf.fill(0);
      this.zPos = 0;
      this.sumSq = 0;
      this.totalSamples = 0;
      this.blockLoud.fill(0);
      this.blockPower.fill(0);
      this.blockWrite = 0;
      this.blockCount = 0;
      this.shortPower.fill(0);
      this.shortWrite = 0;
      this.shortCount = 0;
      this.peak = 0;
      this.truePeak = 0;
      this.histL.fill(0);
      this.histR.fill(0);
      this.histPos = 0;
      this.histFull = false;
      this.rlbL.z1 = 0;
      this.rlbL.z2 = 0;
      this.shelfL.z1 = 0;
      this.shelfL.z2 = 0;
      this.rlbR.z1 = 0;
      this.rlbR.z2 = 0;
      this.shelfR.z1 = 0;
      this.shelfR.z2 = 0;
    }
    // ---------------------------------------------------------------- 内部
    /** 记录一个完整 400ms 块（静音块响度记 NaN，避免 -Infinity 泄漏） */
    recordBlock() {
      const p = this.sumSq / this.blockLen;
      const lk = p > 1e-30 ? -0.691 + 10 * Math.log10(p) : NaN;
      const cap = _LufsMeter.BLOCK_CAP;
      this.blockLoud[this.blockWrite] = lk;
      this.blockPower[this.blockWrite] = p;
      this.blockWrite++;
      if (this.blockWrite >= cap) this.blockWrite = 0;
      if (this.blockCount < cap) this.blockCount++;
      const sc = _LufsMeter.SHORT_CAP;
      this.shortPower[this.shortWrite] = p;
      this.shortWrite++;
      if (this.shortWrite >= sc) this.shortWrite = 0;
      if (this.shortCount < sc) this.shortCount++;
    }
    /** 线性插值百分位（arr 必须已升序；p ∈ [0,1]） */
    percentile(arr, p) {
      const n = arr.length;
      if (n === 1) return arr[0];
      const rank = p * (n - 1);
      const lo = Math.floor(rank);
      const hi = Math.min(n - 1, lo + 1);
      const frac = rank - lo;
      return arr[lo] + frac * (arr[hi] - arr[lo]);
    }
    /**
     * 真峰值插值：历史满后对滞后一个核长的位置做 4× 插值取峰。
     * 位置 t = 最新样本索引 - TAPS_PER_PHASE（滞后保证核窗口因果可用）。
     * 注意：历史环形缓冲的写入游标由 processStereo 每样本推进一次（左右通道
     * 共用同一游标），此处只读不写。
     */
    updateTruePeakInterp(hist) {
      if (!this.histFull) return;
      const t = this.totalSamples - 1 - TRUE_PEAK_TAPS_PER_PHASE;
      if (t < 0) return;
      for (let phi = 0; phi < TRUE_PEAK_OVS; phi++) {
        const base = phi * TRUE_PEAK_HIST;
        let y = 0;
        for (let j = 0; j < TRUE_PEAK_HIST; j++) {
          const idx = t - j + TRUE_PEAK_TAPS_PER_PHASE - 1;
          const ringIdx = (idx % TRUE_PEAK_HIST + TRUE_PEAK_HIST) % TRUE_PEAK_HIST;
          y += this.tpKernel[base + j] * hist[ringIdx];
        }
        if (y < 0) y = -y;
        if (y > this.truePeak) this.truePeak = y;
      }
    }
  };

  // src/dsp/LoudnessComp.ts
  var THIRD_OCTAVE_FREQS = [
    20,
    25,
    31.5,
    40,
    50,
    63,
    80,
    100,
    125,
    160,
    200,
    250,
    315,
    400,
    500,
    630,
    800,
    1e3,
    1250,
    1600,
    2e3,
    2500,
    3150,
    4e3,
    5e3,
    6300,
    8e3,
    1e4,
    12500,
    16e3,
    2e4
  ];
  var PEAKING_CANDIDATES = [315, 630, 1e3, 1600, 2500, 4e3, 6300];
  var PRESET_CURVES = {
    flat: [],
    bass: [
      [63, 6],
      [100, 5],
      [160, 4],
      [250, 2.5],
      [400, 1.5],
      [630, 0.5],
      [1e3, 0],
      [2e3, 0],
      [4e3, -0.5],
      [8e3, -1],
      [12e3, -1.5]
    ],
    vocal: [
      [100, 0],
      [200, 0.5],
      [400, 1.5],
      [800, 2.5],
      [1e3, 3],
      [2e3, 3.5],
      [3e3, 3],
      [5e3, 2],
      [8e3, 1],
      [12e3, 0.5]
    ],
    warm: [
      [63, 2],
      [100, 2.5],
      [200, 3],
      [400, 2.5],
      [800, 1.5],
      [1600, 0.5],
      [3e3, 0],
      [6e3, -1],
      [1e4, -1.5],
      [16e3, -2]
    ],
    bright: [
      [63, 0],
      [200, 0],
      [500, 0.5],
      [1e3, 1],
      [2e3, 1.5],
      [4e3, 2.5],
      [6300, 3],
      [1e4, 3],
      [16e3, 2.5]
    ],
    night: [
      [63, 4],
      [100, 3.5],
      [200, 2.5],
      [400, 1.5],
      [800, 0.5],
      [1600, 0],
      [3e3, -1],
      [6e3, -2],
      [1e4, -2.5],
      [16e3, -3]
    ]
  };
  var MAX_BANDS = 6;
  var LoudnessComp = class {
    fs;
    // 当前目标参数（setParams 计算）
    mode = "auto";
    volumePercent = 100;
    maxBoostDb = 12;
    preset = "flat";
    smoothingSeconds = 0.2;
    targetGains = new Float64Array(MAX_BANDS);
    targetFreqs = new Float64Array(MAX_BANDS);
    targetTypes = new Int32Array(MAX_BANDS);
    // 0=low shelf,1=high shelf,2=peaking
    currentGains = new Float64Array(MAX_BANDS);
    // 内部 biquad 链（6 段，0 增益时为恒等）；左右声道各自独立状态，
    // 避免"一链两声道"时另一声道的处理污染本声道滤波器状态（等效频率翻倍失真）。
    bq = [];
    bqR = [];
    constructor(fs) {
      if (fs <= 0 || !Number.isFinite(fs)) {
        throw new Error("invalid sample rate");
      }
      this.fs = fs;
      for (let i = 0; i < MAX_BANDS; i++) {
        this.bq.push({ c: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, z1: 0, z2: 0 });
        this.bqR.push({ c: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, z1: 0, z2: 0 });
      }
      for (let i = 0; i < MAX_BANDS; i++) {
        this.bq[i].c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
        this.bqR[i].c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
      }
    }
    setParams(p) {
      this.mode = p.mode === "auto" || p.mode === "preset" || p.mode === "custom" ? p.mode : "auto";
      this.volumePercent = clamp6(p.volumePercent, 0, 100);
      this.maxBoostDb = clamp6(p.maxBoostDb, 0, 24);
      this.preset = typeof p.preset === "string" ? p.preset : "flat";
      this.smoothingSeconds = clamp6(p.smoothingSeconds, 0.01, 10);
      const bands = Array.isArray(p.bands) ? p.bands : [];
      const targets = this.computeTargets(bands);
      this.targetGains.set(targets.gains);
      this.targetFreqs.set(targets.freqs);
      this.targetTypes.set(targets.types);
    }
    /** 就地处理立体声；6 段 biquad 级联 + 逐块增益平滑 */
    processStereo(l, r, frameCount) {
      const B = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const alpha = 1 - Math.exp(-B / (this.smoothingSeconds * this.fs));
      for (let i = 0; i < MAX_BANDS; i++) {
        const target = this.targetGains[i];
        const current = this.currentGains[i];
        if (current !== target) {
          let g = current + alpha * (target - current);
          if (Math.abs(g - target) < 1e-9) g = target;
          this.currentGains[i] = g;
          this.recomputeCoeffs(i, g);
        }
      }
      for (let i = 0; i < B; i++) {
        const xl = l[i];
        const xr = r[i];
        let yl = xl;
        let yr = xr;
        for (let k = 0; k < MAX_BANDS; k++) {
          yl = this.biquadStep(this.bq[k], yl);
          yr = this.biquadStep(this.bqR[k], yr);
        }
        l[i] = yl;
        r[i] = yr;
      }
    }
    reset() {
      for (let i = 0; i < MAX_BANDS; i++) {
        this.bq[i].z1 = 0;
        this.bq[i].z2 = 0;
        this.bqR[i].z1 = 0;
        this.bqR[i].z2 = 0;
        this.currentGains[i] = this.targetGains[i];
        this.recomputeCoeffs(i, this.targetGains[i]);
      }
    }
    // ---------------------------------------------------------------- 内部
    /** 按模式计算目标曲线并拟合为 2–6 段 */
    computeTargets(bands) {
      const gains = new Float64Array(MAX_BANDS);
      const freqs = new Float64Array(MAX_BANDS);
      const types = new Int32Array(MAX_BANDS);
      let n = 0;
      if (this.mode === "custom") {
        const low = bands.filter((b) => b.frequency <= 250);
        const high = bands.filter((b) => b.frequency >= 6e3);
        const mid = bands.filter((b) => b.frequency > 250 && b.frequency < 6e3);
        const lowGain2 = low.length > 0 ? average(low.map((b) => clamp6(b.gain, -24, 24))) : 0;
        const highGain2 = high.length > 0 ? average(high.map((b) => clamp6(b.gain, -24, 24))) : 0;
        if (Math.abs(lowGain2) >= 0.25) {
          gains[n] = lowGain2;
          freqs[n] = 120;
          types[n] = 0;
          n++;
        }
        if (Math.abs(highGain2) >= 0.25) {
          gains[n] = highGain2;
          freqs[n] = 12e3;
          types[n] = 1;
          n++;
        }
        const picked2 = mid.filter((b) => Math.abs(clamp6(b.gain, -24, 24)) >= 0.25).map((b) => ({ f: clamp6(b.frequency, 20, 2e4), g: clamp6(b.gain, -24, 24) })).sort((a, b) => Math.abs(b.g) - Math.abs(a.g) || a.f - b.f).slice(0, 4).sort((a, b) => a.f - b.f);
        for (const pk of picked2) {
          gains[n] = pk.g;
          freqs[n] = pk.f;
          types[n] = 2;
          n++;
        }
        return { gains, freqs, types };
      }
      const table = new Float64Array(THIRD_OCTAVE_FREQS.length);
      if (this.mode === "preset") {
        const curve = PRESET_CURVES[this.preset] || PRESET_CURVES.flat;
        for (let i = 0; i < THIRD_OCTAVE_FREQS.length; i++) {
          table[i] = interpLogCurve(THIRD_OCTAVE_FREQS[i], curve);
        }
      } else {
        const v = this.volumePercent / 100;
        for (let i = 0; i < THIRD_OCTAVE_FREQS.length; i++) {
          table[i] = this.maxBoostDb * (1 - v) * autoWeight(THIRD_OCTAVE_FREQS[i]);
        }
      }
      const lowGain = table[THIRD_OCTAVE_FREQS.indexOf(100)];
      const highGain = table[THIRD_OCTAVE_FREQS.indexOf(1e4)];
      if (Math.abs(lowGain) >= 0.25) {
        gains[n] = lowGain;
        freqs[n] = 120;
        types[n] = 0;
        n++;
      }
      if (Math.abs(highGain) >= 0.25) {
        gains[n] = highGain;
        freqs[n] = 12e3;
        types[n] = 1;
        n++;
      }
      const picked = [];
      for (const f of PEAKING_CANDIDATES) {
        const g = table[THIRD_OCTAVE_FREQS.indexOf(f)];
        if (Math.abs(g) >= 0.25) picked.push({ f, g });
      }
      picked.sort((a, b) => Math.abs(b.g) - Math.abs(a.g) || a.f - b.f);
      const top = picked.slice(0, 4).sort((a, b) => a.f - b.f);
      for (const pk of top) {
        gains[n] = pk.g;
        freqs[n] = pk.f;
        types[n] = 2;
        n++;
      }
      return { gains, freqs, types };
    }
    /** 按当前平滑增益重算某段 biquad 系数 */
    recomputeCoeffs(idx, gainDb) {
      const f = this.targetFreqs[idx];
      const type = this.targetTypes[idx];
      const c = type === 0 ? designShelf(true, f, gainDb, this.fs) : type === 1 ? designShelf(false, f, gainDb, this.fs) : designPeaking(f, gainDb, 1, this.fs);
      this.bq[idx].c = c;
      this.bqR[idx].c = c;
    }
    /** TDF2 一步 */
    biquadStep(b, x) {
      const y = b.c.b0 * x + b.z1;
      b.z1 = b.c.b1 * x - b.c.a1 * y + b.z2;
      b.z2 = b.c.b2 * x - b.c.a2 * y;
      return y;
    }
  };
  function clamp6(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }
  function average(arr) {
    if (arr.length === 0) return 0;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  }
  function autoWeight(f) {
    if (f <= 100) return 1;
    if (f < 250) {
      const t = (Math.log10(f) - Math.log10(100)) / (Math.log10(250) - Math.log10(100));
      return 1 - t;
    }
    if (f < 2e3) return 0;
    if (f < 1e4) {
      const t = (Math.log10(f) - Math.log10(2e3)) / (Math.log10(1e4) - Math.log10(2e3));
      return 0.15 / 0.35 * t;
    }
    return 0.15 / 0.35;
  }
  function interpLogCurve(f, pts) {
    if (pts.length === 0) return 0;
    if (pts.length === 1) return pts[0][1];
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    if (f <= sorted[0][0]) return sorted[0][1];
    if (f >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
    for (let i = 0; i < sorted.length - 1; i++) {
      const [f0, g0] = sorted[i];
      const [f1, g1] = sorted[i + 1];
      if (f >= f0 && f <= f1) {
        if (f === f0) return g0;
        if (f === f1) return g1;
        const t = (Math.log10(f) - Math.log10(f0)) / (Math.log10(f1) - Math.log10(f0));
        return g0 + t * (g1 - g0);
      }
    }
    return 0;
  }
  function designPeaking(f0, gainDb, q, fs) {
    const f = Math.min(Math.max(f0, 1), fs * 0.45);
    const a = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const cw = Math.cos(w0);
    const b0 = 1 + alpha * a;
    const b1 = -2 * cw;
    const b2 = 1 - alpha * a;
    const a0 = 1 + alpha / a;
    const a1 = -2 * cw;
    const a2 = 1 - alpha / a;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function designShelf(isLow, f0, gainDb, fs) {
    const f = Math.min(Math.max(f0, 1), fs * 0.45);
    const a = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f / fs;
    const alpha = Math.sin(w0) / 2 * Math.SQRT2;
    const cw = Math.cos(w0);
    const sa = Math.sqrt(a);
    if (isLow) {
      const b02 = a * (a + 1 - (a - 1) * cw + 2 * sa * alpha);
      const b12 = 2 * a * (a - 1 - (a + 1) * cw);
      const b22 = a * (a + 1 - (a - 1) * cw - 2 * sa * alpha);
      const a02 = a + 1 + (a - 1) * cw + 2 * sa * alpha;
      const a12 = -2 * (a - 1 + (a + 1) * cw);
      const a22 = a + 1 + (a - 1) * cw - 2 * sa * alpha;
      return { b0: b02 / a02, b1: b12 / a02, b2: b22 / a02, a1: a12 / a02, a2: a22 / a02 };
    }
    const b0 = a * (a + 1 + (a - 1) * cw + 2 * sa * alpha);
    const b1 = -2 * a * (a - 1 + (a + 1) * cw);
    const b2 = a * (a + 1 + (a - 1) * cw - 2 * sa * alpha);
    const a0 = a + 1 - (a - 1) * cw + 2 * sa * alpha;
    const a1 = 2 * (a - 1 - (a + 1) * cw);
    const a2 = a + 1 - (a - 1) * cw - 2 * sa * alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  // src/dsp/Resampler.ts
  var Resampler = class {
    inRate;
    outRate;
    channels;
    taps;
    half;
    // L = taps/2
    ratio;
    // 输入样本数 / 输出样本数（每个输出样本对应的输入相位步进）
    cutoff;
    table;
    // 多相表：(PH+1) 行 × taps 列
    ph;
    // 相位数
    // ---- 流式状态（环形缓冲） ----
    ring;
    // 容量 (taps+16)×ch 的环形缓冲（交错）
    inTotal = 0;
    // 累计已接收输入帧数（每声道）
    outPos = 0;
    // 已产生的输出帧数（每声道）
    /** quality 0..10（默认 8）：控制抽头数（4 << (quality>>1)）与 Kaiser β。 */
    constructor(inRate, outRate, channels = 1, quality = 8) {
      if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate <= 0 || outRate <= 0) {
        throw new Error("invalid sample rate");
      }
      if (!Number.isInteger(channels) || channels < 1) throw new Error("invalid channel count");
      const q = Math.min(10, Math.max(0, Math.floor(quality)));
      this.inRate = inRate;
      this.outRate = outRate;
      this.channels = channels;
      this.taps = 4 << (q >> 1);
      this.half = this.taps / 2;
      this.ratio = inRate / outRate;
      this.cutoff = Math.min(1, outRate / inRate);
      this.ph = 256;
      this.table = this.buildTable(6 + q * 0.35);
      this.ring = new Float32Array((this.taps + 16) * channels);
    }
    /** 构建多相表：行 = 相位 p/PH（p=0..PH，PH 行与 0 行相同用于环绕插值），列 = taps 个抽头。 */
    buildTable(beta) {
      const rows = this.ph + 1;
      const t = new Float32Array(rows * this.taps);
      const i0b = besselI0(beta);
      const L = this.half;
      for (let p = 0; p < rows; p++) {
        const f = p / this.ph;
        const base = p * this.taps;
        for (let k = 0; k < this.taps; k++) {
          const u = k - (L - 1) - f;
          let h = 0;
          if (u > -L && u < L) {
            const s = u === 0 ? 1 : Math.sin(Math.PI * this.cutoff * u) / (Math.PI * this.cutoff * u);
            const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - u / L * (u / L)))) / i0b;
            h = this.cutoff * s * w;
          }
          t[base + k] = h;
        }
      }
      return t;
    }
    /**
     * 一次性重采样：返回新 Float32Array（长度 ≈ round(N·outRate/inRate)，每声道计）。
     * input 为（可选）多声道交错数据：长度必须是 channels 的整数倍。
     */
    process(input) {
      const ch = this.channels;
      if (input.length % ch !== 0) throw new Error("input length must be a multiple of channels");
      const nFrames = input.length / ch;
      const outFrames = Math.round(nFrames * (this.outRate / this.inRate));
      const out = new Float32Array(outFrames * ch);
      const L = this.half;
      const ph = this.ph;
      const taps = this.taps;
      const table = this.table;
      const ratio = this.ratio;
      const last = nFrames - 1;
      for (let m = 0; m < outFrames; m++) {
        const pos = m * ratio;
        const i = Math.floor(pos);
        const f = pos - i;
        const phReal = f * ph;
        const p0 = Math.floor(phReal);
        const fr = phReal - p0;
        const row0 = p0 * taps;
        const row1 = (p0 + 1) * taps;
        for (let c = 0; c < ch; c++) {
          let acc = 0;
          for (let k = 0; k < taps; k++) {
            const j = i + k - (L - 1);
            const xv = j < 0 ? 0 : j > last ? input[last * ch + c] : input[j * ch + c];
            const kk = table[row0 + k] + (table[row1 + k] - table[row0 + k]) * fr;
            acc += xv * kk;
          }
          out[m * ch + c] = acc;
        }
      }
      return out;
    }
    /**
     * 流式重采样：把 input 追加到内部环形缓冲，把当前可产生的输出写入 out。
     * 返回本次写入的每声道样本数（帧数）；out 空间不足时仅写入可用部分，
     * 剩余输出保留在内部状态，下次调用继续。
     *
     * 环形缓冲管理（自洽设计）：
     *  - 容量 cap = taps + 16（> 内核窗口宽度 2L，含安全余量）；
     *  - 采用"喂入/产出交错"：仅当下一输出 m 的内核窗口尾部 i(m)+L 已落入已接收样本
     *    （i+L < inTotal）时才产出，否则只喂入"恰好使其可产出"的样本量（≤ ceil(ratio)+1）；
     *  - 由此在产出过程中 i(m) 与 inTotal 保持同步（i ≈ inTotal−L），环形占用恒 ≤ 2L+16，
     *    旧样本在回绕时自然被覆盖，读 j%cap 恒为 x[j]；
     *  - j<0（流起始前）按静音补零，与 process() 头部语义一致。
     */
    processStreaming(input, out) {
      const ch = this.channels;
      if (input.length % ch !== 0) throw new Error("input length must be a multiple of channels");
      const inFrames = input.length / ch;
      const ring = this.ring;
      const cap = this.ring.length / ch;
      const L = this.half;
      const taps = this.taps;
      const ph = this.ph;
      const ratio = this.ratio;
      const table = this.table;
      const maxOut = Math.floor(out.length / ch);
      let pos = 0;
      let written = 0;
      while (pos < inFrames && written < maxOut) {
        const m = this.outPos;
        const i = Math.floor(m * ratio);
        if (i + L >= this.inTotal) {
          const take = Math.min(inFrames - pos, i + L + 1 - this.inTotal);
          for (let j = 0; j < take; j++) {
            const slot = (this.inTotal + j) % cap * ch;
            for (let c = 0; c < ch; c++) ring[slot + c] = input[(pos + j) * ch + c];
          }
          this.inTotal += take;
          pos += take;
        } else {
          const f = m * ratio - i;
          const phReal = f * ph;
          const p0 = Math.floor(phReal);
          const fr = phReal - p0;
          const row0 = p0 * taps;
          const row1 = (p0 + 1) * taps;
          for (let c = 0; c < ch; c++) {
            let acc = 0;
            for (let k = 0; k < taps; k++) {
              const j = i + k - (L - 1);
              const xv = j < 0 ? 0 : ring[j % cap * ch + c];
              const kk = table[row0 + k] + (table[row1 + k] - table[row0 + k]) * fr;
              acc += xv * kk;
            }
            out[written * ch + c] = acc;
          }
          this.outPos++;
          written++;
        }
      }
      return written;
    }
    /** 清空流式状态（环形缓冲 / 输出计数）；多相表与系数不变。 */
    reset() {
      this.ring.fill(0);
      this.inTotal = 0;
      this.outPos = 0;
    }
  };
  function besselI0(x) {
    if (x < 0) x = -x;
    let sum = 1;
    let term = 1;
    const x2 = x / 2 * (x / 2);
    for (let k = 1; k <= 40; k++) {
      term *= x2 / (k * k);
      sum += term;
      if (term < 1e-16 * sum) break;
    }
    return sum;
  }

  // src/dsp/HseStretch.ts
  var N = 2048;
  var HOP = 512;
  var HseStretch = class _HseStretch {
    /** 采样率（公开只读，构造时校验 > 0） */
    fs;
    /** 声道数（API 兼容保留；processStereo 固定处理双声道） */
    channels;
    rate = 1;
    semitones = 0;
    pitchScale = 1;
    // ---- 预分配缓冲（process 内零分配） ----
    win;
    // Hann 窗
    anaRe;
    anaIm;
    prevRe;
    prevIm;
    synRe;
    synIm;
    synPhase;
    // N/2+1：合成相位累积
    /** signalsmith 纯 DSP 模块缓存（由 isSignalsmithAvailable 探测填充） */
    static _signalsmith = null;
    constructor(fs, channels = 2) {
      if (!Number.isFinite(fs) || fs <= 0) throw new Error("invalid sample rate");
      if (!Number.isInteger(channels) || channels < 1) throw new Error("invalid channel count");
      this.fs = fs;
      this.channels = channels;
      this.win = hannWindow2(N);
      this.anaRe = new Float32Array(N);
      this.anaIm = new Float32Array(N);
      this.prevRe = new Float32Array(N);
      this.prevIm = new Float32Array(N);
      this.synRe = new Float32Array(N);
      this.synIm = new Float32Array(N);
      this.synPhase = new Float32Array(N / 2 + 1);
    }
    /** 参数即时生效；rate/semitones 做边界 clamp 避免 NaN/病态伸缩。 */
    setParams(p) {
      const r = clamp7(p.rate, 0.1, 8);
      const s = clamp7(p.semitones, -36, 36);
      const ps = Math.pow(2, s / 12);
      if (r !== this.rate || s !== this.semitones) {
        this.rate = r;
        this.semitones = s;
        this.pitchScale = ps;
        this.reset();
      } else {
        this.rate = r;
        this.semitones = s;
        this.pitchScale = ps;
      }
    }
    /**
     * 变速/变调处理立体声。输入输出为独立数组（不就地修改输入）。
     * 返回 { l, r }，长度 ≈ 输入 × rate（±3% 量级，见测试）。
     */
    processStereo(l, r) {
      if (_HseStretch._signalsmith) {
        const via = this._processWithSignalsmith(l, r);
        if (via) return via;
      }
      const rate = this.rate;
      const ps = this.pitchScale;
      return { l: this._processChannel(l, rate, ps), r: this._processChannel(r, rate, ps) };
    }
    /** 清空内部状态（相位累积 / 上一帧频谱 / 窗内缓冲）。 */
    reset() {
      this.prevRe.fill(0);
      this.prevIm.fill(0);
      this.synRe.fill(0);
      this.synIm.fill(0);
      this.synPhase.fill(0);
      this.anaRe.fill(0);
      this.anaIm.fill(0);
    }
    /**
     * 探测 signalsmith-stretch 是否可用于同步处理。
     * 说明：官方 npm 包（v1.x）为 Web Audio / AudioWorklet 包装，需要 AudioContext 且为异步，
     * 无法在纯 JS 环境同步调用，故本探测只认可"同步纯 DSP 类接口"（模块导出 HseStretch 类且含
     * process 方法）；否则返回 false 并回退自研相位声码器。动态 import 失败（未安装）同样回退。
     */
    static async isSignalsmithAvailable() {
      try {
        const spec = "signalsmith-stretch";
        const mod = await import(spec);
        const m = mod;
        if (m && typeof m.HseStretch === "function") {
          _HseStretch._signalsmith = m;
          return true;
        }
        _HseStretch._signalsmith = null;
        return false;
      } catch {
        _HseStretch._signalsmith = null;
        return false;
      }
    }
    // ------------------------------------------------------------------
    // 自研相位声码器
    // ------------------------------------------------------------------
    /** 单声道处理：先按 rate·pitchScale 时间伸缩（不变调），再按 1/pitchScale 重采样变调。 */
    _processChannel(x, rate, pitchScale) {
      const stretched = this._vocoderStretch(x, rate * pitchScale);
      if (Math.abs(pitchScale - 1) < 1e-9) return stretched;
      const rs = new Resampler(this.fs * pitchScale, this.fs, 1, 8);
      return rs.process(stretched);
    }
    /**
     * 相位声码器时间伸缩（不变调）：帧 m 的幅度取输入帧 m 的 STFT 幅度，
     * 相位按瞬时频率在合成 hop Hs=HOP·factor 上累积，Hann 窗 OLA。
     */
    _vocoderStretch(x, factor) {
      const len = x.length;
      if (len === 0) return new Float32Array(0);
      const full = len >= N ? Math.floor((len - N) / HOP) + 1 : 0;
      const partial = full * HOP < len ? 1 : 0;
      const M = Math.max(1, full + partial);
      const Hs = Math.max(1, Math.round(HOP * factor));
      const outLen = (M - 1) * Hs + N;
      const out = new Float32Array(outLen);
      const sArr = new Float32Array(outLen);
      const win = this.win;
      const anaRe = this.anaRe;
      const anaIm = this.anaIm;
      const prevRe = this.prevRe;
      const prevIm = this.prevIm;
      const synRe = this.synRe;
      const synIm = this.synIm;
      const synPhase = this.synPhase;
      const half = N / 2;
      const TWO_PI = 2 * Math.PI;
      for (let m = 0; m < M; m++) {
        const start = m * HOP;
        for (let i = 0; i < N; i++) {
          const j = start + i;
          anaRe[i] = (j < len ? x[j] : 0) * win[i];
          anaIm[i] = 0;
        }
        fft(anaRe, anaIm, false);
        for (let k = 0; k <= half; k++) {
          const re = anaRe[k];
          const im = anaIm[k];
          if (m === 0) {
            synPhase[k] = Math.atan2(im, re);
          } else {
            const dphi = Math.atan2(
              im * prevRe[k] - re * prevIm[k],
              re * prevRe[k] + im * prevIm[k]
            );
            const wk = TWO_PI * k / N;
            let dev = dphi - HOP * wk;
            dev -= TWO_PI * Math.round(dev / TWO_PI);
            const winst = wk + dev / HOP;
            synPhase[k] += Hs * winst;
          }
        }
        for (let k = 0; k <= half; k++) {
          const mag = Math.sqrt(anaRe[k] * anaRe[k] + anaIm[k] * anaIm[k]);
          const ph = synPhase[k];
          if (k === 0 || k === half) {
            synRe[k] = Math.cos(ph) >= 0 ? mag : -mag;
            synIm[k] = 0;
          } else {
            synRe[k] = mag * Math.cos(ph);
            synIm[k] = mag * Math.sin(ph);
          }
        }
        for (let k = 1; k < half; k++) {
          synRe[N - k] = synRe[k];
          synIm[N - k] = -synIm[k];
        }
        fft(synRe, synIm, true);
        const base = m * Hs;
        for (let i = 0; i < N; i++) {
          out[base + i] += win[i] * synRe[i];
          sArr[base + i] += win[i] * win[i];
        }
        prevRe.set(anaRe);
        prevIm.set(anaIm);
      }
      for (let i = 0; i < outLen; i++) {
        const s = sArr[i];
        if (s > 0.01) out[i] /= s;
      }
      return out;
    }
    // ------------------------------------------------------------------
    // signalsmith 适配（防御性；当前官方包为 Web Audio 包装，此路径不会命中）
    // ------------------------------------------------------------------
    _processWithSignalsmith(l, r) {
      try {
        const mod = _HseStretch._signalsmith;
        const block = N;
        const s = new mod.HseStretch(2, block);
        if (typeof s.reset === "function") s.reset();
        if (typeof s.setTransposeSemitones === "function") {
          ;
          s.setTransposeSemitones(this.semitones);
        } else if (typeof s.setFreqFactor === "function") {
          ;
          s.setFreqFactor(this.pitchScale);
        } else {
          return null;
        }
        if (typeof s.setTimeFactor === "function") s.setTimeFactor(this.rate);
        const process = s.process;
        if (typeof process !== "function") return null;
        const n = Math.min(l.length, r.length);
        const targetFrames = Math.round(n * this.rate);
        const outL = new Float32Array(targetFrames);
        const outR = new Float32Array(targetFrames);
        let written = 0;
        for (let off = 0; off < n && written < targetFrames; off += block) {
          const cnt = Math.min(block, n - off);
          const inBuf = new Float32Array(cnt * 2);
          for (let i = 0; i < cnt; i++) {
            inBuf[i * 2] = l[off + i];
            inBuf[i * 2 + 1] = r[off + i];
          }
          const outBuf = new Float32Array(Math.ceil(cnt * this.rate * 2) + block * 4);
          const got = process(inBuf, outBuf, cnt);
          const frames = Math.min(Math.floor(got / 2), targetFrames - written);
          for (let i = 0; i < frames; i++) {
            outL[written + i] = outBuf[i * 2];
            outR[written + i] = outBuf[i * 2 + 1];
          }
          written += frames;
        }
        return { l: outL, r: outR };
      } catch {
        return null;
      }
    }
  };
  function clamp7(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function hannWindow2(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
    return w;
  }

  // src/dsp/modulation.ts
  function clamp8(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  var Lfo = class {
    sampleRate;
    shape = "sine";
    rateHz = 1;
    depth = 1;
    phase = 0;
    constructor(sampleRate2, shape = "sine", rateHz = 1, depth = 1) {
      if (!(sampleRate2 > 0)) throw new Error("invalid sample rate");
      this.sampleRate = sampleRate2;
      this.setParams(shape, rateHz, depth);
    }
    setParams(shape, rateHz, depth) {
      this.shape = shape;
      this.rateHz = Math.max(0, rateHz);
      this.depth = clamp8(depth, 0, 1);
    }
    /** 推进 n 个样本并返回当前归一化输出（-1..1） */
    processBlock(n) {
      const dt = n / this.sampleRate;
      this.phase = (this.phase + this.rateHz * dt) % 1;
      return this.value() * this.depth;
    }
    reset() {
      this.phase = 0;
    }
    value() {
      const p = this.phase;
      switch (this.shape) {
        case "sine":
          return Math.sin(2 * Math.PI * p);
        case "triangle":
          return 4 * Math.abs(p - 0.5) - 1;
        case "square":
          return p < 0.5 ? 1 : -1;
        case "saw":
          return 2 * p - 1;
        default:
          return Math.sin(2 * Math.PI * p);
      }
    }
  };
  var EnvelopeFollower = class {
    sampleRate;
    attackCoef = 0;
    releaseCoef = 0;
    amount = 1;
    env = 0;
    constructor(sampleRate2, attackMs = 10, releaseMs = 200, amount = 1) {
      if (!(sampleRate2 > 0)) throw new Error("invalid sample rate");
      this.sampleRate = sampleRate2;
      this.setParams(attackMs, releaseMs, amount);
    }
    setParams(attackMs, releaseMs, amount) {
      const a = Math.max(attackMs, 0.05);
      const r = Math.max(releaseMs, 0.05);
      this.attackCoef = 1 - Math.exp(-1 / (a / 1e3 * this.sampleRate));
      this.releaseCoef = 1 - Math.exp(-1 / (r / 1e3 * this.sampleRate));
      this.amount = clamp8(amount, 0, 1);
    }
    /** 处理一个块，返回块尾包络（已乘 amount） */
    processBlock(l, r, n) {
      const attack = this.attackCoef;
      const release = this.releaseCoef;
      for (let i = 0; i < n; i++) {
        const e = Math.abs(l[i]) > Math.abs(r[i]) ? Math.abs(l[i]) : Math.abs(r[i]);
        if (e > this.env) this.env += attack * (e - this.env);
        else this.env += release * (e - this.env);
      }
      return this.env * this.amount;
    }
    reset() {
      this.env = 0;
    }
  };
  var ModulationMatrix = class {
    lfo;
    env;
    result = { masterGain: 1, stereoWidth: 1 };
    routes = [];
    constructor(sampleRate2, routes = [], lfo, envelope) {
      this.lfo = new Lfo(sampleRate2, lfo?.shape ?? "sine", lfo?.rateHz ?? 1, lfo?.depth ?? 0.5);
      this.env = new EnvelopeFollower(
        sampleRate2,
        envelope?.attackMs ?? 10,
        envelope?.releaseMs ?? 200,
        envelope?.amount ?? 0.5
      );
      this.routes = routes.slice();
    }
    setRoutes(routes) {
      this.routes = routes.slice();
    }
    setLfoParams(shape, rateHz, depth) {
      this.lfo.setParams(shape, rateHz, depth);
    }
    setEnvelopeParams(attackMs, releaseMs, amount) {
      this.env.setParams(attackMs, releaseMs, amount);
    }
    /** 处理一个块并返回独立结果快照。实时路径应使用 processBlockInto。 */
    processBlock(l, r, n) {
      this.processBlockInto(l, r, n, this.result);
      return { masterGain: this.result.masterGain, stereoWidth: this.result.stereoWidth };
    }
    /** 把结果写入调用方提供的对象，供实时路径避免每块分配。 */
    processBlockInto(l, r, n, output) {
      const lfoVal = this.lfo.processBlock(n);
      const envVal = this.env.processBlock(l, r, n);
      let masterGain = 1;
      let stereoWidth = 1;
      for (const route of this.routes) {
        const src = route.source === "lfo" ? lfoVal : envVal;
        const v = src * route.amount + (route.offset ?? 0);
        if (route.target === "masterGain") masterGain += v;
        else stereoWidth += v;
      }
      output.masterGain = clamp8(masterGain, 0, 4);
      output.stereoWidth = clamp8(stereoWidth, 0, 2);
    }
    reset() {
      this.lfo.reset();
      this.env.reset();
    }
  };

  // src/dsp/ModEffects.ts
  function clamp9(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function readDelay(buf, pos, delaySamples) {
    const size = buf.length;
    const d = clamp9(delaySamples, 0, size - 1);
    const i0 = Math.floor(d);
    const frac = d - i0;
    const idx0 = (pos - i0 + size) % size;
    const idx1 = (idx0 - 1 + size) % size;
    return buf[idx0] * (1 - frac) + buf[idx1] * frac;
  }
  function writeDelay(buf, pos, value) {
    buf[pos] = value;
  }
  var DelayEffect = class {
    fs;
    bufL;
    bufR;
    pos = 0;
    delaySamples = 0;
    feedback = 0.3;
    mix = 0.3;
    constructor(fs) {
      if (!(fs > 0)) throw new Error("invalid sample rate");
      this.fs = fs;
      const maxDelay = Math.ceil(fs * 2) + 1;
      this.bufL = new Float32Array(maxDelay);
      this.bufR = new Float32Array(maxDelay);
    }
    setParams(p) {
      this.delaySamples = clamp9(p.delayMs, 0, 2e3) / 1e3 * this.fs;
      this.feedback = clamp9(p.feedback, 0, 0.98);
      this.mix = clamp9(p.mix, 0, 1);
    }
    processStereo(l, r, frameCount) {
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const bufL = this.bufL;
      const bufR = this.bufR;
      const size = bufL.length;
      const d = this.delaySamples;
      const fb = this.feedback;
      const mix = this.mix;
      let pos = this.pos;
      for (let i = 0; i < n; i++) {
        const xl = l[i];
        const xr = r[i];
        const wetL = readDelay(bufL, pos, d);
        const wetR = readDelay(bufR, pos, d);
        writeDelay(bufL, pos, xl + wetL * fb);
        writeDelay(bufR, pos, xr + wetR * fb);
        l[i] = xl * (1 - mix) + wetL * mix;
        r[i] = xr * (1 - mix) + wetR * mix;
        pos = (pos + 1) % size;
      }
      this.pos = pos;
    }
    reset() {
      this.bufL.fill(0);
      this.bufR.fill(0);
      this.pos = 0;
    }
  };
  var ModulatedDelay = class {
    fs;
    bufL;
    bufR;
    pos = 0;
    phase = 0;
    baseDelay = 0;
    depthSamples = 0;
    rateHz = 1;
    constructor(fs, maxDelaySec) {
      if (!(fs > 0)) throw new Error("invalid sample rate");
      this.fs = fs;
      const len = Math.ceil(fs * maxDelaySec) + 2;
      this.bufL = new Float32Array(len);
      this.bufR = new Float32Array(len);
    }
    setCommon(baseMs, depthMs, rateHz) {
      this.baseDelay = clamp9(baseMs, 0, 100) / 1e3 * this.fs;
      this.depthSamples = clamp9(depthMs, 0, 50) / 1e3 * this.fs;
      this.rateHz = clamp9(rateHz, 0.01, 20);
    }
    lfoValue() {
      return Math.sin(2 * Math.PI * this.phase);
    }
    advance(n) {
      this.phase = (this.phase + this.rateHz * n / this.fs) % 1;
    }
    processCore(l, r, feedback, mix, frameCount) {
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const bufL = this.bufL;
      const bufR = this.bufR;
      const size = bufL.length;
      let pos = this.pos;
      for (let i = 0; i < n; i++) {
        const xl = l[i];
        const xr = r[i];
        const mod = this.lfoValue();
        const d = this.baseDelay + this.depthSamples * mod;
        const wetL = readDelay(bufL, pos, d);
        const wetR = readDelay(bufR, pos, d);
        writeDelay(bufL, pos, xl + wetL * feedback);
        writeDelay(bufR, pos, xr + wetR * feedback);
        l[i] = xl * (1 - mix) + wetL * mix;
        r[i] = xr * (1 - mix) + wetR * mix;
        pos = (pos + 1) % size;
      }
      this.pos = pos;
      this.advance(n);
    }
    reset() {
      this.bufL.fill(0);
      this.bufR.fill(0);
      this.pos = 0;
      this.phase = 0;
    }
  };
  var ChorusEffect = class extends ModulatedDelay {
    constructor(fs) {
      super(fs, 0.1);
    }
    setParams(p) {
      this.setCommon(20, p.depthMs, p.rateHz);
      this.mix = clamp9(p.mix, 0, 1);
    }
    mix = 0.4;
    processStereo(l, r, frameCount) {
      this.processCore(l, r, 0, this.mix, frameCount);
    }
  };
  var FlangerEffect = class extends ModulatedDelay {
    constructor(fs) {
      super(fs, 0.05);
    }
    feedback = 0.4;
    mix = 0.5;
    setParams(p) {
      this.setCommon(1, p.depthMs, p.rateHz);
      this.feedback = clamp9(p.feedback, 0, 0.98);
      this.mix = clamp9(p.mix, 0, 1);
    }
    processStereo(l, r, frameCount) {
      this.processCore(l, r, this.feedback, this.mix, frameCount);
    }
  };
  var PhaserEffect = class {
    fs;
    rateHz = 0.5;
    depth = 0.5;
    feedback = 0.4;
    mix = 0.5;
    stages = 4;
    phase = 0;
    // 每通道每级状态：x1, y1
    stateL;
    stateR;
    constructor(fs) {
      if (!(fs > 0)) throw new Error("invalid sample rate");
      this.fs = fs;
      this.stateL = new Float32Array(8 * 2);
      this.stateR = new Float32Array(8 * 2);
    }
    setParams(p) {
      this.rateHz = clamp9(p.rateHz, 0.01, 20);
      this.depth = clamp9(p.depth, 0, 1);
      this.feedback = clamp9(p.feedback, 0, 0.98);
      this.mix = clamp9(p.mix, 0, 1);
      this.stages = Math.max(2, Math.min(8, Math.round(p.stages)));
    }
    processStereo(l, r, frameCount) {
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const stages = this.stages;
      const fs = this.fs;
      const depth = this.depth;
      const fb = this.feedback;
      const mix = this.mix;
      let phase = this.phase;
      for (let i = 0; i < n; i++) {
        const xl = l[i];
        const xr = r[i];
        const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * phase);
        const fc = 200 + 1800 * (0.2 + 0.8 * lfo * depth);
        const a = (1 - Math.tan(Math.PI * fc / fs)) / (1 + Math.tan(Math.PI * fc / fs));
        const inL = xl + fb * this.lastOutL;
        const inR = xr + fb * this.lastOutR;
        let yl = inL;
        let yr = inR;
        for (let s = 0; s < stages; s++) {
          const base = s * 2;
          yl = this.allpass(inL, this.stateL, base, a);
          yr = this.allpass(inR, this.stateR, base, a);
        }
        this.lastOutL = yl;
        this.lastOutR = yr;
        l[i] = xl * (1 - mix) + yl * mix;
        r[i] = xr * (1 - mix) + yr * mix;
        phase = (phase + this.rateHz / fs) % 1;
      }
      this.phase = phase;
    }
    lastOutL = 0;
    lastOutR = 0;
    allpass(x, state, base, a) {
      const x1 = state[base];
      const y1 = state[base + 1];
      const y = -a * x + x1 + a * y1;
      state[base] = x;
      state[base + 1] = y;
      return y;
    }
    reset() {
      this.stateL.fill(0);
      this.stateR.fill(0);
      this.phase = 0;
      this.lastOutL = 0;
      this.lastOutR = 0;
    }
  };
  var TremoloEffect = class {
    fs;
    rateHz = 5;
    depth = 0.5;
    mix = 1;
    phase = 0;
    constructor(fs) {
      if (!(fs > 0)) throw new Error("invalid sample rate");
      this.fs = fs;
    }
    setParams(p) {
      this.rateHz = clamp9(p.rateHz, 0.01, 30);
      this.depth = clamp9(p.depth, 0, 1);
      this.mix = clamp9(p.mix, 0, 1);
    }
    processStereo(l, r, frameCount) {
      const n = Math.max(0, Math.min(Math.floor(frameCount ?? l.length), l.length, r.length));
      const fs = this.fs;
      const depth = this.depth;
      const mix = this.mix;
      let phase = this.phase;
      for (let i = 0; i < n; i++) {
        const g = 1 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * phase));
        const wet = g;
        l[i] = l[i] * (1 - mix + mix * wet);
        r[i] = r[i] * (1 - mix + mix * wet);
        phase = (phase + this.rateHz / fs) % 1;
      }
      this.phase = phase;
    }
    reset() {
      this.phase = 0;
    }
  };

  // src/dsp/features.ts
  function computeRms(x) {
    const n = x.length;
    if (n === 0) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] * x[i];
    return Math.sqrt(s / n);
  }
  function computeZcr(x) {
    const n = x.length;
    if (n < 2) return 0;
    let crossings = 0;
    let prev = x[0] >= 0;
    for (let i = 1; i < n; i++) {
      const cur = x[i] >= 0;
      if (cur !== prev) crossings++;
      prev = cur;
    }
    return crossings / (n - 1);
  }
  function spectralCentroid(mags, freqs) {
    const n = Math.min(mags.length, freqs.length);
    if (n === 0) return 0;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const m = mags[i];
      num += freqs[i] * m;
      den += m;
    }
    return den > 0 ? num / den : 0;
  }
  function spectralRolloff(mags, freqs, percentile = 0.95) {
    const n = Math.min(mags.length, freqs.length);
    if (n === 0) return 0;
    const p = Math.min(1, Math.max(0, percentile));
    let total = 0;
    for (let i = 0; i < n; i++) total += mags[i];
    if (total <= 0) return 0;
    const target = p * total;
    let cum = 0;
    for (let i = 0; i < n; i++) {
      const prevCum = cum;
      cum += mags[i];
      if (cum >= target) {
        const frac = cum - prevCum > 0 ? (target - prevCum) / (cum - prevCum) : 0;
        if (i === 0) return freqs[0];
        return freqs[i - 1] + (freqs[i] - freqs[i - 1]) * frac;
      }
    }
    return freqs[n - 1];
  }
  function spectralFlatness(mags) {
    const n = mags.length;
    if (n === 0) return 0;
    let logSum = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const m = mags[i];
      if (m <= 0) return 0;
      logSum += Math.log(m);
      sum += m;
    }
    if (sum <= 0) return 0;
    return Math.exp(logSum / n) / (sum / n);
  }
  function spectralCrest(mags) {
    const n = mags.length;
    if (n === 0) return 0;
    let mx = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const m = mags[i];
      if (m > mx) mx = m;
      sum += m;
    }
    const mean = sum / n;
    return mean > 0 ? mx / mean : 0;
  }

  // src/spatial/TimeConvolver.ts
  var TimeConvolver = class {
    fs;
    partitionSize;
    dePeriodize;
    irLoaded = false;
    /** 去周期化后的 IR（长度 M） */
    ir = new Float32Array(0);
    irLength = 0;
    irName = null;
    // ---- 流式状态（与 Convolver 同构；全部预分配） ----
    inputBlockL = new Float32Array(0);
    inputBlockR = new Float32Array(0);
    inputPos = 0;
    /** 每通道环形输入历史（长度 M，跨块携带"卷积尾"） */
    histL = new Float32Array(0);
    histR = new Float32Array(0);
    histPosL = 0;
    histPosR = 0;
    /** 待放行湿块队列（容量 (1+2)·L = 3L，与 Convolver (P+2)·L 对齐，P=1） */
    pendingWetL = new Float32Array(0);
    pendingWetR = new Float32Array(0);
    pendingLen = 0;
    pendingPos = 0;
    /** 已完成的输入块数（块完成时 +1）：湿路放行的"已产出"依据 */
    completedBlocks = 0;
    /** 已输出的样本总数（跨调用累计）：湿路放行的"位置"依据 */
    totalOut = 0;
    /** 已放行的湿路样本总数（严格按序放行依据） */
    totalWetOut = 0;
    maxFrames = 0;
    explicitlyPrepared = false;
    constructor(fs, opts) {
      if (fs <= 0 || !Number.isFinite(fs)) {
        throw new Error("invalid sample rate");
      }
      this.fs = fs;
      let L = opts && opts.partitionSize !== void 0 ? Math.round(opts.partitionSize) : 512;
      if (!Number.isFinite(L) || L < 1) L = 512;
      this.partitionSize = Math.min(8192, Math.max(32, L));
      this.dePeriodize = opts ? opts.dePeriodize !== false : true;
    }
    /**
     * 载入单声道 IR（校验/去周期化与 Convolver.loadIR 一致）。
     * 空 / 全零 / 非法 IR 抛 Error。
     */
    loadIR(ir, irName) {
      if (!ir || ir.length === 0) {
        throw new Error("invalid impulse response: empty");
      }
      let anyNonZero = false;
      for (let i = 0; i < ir.length; i++) {
        const v = ir[i];
        if (!Number.isFinite(v)) {
          throw new Error("invalid impulse response: contains NaN/Infinity");
        }
        if (v !== 0) anyNonZero = true;
      }
      if (!anyNonZero) {
        throw new Error("invalid impulse response: all zero");
      }
      const L = this.partitionSize;
      const src = this.dePeriodize ? this.dePeriodizeIR(ir) : ir;
      const M = src.length;
      this.ir = src.slice();
      this.irLength = M;
      this.irName = irName !== void 0 ? irName : null;
      this.inputBlockL = new Float32Array(L);
      this.inputBlockR = new Float32Array(L);
      this.histL = new Float32Array(M);
      this.histR = new Float32Array(M);
      const pendingCap = this.pendingCapacity(L);
      this.pendingWetL = new Float32Array(pendingCap);
      this.pendingWetR = new Float32Array(pendingCap);
      this.inputPos = 0;
      this.histPosL = 0;
      this.histPosR = 0;
      this.pendingLen = 0;
      this.pendingPos = 0;
      this.completedBlocks = 0;
      this.totalOut = 0;
      this.totalWetOut = 0;
      this.irLoaded = true;
    }
    prepare(maxFrames) {
      const frames = Number.isFinite(maxFrames) ? Math.max(0, Math.floor(maxFrames)) : 0;
      this.explicitlyPrepared = frames > 0;
      this.ensurePendingCapacity(frames);
    }
    ensurePendingCapacity(frames) {
      if (frames <= this.maxFrames) return;
      this.maxFrames = frames;
      if (!this.irLoaded) return;
      const capacity = this.pendingCapacity(this.partitionSize);
      if (this.pendingWetL.length < capacity) {
        this.pendingWetL = new Float32Array(capacity);
        this.pendingWetR = new Float32Array(capacity);
        this.pendingLen = 0;
        this.pendingPos = 0;
      }
    }
    pendingCapacity(partitionSize) {
      const produced = Math.ceil(Math.max(this.maxFrames, partitionSize) / partitionSize);
      return Math.max(3, produced + 2) * partitionSize;
    }
    /**
     * 流式立体声就地处理（与 Convolver.processStereo 同调度）：
     * 湿路 = 时域直接卷积（块装配 + 待放行队列），out[i] = wet[i]，相对输入延迟 L。
     * 未载入 IR 时抛错。
     */
    processStereo(l, r, frameCount) {
      if (!this.irLoaded) {
        throw new Error("no impulse response loaded");
      }
      const requested = frameCount === void 0 ? Math.min(l.length, r.length) : Math.floor(frameCount);
      const B = Math.max(0, Math.min(requested, l.length, r.length));
      if (!this.explicitlyPrepared && B > this.maxFrames) this.ensurePendingCapacity(B);
      const L = this.partitionSize;
      for (let i = 0; i < B; i++) {
        this.inputBlockL[this.inputPos] = l[i];
        this.inputBlockR[this.inputPos] = r[i];
        this.inputPos++;
        if (this.inputPos >= L) {
          const cap = this.pendingWetL.length;
          if (this.pendingPos + this.pendingLen + L > cap) {
            const remain = this.pendingLen;
            if (remain > 0 && this.pendingPos > 0) {
              this.pendingWetL.copyWithin(0, this.pendingPos, this.pendingPos + remain);
              this.pendingWetR.copyWithin(0, this.pendingPos, this.pendingPos + remain);
            }
            this.pendingPos = 0;
            if (this.pendingLen + L > this.pendingWetL.length) {
              if (this.explicitlyPrepared) {
                throw new Error(`TimeConvolver block ${B} exceeds prepared pending capacity`);
              }
              this.ensurePendingCapacity(B);
            }
          }
          const writeAt = this.pendingPos + this.pendingLen;
          this.processWetBlock(this.inputBlockL, this.pendingWetL, writeAt, 0);
          this.processWetBlock(this.inputBlockR, this.pendingWetR, writeAt, 1);
          this.pendingLen += L;
          this.completedBlocks++;
          this.inputPos = 0;
        }
      }
      for (let i = 0; i < B; i++) {
        let wetL = 0;
        let wetR = 0;
        const wetIdx = this.totalOut - L;
        if (this.pendingLen > 0 && wetIdx >= 0 && wetIdx < this.completedBlocks * L && this.totalWetOut === wetIdx) {
          wetL = this.pendingWetL[this.pendingPos];
          wetR = this.pendingWetR[this.pendingPos];
          this.pendingPos++;
          this.pendingLen--;
          this.totalWetOut++;
          if (this.pendingLen === 0) this.pendingPos = 0;
        }
        this.totalOut++;
        l[i] = wetL;
        r[i] = wetR;
      }
    }
    /** 湿路引入的延迟（样本数）= 一个分区长（与分区模式/干路对齐，两模式一致） */
    getLatencySamples() {
      return this.partitionSize;
    }
    reset() {
      this.inputPos = 0;
      this.histPosL = 0;
      this.histPosR = 0;
      this.pendingLen = 0;
      this.pendingPos = 0;
      this.completedBlocks = 0;
      this.totalOut = 0;
      this.totalWetOut = 0;
      if (this.inputBlockL.length > 0) {
        this.inputBlockL.fill(0);
        this.inputBlockR.fill(0);
      }
      if (this.histL.length > 0) {
        this.histL.fill(0);
        this.histR.fill(0);
      }
      if (this.pendingWetL.length > 0) {
        this.pendingWetL.fill(0);
        this.pendingWetR.fill(0);
      }
    }
    /** 当前 IR 名称（未载入返回 null） */
    getIrName() {
      return this.irName;
    }
    // ---------------------------------------------------------------- 内部
    /**
     * 处理一个完整输入块：直接时域卷积（环形输入历史）并把输出块写入
     * pending[writeAt..writeAt+L)。ear=0 左 / 1 右（各自独立的环形历史）。
     */
    processWetBlock(blk, pending, writeAt, ear) {
      const L = this.partitionSize;
      const M = this.irLength;
      const hist = ear === 0 ? this.histL : this.histR;
      let hp = ear === 0 ? this.histPosL : this.histPosR;
      for (let j = 0; j < L; j++) {
        hist[hp] = blk[j];
        hp = (hp + 1) % M;
        const newest = (hp + M - 1) % M;
        let acc = 0;
        for (let m = 0; m < M; m++) {
          acc += this.ir[m] * hist[(newest + M - m) % M];
        }
        pending[writeAt + j] = acc;
      }
      if (ear === 0) this.histPosL = hp;
      else this.histPosR = hp;
    }
    /**
     * IR 去周期化（镜像 dsp/Convolver.ts 的私有 dePeriodizeIR——dsp/* 属并行代理
     * 分区，不跨分区引用；算法一致保证两模式装载同一 IR）：
     * 检测能量包络峰值，从峰值后 −60dB 点起乘 exp 衰减（τ≈50ms）。
     * 返回新数组（不改动调用方传入的 IR）。
     */
    dePeriodizeIR(ir) {
      const M = ir.length;
      const out = new Float32Array(M);
      out.set(ir);
      const W = Math.max(4, Math.round(0.01 * this.fs));
      const half = W >> 1;
      let peakIdx = 0;
      let peakVal = -1;
      for (let n = 0; n < M; n++) {
        let sum = 0;
        const lo = Math.max(0, n - half);
        const hi = Math.min(M, n + half + 1);
        const cnt = hi - lo;
        for (let j = lo; j < hi; j++) sum += ir[j] * ir[j];
        const env = Math.sqrt(sum / cnt);
        if (env > peakVal) {
          peakVal = env;
          peakIdx = n;
        }
      }
      if (peakVal <= 1e-12) return out;
      const threshold = peakVal * 1e-3;
      let lastAbove = peakIdx;
      for (let n = peakIdx; n < M; n++) {
        let sum = 0;
        const lo = Math.max(0, n - half);
        const hi = Math.min(M, n + half + 1);
        const cnt = hi - lo;
        for (let j = lo; j < hi; j++) sum += ir[j] * ir[j];
        if (Math.sqrt(sum / cnt) > threshold) lastAbove = n;
      }
      const n0 = lastAbove + 1;
      if (n0 >= M) return out;
      const tau = 0.05 * this.fs;
      for (let n = n0; n < M; n++) {
        out[n] *= Math.exp(-(n - n0) / tau);
      }
      return out;
    }
  };

  // src/spatial/hrtfInterp.ts
  var SH_ORDER = 3;
  var SH_BASIS_COUNT = (SH_ORDER + 1) * (SH_ORDER + 1);
  var PI = Math.PI;
  var SQRT2 = Math.SQRT2;
  var K0 = 0.5 / Math.sqrt(PI);
  var K1 = Math.sqrt(3 / (4 * PI));
  var K2 = Math.sqrt(5 / (16 * PI));
  var K3 = Math.sqrt(7 / (16 * PI));
  var C21 = 3 * SQRT2 * Math.sqrt(15 / (8 * PI));
  var C22 = 3 * SQRT2 * Math.sqrt(15 / (32 * PI));
  var C31 = 1.5 * SQRT2 * Math.sqrt(21 / (32 * PI));
  var C32 = 15 * SQRT2 * Math.sqrt(105 / (32 * PI));
  var C33 = 15 * SQRT2 * Math.sqrt(35 / (64 * PI));
  function shBasis(azDeg, elDeg, out) {
    const phi = azDeg * PI / 180;
    const th = elDeg * PI / 180;
    const u = Math.cos(th);
    const v = Math.sin(th);
    const ca = Math.cos(phi);
    const sa = Math.sin(phi);
    const c2 = ca * ca - sa * sa;
    const s2 = 2 * sa * ca;
    const c3 = c2 * ca - s2 * sa;
    const s3 = s2 * ca + c2 * sa;
    const u2 = u * u;
    const u3 = u2 * u;
    const v2 = v * v;
    const v3 = v2 * v;
    out[0] = K0;
    out[1] = -K1 * sa * u;
    out[2] = K1 * v;
    out[3] = -K1 * ca * u;
    out[4] = C22 * s2 * u2;
    out[5] = -C21 * sa * v * u;
    out[6] = K2 * (3 * v2 - 1) * 0.5;
    out[7] = -C21 * ca * v * u;
    out[8] = C22 * c2 * u2;
    out[9] = -C33 * s3 * u3;
    out[10] = C32 * s2 * v * u2;
    out[11] = -C31 * sa * (5 * v2 - 1) * u;
    out[12] = K3 * (5 * v3 - 3 * v) * 0.5;
    out[13] = -C31 * ca * (5 * v2 - 1) * u;
    out[14] = C32 * c2 * v * u2;
    out[15] = -C33 * c3 * u3;
  }
  function invertGaussJordan(n, m) {
    const w = 2 * n;
    const aug = new Float64Array(n * w);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) aug[r * w + c] = m[r * n + c];
      aug[r * w + n + r] = 1;
    }
    for (let col = 0; col < n; col++) {
      let piv = col;
      let best = Math.abs(aug[col * w + col]);
      for (let r = col + 1; r < n; r++) {
        const a = Math.abs(aug[r * w + col]);
        if (a > best) {
          best = a;
          piv = r;
        }
      }
      if (piv !== col) {
        for (let c = 0; c < w; c++) {
          const t = aug[col * w + c];
          aug[col * w + c] = aug[piv * w + c];
          aug[piv * w + c] = t;
        }
      }
      const d = aug[col * w + col];
      if (Math.abs(d) < 1e-12) {
        throw new Error("\u7403\u8C10\u62DF\u5408\uFF1A\u7F51\u683C\u65B9\u5411\u6570\u4E0D\u8DB3/\u9000\u5316\uFF08A\u1D40A \u79E9\u4E8F\uFF09");
      }
      for (let c = 0; c < w; c++) aug[col * w + c] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = aug[r * w + col];
        if (f === 0) continue;
        for (let c = 0; c < w; c++) aug[r * w + c] -= f * aug[col * w + c];
      }
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) m[r * n + c] = aug[r * w + n + c];
    }
  }
  var fitCache = /* @__PURE__ */ new WeakMap();
  function fitShCoefficients(grid) {
    const azCount = grid.azimuths.length;
    const elCount = grid.elevations.length;
    const hrirLength = grid.hrirLength;
    const nd = azCount * elCount;
    const nb = SH_BASIS_COUNT;
    const a = new Float64Array(nd * nb);
    const b = new Float64Array(nb);
    let d = 0;
    for (let e = 0; e < elCount; e++) {
      for (let i = 0; i < azCount; i++) {
        shBasis(grid.azimuths[i], grid.elevations[e], b);
        for (let k = 0; k < nb; k++) a[d * nb + k] = b[k];
        d++;
      }
    }
    const g = new Float64Array(nb * nb);
    for (let k = 0; k < nb; k++) {
      for (let m = 0; m < nb; m++) {
        let s = 0;
        for (let d2 = 0; d2 < nd; d2++) s += a[d2 * nb + k] * a[d2 * nb + m];
        g[k * nb + m] = s;
      }
    }
    invertGaussJordan(nb, g);
    const pinv = new Float64Array(nb * nd);
    for (let k = 0; k < nb; k++) {
      for (let d2 = 0; d2 < nd; d2++) {
        let s = 0;
        for (let m = 0; m < nb; m++) s += g[k * nb + m] * a[d2 * nb + m];
        pinv[k * nd + d2] = s;
      }
    }
    const fitEar = (plane) => {
      const coeffs = new Float64Array(nb * hrirLength);
      for (let k = 0; k < nb; k++) {
        for (let t = 0; t < hrirLength; t++) {
          let s = 0;
          for (let d2 = 0; d2 < nd; d2++) s += pinv[k * nd + d2] * plane[d2 * hrirLength + t];
          coeffs[k * hrirLength + t] = s;
        }
      }
      return coeffs;
    };
    return { dirCount: nd, azCount, elCount, hrirLength, pinv, coeffsL: fitEar(grid.left), coeffsR: fitEar(grid.right) };
  }
  function getShFit(grid) {
    const cached = fitCache.get(grid);
    if (cached && cached.azCount === grid.azimuths.length && cached.elCount === grid.elevations.length && cached.hrirLength === grid.hrirLength && cached.dirCount === grid.azimuths.length * grid.elevations.length) {
      return cached;
    }
    const fresh = fitShCoefficients(grid);
    fitCache.set(grid, fresh);
    return fresh;
  }
  function sphericalHrtf(grid, azimuthDeg, elevationDeg, outL, outR) {
    if (outL.length !== grid.hrirLength || outR.length !== grid.hrirLength) {
      throw new Error(`sphericalHrtf: \u8F93\u51FA\u957F\u5EA6\u5FC5\u987B\u7B49\u4E8E hrirLength\uFF08${grid.hrirLength}\uFF09\uFF0C\u5B9E\u9645 L=${outL.length} R=${outR.length}`);
    }
    const cache = getShFit(grid);
    const hl = cache.hrirLength;
    const nb = SH_BASIS_COUNT;
    const els = grid.elevations;
    const az = ((azimuthDeg + 180) % 360 + 360) % 360 - 180;
    const el = Math.min(els[els.length - 1], Math.max(els[0], elevationDeg));
    const y = new Float64Array(nb);
    shBasis(az, el, y);
    const evalEar = (coeffs, out) => {
      for (let t = 0; t < hl; t++) {
        let s = 0;
        for (let k = 0; k < nb; k++) s += coeffs[k * hl + t] * y[k];
        out[t] = s;
      }
    };
    evalEar(cache.coeffsL, outL);
    evalEar(cache.coeffsR, outR);
  }

  // src/spatial/roomSim.ts
  var SPEED_OF_SOUND = 343;
  var DEG2RAD = Math.PI / 180;
  var EARLY_LP_FC_BASE = 8e3;
  var FDN_LP_FC = 4e3;
  var FDN_PRIMES = [179, 211, 251, 307, 359, 419, 467, 521];
  var ROOM_PRESETS = {
    studio: { width: 5, height: 3, depth: 4, reflectivity: 0.25, rt60: 0.45 },
    // 录音棚：小空间短尾
    hall: { width: 25, height: 12, depth: 18, reflectivity: 0.6, rt60: 2.2 },
    // 音乐厅：大空间长尾
    stage: { width: 18, height: 8, depth: 14, reflectivity: 0.5, rt60: 1.4 },
    // 舞台：纵深宽声场
    church: { width: 30, height: 18, depth: 40, reflectivity: 0.75, rt60: 4.5 },
    // 教堂：超长尾
    outdoor: { width: 80, height: 30, depth: 60, reflectivity: 0.15, rt60: 1.2 },
    // 户外：弱反射、长延迟
    bathroom: { width: 2.5, height: 2.6, depth: 2.2, reflectivity: 0.9, rt60: 1.8 },
    // 浴室：瓷砖高反射
    corridor: { width: 2.2, height: 2.8, depth: 18, reflectivity: 0.5, rt60: 1.6 }
    // 走廊：窄长通道
  };
  function roomParamsFromPreset(preset, earlyOrders, geometryScale = 1) {
    if (preset === "off") return null;
    const p = ROOM_PRESETS[preset];
    const scale = Number.isFinite(geometryScale) ? Math.min(2, Math.max(0.5, geometryScale)) : 1;
    return {
      width: p.width * scale,
      height: p.height * scale,
      depth: p.depth * scale,
      reflectivity: p.reflectivity,
      earlyOrders,
      rt60: p.rt60
    };
  }
  var FdnState = class {
    delays;
    gains;
    lpCoefs;
    linesL = [];
    linesR = [];
    posL;
    posR;
    lpStateL;
    lpStateR;
    /** 正交反馈矩阵 H8/√8（Sylvester Hadamard，f64；与 Rust 侧同构造） */
    matrix = [];
    /** 矩阵乘 scratch（每样本 8 个阻尼后线输出，f64） */
    v = new Float64Array(8);
    constructor(fs, rt60) {
      const scale = fs / 48e3;
      this.delays = FDN_PRIMES.map((p) => Math.max(1, Math.round(p * scale)));
      this.gains = new Float32Array(8);
      this.lpCoefs = new Float32Array(8);
      for (let i = 0; i < 8; i++) {
        const d = this.delays[i];
        this.gains[i] = Math.pow(10, -3 * (d / fs) / rt60);
        this.lpCoefs[i] = Math.exp(-2 * Math.PI * FDN_LP_FC / fs);
        this.linesL.push(new Float32Array(d));
        this.linesR.push(new Float32Array(d));
      }
      this.posL = new Int32Array(8);
      this.posR = new Int32Array(8);
      this.lpStateL = new Float32Array(8);
      this.lpStateR = new Float32Array(8);
      const inv = 1 / Math.sqrt(8);
      for (let i = 0; i < 8; i++) {
        const row = [];
        for (let k = 0; k < 8; k++) {
          let parity = 0;
          let m = i & k;
          while (m > 0) {
            parity ^= m & 1;
            m >>>= 1;
          }
          row.push(parity === 0 ? inv : -inv);
        }
        this.matrix.push(row);
      }
    }
    /**
     * 处理单样本（ear=0 左 / 1 右；input 为已除扬声器数的湿总线样本，f64）。
     * 每样本：①读各线输出 + 阻尼低通 ②矩阵混合 + 反馈写回（input 馈入全部 8 线）
     * ③输出 = Σ 阻尼后线输出。与 Rust 侧 process_sample 逐位对齐（同运算顺序）。
     */
    processSample(ear, input) {
      const lines = ear === 0 ? this.linesL : this.linesR;
      const pos = ear === 0 ? this.posL : this.posR;
      const lpStates = ear === 0 ? this.lpStateL : this.lpStateR;
      const v = this.v;
      for (let i = 0; i < 8; i++) {
        const p = pos[i];
        const read = lines[i][p];
        const a = this.lpCoefs[i];
        const lp = (1 - a) * read + a * lpStates[i];
        lpStates[i] = lp;
        v[i] = lp;
      }
      for (let i = 0; i < 8; i++) {
        let acc = 0;
        const row = this.matrix[i];
        for (let k = 0; k < 8; k++) acc += row[k] * v[k];
        const p = pos[i];
        lines[i][p] = input + this.gains[i] * acc;
        const np = p + 1;
        pos[i] = np >= this.delays[i] ? 0 : np;
      }
      let out = 0;
      for (let i = 0; i < 8; i++) out += v[i];
      return out;
    }
  };
  function axisImages(coord, dim, order) {
    switch (order) {
      case 0:
        return [[coord, 0]];
      case 1:
        return [
          [-coord, 1],
          [2 * dim - coord, 1]
        ];
      case 2:
        return [
          [2 * dim + coord, 2],
          [coord - 2 * dim, 2]
        ];
      default:
        return [
          [4 * dim - coord, 3],
          [-2 * dim - coord, 3]
        ];
    }
  }
  var RoomSim = class {
    /** 房间混合量（config.roomAmount；≤0 或 off 时旁路）——可变：签名不变复用实例时经
     *  setAmount 热更新（避免重建截断 FDN 混响尾），构造后由后端按配置维护 */
    roomAmount;
    active;
    speakerCount;
    states = [];
    fdn;
    /** 早期反射累加总线（每块零化，双耳；按需扩容） */
    earlyL = new Float32Array(0);
    earlyR = new Float32Array(0);
    constructor(fs, speakers, params, roomAmount) {
      this.roomAmount = roomAmount;
      this.speakerCount = speakers.length;
      const active = params !== null && roomAmount > 0 && speakers.length > 0;
      this.active = active;
      if (!active) {
        this.fdn = null;
        return;
      }
      const cx = params.width / 2;
      const cy = params.height / 2;
      const cz = params.depth / 2;
      const orders = params.earlyOrders;
      for (const sp of speakers) {
        const azRad = Math.fround(sp.azimuthDeg) * DEG2RAD;
        const elRad = Math.fround(sp.elevationDeg) * DEG2RAD;
        const d0 = Math.cos(elRad) * Math.sin(azRad);
        const d1 = Math.sin(elRad);
        const d2 = Math.cos(elRad) * Math.cos(azRad);
        const dlen = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
        const sx = cx + sp.distance * (d0 / dlen);
        const sy = cy + sp.distance * (d1 / dlen);
        const sz = cz + sp.distance * (d2 / dlen);
        const taps = [];
        let maxDelay = 1;
        for (let ox = 0; ox <= orders; ox++) {
          const xs = axisImages(sx, params.width, ox);
          for (let xi = 0; xi < xs.length; xi++) {
            for (let oy = 0; oy <= orders; oy++) {
              const ys = axisImages(sy, params.height, oy);
              for (let yi = 0; yi < ys.length; yi++) {
                for (let oz = 0; oz <= orders; oz++) {
                  const zs = axisImages(sz, params.depth, oz);
                  for (let zi = 0; zi < zs.length; zi++) {
                    const o = xs[xi][1] + ys[yi][1] + zs[zi][1];
                    if (o < 1 || o > orders) continue;
                    const dx = xs[xi][0] - cx;
                    const dy = ys[yi][0] - cy;
                    const dz = zs[zi][0] - cz;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    let delay = Math.floor(dist * fs / SPEED_OF_SOUND + 0.5);
                    if (delay < 1) delay = 1;
                    if (delay > maxDelay) maxDelay = delay;
                    let rp = 1;
                    for (let k = 0; k < o; k++) rp *= params.reflectivity;
                    const gain = rp / (dist * dist);
                    const fc = EARLY_LP_FC_BASE / (1 + o);
                    const lpCoef = Math.exp(-2 * Math.PI * fc / fs);
                    taps.push({ delay, gain: Math.fround(gain), lpCoef: Math.fround(lpCoef), lpStateL: 0, lpStateR: 0 });
                  }
                }
              }
            }
          }
        }
        const historyLength = maxDelay + 1;
        this.states.push({
          histL: new Float32Array(historyLength),
          histR: new Float32Array(historyLength),
          histPosL: 0,
          histPosR: 0,
          taps
        });
      }
      this.fdn = new FdnState(fs, params.rt60);
    }
    /**
     * 热更新房间混合量（0..1 钳位）：房间签名（预设+扬声器几何+阶数）不变时由后端
     * 复用实例调用——重建会瞬间截断 FDN 混响尾与早期反射历史（可听突变）。
     * active 判定（构造时）不随 amount 热更新：off↔on 切换由后端重建实例表达。
     */
    setAmount(v) {
      this.roomAmount = Math.min(1, Math.max(0, v));
    }
    /** 在控制路径预分配块级累加总线。 */
    prepare(maxBlockSize) {
      const size = Number.isFinite(maxBlockSize) ? Math.max(0, Math.floor(maxBlockSize)) : 0;
      if (this.earlyL.length >= size) return;
      this.earlyL = new Float32Array(size);
      this.earlyR = new Float32Array(size);
    }
    /** 每块开始时零化早期总线（须早于任何 early() 调用；热路径零分配） */
    beginBlock(n) {
      if (this.earlyL.length < n) {
        throw new Error(`RoomSim block ${n} exceeds prepared capacity ${this.earlyL.length}`);
      }
      this.earlyL.fill(0, 0, n);
      this.earlyR.fill(0, 0, n);
    }
    /**
     * 处理一个扬声器的早期反射（si = 扬声器索引；wetL/wetR = 该扬声器本块湿路，
     * 只读不修改）。每耳整块处理（各自独立写指针）：写历史环 → 逐抽头延迟读/
     * 低通/累加进早期总线。与 Rust 侧 process_block 的早期反射段逐位对齐
     * （同样本顺序、同 f32 舍入；独立指针下输出与块长无关）。
     */
    early(si, wetL, wetR, n) {
      if (!this.active) return;
      const st = this.states[si];
      const maxD = st.histL.length;
      const taps = st.taps;
      const earlyL = this.earlyL;
      let wp = st.histPosL;
      const histL = st.histL;
      for (let j = 0; j < n; j++) {
        const w = wetL[j];
        histL[wp] = w;
        for (let t = 0; t < taps.length; t++) {
          const tap = taps[t];
          const read = histL[(wp + maxD - tap.delay) % maxD];
          const a = tap.lpCoef;
          const lp = (1 - a) * read + a * tap.lpStateL;
          tap.lpStateL = Math.fround(lp);
          earlyL[j] += tap.gain * lp;
        }
        wp++;
        if (wp >= maxD) wp = 0;
      }
      st.histPosL = wp;
      const histR = st.histR;
      const earlyR = this.earlyR;
      wp = st.histPosR;
      for (let j = 0; j < n; j++) {
        const w = wetR[j];
        histR[wp] = w;
        for (let t = 0; t < taps.length; t++) {
          const tap = taps[t];
          const read = histR[(wp + maxD - tap.delay) % maxD];
          const a = tap.lpCoef;
          const lp = (1 - a) * read + a * tap.lpStateR;
          tap.lpStateR = Math.fround(lp);
          earlyR[j] += tap.gain * lp;
        }
        wp++;
        if (wp >= maxD) wp = 0;
      }
      st.histPosR = wp;
    }
    /**
     * FDN 晚期混响 + 混合（就地改写 wetL/wetR，须在所有 speaker 的 early() 之后调用）：
     *   wet += roomAmount·(earlyBus + fdnOut)，fdn 输入 = 湿总线/N（N = 扬声器数）。
     * 与 Rust 侧 process_block 的 FDN 段逐位对齐（每耳整块顺序处理）。
     */
    lateAndMix(wetL, wetR, n) {
      if (!this.active || !this.fdn) return;
      const roomAmount = this.roomAmount;
      const ns = this.speakerCount;
      const earlyL = this.earlyL;
      const earlyR = this.earlyR;
      for (let j = 0; j < n; j++) {
        const x = wetL[j];
        const fdnOut = this.fdn.processSample(0, x / ns);
        wetL[j] = x + roomAmount * (earlyL[j] + fdnOut);
      }
      for (let j = 0; j < n; j++) {
        const x = wetR[j];
        const fdnOut = this.fdn.processSample(1, x / ns);
        wetR[j] = x + roomAmount * (earlyR[j] + fdnOut);
      }
    }
    /** 清零流式状态（历史环/低通状态/FDN 延迟线与指针；参数保留） */
    reset() {
      for (const st of this.states) {
        st.histL.fill(0);
        st.histR.fill(0);
        st.histPosL = 0;
        st.histPosR = 0;
        for (const t of st.taps) {
          t.lpStateL = 0;
          t.lpStateR = 0;
        }
      }
      if (this.fdn) {
        for (let i = 0; i < 8; i++) {
          this.fdn.linesL[i].fill(0);
          this.fdn.linesR[i].fill(0);
        }
        this.fdn.posL.fill(0);
        this.fdn.posR.fill(0);
        this.fdn.lpStateL.fill(0);
        this.fdn.lpStateR.fill(0);
      }
    }
  };

  // src/spatial/TsConvolverBackend.ts
  var PARTITION_SIZE = 512;
  var REF_DISTANCE = 1;
  var LINEAR_MAX_DISTANCE = 50;
  var AIR_FILTER_FC_BASE = 4e3;
  var SPEED_OF_SOUND2 = 343;
  var DOPPLER_RATE_MIN = 0.5;
  var DOPPLER_RATE_MAX = 2;
  var DEG2RAD2 = Math.PI / 180;
  var RESAMP_LINE = 1024;
  var RESAMP_START_DELAY = 512;
  var RESAMP_MIN_DELAY = 1;
  var RESAMP_MAX_DELAY = RESAMP_LINE - 2;
  var SIZE_BLUR_DEG = 30;
  var DECORR_LINE = 16;
  var OCC_GAIN_FACTOR = 0.8;
  var OCC_FC_BASE = 12e3;
  var OCC_FC_MIN = 1;
  var SOFTCLIP_THRESHOLD = 0.85;
  var RELOAD_FADE_SAMPLES = 256;
  var GAIN_SMOOTH_TAU = 0.02;
  function softClip(x) {
    const ax = x < 0 ? -x : x;
    if (ax <= SOFTCLIP_THRESHOLD) return x;
    const t = SOFTCLIP_THRESHOLD;
    const y = t + (1 - t) * Math.tanh((ax - t) / (1 - t));
    return x < 0 ? -y : y;
  }
  function distanceGain(model, d, ref = REF_DISTANCE, max = LINEAR_MAX_DISTANCE) {
    switch (model) {
      case "inverse":
        return Math.min(1, ref / Math.max(d, ref));
      case "linear":
        return Math.min(1, Math.max(0, 1 - (d - ref) / (Math.max(max, ref + 0.1) - ref)));
      case "exponential":
        return Math.pow(Math.max(d, ref) / ref, -1);
    }
  }
  function dopplerRate(vel, dirX, dirY, dirZ) {
    const vx = Math.fround(vel.x);
    const vy = Math.fround(vel.y);
    const vz = Math.fround(vel.z);
    const m = -vx * dirX - vy * dirY - vz * dirZ;
    const factor = SPEED_OF_SOUND2 / (SPEED_OF_SOUND2 + m);
    return Math.min(DOPPLER_RATE_MAX, Math.max(DOPPLER_RATE_MIN, factor));
  }
  function nearestGridIndex(grid, azimuthDeg, elevationDeg) {
    const azs = grid.azimuths;
    const els = grid.elevations;
    const az = ((azimuthDeg + 180) % 360 + 360) % 360 - 180;
    let azIdx = 0;
    let bestAz = Infinity;
    for (let i = 0; i < azs.length; i++) {
      const diff = Math.abs(az - azs[i]);
      const angDist = Math.min(diff, 360 - diff);
      if (angDist < bestAz) {
        bestAz = angDist;
        azIdx = i;
      }
    }
    const elClamped = Math.min(els[els.length - 1], Math.max(els[0], elevationDeg));
    let elIdx = 0;
    let bestEl = Infinity;
    for (let i = 0; i < els.length; i++) {
      const diff = Math.abs(elClamped - els[i]);
      if (diff < bestEl) {
        bestEl = diff;
        elIdx = i;
      }
    }
    return { azIdx, elIdx };
  }
  function mixHalf(a, b) {
    for (let j = 0; j < a.length; j++) {
      a[j] = (a[j] + b[j]) * 0.5;
    }
  }
  var TsConvolverBackend = class {
    fs = 48e3;
    // 由 loadHrtf(grid.sampleRate) 覆盖
    grid = null;
    speakers = [];
    // 每扬声器：左/右耳卷积引擎（partitioned=Convolver 分区 FFT / time=TimeConvolver
    // 时域直接卷积，接口同构可互换）+ 空气吸收状态 + 标量增益
    convL = [];
    convR = [];
    /** 控制路径预建的下一组卷积器；渲染线程淡出到零时只交换引用。 */
    pendingConvL = [];
    pendingConvR = [];
    /** 交换下来的旧实例暂存到控制路径回收，避免音频回调内析构。 */
    retiredConvL = [];
    retiredConvR = [];
    /** 卷积模式：'partitioned'=分区 FFT（默认）/ 'time'=时域直接卷积（契约 spatial_set_convolution_mode） */
    convMode = "partitioned";
    airState = new Float32Array(0);
    // 一阶低通 y 状态（每扬声器一个标量）
    airCoef = new Float32Array(0);
    // 一阶低通系数 a（每扬声器）
    distGain = new Float32Array(0);
    // 距离衰减 × 扬声器 gain × 遮挡增益（每扬声器标量，目标值）
    /** distGain 的当前平滑值（f64 存储——跨块保存平滑状态若经 f32 截断，分块与
     *  整块处理路径会产生 ~1e-7 漂移，破坏逐位确定性；renderProcess 逐样本逼近目标） */
    distGainCur = new Float64Array(0);
    lastAzIdx = new Int32Array(0);
    // 已装载 IR 的网格索引（防重复 loadIR）
    lastElIdx = new Int32Array(0);
    /** 已装载 IR 的声源大小（防重复 loadIR；与 lastAzIdx/lastElIdx 同语义） */
    lastSize = new Float32Array(0);
    // NaN 初始化强制新槽位首装载
    /** spherical 插值方向去重：上次装载方向/size（NaN 初始化强制首装载；|Δaz|+|Δel| < 0.5° 跳过重装） */
    lastShAz = new Float32Array(0);
    lastShEl = new Float32Array(0);
    lastShSize = new Float32Array(0);
    // —— IR 重装载状态机（爆音修复：淡出 → loadIR → 淡入）——
    /** 槽位卷积实例已装载过 IR（0=全新实例必须立即装载，否则 processStereo 抛错；1=已有 IR，可走淡出重装） */
    hasIr = new Uint8Array(0);
    /** 淡出/淡入相位：0=稳态满增益 1=淡出中（计数值递减）2=淡入中（计数值递增） */
    fadePhase = new Uint8Array(0);
    /** 淡变已推进样本数（phase1 从 RELOAD_FADE_SAMPLES 递减到 0 时执行装载转 phase2；phase2 递增到上限转 phase0） */
    fadeCount = new Int32Array(0);
    /** 干湿混合增益平滑状态（NaN = 首块直接跳到目标） */
    dryGState = NaN;
    wetGState = NaN;
    /** 插值模式：nearest=网格查表（波 1 原逻辑）/ spherical=球谐插值（见 hrtfInterp.ts） */
    interp = "nearest";
    /** 球谐插值 scratch（HRIR 对，长度 = hrirLength；loadHrtf 时分配） */
    shIrL = new Float32Array(0);
    shIrR = new Float32Array(0);
    // 干路延迟线（环形，长度 = 分区长度，与湿路延迟对齐）
    dryLineL = new Float32Array(0);
    dryLineR = new Float32Array(0);
    dryPos = 0;
    // 工作 scratch（稳态零分配，仅按需扩容）
    silenceL = new Float32Array(0);
    // 左耳卷积静音通道（就地写回会污染，需独立）
    silenceR = new Float32Array(0);
    // 右耳卷积静音通道（同上）
    srcL = new Float32Array(0);
    // 扬声器滤波信号（左耳卷积输入）
    srcR = new Float32Array(0);
    // 同一信号的副本（右耳卷积输入）
    wetL = new Float32Array(0);
    wetR = new Float32Array(0);
    /** 湿总线分组 scratch：每扬声器所属组代表索引（-1 未分组；renderProcess 按输入引用分组） */
    grpOf = new Int32Array(0);
    /** 湿总线分组 scratch：每扬声器组缩放系数（renderProcess 按输入引用分组计算） */
    grpScale = new Float32Array(0);
    // 当前配置（混合参数）
    amount = 1;
    masterGain = 1;
    distanceModel = "inverse";
    /** 距离衰减参考/最大距离（米，config 可配；缺省 REF_DISTANCE/LINEAR_MAX_DISTANCE） */
    refDistance = REF_DISTANCE;
    maxDistance = LINEAR_MAX_DISTANCE;
    /** 多普勒（§4.6，模式 C）：听者速度（null=未启用 → 直通） */
    dopplerVelocity = null;
    // 每扬声器重采样状态（小数延迟线，与 Rust 侧 SpeakerState 对齐）：
    rsmpRing = new Float32Array(0);
    // 环形延迟线（n×RESAMP_LINE）
    rsmpPos = new Int32Array(0);
    // 写指针（环内索引）
    rsmpDelay = new Float64Array(0);
    // 小数延迟（样本，f64）
    rsmpDirX = new Float64Array(0);
    // 方位单位向量（f64，setConfig 预计算）
    rsmpDirY = new Float64Array(0);
    rsmpDirZ = new Float64Array(0);
    // 声源大小 size（§4.7 扩散声源）：右耳去相关一阶线性插值小数延迟线（每 speaker 一条）
    decorrRing = new Float32Array(0);
    // n×DECORR_LINE 环形缓冲
    decorrPos = new Int32Array(0);
    // 写指针（环内索引）
    decorrDelay = new Float64Array(0);
    // 延迟样本 = size·6（f64；size 经 f32 量化）
    // 遮挡（§4.7，契约 spatial_set_occlusion）：全局量 → 每 speaker 增益衰减 + 空气式低通
    /** 遮挡量 0..1（config.occlusionAmount 钳位；0=旁路，与现状逐位一致） */
    occAmount = 0;
    /** 遮挡是否激活（occAmount > 0） */
    occActive = false;
    /** 空气式低通系数 a = 1−exp(−2π·fc/fs)，fc = max(12000·(1−occ), 1) Hz（f32 量化，与 Rust 侧 occ_alpha 对齐） */
    occCoef = 0;
    /** 增益衰减 (1 − 0.8·occ)（f32 量化；并入 distGain） */
    occGain = 1;
    /** 每 speaker 遮挡低通状态 y[n−1] */
    occState = new Float32Array(0);
    // 声源大小方向模糊 scratch（HRIR 对，长度 = hrirLength；loadHrtf 时分配）
    sizeIrL = new Float32Array(0);
    // 球谐分支第二方向 HRIR（左耳）
    sizeIrR = new Float32Array(0);
    mixIrL = new Float32Array(0);
    // 最近邻分支 50/50 混合目标（左耳）
    mixIrR = new Float32Array(0);
    // 房间模拟（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响，roomSim.ts 与 Rust 对拍）
    /** 房间处理器（config.room !== 'off' && roomAmount>0 && 有扬声器时创建；否则 null 旁路） */
    room = null;
    /** 上次 RoomSim 构造签名（preset + 扬声器几何 + 阶数）：签名不变时复用实例仅
     *  setAmount 更新混响量——避免每次 setConfig 重建截断 FDN 混响尾产生突变 */
    roomSig = "";
    /** 早期反射阶数（默认 2；setRoomEarlyOrders 修改，内部/测试接口） */
    roomEarlyOrders = 2;
    /**
     * 上次 syncSpeakers 配置的扬声器数量（增量更新基准）。
     * 用于判定 setConfig 时哪些扬声器槽位是"新增"（需初始化）vs "保留"（状态连续）：
     * 数组本身只扩容不收缩，故 _configuredN（而非数组长度）才反映实际在用槽位数。
     * 仅在 syncSpeakers 末尾更新；显式 reset() 不触碰（配置未变，仅流式状态清零）。
     */
    _configuredN = 0;
    maxBlockSize = 0;
    explicitlyPrepared = false;
    prepare(maxBlockSize) {
      const size = Number.isFinite(maxBlockSize) ? Math.max(0, Math.floor(maxBlockSize)) : 0;
      this.explicitlyPrepared = size > 0;
      this.allocateBlockScratch(size);
    }
    allocateBlockScratch(size) {
      if (size <= this.maxBlockSize) return;
      this.maxBlockSize = size;
      this.silenceL = new Float32Array(size);
      this.silenceR = new Float32Array(size);
      this.srcL = new Float32Array(size);
      this.srcR = new Float32Array(size);
      this.wetL = new Float32Array(size);
      this.wetR = new Float32Array(size);
      for (const convolver of this.convL) convolver.prepare(size);
      for (const convolver of this.convR) convolver.prepare(size);
      for (const convolver of this.pendingConvL) convolver?.prepare(size);
      for (const convolver of this.pendingConvR) convolver?.prepare(size);
      if (this.room) this.room.prepare(size);
    }
    loadHrtf(grid) {
      if (!grid || !Number.isFinite(grid.sampleRate) || grid.sampleRate <= 0) {
        throw new Error("invalid hrtf grid: sampleRate");
      }
      const azCount = grid.azimuths.length;
      const elCount = grid.elevations.length;
      const expect = elCount * azCount * grid.hrirLength;
      if (azCount < 1 || elCount < 1 || grid.hrirLength < 1 || grid.left.length !== expect || grid.right.length !== expect) {
        throw new Error("invalid hrtf grid: layout");
      }
      this.grid = grid;
      this.fs = grid.sampleRate;
      if (this.shIrL.length !== grid.hrirLength) {
        this.shIrL = new Float32Array(grid.hrirLength);
        this.shIrR = new Float32Array(grid.hrirLength);
        this.sizeIrL = new Float32Array(grid.hrirLength);
        this.sizeIrR = new Float32Array(grid.hrirLength);
        this.mixIrL = new Float32Array(grid.hrirLength);
        this.mixIrR = new Float32Array(grid.hrirLength);
      }
      if (this.speakers.length > 0) this.syncSpeakers(true);
    }
    setConfig(config) {
      if (!this.grid) {
        this.speakers = [];
        return;
      }
      this.speakers = config.speakers ?? [];
      this.amount = Math.min(1, Math.max(0, config.amount ?? 1));
      this.masterGain = config.masterGain ?? 1;
      this.distanceModel = config.distanceModel ?? "inverse";
      this.refDistance = Math.max(0.1, config.refDistance ?? REF_DISTANCE);
      this.maxDistance = Math.max(this.refDistance + 0.1, config.maxDistance ?? LINEAR_MAX_DISTANCE);
      this.dopplerVelocity = config.dopplerVelocity ? { x: config.dopplerVelocity.x, y: config.dopplerVelocity.y, z: config.dopplerVelocity.z } : null;
      const convMode = config.convolution === "time" ? "time" : "partitioned";
      if (convMode !== this.convMode) {
        this.convL = [];
        this.convR = [];
        this.pendingConvL = [];
        this.pendingConvR = [];
        this.retiredConvL = [];
        this.retiredConvR = [];
        this.convMode = convMode;
        this._configuredN = 0;
        if (this.hasIr.length > 0) this.hasIr.fill(0);
      }
      this.occAmount = Math.min(1, Math.max(0, config.occlusionAmount ?? 0));
      this.interp = config.hrtfInterp === "spherical" ? "spherical" : "nearest";
      const roomPreset = config.room ?? "off";
      const roomAmount = Math.max(0, config.roomAmount ?? 0);
      const roomActive = roomPreset !== "off" && roomAmount > 0 && this.speakers.length > 0;
      const roomScale = Math.min(2, Math.max(0.5, config.roomSizeScale ?? 1));
      const roomSig = roomActive ? roomPreset + "|" + roomScale + "|" + this.roomEarlyOrders + "|" + this.speakers.map((sp) => `${Math.fround(sp.azimuthDeg)},${Math.fround(sp.elevationDeg)},${Math.fround(sp.distance)},${sp.channel}`).join(";") : "";
      if (roomActive) {
        if (this.room && this.roomSig === roomSig) {
          this.room.setAmount(roomAmount);
        } else {
          this.room = new RoomSim(
            this.fs,
            config.speakers,
            roomParamsFromPreset(roomPreset, this.roomEarlyOrders, roomScale),
            roomAmount
          );
          if (this.maxBlockSize > 0) this.room.prepare(this.maxBlockSize);
          this.roomSig = roomSig;
        }
      } else {
        this.room = null;
        this.roomSig = "";
      }
      this.syncSpeakers(false);
    }
    /**
     * 设置早期反射阶数（0=关闭早期反射，只保留 FDN；0..3 钳位）。
     * 内部/测试接口（对应 Rust ABI spatial_set_room 的 early_orders 参数）：
     * 须在 setConfig 之前调用（setConfig 时按当前值初始化房间）。
     */
    setRoomEarlyOrders(orders) {
      this.roomEarlyOrders = Math.min(3, Math.max(0, Math.floor(orders)));
    }
    /** 按当前扬声器配置同步卷积器/状态（方向或网格变化时重装 IR，非热路径） */
    syncSpeakers(forceReload) {
      const grid = this.grid;
      if (!grid) return;
      this.retiredConvL.fill(null);
      this.retiredConvR.fill(null);
      const n = this.speakers.length;
      if (this.grpOf.length < n) {
        this.grpOf = new Int32Array(n);
        this.grpScale = new Float32Array(n);
      }
      while (this.convL.length < n) {
        this.convL.push(this.createConvolver());
        this.convR.push(this.createConvolver());
        this.pendingConvL.push(null);
        this.pendingConvR.push(null);
        this.retiredConvL.push(null);
        this.retiredConvR.push(null);
      }
      if (this.convL.length > n) {
        this.convL.length = n;
        this.convR.length = n;
        this.pendingConvL.length = n;
        this.pendingConvR.length = n;
        this.retiredConvL.length = n;
        this.retiredConvR.length = n;
      }
      if (this.airState.length < n) {
        const ns = new Float32Array(n);
        ns.set(this.airState.subarray(0, Math.min(this.airState.length, n)));
        this.airState = ns;
      }
      if (this.airCoef.length < n) {
        const nc = new Float32Array(n);
        nc.set(this.airCoef.subarray(0, Math.min(this.airCoef.length, n)));
        this.airCoef = nc;
      }
      if (this.distGain.length < n) {
        const ng = new Float32Array(n);
        ng.set(this.distGain.subarray(0, Math.min(this.distGain.length, n)));
        this.distGain = ng;
        const nc2 = new Float64Array(n);
        nc2.set(this.distGainCur.subarray(0, Math.min(this.distGainCur.length, n)));
        this.distGainCur = nc2;
      }
      if (this.lastAzIdx.length < n) {
        const na = new Int32Array(n);
        na.set(this.lastAzIdx.subarray(0, Math.min(this.lastAzIdx.length, n)));
        this.lastAzIdx = na;
      }
      if (this.lastElIdx.length < n) {
        const ne = new Int32Array(n);
        ne.set(this.lastElIdx.subarray(0, Math.min(this.lastElIdx.length, n)));
        this.lastElIdx = ne;
      }
      if (this.lastSize.length < n) {
        const ns = new Float32Array(n);
        ns.fill(NaN);
        ns.set(this.lastSize.subarray(0, Math.min(this.lastSize.length, n)));
        this.lastSize = ns;
      }
      if (this.lastShAz.length < n) {
        const a = new Float32Array(n);
        const e = new Float32Array(n);
        const sz = new Float32Array(n);
        a.fill(NaN);
        e.fill(NaN);
        sz.fill(NaN);
        this.lastShAz = a;
        this.lastShEl = e;
        this.lastShSize = sz;
      }
      if (this.hasIr.length < n) {
        const hi = new Uint8Array(n);
        hi.set(this.hasIr.subarray(0, Math.min(this.hasIr.length, n)));
        this.hasIr = hi;
        const fp = new Uint8Array(n);
        fp.set(this.fadePhase.subarray(0, Math.min(this.fadePhase.length, n)));
        this.fadePhase = fp;
        const fc = new Int32Array(n);
        fc.set(this.fadeCount.subarray(0, Math.min(this.fadeCount.length, n)));
        this.fadeCount = fc;
      }
      if (this.occState.length < n) {
        const ns = new Float32Array(n);
        ns.set(this.occState.subarray(0, Math.min(this.occState.length, n)));
        this.occState = ns;
      }
      if (this.dryLineL.length !== PARTITION_SIZE) {
        this.dryLineL = new Float32Array(PARTITION_SIZE);
        this.dryLineR = new Float32Array(PARTITION_SIZE);
        this.dryPos = 0;
      }
      const oldN = this._configuredN;
      if (this.rsmpRing.length < n * RESAMP_LINE) {
        const newRing = new Float32Array(n * RESAMP_LINE);
        const copyS = Math.min(oldN, n);
        if (copyS > 0) newRing.set(this.rsmpRing.subarray(0, copyS * RESAMP_LINE));
        this.rsmpRing = newRing;
      }
      if (this.rsmpPos.length < n) {
        const np = new Int32Array(n);
        np.set(this.rsmpPos.subarray(0, Math.min(this.rsmpPos.length, n)));
        this.rsmpPos = np;
        const nd = new Float64Array(n);
        nd.set(this.rsmpDelay.subarray(0, Math.min(this.rsmpDelay.length, n)));
        this.rsmpDelay = nd;
        const ndx = new Float64Array(n);
        ndx.set(this.rsmpDirX.subarray(0, Math.min(this.rsmpDirX.length, n)));
        this.rsmpDirX = ndx;
        const ndy = new Float64Array(n);
        ndy.set(this.rsmpDirY.subarray(0, Math.min(this.rsmpDirY.length, n)));
        this.rsmpDirY = ndy;
        const ndz = new Float64Array(n);
        ndz.set(this.rsmpDirZ.subarray(0, Math.min(this.rsmpDirZ.length, n)));
        this.rsmpDirZ = ndz;
      }
      if (this.decorrRing.length < n * DECORR_LINE) {
        const newRing = new Float32Array(n * DECORR_LINE);
        const copyS = Math.min(oldN, n);
        if (copyS > 0) newRing.set(this.decorrRing.subarray(0, copyS * DECORR_LINE));
        this.decorrRing = newRing;
      }
      if (this.decorrPos.length < n) {
        const np = new Int32Array(n);
        np.set(this.decorrPos.subarray(0, Math.min(this.decorrPos.length, n)));
        this.decorrPos = np;
        const nd = new Float64Array(n);
        nd.set(this.decorrDelay.subarray(0, Math.min(this.decorrDelay.length, n)));
        this.decorrDelay = nd;
      }
      for (let s = oldN; s < n; s++) {
        this.rsmpRing.fill(0, s * RESAMP_LINE, (s + 1) * RESAMP_LINE);
        this.decorrRing.fill(0, s * DECORR_LINE, (s + 1) * DECORR_LINE);
        this.rsmpPos[s] = 0;
        this.rsmpDelay[s] = RESAMP_START_DELAY;
        this.decorrPos[s] = 0;
        this.airState[s] = 0;
        this.occState[s] = 0;
        this.distGain[s] = 0;
        this.distGainCur[s] = 0;
        this.lastAzIdx[s] = -1;
        this.lastElIdx[s] = -1;
        this.lastSize[s] = NaN;
        this.lastShAz[s] = NaN;
        this.lastShEl[s] = NaN;
        this.lastShSize[s] = NaN;
        this.hasIr[s] = 0;
        this.fadePhase[s] = 0;
        this.fadeCount[s] = 0;
      }
      this._configuredN = n;
      const occ = this.occAmount;
      this.occActive = occ > 0;
      this.occGain = Math.fround(occ > 0 ? 1 - OCC_GAIN_FACTOR * occ : 1);
      this.occCoef = Math.fround(1 - Math.exp(-2 * Math.PI * Math.max(OCC_FC_BASE * (1 - occ), OCC_FC_MIN) / this.fs));
      for (let s = 0; s < n; s++) {
        const sp = this.speakers[s];
        const d = Math.fround(sp.distance);
        this.distGain[s] = distanceGain(this.distanceModel, d, this.refDistance, this.maxDistance) * Math.min(2, Math.max(0, sp.gain ?? 1)) * this.occGain;
        const fc = AIR_FILTER_FC_BASE / (1 + Math.fround(d));
        this.airCoef[s] = 1 - Math.exp(-2 * Math.PI * fc / this.fs);
        const size = Math.min(1, Math.max(0, sp.size ?? 0));
        this.decorrDelay[s] = Math.fround(size) * 6;
        const azRad = Math.fround(sp.azimuthDeg) * DEG2RAD2;
        const elRad = Math.fround(sp.elevationDeg) * DEG2RAD2;
        const dRawX = Math.cos(elRad) * Math.sin(azRad);
        const dRawY = Math.sin(elRad);
        const dRawZ = Math.cos(elRad) * Math.cos(azRad);
        const dLen = Math.sqrt(dRawX * dRawX + dRawY * dRawY + dRawZ * dRawZ);
        this.rsmpDirX[s] = dRawX / dLen;
        this.rsmpDirY[s] = dRawY / dLen;
        this.rsmpDirZ[s] = dRawZ / dLen;
        if (this.interp === "spherical") {
          const azF = Math.fround(sp.azimuthDeg);
          const elF = Math.fround(sp.elevationDeg);
          const sizeF = Math.fround(size);
          const lastAz = this.lastShAz[s];
          const azDiff = Math.abs((azF - lastAz + 540) % 360 - 180);
          const needReload = !Number.isFinite(lastAz) || azDiff >= 0.5 || Math.abs(elF - this.lastShEl[s]) >= 0.5 || sizeF !== this.lastShSize[s];
          if (needReload || forceReload) {
            if (size > 0) {
              const az1 = azF - sizeF * SIZE_BLUR_DEG;
              const az2 = azF + sizeF * SIZE_BLUR_DEG;
              sphericalHrtf(grid, az1, sp.elevationDeg, this.shIrL, this.shIrR);
              sphericalHrtf(grid, az2, sp.elevationDeg, this.sizeIrL, this.sizeIrR);
              mixHalf(this.shIrL, this.sizeIrL);
              mixHalf(this.shIrR, this.sizeIrR);
            } else {
              sphericalHrtf(grid, sp.azimuthDeg, sp.elevationDeg, this.shIrL, this.shIrR);
            }
            this.queueIr(s, this.shIrL, this.shIrR);
            this.lastShAz[s] = azF;
            this.lastShEl[s] = elF;
            this.lastShSize[s] = sizeF;
          }
        } else {
          const { azIdx, elIdx } = nearestGridIndex(grid, sp.azimuthDeg, sp.elevationDeg);
          if (forceReload || this.lastAzIdx[s] !== azIdx || this.lastElIdx[s] !== elIdx || this.lastSize[s] !== size) {
            const azc = grid.azimuths.length;
            const M = grid.hrirLength;
            let irL;
            let irR;
            if (size > 0) {
              const az1 = Math.fround(sp.azimuthDeg) - Math.fround(size) * SIZE_BLUR_DEG;
              const az2 = Math.fround(sp.azimuthDeg) + Math.fround(size) * SIZE_BLUR_DEG;
              const a1 = nearestGridIndex(grid, az1, sp.elevationDeg);
              const a2 = nearestGridIndex(grid, az2, sp.elevationDeg);
              const b1 = (a1.elIdx * azc + a1.azIdx) * M;
              const b2 = (a2.elIdx * azc + a2.azIdx) * M;
              for (let j = 0; j < M; j++) {
                this.mixIrL[j] = (grid.left[b1 + j] + grid.left[b2 + j]) * 0.5;
                this.mixIrR[j] = (grid.right[b1 + j] + grid.right[b2 + j]) * 0.5;
              }
              irL = this.mixIrL;
              irR = this.mixIrR;
            } else {
              const base = (elIdx * azc + azIdx) * M;
              irL = grid.left.subarray(base, base + M);
              irR = grid.right.subarray(base, base + M);
            }
            this.queueIr(s, irL, irR);
            this.lastAzIdx[s] = azIdx;
            this.lastElIdx[s] = elIdx;
            this.lastSize[s] = size;
          }
        }
      }
      for (let s = oldN; s < n; s++) {
        this.distGainCur[s] = NaN;
      }
    }
    createConvolver() {
      const convolver = this.convMode === "time" ? new TimeConvolver(this.fs, { partitionSize: PARTITION_SIZE }) : new Convolver(this.fs, { partitionSize: PARTITION_SIZE });
      if (this.maxBlockSize > 0) convolver.prepare(this.maxBlockSize);
      return convolver;
    }
    /**
     * IR 装载入队（爆音修复）：已有 IR 的槽位在控制路径预建下一组卷积器，
     * 渲染路径只负责旧湿路淡出、交换已完成的实例引用、再淡入；FFT、数组分配和
     * 旧实例析构都不会发生在 process 回调内。全新槽位/实例立即装载并从 0 淡入。
     */
    queueIr(s, irL, irR) {
      if (!this.grid) return;
      if (this.hasIr[s]) {
        const nextL = this.createConvolver();
        const nextR = this.createConvolver();
        nextL.loadIR(irL, `sp${s}-L`);
        nextR.loadIR(irR, `sp${s}-R`);
        this.pendingConvL[s] = nextL;
        this.pendingConvR[s] = nextR;
        this.fadePhase[s] = 1;
        this.fadeCount[s] = RELOAD_FADE_SAMPLES;
      } else {
        this.convL[s].loadIR(irL, `sp${s}-L`);
        this.convR[s].loadIR(irR, `sp${s}-R`);
        this.hasIr[s] = 1;
        this.fadePhase[s] = 2;
        this.fadeCount[s] = -PARTITION_SIZE;
      }
    }
    setListener(_listener) {
    }
    /**
     * 查询指定方向的 HRIR 对（规划书 §3.2 契约）：与渲染同网格/同插值路径——
     * nearest=最近邻网格查表（nearestGridIndex，返回网格原数据段拷贝）/
     * spherical=球谐插值（hrtfInterp.sphericalHrtf）。返回 { left, right }
     * （各为长度 = grid.hrirLength 的新 Float32Array）。
     * 对应 Rust 侧 spatial_get_hrir（ABI 契约；与 Rust build_speaker 装载分支
     * 同源同路径——注释互标）。
     */
    getHrir(azimuthDeg, elevationDeg) {
      const grid = this.grid;
      if (!grid) {
        throw new Error("TsConvolverBackend: \u5C1A\u672A loadHrtf\uFF08getHrir \u9700\u5148\u88C5\u8F7D\u7F51\u683C\uFF09");
      }
      const M = grid.hrirLength;
      const left = new Float32Array(M);
      const right = new Float32Array(M);
      if (this.interp === "spherical") {
        sphericalHrtf(grid, azimuthDeg, elevationDeg, left, right);
      } else {
        const { azIdx, elIdx } = nearestGridIndex(grid, azimuthDeg, elevationDeg);
        const base = (elIdx * grid.azimuths.length + azIdx) * M;
        left.set(grid.left.subarray(base, base + M));
        right.set(grid.right.subarray(base, base + M));
      }
      return { left, right };
    }
    processStereo(inL, inR, outL, outR, frameCount) {
      this.renderProcess(null, inL, inR, outL, outR, frameCount);
    }
    /**
     * 多声道输入渲染（SpatialBackend.processMulti 可选方法）：N 路单声道输入 → 双耳。
     * 与 processStereo 同算法仅输入侧扩展——speaker.channel < inputs.length 时取对应
     * 输入；越界取 0 号输入；干路 = 0/1 号输入（立体声下混）。相同 speaker 配置下
     * 2 路输入与 processStereo 输出逐位一致（回归测试）。
     */
    processMulti(inputs, outL, outR, frameCount) {
      if (inputs.length === 0) {
        outL.fill(0);
        outR.fill(0);
        return;
      }
      const inL = inputs[0];
      const inR = inputs.length > 1 ? inputs[1] : inputs[0];
      this.renderProcess(inputs, inL, inR, outL, outR, frameCount);
    }
    sourceForSpeaker(inputs, inL, inR, speakerIndex) {
      const channel = this.speakers[speakerIndex].channel;
      if (!inputs) return channel <= 0 ? inL : inR;
      return channel < inputs.length ? inputs[channel] : inputs[0];
    }
    /**
     * 公共渲染内核（processStereo / processMulti 共用；输入数组只做源声道选择，
     * 全部 DSP 算术与顺序逐位一致）：
     * 干路延迟线（512 对齐）→ 逐扬声器吸收/距离增益/遮挡/多普勒/去相关/卷积 →
     * 房间早期反射 + FDN → 干湿混合。
     */
    renderProcess(inputs, inL, inR, outL, outR, frameCount) {
      const requested = frameCount === void 0 ? Math.min(inL.length, inR.length, outL.length, outR.length) : Math.floor(frameCount);
      const B = Math.max(0, Math.min(requested, inL.length, inR.length, outL.length, outR.length));
      if (B <= 0) return;
      if (this.maxBlockSize === 0) this.allocateBlockScratch(B);
      if (B > this.maxBlockSize) {
        if (this.explicitlyPrepared) {
          throw new Error(`TsConvolverBackend block ${B} exceeds prepared capacity ${this.maxBlockSize}`);
        }
        this.allocateBlockScratch(B);
      }
      const n = this.speakers.length;
      if (n === 0) {
        for (let i = 0; i < B; i++) {
          outL[i] = inL[i];
          outR[i] = inR[i];
        }
        return;
      }
      for (let i = 0; i < B; i++) {
        outL[i] = this.dryLineL[this.dryPos];
        outR[i] = this.dryLineR[this.dryPos];
        this.dryLineL[this.dryPos] = inL[i];
        this.dryLineR[this.dryPos] = inR[i];
        this.dryPos++;
        if (this.dryPos >= PARTITION_SIZE) this.dryPos = 0;
      }
      if (this.room) this.room.beginBlock(B);
      this.wetL.fill(0, 0, B);
      this.wetR.fill(0, 0, B);
      const gainCoef = 1 - Math.exp(-1 / (this.fs * GAIN_SMOOTH_TAU));
      for (let s = 0; s < n; s++) this.grpOf[s] = -1;
      for (let s = 0; s < n; s++) {
        if (this.grpOf[s] !== -1) continue;
        const srcS = this.sourceForSpeaker(inputs, inL, inR, s);
        let e = this.distGain[s] * this.distGain[s];
        for (let k = s + 1; k < n; k++) {
          if (this.grpOf[k] === -1 && this.sourceForSpeaker(inputs, inL, inR, k) === srcS) {
            this.grpOf[k] = s;
            e += this.distGain[k] * this.distGain[k];
          }
        }
        this.grpOf[s] = s;
        const scale = e > 1 ? 1 / Math.sqrt(e) : 1;
        this.grpScale[s] = scale;
      }
      for (let s = 0; s < n; s++) {
        const src = this.sourceForSpeaker(inputs, inL, inR, s);
        const gTarget = this.distGain[s] * this.grpScale[this.grpOf[s]];
        let g = this.distGainCur[s];
        if (Number.isNaN(g)) g = gTarget;
        const a = this.airCoef[s];
        const sl = this.srcL;
        const sr = this.srcR;
        for (let i = 0; i < B; i++) {
          g += gainCoef * (gTarget - g);
          const v = src[i] * g;
          sl[i] = v;
          sr[i] = v;
        }
        this.distGainCur[s] = g;
        for (let i = 0; i < B; i++) {
          let y = this.airState[s];
          y += a * (sl[i] - y);
          this.airState[s] = y;
          sl[i] = y;
          sr[i] = y;
        }
        if (this.occActive) {
          let oy = this.occState[s];
          const oa = this.occCoef;
          for (let i = 0; i < B; i++) {
            oy += oa * (sl[i] - oy);
            sl[i] = oy;
            sr[i] = oy;
          }
          this.occState[s] = oy;
        }
        if (this.dopplerVelocity) {
          const rate = dopplerRate(this.dopplerVelocity, this.rsmpDirX[s], this.rsmpDirY[s], this.rsmpDirZ[s]);
          if (rate !== 1) {
            this.resampleSpeaker(s, sl, B, rate);
            for (let i = 0; i < B; i++) sr[i] = sl[i];
          }
        }
        if (this.decorrDelay[s] > 0) {
          this.decorrRight(s, sr, B);
        }
        this.silenceL.fill(0, 0, B);
        this.silenceR.fill(0, 0, B);
        this.convL[s].processStereo(this.srcL, this.silenceL, B);
        this.convR[s].processStereo(this.silenceR, this.srcR, B);
        let phase = this.fadePhase[s];
        let swapAfterBlock = false;
        if (phase !== 0) {
          let count = this.fadeCount[s];
          for (let i = 0; i < B; i++) {
            if (phase === 0) continue;
            let fg = 1;
            if (phase === 1) {
              count--;
              fg = count > 0 ? count / RELOAD_FADE_SAMPLES : 0;
              if (count <= 0) {
                swapAfterBlock = true;
                count = 0;
                fg = 0;
              }
            } else {
              count++;
              if (count >= RELOAD_FADE_SAMPLES) {
                phase = 0;
              } else {
                fg = count > 0 ? count / RELOAD_FADE_SAMPLES : 0;
              }
            }
            if (fg !== 1) {
              sl[i] *= fg;
              sr[i] *= fg;
            }
          }
          if (swapAfterBlock) {
            const nextL = this.pendingConvL[s];
            const nextR = this.pendingConvR[s];
            if (nextL && nextR) {
              this.retiredConvL[s] = this.convL[s];
              this.retiredConvR[s] = this.convR[s];
              this.convL[s] = nextL;
              this.convR[s] = nextR;
              this.pendingConvL[s] = null;
              this.pendingConvR[s] = null;
            }
            phase = 2;
            count = -PARTITION_SIZE;
          }
          this.fadePhase[s] = phase;
          this.fadeCount[s] = count;
        }
        for (let i = 0; i < B; i++) {
          this.wetL[i] += sl[i];
          this.wetR[i] += sr[i];
        }
        if (this.room) this.room.early(s, sl, sr, B);
      }
      if (this.room) this.room.lateAndMix(this.wetL, this.wetR, B);
      const dryT = (1 - this.amount) * this.masterGain;
      const wetT = this.amount * this.masterGain;
      if (Number.isNaN(this.dryGState)) {
        this.dryGState = dryT;
        this.wetGState = wetT;
      }
      let dg = this.dryGState;
      let wg = this.wetGState;
      for (let i = 0; i < B; i++) {
        dg += gainCoef * (dryT - dg);
        wg += gainCoef * (wetT - wg);
        outL[i] = softClip(dg * outL[i] + wg * this.wetL[i]);
        outR[i] = softClip(dg * outR[i] + wg * this.wetR[i]);
      }
      this.dryGState = dg;
      this.wetGState = wg;
    }
    getLatencySamples() {
      return this.speakers.length > 0 ? PARTITION_SIZE : 0;
    }
    /**
     * 时变重采样（小数延迟线 + 线性插值，与 Rust 侧逐位对齐）：buf 就地重采样 n 个样本，
     * 每输出样本依次——
     *   1) 输入样本写入环形延迟线（写指针 +1）；
     *   2) delay += 1 − rate（rate>1 读指针前移 → 时间压缩/音调升高；<1 后移 → 拉伸）；
     *   3) delay 钳位 [RESAMP_MIN_DELAY, RESAMP_MAX_DELAY]——延迟线饱和后速率回落 1
     *      （恒定速率下效果持续约 (MAX−START)/|rate−1| 样本，规划书 §4.6 简化模型）；
     *   4) 读指针 pos = 最新样本索引 − (delay − 1)，floor/frac 线性插值（f64 计算、f32 写回）。
     * rate==1 直通（调用方保证不进入本方法）。
     */
    resampleSpeaker(s, buf, n, rate) {
      const DLINE = RESAMP_LINE;
      const base = s * DLINE;
      let wp = this.rsmpPos[s];
      let delay = this.rsmpDelay[s];
      for (let i = 0; i < n; i++) {
        this.rsmpRing[base + wp] = buf[i];
        wp = (wp + 1) % DLINE;
        delay += 1 - rate;
        if (delay < RESAMP_MIN_DELAY) delay = RESAMP_MIN_DELAY;
        else if (delay > RESAMP_MAX_DELAY) delay = RESAMP_MAX_DELAY;
        const pos = (wp - 1 + DLINE) % DLINE - (delay - 1);
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        let idx0 = i0 % DLINE;
        if (idx0 < 0) idx0 += DLINE;
        let idx1 = idx0 + 1;
        if (idx1 >= DLINE) idx1 = 0;
        buf[i] = this.rsmpRing[base + idx0] * (1 - frac) + this.rsmpRing[base + idx1] * frac;
      }
      this.rsmpPos[s] = wp;
      this.rsmpDelay[s] = delay;
    }
    /**
     * 双耳去相关（§4.7 声源大小 size）：buf 就地延迟 size·6 样本（一阶线性插值延迟线，
     * 与 Rust 侧 SpeakerState::decorr_next 逐位对齐）——
     *   1) 输入样本写入环形延迟线（写指针 +1）；
     *   2) 读指针 pos = 最新样本索引 − delay（delay = size·6 ∈ (0, 6]；
     *      delay>0 时 pos < newest，双抽头均为已写样本）；
     *   3) floor/frac 线性插值（f64 计算、f32 写回）。
     * 仅右耳源调用（左耳不延迟，产生双耳去相关的"更宽方向感"）；size=0 时调用方
     * 跳过（直通，不触碰延迟线状态）。
     */
    decorrRight(s, buf, n) {
      const DLINE = DECORR_LINE;
      const base = s * DLINE;
      const d = this.decorrDelay[s];
      let wp = this.decorrPos[s];
      for (let i = 0; i < n; i++) {
        this.decorrRing[base + wp] = buf[i];
        wp = (wp + 1) % DLINE;
        const newest = (wp + DLINE - 1) % DLINE;
        const pos = newest - d;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        let idx0 = i0 % DLINE;
        if (idx0 < 0) idx0 += DLINE;
        let idx1 = idx0 + 1;
        if (idx1 >= DLINE) idx1 = 0;
        buf[i] = this.decorrRing[base + idx0] * (1 - frac) + this.decorrRing[base + idx1] * frac;
      }
      this.decorrPos[s] = wp;
    }
    reset() {
      for (let s = 0; s < this.convL.length; s++) {
        this.convL[s].reset();
        this.convR[s].reset();
      }
      if (this.airState.length > 0) this.airState.fill(0);
      if (this.occState.length > 0) this.occState.fill(0);
      if (this.dryLineL.length > 0) {
        this.dryLineL.fill(0);
        this.dryLineR.fill(0);
      }
      this.dryPos = 0;
      if (this.rsmpRing.length > 0) this.rsmpRing.fill(0);
      if (this.rsmpPos.length > 0) {
        this.rsmpPos.fill(0);
        this.rsmpDelay.fill(RESAMP_START_DELAY);
      }
      if (this.decorrRing.length > 0) this.decorrRing.fill(0);
      if (this.decorrPos.length > 0) this.decorrPos.fill(0);
      this.dryGState = NaN;
      this.wetGState = NaN;
      for (let s = 0; s < this.distGainCur.length; s++) this.distGainCur[s] = NaN;
      if (this.fadePhase.length > 0) {
        for (let s = 0; s < this.fadePhase.length; s++) {
          if (this.fadePhase[s] === 1) {
            const nextL = this.pendingConvL[s];
            const nextR = this.pendingConvR[s];
            if (nextL && nextR) {
              this.convL[s] = nextL;
              this.convR[s] = nextR;
              this.pendingConvL[s] = null;
              this.pendingConvR[s] = null;
            }
          }
          if (this.hasIr[s]) {
            this.fadePhase[s] = 2;
            this.fadeCount[s] = -PARTITION_SIZE;
          } else {
            this.fadePhase[s] = 0;
            this.fadeCount[s] = 0;
          }
        }
      }
      this.room?.reset();
    }
  };

  // src/spatial/analyticHrtf.ts
  var HEAD_RADIUS = 0.0875;
  var SPEED_OF_SOUND3 = 343;
  var HRIR_LENGTH = 256;
  var AZ_COUNT = 72;
  var AZ_STEP = 5;
  var EL_COUNT = 14;
  var EL_STEP = 10;
  var SINC_FC_MAX = 14e3;
  var TAIL_TAU_SECONDS = 1e-3;
  function woodworthItdSeconds(theta) {
    if (theta <= Math.PI / 2) {
      return HEAD_RADIUS / SPEED_OF_SOUND3 * (Math.sin(theta) + theta);
    }
    return HEAD_RADIUS / SPEED_OF_SOUND3 * (Math.PI - theta + Math.sin(theta));
  }
  function buildHrir(delaySamples, fc, fs) {
    const h = new Float32Array(HRIR_LENGTH);
    const tau = TAIL_TAU_SECONDS * fs;
    for (let n = 0; n < HRIR_LENGTH; n++) {
      const x = n - delaySamples;
      let v;
      if (x === 0) {
        v = 2 * fc / fs;
      } else {
        v = Math.sin(2 * Math.PI * fc * x / fs) / (Math.PI * x);
      }
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (HRIR_LENGTH - 1));
      h[n] = v * w;
      if (n > delaySamples) {
        h[n] *= Math.exp(-(n - delaySamples) / tau);
      }
    }
    return h;
  }
  function onePoleLowpassInPlace(x, fc, fs) {
    const a = 1 - Math.exp(-2 * Math.PI * fc / fs);
    let y = 0;
    for (let i = 0; i < x.length; i++) {
      y += a * (x[i] - y);
      x[i] = y;
    }
  }
  function generateAnalyticHrtfGrid(sampleRate2) {
    const azimuths = [];
    for (let a = 0; a < AZ_COUNT; a++) azimuths.push(-180 + a * AZ_STEP);
    const elevations = [];
    for (let e = 0; e < EL_COUNT; e++) elevations.push(-40 + e * EL_STEP);
    const left = new Float32Array(EL_COUNT * AZ_COUNT * HRIR_LENGTH);
    const right = new Float32Array(EL_COUNT * AZ_COUNT * HRIR_LENGTH);
    const fc = Math.min(SINC_FC_MAX, 0.45 * sampleRate2);
    const center = Math.floor(HRIR_LENGTH / 2);
    for (let elIdx = 0; elIdx < EL_COUNT; elIdx++) {
      for (let azIdx = 0; azIdx < AZ_COUNT; azIdx++) {
        const az = azimuths[azIdx];
        const theta = Math.abs(az) * (Math.PI / 180);
        const itdSamples = woodworthItdSeconds(theta) * sampleRate2;
        const farDelay = Math.min(center + itdSamples, HRIR_LENGTH - 2);
        const shadowGain = 1 / (1 + Math.sin(theta / 2) ** 2);
        const shadowFc = 12e3 * Math.cos(theta / 2) ** 2 + 150;
        const nearIsRight = az >= 0;
        const nearH = buildHrir(center, fc, sampleRate2);
        const farH = buildHrir(farDelay, fc, sampleRate2);
        let sumNear = 0;
        for (let i = 0; i < HRIR_LENGTH; i++) sumNear += nearH[i];
        const norm = Math.abs(sumNear) > 1e-12 ? 1 / sumNear : 1;
        for (let i = 0; i < HRIR_LENGTH; i++) {
          nearH[i] *= norm;
          farH[i] *= norm;
        }
        onePoleLowpassInPlace(farH, shadowFc, sampleRate2);
        for (let i = 0; i < HRIR_LENGTH; i++) farH[i] *= shadowGain;
        const base = (elIdx * AZ_COUNT + azIdx) * HRIR_LENGTH;
        if (nearIsRight) {
          right.set(nearH, base);
          left.set(farH, base);
        } else {
          left.set(nearH, base);
          right.set(farH, base);
        }
      }
    }
    return {
      sampleRate: sampleRate2,
      azimuths,
      elevations,
      hrirLength: HRIR_LENGTH,
      left,
      right
    };
  }

  // src/spatial/scenes.ts
  var SEAT_DISTANCE_SCALE = {
    front: 0.8,
    middle: 1,
    back: 1.35
  };
  var STAGE_SCENES = [
    {
      id: "stage",
      name: "\u97F3\u4E50\u821E\u53F0",
      description: "Live \u4E50\u961F\u5168\u666F\uFF1A\u4E3B\u5531\u5C45\u4E2D\uFF0C\u4E50\u5668\u73AF\u7ED5\u5C55\u5F00\uFF0C\u821E\u53F0\u7EB5\u6DF1\u611F",
      speakers: [
        { azimuthDeg: 0, elevationDeg: 0, distance: 2.5, gain: 1, size: 0 },
        // 主唱：正前居中
        { azimuthDeg: -30, elevationDeg: 0, distance: 4, gain: 1, size: 0 },
        // 吉他：左前
        { azimuthDeg: 30, elevationDeg: 0, distance: 4, gain: 1, size: 0 },
        // 贝斯：右前
        { azimuthDeg: 10, elevationDeg: 0, distance: 6, gain: 1, size: 0 },
        // 鼓：居中偏右稍远
        { azimuthDeg: -20, elevationDeg: 0, distance: 5, gain: 1, size: 0 },
        // 键盘：左前偏中
        { azimuthDeg: -110, elevationDeg: 0, distance: 8, gain: 1, size: 0 },
        // 环境环绕：左
        { azimuthDeg: 110, elevationDeg: 0, distance: 8, gain: 1, size: 0 }
        // 环境环绕：右
      ],
      room: "stage"
    },
    {
      id: "cinema",
      name: "\u7535\u5F71\u9662",
      description: "7.1.4 \u5F71\u9662\u5E03\u5C40\uFF1A\u94F6\u5E55\u5BF9\u767D + \u4FA7\u540E\u73AF\u7ED5 + \u9876\u7F6E\u5929\u7A7A\u58F0\u9053",
      speakers: [
        { azimuthDeg: 0, elevationDeg: 0, distance: 4, gain: 1, size: 0 },
        // C：银幕中央
        { azimuthDeg: -30, elevationDeg: 0, distance: 4, gain: 1, size: 0 },
        // FL：银幕左
        { azimuthDeg: 30, elevationDeg: 0, distance: 4, gain: 1, size: 0 },
        // FR：银幕右
        { azimuthDeg: -100, elevationDeg: 0, distance: 7, gain: 1, size: 0 },
        // SL：左侧环绕
        { azimuthDeg: 100, elevationDeg: 0, distance: 7, gain: 1, size: 0 },
        // SR：右侧环绕
        { azimuthDeg: -135, elevationDeg: 0, distance: 7, gain: 1, size: 0 },
        // RL：左后环绕
        { azimuthDeg: 135, elevationDeg: 0, distance: 7, gain: 1, size: 0 },
        // RR：右后环绕
        { azimuthDeg: -45, elevationDeg: 45, distance: 5, gain: 1, size: 0 },
        // TFL：左前顶置
        { azimuthDeg: 45, elevationDeg: 45, distance: 5, gain: 1, size: 0 },
        // TFR：右前顶置
        { azimuthDeg: -135, elevationDeg: 45, distance: 5, gain: 1, size: 0 },
        // TRL：左后顶置
        { azimuthDeg: 135, elevationDeg: 45, distance: 5, gain: 1, size: 0 }
        // TRR：右后顶置
      ],
      room: "hall"
    },
    {
      id: "piano",
      name: "\u94A2\u7434\u72EC\u594F",
      description: "\u72EC\u594F\u94A2\u7434\u5C45\u4E2D\uFF0C\u97F3\u4E50\u5385\u957F\u5C3E\u6DF7\u54CD\u73AF\u7ED5\uFF0C\u9759\u8C27\u6C89\u6D78",
      speakers: [
        { azimuthDeg: 0, elevationDeg: 0, distance: 2, gain: 1, size: 0 },
        // 钢琴：正前近场
        { azimuthDeg: -90, elevationDeg: 0, distance: 9, gain: 1, size: 0 },
        // 音乐厅环境：左
        { azimuthDeg: 90, elevationDeg: 0, distance: 9, gain: 1, size: 0 },
        // 音乐厅环境：右
        { azimuthDeg: 180, elevationDeg: 0, distance: 10, gain: 1, size: 0 }
        // 音乐厅环境：正后
      ],
      room: "hall"
    },
    {
      id: "nature",
      name: "\u81EA\u7136\u573A\u666F",
      description: "\u96E8\u58F0\u5934\u9876\u3001\u96F7\u58F0\u8EAB\u540E\u3001\u9E1F\u9E23\u6EAA\u6D41\uFF0C\u7F6E\u8EAB\u6237\u5916\u65F7\u91CE",
      speakers: [
        { azimuthDeg: 0, elevationDeg: 50, distance: 7, gain: 1, size: 0 },
        // 雨：头顶上方（仰角 50°）
        { azimuthDeg: 180, elevationDeg: 0, distance: 15, gain: 1, size: 0 },
        // 雷：正后方远处
        { azimuthDeg: -140, elevationDeg: 20, distance: 8, gain: 1, size: 0 },
        // 鸟：左后上方（仰角 20°）
        { azimuthDeg: 110, elevationDeg: 0, distance: 6, gain: 1, size: 0 }
        // 溪流：右前方
      ],
      room: "outdoor"
    }
  ];
  function sceneById(id) {
    const found = STAGE_SCENES.find((s) => s.id === id);
    return found ?? STAGE_SCENES[0];
  }
  var DIST_MIN = 0.5;
  var DIST_MAX = 10;
  function clampDistance(d) {
    return Math.min(DIST_MAX, Math.max(DIST_MIN, d));
  }
  function stageSpeakers(p) {
    const scene = sceneById(p.preset);
    const seatScale = SEAT_DISTANCE_SCALE[p.seat] ?? 1;
    const roomScale = Math.min(2, Math.max(0.5, p.roomSize));
    return scene.speakers.map((s) => ({
      ...s,
      distance: clampDistance(s.distance * seatScale * roomScale)
    }));
  }
  function stageRoom(p) {
    return sceneById(p.preset).room;
  }

  // src/spatial/controller.ts
  function computeWorldVelocity(prev, current) {
    if (!prev) return { x: 0, y: 0, z: 0 };
    const dt = current.playhead - prev.playhead;
    if (!Number.isFinite(dt) || dt <= 0) return { x: 0, y: 0, z: 0 };
    return {
      x: (current.position.x - prev.position.x) / dt,
      y: (current.position.y - prev.position.y) / dt,
      z: (current.position.z - prev.position.z) / dt
    };
  }
  function wrapAzimuthDeg(angle) {
    return ((angle + 180) % 360 + 360) % 360 - 180;
  }
  function computeRelativeDirection(listener, source) {
    if (![
      listener.position.x,
      listener.position.y,
      listener.position.z,
      listener.yaw,
      listener.pitch ?? 0,
      listener.roll ?? 0,
      source.x,
      source.y,
      source.z
    ].every(Number.isFinite)) {
      throw new Error("computeRelativeDirection: listener and source values must be finite");
    }
    const dx = source.x - listener.position.x;
    const dy = source.y - listener.position.y;
    const dz = source.z - listener.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance === 0) {
      return { azimuthDeg: 0, elevationDeg: 0, distance: 0 };
    }
    const yaw = -(listener.yaw * Math.PI) / 180;
    const pitch = (listener.pitch ?? 0) * Math.PI / 180;
    const roll = -((listener.roll ?? 0) * Math.PI) / 180;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const yawX = cy * dx + sy * dz;
    const yawZ = -sy * dx + cy * dz;
    const pitchY = cp * dy - sp * yawZ;
    const pitchZ = sp * dy + cp * yawZ;
    const headX = cr * yawX + sr * pitchY;
    const headY = -sr * yawX + cr * pitchY;
    const azimuthDeg = wrapAzimuthDeg(Math.atan2(headX, pitchZ) * 180 / Math.PI);
    const elevationDeg = Math.asin(Math.max(-1, Math.min(1, headY / distance))) * 180 / Math.PI;
    return { azimuthDeg, elevationDeg, distance };
  }
  function computeTrajectoryPosition(keyframes, t) {
    if (keyframes.length === 0) return { x: 0, y: 0, z: 0 };
    const sorted = [...keyframes].sort((a, b) => a.t - b.t);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (t <= first.t) return { ...first.position };
    if (t >= last.t) return { ...last.position };
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        const u = span === 0 ? 0 : (t - a.t) / span;
        return {
          x: a.position.x + (b.position.x - a.position.x) * u,
          y: a.position.y + (b.position.y - a.position.y) * u,
          z: a.position.z + (b.position.z - a.position.z) * u
        };
      }
    }
    return { ...last.position };
  }

  // src/spatial/ambisonics.ts
  var AMBIENCE_SPEAKERS = [
    { azimuthDeg: 45, elevationDeg: 0 },
    { azimuthDeg: 135, elevationDeg: 0 },
    { azimuthDeg: 225, elevationDeg: 0 },
    { azimuthDeg: 315, elevationDeg: 0 }
  ];
  function decodeFoaToSpeakers(foa, azimuths, out) {
    if (out.length < azimuths.length) throw new Error("decodeFoaToSpeakers: output buffer is too small");
    for (let i = 0; i < azimuths.length; i++) {
      const az = azimuths[i] * Math.PI / 180;
      out[i] = foa[0] / Math.SQRT2 + Math.cos(az) * foa[1] + Math.sin(az) * foa[2];
    }
    return out;
  }
  function stereoToFoa(l, r, frameCount, out) {
    if (out.length < 4) throw new Error("stereoToFoa: output buffer is too small");
    const requested = Number.isFinite(frameCount) ? Math.floor(frameCount) : 0;
    const n = Math.max(0, Math.min(requested, l.length, r.length));
    if (n <= 0) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return out;
    }
    let sMid = 0;
    let sSide = 0;
    for (let i = 0; i < n; i++) {
      const mid = (l[i] + r[i]) * 0.5;
      const side = (l[i] - r[i]) * 0.5;
      sMid += mid * mid;
      sSide += side * side;
    }
    out[0] = Math.sqrt(2 * sMid / n);
    out[1] = 0;
    out[2] = Math.sqrt(2 * sSide / n);
    out[3] = 0;
    return out;
  }

  // src/spatial/ambienceMixer.ts
  var AMBIENCE_CHANNELS = AMBIENCE_SPEAKERS.length;
  var AMBIENCE_AZIMUTHS = AMBIENCE_SPEAKERS.map((s) => s.azimuthDeg);
  var AMBIENCE_DELAY_BASE_MS = 20;
  var AMBIENCE_DELAY_STEP_MS = 8;
  function ambienceDelaySamples(sampleRate2, k) {
    const ms = AMBIENCE_DELAY_BASE_MS + k % AMBIENCE_CHANNELS * AMBIENCE_DELAY_STEP_MS;
    return Math.round(ms / 1e3 * sampleRate2);
  }
  function foaAmbienceGains(l, r, frameCount, foa, out) {
    if (out.length < AMBIENCE_CHANNELS) throw new Error("foaAmbienceGains: output buffer is too small");
    stereoToFoa(l, r, frameCount, foa);
    decodeFoaToSpeakers(foa, AMBIENCE_AZIMUTHS, out);
    for (let k = 0; k < AMBIENCE_CHANNELS; k++) {
      out[k] = Math.max(-1, Math.min(1, out[k]));
    }
    return out;
  }
  var AmbienceRenderer = class {
    foa = new Float64Array(4);
    targets = new Float64Array(AMBIENCE_CHANNELS);
    current = new Float64Array(AMBIENCE_CHANNELS);
    delays;
    lines = [];
    positions = new Int32Array(AMBIENCE_CHANNELS);
    panL = new Float64Array(AMBIENCE_CHANNELS);
    panR = new Float64Array(AMBIENCE_CHANNELS);
    smoothCoef;
    constructor(sampleRate2) {
      this.delays = new Int32Array(AMBIENCE_CHANNELS);
      this.smoothCoef = Math.exp(-1 / (Math.max(1, sampleRate2) * 0.02));
      for (let k = 0; k < AMBIENCE_CHANNELS; k++) {
        const delay = Math.max(1, ambienceDelaySamples(sampleRate2, k));
        this.delays[k] = delay;
        this.lines.push(new Float32Array(delay));
        const pan = (Math.sin(AMBIENCE_AZIMUTHS[k] * Math.PI / 180) + 1) * 0.5;
        this.panL[k] = Math.sqrt(1 - pan);
        this.panR[k] = Math.sqrt(pan);
      }
    }
    prepare(_maxBlockSize) {
    }
    processAdd(inL, inR, outL, outR, frameCount, amount) {
      const mix = Math.min(1, Math.max(0, amount)) * 0.5;
      if (mix <= 0 || frameCount <= 0) return;
      foaAmbienceGains(inL, inR, frameCount, this.foa, this.targets);
      for (let i = 0; i < frameCount; i++) {
        let addL = 0;
        let addR = 0;
        for (let k = 0; k < AMBIENCE_CHANNELS; k++) {
          const line = this.lines[k];
          const pos = this.positions[k];
          const delayed = line[pos];
          line[pos] = k < 2 ? inR[i] : inL[i];
          this.positions[k] = pos + 1 >= this.delays[k] ? 0 : pos + 1;
          const gain = this.targets[k] + this.smoothCoef * (this.current[k] - this.targets[k]);
          this.current[k] = gain;
          addL += delayed * gain * this.panL[k];
          addR += delayed * gain * this.panR[k];
        }
        outL[i] += addL * mix;
        outR[i] += addR * mix;
      }
    }
    reset() {
      this.foa.fill(0);
      this.targets.fill(0);
      this.current.fill(0);
      this.positions.fill(0);
      for (let k = 0; k < this.lines.length; k++) this.lines[k].fill(0);
    }
  };

  // src/engine/HyperSoundEngine.ts
  var ANALYSIS_WINDOW = 2048;
  var MAX_PRE_EQ_BANDS = 20;
  var IEQ_BAND_COUNT = 10;
  var IEQ_FREQS = [31.5, 63, 125, 250, 500, 1e3, 2e3, 4e3, 8e3, 16e3];
  var DYNAMIC_EQ_CROSSOVERS = [200, 800, 2500, 8e3];
  var NORM_SMOOTH_SEC = 3;
  var MANUAL_GAIN_SMOOTH_SEC = 0.08;
  function cloneParams(p) {
    return {
      ...p,
      eq: {
        ...p.eq,
        simpleBands: p.eq.simpleBands.slice(),
        proBands: p.eq.proBands.map((b) => ({ frequency: b.frequency, gain: b.gain, q: b.q }))
      },
      deesser: { ...p.deesser },
      compressor: { ...p.compressor },
      nightMode: { ...p.nightMode },
      bassEnhancer: { ...p.bassEnhancer },
      reverb: {
        ...p.reverb,
        algorithmic: { ...p.reverb.algorithmic },
        convolution: { ...p.reverb.convolution }
      },
      surround3d: { ...p.surround3d },
      loudnessCompensation: {
        ...p.loudnessCompensation,
        bands: p.loudnessCompensation.bands.map((b) => ({ frequency: b.frequency, gain: b.gain }))
      },
      loudnessNormalization: { ...p.loudnessNormalization },
      limiter: { ...p.limiter },
      ieq: { ...p.ieq },
      pitch: { ...p.pitch },
      modulation: {
        ...p.modulation,
        lfo: { ...p.modulation.lfo },
        envelope: { ...p.modulation.envelope },
        routes: p.modulation.routes.map((r) => ({ ...r }))
      },
      modEffects: {
        delay: { ...p.modEffects.delay },
        chorus: { ...p.modEffects.chorus },
        flanger: { ...p.modEffects.flanger },
        phaser: { ...p.modEffects.phaser },
        tremolo: { ...p.modEffects.tremolo }
      },
      hearing: { ...p.hearing },
      spatial: p.spatial ? cloneSpatial(p.spatial) : void 0
    };
  }
  function cloneSpatial(s) {
    return {
      ...s,
      instant: { ...s.instant },
      headLocked: {
        ...s.headLocked,
        speakers: s.headLocked.speakers.map((sp) => ({ ...sp })),
        routes: s.headLocked.routes.slice()
      },
      world: {
        ...s.world,
        listener: { ...s.world.listener, position: { ...s.world.listener.position } },
        sources: s.world.sources.map((src) => ({ ...src, position: { ...src.position } })),
        trajectories: s.world.trajectories.map((t) => ({
          sourceId: t.sourceId,
          keyframes: t.keyframes.map((k) => ({ t: k.t, position: { ...k.position } }))
        }))
      },
      stage: {
        ...s.stage,
        customSources: s.stage.customSources.map((src) => ({ ...src, position: { ...src.position } }))
      },
      ambience: { ...s.ambience }
    };
  }
  function headLockedChannel(azimuthDeg) {
    return azimuthDeg <= 0 ? 0 : 1;
  }
  function routeSpeaker(cfg, route) {
    const base = {
      azimuthDeg: cfg.azimuthDeg,
      elevationDeg: cfg.elevationDeg,
      distance: cfg.distance,
      gain: cfg.gain,
      size: cfg.size
    };
    if (route === "both") {
      return [
        { ...base, channel: 0, gain: cfg.gain * 0.5 },
        { ...base, channel: 1, gain: cfg.gain * 0.5 }
      ];
    }
    const channel = route === "r" ? 1 : route === "l" ? 0 : headLockedChannel(cfg.azimuthDeg);
    return [{ ...base, channel }];
  }
  function trajectoryPosition(world, sourceId) {
    const traj = world.trajectories.find((t) => t.sourceId === sourceId);
    if (!traj) return null;
    return computeTrajectoryPosition(traj.keyframes, world.playhead);
  }
  function speakersFromSettings(s) {
    if (s.mode === "instant") {
      return instantSpeakers(s.instant);
    }
    if (s.mode === "headLocked") {
      const routes = s.headLocked.routes;
      return headLockedSpeakers(s.headLocked).flatMap(
        (cfg, i) => routeSpeaker(cfg.muted ? { ...cfg, gain: 0 } : cfg, i < routes.length ? routes[i] : void 0)
      );
    }
    if (s.mode === "stage") {
      const custom = s.stage.customSources.map((src) => {
        const rel = computeRelativeDirection(
          { position: { x: 0, y: 1.6, z: 0 }, yaw: 0 },
          src.position
        );
        return {
          channel: headLockedChannel(rel.azimuthDeg),
          azimuthDeg: rel.azimuthDeg,
          elevationDeg: rel.elevationDeg,
          distance: rel.distance,
          gain: src.gain,
          size: src.size
        };
      });
      return [
        ...stageSpeakers(s.stage).map((cfg) => ({
          channel: headLockedChannel(cfg.azimuthDeg),
          azimuthDeg: cfg.azimuthDeg,
          elevationDeg: cfg.elevationDeg,
          distance: cfg.distance,
          gain: cfg.gain,
          size: cfg.size
        })),
        ...custom
      ];
    }
    if (s.mode === "world") {
      return s.world.sources.map((src) => {
        const pos = trajectoryPosition(s.world, src.id) ?? src.position;
        const rel = computeRelativeDirection(s.world.listener, pos);
        return {
          channel: headLockedChannel(rel.azimuthDeg),
          azimuthDeg: rel.azimuthDeg,
          elevationDeg: rel.elevationDeg,
          distance: rel.distance,
          gain: src.gain,
          size: src.size
        };
      });
    }
    return [];
  }
  function spatialConfigFromSettings(s, dopplerVelocity, inputChannelCount = 2) {
    const stageActive = s.mode === "stage";
    const speakers = s.mode === "instant" && s.instant.multichannelAuto && inputChannelCount > 2 ? multichannelSpeakers(inputChannelCount) : speakersFromSettings(s);
    return {
      speakers,
      room: stageActive ? stageRoom(s.stage) : s.instant.room,
      roomAmount: stageActive ? s.stage.reverbAmount : s.instant.roomAmount,
      roomSizeScale: stageActive ? s.stage.roomSize : 1,
      amount: s.instant.amount,
      distanceModel: s.distanceModel ?? "inverse",
      refDistance: s.refDistance,
      maxDistance: s.maxDistance,
      hrtfInterp: s.hrtfInterp,
      convolution: s.convolution,
      masterGain: s.masterGain,
      occlusionAmount: s.mode === "world" ? s.world.occlusion : void 0,
      dopplerVelocity: s.mode === "world" ? dopplerVelocity : void 0,
      ambienceAmount: s.ambience.enabled ? s.ambience.amount : 0
    };
  }
  var HyperSoundEngine = class _HyperSoundEngine {
    _fs;
    _channels;
    _legacyPaddedTail;
    _params;
    // —— 链上 DSP 模块（构造时固定采样率，setParams 只重算系数） ——
    _eqChain;
    _midSide;
    _deesser;
    _compressor;
    _limiter;
    _bass;
    _convolver;
    // 非 readonly：dePeriodize 选项变化时重建（死参数修复）
    _convolverDePeriodize = true;
    _reverbSimple;
    _fdnReverb;
    _useFdn = false;
    _lufs;
    _loudnessComp;
    _stretch;
    _modMatrix;
    _modMasterGain = 1;
    _modStereoWidth = 1;
    _modulationResult = { masterGain: 1, stereoWidth: 1 };
    _delay;
    _chorus;
    _flanger;
    _phaser;
    _tremolo;
    // —— 多通道逐对处理子引擎池（processBus perChannelPair；懒创建，setParams/reset 同步） ——
    _pairEngines = [];
    // —— 夜间模式（压缩增强 + 6kHz 高频 shelf） ——
    _nightCompressor;
    _nightShelfL;
    _nightShelfR;
    _nightActive = false;
    // —— IEQ（Post）：内部实现，参考技术文档 §1.4 ——
    _ieqChain;
    _dynamicEq;
    _ieqActive = false;
    _ieqStrength = 0.5;
    _ieqSmooth = 0.01;
    _ieqGains = new Float32Array(IEQ_BAND_COUNT);
    _ieqLevels = new Float32Array(IEQ_BAND_COUNT);
    _ieqBands = [];
    _ieqZeroBands = [];
    _ieqTargets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    _ieqBinRanges = [];
    // —— 分析路径（2048 点 FFT，每累计一窗更新一次） ——
    _ring;
    _ringPos = 0;
    _analysisPos = 0;
    _analysisReady = false;
    _timeBuf;
    _real;
    _imag;
    _magBuf;
    _hann;
    _binFreqs;
    _featCache;
    // —— 工作缓冲（惰性扩容，稳态零分配） ——
    _workL = new Float32Array(0);
    _workR = new Float32Array(0);
    _sideL = new Float32Array(0);
    _sideR = new Float32Array(0);
    _sidechainActive = false;
    // —— 处理链（20 级，顺序即数组顺序） ——
    _stages = [];
    // —— 运行时状态 ——
    _preEqActive = false;
    _useConvolver = false;
    _loadedIr = null;
    _normGain = 1;
    _surroundPhase = 0;
    // —— 空间音频（内联级；TsConvolverBackend + 合成 HRTF 兜底网格） ——
    _spatialBackend;
    _ambienceRenderer;
    _spatialActive = false;
    _ambienceAmount = 0;
    _worldHistoryValid = false;
    _worldPrevPlayhead = 0;
    _worldPrevX = 0;
    _worldPrevY = 0;
    _worldPrevZ = 0;
    /** spatial 配置变更签名（JSON）——仅当 settings 实际变化时才 setConfig，避免非空间参数
     *  变更触发后端 resample/decorr 状态清零（fill(0)）造成咔哒声 */
    _spatialCfgKey = "";
    _spatialOutL = new Float32Array(0);
    _spatialOutR = new Float32Array(0);
    /** 多声道空间渲染使用的预分配输入引用视图；每块只更新元素。 */
    _spatialInputs;
    _preparedCapacity = 0;
    constructor(sampleRate2, channelCount = 2, options) {
      if (!Number.isFinite(sampleRate2) || sampleRate2 <= 0) {
        throw new Error("invalid sample rate");
      }
      this._fs = sampleRate2;
      this._channels = channelCount > 0 ? channelCount : 2;
      this._spatialInputs = new Array(this._channels);
      this._legacyPaddedTail = options?.legacyPaddedTail === true;
      this._eqChain = new EqChain(sampleRate2, MAX_PRE_EQ_BANDS);
      this._midSide = new MidSide();
      this._deesser = new Deesser(sampleRate2);
      this._compressor = new Compressor(sampleRate2);
      this._limiter = new Limiter(sampleRate2);
      this._bass = new BassEnhancer(sampleRate2);
      this._convolver = new Convolver(sampleRate2);
      this._reverbSimple = new ReverbSimple(sampleRate2);
      this._fdnReverb = new FdnReverb(sampleRate2);
      this._lufs = new LufsMeter(sampleRate2);
      this._loudnessComp = new LoudnessComp(sampleRate2);
      this._stretch = new HseStretch(sampleRate2, 2);
      this._modMatrix = new ModulationMatrix(sampleRate2);
      this._delay = new DelayEffect(sampleRate2);
      this._chorus = new ChorusEffect(sampleRate2);
      this._flanger = new FlangerEffect(sampleRate2);
      this._phaser = new PhaserEffect(sampleRate2);
      this._tremolo = new TremoloEffect(sampleRate2);
      this._nightCompressor = new Compressor(sampleRate2);
      this._nightShelfL = new Biquad("highshelf", 6e3, 0.707, 0, sampleRate2);
      this._nightShelfR = new Biquad("highshelf", 6e3, 0.707, 0, sampleRate2);
      this._ieqChain = new EqChain(sampleRate2, IEQ_BAND_COUNT);
      this._dynamicEq = new DynamicEq(sampleRate2);
      for (let i = 0; i < IEQ_BAND_COUNT; i++) {
        this._ieqBands.push({ frequency: IEQ_FREQS[i], gain: 0, q: 1.1 });
        this._ieqZeroBands.push({ frequency: IEQ_FREQS[i], gain: 0, q: 1.1 });
      }
      const binHz = sampleRate2 / ANALYSIS_WINDOW;
      for (let i = 0; i < IEQ_BAND_COUNT; i++) {
        const loEdge = i === 0 ? 20 : Math.sqrt(IEQ_FREQS[i - 1] * IEQ_FREQS[i]);
        const hiEdge = i === IEQ_BAND_COUNT - 1 ? sampleRate2 / 2 : Math.sqrt(IEQ_FREQS[i] * IEQ_FREQS[i + 1]);
        const lo = Math.max(0, Math.floor(loEdge / binHz));
        const hi = Math.min(ANALYSIS_WINDOW / 2, Math.ceil(hiEdge / binHz));
        this._ieqBinRanges.push([lo, hi]);
      }
      this._ring = new Float32Array(ANALYSIS_WINDOW);
      this._timeBuf = new Float32Array(ANALYSIS_WINDOW);
      this._real = new Float32Array(ANALYSIS_WINDOW);
      this._imag = new Float32Array(ANALYSIS_WINDOW);
      this._magBuf = new Float32Array(ANALYSIS_WINDOW / 2 + 1);
      this._hann = hannWindow(ANALYSIS_WINDOW);
      this._binFreqs = frequencyBins(ANALYSIS_WINDOW, sampleRate2);
      this._featCache = { rms: 0, zcr: 0, centroidHz: 0, rolloffHz: 0, flatness: 0, crest: 0 };
      this._spatialBackend = new TsConvolverBackend();
      this._spatialBackend.loadHrtf(generateAnalyticHrtfGrid(sampleRate2));
      this._ambienceRenderer = new AmbienceRenderer(sampleRate2);
      this._params = createDefaultParams(sampleRate2);
      this.buildStages();
      this.setParams(this._params);
    }
    /** 参数更新：重算所有模块系数（即时生效）。不修改传入的 p。 */
    setParams(p) {
      const prev = {
        eq: this._preEqActive,
        deesser: this._params.deesser.enabled,
        compressor: this._params.compressor.enabled,
        night: this._nightActive,
        delay: this._params.modEffects.delay.enabled,
        chorus: this._params.modEffects.chorus.enabled,
        flanger: this._params.modEffects.flanger.enabled,
        phaser: this._params.modEffects.phaser.enabled,
        tremolo: this._params.modEffects.tremolo.enabled,
        reverb: this._params.reverb.enabled && this._params.reverb.mode !== "off",
        bass: this._params.bassEnhancer.enabled,
        loudnessComp: this._params.loudnessCompensation.enabled,
        ieq: this._ieqActive,
        dynamicEq: this._params.dynamicEq.enabled,
        limiter: this._params.limiter.enabled
      };
      this._params = cloneParams(p);
      const p2 = this._params;
      const bands = this.buildPreEqBands(p2);
      this._eqChain.setBands(bands);
      this._eqChain.setQCompensation(p2.eq.qCompensation);
      this._preEqActive = p2.eq.enabled;
      this._deesser.setParams(p2.deesser);
      this._compressor.setParams(p2.compressor);
      const nm = p2.nightMode;
      this._nightActive = nm.enabled && nm.amount > 0;
      if (this._nightActive) {
        const k = nm.amount / 10;
        const base = p2.compressor;
        const night = {
          enabled: true,
          thresholdDb: base.thresholdDb - 6 * k,
          ratio: Math.max(1, base.ratio * (1 + 0.5 * k)),
          // 满强度时 ratio×1.5
          kneeDb: base.kneeDb,
          attackMs: base.attackMs,
          releaseMs: base.releaseMs,
          makeupDb: base.makeupDb,
          outputGain: 1,
          sidechainEnabled: base.sidechainEnabled
        };
        this._nightCompressor.setParams(night);
        const shelfGainDb = -1.5 * nm.amount;
        this._nightShelfL.setParams("highshelf", 6e3, 0.707, shelfGainDb);
        this._nightShelfR.setParams("highshelf", 6e3, 0.707, shelfGainDb);
      }
      this.configureReverb(p2.reverb);
      this._bass.setParams(p2.bassEnhancer);
      this._loudnessComp.setParams(p2.loudnessCompensation);
      this._limiter.setParams(p2.limiter);
      this._ieqActive = p2.ieq.enabled;
      this._ieqStrength = p2.ieq.strength;
      this._ieqTargets = this.ieqTargetCurve(p2.ieq.targetCurve);
      this._dynamicEq.setParams({
        enabled: p2.dynamicEq.enabled,
        strength: p2.dynamicEq.strength,
        thresholdDb: p2.dynamicEq.thresholdDb,
        ratio: p2.dynamicEq.ratio,
        attackMs: p2.dynamicEq.attackMs,
        releaseMs: p2.dynamicEq.releaseMs,
        bands: p2.dynamicEq.bands.map((b, i) => ({
          enabled: b.enabled,
          frequency: DYNAMIC_EQ_CROSSOVERS[i] ?? 0,
          targetGainDb: b.targetGainDb
        }))
      });
      const intervalSec = ANALYSIS_WINDOW / this._fs;
      this._ieqSmooth = 1 - Math.exp(-intervalSec / Math.max(0.1, p2.ieq.timeConstantSec));
      if (!this._ieqActive) {
        this._ieqGains.fill(0);
        this._ieqChain.setBands(this._ieqZeroBands);
      }
      const mod = p2.modulation;
      this._modMatrix.setRoutes(mod.routes);
      this._modMatrix.setLfoParams(mod.lfo.shape, mod.lfo.rateHz, mod.lfo.depth);
      this._modMatrix.setEnvelopeParams(mod.envelope.attackMs, mod.envelope.releaseMs, mod.envelope.amount);
      const me = p2.modEffects;
      this._delay.setParams(me.delay);
      this._chorus.setParams(me.chorus);
      this._flanger.setParams(me.flanger);
      this._phaser.setParams(me.phaser);
      this._tremolo.setParams(me.tremolo);
      if (!p2.loudnessNormalization.enabled) {
        this._normGain = 1;
      }
      for (const e of this._pairEngines) e.setParams(p2);
      if (!prev.eq && this._preEqActive) this._eqChain.reset();
      if (!prev.deesser && p2.deesser.enabled) this._deesser.reset();
      if (!prev.compressor && p2.compressor.enabled) this._compressor.reset();
      if (!prev.night && this._nightActive) {
        this._nightCompressor.reset();
        this._nightShelfL.reset();
        this._nightShelfR.reset();
      }
      if (!prev.delay && me.delay.enabled) this._delay.reset();
      if (!prev.chorus && me.chorus.enabled) this._chorus.reset();
      if (!prev.flanger && me.flanger.enabled) this._flanger.reset();
      if (!prev.phaser && me.phaser.enabled) this._phaser.reset();
      if (!prev.tremolo && me.tremolo.enabled) this._tremolo.reset();
      if (!prev.reverb && p2.reverb.enabled && p2.reverb.mode !== "off") {
        if (this._useConvolver) this._convolver.reset();
        else if (this._useFdn) this._fdnReverb.reset();
        else this._reverbSimple.reset();
      }
      if (!prev.bass && p2.bassEnhancer.enabled) this._bass.reset();
      if (!prev.loudnessComp && p2.loudnessCompensation.enabled) this._loudnessComp.reset();
      if (!prev.ieq && this._ieqActive) this._ieqChain.reset();
      if (!prev.dynamicEq && p2.dynamicEq.enabled) this._dynamicEq.reset();
      if (!prev.limiter && p2.limiter.enabled) this._limiter.reset();
      const sp = p2.spatial;
      const spatialActive = !!sp && sp.mode !== "off";
      const wasSpatialActive = this._spatialActive;
      this._spatialActive = spatialActive;
      let dopplerVelocity;
      if (sp?.mode === "world") {
        const listener = sp.world.listener.position;
        const playhead = sp.world.playhead;
        dopplerVelocity = computeWorldVelocity(
          this._worldHistoryValid ? {
            position: { x: this._worldPrevX, y: this._worldPrevY, z: this._worldPrevZ },
            playhead: this._worldPrevPlayhead
          } : null,
          { position: listener, playhead }
        );
        this._worldHistoryValid = true;
        this._worldPrevPlayhead = playhead;
        this._worldPrevX = listener.x;
        this._worldPrevY = listener.y;
        this._worldPrevZ = listener.z;
      } else {
        this._worldHistoryValid = false;
      }
      const wasAmbienceActive = this._ambienceAmount > 0;
      this._ambienceAmount = spatialActive && sp?.ambience.enabled ? Math.min(1, Math.max(0, sp.ambience.amount)) : 0;
      if (!wasAmbienceActive && this._ambienceAmount > 0) this._ambienceRenderer.reset();
      if (spatialActive && sp) {
        const key = JSON.stringify(sp);
        if (key !== this._spatialCfgKey) {
          if (!wasSpatialActive) {
            this._spatialBackend.reset();
            this._ambienceRenderer.reset();
          }
          this._spatialBackend.setConfig(spatialConfigFromSettings(sp, dopplerVelocity, this._channels));
          this._spatialCfgKey = key;
        }
      } else {
        this._spatialCfgKey = "";
        this._ambienceAmount = 0;
      }
    }
    /** 返回当前参数快照（深拷贝，外部修改不影响引擎内部状态）。 */
    getParams() {
      return cloneParams(this._params);
    }
    /** 预分配内部工作缓冲；实时处理前调用一次，之后 process 内零分配。 */
    prepare(maxBlockSize) {
      const size = Number.isFinite(maxBlockSize) ? Math.max(0, Math.floor(maxBlockSize)) : 0;
      if (size > 0) {
        this.ensureCapacity(size);
        this._preparedCapacity = Math.max(this._preparedCapacity, size);
        this.ensureSideCapacity(size);
        this._convolver.prepare(size);
        this._spatialBackend.prepare(size);
        this._ambienceRenderer.prepare(size);
      }
    }
    /** 就地处理：outputs[i] 写入处理结果（长度 = inputs[i] 长度）。process 内零分配。 */
    process(inputs, outputs, sidechain) {
      this.processInternal(inputs, outputs, sidechain, false);
    }
    /**
     * 3–8 路实时输入到双耳/立体声输出。数组和通道缓冲均由调用方预分配并复用。
     * spatial 开启时先由 SpatialBackend.processMulti 双耳化，再让所得 L/R 经过第 1–21 级；
     * spatial 关闭时保持 ch0→L、ch1→R，ch2+ 忽略的兼容语义并直接执行第 1–21 级。
     */
    processMulti(inputs, outputs, sidechain) {
      if (inputs.length < 3 || inputs.length > 8) {
        throw new RangeError("processMulti requires 3 to 8 input channels");
      }
      if (inputs.length !== this._channels) {
        throw new RangeError(`processMulti requires configured input channel count ${this._channels}, got ${inputs.length}`);
      }
      if (outputs.length < 2) {
        throw new RangeError("processMulti requires two output channels");
      }
      this.processInternal(inputs, outputs, sidechain, true);
    }
    processInternal(inputs, outputs, sidechain, multi) {
      let n = Infinity;
      for (const ch of inputs) {
        if (ch) n = Math.min(n, ch.length);
      }
      if (n === Infinity || n <= 0) return;
      this.ensureCapacity(n);
      const L = this._workL;
      const R = this._workR;
      const inL = inputs[0];
      const inR = this._channels > 1 && inputs.length > 1 ? inputs[1] : void 0;
      if (multi && this._spatialActive) {
        for (let channel = 0; channel < inputs.length; channel++) this._spatialInputs[channel] = inputs[channel];
        this._spatialBackend.processMulti(this._spatialInputs, L, R, n);
        if (this._ambienceAmount > 0) {
          this._ambienceRenderer.processAdd(inputs[0], inputs[1], L, R, n, this._ambienceAmount);
        }
      } else {
        for (let i = 0; i < n; i++) L[i] = inL ? inL[i] : 0;
        for (let i = 0; i < n; i++) R[i] = inR ? inR[i] : 0;
      }
      if (sidechain && sidechain.length > 0 && (sidechain[0]?.length ?? 0) > 0) {
        this.ensureSideCapacity(n);
        const sL = sidechain[0];
        const sR = sidechain.length > 1 ? sidechain[1] : sL;
        for (let i = 0; i < n; i++) {
          this._sideL[i] = sL && i < sL.length ? sL[i] : 0;
          this._sideR[i] = sR && i < sR.length ? sR[i] : 0;
        }
        this._sidechainActive = true;
      } else {
        this._sidechainActive = false;
      }
      if (this._params.modulation.enabled) {
        this._modMatrix.processBlockInto(L, R, n, this._modulationResult);
        this._modMasterGain = this._modulationResult.masterGain;
        this._modStereoWidth = this._modulationResult.stereoWidth;
      } else {
        this._modMasterGain = 1;
        this._modStereoWidth = 1;
      }
      if (multi) this.processCore21(L, R, n);
      else this.processAllStages(L, R, n);
      const outL = outputs[0];
      if (outL) for (let i = 0; i < n; i++) outL[i] = L[i];
      if (outputs.length > 1 && outputs[1]) {
        const outR = outputs[1];
        for (let i = 0; i < n; i++) outR[i] = R[i];
      }
    }
    /**
     * 多通道 HseAudioBus 处理入口。
     *
     * 引擎 DSP 核心为立体声，支持两种多通道路由（`options.mode`）：
     * - `'downmix'`（默认）：输入 >2 声道下混为立体声处理；输出写入时不足 2 声道写第一声道、
     *   超过 2 声道把处理后的立体声复制到其余声道。适合环绕声监听（各声道听感一致）。
     * - `'perChannelPair'`：真正的 N 通道处理——按立体声对 (0,1)、(2,3)… 分组，
     *   每对由独立引擎实例（子引擎池，参数/复位与主引擎同步）分别处理，互不串扰；
     *   奇数剩余通道复制成立体声处理并取 L 写回。适合 5.1/7.1 各通道独立处理。
     *   sidechain 同样按对切片；不足 2 声道时取第 0 声道广播到各对。
     *
     * 注意：本方法为便利入口，会分配临时缓冲；实时立体声使用 `process()`，
     * 实时 3–8 路输入使用 `processMulti()`。
     */
    processBus(input, output, sidechain, options) {
      if (options?.mode === "perChannelPair" && input.channelCount > 2) {
        this.processBusPerChannelPair(input, output, sidechain);
        return;
      }
      const n = Math.min(input.frameCount, output.frameCount);
      const { l, r } = input.downmixToStereo();
      const outL = new Float32Array(n);
      const outR = new Float32Array(n);
      let sideL;
      let sideR;
      if (sidechain) {
        const s = sidechain.downmixToStereo();
        sideL = s.l;
        sideR = s.r;
      }
      this.process([l, r], [outL, outR], sideL && sideR ? [sideL, sideR] : void 0);
      output.writeStereo(outL, outR);
    }
    /** 按立体声对逐对处理（perChannelPair）。每对独立子引擎，输出就地写入 output 对应通道。 */
    processBusPerChannelPair(input, output, sidechain) {
      const n = Math.min(input.frameCount, output.frameCount);
      const cc = input.channelCount;
      const pairCount = Math.floor(cc / 2);
      for (let p = 0; p < pairCount; p++) {
        const e = this.ensurePairEngine(p);
        const inL = input.getChannel(p * 2).subarray(0, n);
        const inR = input.getChannel(p * 2 + 1).subarray(0, n);
        const outL = output.getChannel(p * 2).subarray(0, n);
        const outR = output.getChannel(p * 2 + 1).subarray(0, n);
        let side;
        if (sidechain) {
          const sc = sidechain.channelCount;
          if (sc >= 2) {
            side = [sidechain.getChannel(Math.min(p * 2, sc - 1)).subarray(0, n), sidechain.getChannel(Math.min(p * 2 + 1, sc - 1)).subarray(0, n)];
          } else {
            const mono = sidechain.getChannel(0).subarray(0, n);
            side = [mono, mono];
          }
        }
        e.process([inL, inR], [outL, outR], side);
      }
      if (cc % 2 === 1) {
        const p = pairCount;
        const e = this.ensurePairEngine(p);
        const mono = input.getChannel(cc - 1).subarray(0, n);
        const out = output.getChannel(cc - 1).subarray(0, n);
        const tmpL = new Float32Array(n);
        const tmpR = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          tmpL[i] = mono[i];
          tmpR[i] = mono[i];
        }
        let side;
        if (sidechain) {
          const mono2 = sidechain.getChannel(0).subarray(0, n);
          side = [mono2, mono2];
        }
        e.process([tmpL, tmpR], [tmpL, tmpR], side);
        for (let i = 0; i < n; i++) out[i] = tmpL[i];
      }
    }
    /** 获取（或懒创建）第 index 个立体声子引擎；参数与主引擎当前快照一致。 */
    ensurePairEngine(index) {
      let e = this._pairEngines[index];
      if (!e) {
        e = new _HyperSoundEngine(this._fs, 2);
        e.setParams(this._params);
        this._pairEngines[index] = e;
      }
      return e;
    }
    getStats() {
      return {
        lufsIntegrated: this._lufs.getIntegratedLufs(),
        lufsMomentary: this._lufs.getMomentaryLufs(),
        lra: this._lufs.getLra(),
        peakDb: this._lufs.getPeakDb(),
        truePeakDb: this._lufs.getTruePeakDb(),
        limiterReductionDb: this._limiter.getReductionDb(),
        engineLatencySamples: this.getLatencySamples()
      };
    }
    /** 最近一帧频谱 + 特征（内部 2048 点 FFT + Hann 窗）。未测到返回 null。 */
    getAnalysis() {
      if (!this._analysisReady) return { spectrum: null, features: null };
      const spectrum = new Float32Array(this._magBuf);
      const features = { ...this._featCache };
      return { spectrum, features };
    }
    /** 引擎引入的延迟（样本数）= 限幅器前瞻 + 混响延迟 + 空间音频分区延迟。 */
    getLatencySamples() {
      let lat = 0;
      const p = this._params;
      if (p.limiter.enabled) lat += this._limiter.getLatencySamples();
      if (p.reverb.enabled) {
        if (this._useConvolver) lat += this._convolver.getLatencySamples();
        else if (p.reverb.mode === "algorithmic") {
          lat += Math.round(p.reverb.algorithmic.preDelayMs / 1e3 * this._fs);
        }
      }
      if (this._spatialActive) lat += this._spatialBackend.getLatencySamples();
      return lat;
    }
    /** 变速/变调处理器（不内联进主链，供 gapless/过渡场景调用）。 */
    getStretch() {
      return this._stretch;
    }
    /**
     * 注册自定义处理阶段（模块化效果器扩展点）。
     * - `index` 缺省时插到 `limiter` 之前（即参与主链但位于最终保护之前）；
     * - 若 `id` 已存在则原位替换；
     * - 自定义阶段可提供可选 `reset()`，引擎 `reset()` 时会调用。
     */
    registerStage(stage, index) {
      if (!stage || typeof stage.id !== "string" || stage.id.length === 0) {
        throw new Error("registerStage: stage.id must be a non-empty string");
      }
      const existing = this._stages.findIndex((s) => s.id === stage.id);
      if (existing >= 0) {
        this._stages[existing] = stage;
        return;
      }
      let insertAt;
      if (index === void 0) {
        const limiterIdx = this._stages.findIndex((s) => s.id === "limiter");
        insertAt = limiterIdx >= 0 ? limiterIdx : this._stages.length;
      } else {
        insertAt = Math.max(0, Math.min(this._stages.length, Math.floor(index)));
      }
      this._stages.splice(insertAt, 0, stage);
    }
    /** 按 id 移除自定义处理阶段；返回是否移除成功。 */
    unregisterStage(id) {
      const idx = this._stages.findIndex((s) => s.id === id);
      if (idx < 0) return false;
      this._stages.splice(idx, 1);
      return true;
    }
    /** 当前处理阶段列表（返回副本，外部修改不影响引擎内部链）。 */
    getStages() {
      return this._stages.slice();
    }
    /** 复位所有模块与内部状态。 */
    reset() {
      this._eqChain.reset();
      this._midSide.reset();
      this._deesser.reset();
      this._compressor.reset();
      this._limiter.reset();
      this._bass.reset();
      this._convolver.reset();
      this._reverbSimple.reset();
      this._fdnReverb.reset();
      this._lufs.reset();
      this._loudnessComp.reset();
      this._nightCompressor.reset();
      this._nightShelfL.reset();
      this._nightShelfR.reset();
      this._ieqChain.reset();
      this._dynamicEq.reset();
      this._stretch.reset();
      this._delay.reset();
      this._chorus.reset();
      this._flanger.reset();
      this._phaser.reset();
      this._tremolo.reset();
      this._spatialBackend.reset();
      this._ambienceRenderer.reset();
      this._worldHistoryValid = false;
      this._normGain = 1;
      this._surroundPhase = 0;
      this._sidechainActive = false;
      this._modMatrix.reset();
      this._modMasterGain = 1;
      this._modStereoWidth = 1;
      this._ringPos = 0;
      this._analysisPos = 0;
      this._analysisReady = false;
      this._ring.fill(0);
      this._magBuf.fill(0);
      this._ieqGains.fill(0);
      const f = this._featCache;
      f.rms = 0;
      f.zcr = 0;
      f.centroidHz = 0;
      f.rolloffHz = 0;
      f.flatness = 0;
      f.crest = 0;
      for (const stage of this._stages) stage.reset?.();
      for (const e of this._pairEngines) e.reset();
    }
    // ==================== 内部实现 ====================
    processCore21(L, R, frameCount) {
      for (const stage of this._stages) {
        if (stage.id === "spatial") continue;
        if (stage.active()) stage.run(L, R, frameCount);
      }
    }
    processAllStages(L, R, frameCount) {
      for (const stage of this._stages) {
        if (stage.active()) stage.run(L, R, frameCount);
      }
    }
    /**
     * 构建处理链（22 级，含调制类效果、调制主增益与空间音频）。
     * 顺序固定，与 API_SPEC 辅助模块 A 一致；数组顺序即处理顺序。
     */
    buildStages() {
      this._stages.length = 0;
      this._stages.push(
        {
          id: "loudness-normalization",
          active: () => this._params.loudnessNormalization.enabled,
          run: (L, R, n) => {
            const ln = this._params.loudnessNormalization;
            if (ln.useRealtimeMeter) {
              const integrated = this._lufs.getIntegratedLufs();
              const measured = Number.isFinite(integrated) ? integrated : this._lufs.getMomentaryLufs();
              const gainDb = Number.isFinite(measured) ? Math.min(ln.maxGainDb, Math.max(ln.minGainDb, ln.targetLufs - measured)) : 0;
              const targetLin = Math.pow(10, gainDb / 20);
              const alpha = 1 - Math.exp(-(n / this._fs) / NORM_SMOOTH_SEC);
              this._normGain += alpha * (targetLin - this._normGain);
            } else {
              const targetLin = Math.pow(10, Math.min(ln.maxGainDb, Math.max(ln.minGainDb, ln.externalGainDb)) / 20);
              const alpha = 1 - Math.exp(-(n / this._fs) / MANUAL_GAIN_SMOOTH_SEC);
              this._normGain += alpha * (targetLin - this._normGain);
            }
            const g = this._normGain;
            for (let i = 0; i < n; i++) {
              L[i] *= g;
              R[i] *= g;
            }
          }
        },
        {
          id: "surround3d",
          active: () => this._params.surround3d.enabled,
          run: (L, R, n) => {
            const s3 = this._params.surround3d;
            const dt = n / this._fs;
            this._surroundPhase += 2 * Math.PI * s3.speed * dt * 0.125;
            const theta = s3.angle * Math.PI / 180 + s3.direction * this._surroundPhase;
            const c = Math.cos(theta);
            const s = Math.sin(theta);
            const scale = 0.5 + 0.5 * s3.distance;
            for (let i = 0; i < n; i++) {
              const l = L[i];
              const r = R[i];
              L[i] = (l * c - r * s) * scale;
              R[i] = (l * s + r * c) * scale;
            }
          }
        },
        {
          id: "mid-side",
          active: () => true,
          run: (L, R, n) => {
            const vb = this._params.pitch.enabled ? this._params.pitch.voiceBalance : 0;
            const width = this._params.modulation.enabled ? this._modStereoWidth : this._params.stereoWidth;
            this._midSide.setParams(width, vb);
            this._midSide.processStereo(L, R, this.dspFrameCount(n));
          }
        },
        {
          id: "pre-eq",
          active: () => this._preEqActive,
          run: (L, R, n) => this._eqChain.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "deesser",
          active: () => this._params.deesser.enabled,
          run: (L, R, n) => {
            if (this._sidechainActive && this._params.deesser.sidechainEnabled) {
              this._deesser.processStereo(L, R, this._sideL, this._sideR, this.dspFrameCount(n));
            } else {
              this._deesser.processStereo(L, R, void 0, void 0, this.dspFrameCount(n));
            }
          }
        },
        {
          id: "compressor",
          active: () => this._params.compressor.enabled,
          run: (L, R, n) => {
            if (this._sidechainActive && this._params.compressor.sidechainEnabled) {
              this._compressor.processStereo(L, R, this._sideL, this._sideR, this.dspFrameCount(n));
            } else {
              this._compressor.processStereo(L, R, void 0, void 0, this.dspFrameCount(n));
            }
          }
        },
        {
          id: "night-mode",
          active: () => this._nightActive,
          run: (L, R, n) => {
            const dspN = this.dspFrameCount(n);
            this._nightCompressor.processStereo(L, R, void 0, void 0, dspN);
            this._nightShelfL.processBlock(L, L, dspN);
            this._nightShelfR.processBlock(R, R, dspN);
          }
        },
        {
          id: "delay",
          active: () => this._params.modEffects.delay.enabled,
          run: (L, R, n) => this._delay.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "chorus",
          active: () => this._params.modEffects.chorus.enabled,
          run: (L, R, n) => this._chorus.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "flanger",
          active: () => this._params.modEffects.flanger.enabled,
          run: (L, R, n) => this._flanger.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "phaser",
          active: () => this._params.modEffects.phaser.enabled,
          run: (L, R, n) => this._phaser.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "tremolo",
          active: () => this._params.modEffects.tremolo.enabled,
          run: (L, R, n) => this._tremolo.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "reverb",
          active: () => this._params.reverb.enabled && this._params.reverb.mode !== "off",
          run: (L, R, n) => {
            const dspN = this.dspFrameCount(n);
            if (this._useConvolver) this._convolver.processStereo(L, R, dspN);
            else if (this._useFdn) this._fdnReverb.processStereo(L, R, dspN);
            else this._reverbSimple.processStereo(L, R, dspN);
          }
        },
        {
          id: "bass-enhancer",
          active: () => this._params.bassEnhancer.enabled,
          run: (L, R, n) => this._bass.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "loudness-compensation",
          active: () => this._params.loudnessCompensation.enabled,
          run: (L, R, n) => this._loudnessComp.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "ieq-post",
          active: () => this._ieqActive,
          run: (L, R, n) => this._ieqChain.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "analysis",
          active: () => true,
          run: (L, R, n) => {
            this.feedAnalysis(L, R, n);
          }
        },
        {
          id: "dynamic-eq",
          active: () => this._params.dynamicEq.enabled,
          run: (L, R, n) => this._dynamicEq.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "lufs",
          active: () => true,
          run: (L, R, n) => {
            this._lufs.processStereo(L, R, this.dspFrameCount(n));
          }
        },
        {
          id: "mod-master-gain",
          active: () => this._params.modulation.enabled,
          run: (L, R, n) => {
            const g = this._modMasterGain;
            for (let i = 0; i < n; i++) {
              L[i] *= g;
              R[i] *= g;
            }
          }
        },
        {
          id: "limiter",
          active: () => this._params.limiter.enabled,
          run: (L, R, n) => this._limiter.processStereo(L, R, this.dspFrameCount(n))
        },
        {
          id: "spatial",
          active: () => this._spatialActive,
          run: (L, R, n) => {
            if (this._spatialOutL.length < n) {
              this._spatialOutL = new Float32Array(n);
              this._spatialOutR = new Float32Array(n);
            }
            const oL = this._spatialOutL;
            const oR = this._spatialOutR;
            this._spatialBackend.processStereo(L, R, oL, oR, n);
            if (this._ambienceAmount > 0) {
              this._ambienceRenderer.processAdd(L, R, oL, oR, n, this._ambienceAmount);
            }
            for (let i = 0; i < n; i++) {
              L[i] = oL[i];
              R[i] = oR[i];
            }
          }
        }
      );
    }
    dspFrameCount(frameCount) {
      return this._legacyPaddedTail ? this._workL.length : frameCount;
    }
    ensureCapacity(n) {
      if (this._workL.length < n) {
        if (this._preparedCapacity > 0) {
          throw new RangeError(`HyperSoundEngine block ${n} exceeds prepared capacity ${this._preparedCapacity}`);
        }
        this._workL = new Float32Array(n);
        this._workR = new Float32Array(n);
        this._spatialBackend.prepare(n);
      }
      if (this._spatialOutL.length < n) {
        this._spatialOutL = new Float32Array(n);
        this._spatialOutR = new Float32Array(n);
      }
    }
    ensureSideCapacity(n) {
      if (this._sideL.length < n) {
        this._sideL = new Float32Array(n);
        this._sideR = new Float32Array(n);
      }
    }
    /** 收集用户 EQ（simple/pro）bands，上限 20 段。 */
    buildPreEqBands(p) {
      const out = [];
      if (!p.eq.enabled) return out;
      if (p.eq.mode === "simple") {
        for (let i = 0; i < SIMPLE_EQ_FREQUENCIES.length; i++) {
          out.push({ frequency: SIMPLE_EQ_FREQUENCIES[i], gain: p.eq.simpleBands[i] ?? 0, q: 1.1 });
        }
      } else {
        const count = Math.min(p.eq.bandCount, p.eq.proBands.length);
        for (let i = 0; i < count; i++) {
          const b = p.eq.proBands[i];
          out.push({ frequency: b.frequency, gain: b.gain, q: b.q });
        }
      }
      return out.slice(0, MAX_PRE_EQ_BANDS);
    }
    /**
     * 混响路由配置：convolution 且 IR 有效 → 卷积；fdn → FDN 网络混响；
     * 否则算法混响（Freeverb，含卷积自动回退）。
     */
    configureReverb(rv) {
      this._reverbSimple.setParams({ ...rv.algorithmic });
      this._fdnReverb.setParams({ ...rv.algorithmic, type: rv.algorithmic.type });
      this._useConvolver = false;
      this._useFdn = false;
      const wantDeP = rv.convolution.dePeriodize;
      if (wantDeP !== this._convolverDePeriodize) {
        this._convolver = new Convolver(this._fs, { dePeriodize: wantDeP });
        if (this._preparedCapacity > 0) this._convolver.prepare(this._preparedCapacity);
        this._convolverDePeriodize = wantDeP;
        this._loadedIr = null;
      }
      if (rv.enabled && rv.mode === "fdn") {
        this._useFdn = true;
        return;
      }
      if (rv.enabled && rv.mode === "convolution") {
        const ir = rv.convolution.ir;
        if (ir && ir.length > 0) {
          try {
            if (ir !== this._loadedIr) {
              this._convolver.loadIR(new Float32Array(ir), rv.convolution.irName ?? void 0);
              if (this._preparedCapacity > 0) this._convolver.prepare(this._preparedCapacity);
              this._loadedIr = ir;
            }
            this._convolver.setMix(rv.convolution.mix);
            this._convolver.setPreDelayMs(rv.convolution.preDelayMs);
            this._useConvolver = true;
          } catch {
            this._useConvolver = false;
          }
        }
      }
    }
    /** 把单声道下混写入环形分析缓冲；累计满一窗后执行 FFT + 特征 + IEQ 更新。 */
    feedAnalysis(l, r, n) {
      const W = ANALYSIS_WINDOW;
      for (let i = 0; i < n; i++) {
        this._ring[this._ringPos] = 0.5 * (l[i] + r[i]);
        this._ringPos = (this._ringPos + 1) % W;
      }
      this._analysisPos += n;
      while (this._analysisPos >= W) {
        this._analysisPos -= W;
        this.runAnalysis();
      }
    }
    /** 对最近一窗做 2048 点 FFT（Hann 窗），计算幅度谱与特征，并更新 IEQ。 */
    runAnalysis() {
      const W = ANALYSIS_WINDOW;
      for (let i = 0; i < W; i++) {
        const src = this._ring[(this._ringPos + i) % W];
        this._timeBuf[i] = src;
        this._real[i] = src * this._hann[i];
        this._imag[i] = 0;
      }
      fft(this._real, this._imag, false);
      const half = W / 2;
      const mag = this._magBuf;
      for (let k = 0; k <= half; k++) {
        const re = this._real[k];
        const im = this._imag[k];
        mag[k] = Math.sqrt(re * re + im * im);
      }
      const f = this._featCache;
      f.rms = computeRms(this._timeBuf);
      f.zcr = computeZcr(this._timeBuf);
      f.centroidHz = spectralCentroid(mag, this._binFreqs);
      f.rolloffHz = spectralRolloff(mag, this._binFreqs);
      f.flatness = spectralFlatness(mag);
      f.crest = spectralCrest(mag);
      this._analysisReady = true;
      if (this._ieqActive) this.updateIeq(mag);
    }
    /** IEQ：长时频谱与目标曲线之差 → 平滑增益 → 写入内部参数 EQ。 */
    updateIeq(mag) {
      const levels = this._ieqLevels;
      let overall = 0;
      for (let i = 0; i < IEQ_BAND_COUNT; i++) {
        const [lo, hi] = this._ieqBinRanges[i];
        let sumSq = 0;
        for (let k = lo; k <= hi; k++) sumSq += mag[k] * mag[k];
        const rms = Math.sqrt(sumSq / (hi - lo + 1));
        levels[i] = 20 * Math.log10(Math.max(rms, 1e-4));
        overall += levels[i];
      }
      overall /= IEQ_BAND_COUNT;
      const alpha = this._ieqSmooth;
      const strength = this._ieqStrength;
      for (let i = 0; i < IEQ_BAND_COUNT; i++) {
        const relative = levels[i] - overall;
        const desired = strength * (this._ieqTargets[i] - relative);
        let g = this._ieqGains[i] + alpha * (desired - this._ieqGains[i]);
        if (g > 12) g = 12;
        else if (g < -12) g = -12;
        this._ieqGains[i] = g;
        this._ieqBands[i].gain = g;
      }
      this._ieqChain.setBands(this._ieqBands);
    }
    /** IEQ 目标曲线（dB，按 1 倍频程 10 段）。 */
    ieqTargetCurve(curve) {
      switch (curve) {
        case "flat":
          return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        case "warm":
          return [4, 3.5, 2.5, 1.5, 0.5, 0, -0.5, -1.5, -2.5, -3.5];
        case "bright":
          return [-3.5, -2.5, -1.5, -0.5, 0, 0.5, 1.5, 2.5, 3.5, 4];
        case "vocal":
          return [-1.5, -1, 0, 1, 2, 2.5, 2, 1, 0, -0.5];
      }
    }
  };

  // src/worklet/HseAudioEffectsProcessor.ts
  var WORKLET_PROCESSOR_NAME = "hypersoundengine";
  var STATS_INTERVAL_CALLBACKS = 30;
  var HseAudioEffectsProcessor = class extends AudioWorkletProcessor {
    engine;
    inputChannelCount;
    inputRefs;
    outputRefs;
    callbackCount = 0;
    scratch;
    silence;
    constructor(options) {
      super(options);
      const processorOptions = options?.processorOptions;
      const requested = processorOptions?.inputChannelCount;
      this.inputChannelCount = requested === 6 || requested === 8 ? requested : 2;
      this.inputRefs = new Array(this.inputChannelCount);
      this.outputRefs = new Array(2);
      this.silence = new Float32Array(128);
      this.scratch = new Float32Array(128);
      this.engine = new HyperSoundEngine(sampleRate, this.inputChannelCount);
      this.engine.prepare(128);
      try {
        if (processorOptions?.initialParams) this.engine.setParams(processorOptions.initialParams);
      } catch (error) {
        this.port.postMessage({
          type: "error",
          phase: "construct",
          requestId: processorOptions?.requestId,
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      this.port.onmessage = (event) => {
        const msg = event.data;
        if (msg !== null && typeof msg === "object" && msg.type === "reset") {
          this.engine.reset();
        }
      };
      if (processorOptions?.requestId) {
        this.port.postMessage({ type: "ready", requestId: processorOptions.requestId });
      }
    }
    process(inputs, outputs, _parameters) {
      const outChannels = outputs.length > 0 ? outputs[0] : [];
      if (outChannels.length === 0) return true;
      const frameCount = outChannels[0].length;
      if (frameCount > this.silence.length) {
        for (let channel = 0; channel < outChannels.length; channel++) outChannels[channel].fill(0);
        return true;
      }
      const inChannels = inputs.length > 0 ? inputs[0] : [];
      this.outputRefs[0] = outChannels[0];
      this.outputRefs[1] = outChannels.length >= 2 ? outChannels[1] : this.scratch;
      if (this.inputChannelCount > 2) {
        for (let channel = 0; channel < this.inputChannelCount; channel++) {
          this.inputRefs[channel] = inChannels[channel] ?? this.silence;
        }
        this.engine.processMulti(this.inputRefs, this.outputRefs);
      } else {
        const left = inChannels[0] ?? this.silence;
        this.inputRefs[0] = left;
        this.inputRefs[1] = inChannels[1] ?? left;
        this.engine.process(this.inputRefs, this.outputRefs);
      }
      if (outChannels.length < 2) {
        for (let i = 0; i < frameCount; i++) {
          outChannels[0][i] = (outChannels[0][i] + this.scratch[i]) * 0.5;
        }
      }
      this.callbackCount++;
      if (this.callbackCount >= STATS_INTERVAL_CALLBACKS) {
        this.callbackCount = 0;
        this.port.postMessage({ type: "stats", stats: this.engine.getStats(), analysis: this.engine.getAnalysis() });
      }
      return true;
    }
  };
  typeof registerProcessor !== "undefined" && registerProcessor(WORKLET_PROCESSOR_NAME, HseAudioEffectsProcessor);
})();
