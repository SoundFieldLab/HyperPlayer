//! reverb_simple —— Freeverb 类算法混响阶段（Phase 1 试点模块）。
//!
//! 行为事实标准：仓库根 `src/dsp/ReverbSimple.ts`；规格：`specs/dsp/reverb-simple.md`。
//! 移植要点：梳状（左右各 4，@44.1kHz 互质延迟按采样率缩放）+ 全通（共用 4 延迟）、
//! 五种 type 基准表、effRoom/effDamp 混合公式、preDelay、width 立体声扩展、wet/dry。
//!
//! # 数值精度铁律的落点
//!
//! - 一切以 JS `Number`（f64）参与运算的中间量——effRoom/effDamp、feedback、
//!   damp1/damp2、wet1/wet2、dry、梳状/全通逐样本递推、湿路求和 `acc`——
//!   全部用 `f64` 复刻，运算顺序与 TS 逐行一致；
//! - 只有写回 `Float32Array` 的样本落点才取 f32：8 个梳状缓冲、8 个全通缓冲、
//!   preDelay 延迟线，**以及 `combStoreL/R` 阻尼滤波器状态**（TS 中它是
//!   `Float32Array`，每样本写入即被量化到 f32；不复刻该量化点则长尾逐步
//!   漂移，无法通过对拍容差）；
//! - `Math.round`/`Math.ceil` 在本模块所有调用点的操作数均非负（先经 clamp），
//!   与 Rust `f64::round`/`f64::ceil` 结果一致（正数域"半值向上"="半值远离零"）。

use crate::Stage;
use std::fmt;

/// 对齐 TS `ReverbSimpleParams` 的参数快照。
#[derive(Debug, Clone)]
pub struct ReverbSimpleParams {
    pub room_size: f64,
    pub damping: f64,
    pub wet: f64,
    pub dry: f64,
    pub pre_delay_ms: f64,
    pub width: f64,
    /// TS `ReverbType` 五种之一：hall / room / plate / spring / stage。
    /// 未知值运行时回退 hall（GWT-RS-11，与 TS `TYPE_TABLE[p.type] || TYPE_TABLE.hall` 一致）。
    pub reverb_type: String,
}

/// type → 房间参数基准条目（对齐 TS `ReverbTypeTable`）。
#[derive(Debug, Clone, Copy)]
struct TypeTable {
    /// 基准 roomSize（0..1）
    room_size: f64,
    /// 基准 damping（0..1）
    damping: f64,
    /// 延迟长度缩放（1.0 = 标准 Freeverb 调音）
    delay_scale: f64,
}

// type → 房间参数表（与 TS TYPE_TABLE 逐项一致，规格 §3.2）
const TABLE_HALL: TypeTable = TypeTable {
    room_size: 0.7,
    damping: 0.4,
    delay_scale: 1.0,
};
const TABLE_ROOM: TypeTable = TypeTable {
    room_size: 0.4,
    damping: 0.6,
    delay_scale: 0.8,
};
const TABLE_PLATE: TypeTable = TypeTable {
    room_size: 0.6,
    damping: 0.2,
    delay_scale: 0.7,
};
const TABLE_SPRING: TypeTable = TypeTable {
    room_size: 0.3,
    damping: 0.8,
    delay_scale: 0.5,
};
const TABLE_STAGE: TypeTable = TypeTable {
    room_size: 0.5,
    damping: 0.5,
    delay_scale: 1.2,
};

/// 查表；未知枚举回退 hall（GWT-RS-11）。
fn type_table(reverb_type: &str) -> TypeTable {
    match reverb_type {
        "room" => TABLE_ROOM,
        "plate" => TABLE_PLATE,
        "spring" => TABLE_SPRING,
        "stage" => TABLE_STAGE,
        _ => TABLE_HALL,
    }
}

// 标准 Freeverb 梳状延迟（左右各 4，@44.1kHz，互质）
const COMB_DELAYS_L: [f64; 4] = [1116.0, 1188.0, 1277.0, 1356.0];
const COMB_DELAYS_R: [f64; 4] = [1101.0, 1173.0, 1256.0, 1344.0];
// 标准 Freeverb 全通延迟（@44.1kHz，左右共用）
const ALLPASS_DELAYS: [f64; 4] = [556.0, 441.0, 341.0, 225.0];

/// 四路梳状求和的电平补偿常数（TS `WET_GAIN`）。
const WET_GAIN: f64 = 0.25;

/// 一个已配置的算法混响阶段。
///
/// 缓冲在构造时按最大延迟长度一次性预分配（最长梳状 1356·1.2、最长全通
/// 556·1.2、preDelay 上限 1000ms），`process` 稳态零分配。
pub struct ReverbSimpleStage {
    sample_rate: f64,
    params: ReverbSimpleParams,

    // 梳状滤波器状态（8 组；缓冲按最大长度分配，逻辑长度见 *_len）
    comb_buf_l: Vec<Vec<f32>>,
    comb_buf_r: Vec<Vec<f32>>,
    comb_pos_l: [usize; 4],
    comb_pos_r: [usize; 4],
    comb_len_l: [usize; 4],
    comb_len_r: [usize; 4],
    /// 阻尼低通累积状态。注意：TS 中为 `Float32Array`，每样本写入即量化 f32，
    /// 这里必须保持 `f32` 才能与 TS 长尾逐位同态。
    comb_store_l: [f32; 4],
    comb_store_r: [f32; 4],

    // 全通滤波器状态（左右各 4，共用延迟长度表）
    ap_buf_l: Vec<Vec<f32>>,
    ap_buf_r: Vec<Vec<f32>>,
    ap_pos_l: [usize; 4],
    ap_pos_r: [usize; 4],
    ap_len: [usize; 4],

    // preDelay 延迟线（左右各一，共享游标；物理长度 = ceil(fs)+1）
    pre_delay_l: Vec<f32>,
    pre_delay_r: Vec<f32>,
    pre_delay_pos: usize,
    /// 读偏移（单位 = 游标步；游标每帧推进两次，见 `process`）。
    pre_delay_len: usize,

    // 派生参数（f64 复刻 TS Number 运算；由 apply_params 从 params 计算）
    feedback: f64,
    damp1: f64,
    damp2: f64,
    wet1: f64,
    wet2: f64,
    dry_gain: f64,
}

