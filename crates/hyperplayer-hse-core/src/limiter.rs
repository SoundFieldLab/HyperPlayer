//! limiter —— 前瞻限幅器 + 真峰值阶段（Phase 1 试点模块）。
//!
//! 行为事实标准：仓库根 `src/dsp/Limiter.ts»；规格：「specs/dsp/limiter.md」。
//! 本文件是该 TS 类的逐行移植，关键对应关系：
//!
//! - 时序模型：流式逐样本，输出 `y[idx] = x[idx−L]·g[idx]»；g 由检测窗峰值经
//!   attack/release 一阶平滑得到。真峰值模式下检测值定位在 `idx−3»（居中 sinc
//!   插值所需），有效检测窗为 `[idx−L−3, idx−3]»（数字峰值模式为 `[idx−L, idx]»）。
//! - 数值精度铁律：TS 中以 Number(f64) 参与运算的中间量（阈值线性值、插值系数
//!   计算、检测峰值 det、增益包络、平滑系数）一律用 f64 复刻；f32 落点只有三处，
//!   且与 TS 完全一致——写回输出样本、队列峰值存储（TS `qVal» 为 Float32Array）、
//!   插值系数表与真峰值历史环（Float32Array）。
//! - Math.round 复刻为 `floor(x + 0.5)»（JS 对 .5 向 +∞ 舍入，非远离零）。
//! - 相位 2（frac=1/2）利用 sinc 偶函数对称 + Blackman 窗对称，tap 对 (t2,t7)、
//!   (t3,t6)、(t4,t5) 系数相同，按 TS 合并乘加——纯优化，加法链顺序与 TS 一致。
//! - 与 TS 的唯一有意偏差：apply_params 重分配延迟线时 TS 不重置 delayW，
//!   新尺寸小于旧写游标时 TS 会越界静默丢写/读到 undefined；此处仅在该越界场景
//!   把写游标归零。由于重分配同时清零整条延迟线且每槽随写随读，环形起始相位在
//!   数值上不可观测，其余场景与 TS 逐位一致。
//! - 实时安全：延迟线 / 检测队列 / 插值历史全部在构造与 configure 中预分配，
//!   process 内零分配、零 panic。

use std::f64::consts::PI;
use std::fmt;

use crate::Stage;

/// 对齐 TS `LimiterSettings» 的参数快照。
#[derive(Debug, Clone)]
pub struct LimiterSettings {
    pub enabled: bool,
    pub threshold_db: f64,
    pub lookahead_ms: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub true_peak: bool,
}

/// limiter 连续处理状态快照（延迟线、单调递减检测队列、真峰值历史、
/// 增益包络与读数、前瞻尾部排空进度）。字段保持私有，不包含任何参数、
/// 平滑系数或插值系数表——这些由参数快照（[`LimiterSettings`]）决定。
///
/// 与 [`CompressorRuntimeState`](crate::compressor::CompressorRuntimeState)
/// 的四件套范式一致：[`LimiterStage::snapshot_runtime_state`] /
/// [`LimiterStage::save_runtime_state`] / [`LimiterStage::restore_runtime_state`] /
/// [`LimiterStage::copy_runtime_state_from`]，采样率或前瞻长度不一致时
/// 以 [`LimiterRuntimeStateMismatch`] 原子拒绝（不产生部分迁移）。
#[derive(Clone)]
pub struct LimiterRuntimeState {
    sample_rate_bits: u64,
    lookahead: usize,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    delay_w: usize,
    q_idx: Vec<i64>,
    q_val: Vec<f32>,
    q_head: usize,
    q_tail: usize,
    q_len: usize,
    hist_l: [f32; 8],
    hist_r: [f32; 8],
    hist_w: usize,
    gain: f64,
    reduction_db: f64,
    last_peak: f64,
    sample_index: i64,
    tail_buffered: usize,
    tail_cursor: usize,
}

/// 运行时状态的采样率或前瞻长度与目标限幅器不一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimiterRuntimeStateMismatch;

impl fmt::Display for LimiterRuntimeStateMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("limiter runtime state sample rate or lookahead mismatch")
    }
}

impl std::error::Error for LimiterRuntimeStateMismatch {}

/// 一个已配置的前瞻限幅器阶段。
///
/// 字段一一对应 TS `Limiter» 的私有域；命名沿用蛇形转换。
pub struct LimiterStage {
    sample_rate: f64,
    // —— 生效参数（apply_params 钳制后的取值）——
    enabled: bool,
    threshold_lin: f64,
    lookahead: usize,
    attack_coef: f64,
    release_coef: f64,
    true_peak: bool,
    // —— 延迟线（尺寸 lookahead+1，读取最旧样本 = 延迟 L）——
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    delay_w: usize,
    // —— 单调递减队列（环形），滑动窗峰值检测 ——
    q_idx: Vec<i64>,
    q_val: Vec<f32>,
    q_head: usize,
    q_tail: usize,
    q_len: usize,
    q_cap: usize,
    // —— 真峰值：每通道 8 样本历史（环形）+ 3 相位 × 8 taps 插值系数 ——
    hist_l: [f32; 8],
    hist_r: [f32; 8],
    hist_w: usize,
    interp: [f32; 24],
    // —— 包络与统计 ——
    gain: f64,
    reduction_db: f64,
    // —— HyperPlayer 扩展读数：最近一个被处理样本的检测峰值（线性域）——
    last_peak: f64,
    sample_index: i64,
    // —— HyperPlayer 扩展：延迟线中尚待 drain 送出的帧数与其读出游标 ——
    tail_buffered: usize,
    tail_cursor: usize,
}

/// TS `clamp(v, lo, hi)» 的逐字复刻。
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// TS `onePoleCoef(timeMs, fs)» 的逐字复刻：
/// coef = 1 − exp(−1 / ((max(ms, 0.05)/1000) × fs))，ms 下限 0.05 生效。
fn one_pole_coef(time_ms: f64, fs: f64) -> f64 {
    let ms = time_ms.max(0.05);
    1.0 - (-1.0 / ((ms / 1000.0) * fs)).exp()
}

/// 把 `src` 逐元素写入 `dst`；容量充足时零分配（供 checkpoint 复用路径使用）。
fn assign_vec<T: Clone>(dst: &mut Vec<T>, src: &[T]) {
    dst.clear();
    dst.extend_from_slice(src);
}

/// 取真峰值历史环中自 oldest 槽位起的连续 8 个样本（对齐 TS 把 i0..i7 一次性
/// 取入局部变量的展开），返回 f64 供插值运算（TS 中历史样本即 Number 参与运算）。
#[inline]
fn hist_window(hist: &[f32; 8], oldest: usize) -> [f64; 8] {
    [
        f64::from(hist[oldest]),
        f64::from(hist[(oldest + 1) & 7]),
        f64::from(hist[(oldest + 2) & 7]),
        f64::from(hist[(oldest + 3) & 7]),
        f64::from(hist[(oldest + 4) & 7]),
        f64::from(hist[(oldest + 5) & 7]),
        f64::from(hist[(oldest + 6) & 7]),
        f64::from(hist[(oldest + 7) & 7]),
    ]
}

impl LimiterStage {
    /// 按 TS 构造函数默认参数创建（thresholdDb=-1 / lookaheadMs=5 / attackMs=0.5 /
    /// releaseMs=150 / truePeak=true / enabled=true），随后可用 configure 覆盖。
    pub fn new(sample_rate: f64) -> Result<Self, String> {
        Self::from_settings(
            sample_rate,
            LimiterSettings {
                enabled: true,
                threshold_db: -1.0,
                lookahead_ms: 5.0,
                attack_ms: 0.5,
                release_ms: 150.0,
                true_peak: true,
            },
        )
    }