impl ReverbSimpleStage {
    /// 以显式参数快照构造（内部缓冲按采样率分配；钳制/混合公式见规格）。
    ///
    /// 对齐 TS「构造即分配最大缓冲 + `setParams(p)`」的组合语义：
    /// 构造完成时派生参数与延迟长度均已按 `params` 生效。
    pub fn from_params(sample_rate: f64, params: ReverbSimpleParams) -> Result<Self, String> {
        if !(sample_rate.is_finite() && sample_rate > 0.0) {
            return Err("sampleRate 必须为正有限数".into());
        }

        // 预分配最大延迟缓冲：最长梳状 1356·1.2（stage）、最长全通 556·1.2 @fs。
        // 表达式分组与 TS 构造器 `Math.ceil((1356 * 1.2 * fs) / 44100) + 2` 一致。
        let max_comb_len = ((((1356.0_f64 * 1.2) * sample_rate) / 44100.0).ceil() as usize) + 2;
        let max_ap_len = ((((556.0_f64 * 1.2) * sample_rate) / 44100.0).ceil() as usize) + 2;
        // preDelay 上限 1000ms：物理长度 ceil(fs)+1（TS `new Float32Array(Math.ceil(fs) + 1)`）。
        let pre_delay_cap = (sample_rate.ceil() as usize) + 1;

        let mut stage = Self {
            sample_rate,
            params,
            comb_buf_l: vec![vec![0.0; max_comb_len]; 4],
            comb_buf_r: vec![vec![0.0; max_comb_len]; 4],
            comb_pos_l: [0; 4],
            comb_pos_r: [0; 4],
            comb_len_l: [1; 4],
            comb_len_r: [1; 4],
            comb_store_l: [0.0; 4],
            comb_store_r: [0.0; 4],
            ap_buf_l: vec![vec![0.0; max_ap_len]; 4],
            ap_buf_r: vec![vec![0.0; max_ap_len]; 4],
            ap_pos_l: [0; 4],
            ap_pos_r: [0; 4],
            ap_len: [1; 4],
            pre_delay_l: vec![0.0; pre_delay_cap],
            pre_delay_r: vec![0.0; pre_delay_cap],
            pre_delay_pos: 0,
            pre_delay_len: 0,
            feedback: 0.0,
            damp1: 0.0,
            damp2: 1.0,
            wet1: 0.0,
            wet2: 0.0,
            dry_gain: 0.0,
        };
        stage.apply_params();
        Ok(stage)
    }

    /// 覆盖参数快照（对齐 TS `setParams` 整体替换语义）。
    ///
    /// 即时重算派生参数与延迟长度；内部缓冲与游标位置保留不清零（规格 §4.2）。
    pub fn configure(&mut self, params: ReverbSimpleParams) {
        self.params = params;
        self.apply_params();
    }

    /// 由当前参数快照重算全部派生量（对齐 TS `setParams` 函数体，逐行同序）。
    fn apply_params(&mut self) {
        let p = &self.params;
        let t = type_table(&p.reverb_type);

        // type 提供基准，用户参数在基准附近 ±0.25 范围内微调（中性 0.5 即类型本身）。
        // TS：min(0.98, max(0, base + (clamp01(u) - 0.5) * 0.5))
        let eff_room = (t.room_size + (clamp01(p.room_size) - 0.5) * 0.5)
            .max(0.0)
            .min(0.98);
        // TS：min(0.99, max(0.01, base + (clamp01(u) - 0.5) * 0.5))
        let eff_damp = (t.damping + (clamp01(p.damping) - 0.5) * 0.5)
            .max(0.01)
            .min(0.99);

        self.feedback = eff_room;
        self.damp1 = eff_damp;
        self.damp2 = 1.0 - eff_damp;

        let wet = p.wet.max(0.0).min(4.0);
        let width = p.width.max(0.0).min(2.0);
        self.wet1 = wet * (width / 2.0 + 0.5);
        self.wet2 = wet * ((1.0 - width) / 2.0);
        self.dry_gain = p.dry.max(0.0).min(4.0);

        // preDelay：TS `Math.round((pdMs * this.fs) / 1000)`，可为 0（旁路）。
        let pd_ms = p.pre_delay_ms.max(0.0).min(1000.0);
        self.pre_delay_len = ((pd_ms * self.sample_rate) / 1000.0).round() as usize;

        // 延迟长度：标准调音 × type.delayScale × fs/44100，四舍五入且下限 1 样本。
        let scale = (t.delay_scale * self.sample_rate) / 44100.0;
        for c in 0..4 {
            self.comb_len_l[c] = ((COMB_DELAYS_L[c] * scale).round()).max(1.0) as usize;
            self.comb_len_r[c] = ((COMB_DELAYS_R[c] * scale).round()).max(1.0) as usize;
            self.ap_len[c] = ((ALLPASS_DELAYS[c] * scale).round()).max(1.0) as usize;
        }
    }

    /// 返回含全部延迟缓冲内容的定长状态快照（非实时 checkpoint 路径，会分配）。
    pub fn snapshot_runtime_state(&self) -> ReverbSimpleRuntimeState {
        ReverbSimpleRuntimeState {
            sample_rate_bits: self.sample_rate.to_bits(),
            comb_len_l: self.comb_len_l,
            comb_len_r: self.comb_len_r,
            ap_len: self.ap_len,
            comb_pos_l: self.comb_pos_l,
            comb_pos_r: self.comb_pos_r,
            comb_store_l: self.comb_store_l,
            comb_store_r: self.comb_store_r,
            ap_pos_l: self.ap_pos_l,
            ap_pos_r: self.ap_pos_r,
            pre_delay_pos: self.pre_delay_pos,
            comb_buf_l: self.comb_buf_l.clone(),
            comb_buf_r: self.comb_buf_r.clone(),
            ap_buf_l: self.ap_buf_l.clone(),
            ap_buf_r: self.ap_buf_r.clone(),
            pre_delay_l: self.pre_delay_l.clone(),
            pre_delay_r: self.pre_delay_r.clone(),
        }
    }

    /// 将当前状态写入已有快照；采样率（或由其决定的缓冲长度）不符时不修改快照。
    ///
    /// 通过 `clone_from` 复用快照既有分配：缓冲容量由采样率固定、过程期不增长，
    /// 稳态重写快照为零分配。
    pub fn save_runtime_state(
        &self,
        state: &mut ReverbSimpleRuntimeState,
    ) -> Result<(), ReverbSimpleRuntimeStateMismatch> {
        if !self.state_shapes_match(state) {
            return Err(ReverbSimpleRuntimeStateMismatch);
        }
        state.comb_pos_l = self.comb_pos_l;
        state.comb_pos_r = self.comb_pos_r;
        state.comb_store_l = self.comb_store_l;
        state.comb_store_r = self.comb_store_r;
        state.ap_pos_l = self.ap_pos_l;
        state.ap_pos_r = self.ap_pos_r;
        state.pre_delay_pos = self.pre_delay_pos;
        state.comb_buf_l.clone_from(&self.comb_buf_l);
        state.comb_buf_r.clone_from(&self.comb_buf_r);
        state.ap_buf_l.clone_from(&self.ap_buf_l);
        state.ap_buf_r.clone_from(&self.ap_buf_r);
        state.pre_delay_l.clone_from(&self.pre_delay_l);
        state.pre_delay_r.clone_from(&self.pre_delay_r);
        Ok(())
    }