    /// 以显式参数快照构造（对齐 TS `setParams» 整体替换语义；钳制规则见规格参数表）。
    ///
    /// sampleRate ≤ 0 或非有限时报错（GWT-LM-11，对齐 TS Error('invalid sample rate')）。
    pub fn from_settings(sample_rate: f64, settings: LimiterSettings) -> Result<Self, String> {
        if !(sample_rate.is_finite() && sample_rate > 0.0) {
            return Err("sampleRate 必须为正有限数".into());
        }
        let mut stage = Self {
            sample_rate,
            // TS 字段初始化器的默认域（构造体内随即被 applyParams 覆写）。
            enabled: true,
            threshold_lin: 10_f64.powf(-1.0 / 20.0),
            lookahead: 0,
            attack_coef: 0.0,
            release_coef: 0.0,
            true_peak: false,
            delay_l: vec![0.0; 1],
            delay_r: vec![0.0; 1],
            delay_w: 0,
            q_idx: vec![0; 8],
            q_val: vec![0.0; 8],
            q_head: 0,
            q_tail: 0,
            q_len: 0,
            q_cap: 8,
            hist_l: [0.0; 8],
            hist_r: [0.0; 8],
            hist_w: 0,
            interp: [0.0; 24],
            gain: 1.0,
            reduction_db: 0.0,
            last_peak: 0.0,
            sample_index: 0,
            tail_buffered: 0,
            tail_cursor: 0,
        };
        stage.apply_params(&settings);
        Ok(stage)
    }

    /// 覆盖参数快照（对齐 TS setParams；缓冲尺寸变化或禁用切回启用时清空管线）。
    pub fn configure(&mut self, settings: LimiterSettings) {
        self.apply_params(&settings);
    }

    /// 当前增益衰减 dB（恒 ≤ 0，对齐 TS getReductionDb）。
    pub fn reduction_db(&self) -> f64 {
        self.reduction_db
    }

    /// 引入的延迟样本数 = lookahead（对齐 TS getLatencySamples，两种模式下均成立）。
    pub fn latency_samples(&self) -> usize {
        self.lookahead
    }

    /// 静态尾部容量：启用时等于 lookahead（尚未送出的最后一段输入），
    /// 禁用时为 0（禁用即直通，延迟线不被填充）。drain 排空进度不计入。
    pub fn tail_samples(&self) -> usize {
        if self.enabled {
            self.lookahead
        } else {
            0
        }
    }

    /// 当前仍待 [`LimiterStage::drain`] 排空的前瞻尾部帧数。延迟线中真实缓冲、
    /// 尚未送出的样本数（随 process 增长、随 drain 递减；禁用、复位后为 0）。
    pub fn pending_tail_frames(&self) -> usize {
        if self.enabled {
            self.tail_buffered
        } else {
            0
        }
    }

    /// 最近一个被处理样本的检测峰值（线性域，HyperPlayer 扩展读数）。
    ///
    /// 真峰值模式下为 4× 过采样 sinc 插值峰值（可超出 1.0，覆盖 intersample
    /// peak），数字峰值模式为样本绝对值峰值；禁用、复位或刚构造时为 0。
    pub fn last_detected_peak(&self) -> f64 {
        self.last_peak
    }