    /// 恢复全部延迟缓冲、游标与阻尼 store 状态，保留目标参数与派生量。
    pub fn restore_runtime_state(
        &mut self,
        state: &ReverbSimpleRuntimeState,
    ) -> Result<(), ReverbSimpleRuntimeStateMismatch> {
        if !self.state_shapes_match(state) {
            return Err(ReverbSimpleRuntimeStateMismatch);
        }
        self.comb_pos_l = state.comb_pos_l;
        self.comb_pos_r = state.comb_pos_r;
        self.comb_store_l = state.comb_store_l;
        self.comb_store_r = state.comb_store_r;
        self.ap_pos_l = state.ap_pos_l;
        self.ap_pos_r = state.ap_pos_r;
        self.pre_delay_pos = state.pre_delay_pos;
        self.comb_buf_l.clone_from(&state.comb_buf_l);
        self.comb_buf_r.clone_from(&state.comb_buf_r);
        self.ap_buf_l.clone_from(&state.ap_buf_l);
        self.ap_buf_r.clone_from(&state.ap_buf_r);
        self.pre_delay_l.clone_from(&state.pre_delay_l);
        self.pre_delay_r.clone_from(&state.pre_delay_r);
        Ok(())
    }

    /// 从另一实例复制连续处理状态，保留目标参数与派生量。
    ///
    /// 直接逐字段拷贝（`clone_from` 复用既有分配）：稳态调用零分配。延迟长度
    /// 拓扑（梳状/全通长度）与采样率不一致时报错——此时游标语义失配，必须重建。
    pub fn copy_runtime_state_from(
        &mut self,
        source: &Self,
    ) -> Result<(), ReverbSimpleRuntimeStateMismatch> {
        if self.sample_rate.to_bits() != source.sample_rate.to_bits()
            || self.comb_len_l != source.comb_len_l
            || self.comb_len_r != source.comb_len_r
            || self.ap_len != source.ap_len
        {
            return Err(ReverbSimpleRuntimeStateMismatch);
        }
        self.comb_pos_l = source.comb_pos_l;
        self.comb_pos_r = source.comb_pos_r;
        self.comb_store_l = source.comb_store_l;
        self.comb_store_r = source.comb_store_r;
        self.ap_pos_l = source.ap_pos_l;
        self.ap_pos_r = source.ap_pos_r;
        self.pre_delay_pos = source.pre_delay_pos;
        for c in 0..4 {
            self.comb_buf_l[c].clone_from(&source.comb_buf_l[c]);
            self.comb_buf_r[c].clone_from(&source.comb_buf_r[c]);
            self.ap_buf_l[c].clone_from(&source.ap_buf_l[c]);
            self.ap_buf_r[c].clone_from(&source.ap_buf_r[c]);
        }
        self.pre_delay_l.clone_from(&source.pre_delay_l);
        self.pre_delay_r.clone_from(&source.pre_delay_r);
        Ok(())
    }

    /// 状态形状核对：采样率逐位一致（延迟缓冲物理长度由其唯一决定）且快照
    /// 缓冲长度与本阶段一致（防绕过构造器的非常规实例）。
    fn state_shapes_match(&self, state: &ReverbSimpleRuntimeState) -> bool {
        if state.sample_rate_bits != self.sample_rate.to_bits() {
            return false;
        }
        if state.comb_len_l != self.comb_len_l
            || state.comb_len_r != self.comb_len_r
            || state.ap_len != self.ap_len
        {
            return false;
        }
        let shape = |buffers: (&[Vec<f32>], &[Vec<f32>])| {
            buffers.0.len() == buffers.1.len()
                && buffers
                    .0
                    .iter()
                    .zip(buffers.1.iter())
                    .all(|(a, b)| a.len() == b.len())
        };
        shape((&self.comb_buf_l, &state.comb_buf_l))
            && shape((&self.comb_buf_r, &state.comb_buf_r))
            && shape((&self.ap_buf_l, &state.ap_buf_l))
            && shape((&self.ap_buf_r, &state.ap_buf_r))
            && self.pre_delay_l.len() == state.pre_delay_l.len()
            && self.pre_delay_r.len() == state.pre_delay_r.len()
    }

    /// 干路直通、湿路并联——处理延迟为零。
    pub fn latency_samples(&self) -> usize {
        0
    }

    /// 湿路尾音排空估计（−60 dB 保守上限）：preDelay + 最长梳状线的反馈排空。
    pub fn tail_samples(&self) -> usize {
        let longest = self
            .comb_len_l
            .iter()
            .chain(self.comb_len_r.iter())
            .copied()
            .max()
            .unwrap_or(0);
        self.pre_delay_len + reverb_tail_drain_frames(longest, self.feedback, self.sample_rate)
    }

    /// 单路梳状递推（左声道第 c 路，对齐 TS 内联块，运算顺序逐行一致）。
    ///
    /// `filt` 为 f64 运算；但 `store` 写回即量化 f32（TS Float32Array 语义）。
    #[inline]
    fn comb_step_l(&mut self, c: usize, input: f64) -> f64 {
        let pos = self.comb_pos_l[c];
        let len = self.comb_len_l[c];
        let feedback = self.feedback;
        let damp1 = self.damp1;
        let damp2 = self.damp2;
        let out = f64::from(self.comb_buf_l[c][pos]);
        let filt = out * damp2 + f64::from(self.comb_store_l[c]) * damp1;
        self.comb_store_l[c] = filt as f32;
        self.comb_buf_l[c][pos] = (input + filt * feedback) as f32;
        self.comb_pos_l[c] = if pos + 1 >= len { 0 } else { pos + 1 };
        out
    }

    /// 单路梳状递推（右声道第 c 路）。
    #[inline]
    fn comb_step_r(&mut self, c: usize, input: f64) -> f64 {
        let pos = self.comb_pos_r[c];
        let len = self.comb_len_r[c];
        let feedback = self.feedback;
        let damp1 = self.damp1;
        let damp2 = self.damp2;
        let out = f64::from(self.comb_buf_r[c][pos]);
        let filt = out * damp2 + f64::from(self.comb_store_r[c]) * damp1;
        self.comb_store_r[c] = filt as f32;
        self.comb_buf_r[c][pos] = (input + filt * feedback) as f32;
        self.comb_pos_r[c] = if pos + 1 >= len { 0 } else { pos + 1 };
        out
    }