    /// 返回仅含连续处理状态的完整快照（延迟线/队列/真峰值历史/包络/读数/
    /// 排空进度；不含参数与系数）。会克隆内部缓冲，仅供非实时检查点路径调用。
    pub fn snapshot_runtime_state(&self) -> LimiterRuntimeState {
        LimiterRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            lookahead: self.lookahead,
            delay_l: self.delay_l.clone(),
            delay_r: self.delay_r.clone(),
            delay_w: self.delay_w,
            q_idx: self.q_idx.clone(),
            q_val: self.q_val.clone(),
            q_head: self.q_head,
            q_tail: self.q_tail,
            q_len: self.q_len,
            hist_l: self.hist_l,
            hist_r: self.hist_r,
            hist_w: self.hist_w,
            gain: self.gain,
            reduction_db: self.reduction_db,
            last_peak: self.last_peak,
            sample_index: self.sample_index,
            tail_buffered: self.tail_buffered,
            tail_cursor: self.tail_cursor,
        }
    }

    /// 将当前状态写入已有快照；采样率或前瞻长度不符时不修改快照。
    ///
    /// 复用容量充足的既有快照时零分配（Vec 复用 length/capacity）。
    pub fn save_runtime_state(
        &self,
        state: &mut LimiterRuntimeState,
    ) -> Result<(), LimiterRuntimeStateMismatch> {
        if !self.runtime_state_compatible(state.sample_rate_bits, state.lookahead) {
            return Err(LimiterRuntimeStateMismatch);
        }
        assign_vec(&mut state.delay_l, &self.delay_l);
        assign_vec(&mut state.delay_r, &self.delay_r);
        state.delay_w = self.delay_w;
        assign_vec(&mut state.q_idx, &self.q_idx);
        assign_vec(&mut state.q_val, &self.q_val);
        state.q_head = self.q_head;
        state.q_tail = self.q_tail;
        state.q_len = self.q_len;
        state.hist_l = self.hist_l;
        state.hist_r = self.hist_r;
        state.hist_w = self.hist_w;
        state.gain = self.gain;
        state.reduction_db = self.reduction_db;
        state.last_peak = self.last_peak;
        state.sample_index = self.sample_index;
        state.tail_buffered = self.tail_buffered;
        state.tail_cursor = self.tail_cursor;
        Ok(())
    }

    /// 恢复连续处理状态，保留目标参数、平滑/插值系数与工作缓冲尺寸。
    pub fn restore_runtime_state(
        &mut self,
        state: &LimiterRuntimeState,
    ) -> Result<(), LimiterRuntimeStateMismatch> {
        if !self.runtime_state_compatible(state.sample_rate_bits, state.lookahead)
            || state.delay_l.len() != self.delay_l.len()
            || state.delay_r.len() != self.delay_r.len()
            || state.q_idx.len() != self.q_idx.len()
            || state.q_val.len() != self.q_val.len()
        {
            return Err(LimiterRuntimeStateMismatch);
        }
        self.delay_l.copy_from_slice(&state.delay_l);
        self.delay_r.copy_from_slice(&state.delay_r);
        self.delay_w = state.delay_w;
        self.q_idx.copy_from_slice(&state.q_idx);
        self.q_val.copy_from_slice(&state.q_val);
        self.q_head = state.q_head;
        self.q_tail = state.q_tail;
        self.q_len = state.q_len;
        self.hist_l = state.hist_l;
        self.hist_r = state.hist_r;
        self.hist_w = state.hist_w;
        self.gain = state.gain;
        self.reduction_db = state.reduction_db;
        self.last_peak = state.last_peak;
        self.sample_index = state.sample_index;
        self.tail_buffered = state.tail_buffered;
        self.tail_cursor = state.tail_cursor;
        Ok(())
    }

    /// 从另一实例复制连续处理状态，保留目标参数与工作缓冲。
    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), LimiterRuntimeStateMismatch> {
        if !self.runtime_state_compatible(source.sample_rate.to_bits(), source.lookahead) {
            return Err(LimiterRuntimeStateMismatch);
        }
        self.delay_l.copy_from_slice(&source.delay_l);
        self.delay_r.copy_from_slice(&source.delay_r);
        self.delay_w = source.delay_w;
        self.q_idx.copy_from_slice(&source.q_idx);
        self.q_val.copy_from_slice(&source.q_val);
        self.q_head = source.q_head;
        self.q_tail = source.q_tail;
        self.q_len = source.q_len;
        self.hist_l = source.hist_l;
        self.hist_r = source.hist_r;
        self.hist_w = source.hist_w;
        self.gain = source.gain;
        self.reduction_db = source.reduction_db;
        self.last_peak = source.last_peak;
        self.sample_index = source.sample_index;
        self.tail_buffered = source.tail_buffered;
        self.tail_cursor = source.tail_cursor;
        Ok(())
    }

    /// 采样率位型与前瞻长度均一致时，运行时状态才可迁移。
    fn runtime_state_compatible(&self, sample_rate_bits: u64, lookahead: usize) -> bool {
        self.sample_rate.to_bits() == sample_rate_bits && self.lookahead == lookahead
    }

    /// 排空前瞻延迟线（HyperPlayer 扩展，TS 无对应物；停流/换链时调用）。
    ///
    /// 将尚未送出的最后至多 `lookahead` 个输入样本以**当前冻结增益**写出到
    /// `left`/`right`（至多写 `min(left.len(), right.len())` 帧），返回实际写出
    /// 的帧数；被读出的槽位即时清零。全部排空后，检测队列与真峰值历史一并
    /// 清空，音频状态回到等效 reset 的取值（参数与衰减报告保留）。禁用阶段
    /// 没有待排空内容，恒返回 0。检测包络在排空期间不更新（没有新输入参与
    /// 检测），因此排空输出 = 延迟样本 × 冻结增益，零分配、零 panic。
    pub fn drain(&mut self, left: &mut [f32], right: &mut [f32]) -> usize {
        if !self.enabled || self.tail_buffered == 0 {
            return 0;
        }
        let n = self.tail_buffered.min(left.len()).min(right.len());
        let dsize = self.delay_l.len();
        let gain = self.gain;
        // tail_cursor 由 process 在块尾定位到最旧待排空样本的槽位
        //（process 的「写后读」模型下 delay_w 槽位的样本已随最后一个输入送出）。
        let mut cursor = self.tail_cursor;
        for slot in left[..n].iter_mut().zip(right[..n].iter_mut()) {
            let (out_l, out_r) = slot;
            *out_l = (f64::from(self.delay_l[cursor]) * gain) as f32;
            *out_r = (f64::from(self.delay_r[cursor]) * gain) as f32;
            self.delay_l[cursor] = 0.0;
            self.delay_r[cursor] = 0.0;
            cursor += 1;
            if cursor >= dsize {
                cursor = 0;
            }
        }
        self.tail_cursor = cursor;
        self.tail_buffered -= n;
        if self.tail_buffered == 0 {
            // 全部排空：延迟线（含 process 写后读模型下仅存已送出样本的
            // delay_w 槽位）与检测队列、真峰值历史一并清空。
            self.delay_l.fill(0.0);
            self.delay_r.fill(0.0);
            self.q_head = 0;
            self.q_tail = 0;
            self.q_len = 0;
            self.hist_l.fill(0.0);
            self.hist_r.fill(0.0);
            self.hist_w = 0;
        }
        n
    }

    /// TS applyParams 的逐行移植：钳制 + 系数重算 + 条件性管线清理 + 插值系数刷新。
    fn apply_params(&mut self, p: &LimiterSettings) {
        let was_enabled = self.enabled;
        self.enabled = p.enabled;
        self.threshold_lin = 10_f64.powf(clamp(p.threshold_db, -60.0, 0.0) / 20.0);
        // TS Math.round((lookaheadMs * fs) / 1000)：乘除次序保持，再钳到 [0, floor(fs*0.1)]。
        let rounded = (((p.lookahead_ms * self.sample_rate) / 1000.0) + 0.5).floor();
        let upper = (self.sample_rate * 0.1).floor();
        self.lookahead = clamp(rounded, 0.0, upper.max(0.0)) as usize;
        self.attack_coef = one_pole_coef(p.attack_ms, self.sample_rate);
        self.release_coef = one_pole_coef(p.release_ms, self.sample_rate);
        self.true_peak = p.true_peak;

        let size = (self.lookahead + 1).max(1);
        let cap = (self.lookahead + 8).max(8);
        if size != self.delay_l.len() || cap != self.q_cap {
            self.delay_l = vec![0.0; size];
            self.delay_r = vec![0.0; size];
            self.q_idx = vec![0; cap];
            self.q_val = vec![0.0; cap];
            self.q_cap = cap;
            self.q_head = 0;
            self.q_tail = 0;
            self.q_len = 0;
            self.hist_l = [0.0; 8];
            self.hist_r = [0.0; 8];
            self.hist_w = 0;
            self.gain = 1.0;
            self.sample_index = 0;
            self.reduction_db = 0.0;
            self.last_peak = 0.0;
            self.tail_buffered = 0;
            self.tail_cursor = 0;
            // 见模块注释「唯一有意偏差」：TS 不重置 delayW，这里仅防越界归零。
            if self.delay_w >= size {
                self.delay_w = 0;
            }
        }
        if self.enabled && !was_enabled {
            // 禁用期间延迟线未更新，恢复时清空避免陈旧样本（GWT-LM-01/§4.4）。
            self.delay_l.fill(0.0);
            self.delay_r.fill(0.0);
            self.q_head = 0;
            self.q_tail = 0;
            self.q_len = 0;
            self.hist_l.fill(0.0);
            self.hist_r.fill(0.0);
            self.hist_w = 0;
            self.gain = 1.0;
            self.sample_index = 0;
            self.reduction_db = 0.0;
            self.last_peak = 0.0;
            self.tail_buffered = 0;
            self.tail_cursor = 0;
        }
        // 4× 过采样 sinc 插值系数（Blackman 窗，3 相位 × 8 taps，窗支撑 [-5, 5]）；
        // 仅 truePeak 时计算，系数按 Float32Array 语义落点 f32。
        if self.true_peak {
            for ph in 0..3_usize {
                let frac = (ph as f64 + 1.0) / 4.0;
                for k in -4_i64..=3 {
                    let x = frac - k as f64;
                    let sx = if x == 0.0 {
                        1.0
                    } else {
                        (PI * x).sin() / (PI * x)
                    };
                    let u = (x + 5.0) / 10.0;
                    let w = 0.42 - 0.5 * (2.0 * PI * u).cos() + 0.08 * (4.0 * PI * u).cos();
                    self.interp[ph * 8 + (k + 4) as usize] = (sx * w) as f32;
                }
            }
        }
    }

    /// 单调递减队列的弹出过期队首 + 弹出 ≤det 队尾 + 入队（两种检测模式共用骨架）。
    ///
    /// key/oldest 用 i64 复刻 TS 的 Int32Array 索引比较（允许启动期为负）；
    /// det 入队时落点 f32（TS qVal 为 Float32Array），比较时升回 f64。
    #[inline]
    fn queue_push(
        &mut self,
        key: i64,
        oldest: i64,
        det: f64,
        q_head: &mut usize,
        q_tail: &mut usize,
        q_len: &mut usize,
    ) {
        while *q_len > 0 && self.q_idx[*q_head] < oldest {
            *q_head = (*q_head + 1) % self.q_cap;
            *q_len -= 1;
        }
        while *q_len > 0 {
            let t = (*q_tail + self.q_cap - 1) % self.q_cap;
            if f64::from(self.q_val[t]) > det {
                break;
            }
            *q_tail = t;
            *q_len -= 1;
        }
        self.q_idx[*q_tail] = key;
        self.q_val[*q_tail] = det as f32;
        *q_tail = (*q_tail + 1) % self.q_cap;
        *q_len += 1;
    }
}