    /// 单路全通递推（左声道第 c 路，反馈系数固定 0.5）。
    #[inline]
    fn ap_step_l(&mut self, c: usize, input: f64) -> f64 {
        let pos = self.ap_pos_l[c];
        let len = self.ap_len[c];
        let bufout = f64::from(self.ap_buf_l[c][pos]);
        let ap_out = -input + bufout;
        self.ap_buf_l[c][pos] = (input + bufout * 0.5) as f32;
        self.ap_pos_l[c] = if pos + 1 >= len { 0 } else { pos + 1 };
        ap_out
    }

    /// 单路全通递推（右声道第 c 路）。
    #[inline]
    fn ap_step_r(&mut self, c: usize, input: f64) -> f64 {
        let pos = self.ap_pos_r[c];
        let len = self.ap_len[c];
        let bufout = f64::from(self.ap_buf_r[c][pos]);
        let ap_out = -input + bufout;
        self.ap_buf_r[c][pos] = (input + bufout * 0.5) as f32;
        self.ap_pos_r[c] = if pos + 1 >= len { 0 } else { pos + 1 };
        ap_out
    }
}

/// 算法混响连续处理状态快照。
///
/// 与 [`crate::compressor::CompressorRuntimeState`] 的纯标量形态不同，反馈混响的
/// 记忆驻留在延迟线缓冲中——不含缓冲内容的 checkpoint 无法逐位续播（冲激在缓冲中
/// 的驻留会整体丢失）。因此本快照按值携带全部延迟缓冲；构造/写入快照属**非实时**
/// checkpoint 路径（[`ReverbSimpleStage::save_runtime_state`] 通过 `clone_from`
/// 复用已有分配，稳态下零分配），`process` 实时路径不受影响。
#[derive(Clone)]
pub struct ReverbSimpleRuntimeState {
    sample_rate_bits: u64,
    /// 延迟长度拓扑：type/delayScale 变化会改变梳状/全通长度，游标失配时
    /// 状态迁移不再安全——必须走重建（checkpoint 不兼容语义）。
    comb_len_l: [usize; 4],
    comb_len_r: [usize; 4],
    ap_len: [usize; 4],
    comb_pos_l: [usize; 4],
    comb_pos_r: [usize; 4],
    comb_store_l: [f32; 4],
    comb_store_r: [f32; 4],
    ap_pos_l: [usize; 4],
    ap_pos_r: [usize; 4],
    pre_delay_pos: usize,
    comb_buf_l: Vec<Vec<f32>>,
    comb_buf_r: Vec<Vec<f32>>,
    ap_buf_l: Vec<Vec<f32>>,
    ap_buf_r: Vec<Vec<f32>>,
    pre_delay_l: Vec<f32>,
    pre_delay_r: Vec<f32>,
}

/// 运行时状态的采样率与目标混响不一致（延迟缓冲物理长度由采样率唯一决定，
/// 二者必须逐位一致才允许迁移）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReverbSimpleRuntimeStateMismatch;

impl fmt::Display for ReverbSimpleRuntimeStateMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("reverb simple runtime state sample rate mismatch")
    }
}

impl std::error::Error for ReverbSimpleRuntimeStateMismatch {}

/// 混响尾音的 −60 dB 排空估计（本 crate 三种混响模式共用；单位 = 采样帧）。
///
/// 反馈回路的振幅每经过 `longest_line` 帧衰减 `feedback` 倍，衰减到 −60 dB
/// （1e-3）所需帧数 ≈ `longest_line · ln(1e-3) / ln(feedback)`；阻尼低通只会
/// 加快衰减，故该估计是保守上限。`feedback ≤ 0`（无再循环）时尾音止于最长
/// 延迟线本身；结果钳制在 10 秒内，防止 feedback→1 时估计发散。
pub(crate) fn reverb_tail_drain_frames(
    longest_line: usize,
    feedback: f64,
    sample_rate: f64,
) -> usize {
    let recirculated = if feedback > 0.0 && feedback < 1.0 {
        let frames = (longest_line as f64) * (-6.907_755_278_982_137_f64 / feedback.ln());
        if frames.is_finite() {
            frames.ceil() as usize
        } else {
            // ln(feedback) → −0 时理论尾音发散，按 10 秒封顶。
            (10.0 * sample_rate) as usize
        }
    } else {
        longest_line
    };
    let cap = (10.0 * sample_rate) as usize;
    recirculated.min(cap)
}