impl Stage for LimiterStage {
    fn prepare(&mut self, _max_block_size: usize) {
        // 全部工作缓冲与块长无关（延迟线/队列/历史尺寸只由参数决定），
        // 已在 from_settings/configure 预分配，这里无事可做。
    }

    /// 就地处理一个立体声块；状态跨块保持，运算序列与分块方式无关（GWT-LM-07）。
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.enabled {
            // GWT-LM-01：禁用即直通——不改写缓冲（逐位一致），衰减报告归零。
            self.reduction_db = 0.0;
            self.last_peak = 0.0;
            return;
        }
        let n = left.len();
        let thr = self.threshold_lin;
        let dsize = self.delay_l.len();
        let lookahead = self.lookahead as i64;
        let tp = self.true_peak;
        let attack = self.attack_coef;
        let release = self.release_coef;

        // 热路径游标/包络取局部变量，块尾写回（对齐 TS processStereo 的缓存模式）。
        let mut q_head = self.q_head;
        let mut q_tail = self.q_tail;
        let mut q_len = self.q_len;
        let mut delay_w = self.delay_w;
        let mut gain = self.gain;
        let mut last_det = self.last_peak;

        for i in 0..n {
            let xl = left[i];
            let xr = right[i];
            let idx = self.sample_index;

            // 1) 4× 过采样历史写入（位置 idx−7..idx）
            self.hist_l[self.hist_w] = xl;
            self.hist_r[self.hist_w] = xr;
            self.hist_w = (self.hist_w + 1) & 7;

            // 2) 检测值：数字峰值 或 真峰值（4× sinc 插值，位置 p = idx−3）
            let abs_xl = xl.abs();
            let abs_xr = xr.abs();
            let mut det = if abs_xl > abs_xr {
                f64::from(abs_xl)
            } else {
                f64::from(abs_xr)
            };

            if tp {
                if idx >= 7 {
                    let w = self.hist_w; // 自增后 = 最旧样本 x[idx−7] 的槽位
                    let hl = hist_window(&self.hist_l, w);
                    let hr = hist_window(&self.hist_r, w);
                    let mut vl = 0.0_f64;
                    let mut vr = 0.0_f64;
                    // 相位 1（frac=1/4）：8 taps 顺序展开（左折叠加法链与 TS 一致）
                    {
                        let s_l = f64::from(self.interp[0]) * hl[0]
                            + f64::from(self.interp[1]) * hl[1]
                            + f64::from(self.interp[2]) * hl[2]
                            + f64::from(self.interp[3]) * hl[3]
                            + f64::from(self.interp[4]) * hl[4]
                            + f64::from(self.interp[5]) * hl[5]
                            + f64::from(self.interp[6]) * hl[6]
                            + f64::from(self.interp[7]) * hl[7];
                        let s_r = f64::from(self.interp[0]) * hr[0]
                            + f64::from(self.interp[1]) * hr[1]
                            + f64::from(self.interp[2]) * hr[2]
                            + f64::from(self.interp[3]) * hr[3]
                            + f64::from(self.interp[4]) * hr[4]
                            + f64::from(self.interp[5]) * hr[5]
                            + f64::from(self.interp[6]) * hr[6]
                            + f64::from(self.interp[7]) * hr[7];
                        let a_l = s_l.abs();
                        let a_r = s_r.abs();
                        if a_l > vl {
                            vl = a_l;
                        }
                        if a_r > vr {
                            vr = a_r;
                        }
                    }
                    // 相位 2（frac=1/2）：sinc 偶对称 → tap 对合并（hL2+hL7 / hL3+hL6 / hL4+hL5）
                    {
                        let s_l = f64::from(self.interp[8]) * hl[0]
                            + f64::from(self.interp[9]) * hl[1]
                            + f64::from(self.interp[10]) * (hl[2] + hl[7])
                            + f64::from(self.interp[11]) * (hl[3] + hl[6])
                            + f64::from(self.interp[12]) * (hl[4] + hl[5]);
                        let s_r = f64::from(self.interp[8]) * hr[0]
                            + f64::from(self.interp[9]) * hr[1]
                            + f64::from(self.interp[10]) * (hr[2] + hr[7])
                            + f64::from(self.interp[11]) * (hr[3] + hr[6])
                            + f64::from(self.interp[12]) * (hr[4] + hr[5]);
                        let a_l = s_l.abs();
                        let a_r = s_r.abs();
                        if a_l > vl {
                            vl = a_l;
                        }
                        if a_r > vr {
                            vr = a_r;
                        }
                    }
                    // 相位 3（frac=3/4）：8 taps 顺序展开
                    {
                        let s_l = f64::from(self.interp[16]) * hl[0]
                            + f64::from(self.interp[17]) * hl[1]
                            + f64::from(self.interp[18]) * hl[2]
                            + f64::from(self.interp[19]) * hl[3]
                            + f64::from(self.interp[20]) * hl[4]
                            + f64::from(self.interp[21]) * hl[5]
                            + f64::from(self.interp[22]) * hl[6]
                            + f64::from(self.interp[23]) * hl[7];
                        let s_r = f64::from(self.interp[16]) * hr[0]
                            + f64::from(self.interp[17]) * hr[1]
                            + f64::from(self.interp[18]) * hr[2]
                            + f64::from(self.interp[19]) * hr[3]
                            + f64::from(self.interp[20]) * hr[4]
                            + f64::from(self.interp[21]) * hr[5]
                            + f64::from(self.interp[22]) * hr[6]
                            + f64::from(self.interp[23]) * hr[7];
                        let a_l = s_l.abs();
                        let a_r = s_r.abs();
                        if a_l > vl {
                            vl = a_l;
                        }
                        if a_r > vr {
                            vr = a_r;
                        }
                    }
                    if vl > det {
                        det = vl;
                    }
                    if vr > det {
                        det = vr;
                    }
                }
                // 弹出窗口外（索引 < oldest）的队首过期项；单调递减入队（相等值保留最新）。
                let oldest = idx - 3 - lookahead;
                self.queue_push(idx - 3, oldest, det, &mut q_head, &mut q_tail, &mut q_len);
            } else {
                let oldest = idx - lookahead;
                self.queue_push(idx, oldest, det, &mut q_head, &mut q_tail, &mut q_len);
            }
            // HyperPlayer 扩展读数：记录本样本检测峰值（块尾写回，热路径无 self 访问）。
            last_det = det;

            // 3) 延迟线写入（写后游标自增，环回用比较代替取模）
            self.delay_l[delay_w] = xl;
            self.delay_r[delay_w] = xr;
            delay_w += 1;
            if delay_w >= dsize {
                delay_w = 0;
            }

            // 4) 目标增益 = min(1, 阈值/峰值)，attack/release 一阶平滑
            //    （peak 从 Float32Array 读回升 f64；Math.max(peak, 1e-12) 防 0 除）
            let peak = if q_len > 0 {
                f64::from(self.q_val[q_head])
            } else {
                0.0
            };
            let target = (thr / peak.max(1e-12)).min(1.0);
            if target < gain {
                gain += attack * (target - gain);
            } else {
                gain += release * (target - gain);
            }

            // 5) 输出 = 延迟 L 样本 × 平滑增益（f64 运算，样本落点 f32）
            left[i] = (f64::from(self.delay_l[delay_w]) * gain) as f32;
            right[i] = (f64::from(self.delay_r[delay_w]) * gain) as f32;
            self.sample_index = idx + 1;
        }