/// TS `clamp01`：v < 0 → 0；v > 1 → 1；否则原值。
fn clamp01(v: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

impl Stage for ReverbSimpleStage {
    /// 缓冲已在构造时按最大延迟长度分配，与块长无关，无需再分配。
    fn prepare(&mut self, _max_block_size: usize) {}

    /// 就地处理立体声块；状态跨块保持（GWT-RS-09 切块不变逐样本递推序列）。
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let frames = left.len().min(right.len());

        // 字段缓存为局部变量（对齐 TS 热路径写法；f64 运算中间量）。
        let wet1 = self.wet1;
        let wet2 = self.wet2;
        let dry = self.dry_gain;

        for i in 0..frames {
            let xl = f64::from(left[i]);
            let xr = f64::from(right[i]);

            // ---- preDelay（左右各一次 push，共享游标；len=0 时旁路且不推游标）----
            let dl: f64;
            let dr: f64;
            if self.pre_delay_len == 0 {
                dl = xl;
                dr = xr;
            } else {
                let size = self.pre_delay_l.len();
                // 左声道：读 pdLen 步之前的位置，再写入当前输入。
                let mut rp = self.pre_delay_pos as isize - self.pre_delay_len as isize;
                if rp < 0 {
                    rp += size as isize;
                }
                dl = f64::from(self.pre_delay_l[rp as usize]);
                self.pre_delay_l[self.pre_delay_pos] = xl as f32;
                self.pre_delay_pos += 1;
                if self.pre_delay_pos >= size {
                    self.pre_delay_pos = 0;
                }
                // 右声道：同一游标继续推进一次。
                let mut rp = self.pre_delay_pos as isize - self.pre_delay_len as isize;
                if rp < 0 {
                    rp += size as isize;
                }
                dr = f64::from(self.pre_delay_r[rp as usize]);
                self.pre_delay_r[self.pre_delay_pos] = xr as f32;
                self.pre_delay_pos += 1;
                if self.pre_delay_pos >= size {
                    self.pre_delay_pos = 0;
                }
            }

            // ---- 8 梳状并联（左右交替，累加次序与 TS 展开一致）----
            let mut acc_l = 0.0_f64;
            let mut acc_r = 0.0_f64;
            for c in 0..4 {
                acc_l += self.comb_step_l(c, dl);
                acc_r += self.comb_step_r(c, dr);
            }

            // ---- 4 全通串联（每声道独立级联，反馈系数 0.5）----
            for c in 0..4 {
                acc_l = self.ap_step_l(c, acc_l);
                acc_r = self.ap_step_r(c, acc_r);
            }

            acc_l *= WET_GAIN;
            acc_r *= WET_GAIN;

            // ---- wet/dry + width 交叉混合（加法结合顺序与 TS 一致）----
            left[i] = (xl * dry + acc_l * wet1 + acc_r * wet2) as f32;
            right[i] = (xr * dry + acc_r * wet1 + acc_l * wet2) as f32;
        }
    }

    /// 清空全部缓冲并归零游标与 store 状态；派生参数与延迟长度保留
    /// （对齐 TS `reset()`：只清缓冲/位置/store，不动 `setParams` 结果）。
    fn reset(&mut self) {
        for c in 0..4 {
            self.comb_buf_l[c].fill(0.0);
            self.comb_buf_r[c].fill(0.0);
            self.ap_buf_l[c].fill(0.0);
            self.ap_buf_r[c].fill(0.0);
            self.comb_pos_l[c] = 0;
            self.comb_pos_r[c] = 0;
            self.ap_pos_l[c] = 0;
            self.ap_pos_r[c] = 0;
            self.comb_store_l[c] = 0.0;
            self.comb_store_r[c] = 0.0;
        }
        self.pre_delay_l.fill(0.0);
        self.pre_delay_r.fill(0.0);
        self.pre_delay_pos = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 基准参数快照（中性用户参数 + hall），按需覆盖字段。
    fn base_params(reverb_type: &str) -> ReverbSimpleParams {
        ReverbSimpleParams {
            room_size: 0.5,
            damping: 0.5,
            wet: 0.3,
            dry: 0.7,
            pre_delay_ms: 0.0,
            width: 1.0,
            reverb_type: reverb_type.to_string(),
        }
    }

    /// 确定性伪噪声（LCG，无随机依赖），幅度 [-1, 1)。
    fn lcg_noise(n: usize, seed: u32) -> Vec<f32> {
        let mut u = seed;
        (0..n)
            .map(|_| {
                u = u.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((f64::from(u) / f64::from(u32::MAX)) * 2.0 - 1.0) as f32
            })
            .collect()
    }

    #[test]
    fn fs44100下延迟长度等于原始表值() {
        let mut s = ReverbSimpleStage::from_params(44100.0, base_params("hall")).unwrap();
        s.prepare(128);
        assert_eq!(s.comb_len_l, [1116, 1188, 1277, 1356]);
        assert_eq!(s.comb_len_r, [1101, 1173, 1256, 1344]);
        assert_eq!(s.ap_len, [556, 441, 341, 225]);
        // 逻辑延迟长度不得超过物理缓冲容量。
        for c in 0..4 {
            assert!(s.comb_len_l[c] <= s.comb_buf_l[c].len());
            assert!(s.comb_len_r[c] <= s.comb_buf_r[c].len());
            assert!(s.ap_len[c] <= s.ap_buf_l[c].len());
        }
        // preDelayMs=0 → 读偏移 0（旁路分支）。
        assert_eq!(s.pre_delay_len, 0);
        // 物理缓冲容量 = ceil(fs)+1。
        assert_eq!(s.pre_delay_l.len(), 44101);
    }

    #[test]
    fn 五型基准表逐项生效() {
        // 中性用户参数 0.5 → 生效值即类型基准；延迟 = 表值 × delayScale @44100。
        // 各型长度已与 TS 行为标准逐项核对（Node 直跑 TYPE_TABLE 派生值）：
        // spring 含精确 .5 边界（round 半值向上）；plate 的 225×scale 实际落在
        // ≥157.5 一侧取 158（f64 缩放乘除后的舍入方向以真值为准）。
        let cases: [(&str, f64, f64, [usize; 4], [usize; 4], [usize; 4]); 5] = [
            (
                "hall",
                0.7,
                0.4,
                [1116, 1188, 1277, 1356],
                [1101, 1173, 1256, 1344],
                [556, 441, 341, 225],
            ),
            (
                "room",
                0.4,
                0.6,
                [893, 950, 1022, 1085],
                [881, 938, 1005, 1075],
                [445, 353, 273, 180],
            ),
            (
                "plate",
                0.6,
                0.2,
                [781, 832, 894, 949],
                [771, 821, 879, 941],
                [389, 309, 239, 158],
            ),
            (
                "spring",
                0.3,
                0.8,
                [558, 594, 639, 678],
                [551, 587, 628, 672],
                [278, 221, 171, 113],
            ),
            (
                "stage",
                0.5,
                0.5,
                [1339, 1426, 1532, 1627],
                [1321, 1408, 1507, 1613],
                [667, 529, 409, 270],
            ),
        ];
        for &(ty, room, damp, comb_l, comb_r, ap) in &cases {
            let s = ReverbSimpleStage::from_params(44100.0, base_params(ty)).unwrap();
            assert_eq!(s.feedback, room, "{ty}: feedback 应为类型基准");
            assert_eq!(s.damp1, damp, "{ty}: damp1 应为类型基准");
            assert_eq!(s.damp2, 1.0 - damp, "{ty}: damp2 = 1 - 基准");
            assert_eq!(s.comb_len_l, comb_l, "{ty}: combLenL");
            assert_eq!(s.comb_len_r, comb_r, "{ty}: combLenR");
            assert_eq!(s.ap_len, ap, "{ty}: apLen");
        }

        // GWT-RS-11：未知 type 运行时回退 hall。
        let weird = ReverbSimpleStage::from_params(44100.0, base_params("no-such-type")).unwrap();
        assert_eq!(weird.feedback, 0.7);
        assert_eq!(weird.damp1, 0.4);
        assert_eq!(weird.damp2, 1.0 - 0.4);
        assert_eq!(weird.comb_len_l, [1116, 1188, 1277, 1356]);
    }

    #[test]
    fn eff混合公式与钳制边界逐项生效() {
        // 期望值写成与规格 §3.1 相同形式的表达式（避免字面量最近舍入差异）。
        let mk = |room_size: f64, damping: f64| {
            let mut p = base_params("hall");
            p.room_size = room_size;
            p.damping = damping;
            ReverbSimpleStage::from_params(44100.0, p).unwrap()
        };

        // effRoom = min(0.98, max(0, 0.7 + (clamp01(u) - 0.5) * 0.5))
        let s = mk(1.0, 0.5);
        assert_eq!(s.feedback, 0.7 + (1.0 - 0.5) * 0.5); // 0.95，未触上限
        let s = mk(0.0, 0.5);
        assert_eq!(s.feedback, 0.7 + (0.0 - 0.5) * 0.5);
        let s = mk(3.0, 0.5);
        assert_eq!(s.feedback, 0.7 + (1.0 - 0.5) * 0.5); // clamp01(3)=1
        let s = mk(-2.0, 0.5);
        assert_eq!(s.feedback, 0.7 + (0.0 - 0.5) * 0.5); // clamp01(-2)=0

        // effDamp = min(0.99, max(0.01, 0.4 + (clamp01(u) - 0.5) * 0.5))
        let s = mk(0.5, 1.0);
        assert_eq!(s.damp1, 0.4 + (1.0 - 0.5) * 0.5);
        assert_eq!(s.damp2, 1.0 - (0.4 + (1.0 - 0.5) * 0.5));
        let s = mk(0.5, 0.0);
        assert_eq!(s.damp1, 0.4 + (0.0 - 0.5) * 0.5);

        // 上限钳制真实触发：spring damping=1 → 0.8+0.25=1.05 → 0.99。
        let mut p = base_params("spring");
        p.damping = 1.0;
        let s = ReverbSimpleStage::from_params(44100.0, p).unwrap();
        assert_eq!(s.damp1, 0.99);
        assert_eq!(s.damp2, 1.0 - 0.99);

        // wet/dry/preDelayMs/width 双向钳制。
        let mut p = base_params("stage");
        p.wet = 99.0; // → 4
        p.dry = -5.0; // → 0
        p.width = 5.0; // → 2
        p.pre_delay_ms = 5000.0; // → 1000ms
        let s = ReverbSimpleStage::from_params(48000.0, p).unwrap();
        assert_eq!(s.wet1, 4.0 * (2.0 / 2.0 + 0.5)); // 6
        assert_eq!(s.wet2, 4.0 * ((1.0 - 2.0) / 2.0)); // -2
        assert_eq!(s.dry_gain, 0.0);
        assert_eq!(s.pre_delay_len, 48_000);
    }

    #[test]
    fn wet0_dry1时输出与输入逐位一致() {
        // GWT-RS-01：湿路增益精确为零、干路乘 1.0 为精确乘法 → 逐位恒等。
        // 注：输入不含 -0.0（TS 中 -0.0 经 +acc×0 会翻成 +0.0，两支线行为一致，
        // 不属于恒等断言范畴）。
        let mut p = base_params("hall");
        p.wet = 0.0;
        p.dry = 1.0;
        p.pre_delay_ms = 37.0; // 湿路有延迟也不影响干路恒等
        let mut s = ReverbSimpleStage::from_params(48000.0, p).unwrap();
        s.prepare(64);

        let input = lcg_noise(512, 0xC0FFEE);
        let mut offset = 0_usize;
        while offset < input.len() {
            let end = (offset + 64).min(input.len());
            let mut l = input[offset..end].to_vec();
            let mut r = input[offset..end].to_vec();
            s.process(&mut l, &mut r);
            for (i, &x) in input[offset..end].iter().enumerate() {
                assert_eq!(l[i].to_bits(), x.to_bits(), "left 帧 {}", offset + i);
                assert_eq!(r[i].to_bits(), x.to_bits(), "right 帧 {}", offset + i);
            }
            offset = end;
        }
    }

    #[test]
    fn 边界参数全程无非有限值() {
        // 冻结向量 case2 同款边界：roomSize=0 / damping=1 下限方向、width=0 单声道化、
        // 纯湿声；满幅冲激 + 阶跃 + 正弦 + 长静音不得产生 NaN/Inf 或自激发散。
        let mut p = base_params("room");
        p.room_size = 0.0;
        p.damping = 1.0;
        p.wet = 1.0;
        p.dry = 0.0;
        p.width = 0.0;
        p.pre_delay_ms = 20.0;
        let mut s = ReverbSimpleStage::from_params(44100.0, p).unwrap();
        s.prepare(256);

        let n = 12_000;
        let mut l = vec![0.0_f32; n];
        let mut r = vec![0.0_f32; n];
        l[0] = 1.0; // 单位冲激
        for x in l.iter_mut().take(2000).skip(1000) {
            *x = 1.0; // 阶跃段
        }
        for (i, x) in l.iter_mut().enumerate().take(3000).skip(2000) {
            *x = ((i as f64) * 0.043).sin() as f32; // 正弦段
        } // 其余静音（衰减尾）
        r.copy_from_slice(&l);

        let mut offset = 0_usize;
        while offset < n {
            let end = (offset + 256).min(n);
            s.process(&mut l[offset..end], &mut r[offset..end]);
            offset = end;
        }
        for (i, (&lv, &rv)) in l.iter().zip(r.iter()).enumerate() {
            assert!(lv.is_finite(), "left[{i}] 非有限: {lv}");
            assert!(rv.is_finite(), "right[{i}] 非有限: {rv}");
        }
        // GWT-RS-03：能量包络整体衰减、局部纹波允许——阶跃/正弦的湿尾要经过
        // 梳状填充（最长 ~1627 帧）才展开，激励结束后先升后降是预期形态；
        // 断言远端尾部相对激励段收敛，且呈下降趋势（阈值已按 TS 真值核对）。
        let energy = |a: usize, b: usize| -> f64 {
            l[a..b].iter().map(|&x| f64::from(x) * f64::from(x)).sum()
        };
        let excite = energy(1000, 3000);
        let mid_tail = energy(7500, 8000);
        let far_tail = energy(n - 1000, n);
        assert!(
            far_tail < excite * 1e-3,
            "远端尾部未收敛: {far_tail} vs 激励 {excite}"
        );
        assert!(mid_tail < energy(5000, 6000), "衰减趋势中断(中段)");
        assert!(far_tail < mid_tail, "衰减趋势中断(远段)");
        // width=0 湿路单声道化：输入左右相同 → 输出左右逐位相同。
        assert_eq!(l[..], r[..], "width=0 时左右输出应逐位相同");
    }

    #[test]
    fn reset后重放与全新实例逐位一致() {
        // GWT-RS-10：reset 后重放 = 首次从零状态处理 = 全新实例。
        let mut p = base_params("hall");
        p.pre_delay_ms = 13.7;
        p.width = 0.8;
        let mut a = ReverbSimpleStage::from_params(48000.0, p.clone()).unwrap();
        a.prepare(128);
        let input_l = lcg_noise(1024, 7);
        let input_r = lcg_noise(1024, 99);

        let mut l1 = input_l.clone();
        let mut r1 = input_r.clone();
        let mut offset = 0;
        while offset < 1024 {
            let end = (offset + 128).min(1024);
            a.process(&mut l1[offset..end], &mut r1[offset..end]);
            offset = end;
        }

        a.reset();
        let mut l2 = input_l.clone();
        let mut r2 = input_r.clone();
        let mut offset = 0;
        while offset < 1024 {
            let end = (offset + 128).min(1024);
            a.process(&mut l2[offset..end], &mut r2[offset..end]);
            offset = end;
        }

        let mut b = ReverbSimpleStage::from_params(48000.0, p).unwrap();
        b.prepare(128);
        let mut l3 = input_l.clone();
        let mut r3 = input_r.clone();
        b.process(&mut l3, &mut r3);

        for i in 0..1024 {
            assert_eq!(
                l1[i].to_bits(),
                l3[i].to_bits(),
                "首轮 vs 全新实例 left[{i}]"
            );
            assert_eq!(l2[i].to_bits(), l3[i].to_bits(), "reset 重放 left[{i}]");
            assert_eq!(
                r1[i].to_bits(),
                r3[i].to_bits(),
                "首轮 vs 全新实例 right[{i}]"
            );
            assert_eq!(r2[i].to_bits(), r3[i].to_bits(), "reset 重放 right[{i}]");
        }
        // 说明：噪声输入下若 reset 未清净缓冲/游标/store，重放必偏离首轮；
        // 三轮逐位全等即证明状态被完整清空（GWT-RS-10）。
    }

    #[test]
    fn 分块处理与整块处理逐位一致() {
        // GWT-RS-09：blockSize=99 不整除 1000（末块 10 帧），输出须逐位一致。
        let mut p = base_params("hall");
        p.pre_delay_ms = 7.0;
        let mut whole = ReverbSimpleStage::from_params(48000.0, p.clone()).unwrap();
        whole.prepare(1000);
        let input_l = lcg_noise(1000, 1234);
        let input_r = lcg_noise(1000, 4321);
        let mut wl = input_l.clone();
        let mut wr = input_r.clone();
        whole.process(&mut wl, &mut wr);

        let mut chunked = ReverbSimpleStage::from_params(48000.0, p).unwrap();
        chunked.prepare(99);
        let mut cl = input_l.clone();
        let mut cr = input_r.clone();
        let mut offset = 0;
        while offset < 1000 {
            let end = (offset + 99).min(1000);
            chunked.process(&mut cl[offset..end], &mut cr[offset..end]);
            offset = end;
        }
        for i in 0..1000 {
            assert_eq!(wl[i].to_bits(), cl[i].to_bits(), "left[{i}] 分块不一致");
            assert_eq!(wr[i].to_bits(), cr[i].to_bits(), "right[{i}] 分块不一致");
        }
    }

    #[test]
    fn pre_delay仅作用于湿路且干路不被延迟() {
        // 44100Hz、20ms → 读偏移 882 游标步；游标每帧推进两次 → 湿路推迟 441 帧。
        // 冲激再经最早的梳状（hall 左 0 路 = 1116 帧）回读后才成为湿声输出，
        // 故首个非零湿声帧 = 441 + 1116 = 1557（与 TS 行为标准实测一致）。
        let mut p = base_params("hall");
        p.wet = 1.0;
        p.dry = 0.0;
        p.width = 1.0;
        p.pre_delay_ms = 20.0;
        let mut s = ReverbSimpleStage::from_params(44100.0, p).unwrap();
        s.prepare(256);
        let n = 2400;
        let mut l = vec![0.0_f32; n];
        let mut r = vec![0.0_f32; n];
        l[0] = 1.0; // 左声道单位冲激
        let mut offset = 0;
        while offset < n {
            let end = (offset + 256).min(n);
            s.process(&mut l[offset..end], &mut r[offset..end]);
            offset = end;
        }
        // 首 1557 帧精确为零（preDelay 未放出 + 梳状未回读）。
        for (i, &x) in l.iter().enumerate().take(1557) {
            assert_eq!(x.to_bits(), 0_u32, "left[{i}] 应仍为零");
        }
        assert!(l[1557].to_bits() != 0_u32, "第 1557 帧应出现首个湿声样本");
        // 右声道输入全零 + width=1 无交叉 → 右声道全程为零。
        assert!(r.iter().all(|&x| x.to_bits() == 0_u32));

        // 干路不被延迟：wet=0/dry=1、preDelayMs=50 → 冲激原位逐位透传。
        let mut p2 = base_params("hall");
        p2.wet = 0.0;
        p2.dry = 1.0;
        p2.pre_delay_ms = 50.0;
        let mut s2 = ReverbSimpleStage::from_params(44100.0, p2).unwrap();
        s2.prepare(8);
        let mut l2 = vec![0.0_f32; 16];
        let mut r2 = vec![0.0_f32; 16];
        l2[0] = 1.0;
        s2.process(&mut l2, &mut r2);
        assert_eq!(l2[0].to_bits(), 1.0_f32.to_bits(), "干路冲激不应被延迟");
    }

    #[test]
    fn configure整体替换参数即时生效() {
        let mut s = ReverbSimpleStage::from_params(44100.0, base_params("hall")).unwrap();
        assert_eq!(s.feedback, 0.7);
        s.configure(base_params("stage"));
        assert_eq!(s.feedback, 0.5);
        assert_eq!(s.damp1, 0.5);
        assert_eq!(s.comb_len_l, [1339, 1426, 1532, 1627]);
        // 参数更新不清空缓冲与游标（规格 §4.2）。
        assert_eq!(s.comb_buf_l[0][0], 0.0);
    }

    #[test]
    fn 无效采样率返回错误() {
        let p = base_params("hall");
        assert!(ReverbSimpleStage::from_params(0.0, p.clone()).is_err());
        assert!(ReverbSimpleStage::from_params(-44100.0, p.clone()).is_err());
        assert!(ReverbSimpleStage::from_params(f64::NAN, p.clone()).is_err());
        assert!(ReverbSimpleStage::from_params(f64::INFINITY, p).is_err());
    }

    #[test]
    fn 运行时状态往返保存复制与失配保持原子性() {
        let prefix = lcg_noise(513, 201);
        let continuation = lcg_noise(331, 203);
        let mut source = ReverbSimpleStage::from_params(48_000.0, base_params("hall")).unwrap();
        source.prepare(73);
        drive_chunks(&mut source, &prefix, 73);
        let checkpoint = source.snapshot_runtime_state();
        let expected = drive_chunks(&mut source, &continuation, 61);

        // 快照往返：restore 后续播与连续处理逐位一致。
        let mut replay = ReverbSimpleStage::from_params(48_000.0, base_params("hall")).unwrap();
        replay.restore_runtime_state(&checkpoint).unwrap();
        assert_eq!(drive_chunks(&mut replay, &continuation, 61), expected);

        // save 覆盖 + copy：copy 保留目标参数（只改 wet/width 等非拓扑参数）。
        let mut reusable = checkpoint.clone();
        replay.save_runtime_state(&mut reusable).unwrap();
        let mut non_topology = base_params("hall");
        non_topology.wet = 0.8;
        non_topology.width = 0.0;
        let mut target = ReverbSimpleStage::from_params(48_000.0, non_topology).unwrap();
        let params_before = (target.feedback, target.wet1, target.wet2, target.dry_gain);
        target.copy_runtime_state_from(&replay).unwrap();
        assert_eq!(
            (target.feedback, target.wet1, target.wet2, target.dry_gain),
            params_before,
            "copy 只迁移状态，不覆盖参数"
        );
        assert_eq!(drive_chunks(&mut target, &continuation, 61), expected);

        // 延迟长度拓扑失配（type 变化 → 梳状/全通长度变化）：报错（重建语义）。
        let mut topology = ReverbSimpleStage::from_params(48_000.0, base_params("plate")).unwrap();
        assert_eq!(
            topology.restore_runtime_state(&reusable),
            Err(ReverbSimpleRuntimeStateMismatch)
        );

        // 采样率失配：save/restore/copy 三路都报错且保持原子性。
        let mut mismatch = ReverbSimpleStage::from_params(44_100.0, base_params("hall")).unwrap();
        let mismatch_before = mismatch.snapshot_runtime_state();
        assert_eq!(
            mismatch.restore_runtime_state(&reusable),
            Err(ReverbSimpleRuntimeStateMismatch)
        );
        assert_eq!(
            mismatch.save_runtime_state(&mut reusable),
            Err(ReverbSimpleRuntimeStateMismatch)
        );
        assert_eq!(
            mismatch.copy_runtime_state_from(&replay),
            Err(ReverbSimpleRuntimeStateMismatch)
        );
        let mismatch_after = mismatch.snapshot_runtime_state();
        assert_eq!(
            mismatch_after.comb_pos_l, mismatch_before.comb_pos_l,
            "失配 restore 不得改动目标状态"
        );
        assert_eq!(mismatch_after.pre_delay_pos, mismatch_before.pre_delay_pos);
        assert_eq!(mismatch_after.comb_buf_l, mismatch_before.comb_buf_l);
    }

    #[test]
    fn reset后快照与全新实例快照逐位一致() {
        let mut stage = ReverbSimpleStage::from_params(48_000.0, base_params("hall")).unwrap();
        stage.prepare(64);
        drive_chunks(&mut stage, &lcg_noise(256, 7), 64);
        stage.reset();
        let reset_state = stage.snapshot_runtime_state();
        let fresh = ReverbSimpleStage::from_params(48_000.0, base_params("hall")).unwrap();
        let fresh_state = fresh.snapshot_runtime_state();
        assert_eq!(reset_state.comb_pos_l, fresh_state.comb_pos_l);
        assert_eq!(reset_state.ap_pos_r, fresh_state.ap_pos_r);
        assert_eq!(reset_state.pre_delay_pos, fresh_state.pre_delay_pos);
        assert_eq!(reset_state.comb_store_l, fresh_state.comb_store_l);
        assert_eq!(reset_state.comb_buf_l, fresh_state.comb_buf_l);
        assert_eq!(reset_state.pre_delay_l, fresh_state.pre_delay_r);
    }

    #[test]
    fn 延迟为零_尾音估计与参数语义一致() {
        // hall @48000：最长梳状 1356×1.0 缩放 ≈ 1476（fs/44100 缩放 + 下限），
        // feedback=0.7 → 排空 = ceil(1476 · ln(1e-3)/ln(0.7))。
        let s = ReverbSimpleStage::from_params(48_000.0, base_params("hall")).unwrap();
        assert_eq!(s.latency_samples(), 0, "干路直通、湿路并联，无处理延迟");
        let longest = *s
            .comb_len_l
            .iter()
            .chain(s.comb_len_r.iter())
            .max()
            .unwrap();
        let want = s.pre_delay_len
            + ((longest as f64) * (-6.907_755_278_982_137_f64 / 0.7_f64.ln())).ceil() as usize;
        assert_eq!(s.tail_samples(), want);
        assert!(s.tail_samples() > longest);

        // 阻尼=1（feedback→0.2 下限方向）排空显著缩短；feedback=0 时尾音止于
        // 最长延迟线本身（无再循环）。
        let mut damped = base_params("spring");
        damped.room_size = 0.0;
        let s = ReverbSimpleStage::from_params(48_000.0, damped).unwrap();
        let longest = *s
            .comb_len_l
            .iter()
            .chain(s.comb_len_r.iter())
            .max()
            .unwrap();
        let want = s.pre_delay_len
            + ((longest as f64) * (-6.907_755_278_982_137_f64 / s.feedback.ln())).ceil() as usize;
        assert_eq!(s.tail_samples(), want);

        // 10 秒封顶：feedback→1 的病态配置不得发散。
        let mut hot = base_params("hall");
        hot.room_size = 1.0; // feedback = 0.95，接近发散
        let s = ReverbSimpleStage::from_params(48_000.0, hot).unwrap();
        assert!(s.tail_samples() <= (10.0_f64 * 48_000.0) as usize);
    }

    /// 按给定块长驱动整段输入（左右声道独立同源缓冲），返回左声道输出拷贝。
    fn drive_chunks(stage: &mut ReverbSimpleStage, input: &[f32], block: usize) -> Vec<f32> {
        let mut out_l = input.to_vec();
        let mut out_r = input.to_vec();
        let mut offset = 0;
        while offset < input.len() {
            let end = (offset + block).min(input.len());
            let (_left_head, left_tail) = out_l.split_at_mut(offset);
            let (_right_head, right_tail) = out_r.split_at_mut(offset);
            stage.process(
                &mut left_tail[..end - offset],
                &mut right_tail[..end - offset],
            );
            offset = end;
        }
        out_l
    }
}