        self.delay_w = delay_w;
        // HyperPlayer 扩展：尾部缓冲计账与排空游标定位（块尾一次完成）。
        self.tail_buffered = (self.tail_buffered + n).min(self.lookahead);
        if self.tail_buffered > 0 {
            self.tail_cursor = (self.delay_w + dsize - self.tail_buffered) % dsize;
        }
        self.q_head = q_head;
        self.q_tail = q_tail;
        self.q_len = q_len;
        self.gain = gain;
        self.last_peak = last_det;
        // TS 在 processStereo 尾部统一刷新衰减报告（含空块调用）。
        self.reduction_db = 20.0 * gain.log10();
    }

    /// 清空全部管线状态回刚构造取值（对齐 TS reset；含 HyperPlayer 扩展读数
    /// 与排空进度）。
    fn reset(&mut self) {
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.delay_w = 0;
        self.q_head = 0;
        self.q_tail = 0;
        self.q_len = 0;
        self.hist_l.fill(0.0);
        self.hist_r.fill(0.0);
        self.hist_w = 0;
        self.gain = 1.0;
        self.reduction_db = 0.0;
        self.last_peak = 0.0;
        self.sample_index = 0;
        self.tail_buffered = 0;
        self.tail_cursor = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 确定性伪随机源（LCG；测试专用，不进实时路径）。
    struct Lcg(u64);

    impl Lcg {
        fn next_f32(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) as f32 / (1_u32 << 31) as f32) * 2.0 - 1.0
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn settings(
        enabled: bool,
        threshold_db: f64,
        lookahead_ms: f64,
        attack_ms: f64,
        release_ms: f64,
        true_peak: bool,
    ) -> LimiterSettings {
        LimiterSettings {
            enabled,
            threshold_db,
            lookahead_ms,
            attack_ms,
            release_ms,
            true_peak,
        }
    }

    fn noise_stereo(seed: u64, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Lcg(seed);
        let l = (0..frames).map(|_| rng.next_f32()).collect::<Vec<f32>>();
        let r = (0..frames).map(|_| rng.next_f32()).collect::<Vec<f32>>();
        (l, r)
    }

    // ---- GWT-LM-11：非法采样率抛错 ----

    #[test]
    fn 非法采样率一律报错() {
        for fs in [0.0, -48_000.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(LimiterStage::new(fs).is_err(), "fs={fs} 必须报错");
        }
    }

    // ---- 构造默认值与 TS 一致 ----

    #[test]
    fn 构造默认值与ts构造函数一致() {
        let st = LimiterStage::new(48_000.0).unwrap();
        assert_eq!(st.latency_samples(), 240); // round(5*48000/1000)
        assert!(st.enabled);
        assert!(st.true_peak);
        assert_eq!(st.reduction_db(), 0.0);
        assert!((st.threshold_lin - 10_f64.powf(-1.0 / 20.0)).abs() < 1e-15);
        // attack 0.5ms@48k：1-exp(-1/24)；release 150ms@48k：1-exp(-1/7200)
        let expect_attack = 1.0 - (-1.0_f64 / ((0.5 / 1000.0) * 48_000.0)).exp();
        let expect_release = 1.0 - (-1.0_f64 / ((150.0 / 1000.0) * 48_000.0)).exp();
        assert!((st.attack_coef - expect_attack).abs() < 1e-15);
        assert!((st.release_coef - expect_release).abs() < 1e-15);
        // 延迟线尺寸 = lookahead+1，队列容量 = lookahead+8
        assert_eq!(st.delay_l.len(), 241);
        assert_eq!(st.delay_r.len(), 241);
        assert_eq!(st.q_cap, 248);
        // 默认参数下插值系数表已填充
        assert_ne!(st.interp[0], 0.0);
        assert_ne!(st.interp[23], 0.0);
    }

    // ---- lookahead 取整与上限钳制 ----

    #[test]
    fn lookahead取整与上限钳制() {
        // round 半值向上语义：220.5 → 221
        let st = LimiterStage::new(44_100.0).unwrap();
        assert_eq!(st.lookahead, 221);
        let cases: [(f64, f64, usize); 6] = [
            (48_000.0, 5.0, 240),     // 典型值
            (48_000.0, 0.4, 19),      // round(19.2)=19
            (48_000.0, 200.0, 4_800), // 9600 → 钳到 floor(48000*0.1)=4800
            (48_000.0, -5.0, 0),      // 负值钳 0
            (48_000.0, 0.0, 0),       // 无前瞻
            // 0.0625*8000/1000 = 0.5（二的幂精确表示）→ 半值向上 → 1
            (8_000.0, 0.0625, 1),
        ];
        for (fs, ms, want) in cases {
            let st = LimiterStage::from_settings(fs, settings(true, -1.0, ms, 0.5, 150.0, false))
                .unwrap();
            assert_eq!(st.lookahead, want, "fs={fs} lookaheadMs={ms}");
            assert_eq!(st.delay_l.len(), want + 1);
            assert_eq!(st.q_idx.len(), want + 8);
        }
        // 上限钳制的另一档：150ms@8000 = 1200 → 钳到 floor(800)
        let st =
            LimiterStage::from_settings(8_000.0, settings(true, -1.0, 150.0, 0.5, 150.0, false))
                .unwrap();
        assert_eq!(st.lookahead, 800);
        assert_eq!(st.latency_samples(), 800);
    }

    // ---- onePole 系数边界 ----

    #[test]
    fn one_pole系数ms下限生效() {
        let fs = 48_000.0;
        let floor = one_pole_coef(0.05, fs);
        assert_eq!(one_pole_coef(0.0, fs), floor, "ms≤0.05 按 0.05 生效");
        assert_eq!(one_pole_coef(-10.0, fs), floor);
        // (0.05/1000)*48000 = 2.4 → 1-exp(-1/2.4)
        assert!((floor - (1.0 - (-1.0_f64 / 2.4).exp())).abs() < 1e-15);
        // 正常值不受下限影响
        let normal = one_pole_coef(50.0, fs);
        let expected = 1.0 - (-1.0_f64 / ((50.0 / 1000.0) * fs)).exp();
        assert!((normal - expected).abs() < 1e-15);
    }

    // ---- GWT-LM-02：静音输入静音输出 ----

    #[test]
    fn 静音输入恒静音且增益保持一() {
        for tp in [true, false] {
            let mut st =
                LimiterStage::from_settings(48_000.0, settings(true, -6.0, 10.0, 0.5, 150.0, tp))
                    .unwrap();
            for _ in 0..8 {
                let mut l = vec![0.0_f32; 512];
                let mut r = vec![0.0_f32; 512];
                st.process(&mut l, &mut r);
                assert!(
                    l.iter().all(|&s| s.to_bits() == 0),
                    "tp={tp} 左声道必须全零位型"
                );
                assert!(
                    r.iter().all(|&s| s.to_bits() == 0),
                    "tp={tp} 右声道必须全零位型"
                );
            }
            assert_eq!(st.reduction_db(), 0.0);
            assert_eq!(st.gain, 1.0);
        }
    }

    // ---- GWT-LM-01：禁用即逐位直通 ----

    #[test]
    fn 禁用时输出与输入逐位一致() {
        let mut st =
            LimiterStage::from_settings(48_000.0, settings(false, -12.0, 5.0, 0.5, 150.0, true))
                .unwrap();
        let (mut l, mut r) = noise_stereo(42, 777); // 故意非整块长
        let before_l = l.clone();
        let before_r = r.clone();
        st.process(&mut l, &mut r);
        assert_eq!(l, before_l);
        assert_eq!(r, before_r);
        assert_eq!(st.reduction_db(), 0.0);
    }

    // ---- GWT-LM-07：跨块状态连续性（逐位一致）----

    #[test]
    fn 分块处理与整块处理逐位一致() {
        for params in [
            settings(true, -1.0, 5.0, 0.5, 150.0, true), // case1 同款
            settings(true, -12.0, 0.0, 1.0, 50.0, false), // case2 同款（无前瞻）
        ] {
            let frames = 1000;
            let (src_l, src_r) = noise_stereo(7, frames);
            let mut whole_l = src_l.clone();
            let mut whole_r = src_r.clone();
            let mut whole = LimiterStage::from_settings(48_000.0, params.clone()).unwrap();
            whole.process(&mut whole_l, &mut whole_r);

            let mut chunk_l = src_l.clone();
            let mut chunk_r = src_r.clone();
            let mut chunked = LimiterStage::from_settings(48_000.0, params.clone()).unwrap();
            let mut off = 0;
            while off < frames {
                let end = (off + 333).min(frames); // 333 不整除 1000，末块短
                chunked.process(&mut chunk_l[off..end], &mut chunk_r[off..end]);
                off = end;
            }
            assert_eq!(chunk_l, whole_l, "params={params:?} 分块必须逐位一致");
            assert_eq!(chunk_r, whole_r);
        }
    }

    // ---- GWT-LM-09：reset 后行为可复现 ----

    #[test]
    fn reset后重放同一输入输出一致() {
        let (src_l, src_r) = noise_stereo(99, 600);
        let mut st =
            LimiterStage::from_settings(48_000.0, settings(true, -3.0, 2.5, 0.5, 80.0, true))
                .unwrap();
        let mut first_l = src_l.clone();
        let mut first_r = src_r.clone();
        st.process(&mut first_l, &mut first_r);
        st.reset();
        let mut again_l = src_l.clone();
        let mut again_r = src_r.clone();
        st.process(&mut again_l, &mut again_r);
        assert_eq!(first_l, again_l);
        assert_eq!(first_r, again_r);
    }

    // ---- GWT-LM-10 / §4.4：改前瞻、禁用→启用均等价新实例 ----

    #[test]
    fn 改前瞻后管线等价于同参新实例() {
        let (tail_src_l, tail_src_r) = noise_stereo(2024, 300);
        let (head_l, head_r) = noise_stereo(123, 500);

        let mut tuned =
            LimiterStage::from_settings(48_000.0, settings(true, -6.0, 5.0, 0.5, 150.0, true))
                .unwrap();
        let mut hl = head_l.clone();
        let mut hr = head_r.clone();
        tuned.process(&mut hl, &mut hr); // 先流过一段旧参数
        tuned.configure(settings(true, -6.0, 2.0, 0.5, 150.0, true)); // lookahead 变更 → 清空

        let mut fresh =
            LimiterStage::from_settings(48_000.0, settings(true, -6.0, 2.0, 0.5, 150.0, true))
                .unwrap();
        let mut fl = tail_src_l.clone();
        let mut fr = tail_src_r.clone();
        fresh.process(&mut fl, &mut fr);

        let mut al = tail_src_l.clone();
        let mut ar = tail_src_r.clone();
        tuned.process(&mut al, &mut ar);
        assert_eq!(al, fl, "改前瞻后必须与同参新实例逐位一致（陈旧内容不残留）");
        assert_eq!(ar, fr);
    }

    #[test]
    fn 禁用再启用后管线等价于同参新实例() {
        let (head_l, head_r) = noise_stereo(55, 400);
        let (tail_src_l, tail_src_r) = noise_stereo(66, 250);
        let mut st =
            LimiterStage::from_settings(48_000.0, settings(true, -1.0, 5.0, 0.5, 150.0, true))
                .unwrap();
        let mut hl = head_l.clone();
        let mut hr = head_r.clone();
        st.process(&mut hl, &mut hr);
        st.configure(settings(false, -1.0, 5.0, 0.5, 150.0, true));
        // 禁用期间送噪声：必须原样直通且不留状态
        let (mut gap_l, mut gap_r) = noise_stereo(77, 120);
        let (gap_before_l, gap_before_r) = (gap_l.clone(), gap_r.clone());
        st.process(&mut gap_l, &mut gap_r);
        assert_eq!(gap_l, gap_before_l);
        assert_eq!(gap_r, gap_before_r);
        st.configure(settings(true, -1.0, 5.0, 0.5, 150.0, true)); // 切回启用 → 清空

        let mut fresh =
            LimiterStage::from_settings(48_000.0, settings(true, -1.0, 5.0, 0.5, 150.0, true))
                .unwrap();
        let mut fl = tail_src_l.clone();
        let mut fr = tail_src_r.clone();
        fresh.process(&mut fl, &mut fr);
        let mut tl = tail_src_l.clone();
        let mut tr = tail_src_r.clone();
        st.process(&mut tl, &mut tr);
        assert_eq!(tl, fl, "切回启用后必须与同参新实例逐位一致");
        assert_eq!(tr, fr);
    }

    // ---- GWT-LM-06：极值参数无数值事故 ----

    #[test]
    fn 极值参数全程有限且有界() {
        let combos = [
            settings(true, -60.0, 0.0, 0.0, 0.0, true),
            settings(true, 0.0, 20.0, 0.0, 0.0, true),
            settings(true, -60.0, 20.0, 0.001, 0.001, false),
            settings(true, 0.0, 0.0, 0.05, 1000.0, false),
        ];
        for params in combos {
            let mut st = LimiterStage::from_settings(48_000.0, params.clone()).unwrap();
            // 满幅 ±1 方波串激励（限幅器增益恒 ≤1，输出不得超输入幅值）
            let mut l: Vec<f32> = (0..2048)
                .map(|i| if (i / 16) % 2 == 0 { 1.0 } else { -1.0 })
                .collect();
            let mut r: Vec<f32> = l.iter().map(|s| -s).collect();
            st.process(&mut l, &mut r);
            for (i, (&a, &b)) in l.iter().zip(r.iter()).enumerate() {
                assert!(
                    a.is_finite() && b.is_finite(),
                    "params={params:?} @{i} 出现非有限值"
                );
            }
            let max_out = l
                .iter()
                .chain(r.iter())
                .fold(0.0_f32, |m, s| m.max(s.abs()));
            assert!(max_out <= 1.0 + 1e-6, "限幅器不得增益：{max_out}");
        }
    }

    // ---- 行为冒烟：brickwall 方向正确（非冻结断言）----

    #[test]
    fn 满幅正弦稳态输出贴近阈值() {
        // 3kHz 满幅正弦、阈值 -12dBFS：稳态输出峰值应显著低于输入并接近阈值
        let mut st =
            LimiterStage::from_settings(48_000.0, settings(true, -12.0, 5.0, 0.5, 150.0, true))
                .unwrap();
        let frames = 24_000;
        let mut l: Vec<f32> = (0..frames)
            .map(|i| (2.0 * PI * 3_000.0 * i as f64 / 48_000.0).sin() as f32)
            .collect();
        let mut r = l.clone();
        st.process(&mut l, &mut r);
        let peak_out = l.iter().skip(4_000).fold(0.0_f32, |m, s| m.max(s.abs()));
        let thr_lin = 10_f64.powf(-12.0 / 20.0) as f32;
        assert!(peak_out < 0.35, "稳态输出峰值应被压低，实际 {peak_out}");
        assert!(
            peak_out >= thr_lin * 0.85,
            "不应过度压限，实际 {peak_out} vs 阈值 {thr_lin}"
        );
        assert!(st.reduction_db() <= 0.0);
    }

    // ---- HyperPlayer 扩展：运行时状态四件套（save/restore/copy/失配原子性）----

    #[test]
    fn 运行时状态往返保存复制与失配保持原子性() {
        let prefix_l = noise_stereo(201, 257).0;
        let prefix_r = noise_stereo(202, 257).1;
        let continuation_l = noise_stereo(203, 193).0;
        let continuation_r = noise_stereo(204, 193).1;
        let params = settings(true, -3.0, 2.5, 0.5, 80.0, true);
        let drive = |st: &mut LimiterStage, l: &[f32], r: &[f32], block: usize| {
            let mut out_l = l.to_vec();
            let mut out_r = r.to_vec();
            let mut off = 0;
            while off < l.len() {
                let end = (off + block).min(l.len());
                st.process(&mut out_l[off..end], &mut out_r[off..end]);
                off = end;
            }
            (out_l, out_r)
        };

        let mut source = LimiterStage::from_settings(48_000.0, params.clone()).unwrap();
        let _ = drive(&mut source, &prefix_l, &prefix_r, 73);
        let checkpoint = source.snapshot_runtime_state();
        let (expected_l, expected_r) = drive(&mut source, &continuation_l, &continuation_r, 61);

        // restore 往返：同参新实例恢复检查点后与原实例逐位一致。
        let mut replay = LimiterStage::from_settings(48_000.0, params.clone()).unwrap();
        replay.restore_runtime_state(&checkpoint).unwrap();
        let (actual_l, actual_r) = drive(&mut replay, &continuation_l, &continuation_r, 61);
        assert_eq!((actual_l, actual_r), (expected_l, expected_r));

        // copy：状态迁移但目标参数（阈值/系数）保持不变。
        let mut target_params = settings(true, -6.0, 2.5, 1.0, 60.0, true);
        target_params.true_peak = false;
        let mut target = LimiterStage::from_settings(48_000.0, target_params).unwrap();
        let params_before = (target.threshold_lin, target.attack_coef, target.true_peak);
        target.copy_runtime_state_from(&replay).unwrap();
        assert_eq!(
            (target.threshold_lin, target.attack_coef, target.true_peak),
            params_before
        );

        // 采样率不符 / 前瞻长度不符：三种迁移全部拒绝且目标状态不被触碰。
        let mut reusable = checkpoint.clone();
        replay.save_runtime_state(&mut reusable).unwrap();
        let before = (
            replay.gain,
            replay.reduction_db,
            replay.delay_w,
            replay.sample_index,
        );
        let mut rate_mismatch = LimiterStage::from_settings(44_100.0, params).unwrap();
        let rate_before = (rate_mismatch.gain, rate_mismatch.delay_w);
        assert_eq!(
            rate_mismatch.restore_runtime_state(&reusable),
            Err(LimiterRuntimeStateMismatch)
        );
        assert_eq!(
            rate_mismatch.copy_runtime_state_from(&replay),
            Err(LimiterRuntimeStateMismatch)
        );
        assert_eq!(
            rate_mismatch.save_runtime_state(&mut reusable),
            Err(LimiterRuntimeStateMismatch)
        );
        assert_eq!((rate_mismatch.gain, rate_mismatch.delay_w), rate_before);
        assert_eq!(
            (reusable.gain, reusable.delay_w),
            (replay.gain, replay.delay_w),
            "失败的 save 不得修改已有快照"
        );

        let mut lookahead_mismatch =
            LimiterStage::from_settings(48_000.0, settings(true, -3.0, 5.0, 0.5, 80.0, true))
                .unwrap();
        assert_eq!(
            lookahead_mismatch.restore_runtime_state(&reusable),
            Err(LimiterRuntimeStateMismatch)
        );
        assert_eq!(
            lookahead_mismatch.copy_runtime_state_from(&replay),
            Err(LimiterRuntimeStateMismatch)
        );
        assert_eq!(
            (
                replay.gain,
                replay.reduction_db,
                replay.delay_w,
                replay.sample_index
            ),
            before,
            "失败的迁移不得修改源状态"
        );

        // reset 后的状态与刚构造实例逐位等价。
        replay.reset();
        let reset_state = replay.snapshot_runtime_state();
        let fresh =
            LimiterStage::from_settings(48_000.0, settings(true, -3.0, 2.5, 0.5, 80.0, true))
                .unwrap();
        assert_eq!(reset_state.gain.to_bits(), fresh.gain.to_bits());
        assert_eq!(
            reset_state.reduction_db.to_bits(),
            fresh.reduction_db.to_bits()
        );
        assert_eq!(reset_state.last_peak.to_bits(), fresh.last_peak.to_bits());
        assert_eq!(reset_state.delay_w, fresh.delay_w);
        assert_eq!(reset_state.q_len, fresh.q_len);
        assert_eq!(reset_state.hist_w, fresh.hist_w);
        assert_eq!(reset_state.sample_index, fresh.sample_index);
        assert_eq!(reset_state.tail_buffered, fresh.tail_buffered);
        assert_eq!(reset_state.tail_cursor, fresh.tail_cursor);
    }

    #[test]
    fn 运行时状态完整携带延迟线与队列内容() {
        // 快照不仅复位标量：延迟线/队列/真峰值历史内容也必须可迁移。
        // 用噪声把延迟线填出非零内容，再对快照缓冲逐位核对。
        let mut st =
            LimiterStage::from_settings(48_000.0, settings(true, -6.0, 2.0, 0.5, 150.0, true))
                .unwrap();
        let (l, r) = noise_stereo(9001, 400);
        let mut nl = l.clone();
        let mut nr = r.clone();
        st.process(&mut nl, &mut nr);

        let state = st.snapshot_runtime_state();
        assert_eq!(state.lookahead, st.lookahead);
        assert_eq!(state.delay_l.len(), st.delay_l.len());
        assert_eq!(state.delay_r, st.delay_r);
        assert_eq!(state.delay_l, st.delay_l);
        assert_eq!(state.q_len, st.q_len);
        assert_eq!(state.q_head, st.q_head);
        assert_eq!(state.q_val, st.q_val);
        assert_eq!(state.hist_w, st.hist_w);
        assert!(state.hist_l.iter().any(|&s| s != 0.0), "真峰值历史应为非零");
        assert!(state.delay_l.iter().any(|&s| s != 0.0), "延迟线应为非零");
        assert_ne!(state.sample_index, 0);
    }

    // ---- HyperPlayer 扩展：drain 排空语义 ----

    #[test]
    fn 排空输出等于冻结增益乘延迟尾部() {
        let params = settings(true, -3.0, 2.5, 0.5, 80.0, true);
        let lookahead = 120_usize; // round(2.5 * 48000 / 1000)
        let frames = 300_usize;
        let (src_l, src_r) = noise_stereo(4242, frames);
        let mut st = LimiterStage::from_settings(48_000.0, params).unwrap();
        let mut out_l = src_l.clone();
        let mut out_r = src_r.clone();
        st.process(&mut out_l, &mut out_r);
        let frozen_gain = st.gain;
        assert_eq!(st.pending_tail_frames(), lookahead);
        assert_eq!(st.tail_samples(), lookahead);

        // 一次性排空：预期 = 延迟 L 帧的输入 × 冻结增益（与 process 的样本落点公式一致）。
        let mut tail_l = vec![0.0_f32; lookahead + 5]; // 容量超出，验证返回值截断
        let mut tail_r = vec![0.0_f32; lookahead + 5];
        let drained = st.drain(&mut tail_l, &mut tail_r);
        assert_eq!(drained, lookahead);
        for k in 0..lookahead {
            let idx_in = frames + k - lookahead;
            let want_l = (f64::from(src_l[idx_in]) * frozen_gain) as f32;
            let want_r = (f64::from(src_r[idx_in]) * frozen_gain) as f32;
            assert_eq!(tail_l[k].to_bits(), want_l.to_bits(), "drain L @{k}");
            assert_eq!(tail_r[k].to_bits(), want_r.to_bits(), "drain R @{k}");
        }
        assert!(tail_l[lookahead..].iter().all(|&s| s == 0.0));

        // 完全排空后：无待排空内容、延迟线/队列/历史清空、再次 drain 返回 0。
        assert_eq!(st.pending_tail_frames(), 0);
        assert!(st.delay_l.iter().all(|&s| s == 0.0));
        assert!(st.delay_r.iter().all(|&s| s == 0.0));
        assert_eq!(st.q_len, 0);
        assert!(st.hist_l.iter().all(|&s| s == 0.0));
        assert!(st.hist_r.iter().all(|&s| s == 0.0));
        let mut scratch_l = vec![0.0_f32; 64];
        let mut scratch_r = vec![0.0_f32; 64];
        assert_eq!(st.drain(&mut scratch_l, &mut scratch_r), 0);
    }

    #[test]
    fn 排空支持分次调用且与一次性排空逐位一致() {
        let (src_l, src_r) = noise_stereo(7777, 260);
        let mut st =
            LimiterStage::from_settings(48_000.0, settings(true, -3.0, 2.5, 0.5, 80.0, true))
                .unwrap();
        let mut out_l = src_l.clone();
        let mut out_r = src_r.clone();
        st.process(&mut out_l, &mut out_r);

        // 一次性排空参照：确定性回放保证同输入同状态。
        let mut whole =
            LimiterStage::from_settings(48_000.0, settings(true, -3.0, 2.5, 0.5, 80.0, true))
                .unwrap();
        let mut wl = src_l.clone();
        let mut wr = src_r.clone();
        whole.process(&mut wl, &mut wr);
        let mut whole_l = vec![0.0_f32; 128];
        let mut whole_r = vec![0.0_f32; 128];
        let drained_whole = whole.drain(&mut whole_l, &mut whole_r);
        assert_eq!(drained_whole, 120);

        // 分次排空：3 + 64 + 剩余，拼接结果必须与一次性排空逐位一致。
        let mut pieces_l = Vec::new();
        let mut pieces_r = Vec::new();
        for step in [3_usize, 64, 128, 5] {
            let mut buf_l = vec![0.0_f32; step];
            let mut buf_r = vec![0.0_f32; step];
            let n = st.drain(&mut buf_l, &mut buf_r);
            assert!(n <= step);
            pieces_l.extend_from_slice(&buf_l[..n]);
            pieces_r.extend_from_slice(&buf_r[..n]);
        }
        assert_eq!(st.pending_tail_frames(), 0);
        assert_eq!(pieces_l.len(), 120, "排空总数必须等于 lookahead");
        assert_eq!(pieces_l, whole_l[..pieces_l.len()]);
        assert_eq!(pieces_r, whole_r[..pieces_r.len()]);

        // 排空中途 reset：进度与延迟线清空，后续 drain 恒 0。
        let mut mid =
            LimiterStage::from_settings(48_000.0, settings(true, -3.0, 2.5, 0.5, 80.0, true))
                .unwrap();
        let mut ml = src_l.clone();
        let mut mr = src_r.clone();
        mid.process(&mut ml, &mut mr);
        let (mut two_l, mut two_r) = (vec![0.0_f32; 2], vec![0.0_f32; 2]);
        assert_eq!(mid.drain(&mut two_l, &mut two_r), 2);
        assert_eq!(mid.pending_tail_frames(), 118);
        mid.reset();
        assert_eq!(mid.pending_tail_frames(), 0);
        let (mut after_l, mut after_r) = (vec![0.0_f32; 16], vec![0.0_f32; 16]);
        assert_eq!(mid.drain(&mut after_l, &mut after_r), 0);
    }

    #[test]
    fn 禁用与零前瞻时排空恒零() {
        let mut disabled =
            LimiterStage::from_settings(48_000.0, settings(false, -3.0, 2.5, 0.5, 80.0, true))
                .unwrap();
        let (mut l, mut r) = noise_stereo(31, 100);
        disabled.process(&mut l, &mut r);
        assert_eq!(disabled.tail_samples(), 0);
        assert_eq!(disabled.pending_tail_frames(), 0);
        let mut out_l = vec![0.0_f32; 64];
        let mut out_r = vec![0.0_f32; 64];
        assert_eq!(disabled.drain(&mut out_l, &mut out_r), 0);
        assert!(out_l.iter().all(|&s| s == 0.0));

        let mut zero_lookahead =
            LimiterStage::from_settings(48_000.0, settings(true, -3.0, 0.0, 0.5, 80.0, true))
                .unwrap();
        let (mut l, mut r) = noise_stereo(32, 100);
        zero_lookahead.process(&mut l, &mut r);
        assert_eq!(zero_lookahead.tail_samples(), 0);
        assert_eq!(zero_lookahead.pending_tail_frames(), 0);
        assert_eq!(zero_lookahead.drain(&mut out_l, &mut out_r), 0);
    }

    #[test]
    fn 检测峰值读数区分真峰值与数字峰值() {
        // 零段接 ±1 交替短脉冲：交替起始处的不连续经 4× 过采样 sinc（Blackman 窗）
        // 重建产生 intersample 过冲，检测峰值 ≈ 1.0728 > 数字峰值 1.0。阈值
        // 0 dBFS 下仅真峰值模式对该样本产生实际衰减（attack 0.5 ms、release
        // 150 ms，单样本拉低 ≈ 0.024 dB）。
        let mut input = vec![0.0_f32; 600];
        input.extend([1.0_f32, -1.0, 1.0]);

        let mut tp =
            LimiterStage::from_settings(48_000.0, settings(true, 0.0, 5.0, 0.5, 150.0, true))
                .unwrap();
        let mut tl = input.clone();
        let mut tr = input.clone();
        tp.process(&mut tl, &mut tr);
        assert!(
            tp.last_detected_peak() > 1.0 && tp.last_detected_peak() < 1.2,
            "真峰值读数必须覆盖 intersample peak，实际 {}",
            tp.last_detected_peak()
        );
        assert!(
            tp.reduction_db() < -0.01 && tp.reduction_db() <= 0.0,
            "真峰值超阈样本必须产生衰减，实际 {}",
            tp.reduction_db()
        );

        let mut dp =
            LimiterStage::from_settings(48_000.0, settings(true, 0.0, 5.0, 0.5, 150.0, false))
                .unwrap();
        let mut dl = input.clone();
        let mut dr = input.clone();
        dp.process(&mut dl, &mut dr);
        assert_eq!(
            dp.last_detected_peak(),
            1.0,
            "数字峰值读数 = 样本绝对值峰值"
        );
        assert_eq!(dp.reduction_db(), 0.0, "数字峰值不超阈不衰减");
        // 两条路径读数可区分，排水行为不受读数影响。
        assert!(tp.last_detected_peak() > dp.last_detected_peak());
        assert_eq!(dp.pending_tail_frames(), 240);
        assert_eq!(tp.pending_tail_frames(), 240);
    }
}
